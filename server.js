const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Usa a diretoria /tmp no Linux (Render) para garantir permissão total
const isWin = process.platform === 'win32';
const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin ? path.join(__dirname, binaryName) : path.join('/tmp', binaryName);

let ytDlpWrap = null;
let isBinaryReady = false;
let initError = null;
let isDownloading = false;

// Descarrega o binário oficial seguindo redirecionamentos
function downloadFileDirect(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'CortePro-Master/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFileDirect(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Status HTTP: ${response.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
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

      console.log('A transferir binário oficial de:', downloadUrl);
      await downloadFileDirect(downloadUrl, binaryPath);
    }

    if (!isWin) {
      fs.chmodSync(binaryPath, 0o755);
    }

    ytDlpWrap = new YTDlpWrap(binaryPath);
    isBinaryReady = true;
    isDownloading = false;
    console.log('yt-dlp pronto em:', binaryPath);
    return true;
  } catch (err) {
    initError = err.message;
    isDownloading = false;
    console.error('Erro ao preparar yt-dlp:', err.message);
    return false;
  }
}

ensureYtDlpReady();

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

// Rota raiz com diagnóstico
app.get('/', (req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    ffmpegReady: Boolean(ffmpegPath),
    initError: initError,
    endpoint: '/api/extract?url=LINK_DO_VIDEO',
    downloadEndpoint: '/api/download?url=LINK_DO_VIDEO'
  });
});

// Rota 1: Extrai informações do vídeo
app.get('/api/extract', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "Parâmetro 'url' não fornecido." });
  }

  if (!isValidPublicUrl(videoUrl)) {
    return res.status(400).json({ error: 'Link inválido ou não permitido.' });
  }

  if (!isBinaryReady) {
    const readyNow = await ensureYtDlpReady();
    if (!readyNow) {
      return res.status(503).json({
        error: initError
          ? `Erro ao preparar extrator: ${initError}`
          : 'O extrator está a ser preparado. Aguarde 10 segundos e tente novamente.'
      });
    }
  }

  try {
    console.log(`A analisar vídeo: ${videoUrl}`);

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
      error: 'Não foi possível extrair este vídeo. Verifique se o link é público e tente novamente.',
      details: error.message
    });
  }
});

// Rota 2: Faz o download real com suporte a FFmpeg e deteção dinâmica do ficheiro gerado
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl || !isValidPublicUrl(videoUrl)) {
    return res.status(400).send('URL inválida ou ausente.');
  }

  if (!isBinaryReady) {
    const readyNow = await ensureYtDlpReady();
    if (!readyNow) {
      return res.status(503).send('Extrator a iniciar. Tente novamente em alguns segundos.');
    }
  }

  const uniquePrefix = `cortepro_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const outputTemplate = path.join('/tmp', `${uniquePrefix}.%(ext)s`);

  // Função para localizar qualquer ficheiro criado com este prefixo em /tmp
  const findGeneratedFile = () => {
    const files = fs.readdirSync('/tmp');
    const match = files.find(f => f.startsWith(uniquePrefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
    return match ? path.join('/tmp', match) : null;
  };

  // Função para apagar todos os ficheiros temporários deste pedido
  const cleanupFiles = () => {
    try {
      const files = fs.readdirSync('/tmp');
      files.forEach(f => {
        if (f.startsWith(uniquePrefix)) {
          fs.unlink(path.join('/tmp', f), () => {});
        }
      });
    } catch (e) {}
  };

  try {
    console.log(`A processar download para: ${videoUrl}`);

    const args = [
      videoUrl,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--no-part',
      '--max-filesize', '180M',
      '-o', outputTemplate
    ];

    // Se o ffmpeg-static estiver presente, informa o caminho exato ao yt-dlp
    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    await ytDlpWrap.execPromise(args);

    const finalFilePath = findGeneratedFile();

    if (!finalFilePath || !fs.existsSync(finalFilePath)) {
      cleanupFiles();
      return res.status(422).send('Não foi possível gerar o ficheiro de vídeo para download.');
    }

    const ext = path.extname(finalFilePath) || '.mp4';
    const mimeType = ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="cortepro_${Date.now()}${ext}"`);

    const readStream = fs.createReadStream(finalFilePath);
    readStream.pipe(res);

    readStream.on('close', cleanupFiles);
    readStream.on('error', cleanupFiles);
    res.on('close', cleanupFiles);
  } catch (error) {
    console.error('Erro no download direto:', error.message);
    cleanupFiles();
    if (!res.headersSent) {
      res.status(500).send(`Falha ao descarregar o vídeo: ${error.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master a correr na porta ${PORT}`);
});
