const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const ffmpegStaticPath = require('ffmpeg-static');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const isWin = process.platform === 'win32';
if (!isWin && ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
  try {
    fs.chmodSync(ffmpegStaticPath, 0o755);
  } catch (e) {}
}

const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
const binaryPath = isWin ? path.join(__dirname, binaryName) : path.join('/tmp', binaryName);
const modernFfmpegPath = isWin ? ffmpegStaticPath : '/tmp/ffmpeg_modern';

let ytDlpWrap = null;
let isBinaryReady = false;
let initError = null;
let isDownloading = false;

// Retorna o FFmpeg 7+ (com suporte a xHE-AAC do Facebook/Instagram) ou o ffmpeg-static como reserva
function getFfmpegBinary() {
  if (!isWin && fs.existsSync(modernFfmpegPath) && fs.statSync(modernFfmpegPath).size > 10000000) {
    return modernFfmpegPath;
  }
  return ffmpegStaticPath;
}

// Limpa arquivos temporários com mais de 15 minutos em /tmp para não lotar o servidor
function cleanupOldTempFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync('/tmp');
    files.forEach(f => {
      if (f.startsWith('cortepro_') || f.startsWith('splitjob_')) {
        const fullPath = path.join('/tmp', f);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > 15 * 60 * 1000) {
            fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
    });
  } catch (e) {}
}

// Baixa arquivo seguindo redirecionamentos
function downloadFileDirect(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'CortePro-Master/2.0' } }, (response) => {
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

// Baixa o FFmpeg 7.1+ oficial do yt-dlp no Linux para decodificar áudio xHE-AAC (40.42) sem falhas
async function ensureModernFfmpeg() {
  if (isWin) return;
  if (fs.existsSync(modernFfmpegPath) && fs.statSync(modernFfmpegPath).size > 10000000) {
    return;
  }
  const archivePath = '/tmp/ffmpeg_build.tar.xz';
  try {
    console.log('Baixando FFmpeg 7+ atualizado para suporte completo de áudio...');
    const url = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz';
    await downloadFileDirect(url, archivePath);
    await new Promise((resolve, reject) => {
      exec(
        `tar -xJf ${archivePath} -C /tmp --strip-components=2 --wildcards '*/bin/ffmpeg' && mv /tmp/ffmpeg ${modernFfmpegPath} && chmod 755 ${modernFfmpegPath}`,
        (err) => (err ? reject(err) : resolve())
      );
    });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    console.log('FFmpeg 7+ pronto em:', modernFfmpegPath);
  } catch (err) {
    console.warn('Usando ffmpeg-static padrão (aviso ao atualizar FFmpeg 7+):', err.message);
    if (fs.existsSync(archivePath)) fs.unlink(archivePath, () => {});
  }
}

// Prepara o yt-dlp e o FFmpeg
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

      console.log('Baixando binário oficial do yt-dlp:', downloadUrl);
      await downloadFileDirect(downloadUrl, binaryPath);
    }

    if (!isWin) {
      fs.chmodSync(binaryPath, 0o755);
    }

    ytDlpWrap = new YTDlpWrap(binaryPath);
    isBinaryReady = true;
    isDownloading = false;
    console.log('yt-dlp pronto em:', binaryPath);

    // Inicia o download do FFmpeg 7+ em segundo plano
    ensureModernFfmpeg();
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
    const bin = getFfmpegBinary();
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout, stderr });
    });
  });
}

// Inspeciona se o arquivo tem vídeo, se tem áudio, duração e codecs
function inspectMediaStreams(filePath) {
  return new Promise((resolve) => {
    const bin = getFfmpegBinary();
    if (!bin) return resolve({ hasVideo: true, hasAudio: true, isH264: true, isAacLc: true, duration: 0 });
    execFile(bin, ['-hide_banner', '-i', filePath], (error, stdout, stderr) => {
      const info = (stderr || '') + (stdout || '');
      const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
      const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(info);
      const isH264 = /Video:\s*h264/i.test(info);
      const isXheAac = /40\.42|usac|xhe-aac/i.test(info);
      const isAacLc = /Audio:\s*aac\s*\(LC\)/i.test(info) && !isXheAac;

      let duration = 0;
      const durMatch = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (durMatch) {
        duration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
      }

      resolve({ hasVideo, hasAudio, isH264, isAacLc, isXheAac, duration, rawInfo: info });
    });
  });
}

// Converte e garante que o arquivo final tenha Vídeo H.264 + Áudio AAC-LC audível em qualquer Android
async function prepareAndroidMp4(inputPath, outputPath) {
  const bin = getFfmpegBinary();
  if (!bin) return inputPath;

  const check = await inspectMediaStreams(inputPath);
  console.log(`Inspeção -> Video: ${check.hasVideo}, Audio: ${check.hasAudio}, H264: ${check.isH264}, AAC-LC: ${check.isAacLc}`);

  if (!check.hasVideo) {
    throw new Error('O arquivo obtido não contém faixa de vídeo.');
  }

  // Se o vídeo já é H.264 e tem áudio, converte o áudio para AAC-LC padrão (corrige som mudo no Android)
  if (check.isH264 && check.hasAudio) {
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
        outputPath
      ]);
      const outCheck = await inspectMediaStreams(outputPath);
      if (fs.existsSync(outputPath) && outCheck.hasVideo && outCheck.hasAudio) {
        return outputPath;
      }
    } catch (e) {
      console.warn('Aviso na conversão rápida de áudio, tentando recodificação completa:', e.message);
    }
  }

  // Recodificação completa para H.264 + AAC-LC
  try {
    const ffArgs = [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '25',
      '-profile:v', 'main',
      '-level', '3.1'
    ];
    if (check.hasAudio) {
      ffArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
    }
    ffArgs.push('-movflags', '+faststart', outputPath);

    await runFfmpeg(ffArgs);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      return outputPath;
    }
  } catch (err) {
    console.error('Erro ao recodificar MP4:', err.message);
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
    ffmpegReady: Boolean(getFfmpegBinary()),
    modernFfmpegReady: fs.existsSync(modernFfmpegPath),
    initError: initError,
    endpoint: '/api/extract?url=LINK_DO_VIDEO',
    downloadEndpoint: '/api/download?url=LINK_DO_VIDEO',
    smartSplitEndpoint: '/api/smart-split?parts=QUANTIDADE'
  });
});

// Rota 1: Extração de informações do vídeo
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
          : 'O servidor está preparando o extrator. Aguarde 10 segundos e tente novamente.'
      });
    }
  }

  try {
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
      downloadUrl: serverDownloadUrl
    });
  } catch (error) {
    console.error('Erro na extração:', error.message);
    res.status(500).json({
      error: 'Não foi possível extrair este vídeo. Verifique se o link é público e tente novamente.',
      details: error.message
    });
  }
});

// Rota 2: Download do vídeo garantindo Vídeo + Áudio funcionando no Android
app.get('/api/download', async (req, res) => {
  cleanupOldTempFiles();
  const videoUrl = req.query.url;

  if (!videoUrl || !isValidPublicUrl(videoUrl)) {
    return res.status(400).send('URL inválida ou ausente.');
  }

  if (!isBinaryReady) {
    const readyNow = await ensureYtDlpReady();
    if (!readyNow) {
      return res.status(503).send('Extrator iniciando. Tente novamente em alguns segundos.');
    }
  }

  const uniquePrefix = `cortepro_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const outputTemplate = path.join('/tmp', `${uniquePrefix}_raw.%(ext)s`);
  const normalizedPath = path.join('/tmp', `${uniquePrefix}_android.mp4`);

  const findFileByPrefix = (prefix) => {
    const files = fs.readdirSync('/tmp');
    const matches = files.filter(
      f => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl')
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
    const activeFfmpeg = getFfmpegBinary();

    // Prioriza formatos com Vídeo + Áudio compatíveis, mantendo fallback bv*+ba para NUNCA baixar sem som
    const formatSelector = [
      'bv*[vcodec^=avc]+ba[acodec^=mp4a.40.2]',
      'bv*[vcodec^=avc]+ba[acodec^=mp4a.40.5]',
      'hd',
      'sd',
      'b[ext=mp4][vcodec^=avc][acodec!=none]',
      'bv*[vcodec^=avc]+ba[ext=m4a]',
      'bv*[vcodec^=avc]+ba',
      'bv*+ba',
      'b[vcodec!=none][acodec!=none]',
      'best'
    ].join('/');

    const args = [
      videoUrl,
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--no-part',
      '-o', outputTemplate
    ];

    if (activeFfmpeg) {
      args.push('--ffmpeg-location', activeFfmpeg);
    }

    await ytDlpWrap.execPromise(args);

    let rawFilePath = findFileByPrefix(`${uniquePrefix}_raw`);
    if (!rawFilePath || !fs.existsSync(rawFilePath)) {
      cleanupFiles();
      return res.status(422).send('Não foi possível gerar o arquivo de vídeo para download.');
    }

    // Verifica se o arquivo baixado possui faixa de áudio; se não tiver, baixa a faixa de áudio separada e une!
    const initialCheck = await inspectMediaStreams(rawFilePath);
    if (!initialCheck.hasAudio && activeFfmpeg) {
      console.log('Arquivo veio sem áudio na 1ª tentativa. Extraindo faixa de áudio separada para unir...');
      const audioTemplate = path.join('/tmp', `${uniquePrefix}_audio.%(ext)s`);
      try {
        await ytDlpWrap.execPromise([
          videoUrl,
          '-f', 'ba[acodec^=mp4a.40.2]/ba[acodec^=mp4a.40.5]/ba/bestaudio/best',
          '--no-playlist',
          '--no-warnings',
          '--no-check-certificates',
          '-o', audioTemplate
        ]);
        const audioFilePath = findFileByPrefix(`${uniquePrefix}_audio`);
        if (audioFilePath && fs.existsSync(audioFilePath)) {
          const mergedPath = path.join('/tmp', `${uniquePrefix}_merged.mp4`);
          await runFfmpeg([
            '-y',
            '-i', rawFilePath,
            '-i', audioFilePath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            '-shortest',
            '-movflags', '+faststart',
            mergedPath
          ]);
          if (fs.existsSync(mergedPath)) {
            rawFilePath = mergedPath;
          }
        }
      } catch (audioErr) {
        console.warn('Não foi possível unir áudio extra:', audioErr.message);
      }
    }

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
      res.status(500).send(`Falha ao baixar o vídeo: ${error.message}`);
    }
  }
});

// --- FUNCIONALIDADE B: DIVISOR AUTO-INTELIGENTE ---

// Detecta pausas de fala usando silencedetect em múltiplos níveis de ruído (funciona mesmo com música de fundo)
async function detectSpeechPauses(filePath) {
  const bin = getFfmpegBinary();
  if (!bin) return [];

  const thresholds = ['-32dB', '-24dB', '-18dB'];
  let allPauses = [];

  for (const noiseLevel of thresholds) {
    const pauses = await new Promise((resolve) => {
      execFile(
        bin,
        ['-hide_banner', '-vn', '-i', filePath, '-af', `silencedetect=noise=${noiseLevel}:d=0.22`, '-f', 'null', '-'],
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

// Calcula onde cortar cada parte e onde começar a próxima de forma inteligente (sem partes obrigatoriamente iguais)
function computeSmartSegments(totalDuration, partsCount, pauses) {
  const segments = [];
  let currentStart = 0;

  for (let i = 1; i < partsCount; i++) {
    const remainingDuration = totalDuration - currentStart;
    const remainingParts = partsCount - i + 1;
    const targetCut = currentStart + remainingDuration / remainingParts;
    const avgPartLen = totalDuration / partsCount;

    // Janela flexível (+/- 35% da duração média) para permitir partes de tamanhos diferentes onde a fala pausa
    const searchRadius = Math.max(4, Math.min(20, avgPartLen * 0.35));
    const minCut = Math.max(currentStart + 3, targetCut - searchRadius);
    const maxCut = Math.min(totalDuration - 3 * (remainingParts - 1), targetCut + searchRadius);

    const candidates = pauses.filter(p => p.mid >= minCut && p.mid <= maxCut);

    let chosenCutEnd = targetCut;
    let nextPartStart = targetCut;
    let cutReason = 'Transição suave com continuidade';

    if (candidates.length > 0) {
      // Escolhe a melhor pausa combinando duração do silêncio e proximidade do alvo
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

      // Termina a parte atual logo após a frase acabar e inicia a próxima exatamente antes da nova frase
      chosenCutEnd = Math.min(totalDuration, bestPause.start + Math.min(bestPause.duration * 0.65, 0.35));
      nextPartStart = Math.max(0, bestPause.end - Math.min(bestPause.duration * 0.35, 0.25));
      cutReason = 'Pausa natural na fala detectada';
    } else {
      // Se for uma cena contínua sem pausa, aplica 0.35s de recapitulação para não cortar sílabas
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

  // Última parte vai até o final do vídeo
  segments.push({
    partNumber: partsCount,
    start: Number(currentStart.toFixed(2)),
    end: Number(totalDuration.toFixed(2)),
    duration: Number((totalDuration - currentStart).toFixed(1)),
    reason: 'Conclusão do vídeo'
  });

  return segments;
}

// Rota 3: Recebe o vídeo da galeria, analisa pausas de fala e gera as partes em MP4 compatível com Android
app.post('/api/smart-split', async (req, res) => {
  cleanupOldTempFiles();

  const partsCount = Math.max(2, Math.min(20, parseInt(req.query.parts, 10) || 2));
  const jobId = `splitjob_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const inputPath = path.join('/tmp', `${jobId}_input.mp4`);

  try {
    // Salva o fluxo do vídeo enviado pelo celular direto em /tmp
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(inputPath);
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ error: 'Arquivo de vídeo inválido ou vazio.' });
    }

    const mediaInfo = await inspectMediaStreams(inputPath);
    const totalDuration = mediaInfo.duration || 60;

    if (totalDuration < 4) {
      return res.status(400).json({ error: 'O vídeo é muito curto para ser dividido.' });
    }

    console.log(`Analisando pausas inteligentes para ${partsCount} partes (Duração total: ${totalDuration}s)...`);
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
        '-crf', '25',
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
        downloadUrl: `/api/split-download/${partFileName}`
      });
    }

    // Remove o arquivo original bruto para economizar espaço, mantendo apenas as partes prontas
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

// Rota 4: Entrega cada parte dividida para download no Android
app.get('/api/split-download/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  if (!fileName.startsWith('splitjob_') || !fileName.endsWith('.mp4')) {
    return res.status(400).send('Arquivo inválido.');
  }

  const filePath = path.join('/tmp', fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Esta parte expirou. Por favor, divida o vídeo novamente.');
  }

  const stat = fs.statSync(filePath);
  const partMatch = fileName.match(/parte_(\d+)\.mp4$/);
  const friendlyName = partMatch ? `CortePro_Parte_${partMatch[1]}.mp4` : `CortePro_${fileName}`;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${friendlyName}"`);

  fs.createReadStream(filePath).pipe(res);
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master rodando na porta ${PORT}`);
});
