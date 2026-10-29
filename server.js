const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const isWin = process.platform === 'win32';
if (!isWin && ffmpegPath && fs.existsSync(ffmpegPath)) {
  try {
    fs.chmodSync(ffmpegPath, 0o755);
  } catch (e) {}
}

const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin ? path.join(__dirname, binaryName) : path.join('/tmp', binaryName);

let ytDlpWrap = null;
let isBinaryReady = false;
let initError = null;
let isDownloading = false;

function cleanupOldTempFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync('/tmp');
    files.forEach(f => {
      if (f.startsWith('cortepro_') || f.startsWith('splitjob_')) {
        const fullPath = path.join('/tmp', f);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > 10 * 60 * 1000) {
            fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
    });
  } catch (e) {}
}

// Expande links encurtados de partilha (como facebook.com/share/... ou vm.tiktok.com)
function expandShortUrl(urlStr) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;
      
      const req = lib.request(urlStr, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
        if (res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(urlStr);
        }
      });
      req.on('error', () => resolve(urlStr));
      req.setTimeout(4000, () => {
        req.destroy();
        resolve(urlStr);
      });
      req.end();
    } catch (e) {
      resolve(urlStr);
    }
  });
}

function downloadFileDirect(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'CortePro-Master/3.0' } }, (response) => {
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

      console.log('A transferir binário oficial do yt-dlp:', downloadUrl);
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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout, stderr });
    });
  });
}

function inspectMediaStreams(filePath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve({ hasVideo: true, hasAudio: true, isH264: true, duration: 0 });
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (error, stdout, stderr) => {
      const info = (stderr || '') + (stdout || '');
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
      const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(info);
      const isH264 = /Video:\s*h264/i.test(info);

      let duration = 0;
      const durMatch = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (durMatch) {
        duration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
      }

      resolve({ hasVideo, hasAudio, isH264, duration, rawInfo: info });
    });
  });
}

async function prepareAndroidMp4(inputPath, outputPath) {
  if (!ffmpegPath) return inputPath;

  const check = await inspectMediaStreams(inputPath);
  console.log(`Inspeção -> Video: ${check.hasVideo}, Audio: ${check.hasAudio}, H264: ${check.isH264}`);

  if (!check.hasVideo) {
    throw new Error('O ficheiro obtido não contém faixa de vídeo.');
  }

  try {
    const ffArgs = [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-profile:v', 'main',
      '-level', '3.1'
    ];
    if (check.hasAudio) {
      ffArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
    }
    ffArgs.push('-movflags', '+faststart', outputPath);

    await runFfmpeg(ffArgs);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      fs.unlink(inputPath, () => {});
      return outputPath;
    }
  } catch (err) {
    console.error('Erro ao converter vídeo:', err.message);
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

async function downloadAndPrepareVideo(rawUrl) {
  cleanupOldTempFiles();

  const expandedUrl = await expandShortUrl(rawUrl);
  console.log(`URL expandida: ${expandedUrl}`);

  const uniqueId = `cortepro_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const rawTemplate = path.join('/tmp', `${uniqueId}_raw.%(ext)s`);
  const finalFileName = `${uniqueId}_ready.mp4`;
  const finalFilePath = path.join('/tmp', finalFileName);

  const findByPrefix = (prefix) => {
    const files = fs.readdirSync('/tmp');
    const matches = files.filter(
      f => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl')
    );
    const mp4Match = matches.find(f => f.endsWith('.mp4'));
    const chosen = mp4Match || matches[0];
    return chosen ? path.join('/tmp', chosen) : null;
  };

  // Seletor universal robusto para qualquer plataforma (Facebook, Instagram, TikTok, Kwai, YouTube)
  const formatSelector = 'bv*+ba/b/best';

  const args = [
    expandedUrl,
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--no-part',
    '--max-filesize', '180M',
    '-o', rawTemplate
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  await ytDlpWrap.execPromise(args);

  const rawFilePath = findByPrefix(`${uniqueId}_raw`);
  if (!rawFilePath || !fs.existsSync(rawFilePath)) {
    throw new Error('Não foi possível transferir o vídeo desta publicação. O link pode ser privado.');
  }

  const preparedPath = await prepareAndroidMp4(rawFilePath, finalFilePath);
  return {
    fileName: path.basename(preparedPath),
    filePath: preparedPath
  };
}

app.get('/', (req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    ffmpegReady: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    endpoint: '/api/extract?url=LINK_DO_VIDEO'
  });
});

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
          : 'O servidor está a iniciar o extrator. Aguarde 10 segundos e tente novamente.'
      });
    }
  }

  try {
    console.log(`A processar URL universal: ${videoUrl}`);
    const result = await downloadAndPrepareVideo(videoUrl);

    res.json({
      success: true,
      title: 'Vídeo MP4 Pronto (Com Áudio)',
      downloadUrl: `/api/file/${result.fileName}`
    });
  } catch (error) {
    console.error('Erro ao transferir vídeo:', error.message);
    res.status(500).json({
      error: 'Não foi possível transferir este vídeo. Verifique se o link é público e tente novamente.',
      details: error.message
    });
  }
});

app.get('/api/file/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  if (!fileName.startsWith('cortepro_') && !fileName.startsWith('splitjob_')) {
    return res.status(400).send('Ficheiro inválido.');
  }

  const filePath = path.join('/tmp', fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('O ficheiro expirou. Por favor, clique em Processar e Baixar novamente.');
  }

  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="CortePro_${Date.now()}.mp4"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// --- FUNCIONALIDADE B: DIVISOR AUTO-INTELIGENTE ---
async function detectSpeechPauses(filePath) {
  if (!ffmpegPath) return [];

  const thresholds = ['-30dB', '-22dB'];
  let allPauses = [];

  for (const noiseLevel of thresholds) {
    const pauses = await new Promise((resolve) => {
      execFile(
        ffmpegPath,
        ['-hide_banner', '-vn', '-i', filePath, '-af', `silencedetect=noise=${noiseLevel}:d=0.25`, '-f', 'null', '-'],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          const output = (stderr || '') + (stdout || '');
          const list = [];
          let currentStart = null;

          const lines = output.split('\n');
          for (const line of lines) {
            const startMatch = line.match(/silence_start:\s*([\d.]+)/);
            if (startMatch) {
              currentStart = parseFloat(startMatch[1]);
            }
            const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
            if (endMatch && currentStart !== null) {
              const end = parseFloat(endMatch[1]);
              const duration = parseFloat(endMatch[2]);
              list.push({
                start: currentStart,
                end: end,
                duration: duration,
                mid: (currentStart + end) / 2
              });
              currentStart = null;
            }
          }
          resolve(list);
        }
      );
    });

    if (pauses.length >= 2) {
      allPauses = pauses;
      break;
    } else if (pauses.length > allPauses.length) {
      allPauses = pauses;
    }
  }

  return allPauses;
}

function computeSmartSegments(totalDuration, partsCount, pauses) {
  const segments = [];
  let currentStart = 0;

  for (let i = 1; i < partsCount; i++) {
    const remainingDuration = totalDuration - currentStart;
    const remainingParts = partsCount - i + 1;
    const targetCut = currentStart + remainingDuration / remainingParts;
    const avgPartLen = totalDuration / partsCount;

    const searchRadius = Math.max(4, Math.min(20, avgPartLen * 0.35));
    const minCut = Math.max(currentStart + 3, targetCut - searchRadius);
    const maxCut = Math.min(totalDuration - 3 * (remainingParts - 1), targetCut + searchRadius);

    const candidates = pauses.filter(p => p.mid >= minCut && p.mid <= maxCut);

    let chosenCutEnd = targetCut;
    let nextPartStart = targetCut;
    let cutReason = 'Transição suave com continuidade';

    if (candidates.length > 0) {
      let bestPause = candidates[0];
      let bestScore = -Infinity;

      for (const c of candidates) {
        const distPenalty = Math.abs(c.mid - targetCut) / searchRadius;
        const durationBonus = Math.min(c.duration, 1.5) * 1.8;
        const score = durationBonus - distPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestPause = c;
        }
      }

      chosenCutEnd = Math.min(totalDuration, bestPause.start + Math.min(bestPause.duration * 0.65, 0.35));
      nextPartStart = Math.max(0, bestPause.end - Math.min(bestPause.duration * 0.35, 0.25));
      cutReason = 'Pausa natural na fala detetada';
    } else {
      chosenCutEnd = targetCut;
      nextPartStart = Math.max(currentStart, targetCut - 0.35);
    }

    segments.push({
      partNumber: i,
      start: Number(currentStart.toFixed(2)),
      end: Number(chosenCutEnd.toFixed(2)),
      duration: Number((chosenCutEnd - currentStart).toFixed(1)),
      reason: cutReason
    });

    currentStart = nextPartStart;
  }

  segments.push({
    partNumber: partsCount,
    start: Number(currentStart.toFixed(2)),
    end: Number(totalDuration.toFixed(2)),
    duration: Number((totalDuration - currentStart).toFixed(1)),
    reason: 'Conclusão do vídeo'
  });

  return segments;
}

app.post('/api/smart-split', async (req, res) => {
  cleanupOldTempFiles();

  const partsCount = Math.max(2, Math.min(20, parseInt(req.query.parts, 10) || 2));
  const jobId = `splitjob_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const inputPath = path.join('/tmp', `${jobId}_input.mp4`);

  try {
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inputPath);
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ error: 'Ficheiro de vídeo inválido ou vazio.' });
    }

    const mediaInfo = await inspectMediaStreams(inputPath);
    const totalDuration = mediaInfo.duration || 60;

    if (totalDuration < 4) {
      return res.status(400).json({ error: 'O vídeo é muito curto para ser dividido.' });
    }

    const pauses = await detectSpeechPauses(inputPath);
    const segments = computeSmartSegments(totalDuration, partsCount, pauses);

    const generatedParts = [];

    for (const seg of segments) {
      const partFileName = `${jobId}_parte_${seg.partNumber}.mp4`;
      const partPath = path.join('/tmp', partFileName);

      await runFfmpeg([
        '-y',
        '-ss', String(seg.start),
        '-to', String(seg.end),
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
        partPath
      ]);

      generatedParts.push({
        partNumber: seg.partNumber,
        start: seg.start,
        end: seg.end,
        duration: seg.duration,
        reason: seg.reason,
        downloadUrl: `/api/file/${partFileName}`
      });
    }

    if (fs.existsSync(inputPath)) {
      fs.unlink(inputPath, () => {});
    }

    res.json({
      success: true,
      totalDuration: Number(totalDuration.toFixed(1)),
      partsCount: generatedParts.length,
      parts: generatedParts
    });
  } catch (error) {
    console.error('Erro no divisor inteligente:', error.message);
    if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
    res.status(500).json({
      error: 'Falha ao processar a divisão inteligente do vídeo.',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master a correr na porta ${PORT}`);
});
