const express = require('express');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 180 * 1024 * 1024;
const TEMP_DIR = os.tmpdir();
const VERSION = '5.0';

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
let activeBinaryPath = localBinaryPath;

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
      if (!name.startsWith('cortepro_') &&
          !name.startsWith('splitjob_')) continue;

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
    if (redirectsLeft < 0) {
      return reject(new Error('Redirecionamentos demais no download.'));
    }

    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (_) {
      return reject(new Error('URL de download inválida.'));
    }

    const lib = parsed.protocol === 'https:'
      ? https
      : parsed.protocol === 'http:'
        ? http
        : null;

    if (!lib) {
      return reject(new Error('Protocolo de download inválido.'));
    }

    const request = lib.get(urlString, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
      },
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
        return reject(new Error(`Falha no download. HTTP ${status}.`));
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve());
      });

      file.on('error', err => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Tempo esgotado ao baixar arquivo.'));
    });

    request.on('error', err => {
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

function fetchJson(urlString, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
        'Accept': 'application/json'
      },
      timeout: timeoutMs
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error('Resposta JSON inválida.'));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout na API auxiliar.')));
    req.on('error', reject);
  });
}

// Resolve links curtos como facebook.com/share/v/..., share/r/..., fb.watch, vt.tiktok.com
function resolveShareUrl(rawUrl, hopsLeft = 5) {
  return new Promise(resolve => {
    if (hopsLeft <= 0) return resolve(rawUrl);

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return resolve(rawUrl);
    }

    // Se o Facebook redirecionou para /login/?next=..., extrai o link real do parâmetro "next"
    if (
      parsed.hostname.includes('facebook.com') &&
      parsed.pathname.includes('/login') &&
      parsed.searchParams.get('next')
    ) {
      return resolve(parsed.searchParams.get('next'));
    }

    const isFbShare =
      parsed.hostname.includes('facebook.com') &&
      /\/share\/[vrp]\//i.test(parsed.pathname);
    const isShortener =
      /^(vt\.tiktok\.com|vm\.tiktok\.com|fb\.watch|s\.kw\.ai)$/i.test(parsed.hostname);
    const isInstaShare =
      parsed.hostname.includes('instagram.com') &&
      parsed.pathname.includes('/share/');

    if (!isFbShare && !isShortener && !isInstaShare) {
      return resolve(rawUrl);
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const ua = isFbShare || parsed.hostname === 'fb.watch'
      ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

    const req = lib.get(rawUrl, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 8000
    }, res => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let nextUrl = new URL(res.headers.location, rawUrl).toString();

        try {
          const nextParsed = new URL(nextUrl);
          if (
            nextParsed.hostname.includes('facebook.com') &&
            nextParsed.pathname.includes('/login') &&
            nextParsed.searchParams.get('next')
          ) {
            nextUrl = nextParsed.searchParams.get('next');
            return resolve(nextUrl);
          }
        } catch (_) {}

        return resolveShareUrl(nextUrl, hopsLeft - 1).then(resolve);
      }

      // Lê os primeiros KB do HTML caso o link real esteja em og:url
      let htmlChunk = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        if (htmlChunk.length < 25000) {
          htmlChunk += chunk;
        } else {
          res.destroy();
        }
      });

      const finishHtml = () => {
        const ogMatch =
          htmlChunk.match(/property=["']og:url["']\s+content=["']([^"']+)["']/i) ||
          htmlChunk.match(/content=["']([^"']+)["']\s+property=["']og:url["']/i);

        if (ogMatch && ogMatch[1]) {
          const decoded = ogMatch[1].replace(/&amp;/g, '&');
          if (decoded.startsWith('http')) {
            return resolve(decoded);
          }
        }
        resolve(rawUrl);
      };

      res.on('end', finishHtml);
      res.on('close', finishHtml);
      res.on('error', () => resolve(rawUrl));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(rawUrl);
    });

    req.on('error', () => resolve(rawUrl));
  });
}

async function ensureYtDlpReady() {
  if (isBinaryReady && fs.existsSync(activeBinaryPath)) {
    return true;
  }

  if (binaryReadyPromise) {
    return binaryReadyPromise;
  }

  binaryReadyPromise = (async () => {
    initError = null;

    try {
      if (fs.existsSync(localBinaryPath) && fs.statSync(localBinaryPath).size > 1000000) {
        activeBinaryPath = localBinaryPath;
      } else if (fs.existsSync(tempBinaryPath) && fs.statSync(tempBinaryPath).size > 1000000) {
        activeBinaryPath = tempBinaryPath;
      } else {
        const downloadUrl = isWin
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

        console.log('Baixando yt-dlp:', downloadUrl);

        try {
          await downloadFileDirect(downloadUrl, localBinaryPath);
          activeBinaryPath = localBinaryPath;
        } catch (_) {
          await downloadFileDirect(downloadUrl, tempBinaryPath);
          activeBinaryPath = tempBinaryPath;
        }
      }

      if (!isWin) {
        fs.chmodSync(activeBinaryPath, 0o755);
      }

      isBinaryReady = true;
      console.log('yt-dlp pronto em:', activeBinaryPath);
      return true;
    } catch (err) {
      isBinaryReady = false;
      initError = err.message;
      console.error('Erro ao preparar yt-dlp:', err.message);
      return false;
    } finally {
      binaryReadyPromise = null;
    }
  })();

  return binaryReadyPromise;
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return reject(new Error('FFmpeg não está disponível no servidor.'));
    }

    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || 'Erro no FFmpeg').trim();
          return reject(new Error(detail.slice(-3000)));
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }
    );
  });
}

function inspectMediaStreams(mediaPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return reject(new Error('FFmpeg indisponível para inspeção.'));
    }

    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', mediaPath],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20000
      },
      (error, stdout, stderr) => {
        const info = `${stderr || ''}\n${stdout || ''}`;

        const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
        const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(info);
        const isH264 = /Video:\s*h264\b/i.test(info);
        const isAAC = /Audio:\s*aac\b/i.test(info);
        const isYuv420p = /Video:.*\byuv420p\b/i.test(info);

        let duration = 0;
        const match = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);

        if (match) {
          duration =
            Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3]);
        }

        if (!hasVideo && !hasAudio && error && !info.includes('Input #')) {
          return reject(new Error('Não foi possível ler o arquivo de mídia.'));
        }

        resolve({
          hasVideo,
          hasAudio,
          isH264,
          isAAC,
          isYuv420p,
          duration,
          rawInfo: info
        });
      }
    );
  });
}

async function prepareAndroidMp4(inputPath, outputPath) {
  const inputInfo = await inspectMediaStreams(inputPath);

  console.log(
    `Origem: vídeo=${inputInfo.hasVideo}, áudio=${inputInfo.hasAudio}, H264=${inputInfo.isH264}, AAC=${inputInfo.isAAC}`
  );

  if (!inputInfo.hasVideo) {
    throw new Error('O arquivo não contém uma faixa de vídeo válida.');
  }

  if (!inputInfo.hasAudio) {
    throw new Error('O vídeo extraído não contém faixa de áudio.');
  }

  // Caminho 1 (Instantâneo): Já é H264 + AAC
  if (inputInfo.isH264 && inputInfo.isAAC) {
    try {
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-sn',
        '-dn',
        outputPath
      ], 25000);

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        console.log('MP4 pronto instantaneamente via remux (-c copy).');
        return outputPath;
      }
    } catch (err) {
      console.warn('Remux rápido falhou, convertendo:', err.message);
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
  }

  // Caminho 2 (Rápido): Vídeo já é H264, converte apenas o áudio para AAC
  if (inputInfo.isH264 && !inputInfo.isAAC) {
    try {
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        '-sn',
        '-dn',
        outputPath
      ], 35000);

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        console.log('MP4 pronto rapidamente (cópia de vídeo + áudio AAC).');
        return outputPath;
      }
    } catch (_) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
  }

  // Caminho 3: Recodificação leve (máx 720p) para CPU do Render Free
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-vf',
    "scale='min(720,trunc(iw/2)*2)':trunc(ow/dar/2)*2,format=yuv420p",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',
    '-threads', '2',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    '-sn',
    '-dn',
    outputPath
  ], 75000);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
    throw new Error('A conversão não gerou um MP4 válido.');
  }

  try { fs.unlinkSync(inputPath); } catch (_) {}
  console.log('MP4 recodificado e validado com áudio.');
  return outputPath;
}

function isValidPublicUrl(urlString) {
  try {
    const parsed = new URL(urlString);

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }

    const allowedDomains = [
      'youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'tiktok.com',
      'instagram.com',
      'kwai.com',
      'kwai-video.com',
      'kw.ai',
      'facebook.com',
      'fb.watch',
      'fb.gg'
    ];

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

    return allowedDomains.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch (_) {
    return false;
  }
}

function cleanTargetUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    if (host.includes('instagram.com')) {
      parsed.search = '';
      parsed.hash = '';
      parsed.pathname = parsed.pathname.replace(/^\/reels\//i, '/reel/');
      return parsed.toString();
    }

    if (host.includes('facebook.com')) {
      // Remove parâmetros de rastreio mantendo apenas ?v= quando for watch
      const vParam = parsed.searchParams.get('v');
      parsed.search = '';
      parsed.hash = '';
      if (vParam) {
        parsed.searchParams.set('v', vParam);
      }
      return parsed.toString();
    }

    return rawUrl;
  } catch (_) {
    return rawUrl;
  }
}

function findExtractedFiles(prefix) {
  return fs.readdirSync(TEMP_DIR)
    .filter(name =>
      name.startsWith(prefix) &&
      !name.endsWith('.part') &&
      !name.endsWith('.ytdl')
    )
    .map(name => path.join(TEMP_DIR, name))
    .filter(file => {
      try {
        return fs.statSync(file).isFile() && fs.statSync(file).size > 1000;
      } catch (_) {
        return false;
      }
    });
}

function removeFiles(fileList) {
  for (const f of fileList) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

function runYtDlpAttempt(targetUrl, rawTemplate, formatSelector, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      targetUrl,
      '--force-ipv4',
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--no-check-certificates',
      '--geo-bypass',
      '--max-filesize', '180M',
      '--retries', '2',
      '--fragment-retries', '2',
      '--socket-timeout', '15',
      ...extraArgs,
      '-o', rawTemplate
    ];

    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    execFile(
      activeBinaryPath,
      args,
      {
        maxBuffer: 15 * 1024 * 1024,
        timeout: 45000
      },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error((stderr || err.message || 'Falha no yt-dlp').slice(-1000)));
        }
        resolve(stdout);
      }
    );
  });
}

// Extrator rápido para TikTok
async function tryFastTikTokExtract(targetUrl, destFilePath) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=0`;
  const json = await fetchJson(apiUrl, 12000);

  if (!json || json.code !== 0 || !json.data) {
    throw new Error('API rápida do TikTok não retornou dados.');
  }

  const videoPlayUrl = json.data.play || json.data.wmplay;
  if (!videoPlayUrl) {
    throw new Error('Link de vídeo do TikTok não encontrado.');
  }

  await downloadFileDirect(videoPlayUrl, destFilePath);
  const info = await inspectMediaStreams(destFilePath);

  if (!info.hasVideo || !info.hasAudio) {
    try { fs.unlinkSync(destFilePath); } catch (_) {}
    throw new Error('Arquivo do TikTok sem áudio ou vídeo.');
  }

  return destFilePath;
}

// Resgate de áudio: se o vídeo baixado veio mudo, baixa a faixa de áudio separada e junta no FFmpeg
async function rescueAudioAndMerge(targetUrl, muteVideoPath, uniqueId, userAgent) {
  const audioPrefix = `${uniqueId}_audrescue`;
  const audioTemplate = path.join(TEMP_DIR, `${audioPrefix}.%(ext)s`);
  const mergedPath = path.join(TEMP_DIR, `${uniqueId}_merged.mp4`);

  console.log('Iniciando resgate de áudio separado para:', targetUrl);

  try {
    await runYtDlpAttempt(
      targetUrl,
      audioTemplate,
      'ba/bestaudio/b',
      ['--user-agent', userAgent]
    );

    const audioFiles = findExtractedFiles(audioPrefix);
    if (!audioFiles.length) return null;

    const audioFile = audioFiles[0];
    const audioInfo = await inspectMediaStreams(audioFile);

    if (!audioInfo.hasAudio) {
      removeFiles(audioFiles);
      return null;
    }

    await runFfmpeg([
      '-y',
      '-i', muteVideoPath,
      '-i', audioFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      mergedPath
    ], 35000);

    removeFiles(audioFiles);
    try { fs.unlinkSync(muteVideoPath); } catch (_) {}

    const mergedInfo = await inspectMediaStreams(mergedPath);
    if (mergedInfo.hasVideo && mergedInfo.hasAudio) {
      console.log('Resgate de áudio concluído com sucesso!');
      return mergedPath;
    }
  } catch (err) {
    console.warn('Resgate de áudio falhou:', err.message);
  }

  try { fs.unlinkSync(mergedPath); } catch (_) {}
  return null;
}

async function downloadAndPrepareVideo(rawUrl) {
  cleanupOldTempFiles();

  // 1. Resolve redirecionamentos (facebook.com/share/v/..., share/r/..., vt.tiktok.com, etc.)
  const resolvedUrl = await resolveShareUrl(rawUrl);
  const targetUrl = cleanTargetUrl(resolvedUrl);

  console.log('URL original:', rawUrl);
  if (targetUrl !== rawUrl) {
    console.log('URL resolvida:', targetUrl);
  }

  const isTikTok = /tiktok\.com/i.test(targetUrl);

  const uniqueId =
    `cortepro_${Date.now()}_` +
    Math.random().toString(36).slice(2, 8);

  const rawPrefix = `${uniqueId}_raw`;
  const rawTemplate = path.join(TEMP_DIR, `${rawPrefix}.%(ext)s`);
  const finalFilePath = path.join(TEMP_DIR, `${uniqueId}_ready.mp4`);

  let selectedRawFile = null;
  let lastYtDlpError = '';

  // 2. Se for TikTok, tenta primeiro a extração rápida (2 a 4s)
  if (isTikTok) {
    const fastTikTokFile = path.join(TEMP_DIR, `${rawPrefix}.mp4`);
    try {
      console.log('Tentando extração rápida para TikTok:', targetUrl);
      selectedRawFile = await tryFastTikTokExtract(targetUrl, fastTikTokFile);
      console.log('Extração rápida do TikTok concluída!');
    } catch (ttErr) {
      console.warn('Extração rápida do TikTok falhou, usando yt-dlp:', ttErr.message);
      try { fs.unlinkSync(fastTikTokFile); } catch (_) {}
    }
  }

  const desktopUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const mobileUA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

  // 3. Estratégias com 'bv+ba' (sem asterisco em bv, obrigando o download do par de áudio)
  // e formatos progressivos nativos ('hd/sd/b')
  if (!selectedRawFile) {
    const strategies = [
      {
        name: 'Fusão explícita Vídeo + Áudio (bv+ba / hd / sd)',
        format: 'bv+ba/hd/sd/b[ext=mp4]/b',
        ua: desktopUA,
        extra: ['-S', 'vcodec:h264,acodec:aac,res:720,ext:mp4:m4a']
      },
      {
        name: 'Stream Mobile Combinado (iPhone UA)',
        format: 'hd/sd/b[ext=mp4]/b/bv+ba',
        ua: mobileUA,
        extra: []
      }
    ];

    for (let i = 0; i < strategies.length; i++) {
      const strat = strategies[i];
      console.log(`Tentativa yt-dlp ${i + 1} (${strat.name}):`, targetUrl);

      try {
        await runYtDlpAttempt(
          targetUrl,
          rawTemplate,
          strat.format,
          ['--user-agent', strat.ua, ...strat.extra]
        );
      } catch (err) {
        lastYtDlpError = err.message;
        console.warn(`Tentativa ${i + 1} aviso/erro:`, err.message);
      }

      const matches = findExtractedFiles(rawPrefix);
      if (!matches.length) continue;

      let videoOnlyFile = null;
      let audioOnlyFile = null;

      for (const file of matches) {
        try {
          const info = await inspectMediaStreams(file);
          console.log(
            `Arquivo gerado (${path.basename(file)}): video=${info.hasVideo}, audio=${info.hasAudio}`
          );

          if (info.hasVideo && info.hasAudio) {
            selectedRawFile = file;
            break;
          } else if (info.hasVideo && !info.hasAudio) {
            videoOnlyFile = file;
          } else if (!info.hasVideo && info.hasAudio) {
            audioOnlyFile = file;
          }
        } catch (_) {}
      }

      if (selectedRawFile) {
        // Remove outros arquivos temporários que não sejam o selecionado
        removeFiles(matches.filter(f => f !== selectedRawFile));
        break;
      }

      // Caso o yt-dlp tenha baixado vídeo e áudio em arquivos separados sem juntar
      if (videoOnlyFile && audioOnlyFile) {
        const mergedFile = path.join(TEMP_DIR, `${uniqueId}_pairmerged.mp4`);
        try {
          await runFfmpeg([
            '-y',
            '-i', videoOnlyFile,
            '-i', audioOnlyFile,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-shortest',
            '-movflags', '+faststart',
            mergedFile
          ], 35000);

          const mergedInfo = await inspectMediaStreams(mergedFile);
          if (mergedInfo.hasVideo && mergedInfo.hasAudio) {
            selectedRawFile = mergedFile;
            removeFiles(matches);
            break;
          }
        } catch (_) {
          try { fs.unlinkSync(mergedFile); } catch (_) {}
        }
      }

      // Caso tenha baixado apenas o vídeo mudo, aciona o Resgate de Áudio
      if (videoOnlyFile && !selectedRawFile) {
        const rescued = await rescueAudioAndMerge(
          targetUrl,
          videoOnlyFile,
          uniqueId,
          strat.ua
        );
        removeFiles(matches);
        if (rescued) {
          selectedRawFile = rescued;
          break;
        }
      } else {
        removeFiles(matches);
      }
    }
  }

  if (!selectedRawFile) {
    const cleanErr = lastYtDlpError.includes('login') || lastYtDlpError.includes('private')
      ? 'Este vídeo é privado ou exige login na plataforma.'
      : 'Não foi possível extrair o vídeo com áudio desta publicação. Verifique se a publicação é pública.';
