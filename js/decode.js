// Opens audio and video files.
//
// Short files are decoded completely into memory (an AudioBuffer), which allows instant
// playback and lossless WAV export.
//
// Long files would need gigabytes of memory decoded (2 hours of stereo audio is about 3 GB),
// so they open in "large file" mode instead: ffmpeg.wasm reads the file straight from disk
// (WORKERFS, no copy in memory) and produces a low-rate mono copy just for the waveform and
// silence detection; previews play through a normal <audio>/<video> element; and the final
// cuts are made by ffmpeg at export time.
//
// ffmpeg.wasm is downloaded once from a CDN (about 31 MB) the first time it's needed.
(function (global) {
  'use strict';

  const CORE_VERSION = '0.12.10';
  const CORE_MIRRORS = [
    `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
    `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
  ];
  const CORE_WASM_BYTES = 32232419;   // used for progress when the server sends no length
  const MAX_MEMORY_SECONDS = 20 * 60; // longer files open in large-file mode
  const ANALYSIS_RATE = 2000;         // Hz, mono copy used for the waveform in large-file mode
  const MOUNT = '/source';

  const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|3gp|wmv|flv|ts|mts)$/i;
  const isVideo = file => /^video\//.test(file.type) || VIDEO_EXT.test(file.name);

  class DecodeError extends Error {
    constructor(userMessage, detail) { super(detail || userMessage); this.userMessage = userMessage; }
  }

  // ---------- ffmpeg.wasm (lazy) ----------
  let ffmpegPromise = null;
  let ffmpegLog = [];
  let logListeners = [];

  async function fetchWithProgress(url, expected, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = +res.headers.get('content-length') || expected || 0;
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress && onProgress(Math.min(1, got / total));
    }
    return new Blob(chunks);
  }

  async function loadCore(onProgress) {
    let lastErr;
    for (const base of CORE_MIRRORS) {
      try {
        const js = await fetchWithProgress(base + 'ffmpeg-core.js');
        const wasm = await fetchWithProgress(base + 'ffmpeg-core.wasm', CORE_WASM_BYTES, onProgress);
        return {
          coreURL: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })),
          wasmURL: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
        };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function getFFmpeg(onStage) {
    if (!ffmpegPromise) {
      ffmpegPromise = (async () => {
        if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
          throw new DecodeError("This browser can't convert files. Try the latest Chrome, Edge, Firefox or Safari.");
        }
        let mod;
        try {
          mod = await import(new URL('vendor/ffmpeg/index.js', document.baseURI).href);
        } catch (e) {
          throw new DecodeError("The converter couldn't start. If you opened the page straight from your disk, use the website address instead.", e.message);
        }
        const label = 'Downloading the converter (about 31 MB, only the first time)…';
        onStage(label, 0);
        let urls;
        try {
          urls = await loadCore(p => onStage(label, p));
        } catch (e) {
          throw new DecodeError("Couldn't download the converter. Check your internet connection and try again.", e.message);
        }
        onStage('Starting the converter…', null);
        const ff = new mod.FFmpeg();
        ff.on('log', ({ message }) => {
          ffmpegLog.push(message);
          if (ffmpegLog.length > 400) ffmpegLog.shift();
          logListeners.forEach(fn => fn(message));
        });
        await ff.load(urls);
        return ff;
      })();
      ffmpegPromise.catch(() => { ffmpegPromise = null; });   // allow a retry later
    }
    return ffmpegPromise;
  }

  // Runs ffmpeg and reports progress from its "time=" log lines against an expected output length.
  async function run(ff, args, expectedSeconds, onProgress) {
    ffmpegLog = [];
    const listener = msg => {
      const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
      if (m && expectedSeconds > 0 && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / expectedSeconds));
    };
    logListeners.push(listener);
    try {
      return { code: await ff.exec(['-hide_banner', '-nostdin', '-y', ...args]), log: ffmpegLog.join('\n') };
    } finally {
      logListeners = logListeners.filter(l => l !== listener);
    }
  }

  function explainFailure(log) {
    if (/matches no streams|does not contain any stream|Output file #0 does not contain/i.test(log) || (/Stream #/.test(log) && !/Audio:/.test(log))) {
      return new DecodeError('This file has no sound track.', log.slice(-600));
    }
    if (/Invalid data found|could not find codec|Unknown format|moov atom not found|could not find corresponding trailer/i.test(log)) {
      return new DecodeError("This file is damaged or isn't an audio or video file.", log.slice(-600));
    }
    if (/Cannot allocate memory|out of memory|OOM/i.test(log)) {
      return new DecodeError('Your device ran out of memory. Close other tabs and try again.', log.slice(-600));
    }
    return new DecodeError("Couldn't process this file.", log.slice(-600));
  }

  // ---------- mounting the original file (read from disk on demand) ----------
  let mountedFile = null;
  async function mountFile(ff, file) {
    if (mountedFile === file) return `${MOUNT}/${file.name}`;
    if (mountedFile) { await ff.unmount(MOUNT).catch(() => {}); mountedFile = null; }
    await ff.createDir(MOUNT).catch(() => {});
    await ff.mount('WORKERFS', { files: [file] }, MOUNT);
    mountedFile = file;
    return `${MOUNT}/${file.name}`;
  }

  // ---------- metadata via a media element (fast, doesn't decode the whole file) ----------
  function probeMedia(file) {
    return new Promise(resolve => {
      const el = document.createElement(isVideo(file) ? 'video' : 'audio');
      el.preload = 'metadata'; el.muted = true;
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = ok => {
        if (done) return; done = true;
        clearTimeout(timer);
        const d = el.duration;
        resolve({ el, url, playable: ok, duration: ok && isFinite(d) && d > 0 ? d : null });
      };
      const timer = setTimeout(() => finish(false), 15000);
      el.addEventListener('loadedmetadata', () => {
        if (isFinite(el.duration)) return finish(true);
        // some files report Infinity until the browser has seeked to the end
        el.currentTime = 1e7;
        el.addEventListener('durationchange', () => isFinite(el.duration) && finish(true), { once: true });
      }, { once: true });
      el.addEventListener('error', () => finish(false), { once: true });
      el.src = url;
    });
  }

  // A small stand-in for AudioBuffer, holding the low-rate analysis copy.
  function analysisBuffer(samples, duration) {
    return {
      sampleRate: ANALYSIS_RATE, numberOfChannels: 1, length: samples.length,
      duration, getChannelData: () => samples,
    };
  }

  async function durationWithFFmpeg(file, onStage) {
    const ff = await getFFmpeg(onStage);
    const src = await mountFile(ff, file);
    onStage('Checking the file…', null);
    const { log } = await run(ff, ['-i', src], 0);   // no output file: fails, but prints the duration
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    if (!m) throw explainFailure(log);
    if (!/Audio:/.test(log)) throw new DecodeError('This file has no sound track.', log.slice(-600));
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }

  // ---------- in-memory decoding ----------
  async function decodeInMemoryWithFFmpeg(file, ctx, onStage) {
    const ff = await getFFmpeg(onStage);
    const src = await mountFile(ff, file);
    onStage('Extracting the sound…', null);
    const { code, log } = await run(ff, ['-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_s16le', '-f', 'wav', '/decoded.wav'], 0);
    if (code !== 0) throw explainFailure(log);
    const wav = await ff.readFile('/decoded.wav');
    await ff.deleteFile('/decoded.wav').catch(() => {});
    onStage('Preparing the waveform…', null);
    try {
      return await ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
    } catch (e) {
      throw new DecodeError("Couldn't read the extracted sound.", e.message);
    }
  }

  // ---------- large-file mode ----------
  async function openLarge(file, probe, onStage) {
    const ff = await getFFmpeg(onStage);
    const src = await mountFile(ff, file);
    onStage('Reading the recording to draw its waveform…', 0);
    const { code, log } = await run(ff,
      ['-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 's16le', '-c:a', 'pcm_s16le', '/analysis.raw'],
      probe.duration || 0, p => onStage('Reading the recording to draw its waveform…', p));
    if (code !== 0) throw explainFailure(log);
    const raw = await ff.readFile('/analysis.raw');
    await ff.deleteFile('/analysis.raw').catch(() => {});
    const ints = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
    const samples = new Float32Array(ints.length);
    for (let i = 0; i < ints.length; i++) samples[i] = ints[i] / 32768;
    const m = /Audio: [^,]+, (\d+) Hz, ([^,\n]+)/.exec(log);
    const channelsText = m ? m[2].trim() : '';
    const channels = /mono/.test(channelsText) ? 1 : /stereo/.test(channelsText) ? 2 : (parseInt(channelsText, 10) || 2);
    const duration = probe.duration || samples.length / ANALYSIS_RATE;
    return {
      kind: 'large', file, video: isVideo(file),
      analysis: analysisBuffer(samples, duration),
      info: { sampleRate: m ? +m[1] : 44100, channels },
      media: probe.playable ? probe.el : null,
    };
  }

  /**
   * Opens a file for editing.
   * @returns {Promise<
   *   {kind: 'memory', buffer: AudioBuffer, video: boolean, via: 'browser'|'ffmpeg'} |
   *   {kind: 'large', file: File, video: boolean, analysis: object, info: {sampleRate, channels}, media: HTMLMediaElement|null}>}
   */
  async function openFile(file, ctx, onStage) {
    if (!file.size) throw new DecodeError('This file is empty.');
    const video = isVideo(file);
    onStage('Checking the file…', null);
    const probe = await probeMedia(file);
    if (!probe.duration && file.size > 30 * 1024 ** 2) {
      // The browser can't tell how long it is; ask ffmpeg before risking a huge in-memory decode.
      probe.duration = await durationWithFFmpeg(file, onStage);
    }
    if (probe.duration > MAX_MEMORY_SECONDS) return openLarge(file, probe, onStage);

    // short file: decode it completely
    const release = () => { probe.el.removeAttribute('src'); probe.el.load(); URL.revokeObjectURL(probe.url); };
    onStage(video ? 'Extracting the sound…' : 'Decoding…', null);
    let data;
    try { data = await file.arrayBuffer(); }
    catch (e) { release(); throw new DecodeError("Couldn't read the file. It may have been moved, or be too large for this device.", e.message); }
    try {
      const buffer = await ctx.decodeAudioData(data);
      release();
      return { kind: 'memory', buffer, video, via: 'browser' };
    } catch (_) {
      data = null;
    }
    // The browser can't decode it: convert it. Long ones go to large-file mode.
    if (!probe.duration) probe.duration = await durationWithFFmpeg(file, onStage);
    if (probe.duration > MAX_MEMORY_SECONDS) return openLarge(file, probe, onStage);
    release();
    const buffer = await decodeInMemoryWithFFmpeg(file, ctx, onStage);
    return { kind: 'memory', buffer, video, via: 'ffmpeg' };
  }

  // ---------- export in large-file mode ----------
  const num = v => (Math.round(v * 1e6) / 1e6).toString();

  /**
   * Cuts the original file with ffmpeg.
   * @param {object} o
   * @param {File} o.file
   * @param {{start:number,end:number}[]} o.runs  stretches to keep, in order
   * @param {'mp3'|'wav'} o.format
   * @param {number} o.kbps
   * @param {number} o.fadeIn, o.fadeOut, o.xfade  seconds
   * @param {boolean} o.joined  true: one file; false: one file per run
   * @param {(text:string, p:number|null)=>void} o.onStage
   * @returns {Promise<Blob[]>}
   */
  async function exportLarge(o) {
    const ff = await getFFmpeg(o.onStage);
    const src = await mountFile(ff, o.file);
    const ext = o.format === 'mp3' ? 'mp3' : 'wav';
    const codec = o.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${o.kbps}k`] : ['-c:a', 'pcm_s16le'];
    const out = [];

    const fades = (len, fi, fo) => {
      const f = [];
      if (fi > 0) f.push(`afade=t=in:st=0:d=${num(Math.min(fi, len / 2))}`);
      if (fo > 0) f.push(`afade=t=out:st=${num(Math.max(0, len - Math.min(fo, len / 2)))}:d=${num(Math.min(fo, len / 2))}`);
      return f;
    };

    if (o.joined) {
      const runs = o.runs, lens = runs.map(r => r.end - r.start);
      const xf = runs.length > 1 ? Math.min(o.xfade, ...lens.map(l => l / 2)) : 0;
      const total = lens.reduce((a, b) => a + b, 0) - xf * (runs.length - 1);
      const g = runs.map((r, i) => `[0:a]atrim=start=${num(r.start)}:end=${num(r.end)},asetpts=PTS-STARTPTS[p${i}]`);
      let last = 'p0';
      if (runs.length > 1) {
        if (xf > 0.001) {
          for (let i = 1; i < runs.length; i++) {
            g.push(`[${last}][p${i}]acrossfade=d=${num(xf)}:c1=qsin:c2=qsin[x${i}]`);
            last = `x${i}`;
          }
        } else {
          g.push(runs.map((_, i) => `[p${i}]`).join('') + `concat=n=${runs.length}:v=0:a=1[cat]`);
          last = 'cat';
        }
      }
      const f = fades(total, o.fadeIn, o.fadeOut);
      g.push(`[${last}]${f.length ? f.join(',') : 'anull'}[out]`);
      await ff.writeFile('/graph.txt', new TextEncoder().encode(g.join(';\n')));
      const name = `/out.${ext}`;
      const label = o.format === 'mp3' ? 'Encoding MP3…' : 'Writing WAV…';
      o.onStage(label, 0);
      const { code, log } = await run(ff, ['-i', src, '-filter_complex_script', '/graph.txt', '-map', '[out]', '-vn', ...codec, name], total, p => o.onStage(label, p));
      await ff.deleteFile('/graph.txt').catch(() => {});
      if (code !== 0) throw explainFailure(log);
      const data = await ff.readFile(name);
      await ff.deleteFile(name).catch(() => {});
      out.push(new Blob([data], { type: o.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
    } else {
      for (let i = 0; i < o.runs.length; i++) {
        const r = o.runs[i], len = r.end - r.start, name = `/part${i}.${ext}`;
        const label = `Encoding part ${i + 1} of ${o.runs.length}…`;
        o.onStage(label, 0);
        const f = fades(len, o.fadeIn, o.fadeOut);
        const { code, log } = await run(ff,
          ['-ss', num(r.start), '-i', src, '-t', num(len), '-map', '0:a:0', '-vn', ...(f.length ? ['-af', f.join(',')] : []), ...codec, name],
          len, p => o.onStage(label, p));
        if (code !== 0) throw explainFailure(log);
        const data = await ff.readFile(name);
        await ff.deleteFile(name).catch(() => {});
        out.push(new Blob([data], { type: o.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }));
      }
    }
    return out;
  }

  global.AudioDecode = { openFile, exportLarge, isVideo, DecodeError };
})(window);
