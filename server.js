
const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
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

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const isWin = process.platform === 'win32';
const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin
  ? path.join(__dirname, binaryName)
  : path.join(TEMP_DIR, binaryName);

let ytDlpWrap = null;
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
      return reject(
        new Error('Redirecionamentos demais ao baixar yt-dlp.')
      );
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
      headers: { 'User-Agent': 'CortePro-Master/4.0' },
      timeout: 20000
    }, response => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 &&
          response.headers.location) {
        response.resume();

        const nextUrl = new URL(
          response.headers.location,
          urlString
        ).toString();

        return downloadFileDirect(
          nextUrl,
          dest,
          redirectsLeft - 1
        ).then(resolve, reject);
      }

      if (status !== 200) {
        response.resume();
        return reject(
          new Error(`Falha ao baixar yt-dlp. HTTP ${status}.`)
        );
      }

      const file = fs.createWriteStream(dest);

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve());
      });

      file.on('error', err => {
        try {
          fs.unlinkSync(dest);
        } catch (_) {}

        reject(err);
      });
    });

    request.on('timeout', () => {
      request.destroy(
        new Error('Tempo esgotado ao baixar yt-dlp.')
      );
    });

    request.on('error', err => {
      try {
        fs.unlinkSync(dest);
      } catch (_) {}

      reject(err);
    });
  });
}

// Evita inicializações concorrentes do yt-dlp.
async function ensureYtDlpReady() {
  if (isBinaryReady && ytDlpWrap &&
      fs.existsSync(binaryPath)) {
    return true;
  }

  if (binaryReadyPromise) {
    return binaryReadyPromise;
  }

  binaryReadyPromise = (async () => {
    initError = null;

    try {
      if (!fs.existsSync(binaryPath) ||
          fs.statSync(binaryPath).size < 1000000) {
        const downloadUrl = isWin
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

        console.log('Baixando yt-dlp:', downloadUrl);

        await downloadFileDirect(downloadUrl, binaryPath);
      }

      if (!isWin) {
        fs.chmodSync(binaryPath, 0o755);
      }

      ytDlpWrap = new YTDlpWrap(binaryPath);
      isBinaryReady = true;

      console.log('yt-dlp pronto:', binaryPath);

      return true;
    } catch (err) {
      isBinaryReady = false;
      ytDlpWrap = null;
      initError = err.message;

      console.error(
        'Erro ao preparar yt-dlp:',
        err.message
      );

      return false;
    } finally {
      binaryReadyPromise = null;
    }
  })();

  return binaryReadyPromise;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return reject(
        new Error('FFmpeg não está disponível no servidor.')
      );
    }

    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 15 * 60 * 1000
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (
            stderr || error.message || 'Erro no FFmpeg'
          ).trim();

          return reject(new Error(detail.slice(-5000)));
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }
    );
  });
}

// Verifica faixas de vídeo e áudio.
function inspectMediaStreams(mediaPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return reject(
        new Error('FFmpeg indisponível para inspeção.')
      );
    }

    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', mediaPath],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000
      },
      (error, stdout, stderr) => {
        const info = `${stderr || ''}\n${stdout || ''}`;

        const hasVideo =
          /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Video:/i
            .test(info);

        const hasAudio =
          /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Audio:/i
            .test(info);

        const isH264 = /Video:\s*h264\b/i.test(info);
        const isAAC = /Audio:\s*aac\b/i.test(info);
        const isYuv420p = /Video:.*\byuv420p\b/i.test(info);

        let duration = 0;

        const match = info.match(
          /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i
        );

        if (match) {
          duration =
            Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3]);
        }

        if (!hasVideo && !hasAudio &&
            error && !info.includes('Input #')) {
          return reject(
            new Error(
              'Não foi possível ler o arquivo de mídia.'
            )
          );
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

// Prepara MP4 compatível com dispositivos móveis.
async function prepareAndroidMp4(inputPath, outputPath) {
  const inputInfo = await inspectMediaStreams(inputPath);

  console.log(
    `Origem: vídeo=${inputInfo.hasVideo}, ` +
    `áudio=${inputInfo.hasAudio}, H264=${inputInfo.isH264}, ` +
    `AAC=${inputInfo.isAAC}`
  );

  if (!inputInfo.hasVideo) {
    throw new Error(
      'O arquivo não contém uma faixa de vídeo válida.'
    );
  }

  if (!inputInfo.hasAudio) {
    throw new Error(
      'O arquivo de origem não contém áudio. ' +
      'O download foi interrompido para evitar entregar ' +
      'um vídeo sem som.'
    );
  }

  if (
    inputInfo.isH264 &&
    inputInfo.isAAC &&
    inputInfo.isYuv420p
  ) {
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
      ]);

      const remuxInfo =
        await inspectMediaStreams(outputPath);

      if (
        remuxInfo.hasVideo &&
        remuxInfo.hasAudio &&
        fs.statSync(outputPath).size > 1000
      ) {
        try {
          fs.unlinkSync(inputPath);
        } catch (_) {}

        console.log(
          'MP4 compatível: conversão rápida sem recodificação.'
        );

        return outputPath;
      }

      throw new Error('O MP4 não passou na validação.');
    } catch (err) {
      console.warn(
        'Remux rápido falhou:',
        err.message
      );

      try {
        fs.unlinkSync(outputPath);
      } catch (_) {}
    }
  }

  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
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
    '-sn',
    '-dn',
    outputPath
  ]);

  if (
    !fs.existsSync(outputPath) ||
    fs.statSync(outputPath).size < 1000
  ) {
    throw new Error(
      'A conversão não gerou um MP4 válido.'
    );
  }

  const outputInfo =
    await inspectMediaStreams(outputPath);

  if (!outputInfo.hasVideo || !outputInfo.hasAudio) {
    try {
      fs.unlinkSync(outputPath);
    } catch (_) {}

    throw new Error(
      'O arquivo final não passou na validação ' +
      'de áudio e vídeo.'
    );
  }

  try {
    fs.unlinkSync(inputPath);
  } catch (_) {}

  console.log('MP4 convertido e validado com áudio.');

  return outputPath;
}

// Restringe links às plataformas suportadas.
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
      'facebook.com',
      'fb.watch'
    ];

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '');

    return allowedDomains.some(domain =>
      hostname === domain ||
      hostname.endsWith('.' + domain)
    );
  } catch (_) {
    return false;
  }
}

// Download e preparação do arquivo.
async function downloadAndPrepareVideo(rawUrl) {
  cleanupOldTempFiles();

  const uniqueId =
    `cortepro_${Date.now()}_` +
    Math.random().toString(36).slice(2, 8);

  const rawTemplate = path.join(
    TEMP_DIR,
    `${uniqueId}_raw.%(ext)s`
  );

  const finalFilePath = path.join(
    TEMP_DIR,
    `${uniqueId}_ready.mp4`
  );

  const args = [
    rawUrl,
    '-f', 'bv*+ba/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--max-filesize', '180M',
    '--retries', '2',
    '--fragment-retries', '2',
    '--socket-timeout', '20',
    '-o', rawTemplate
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  console.time(`${uniqueId}-extracao`);

  try {
    await ytDlpWrap.execPromise(args);
  } finally {
    console.timeEnd(`${uniqueId}-extracao`);
  }

  const matches = fs.readdirSync(TEMP_DIR)
    .filter(name =>
      name.startsWith(`${uniqueId}_raw`) &&
      !name.endsWith('.part') &&
      !name.endsWith('.ytdl')
    )
    .map(name => path.join(TEMP_DIR, name))
    .filter(file => {
      try {
        return (
          fs.statSync(file).isFile() &&
          fs.statSync(file).size > 1000
        );
      } catch (_) {
        return false;
      }
    });

  const rawFilePath =
    matches.find(file =>
      file.toLowerCase().endsWith('.mp4')
    ) || matches[0];

  if (!rawFilePath) {
    throw new Error(
      'O extrator não gerou um vídeo. ' +
      'O link pode ser privado ou indisponível.'
    );
  }

  console.time(`${uniqueId}-preparacao`);

  let preparedPath;

  try {
    preparedPath = await prepareAndroidMp4(
      rawFilePath,
      finalFilePath
    );
  } finally {
    console.timeEnd(`${uniqueId}-preparacao`);
  }

  return {
    fileName: path.basename(preparedPath),
    filePath: preparedPath
  };
}

// Status do servidor.
app.get('/', (_req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    ffmpegReady: Boolean(
      ffmpegPath && fs.existsSync(ffmpegPath)
    ),
    endpoint: '/api/extract?url=LINK_DO_VIDEO'
  });
});

// Endpoint de extração.
app.get('/api/extract', async (req, res) => {
  const videoUrl =
    typeof req.query.url === 'string'
      ? req.query.url.trim()
      : '';

  if (!videoUrl) {
    return res.status(400).json({
      success: false,
      error: "Parâmetro 'url' não fornecido."
    });
  }

  if (!isValidPublicUrl(videoUrl)) {
    return res.status(400).json({
      success: false,
      error: 'Link inválido ou não permitido.'
    });
  }

  const ready = await ensureYtDlpReady();

  if (!ready) {
    return res.status(503).json({
      success: false,
      error: initError
        ? `Erro ao preparar o extrator: ${initError}`
        : 'O extrator ainda está iniciando. ' +
          'Aguarde e tente novamente.'
    });
  }

  try {
    console.log('Iniciando extração:', videoUrl);

    const result =
      await downloadAndPrepareVideo(videoUrl);

    return res.json({
      success: true,
      title: 'Vídeo MP4 validado com áudio',
      downloadUrl: `/api/file/${result.fileName}`
    });
  } catch (error) {
    console.error(
      'Erro ao transferir vídeo:',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: error.message ||
        'Não foi possível transferir este vídeo.'
    });
  }
});

// Download do arquivo com suporte a Range.
app.get('/api/file/:fileName', (req, res) => {
  const fileName =
    path.basename(req.params.fileName);

  if (
    !/^cortepro_[a-zA-Z0-9_-]+\.mp4$/i.test(fileName) &&
    !/^splitjob_[a-zA-Z0-9_-]+\.mp4$/i.test(fileName)
  ) {
    return res.status(400).send(
      'Nome de arquivo inválido.'
    );
  }

  const filePath = path.join(
    TEMP_DIR,
    fileName
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).send(
      'O arquivo expirou. Processe e baixe novamente.'
    );
  }

  let stat;

  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return res.status(404).send(
      'Arquivo não encontrado.'
    );
  }

  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;

  if (range) {
    const match =
      /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    if (!match || (!match[1] && !match[2])) {
      res.setHeader(
        'Content-Range',
        `bytes */${stat.size}`
      );
      return res.status(416).end();
    }

    if (!match[1]) {
      const suffix = Number(match[2]);

      if (!Number.isSafeInteger(suffix) ||
          suffix <= 0) {
        res.setHeader(
          'Content-Range',
          `bytes */${stat.size}`
        );
        return res.status(416).end();
      }

      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);

      if (match[2]) {
        end = Number(match[2]);
      }
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= stat.size ||
      end < start ||
      end < 0
    ) {
      res.setHeader(
        'Content-Range',
        `bytes */${stat.size}`
      );
      return res.status(416).end();
    }

    end = Math.min(end, stat.size - 1);

    res.status(206);
    res.setHeader(
      'Content-Range',
      `bytes ${start}-${end}/${stat.size}`
    );
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Length',
    end - start + 1
  );
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"`
  );

  const stream = fs.createReadStream(
    filePath,
    { start, end }
  );

  stream.on('error', err => {
    console.error(
      'Erro ao enviar arquivo:',
      err.message
    );

    if (!res.headersSent) {
      res.status(500);
    }

    res.end();
  });

  stream.pipe(res);
});

// Detecta pausas naturais no áudio.
async function detectSpeechPauses(filePath) {
  if (!ffmpegPath) return [];

  return new Promise(resolve => {
    execFile(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-vn',
        '-i', filePath,
        '-af',
        'silencedetect=noise=-30dB:d=0.25',
        '-f', 'null',
        '-'
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15 * 60 * 1000
      },
      (_err, stdout, stderr) => {
        const output =
          `${stderr || ''}\n${stdout || ''}`;

        const pauses = [];
        let currentStart = null;

        for (const line of output.split('\n')) {
          const startMatch = line.match(
            /silence_start:\s*([\d.]+)/
          );

          if (startMatch) {
            currentStart =
              parseFloat(startMatch[1]);
          }

          const endMatch = line.match(
            /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/
          );

          if (
            endMatch &&
            currentStart !== null
          ) {
            const end = parseFloat(endMatch[1]);
            const duration =
              parseFloat(endMatch[2]);

            pauses.push({
              start: currentStart,
              end,
              duration,
              mid: (currentStart + end) / 2
            });

            currentStart = null;
          }
        }

        resolve(pauses);
      }
    );
  });
}

// Calcula os segmentos sem espaços e sem sobreposições.
function computeSmartSegments(
  totalDuration,
  partsCount,
  pauses
) {
  const segments = [];
  let currentStart = 0;
  const minPartDuration = 1;

  for (let i = 1; i < partsCount; i++) {
    const remainingParts =
      partsCount - i + 1;

    const targetCut =
      currentStart +
      (totalDuration - currentStart) /
        remainingParts;

    const searchRadius = Math.max(
      1,
      Math.min(
        20,
        (totalDuration / partsCount) * 0.35
      )
    );

    const minCut = Math.max(
      currentStart + minPartDuration,
      targetCut - searchRadius
    );

    const maxCut = Math.min(
      totalDuration -
        (remainingParts - 1) * minPartDuration,
      targetCut + searchRadius
    );

    const candidates = pauses.filter(p =>
      Number.isFinite(p.mid) &&
      p.mid >= minCut &&
      p.mid <= maxCut
    );

    let cut = targetCut;
    let reason =
      'Corte próximo à duração equilibrada';

    if (candidates.length) {
      const bestPause = candidates.reduce(
        (best, candidate) => {
          const score = p =>
            Math.min(p.duration, 1.5) * 1.8 -
            Math.abs(p.mid - targetCut) /
              Math.max(searchRadius, 1);

          return score(candidate) > score(best)
            ? candidate
            : best;
        }
      );

      cut = bestPause.mid;
      reason =
        'Pausa natural no áudio detectada';
    }

    cut = Number(
      Math.max(
        minCut,
        Math.min(maxCut, cut)
      ).toFixed(2)
    );

    segments.push({
      partNumber: i,
      start: Number(currentStart.toFixed(2)),
      end: cut,
      duration: Number(
        (cut - currentStart).toFixed(2)
      ),
      reason
    });

    currentStart = cut;
  }

  segments.push({
    partNumber: partsCount,
    start: Number(currentStart.toFixed(2)),
    end: Number(totalDuration.toFixed(2)),
    duration: Number(
      (totalDuration - currentStart).toFixed(2)
    ),
    reason: 'Conclusão do vídeo'
  });

  return segments;
}

// Divisão inteligente de vídeos enviados.
app.post('/api/smart-split', async (req, res) => {
  cleanupOldTempFiles();

  const partsCount = Math.max(
    2,
    Math.min(
      20,
      parseInt(req.query.parts, 10) || 2
    )
  );

  const jobId =
    `splitjob_${Date.now()}_` +
    Math.random().toString(36).slice(2, 8);

  const inputPath = path.join(
    TEMP_DIR,
    `${jobId}_input.mp4`
  );

  try {
    const contentLength = Number(
      req.headers['content-length']
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_UPLOAD_BYTES
    ) {
      return res.status(413).json({
        success: false,
        error:
          'Vídeo maior que 180 MB. ' +
          'Selecione um arquivo menor.'
      });
    }

    let receivedBytes = 0;

    const limitStream = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;

        if (receivedBytes > MAX_UPLOAD_BYTES) {
          const error = new Error(
            'Vídeo maior que 180 MB.'
          );

          error.statusCode = 413;
          callback(error);
        } else {
          callback(null, chunk);
        }
      }
    });

    await pipeline(
      req,
      limitStream,
      fs.createWriteStream(inputPath)
    );

    if (
      !fs.existsSync(inputPath) ||
      fs.statSync(inputPath).size < 1000
    ) {
      return res.status(400).json({
        success: false,
        error: 'Arquivo de vídeo inválido ou vazio.'
      });
    }

    const mediaInfo =
      await inspectMediaStreams(inputPath);

    if (!mediaInfo.hasVideo) {
      return res.status(400).json({
        success: false,
        error:
          'O arquivo enviado não contém vídeo válido.'
      });
    }

    const totalDuration = mediaInfo.duration;

    if (!totalDuration || totalDuration < 4) {
      return res.status(400).json({
        success: false,
        error:
          'Vídeo curto demais ou duração não identificada.'
      });
    }

    if (totalDuration < partsCount) {
      return res.status(400).json({
        success: false,
        error:
          'Vídeo curto demais para a quantidade ' +
          'de partes selecionada.'
      });
    }

    const pauses = mediaInfo.hasAudio
      ? await detectSpeechPauses(inputPath)
      : [];

    const segments = computeSmartSegments(
      totalDuration,
      partsCount,
      pauses
    );

    const generatedParts = [];

    for (const segment of segments) {
      const partFileName =
        `${jobId}_parte_${segment.partNumber}.mp4`;

      const partPath = path.join(
        TEMP_DIR,
        partFileName
      );

      const args = [
        '-y',
        '-ss', String(segment.start),
        '-i', inputPath,
        '-t', String(
          Math.max(
            0.1,
            segment.end - segment.start
          )
        ),
        '-map', '0:v:0',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '26',
        '-profile:v', 'main',
        '-level', '3.1'
      ];

      if (mediaInfo.hasAudio) {
        args.push(
          '-map', '0:a:0',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2'
        );
      }

      args.push(
        '-movflags', '+faststart',
        '-sn',
        '-dn',
        partPath
      );

      await runFfmpeg(args);

      const partInfo =
        await inspectMediaStreams(partPath);

      if (
        !partInfo.hasVideo ||
        (mediaInfo.hasAudio &&
         !partInfo.hasAudio)
      ) {
        try {
          fs.unlinkSync(partPath);
        } catch (_) {}

        throw new Error(
          `A validação da parte ` +
          `${segment.partNumber} falhou.`
        );
      }

      generatedParts.push({
        partNumber: segment.partNumber,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
        reason: segment.reason,
        downloadUrl:
          `/api/file/${partFileName}`
      });
    }

    try {
      fs.unlinkSync(inputPath);
    } catch (_) {}

    return res.json({
      success: true,
      totalDuration: Number(
        totalDuration.toFixed(1)
      ),
      partsCount: generatedParts.length,
      parts: generatedParts
    });
  } catch (error) {
    console.error(
      'Erro no divisor:',
      error.message
    );

    try {
      fs.unlinkSync(inputPath);
    } catch (_) {}

    if (!res.headersSent) {
      return res.status(
        error.statusCode || 500
      ).json({
        success: false,
        error: error.message ||
          'Falha ao dividir o vídeo.'
      });
    }
  }
});

// Inicialização do servidor.
app.listen(PORT, () => {
  console.log(
    `Servidor CortePro Master ouvindo na porta ${PORT}`
  );
});

ensureYtDlpReady().catch(err => {
  console.error(
    'Falha ao inicializar yt-dlp:',
    err.message
  );
});
