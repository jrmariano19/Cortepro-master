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

// Baixa o binário oficial do yt-dlp seguindo redirecionamentos
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

      console.log('Baixando binário oficial de:', downloadUrl);
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

// Inspeciona o arquivo com FFmpeg para verificar se possui vídeo e qual o codec
function inspectMediaStreams(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve({ hasVideo: true, isH264: true });
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (error, stdout, stderr) => {
      const info = (stderr || '') + (stdout || '');
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
      const isH264 = /Video:\s*h264/i.test(info);
      resolve({ hasVideo, isH264, rawInfo: info });
    });
  });
}

// Converte o vídeo para H.264 + AAC caso a plataforma tenha enviado em AV1, VP9 ou HEVC
function convertToAndroidMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-y',
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
      ],
      (error) => {
        if (error) return reject(error);
        resolve(outputPath);
      }
    );
  });
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
app.get('/
