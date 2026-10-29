const express = require('express');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_UPLOAD_BYTES = 180 * 1024 * 1024;
const TEMP_DIR = os.tmpdir();
const VERSION = '6.0-Fly';

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Accept']
}));

app.use(express.json({ limit: '1mb' }));

const isWin = process.platform === 'win32';
const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const localBinaryPath = path.join(__dirname, binaryName);
const tempBinaryPath = path.join(TEMP_DIR, binaryName);
let activeBinaryPath = tempBinaryPath;

let isBinaryReady = false;
let initError = null;
let binaryReadyPromise = null;

if (!isWin && ffmpegPath && fs.existsSync(ffmpegPath)) {
  try {
    fs.chmodSync(ffmpegPath, 0o755);
  } catch (_) {}
}

function cleanupOldTempFiles() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(TEMP_DIR)) {
      if (!name.startsWith('cortepro_') && !name.startsWith('splitjob_')) continue;
      const fullPath = path.join(TEMP_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > 30 * 60 * 1000) {
          fs.unlinkSync(fullPath);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function downloadFileDirect(urlString, dest, redirectsLeft = 8) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('Redirecionamentos demais.'));

    let parsed;
    try { parsed = new URL(urlString); } catch (_) { return reject(new Error('URL inválida.')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(urlString, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' },
      timeout: 30000
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, urlString).toString();
        return downloadFileDirect(nextUrl, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error('Falha no download. HTTP ' + status));
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', err => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout no download.')));
    req.on('error', err => {
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

async function ensureYtDlpReady() {
  if (isBinaryReady && fs.existsSync(activeBinaryPath)) return true;
  if (binaryReadyPromise) return binaryReadyPromise;

  binaryReadyPromise = (async () => {
    initError = null;
    try {
      if (fs.existsSync(tempBinaryPath) && fs.statSync(tempBinaryPath).size > 1000000) {
        activeBinaryPath = tempBinaryPath;
      } else if (fs.existsSync(localBinaryPath) && fs.statSync(localBinaryPath).size > 1000000) {
        activeBinaryPath = localBinaryPath;
      } else {
        const downloadUrl = isWin
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
        await downloadFileDirect(downloadUrl, tempBinaryPath);
        activeBinaryPath = tempBinaryPath;
      }
      if (!isWin) fs.chmodSync(activeBinaryPath, 0o755);
      isBinaryReady = true;
      return true;
    } catch (err) {
      isBinaryReady = false;
      initError = err.message;
      return false;
    } finally {
      binaryReadyPromise = null;
    }
  })();
  return binaryReadyPromise;
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return reject(new Error('FFmpeg indisponível.'));
    execFile(ffmpegPath, args, { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || 'Erro FFmpeg').trim();
        return reject(new Error(detail.slice(-3000)));
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function inspectMediaStreams(mediaPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return reject(new Error('FFmpeg indisponível.'));
    execFile(ffmpegPath, ['-hide_banner', '-i', mediaPath], { maxBuffer: 10 * 1024 * 1024, timeout: 20000 }, (error, stdout, stderr) => {
      const info = (stderr || '') + '\n' + (stdout || '');
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
      const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(info);
      const isH264 = /Video:\s*h264\b/i.test(info);
      const isAAC = /Audio:\s*aac\b/i.test(info);
      let duration = 0;
      const match = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

      if (!hasVideo && !hasAudio && error && !info.includes('Input #')) {
        return reject(new Error('Falha ao ler mídia.'));
      }
      resolve({ hasVideo, hasAudio, isH264, isAAC, duration });
    });
  });
}

async function prepareAndroidMp4(inputPath, outputPath) {
  const inputInfo = await inspectMediaStreams(inputPath);
  if (!inputInfo.hasVideo) throw new Error('Vídeo inválido.');
  if (!inputInfo.hasAudio) throw new Error('O vídeo extraído não contém áudio.');

  if (inputInfo.isH264 && inputInfo.isAAC) {
    try {
      await runFfmpeg(['-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', outputPath], 25000);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        return outputPath;
      }
    } catch (_) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
  }

  await runFfmpeg([
    '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0',
    '-vf', "scale='min(720,trunc(iw/2)*2)':trunc(ow/dar/2)*2,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '-sn', '-dn', outputPath
  ], 75000);

  try { fs.unlinkSync(inputPath); } catch (_) {}
  return outputPath;
}

function isValidPublicUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const allowed = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'kwai.com', 'facebook.com', 'fb.watch'];
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return allowed.some(d => host === d || host.endsWith('.' + d));
  } catch (_) { return false; }
}

function runYtDlpAttempt(targetUrl, rawTemplate, formatSelector, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      targetUrl, '--force-ipv4', '-f', formatSelector,
      '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '--no-part',
      '--no-check-certificates', '--geo-bypass', '--max-filesize', '180M',
      '--retries', '2', '--socket-timeout', '15', ...extraArgs, '-o', rawTemplate
    ];
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);

    execFile(activeBinaryPath, args, { maxBuffer: 15 * 1024 * 1024, timeout: 45000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-1000)));
      resolve(stdout);
    });
  });
}

function findExtractedFiles(prefix) {
  return fs.readdirSync(TEMP_DIR)
    .filter(n => n.startsWith(prefix) && !n.endsWith('.part') && !n.endsWith('.ytdl'))
    .map(n => path.join(TEMP_DIR, n))
    .filter(f => { try { return fs.statSync(f).size > 1000; } catch (_) { return false; } });
}

function removeFiles(list) {
  for (const f of list) { try { fs.unlinkSync(f); } catch (_) {} }
}

async function downloadAndPrepareVideo(rawUrl) {
  cleanupOldTempFiles();
  const uniqueId = 'cortepro_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const rawPrefix = uniqueId + '_raw';
  const rawTemplate = path.join(TEMP_DIR, rawPrefix + '.%(ext)s');
  const finalFilePath = path.join(TEMP_DIR, uniqueId + '_ready.mp4');

  let selectedRawFile = null;
  let lastErr = '';

  const strategies = [
    { format: 'bv+ba/hd/sd/b[ext=mp4]/b', extra: ['-S', 'vcodec:h264,acodec:aac,res:720'] },
    { format: 'hd/sd/b[ext=mp4]/b/bv+ba', extra: [] }
  ];

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    try {
      await runYtDlpAttempt(rawUrl, rawTemplate, s.format, s.extra);
    } catch (err) {
      lastErr = err.message;
    }

    const matches = findExtractedFiles(rawPrefix);
    if (!matches.length) continue;

    for (const f of matches) {
      try {
        const info = await inspectMediaStreams(f);
        if (info.hasVideo && info.hasAudio) {
          selectedRawFile = f;
          break;
        }
      } catch (_) {}
    }

    if (selectedRawFile) {
      removeFiles(matches.filter(x => x !== selectedRawFile));
      break;
    } else {
      removeFiles(matches);
    }
  }

  if (!selectedRawFile) {
    throw new Error(lastErr.includes('private') ? 'Este vídeo é privado.' : 'Não foi possível extrair o vídeo com áudio desta publicação.');
  }

  const preparedPath = await prepareAndroidMp4(selectedRawFile, finalFilePath);
  return { fileName: path.basename(preparedPath), filePath: preparedPath };
}

app.get('/', (_req, res) => {
  res.json({ status: 'CortePro Fly.io operacional', version: VERSION });
});

app.get('/api/extract', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!url || !isValidPublicUrl(url)) return res.status(400).json({ success: false, error: 'Link inválido.' });

  await ensureYtDlpReady();
  try {
    const result = await downloadAndPrepareVideo(url);
    return res.json({ success: true, downloadUrl: '/api/file/' + result.fileName });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Falha ao processar vídeo.' });
  }
});

app.get('/api/file/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  if (!/^cortepro_[a-zA-Z0-9_-]+\.mp4$/i.test(fileName) && !/^splitjob_[a-zA-Z0-9_-]+\.mp4$/i.test(fileName)) {
    return res.status(400).send('Nome inválido.');
  }
  const filePath = path.join(TEMP_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo expirado.');

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
  fs.createReadStream(filePath).pipe(res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('CortePro Fly.io rodando na porta ' + PORT);
});
