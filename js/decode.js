// Turns any audio or video file into an AudioBuffer.
// First tries the browser's own decoder. If that fails (for example AAC audio in a browser
// built without it, or a container the browser doesn't read), it falls back to ffmpeg.wasm,
// which is downloaded once from a CDN and cached by the browser.
(function (global) {
  'use strict';

  const CORE_VERSION = '0.12.10';
  const CORE_MIRRORS = [
    `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
    `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
  ];
  const CORE_WASM_BYTES = 32232419;   // used for progress when the server sends no length
  const MAX_BYTES = 2 * 1024 ** 3;    // browsers can't hold larger files in memory reliably

  const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|3gp|wmv|flv|ts|mts)$/i;
  const isVideo = file => /^video\//.test(file.type) || VIDEO_EXT.test(file.name);

  class DecodeError extends Error {
    constructor(userMessage, detail) { super(detail || userMessage); this.userMessage = userMessage; }
  }

  // ---------- ffmpeg.wasm (lazy) ----------
  let ffmpegPromise = null;
  let ffmpegLog = [];

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
        let mod;
        try {
          mod = await import(new URL('vendor/ffmpeg/index.js', document.baseURI).href);
        } catch (e) {
          throw new DecodeError("The converter couldn't start. If you opened the page straight from your disk, serve it over http(s) instead.", e.message);
        }
        onStage('Downloading the converter (about 31 MB, only once)…', 0);
        let urls;
        try {
          urls = await loadCore(p => onStage('Downloading the converter (about 31 MB, only once)…', p));
        } catch (e) {
          throw new DecodeError("Couldn't download the converter. Check your internet connection and try again.", e.message);
        }
        onStage('Starting the converter…', null);
        const ff = new mod.FFmpeg();
        ff.on('log', ({ message }) => { ffmpegLog.push(message); if (ffmpegLog.length > 400) ffmpegLog.shift(); });
        await ff.load(urls);
        return ff;
      })();
      ffmpegPromise.catch(() => { ffmpegPromise = null; });   // allow a retry later
    }
    return ffmpegPromise;
  }

  async function decodeWithFFmpeg(file, ctx, onStage) {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      throw new DecodeError("This browser can't read this file. Try the latest Chrome, Edge, Firefox or Safari.");
    }
    const ff = await getFFmpeg(onStage);
    const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase();
    const inName = 'input' + ext, outName = 'output.wav';
    onStage('Reading the file…', null);
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    ffmpegLog = [];
    const onProg = ({ progress }) => onStage('Extracting the sound…', Math.max(0, Math.min(1, progress)));
    ff.on('progress', onProg);
    let code;
    try {
      code = await ff.exec(['-hide_banner', '-i', inName, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_s16le', '-f', 'wav', outName]);
    } finally {
      ff.off('progress', onProg);
    }
    const log = ffmpegLog.join('\n');
    if (code !== 0) {
      await ff.deleteFile(inName).catch(() => {});
      if (/matches no streams|does not contain any stream|no audio/i.test(log) || (/Stream #/.test(log) && !/Audio:/.test(log))) {
        throw new DecodeError('This file has no sound track.', log.slice(-500));
      }
      if (/Invalid data found|could not find codec|Unknown format|moov atom not found/i.test(log)) {
        throw new DecodeError("This file is damaged or isn't an audio or video file.", log.slice(-500));
      }
      throw new DecodeError("Couldn't extract the sound from this file.", log.slice(-500));
    }
    const wav = await ff.readFile(outName);
    await Promise.all([ff.deleteFile(inName), ff.deleteFile(outName)]).catch(() => {});
    onStage('Preparing the waveform…', null);
    try {
      return await ctx.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
    } catch (e) {
      throw new DecodeError("Couldn't read the extracted sound.", e.message);
    }
  }

  /**
   * @param {File} file
   * @param {BaseAudioContext} ctx
   * @param {(text: string, progress: number|null) => void} onStage
   * @returns {Promise<{buffer: AudioBuffer, video: boolean, via: 'browser'|'ffmpeg'}>}
   */
  async function decodeFile(file, ctx, onStage) {
    if (!file.size) throw new DecodeError('This file is empty.');
    if (file.size > MAX_BYTES) throw new DecodeError('This file is over 2 GB, which is more than a browser can hold in memory. Cut it into shorter files first.');
    const video = isVideo(file);
    onStage(video ? 'Reading the video…' : 'Reading the file…', null);
    let data;
    try { data = await file.arrayBuffer(); }
    catch (e) { throw new DecodeError("Couldn't read the file. It may have been moved, or be too large for this device.", e.message); }
    onStage(video ? 'Extracting the sound…' : 'Decoding…', null);
    try {
      const buffer = await ctx.decodeAudioData(data);
      return { buffer, video, via: 'browser' };
    } catch (_) {
      data = null;   // let the first copy be freed before ffmpeg makes its own
    }
    const buffer = await decodeWithFFmpeg(file, ctx, onStage);
    return { buffer, video, via: 'ffmpeg' };
  }

  global.AudioDecode = { decodeFile, isVideo, DecodeError };
})(window);
