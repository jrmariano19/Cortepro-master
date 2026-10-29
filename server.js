const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Garante permissão de execução para o FFmpeg no Linux (Render)
const isWin = process.platform === 'win32';
if (!isWin && ffmpegPath && fs.existsSync(ffmpegPath)) {
  try {
    fs.chmodSync(ffmpegPath, 0o755);
  } catch (e) {
    console.error('Aviso ao ajustar permissão do FFmpeg:', e.message);
  }
}

const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin ? path.join(__dirname, binaryName) : path.join('/tmp', binaryName);

let ytDlpWrap = null;
let isBinaryReady = false;
let initError = null;
let isDownloading = false;

// Descarrega o binário oficial do yt-dlp seguindo redirecionamentos
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

// Prepara o binário do yt-dlp
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

// Executa o FFmpeg como Promise
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout, stderr });
    });
  });
}

// Analisa os codecs de vídeo e áudio do ficheiro descarregado
function inspectMediaStreams(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve({ hasVideo: true, isH264: true, isCleanAac: true });
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (error, stdout, stderr) => {
      const info = (stderr || '') + (stdout || '');
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
      const isH264 = /Video:\s*h264/i.test(info);
      const isCleanAac = /Audio:\s*aac\s*\(LC\)/i.test(info);
      resolve({ hasVideo, isH264, isCleanAac, rawInfo: info });
    });
  });
}

// Garante que o ficheiro final seja um MP4 (H.264 + AAC-LC) 100% compatível com a galeria do Android
async function prepareAndroidMp4(inputPath, outputPath) {
  if (!ffmpegPath) return inputPath;

  const check = await inspectMediaStreams(inputPath);
  console.log(`Inspeção FFmpeg -> hasVideo: ${check.hasVideo}, isH264: ${check.isH264}, isCleanAac: ${check.isCleanAac}`);

  if (!check.hasVideo) {
    throw new Error('O ficheiro obtido não contém faixa de vídeo.');
  }

  // Caso 1: O vídeo já é H.264. Fazemos apenas a normalização rápida do contentor MP4 e áudio AAC-LC (< 1 segundo)
  if (check.isH264) {
    try {
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        outputPath
      ]);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        return outputPath;
      }
    } catch (e) {
      console.warn('Aviso ao converter áudio com copy de vídeo, a tentar remux direto:', e.message);
      try {
        await runFfmpeg([
          '-y',
          '-i', inputPath,
          '-c', 'copy',
          '-movflags', '+faststart',
          outputPath
        ]);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          return outputPath;
        }
      } catch (remuxErr) {
        console.warn('Remux direto falhou, a avançar para recodificação completa.');
      }
    }
  }

  // Caso 2: O vídeo veio em VP9, AV1 ou HEVC. Recodifica para H.264 (yuv420p com dimensões pares) + AAC-LC
  try {
    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-profile:v', 'main',
      '-level', '3.1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath
    ]);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      return outputPath;
    }
  } catch (transcodeErr) {
    console.error('Erro ao recodificar vídeo completo:', transcodeErr.message);
  }

  return inputPath;
}

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

// Rota raiz
app.get('/', (req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    ffmpegReady: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
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
    const serverDownloadUrl = `/api/download?url=${encodeURIComponent(videoUrl)}`;

    res.json({
      success: true,
      title: metadata.title || 'Vídeo CortePro',
      duration: metadata.duration || 0,
      thumbnail: metadata.thumbnail || '',
      extractor: metadata.extractor_key || 'Web',
      downloadUrl: serverDownloadUrl,
      directUrl: null
    });
  } catch (error) {
    console.error('Erro na extração:', error.message);
    res.status(500).json({
      error: 'Não foi possível extrair este vídeo. Verifique se o link é público e tente novamente.',
      details: error.message
    });
  }
});

// Rota 2: Faz o download garantindo MP4 (H.264 + AAC-LC) compatível com a galeria do Android
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
  const outputTemplate = path.join('/tmp', `${uniquePrefix}_raw.%(ext)s`);
  const normalizedPath = path.join('/tmp', `${uniquePrefix}_android.mp4`);

  const findRawFile = () => {
    const files = fs.readdirSync('/tmp');
    const matches = files.filter(
      f => f.startsWith(`${uniquePrefix}_raw`) && !f.endsWith('.part') && !f.endsWith('.ytdl')
    );
    const mp4Match = matches.find(f => f.endsWith('.mp4'));
    const chosen = mp4Match || matches[0];
    return chosen ? path.join('/tmp', chosen) : null;
  };

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
    console.log(`A transferir vídeo compatível com Android: ${videoUrl}`);

    // Prioriza formatos progressivos nativos (hd/sd no Facebook, H.264 MP4 no TikTok/Instagram/Kwai)
    // e evita faixas de áudio xHE-AAC (40.42) e vídeos AV1/HEVC/ByteVC1
    const formatSelector = [
      'hd',
      'sd',
      'b[ext=mp4][vcodec^=avc]',
      'b[ext=mp4][vcodec!^=av01][vcodec!^=vp][vcodec!^=hev][vcodec!^=hvc][vcodec!^=bytevc1]',
      'bv*[vcodec^=avc]+ba[ext=m4a][acodec!*=40.42]',
      'bv*[vcodec!^=av01][vcodec!^=vp]+ba[acodec!*=40.42]',
      'b[ext=mp4]',
      'best'
    ].join('/');

    const args = [
      videoUrl,
      '-f', formatSelector,
      '-S', 'vcodec:h264,acodec:aac,ext:mp4:m4a,res',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--no-part',
      '--max-filesize', '180M',
      '-o', outputTemplate
    ];

    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    await ytDlpWrap.execPromise(args);

    const rawFilePath = findRawFile();
    if (!rawFilePath || !fs.existsSync(rawFilePath)) {
      cleanupFiles();
      return res.status(422).send('Não foi possível gerar o ficheiro de vídeo para download.');
    }

    // Normaliza o ficheiro para garantir reprodução sem erros no Android
    const finalFilePath = await prepareAndroidMp4(rawFilePath, normalizedPath);
    const stat = fs.statSync(finalFilePath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="cortepro_${Date.now()}.mp4"`);

    const readStream = fs.createReadStream(finalFilePath);
    readStream.pipe(res);

    readStream.on('close', cleanupFiles);
    readStream.on('error', cleanupFiles);
    res.on('close', cleanupFiles);
  } catch (error) {
    console.error('Erro no download:', error.message);
    cleanupFiles();
    if (!res.headersSent) {
      res.status(500).send(`Falha ao transferir o vídeo: ${error.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master a correr na porta ${PORT}`);
});
