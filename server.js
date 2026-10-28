const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Usa a diretoria /tmp no Linux (Render) para garantir permissão total de escrita e execução
const isWin = process.platform === 'win32';
const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin ? path.join(__dirname, binaryName) : path.join('/tmp', binaryName);

let ytDlpWrap = null;
let isBinaryReady = false;
let initError = null;
let isDownloading = false;

// Função auxiliar para descarregar ficheiros seguindo redirecionamentos (sem usar a API limitada do GitHub)
function downloadFileDirect(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'CortePro-Master/1.0' } }, (response) => {
      // Segue redirecionamentos 301/302 do GitHub Releases
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFileDirect(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Falha no download do binário. Status HTTP: ${response.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });
    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Prepara o binário autónomo do yt-dlp
async function ensureYtDlpReady() {
  if (isBinaryReady && ytDlpWrap && fs.existsSync(binaryPath)) {
    return true;
  }
  if (isDownloading) {
    return false;
  }

  isDownloading = true;
  initError = null;

  try {
    if (!fs.existsSync(binaryPath) || fs.statSync(binaryPath).size < 1000000) {
      const downloadUrl = isWin
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

      console.log('A transferir binário oficial diretamente de:', downloadUrl);
      await downloadFileDirect(downloadUrl, binaryPath);
    }

    if (!isWin) {
      fs.chmodSync(binaryPath, 0o755);
    }

    ytDlpWrap = new YTDlpWrap(binaryPath);
    isBinaryReady = true;
    isDownloading = false;
    console.log('yt-dlp pronto e operacional em:', binaryPath);
    return true;
  } catch (err) {
    initError = err.message;
    isDownloading = false;
    console.error('Erro ao preparar o yt-dlp:', err.message);
    return false;
  }
}

// Inicia o download assim que o servidor arranca
ensureYtDlpReady();

// Validação de segurança de URL
function isValidPublicUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Rota raiz com diagnóstico completo
app.get('/', (req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    isDownloading: isDownloading,
    initError: initError,
    endpoint: '/api/extract?url=LINK_DO_VIDEO',
    downloadEndpoint: '/api/download?url=LINK_DO_VIDEO'
  });
});

// Rota 1: Extração de metadados e validação do vídeo
app.get('/api/extract', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "Parâmetro 'url' não fornecido." });
  }

  if (!isValidPublicUrl(videoUrl)) {
    return res.status(400).json({ error: 'Link inválido ou não permitido.' });
  }

  // Se ainda não estiver pronto, tenta concluir a preparação na hora
  if (!isBinaryReady) {
    const readyNow = await ensureYtDlpReady();
    if (!readyNow) {
      return res.status(503).json({
        error: initError
          ? `Erro ao preparar extrator no servidor: ${initError}`
          : 'O extrator está a ser transferido no servidor. Aguarde 10 segundos e toque novamente.'
      });
    }
  }

  try {
    console.log(`A extrair vídeo: ${videoUrl}`);

    const stdout = await ytDlpWrap.execPromise([
      videoUrl,
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass'
    ]);

    const metadata = JSON.parse(stdout);

    let directUrl = metadata.url || null;
    if (!directUrl && Array.isArray(metadata.formats)) {
      const progressiveFormats = metadata.formats.filter(
        f => f.url && f.vcodec !== 'none' && f.acodec !== 'none'
      );
      if (progressiveFormats.length > 0) {
        directUrl = progressiveFormats[progressiveFormats.length - 1].url;
      } else {
        const anyVideo = metadata.formats.filter(f => f.url && f.vcodec !== 'none');
        if (anyVideo.length > 0) {
          directUrl = anyVideo[anyVideo.length - 1].url;
        }
      }
    }

    const serverDownloadUrl = `/api/download?url=${encodeURIComponent(videoUrl)}`;

    res.json({
      success: true,
      title: metadata.title || 'Vídeo CortePro',
      duration: metadata.duration || 0,
      thumbnail: metadata.thumbnail || '',
      extractor: metadata.extractor_key || 'Web',
      downloadUrl: serverDownloadUrl,
      directUrl: directUrl
    });
  } catch (error) {
    console.error('Erro na extração:', error.message);
    res.status(500).json({
      error: 'Não foi possível extrair este vídeo. Verifique se o link é público (não privado) e tente novamente.',
      details: error.message
    });
  }
});

// Rota 2: Download direto do ficheiro MP4 para o telemóvel
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl || !isValidPublicUrl(videoUrl)) {
    return res.status(400).send('URL inválida ou ausente.');
  }

  if (!isBinaryReady) {
    const readyNow = await ensureYtDlpReady();
    if (!readyNow) {
      return res.status(503).send('Extrator indisponível no momento.');
    }
  }

  const tempId = `video_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`;
  const tempFilePath = path.join('/tmp', tempId);

  try {
    console.log(`A transferir ficheiro MP4: ${videoUrl}`);

    await ytDlpWrap.execPromise([
      videoUrl,
      '-f', 'best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--max-filesize', '150M',
      '-o', tempFilePath
    ]);

    if (!fs.existsSync(tempFilePath)) {
      return res.status(422).send('Não foi possível gerar o ficheiro de vídeo para download.');
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="cortepro_${Date.now()}.mp4"`);

    const readStream = fs.createReadStream(tempFilePath);
    readStream.pipe(res);

    const cleanup = () => {
      if (fs.existsSync(tempFilePath)) {
        fs.unlink(tempFilePath, () => {});
      }
    };

    readStream.on('close', cleanup);
    readStream.on('error', cleanup);
    res.on('close', cleanup);
  } catch (error) {
    console.error('Erro no download direto:', error.message);
    if (fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, () => {});
    }
    if (!res.headersSent) {
      res.status(500).send('Falha ao descarregar o vídeo. O conteúdo pode ser privado ou bloqueado pela plataforma.');
    }
  }
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master a correr na porta ${PORT}`);
});
