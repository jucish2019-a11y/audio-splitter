// Encoders and packaging: WAV, MP3 (via lamejs) and an uncompressed ZIP writer.
// Each takes plain Float32Array channels so the app can render clips however it likes.
(function (global) {
  'use strict';

  function toInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeWav(channels, sampleRate) {
    const nc = channels.length, length = channels[0].length, bytes = 44 + length * nc * 2;
    const ab = new ArrayBuffer(bytes), v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * 2, true);
    v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, length * nc * 2, true);
    let o = 44;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < nc; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  // MP3 supports at most two channels and a fixed set of sample rates.
  async function prepareForMp3(channels, sampleRate) {
    let chans = channels;
    if (chans.length > 2) {
      const L = new Float32Array(chans[0].length), R = new Float32Array(chans[0].length);
      for (let c = 0; c < chans.length; c++) {
        const dst = c % 2 === 0 ? L : R, g = 2 / chans.length;
        for (let i = 0; i < L.length; i++) dst[i] += chans[c][i] * g;
      }
      chans = [L, R];
    }
    if (MP3_RATES.includes(sampleRate)) return { channels: chans, sampleRate };
    const target = sampleRate > 48000 ? 48000 : MP3_RATES.find(r => r >= sampleRate) || 44100;
    const frames = Math.ceil(chans[0].length * target / sampleRate);
    const off = new OfflineAudioContext(chans.length, frames, target);
    const b = off.createBuffer(chans.length, chans[0].length, sampleRate);
    chans.forEach((ch, i) => b.copyToChannel(ch, i));
    const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    const out = []; for (let c = 0; c < r.numberOfChannels; c++) out.push(r.getChannelData(c));
    return { channels: out, sampleRate: target };
  }

  async function encodeMp3(channels, sampleRate, kbps, onProgress) {
    if (!global.lamejs) throw new Error('The MP3 encoder failed to load.');
    const prep = await prepareForMp3(channels, sampleRate);
    const nc = prep.channels.length;
    const L = toInt16(prep.channels[0]), R = nc > 1 ? toInt16(prep.channels[1]) : null;
    const enc = new global.lamejs.Mp3Encoder(nc, prep.sampleRate, kbps);
    const parts = [], block = 1152, n = L.length;
    let lastYield = performance.now();
    for (let i = 0; i < n; i += block) {
      const chunk = R ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block))
                      : enc.encodeBuffer(L.subarray(i, i + block));
      if (chunk.length) parts.push(new Uint8Array(chunk));
      if (performance.now() - lastYield > 40) {
        onProgress && onProgress(i / n);
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    onProgress && onProgress(1);
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  // ---- ZIP (stored, no compression: audio barely compresses anyway) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ name, blob }]
  async function zipFiles(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const enc = new TextEncoder(), out = [], central = [];
    let offset = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name), crc = crc32(data), size = data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
      out.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...out, ...central, e.buffer], { type: 'application/zip' });
  }

  global.AudioEncoders = { encodeWav, encodeMp3, zipFiles };
})(window);
