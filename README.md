# Audio Splitter

Cut, split and trim audio files in the browser. Files are decoded and encoded on
your own device and are never uploaded, so there is no server to run or pay for.
It's a static site, so GitHub Pages can host it.

## Features

- Open MP3, WAV, M4A, OGG or FLAC (anything your browser can decode), or drop a file on the page
- Waveform with a time ruler
- Add splits by double-clicking the waveform, pressing <kbd>S</kbd> at the playhead, or typing an exact end time
- **Split on silence:** finds quiet gaps (level and minimum length are adjustable) and splits in the middle of each one
- Untick a part to cut it out; merge neighbouring parts; rename parts
- Export each kept part as its own file (several parts come as one `.zip`), or join the kept parts into one file
- MP3 (128/192/320 kbps) or 16-bit WAV output
- Fade in/out, and an equal-power crossfade where parts are joined

Keyboard: <kbd>Space</kbd> play/pause · <kbd>S</kbd> split at playhead · <kbd>←</kbd>/<kbd>→</kbd> move playhead 1 s

## Host it on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, then **Save**.
4. After a minute the site is live at `https://<your-user>.github.io/<repo-name>/`.

There is no build step. The `.nojekyll` file tells Pages to serve the files as they are.

## Run it locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk also works in most browsers.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | Page markup |
| `css/style.css` | Styles (light and dark themes) |
| `js/app.js` | Waveform, splits, parts table, playback, export |
| `js/encoders.js` | WAV encoder, MP3 encoder wrapper, ZIP writer |
| `vendor/lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) 1.2.1 MP3 encoder (LGPL-3.0, unmodified) |

## Limits

- The whole file is decoded into memory. An hour of stereo audio uses about 1.3 GB, so very long recordings may be slow or fail on phones.
- Browsers decode to the audio device's sample rate, so a 44.1 kHz file may export at 48 kHz.
- MP3 output is at most stereo; files with more channels are mixed down.

## License

MIT, see [LICENSE](LICENSE). The bundled MP3 encoder is lamejs under the LGPL-3.0, see `vendor/LAMEJS-LICENSE.txt`.
