// Audio Splitter: open a file, select ranges to remove or keep, place splits, export.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  // A cached old page combined with newer scripts (or a script blocked by an extension) would
  // otherwise break the app silently, so say what to do instead.
  if (!window.AudioEncoders || !window.AudioDecode || !window.lamejs || !$('loading')) {
    const msg = 'Part of the app didn\'t load. Reload the page (Ctrl+Shift+R, or Cmd+Shift+R on a Mac). If that doesn\'t help, turn off ad or script blockers for this site.';
    const target = $('fileMeta') || document.body;
    target.textContent = msg;
    target.style.color = 'var(--err, #b3261e)';
    return;
  }
  const { encodeWav, encodeMp3, zipFiles } = window.AudioEncoders;
  const { decodeFile } = window.AudioDecode;

  const wave = $('wave'), ruler = $('ruler');
  let ctx = null;               // AudioContext, created on first use
  let buf = null;               // decoded AudioBuffer
  let fileBase = 'audio';
  let segs = [];                // [{ start, end, keep, name }]: contiguous, covering the whole file
  let selected = 0;             // highlighted part
  let range = null;             // { a, b } selected time range, or null
  let playhead = 0;             // seconds
  let playing = null;           // { src, t0, from, until, single }
  let view = { start: 0, span: 1 };   // visible window, seconds
  let peaks = null, peaksKey = '';
  let raf = 0;
  let busy = false;
  let loadToken = 0;
  const undoStack = [], redoStack = [];

  const MIN_PART = 0.02;        // seconds; shorter slivers are absorbed into neighbours
  const SNAP_PX = 7;
  const MIN_SPAN = 0.05;        // most zoomed-in view, seconds
  const audioCtx = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());

  // ---------- helpers ----------
  const fmt = s => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60;
    const sec = r.toFixed(3).padStart(6, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const parseTime = str => {
    const parts = String(str).trim().split(':');
    if (!parts[0] || parts.length > 3) return NaN;
    const nums = parts.map(Number);
    return nums.some(n => isNaN(n) || n < 0) ? NaN : nums.reduce((a, n) => a * 60 + n, 0);
  };
  const fmtBytes = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB';
  const pad2 = n => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const safeName = s => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'part';
  const partName = i => segs[i].name || `${fileBase}-part-${pad2(i + 1)}`;
  const segAt = t => {
    const i = segs.findIndex(s => t >= s.start && t < s.end);
    return i < 0 ? segs.length - 1 : i;
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const kept = () => segs.filter(s => s.keep);
  const keptDuration = () => kept().reduce((a, s) => a + s.end - s.start, 0);

  function setStatus(msg, kind) {
    const s = $('status');
    s.textContent = msg;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- history ----------
  const snapshot = () => JSON.stringify(segs);
  function commit() {
    undoStack.push(snapshot());
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    segs = JSON.parse(from.pop());
    selected = clamp(selected, 0, segs.length - 1);
    renderAll();
  }
  const undo = () => { restore(undoStack, redoStack); setStatus('Undone.'); };
  const redo = () => { restore(redoStack, undoStack); setStatus('Redone.'); };
  function updateHistoryButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }
  const hasEdits = () => undoStack.length > 0;

  // ---------- loading ----------
  function showLoading(text, progress) {
    $('loading').hidden = false;
    $('loadText').textContent = text;
    const p = $('loadProg');
    if (progress == null) p.removeAttribute('value'); else p.value = progress;
  }
  const hideLoading = () => { $('loading').hidden = true; };

  async function loadFile(file) {
    if (busy) { setStatus('Wait for the current export to finish.', 'err'); return; }
    if (hasEdits() && !confirm(`Open ${file.name}? Your edits to the current file will be lost.`)) return;
    stop();
    const token = ++loadToken;
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = fmtBytes(file.size);
    setControlsEnabled(false);
    try {
      const { buffer, video, via } = await decodeFile(file, audioCtx(), (t, p) => { if (token === loadToken) showLoading(t, p); });
      if (token !== loadToken) return;              // another file was opened meanwhile
      hideLoading();
      fileBase = safeName(file.name.replace(/\.[^.]+$/, '')) || 'audio';
      setBuffer(buffer, `${video ? 'Video' : 'Audio'} · ${fmtBytes(file.size)}${video ? ' · sound extracted' : ''}${via === 'ffmpeg' ? ' (converted)' : ''}`);
      setStatus('Drag across the waveform to select a range, then Remove it or Keep only it.');
    } catch (e) {
      if (token !== loadToken) return;
      hideLoading();
      console.error(e);
      $('fileMeta').textContent = fmtBytes(file.size);
      setStatus(e.userMessage || "Couldn't open this file.", 'err');
      if (buf) setControlsEnabled(true); else $('fileName').textContent = file.name + ' (not opened)';
    }
  }

  function makeSample() {
    // A spoken-word-like rhythm with pauses, so selecting and splitting has something to work on.
    const sr = 44100, dur = 14, n = sr * dur;
    const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    const L = b.getChannelData(0), R = b.getChannelData(1);
    const phrases = [
      [0.5, [523.25, 659.25, 783.99, 659.25, 523.25]],
      [5.0, [392.0, 493.88, 587.33, 783.99]],
      [9.6, [440.0, 554.37, 659.25, 880.0, 659.25, 440.0]],
    ];
    for (const [t0, notes] of phrases) {
      notes.forEach((f, k) => {
        const s0 = Math.floor((t0 + k * 0.45) * sr), len = Math.floor(0.5 * sr);
        for (let i = 0; i < len && s0 + i < n; i++) {
          const env = Math.min(1, i / (0.01 * sr)) * Math.exp(-i / (0.16 * sr));
          const v = 0.55 * env * (Math.sin(2 * Math.PI * f * i / sr) + 0.25 * Math.sin(4 * Math.PI * f * i / sr));
          L[s0 + i] += v; R[s0 + i] += v * 0.9;
        }
      });
    }
    for (let i = 0; i < n; i++) { const h = (Math.random() - 0.5) * 0.002; L[i] += h; R[i] += h; }
    return b;
  }

  function setBuffer(b, sourceLabel) {
    buf = b;
    segs = [{ start: 0, end: b.duration, keep: true, name: '' }];
    selected = 0; playhead = 0; range = null;
    view = { start: 0, span: b.duration };
    undoStack.length = 0; redoStack.length = 0;
    peaksKey = '';
    const ch = b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : b.numberOfChannels + ' channels';
    $('fileMeta').textContent = `${sourceLabel} · ${fmt(b.duration)} · ${(b.sampleRate / 1000).toFixed(1)} kHz ${ch}`;
    $('empty').hidden = true;
    setControlsEnabled(true);
    renderAll();
  }

  function setControlsEnabled(on) {
    for (const id of ['playBtn', 'splitBtn', 'clearBtn', 'autoBtn', 'zoomIn', 'zoomOut', 'zoomFit']) $(id).disabled = !on;
    if (on) { updateHistoryButtons(); updateExportLabel(); }
    else { $('exportBtn').disabled = true; $('undoBtn').disabled = true; $('redoBtn').disabled = true; }
  }

  // ---------- editing primitives ----------
  // Ensures a part boundary at t. Snaps to an existing boundary (or the file edges) when closer than MIN_PART.
  function cutAt(t) {
    if (t <= MIN_PART) return 0;
    if (t >= buf.duration - MIN_PART) return buf.duration;
    for (const s of segs) {
      if (Math.abs(s.start - t) < MIN_PART) return s.start;
      if (Math.abs(s.end - t) < MIN_PART) return s.end;
    }
    const i = segAt(t), s = segs[i];
    segs.splice(i, 1, { ...s, end: t }, { start: t, end: s.end, keep: s.keep, name: '' });
    return t;
  }
  const segsWithin = (a, b) => segs.map((s, i) => (s.start >= a - 1e-9 && s.end <= b + 1e-9) ? i : -1).filter(i => i >= 0);

  function addSplit(t) {
    if (!buf) return;
    const i = segAt(t), s = segs[i];
    if (t - s.start < MIN_PART || s.end - t < MIN_PART) { setStatus('There is already a split here.', 'err'); return; }
    commit();
    cutAt(t);
    selected = i + 1;
    renderAll();
    setStatus(`Split at ${fmt(t)}. ${segs.length} parts.`);
  }

  function removeRange() {
    if (!range) return;
    commit();
    const a = cutAt(range.a), b = cutAt(range.b);
    const inside = segsWithin(a, b);
    const restoring = inside.length && inside.every(i => !segs[i].keep);
    inside.forEach(i => { segs[i].keep = restoring; });
    tidy();
    range = null;
    renderAll();
    setStatus(restoring ? `Restored ${fmt(b - a)}.` : `Removed ${fmt(b - a)}. Press Ctrl+Z to undo.`, 'ok');
  }

  function keepOnlyRange() {
    if (!range) return;
    commit();
    const a = cutAt(range.a), b = cutAt(range.b);
    segs.forEach(s => { s.keep = s.start >= a - 1e-9 && s.end <= b + 1e-9; });
    tidy();
    range = null;
    playhead = a;
    renderAll();
    setStatus(`Kept ${fmt(b - a)} and removed everything else.`, 'ok');
  }

  function rangeToPart() {
    if (!range) return;
    commit();
    const a = cutAt(range.a), b = cutAt(range.b);
    selected = segAt((a + b) / 2);
    range = null;
    renderAll();
    setStatus(`Part ${selected + 1} is ${fmt(a)} to ${fmt(b)}.`);
  }

  // Merge neighbouring removed parts, so repeated cuts don't leave a pile of tiny removed pieces.
  function tidy() {
    for (let i = segs.length - 2; i >= 0; i--) {
      if (!segs[i].keep && !segs[i + 1].keep) { segs[i].end = segs[i + 1].end; segs.splice(i + 1, 1); }
    }
    selected = clamp(selected, 0, segs.length - 1);
  }

  function removeSplitAfter(i) {
    if (i >= segs.length - 1) return;
    commit();
    segs[i].end = segs[i + 1].end;
    if (!segs[i].keep && segs[i + 1].keep) segs[i].keep = true;
    segs.splice(i + 1, 1);
    selected = Math.min(selected, segs.length - 1);
    renderAll();
  }

  function moveSplit(k, t) {
    const lo = segs[k].start + MIN_PART, hi = segs[k + 1].end - MIN_PART;
    t = clamp(t, lo, hi);
    segs[k].end = t; segs[k + 1].start = t;
  }

  function splitOnSilence() {
    const thrDb = +$('silDb').value, minLen = +$('silLen').value, cut = $('silCut').checked;
    if (!isFinite(thrDb) || !isFinite(minLen) || minLen <= 0) { setStatus('Enter a level in dB and a length in seconds.', 'err'); return; }
    const sr = buf.sampleRate, win = Math.max(1, Math.floor(sr * 0.02)), thr = Math.pow(10, thrDb / 20);
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const frames = Math.floor(buf.length / win), quiet = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (const ch of chans) for (let i = f * win, e = i + win; i < e; i++) sum += ch[i] * ch[i];
      quiet[f] = Math.sqrt(sum / (win * chans.length)) < thr ? 1 : 0;
    }
    const gaps = [], need = Math.ceil(minLen / 0.02);
    let runStart = -1;
    for (let f = 0; f <= frames; f++) {
      if (f < frames && quiet[f]) { if (runStart < 0) runStart = f; continue; }
      if (runStart >= 0) {
        if (f - runStart >= need) gaps.push([runStart * win / sr, Math.min(buf.duration, f * win / sr), runStart === 0, f === frames]);
        runStart = -1;
      }
    }
    if (!gaps.length) { setStatus(`No gaps quieter than ${thrDb} dB lasting ${minLen} s or more. Try a higher level or a shorter length.`, 'err'); return; }
    commit();
    segs = [{ start: 0, end: buf.duration, keep: true, name: '' }];
    if (cut) {
      // remove each gap, leaving a little air (0.15 s) either side of the sound
      const air = 0.15;
      for (const [a, b, atStart, atEnd] of gaps) {
        const ra = atStart ? 0 : a + air, rb = atEnd ? buf.duration : b - air;
        if (rb - ra < MIN_PART * 2) continue;
        const x = cutAt(ra), y = cutAt(rb);
        segsWithin(x, y).forEach(i => { segs[i].keep = false; });
      }
      tidy();
    } else {
      gaps.filter(g => !g[2] && !g[3]).forEach(([a, b]) => cutAt((a + b) / 2));
    }
    selected = 0; range = null;
    renderAll();
    const inner = gaps.filter(g => !g[2] && !g[3]).length;
    setStatus(cut ? `Removed ${gaps.length} silent gap${gaps.length > 1 ? 's' : ''}. ${kept().length} part${kept().length > 1 ? 's' : ''} left.`
                  : `Found ${inner} gap${inner === 1 ? '' : 's'}: ${segs.length} parts.`, 'ok');
  }

  // ---------- view (zoom & scroll) ----------
  function setView(start, span) {
    const d = buf.duration;
    span = clamp(span, Math.min(MIN_SPAN, d), d);
    start = clamp(start, 0, d - span);
    view = { start, span };
    const zoomed = span < d - 1e-9;
    const sc = $('scroll');
    sc.hidden = !zoomed;
    if (zoomed) sc.value = Math.round((start / (d - span)) * 1000);
    $('zoomOut').disabled = !zoomed;
    $('zoomFit').disabled = !zoomed;
    $('zoomIn').disabled = span <= MIN_SPAN + 1e-9;
    draw();
  }
  function zoomAround(t, factor) {
    const span = clamp(view.span * factor, Math.min(MIN_SPAN, buf.duration), buf.duration);
    const rel = view.span ? (t - view.start) / view.span : 0.5;
    setView(t - rel * span, span);
  }
  const viewCenter = () => (range ? (range.a + range.b) / 2 : playhead);
  function zoomIn() { zoomAround(viewCenter(), 0.5); }
  function zoomOut() { zoomAround(viewCenter(), 2); }
  function zoomFit() { setView(0, buf.duration); }
  function follow(t) {
    if (t < view.start || t > view.start + view.span) setView(t - view.span * 0.1, view.span);
  }

  // ---------- drawing ----------
  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }

  function computePeaks(w) {
    const key = `${w}|${view.start}|${view.span}`;
    if (key === peaksKey) return;
    peaksKey = key;
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const n = buf.length, sr = buf.sampleRate, per = (view.span * sr) / w, first = view.start * sr;
    peaks = new Float32Array(w * 2);
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor(first + x * per), s1 = Math.max(s0 + 1, Math.min(n, Math.floor(first + (x + 1) * per)));
      const step = Math.max(1, Math.floor((s1 - s0) / 400));
      let mn = 0, mx = 0;
      for (let i = s0; i < s1 && i < n; i += step) {
        let v = 0; for (const ch of chans) v += ch[i];
        v /= chans.length;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
    }
  }

  let hatch = null, hatchColor = '';
  function hatchPattern(g, dpr) {
    const color = css('--removed');
    if (hatch && hatchColor === color) return hatch;
    const c = document.createElement('canvas'), s = Math.round(8 * dpr);
    c.width = c.height = s;
    const x = c.getContext('2d');
    x.strokeStyle = color; x.lineWidth = 1.2 * dpr;
    x.beginPath(); x.moveTo(0, s); x.lineTo(s, 0); x.moveTo(-s / 2, s / 2); x.lineTo(s / 2, -s / 2); x.moveTo(s / 2, s * 1.5); x.lineTo(s * 1.5, s / 2); x.stroke();
    hatchColor = color;
    return (hatch = g.createPattern(c, 'repeat'));
  }

  function draw() {
    if (!buf) return;
    const { w, h, dpr } = sizeCanvas(wave);
    computePeaks(w);
    const g = wave.getContext('2d'), mid = h / 2;
    const X = t => ((t - view.start) / view.span) * w;
    g.clearRect(0, 0, w, h);
    // removed regions: hatched background
    g.fillStyle = hatchPattern(g, dpr);
    for (const s of segs) if (!s.keep) {
      const x0 = Math.max(0, X(s.start)), x1 = Math.min(w, X(s.end));
      if (x1 > x0) g.fillRect(x0, 0, x1 - x0, h);
    }
    // selected part tint
    const sp = segs[selected];
    if (sp && sp.keep && segs.length > 1) { g.fillStyle = css('--tint'); g.fillRect(X(sp.start), 0, X(sp.end) - X(sp.start), h); }
    // waveform, colored per part
    const cWave = css('--wave'), cAlt = css('--wave-alt'), cOff = css('--wave-off');
    let si = segAt(view.start);
    for (let x = 0; x < w; x++) {
      const t = view.start + ((x + 0.5) / w) * view.span;
      while (si < segs.length - 1 && t >= segs[si].end) si++;
      g.fillStyle = !segs[si].keep ? cOff : si % 2 ? cAlt : cWave;
      const y1 = mid - peaks[x * 2 + 1] * mid * 0.9, y2 = mid - peaks[x * 2] * mid * 0.9;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    // split markers and part numbers
    g.font = `600 ${10 * dpr}px ${css('--font-mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    segs.forEach((s, i) => {
      const xs = X(s.start), xe = X(s.end);
      if (xe < 0 || xs > w) return;
      if (i > 0) { g.fillStyle = css('--marker'); g.fillRect(xs - dpr, 0, 2 * dpr, h); }
      const vx0 = Math.max(xs, 0), vx1 = Math.min(xe, w);
      if (vx1 - vx0 > 40 * dpr) {
        g.fillStyle = s.keep ? css('--fg') : css('--muted');
        g.globalAlpha = 0.6;
        g.fillText(s.keep ? String(i + 1) : 'removed', (vx0 + vx1) / 2, 10 * dpr);
        g.globalAlpha = 1;
      }
    });
    // range selection
    if (range) {
      const xa = X(range.a), xb = X(range.b);
      g.fillStyle = css('--range'); g.fillRect(xa, 0, xb - xa, h);
      g.fillStyle = css('--range-edge');
      g.fillRect(xa - dpr, 0, 2 * dpr, h); g.fillRect(xb - dpr, 0, 2 * dpr, h);
      for (const x of [xa, xb]) g.fillRect(x - 5 * dpr, h - 12 * dpr, 10 * dpr, 12 * dpr);
    }
    // playhead
    const xp = X(playhead);
    if (xp >= -2 && xp <= w + 2) {
      g.fillStyle = css('--playhead');
      g.fillRect(xp - 0.75 * dpr, 0, 1.5 * dpr, h);
      g.beginPath(); g.moveTo(xp - 5 * dpr, 0); g.lineTo(xp + 5 * dpr, 0); g.lineTo(xp, 6 * dpr); g.fill();
    }
    drawRuler();
  }

  function drawRuler() {
    const { w, h, dpr } = sizeCanvas(ruler);
    const g = ruler.getContext('2d'), cssW = w / dpr;
    g.clearRect(0, 0, w, h);
    const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find(s => (cssW / view.span) * s >= 72) || 3600;
    g.fillStyle = css('--muted'); g.strokeStyle = css('--line');
    g.font = `${10 * dpr}px ${css('--font-mono')}`; g.textBaseline = 'middle';
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    for (let k = Math.floor(view.start / step); k * step <= view.start + view.span + 1e-9; k++) {
      const t = k * step;
      if (t < view.start - 1e-9) continue;
      const x = Math.round(((t - view.start) / view.span) * w) + 0.5;
      g.beginPath(); g.moveTo(x, h * 0.55); g.lineTo(x, h); g.stroke();
      let label = fmt(t);
      label = decimals === 0 ? label.replace(/\.\d+$/, '') : label.slice(0, label.length - (3 - decimals));
      if (x + g.measureText(label).width + 4 * dpr < w) g.fillText(label, x + 3 * dpr, h * 0.4);
    }
  }

  // ---------- parts table ----------
  function renderTable() {
    const tb = $('parts');
    tb.textContent = '';
    if (!buf) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="7">Parts appear here once a file is open.</td></tr>';
      return;
    }
    segs.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.className = (i === selected ? 'sel' : '') + (s.keep ? '' : ' off');
      tr.innerHTML = `
        <td class="c-keep"><input type="checkbox" id="keep-${i}" aria-label="Keep part ${i + 1}" ${s.keep ? 'checked' : ''}></td>
        <td class="tc">${i + 1}</td>
        <td><input type="text" id="name-${i}" aria-label="Name of part ${i + 1}" spellcheck="false" ${s.keep ? '' : 'disabled'}></td>
        <td class="tc">${fmt(s.start)}</td>
        <td>${i < segs.length - 1
          ? `<input type="text" id="end-${i}" class="tc" aria-label="End of part ${i + 1}" value="${fmt(s.end)}" size="10">`
          : `<span class="tc">${fmt(s.end)}</span>`}</td>
        <td class="tc">${fmt(s.end - s.start)}</td>
        <td class="c-act"><div class="row">
          <button type="button" class="icon-btn" data-act="play" title="Play part ${i + 1}" aria-label="Play part ${i + 1}">▶</button>
          <button type="button" class="icon-btn" data-act="select" title="Select part ${i + 1} on the waveform" aria-label="Select part ${i + 1} on the waveform">⇤⇥</button>
          ${s.keep ? `<button type="button" class="icon-btn" data-act="save" title="Download part ${i + 1}" aria-label="Download part ${i + 1}">⬇</button>` : ''}
          ${i < segs.length - 1 ? `<button type="button" class="icon-btn" data-act="merge" title="Merge with part ${i + 2}" aria-label="Merge part ${i + 1} with part ${i + 2}">Merge ↓</button>` : ''}
        </div></td>`;
      const name = tr.querySelector(`#name-${i}`);
      name.value = s.keep ? partName(i) : 'removed';
      name.addEventListener('change', () => { commit(); s.name = name.value; });
      name.addEventListener('focus', () => { selected = i; markSelected(); draw(); });
      tr.querySelector(`#keep-${i}`).addEventListener('change', e => { commit(); s.keep = e.target.checked; renderAll(); });
      const endIn = tr.querySelector(`#end-${i}`);
      if (endIn) {
        endIn.addEventListener('change', () => {
          const t = parseTime(endIn.value);
          if (isNaN(t)) { endIn.classList.add('bad'); setStatus('Write times as m:ss.mmm, for example 1:23.500.', 'err'); return; }
          commit(); moveSplit(i, t); renderAll();
        });
        endIn.addEventListener('keydown', e => { if (e.key === 'Enter') endIn.blur(); });
      }
      tr.querySelector('[data-act="play"]').addEventListener('click', () => { selected = i; markSelected(); play(s.start, s.end); });
      tr.querySelector('[data-act="select"]').addEventListener('click', () => {
        range = { a: s.start, b: s.end }; selected = i;
        if (s.start < view.start || s.end > view.start + view.span) setView(s.start - (s.end - s.start) * 0.1, Math.max(view.span, (s.end - s.start) * 1.2));
        renderSelection(); markSelected(); draw();
      });
      const save = tr.querySelector('[data-act="save"]');
      if (save) save.addEventListener('click', () => exportParts([i], 'separate'));
      const merge = tr.querySelector('[data-act="merge"]');
      if (merge) merge.addEventListener('click', () => removeSplitAfter(i));
      tr.addEventListener('click', e => {
        if (e.target.closest('input, button')) return;
        selected = i; playhead = s.start; follow(playhead); markSelected(); draw(); updateClock();
      });
      tb.appendChild(tr);
    });
  }
  function markSelected() {
    [...$('parts').children].forEach((tr, i) => tr.classList.toggle('sel', i === selected));
  }

  function renderSelection() {
    const bar = $('selBar');
    bar.hidden = !range;
    if (!range) return;
    for (const [id, v] of [['selStart', range.a], ['selEnd', range.b]]) {
      const el = $(id);
      if (document.activeElement !== el) el.value = fmt(v);
      el.classList.remove('bad');
    }
    $('selLen').textContent = fmt(range.b - range.a);
    const inside = segs.filter(s => s.start < range.b - 1e-9 && s.end > range.a + 1e-9);
    const allRemoved = inside.length && inside.every(s => !s.keep);
    $('selRemove').textContent = allRemoved ? 'Restore' : 'Remove';
    $('selRemove').classList.toggle('danger', !allRemoved);
  }

  function renderSummary() {
    if (!buf) return;
    const removed = segs.filter(s => !s.keep);
    const total = keptDuration();
    $('summary').textContent = removed.length
      ? `Result ${fmt(total)} · ${fmt(buf.duration - total)} removed in ${removed.length} place${removed.length > 1 ? 's' : ''}`
      : 'Untick a part, or select a range and press Remove, to cut it out.';
  }

  function renderAll() {
    renderTable();
    renderSelection();
    renderSummary();
    draw();
    updateClock();
    updateExportLabel();
    updateHistoryButtons();
  }

  function updateClock() { $('clock').textContent = fmt(playhead); }

  const exportMode = () => document.querySelector('input[name="mode"]:checked').value;
  const exportFmt = () => document.querySelector('input[name="fmt"]:checked').value;

  function updateExportLabel() {
    const n = kept().length, mode = exportMode();
    $('xfRow').hidden = mode !== 'joined';
    $('kbps').disabled = exportFmt() !== 'mp3';
    const btn = $('exportBtn');
    if (!buf) { btn.textContent = 'Download'; btn.disabled = true; return; }
    btn.disabled = busy || n === 0;
    const ext = exportFmt().toUpperCase();
    btn.textContent = n === 0 ? 'Everything is removed'
      : mode === 'joined' ? `Download ${ext} (${fmt(keptDuration()).replace(/\.\d+$/, '')})`
      : n === 1 ? `Download 1 ${ext}` : `Download ${n} ${ext} files (.zip)`;
  }

  // ---------- pointer ----------
  let drag = null;
  const pxToT = clientX => {
    const r = wave.getBoundingClientRect();
    return view.start + clamp((clientX - r.left) / r.width, 0, 1) * view.span;
  };
  const tToPx = t => {
    const r = wave.getBoundingClientRect();
    return r.left + ((t - view.start) / view.span) * r.width;
  };
  function splitNear(clientX, tol) {
    let best = -1, bestD = tol;
    for (let k = 0; k < segs.length - 1; k++) {
      const d = Math.abs(tToPx(segs[k].end) - clientX);
      if (d <= bestD) { best = k; bestD = d; }
    }
    return best;
  }
  function rangeEdgeNear(clientX, tol) {
    if (!range) return null;
    const da = Math.abs(tToPx(range.a) - clientX), db = Math.abs(tToPx(range.b) - clientX);
    if (Math.min(da, db) > tol) return null;
    return da <= db ? 'a' : 'b';
  }
  // snap to split markers, file edges and the playhead while dragging a selection
  function snap(t, clientX) {
    const targets = [0, buf.duration, playhead, ...segs.slice(0, -1).map(s => s.end)];
    for (const v of targets) if (Math.abs(tToPx(v) - clientX) <= SNAP_PX) return v;
    return t;
  }

  wave.addEventListener('pointerdown', e => {
    if (!buf || e.button > 0) return;
    const tol = e.pointerType === 'touch' ? 18 : 8;
    wave.setPointerCapture(e.pointerId);
    const edge = rangeEdgeNear(e.clientX, tol);
    if (edge) { drag = { mode: 'edge', edge }; return; }
    const k = splitNear(e.clientX, tol);
    if (k >= 0) { commit(); drag = { mode: 'split', k }; return; }
    drag = { mode: 'press', x: e.clientX, t: pxToT(e.clientX) };
  });
  wave.addEventListener('pointermove', e => {
    if (!buf) return;
    if (!drag) {
      wave.style.cursor = (rangeEdgeNear(e.clientX, 8) || splitNear(e.clientX, 8) >= 0) ? 'ew-resize' : 'crosshair';
      return;
    }
    const t = snap(pxToT(e.clientX), e.clientX);
    if (drag.mode === 'split') { moveSplit(drag.k, t); draw(); return; }
    if (drag.mode === 'press' && Math.abs(e.clientX - drag.x) > 4) drag = { mode: 'range', origin: snap(drag.t, drag.x) };
    if (drag.mode === 'range') range = { a: Math.min(drag.origin, t), b: Math.max(drag.origin, t) };
    if (drag.mode === 'edge') {
      const other = drag.edge === 'a' ? range.b : range.a;
      if ((drag.edge === 'a' && t > other) || (drag.edge === 'b' && t < other)) drag.edge = drag.edge === 'a' ? 'b' : 'a';
      range = { a: Math.min(t, other), b: Math.max(t, other) };
    }
    if (range && range.b - range.a < 0.001) range = null;
    renderSelection(); draw();
  });
  function endDrag() {
    if (!drag) return;
    if (drag.mode === 'press') {
      playhead = drag.t;
      selected = segAt(playhead);
      range = null;
      if (playing) play(playhead);
      renderSelection(); markSelected(); updateClock(); draw();
    } else if (drag.mode === 'split') {
      renderAll();
    } else if (range && range.b - range.a < 0.01) {
      range = null; renderSelection(); draw();
    }
    drag = null;
  }
  wave.addEventListener('pointerup', endDrag);
  wave.addEventListener('pointercancel', endDrag);
  wave.addEventListener('dblclick', e => {
    if (!buf || splitNear(e.clientX, 8) >= 0) return;
    range = null;
    addSplit(pxToT(e.clientX));
  });
  wave.addEventListener('wheel', e => {
    if (!buf) return;
    if (e.ctrlKey || e.metaKey) {                       // pinch or Ctrl+wheel: zoom at the pointer
      e.preventDefault();
      zoomAround(pxToT(e.clientX), Math.exp(e.deltaY * 0.01));
    } else if (view.span < buf.duration && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
      e.preventDefault();                               // horizontal swipe or Shift+wheel: scroll
      const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      setView(view.start + (d / wave.clientWidth) * view.span, view.span);
    }
  }, { passive: false });
  $('scroll').addEventListener('input', e => {
    setView((+e.target.value / 1000) * (buf.duration - view.span), view.span);
  });

  // ---------- playback ----------
  function play(from, until) {
    stop();
    const ac = audioCtx();
    if (ac.state === 'suspended') ac.resume();
    from = from ?? playhead;
    if (from >= buf.duration - 0.01) from = 0;
    const single = until != null;
    until = until ?? buf.duration;
    if (!single && !segs[segAt(from)].keep) {           // start at the next kept audio
      const next = segs.findIndex(s => s.keep && s.end > from);
      if (next < 0) { setStatus('Nothing left to play after this point.'); return; }
      from = Math.max(from, segs[next].start);
    }
    const src = ac.createBufferSource();
    src.buffer = buf; src.connect(ac.destination);
    const t0 = ac.currentTime + 0.03;
    src.start(t0, from, until - from);
    playing = { src, t0, from, until, single };
    src.onended = () => { if (playing && playing.src === src) { playing = null; setPlayBtn(); draw(); } };
    setPlayBtn();
    tick();
  }
  function stop() {
    if (playing) { const s = playing.src; playing = null; try { s.stop(); } catch (_) {} }
    cancelAnimationFrame(raf);
    setPlayBtn();
  }
  function tick() {
    if (!playing) return;
    playhead = Math.min(playing.until, playing.from + Math.max(0, ctx.currentTime - playing.t0));
    if (!playing.single) {                              // preview the result: jump over removed parts
      const i = segAt(playhead);
      if (!segs[i].keep) {
        const next = segs.findIndex((s, j) => j > i && s.keep);
        if (next < 0) { stop(); draw(); updateClock(); return; }
        play(segs[next].start);
        return;
      }
      if (i !== selected) { selected = i; markSelected(); }
    }
    follow(playhead);
    draw(); updateClock();
    raf = requestAnimationFrame(tick);
  }
  function setPlayBtn() { $('playBtn').textContent = playing ? '❚❚ Pause' : '▶ Play'; }

  // ---------- export ----------
  function renderPart(s, fadeIn, fadeOut) {
    const sr = buf.sampleRate, s0 = Math.round(s.start * sr), s1 = Math.min(buf.length, Math.round(s.end * sr)), n = s1 - s0;
    const fi = Math.min(Math.round(fadeIn * sr), n >> 1), fo = Math.min(Math.round(fadeOut * sr), n >> 1);
    const out = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const dst = buf.getChannelData(c).slice(s0, s1);
      for (let i = 0; i < fi; i++) dst[i] *= i / fi;
      for (let i = 0; i < fo; i++) dst[n - 1 - i] *= i / fo;
      out.push(dst);
    }
    return out;
  }

  // Kept parts that touch each other are one continuous stretch; only real cuts get crossfaded.
  function keptRuns() {
    const runs = [];
    for (const s of segs) {
      if (!s.keep) continue;
      const last = runs[runs.length - 1];
      if (last && Math.abs(last.end - s.start) < 1e-9) last.end = s.end;
      else runs.push({ start: s.start, end: s.end });
    }
    return runs;
  }

  function renderJoined(runs, xfade, fadeIn, fadeOut) {
    const sr = buf.sampleRate, nc = buf.numberOfChannels;
    const pieces = runs.map(s => renderPart(s, 0, 0));
    const lens = pieces.map(p => p[0].length);
    const xf = pieces.length > 1 ? Math.min(Math.round(xfade * sr), ...lens.map(l => l >> 1)) : 0;
    const total = lens.reduce((a, b) => a + b, 0) - xf * (pieces.length - 1);
    const out = Array.from({ length: nc }, () => new Float32Array(total));
    let pos = 0;
    pieces.forEach((p, k) => {
      const n = lens[k], fadeHead = k > 0 ? xf : 0, fadeTail = k < pieces.length - 1 ? xf : 0;
      for (let c = 0; c < nc; c++) {
        const src = p[c], dst = out[c];
        for (let i = 0; i < n; i++) {
          let g = 1;
          if (i < fadeHead) g = Math.sin((i / fadeHead) * Math.PI / 2);            // equal-power crossfade
          else if (i >= n - fadeTail) g = Math.cos(((i - (n - fadeTail)) / fadeTail) * Math.PI / 2);
          dst[pos + i] += src[i] * g;
        }
      }
      pos += n - fadeTail;
    });
    const fi = Math.min(Math.round(fadeIn * sr), total >> 1), fo = Math.min(Math.round(fadeOut * sr), total >> 1);
    for (const ch of out) {
      for (let i = 0; i < fi; i++) ch[i] *= i / fi;
      for (let i = 0; i < fo; i++) ch[total - 1 - i] *= i / fo;
    }
    return out;
  }

  async function encode(channels, onProgress) {
    return exportFmt() === 'mp3'
      ? encodeMp3(channels, buf.sampleRate, +$('kbps').value, onProgress)
      : encodeWav(channels, buf.sampleRate);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function exportParts(indices, mode) {
    if (!buf || busy || !indices.length) return;
    busy = true; updateExportLabel(); stop();
    const ext = exportFmt(), fadeIn = Math.max(0, +$('fadeIn').value || 0) / 1000, fadeOut = Math.max(0, +$('fadeOut').value || 0) / 1000;
    try {
      if (mode === 'joined') {
        setStatus('Joining…');
        await new Promise(r => setTimeout(r, 0));
        const ch = renderJoined(keptRuns(), Math.max(0, +$('xfade').value || 0) / 1000, fadeIn, fadeOut);
        const blob = await encode(ch, p => setStatus(`Encoding MP3… ${Math.round(p * 100)}%`));
        const name = `${fileBase}-edited.${ext}`;
        saveBlob(blob, name);
        setStatus(`Saved ${name} (${fmtBytes(blob.size)}, ${fmt(ch[0].length / buf.sampleRate)}).`, 'ok');
      } else {
        const files = [];
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          setStatus(`Encoding part ${i + 1} (${k + 1} of ${indices.length})…`);
          await new Promise(r => setTimeout(r, 0));
          const blob = await encode(renderPart(segs[i], fadeIn, fadeOut),
            p => setStatus(`Encoding part ${i + 1} (${k + 1} of ${indices.length})… ${Math.round(p * 100)}%`));
          files.push({ name: `${safeName(partName(i))}.${ext}`, blob });
        }
        const seen = new Map();                          // avoid duplicate names inside the zip
        for (const f of files) {
          const n = seen.get(f.name) || 0; seen.set(f.name, n + 1);
          if (n) f.name = f.name.replace(/(\.\w+)$/, `-${n + 1}$1`);
        }
        if (files.length === 1) {
          saveBlob(files[0].blob, files[0].name);
          setStatus(`Saved ${files[0].name} (${fmtBytes(files[0].blob.size)}).`, 'ok');
        } else {
          setStatus('Packing zip…');
          const zip = await zipFiles(files);
          saveBlob(zip, `${fileBase}-parts.zip`);
          setStatus(`Saved ${files.length} files in ${fileBase}-parts.zip (${fmtBytes(zip.size)}).`, 'ok');
        }
      }
    } catch (e) {
      console.error(e);
      setStatus(/allocation|memory|Array buffer/i.test(String(e && e.message)) ? 'Not enough memory to export this much audio at once. Try exporting parts separately, or choose MP3.' : 'Export failed: ' + (e && e.message ? e.message : e), 'err');
    } finally {
      busy = false; updateExportLabel();
    }
  }

  // ---------- wiring ----------
  $('fileInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
  $('sampleBtn').addEventListener('click', () => {
    if (hasEdits() && !confirm('Open the example? Your edits to the current file will be lost.')) return;
    stop(); loadToken++; hideLoading();
    fileBase = 'example';
    $('fileName').textContent = 'example.wav (generated tones)';
    setBuffer(makeSample(), 'Audio');
    setStatus('Example loaded. Drag across the waveform to select a range, then press Remove.');
  });
  $('playBtn').addEventListener('click', () => playing ? stop() : play());
  $('splitBtn').addEventListener('click', () => addSplit(playhead));
  $('clearBtn').addEventListener('click', () => {
    if (!buf || (segs.length === 1 && segs[0].keep)) return;
    commit();
    segs = [{ start: 0, end: buf.duration, keep: true, name: '' }];
    selected = 0; range = null; renderAll(); setStatus('All splits and cuts removed. Press Ctrl+Z to undo.');
  });
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', zoomIn);
  $('zoomOut').addEventListener('click', zoomOut);
  $('zoomFit').addEventListener('click', zoomFit);
  $('autoBtn').addEventListener('click', () => buf && splitOnSilence());
  $('selPlay').addEventListener('click', () => range && play(range.a, range.b));
  $('selRemove').addEventListener('click', removeRange);
  $('selKeep').addEventListener('click', keepOnlyRange);
  $('selPart').addEventListener('click', rangeToPart);
  $('selClear').addEventListener('click', () => { range = null; renderSelection(); draw(); });
  for (const [id, edge] of [['selStart', 'a'], ['selEnd', 'b']]) {
    const el = $(id);
    el.addEventListener('change', () => {
      const t = parseTime(el.value);
      if (!range || isNaN(t)) { el.classList.add('bad'); setStatus('Write times as m:ss.mmm, for example 1:23.500.', 'err'); return; }
      const v = clamp(t, 0, buf.duration), other = edge === 'a' ? range.b : range.a;
      range = { a: Math.min(v, other), b: Math.max(v, other) };
      renderSelection(); draw();
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
  }
  $('exportBtn').addEventListener('click', () => {
    const idx = segs.map((s, i) => s.keep ? i : -1).filter(i => i >= 0);
    exportParts(idx, exportMode());
  });
  document.querySelectorAll('input[name="mode"], input[name="fmt"]').forEach(r => r.addEventListener('change', updateExportLabel));

  window.addEventListener('keydown', e => {
    if (!buf || busy) return;
    const typing = e.target.closest('input[type="text"], input[type="number"], select, textarea');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (typing) return;
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { if (!typing) { e.preventDefault(); redo(); } return; }
    if (typing || mod || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 's' || e.key === 'S') addSplit(playhead);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && range) { e.preventDefault(); removeRange(); }
    else if (e.key === 'Escape' && range) { range = null; renderSelection(); draw(); }
    else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-' || e.key === '_') zoomOut();
    else if (e.key === '0') zoomFit();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      playhead = clamp(playhead + (e.key === 'ArrowLeft' ? -1 : 1), 0, buf.duration);
      if (playing) play(playhead);
      selected = segAt(playhead); follow(playhead); markSelected(); draw(); updateClock();
    }
  });

  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropHint').hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    if (files.length > 1) setStatus(`Opened ${files[0].name}. Drop one file at a time.`);
    loadFile(files[0]);
  });
  window.addEventListener('beforeunload', e => { if (hasEdits()) { e.preventDefault(); e.returnValue = ''; } });

  new ResizeObserver(() => { peaksKey = ''; draw(); }).observe(wave);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { hatch = null; draw(); });
  renderTable();
  updateExportLabel();
})();
