const express = require('express');
const cors = require('cors');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');
const stream = require('stream');
const { Transform } = stream;
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 180 * 1024 * 1024;
const TEMP_DIR = os.tmpdir();
const VERSION = '5.1';

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
        return reject(new Error('Falha no download. HTTP ' + status + '.'));
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

function resolveShareUrl(rawUrl, hopsLeft = 5) {
  return new Promise(resolve => {
    if (hopsLeft <= 0) return resolve(rawUrl);

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return resolve(rawUrl);
    }

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
