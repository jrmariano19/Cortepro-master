/* Isolated from the download flow. Files go directly to the audio service. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const button = byId('musicBtn');
  const input = byId('musicFile');
  const status = byId('musicStatus');
  let config, objectUrl, busy = false;
  let resultToken, resultUrl;
  function message(text, error = false) {
    status.className = 'alert-box ' + (error ? 'error' : 'success');
    status.textContent = text;
  }
  async function jsonRequest(url, options = {}, timeout = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store'});
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('O serviço de áudio não respondeu. Tente novamente.');
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || 'Não foi possível processar o vídeo.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A conexão demorou demais. Tente novamente.');
      if (error instanceof TypeError) throw new Error('Falha de conexão com o serviço de áudio. Verifique a internet.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function getConfig() {
    const data = await jsonRequest('/api/music');
    const url = new URL(data.serviceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== data.serviceUrl) {
      throw new Error('O serviço de áudio está configurado incorretamente.');
    }
    return data;
  }
  function upload(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', config.serviceUrl + '/jobs');
      xhr.timeout = 600000;
      xhr.setRequestHeader('Authorization', 'Bearer ' + config.token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) message('Enviando vídeo: ' + Math.round(event.loaded / event.total * 100) + '%');
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error || data.detail || 'Erro ao enviar vídeo.');
          resolve(data);
        } catch (error) { reject(error instanceof SyntaxError ? new Error('O serviço de áudio não respondeu.') : error); }
      };
      xhr.onerror = () => reject(new Error('Falha ao enviar o vídeo. Verifique a conexão e tente novamente.'));
      xhr.ontimeout = () => reject(new Error('O envio demorou demais. Tente novamente em uma conexão mais rápida.'));
      xhr.send(file);
    });
  }
  async function downloadResult() {
    const save = byId('musicSave');
    save.disabled = true;
    save.textContent = 'Preparando download...';
    try {
      if (!objectUrl) {
        const response = await fetch(resultUrl, {headers: {Authorization: 'Bearer ' + resultToken}});
        if (!response.ok) throw new Error('O arquivo expirou ou está indisponível. Processe o vídeo novamente.');
        objectUrl = URL.createObjectURL(await response.blob());
      }
      byId('musicPreview').src = objectUrl;
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = (input.files[0]?.name.replace(/\.[^.]+$/, '') || 'CortePro') + '_voz.mp4';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) { message(error.message || 'Não foi possível baixar o resultado.', true); }
    finally { save.disabled = false; save.textContent = '↓ Baixar vídeo tratado'; }
  }
  async function process() {
    if (busy) return;
    const file = input.files[0];
    if (!file) { message('Selecione um vídeo do aparelho.', true); return; }
    if (!file.size || file.size > 200 * 1024 * 1024) { message('Selecione um vídeo com até 200 MB.', true); return; }
    if (file.type && !file.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(file.name)) {
      message('Selecione um arquivo de vídeo.', true); return;
    }
    busy = true;
    button.disabled = true;
    input.disabled = true;
    button.textContent = 'Tratando áudio...';
    byId('musicResult').hidden = true;
    byId('musicPreview').removeAttribute('src');
    byId('musicPreview').load();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    try {
      message('Preparando envio...');
      config = await getConfig();
      const job = await upload(file);
      if (!/^[a-f0-9]{48}$/.test(job.id)) throw new Error('Resposta inválida do serviço de áudio.');
      const endpoint = config.serviceUrl + '/jobs/' + job.id;
      const deadline = Date.now() + 45 * 60 * 1000;
      let failures = 0;
      for (;;) {
        if (Date.now() > deadline) throw new Error('O processamento demorou demais. Tente um vídeo mais curto.');
        let state;
        try {
          state = await jsonRequest(endpoint, {headers: {Authorization: 'Bearer ' + config.token}});
          failures = 0;
        } catch (error) {
          if (++failures >= 3) throw error;
          message('Reconectando ao processamento...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        if (state.status === 'failed') throw new Error(state.error || 'Não foi possível tratar este áudio.');
        if (state.status === 'completed') {
          resultUrl = endpoint + '/file';
          resultToken = config.token;
          byId('musicResult').hidden = false;
          message('Áudio tratado. Toque em baixar para salvar e ouvir o resultado.');
          break;
        }
        message(state.message || 'Separando a voz da música... mantenha esta página aberta.');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) { message(error.message || 'Não foi possível processar o vídeo.', true); }
    finally {
      busy = false;
      button.disabled = false;
      input.disabled = false;
      button.textContent = 'Remover música';
    }
  }
  button.addEventListener('click', process);
  byId('musicSave').addEventListener('click', downloadResult);
  async function initialize() {
    try {
      config = await getConfig();
      button.disabled = false;
      button.textContent = 'Remover música';
      status.className = 'alert-box';
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Verificar disponibilidade';
      message(error.message, true);
    }
  }
  // An unavailable processor must never prevent downloading videos.
  initialize();
})();
