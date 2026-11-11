/* Local-only MP4 conversion. Dependencies are pinned and served from this origin. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const fileInput = el('convertFile'), button = el('convertBtn'), cancel = el('convertCancel');
  const quality = el('convertQuality'), status = el('convertStatus'), progress = el('convertProgress');
  const preview = el('convertPreview'), download = el('convertDownload');
  const maxBytes = 200 * 1024 * 1024;
  let active = null, outputURL = null, loader = null;

  function clearOutput() {
    preview.pause(); preview.removeAttribute('src'); preview.load(); preview.hidden = true;
    download.hidden = true; download.removeAttribute('href');
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = null;
  }
  function fileError(file) {
    if (!file) return 'Escolha um arquivo para começar.';
    if (!file.size) return 'Este arquivo está vazio. Escolha outro vídeo.';
    if (file.size > maxBytes) return 'O limite desta versão é 200 MB por arquivo. Escolha um vídeo menor.';
    return '';
  }
  function idle() {
    fileInput.disabled = quality.disabled = false;
    button.disabled = !!fileError(fileInput.files[0]);
    button.textContent = 'Converter para MP4'; cancel.hidden = true; progress.hidden = true;
  }
  function loadWrapper() {
    if (window.FFmpegWASM) return Promise.resolve();
    if (!loader) loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); loader = null; reject(new Error('LOAD')); }, 45000);
      script.src = '/assets/vendor/ffmpeg/ffmpeg.js';
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); loader = null; reject(new Error('LOAD')); };
      document.head.appendChild(script);
    });
    return loader;
  }
  fileInput.addEventListener('change', () => {
    clearOutput();
    const file = fileInput.files[0], error = fileError(file);
    button.disabled = !!error;
    status.textContent = error || `${file.name} • ${(file.size / 1048576).toFixed(1)} MB. Pronto para converter.`;
  });
  cancel.addEventListener('click', () => {
    if (!active) return;
    const job = active; active = null;
    clearTimeout(job.timer); job.engine?.terminate();
    idle(); status.textContent = 'Conversão cancelada. Você pode tentar novamente.';
  });
  window.addEventListener('beforeunload', event => {
    if (active) { event.preventDefault(); event.returnValue = ''; }
  });
  button.addEventListener('click', async () => {
    if (active) return;
    const file = fileInput.files[0], error = fileError(file);
    if (error) { status.textContent = error; return; }
    if (!window.Worker || !window.WebAssembly) {
      status.textContent = 'Este navegador não suporta a conversão. Tente no Chrome atualizado.'; return;
    }
    clearOutput();
    const job = { engine: null, timer: null, phase: 'load' }; active = job;
    button.disabled = fileInput.disabled = quality.disabled = true;
    button.textContent = 'Convertendo…'; cancel.hidden = false;
    progress.hidden = false; progress.removeAttribute('value');
    status.textContent = 'Preparando o conversor… Na primeira vez, o download do componente pode demorar.';
    try {
      await loadWrapper();
      if (active !== job) return;
      const engine = new window.FFmpegWASM.FFmpeg(); job.engine = engine;
      await Promise.race([
        engine.load({ coreURL: new URL('/assets/vendor/ffmpeg-core/ffmpeg-core.js', location.href).href,
          wasmURL: new URL('/assets/vendor/ffmpeg-core/ffmpeg-core.wasm', location.href).href }),
        new Promise((_, reject) => { job.timer = setTimeout(() => reject(new Error('LOAD')), 90000); })
      ]);
      clearTimeout(job.timer);
      if (active !== job) return;
      job.phase = 'convert';
      status.textContent = 'Lendo o arquivo…';
      await engine.writeFile('input', new Uint8Array(await file.arrayBuffer()));
      if (active !== job) return;
      engine.on('progress', ({ progress: ratio }) => {
        if (active !== job || job.phase !== 'convert' || !Number.isFinite(ratio)) return;
        const percent = Math.max(0, Math.min(99, Math.round(ratio * 100)));
        progress.value = percent;
        status.textContent = `Convertendo: aproximadamente ${percent}%. Mantenha esta aba aberta.`;
      });
      status.textContent = 'Convertendo o vídeo e preservando o áudio…';
      const filter = quality.value === '720'
        ? "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
        : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
      const code = await engine.exec(['-i', 'input', '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-sn', '-dn', 'output.mp4']);
      if (active !== job) return;
      if (code !== 0) throw new Error('CONVERT');
      job.phase = 'save'; status.textContent = 'Preparando o MP4 para baixar…';
      const data = await engine.readFile('output.mp4');
      if (active !== job) return;
      if (data.length < 12 || String.fromCharCode(...data.slice(4, 8)) !== 'ftyp') throw new Error('CONVERT');
      outputURL = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'video';
      download.href = outputURL; download.download = `${name}_convertido.mp4`; download.hidden = false;
      preview.src = outputURL; preview.hidden = false;
      status.textContent = `MP4 pronto • ${(data.length / 1048576).toFixed(1)} MB. Toque em Baixar MP4 para salvar.`;
    } catch (err) {
      if (active !== job) return;
      status.textContent = job.phase === 'load'
        ? 'Não foi possível carregar o conversor. Confira a conexão e tente novamente.'
        : 'Não foi possível converter. O arquivo pode usar um codec não suportado, estar danificado, protegido ou exceder a memória disponível. Tente um vídeo menor em 720p.';
    } finally {
      clearTimeout(job.timer); job.engine?.terminate();
      if (active === job) { active = null; idle(); }
    }
  });
})();
