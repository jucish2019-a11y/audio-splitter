# Audio Splitter

Cut, split and trim audio from audio **or video** files in the browser. Files are decoded and encoded on
your own device and are never uploaded, so there is no server to run or pay for.
It's a static site, so GitHub Pages can host it.

## Features

**Opening files**
- Audio: MP3, WAV, M4A/AAC, OGG/Opus, FLAC and anything else your browser can decode
- Video: MP4, MOV, M4V, MKV, WebM and more. The sound track is extracted and the picture is ignored
- If the browser can't decode a file itself, it's converted in the browser with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). The converter (about 31 MB) is downloaded from a CDN the first time it's needed, then cached
- **Long recordings** (over 20 minutes, e.g. a 2-hour interview) open in large-file mode: the file is read straight from disk instead of being decoded into memory, previews play through the browser's normal audio player, and the cuts are made by ffmpeg when you download. A 2-hour MP3 needs a few hundred MB of memory instead of about 3 GB
- Clear messages for files with no sound track and damaged files

**Editing**
- Drag across the waveform to select a range, then **Remove** it, **Keep only this**, or **Make it a part**. Selection edges snap to splits and the playhead, and you can type exact times
- Selecting an already-removed range offers **Restore**
- Removed audio is shown hatched, and **Play** previews the result with the removed parts skipped
- **Undo / Redo** for every edit
- Zoom in for precise edits (buttons, <kbd>+</kbd>/<kbd>−</kbd>, <kbd>Ctrl</kbd> + scroll or pinch), with a scrollbar when zoomed
- Splits: double-click the waveform, press <kbd>S</kbd> at the playhead, or type an exact end time. Drag a split to move it
- **Split on silence**: split in the middle of quiet gaps, or remove the gaps entirely
- Parts table: keep/remove, rename, play, select, merge, or download a single part

**Export**
- One file with the removed parts cut out (each cut is smoothed with a short crossfade to avoid clicks), or each kept part as a separate file (several come as one `.zip`)
- MP3 (128/192/320 kbps) or 16-bit WAV, with optional fade in and fade out

Keyboard: <kbd>Space</kbd> play/pause · <kbd>S</kbd> split · <kbd>Del</kbd> remove selection · <kbd>Esc</kbd> clear selection · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo · <kbd>←</kbd>/<kbd>→</kbd> move 1 s · <kbd>+</kbd>/<kbd>−</kbd>/<kbd>0</kbd> zoom

## Host it on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Every push to `main` now runs `.github/workflows/pages.yml`, which publishes the site to `https://<your-user>.github.io/<repo-name>/`. Check progress in the **Actions** tab. To publish again without a code change, open the workflow in **Actions** and click **Run workflow**.

There is no build step. The page footer shows the version number, so you can tell whether your browser has the latest deploy.

## Run it locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk works for files the browser can decode itself, but the ffmpeg fallback needs the page to be served over http(s).

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | Page markup |
| `css/style.css` | Styles (light and dark themes) |
| `js/app.js` | Waveform, splits, parts table, playback, export |
| `js/decode.js` | Opens audio/video files: browser decoder first, ffmpeg.wasm fallback |
| `js/encoders.js` | WAV encoder, MP3 encoder wrapper, ZIP writer |
| `vendor/ffmpeg/` | [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.15 loader (MIT, unmodified). The GPL ffmpeg core itself is fetched from jsDelivr (or unpkg) at runtime and isn't stored in this repository |
| `vendor/lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) 1.2.1 MP3 encoder (LGPL-3.0, unmodified) |

## Limits

- Files up to 20 minutes are decoded into memory for instant editing. Longer ones use large-file mode, where downloading re-encodes with ffmpeg in the browser and takes a few minutes for multi-hour recordings.
- In large-file mode a WAV export is limited to about 1.5 GB (roughly 2.5 hours of 44.1 kHz stereo); choose MP3 for longer results.
- Browsers decode to the audio device's sample rate, so a 44.1 kHz file may export at 48 kHz.
- MP3 output is at most stereo; files with more channels are mixed down.
- Only the first sound track of a video is used.
- The ffmpeg fallback needs an internet connection the first time, and holds the whole file in memory while converting.

## License

MIT, see [LICENSE](LICENSE). The bundled MP3 encoder is lamejs under the LGPL-3.0, see `vendor/LAMEJS-LICENSE.txt`. The ffmpeg.wasm loader is MIT; the ffmpeg core it downloads is GPL-2.0-or-later.
