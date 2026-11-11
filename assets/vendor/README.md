# FFmpeg WebAssembly dependencies

Pinned upstream npm distributions, served locally; the video is never uploaded.

- @ffmpeg/ffmpeg 0.12.15: MIT, https://github.com/ffmpegwasm/ffmpeg.wasm
- @ffmpeg/core 0.12.10: single-thread build, FFmpeg and bundled codec libraries, including GPL components (libx264).
- Corresponding build sources and recipes: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/core%40v0.12.10
- FFmpeg source: https://github.com/FFmpeg/FFmpeg (build version printed in core logs).

Reproduce the vendored distribution with:

    npm install --prefix /tmp/cortepro-wasm @ffmpeg/ffmpeg@0.12.15 @ffmpeg/core@0.12.10

Copy the .js files from ffmpeg/dist/umd and the .js/.wasm files from core/dist/umd to these directories. Preserve license notices. No runtime CDN requests are needed.
