// Audio Splitter: load a file, place split points, choose which parts to keep, export.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { encodeWav, encodeMp3, zipFiles } = window.AudioEncoders;

  const wave = $('wave'), ruler = $('ruler');
  let ctx = null;               // AudioContext, created on first use
  let buf = null;               // decoded AudioBuffer
  let fileBase = 'audio';
  let segs = [];                // [{ start, end, keep, name }] — contiguous, covering the whole file
  let selected = 0;             // index of the highlighted part
  let playhead = 0;             // seconds
  let playing = null;           // { src, t0, from, until }
  let peaks = null;
  let raf = 0;
  let busy = false;

  const MIN_PART = 0.05;        // seconds
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
  const pad2 = n => String(n).padStart(2, '0');
  const safeName = s => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'part';
  const partName = i => segs[i].name || `${fileBase}-part-${pad2(i + 1)}`;
  const segAt = t => {
    const i = segs.findIndex(s => t >= s.start && t < s.end);
    return i < 0 ? segs.length - 1 : i;
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function setStatus(msg, kind) {
    const s = $('status');
    s.textContent = msg;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- loading ----------
  async function loadFile(file) {
    if (busy) return;
    stop();
    setStatus('Opening ' + file.name + '…');
    try {
      const decoded = await audioCtx().decodeAudioData(await file.arrayBuffer());
      fileBase = safeName(file.name.replace(/\.[^.]+$/, '')) || 'audio';
      $('fileName').textContent = file.name;
      setBuffer(decoded);
      setStatus('Double-click the waveform or press S to add a split.');
    } catch (e) {
      setStatus("Your browser can't read that file. Try MP3, WAV, M4A, OGG or FLAC.", 'err');
    }
  }

  function makeSample() {
    // Three short "tracks" separated by silence, so Split on silence has something to find.
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

  function setBuffer(b) {
    buf = b;
    segs = [{ start: 0, end: b.duration, keep: true, name: '' }];
    selected = 0; playhead = 0; peaks = null;
    const ch = b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : b.numberOfChannels + ' channels';
    $('fileMeta').textContent = `${fmt(b.duration)} · ${(b.sampleRate / 1000).toFixed(1)} kHz · ${ch}`;
    $('empty').hidden = true;
    for (const id of ['playBtn', 'splitBtn', 'clearBtn', 'autoBtn', 'exportBtn']) $(id).disabled = false;
    renderAll();
  }

  // ---------- splits ----------
  function addSplit(t) {
    if (!buf) return false;
    const i = segAt(t), s = segs[i];
    if (t - s.start < MIN_PART || s.end - t < MIN_PART) {
      setStatus('Too close to an existing split.', 'err');
      return false;
    }
    segs.splice(i, 1, { ...s, end: t }, { start: t, end: s.end, keep: s.keep, name: '' });
    selected = i + 1;
    renderAll();
    setStatus(`${segs.length} parts.`);
    return true;
  }

  function removeSplitAfter(i) {
    if (i >= segs.length - 1) return;
    segs[i].end = segs[i + 1].end;
    segs.splice(i + 1, 1);
    selected = Math.min(selected, segs.length - 1);
    renderAll();
  }

  function moveSplit(k, t) {
    // split k sits between segs[k] and segs[k + 1]
    const lo = segs[k].start + MIN_PART, hi = segs[k + 1].end - MIN_PART;
    t = Math.max(lo, Math.min(hi, t));
    segs[k].end = t; segs[k + 1].start = t;
  }

  function splitOnSilence() {
    const thrDb = +$('silDb').value, minLen = +$('silLen').value;
    if (!isFinite(thrDb) || !isFinite(minLen) || minLen <= 0) { setStatus('Enter a level in dB and a length in seconds.', 'err'); return; }
    const sr = buf.sampleRate, win = Math.max(1, Math.floor(sr * 0.02)), thr = Math.pow(10, thrDb / 20);
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const frames = Math.floor(buf.length / win), quiet = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (const ch of chans) for (let i = f * win, e = i + win; i < e; i++) sum += ch[i] * ch[i];
      quiet[f] = Math.sqrt(sum / (win * chans.length)) < thr ? 1 : 0;
    }
    const cuts = [], need = Math.ceil(minLen / 0.02);
    let runStart = -1;
    for (let f = 0; f <= frames; f++) {
      if (f < frames && quiet[f]) { if (runStart < 0) runStart = f; continue; }
      if (runStart >= 0) {
        const len = f - runStart;
        const atEdge = runStart === 0 || f === frames;     // leading/trailing silence isn't a gap between parts
        if (len >= need && !atEdge) cuts.push(((runStart + f) / 2) * win / sr);
        runStart = -1;
      }
    }
    if (!cuts.length) { setStatus(`No gaps quieter than ${thrDb} dB lasting ${minLen} s or more. Try a higher level or shorter length.`, 'err'); return; }
    const bounds = [0, ...cuts, buf.duration];
    segs = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1], keep: true, name: '' }));
    selected = 0;
    renderAll();
    setStatus(`Found ${cuts.length} gap${cuts.length > 1 ? 's' : ''}: ${segs.length} parts.`, 'ok');
  }

  // ---------- drawing ----------
  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }

  function computePeaks(w) {
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const n = buf.length, per = n / w;
    peaks = new Float32Array(w * 2);
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor(x * per), s1 = Math.max(s0 + 1, Math.min(n, Math.floor((x + 1) * per)));
      const step = Math.max(1, Math.floor((s1 - s0) / 500));
      let mn = 0, mx = 0;
      for (let i = s0; i < s1; i += step) {
        let v = 0; for (const ch of chans) v += ch[i];
        v /= chans.length;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
    }
  }

  function draw() {
    if (!buf) return;
    const { w, h, dpr } = sizeCanvas(wave);
    if (!peaks || peaks.length !== w * 2) computePeaks(w);
    const g = wave.getContext('2d'), X = t => (t / buf.duration) * w, mid = h / 2;
    g.clearRect(0, 0, w, h);
    const cWave = css('--wave'), cAlt = css('--wave-alt'), cOff = css('--wave-off');
    // selected part tint
    const sp = segs[selected];
    if (sp) { g.fillStyle = css('--tint'); g.fillRect(X(sp.start), 0, X(sp.end) - X(sp.start), h); }
    // waveform, colored per part
    let si = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + 0.5) / w * buf.duration;
      while (si < segs.length - 1 && t >= segs[si].end) si++;
      g.fillStyle = !segs[si].keep ? cOff : si % 2 ? cAlt : cWave;
      const y1 = mid - peaks[x * 2 + 1] * mid * 0.9, y2 = mid - peaks[x * 2] * mid * 0.9;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    // split markers with numbered tabs
    g.font = `600 ${10 * dpr}px ${css('--font-mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    segs.forEach((s, i) => {
      const xs = X(s.start), xe = X(s.end);
      if (i > 0) { g.fillStyle = css('--marker'); g.fillRect(xs - dpr, 0, 2 * dpr, h); }
      if (xe - xs > 22 * dpr) {
        const cx = (xs + xe) / 2;
        g.fillStyle = s.keep ? css('--fg') : css('--muted');
        g.globalAlpha = 0.55;
        g.fillText(String(i + 1), cx, 10 * dpr);
        g.globalAlpha = 1;
      }
    });
    // playhead
    g.fillStyle = css('--playhead');
    g.fillRect(X(playhead) - 0.75 * dpr, 0, 1.5 * dpr, h);
    drawRuler();
  }

  function drawRuler() {
    const { w, h, dpr } = sizeCanvas(ruler);
    const g = ruler.getContext('2d'), d = buf.duration, cssW = w / dpr;
    g.clearRect(0, 0, w, h);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find(s => (cssW / d) * s >= 72) || 3600;
    g.fillStyle = css('--muted'); g.strokeStyle = css('--line');
    g.font = `${10 * dpr}px ${css('--font-mono')}`; g.textBaseline = 'middle';
    for (let k = 0; k * step <= d + 1e-9; k++) {
      const t = k * step, x = Math.round((t / d) * w) + 0.5;
      g.beginPath(); g.moveTo(x, h * 0.55); g.lineTo(x, h); g.stroke();
      let label = fmt(t);
      label = step >= 1 ? label.replace(/\.000$/, '') : label.replace(/0+$/, '');
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
        <td><input type="text" id="name-${i}" aria-label="Name of part ${i + 1}" spellcheck="false"></td>
        <td class="tc">${fmt(s.start)}</td>
        <td>${i < segs.length - 1
          ? `<input type="text" id="end-${i}" class="tc" aria-label="End of part ${i + 1}" value="${fmt(s.end)}" size="10">`
          : `<span class="tc">${fmt(s.end)}</span>`}</td>
        <td class="tc">${fmt(s.end - s.start)}</td>
        <td class="c-act"><div class="row">
          <button type="button" class="icon-btn" data-act="play" title="Play part ${i + 1}" aria-label="Play part ${i + 1}">▶</button>
          <button type="button" class="icon-btn" data-act="save" title="Download part ${i + 1}" aria-label="Download part ${i + 1}">⬇</button>
          ${i < segs.length - 1 ? `<button type="button" class="icon-btn" data-act="merge" title="Merge with part ${i + 2}" aria-label="Merge part ${i + 1} with part ${i + 2}">⤓ Merge</button>` : ''}
        </div></td>`;
      const name = tr.querySelector(`#name-${i}`);
      name.value = partName(i);
      name.addEventListener('input', () => { s.name = name.value; });
      name.addEventListener('focus', () => { selected = i; markSelected(); draw(); });
      tr.querySelector(`#keep-${i}`).addEventListener('change', e => { s.keep = e.target.checked; renderAll(); });
      const endIn = tr.querySelector(`#end-${i}`);
      if (endIn) {
        endIn.addEventListener('change', () => {
          const t = parseTime(endIn.value);
          if (isNaN(t)) { endIn.classList.add('bad'); setStatus('Write times as m:ss.mmm, for example 1:23.500.', 'err'); return; }
          moveSplit(i, t); renderAll();
        });
        endIn.addEventListener('keydown', e => { if (e.key === 'Enter') endIn.blur(); });
      }
      tr.querySelector('[data-act="play"]').addEventListener('click', () => { selected = i; play(s.start, s.end); });
      tr.querySelector('[data-act="save"]').addEventListener('click', () => exportParts([i], 'separate'));
      const merge = tr.querySelector('[data-act="merge"]');
      if (merge) merge.addEventListener('click', () => removeSplitAfter(i));
      tr.addEventListener('click', e => {
        if (e.target.closest('input, button')) return;
        selected = i; playhead = s.start; markSelected(); draw(); updateClock();
      });
      tb.appendChild(tr);
    });
  }
  function markSelected() {
    [...$('parts').children].forEach((tr, i) => tr.classList.toggle('sel', i === selected));
  }

  function renderAll() {
    renderTable();
    draw();
    updateClock();
    updateExportLabel();
  }

  function updateClock() { $('clock').textContent = fmt(playhead); }

  function exportMode() { return document.querySelector('input[name="mode"]:checked').value; }
  function exportFmt() { return document.querySelector('input[name="fmt"]:checked').value; }

  function updateExportLabel() {
    const kept = segs.filter(s => s.keep).length, mode = exportMode();
    $('xfRow').hidden = mode !== 'joined';
    $('kbps').disabled = exportFmt() !== 'mp3';
    const btn = $('exportBtn');
    if (!buf) { btn.textContent = 'Download'; return; }
    btn.disabled = busy || kept === 0;
    const ext = exportFmt().toUpperCase();
    btn.textContent = kept === 0 ? 'Nothing to download'
      : mode === 'joined' ? `Download 1 ${ext}`
      : kept === 1 ? `Download 1 ${ext}` : `Download ${kept} ${ext} files (.zip)`;
  }

  // ---------- pointer ----------
  let drag = null;
  const xToT = clientX => {
    const r = wave.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * buf.duration;
  };
  const splitNear = (clientX, tol) => {
    const r = wave.getBoundingClientRect();
    let best = -1, bestD = tol;
    for (let k = 0; k < segs.length - 1; k++) {
      const d = Math.abs(r.left + (segs[k].end / buf.duration) * r.width - clientX);
      if (d <= bestD) { best = k; bestD = d; }
    }
    return best;
  };
  wave.addEventListener('pointerdown', e => {
    if (!buf || e.button > 0) return;
    const k = splitNear(e.clientX, e.pointerType === 'touch' ? 20 : 8);
    if (k >= 0) { drag = { k }; wave.setPointerCapture(e.pointerId); return; }
    playhead = xToT(e.clientX);
    selected = segAt(playhead);
    if (playing) play(playhead);
    markSelected(); draw(); updateClock();
  });
  wave.addEventListener('pointermove', e => {
    if (!buf) return;
    if (drag) { moveSplit(drag.k, xToT(e.clientX)); draw(); return; }
    wave.style.cursor = splitNear(e.clientX, 8) >= 0 ? 'ew-resize' : 'crosshair';
  });
  const endDrag = () => { if (drag) { drag = null; renderTable(); } };
  wave.addEventListener('pointerup', endDrag);
  wave.addEventListener('pointercancel', endDrag);
  wave.addEventListener('dblclick', e => { if (buf && splitNear(e.clientX, 8) < 0) addSplit(xToT(e.clientX)); });

  // ---------- playback ----------
  function play(from, until) {
    stop();
    const ac = audioCtx();
    if (ac.state === 'suspended') ac.resume();
    from = from ?? playhead;
    if (from >= buf.duration - 0.01) from = 0;
    until = until ?? buf.duration;
    const src = ac.createBufferSource();
    src.buffer = buf; src.connect(ac.destination);
    const t0 = ac.currentTime + 0.03;
    src.start(t0, from, until - from);
    playing = { src, t0, from, until, single: until !== buf.duration };
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
    // when previewing the whole file, jump over parts that will be cut
    if (!playing.single) {
      const i = segAt(playhead);
      if (!segs[i].keep) {
        const next = segs.findIndex((s, j) => j > i && s.keep);
        if (next < 0) { stop(); draw(); updateClock(); return; }
        play(segs[next].start);
        return;
      }
      if (i !== selected) { selected = i; markSelected(); }
    }
    draw(); updateClock();
    raf = requestAnimationFrame(tick);
  }
  function setPlayBtn() { $('playBtn').textContent = playing ? '❚❚ Pause' : '▶ Play'; }

  // ---------- export ----------
  function renderPart(s, fadeIn, fadeOut) {
    const sr = buf.sampleRate, s0 = Math.round(s.start * sr), s1 = Math.round(s.end * sr), n = s1 - s0;
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

  function renderJoined(parts, xfade, fadeIn, fadeOut) {
    const sr = buf.sampleRate, nc = buf.numberOfChannels;
    const pieces = parts.map(s => renderPart(s, 0, 0));
    const lens = pieces.map(p => p[0].length);
    const xf = Math.min(Math.round(xfade * sr), ...lens.map(l => l >> 1));
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
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  const sizeLabel = b => b.size > 1048576 ? (b.size / 1048576).toFixed(1) + ' MB' : Math.ceil(b.size / 1024) + ' KB';

  async function exportParts(indices, mode) {
    if (!buf || busy || !indices.length) return;
    busy = true; updateExportLabel(); stop();
    const ext = exportFmt(), fadeIn = Math.max(0, +$('fadeIn').value || 0) / 1000, fadeOut = Math.max(0, +$('fadeOut').value || 0) / 1000;
    try {
      if (mode === 'joined') {
        setStatus('Joining parts…');
        await new Promise(r => setTimeout(r, 0));
        const ch = renderJoined(indices.map(i => segs[i]), Math.max(0, +$('xfade').value || 0) / 1000, fadeIn, fadeOut);
        const blob = await encode(ch, p => setStatus(`Encoding MP3… ${Math.round(p * 100)}%`));
        const name = `${fileBase}-edit.${ext}`;
        saveBlob(blob, name);
        setStatus(`Saved ${name} (${sizeLabel(blob)}).`, 'ok');
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
        // avoid duplicate names inside the zip
        const seen = new Map();
        for (const f of files) {
          const n = seen.get(f.name) || 0; seen.set(f.name, n + 1);
          if (n) f.name = f.name.replace(/(\.\w+)$/, `-${n + 1}$1`);
        }
        if (files.length === 1) {
          saveBlob(files[0].blob, files[0].name);
          setStatus(`Saved ${files[0].name} (${sizeLabel(files[0].blob)}).`, 'ok');
        } else {
          setStatus('Packing zip…');
          const zip = await zipFiles(files);
          saveBlob(zip, `${fileBase}-parts.zip`);
          setStatus(`Saved ${files.length} files in ${fileBase}-parts.zip (${sizeLabel(zip)}).`, 'ok');
        }
      }
    } catch (e) {
      setStatus('Export failed: ' + (e && e.message ? e.message : e), 'err');
    } finally {
      busy = false; updateExportLabel();
    }
  }

  // ---------- wiring ----------
  $('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  $('sampleBtn').addEventListener('click', () => {
    stop(); fileBase = 'example';
    $('fileName').textContent = 'example.wav (generated tones)';
    setBuffer(makeSample());
    setStatus('Example loaded. Open "Split on silence" and press Find splits.');
    $('autoBox').open = true;
  });
  $('playBtn').addEventListener('click', () => playing ? stop() : play());
  $('splitBtn').addEventListener('click', () => addSplit(playhead));
  $('clearBtn').addEventListener('click', () => {
    if (!buf) return;
    segs = [{ start: 0, end: buf.duration, keep: true, name: '' }];
    selected = 0; renderAll(); setStatus('All splits removed.');
  });
  $('autoBtn').addEventListener('click', () => buf && splitOnSilence());
  $('exportBtn').addEventListener('click', () => {
    const kept = segs.map((s, i) => s.keep ? i : -1).filter(i => i >= 0);
    exportParts(kept, exportMode());
  });
  document.querySelectorAll('input[name="mode"], input[name="fmt"]').forEach(r => r.addEventListener('change', updateExportLabel));

  window.addEventListener('keydown', e => {
    if (!buf || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 's' || e.key === 'S') addSplit(playhead);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      playhead = Math.max(0, Math.min(buf.duration, playhead + (e.key === 'ArrowLeft' ? -1 : 1)));
      if (playing) play(playhead);
      selected = segAt(playhead); markSelected(); draw(); updateClock();
    }
  });

  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropHint').hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
    const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
  });

  new ResizeObserver(() => { peaks = null; draw(); }).observe(wave);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);
  renderTable();
  updateExportLabel();
})();
