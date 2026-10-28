const express = require('express');
const cors = require('cors');
const YTDlpWrapModule = require('yt-dlp-wrap');
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Caminho onde o executável do yt-dlp ficará salvo no Render
const binaryPath = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytDlpWrap = null;
let isBinaryReady = false;

// Baixa e configura o binário do yt-dlp ao iniciar o servidor
async function initYtDlp() {
  try {
    if (!fs.existsSync(binaryPath)) {
      console.log('Baixando binário atualizado do yt-dlp do GitHub...');
      await YTDlpWrap.downloadFromGithub(binaryPath);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, '755');
    }
    ytDlpWrap = new YTDlpWrap(binaryPath);
    isBinaryReady = true;
    console.log('yt-dlp pronto e operacional em:', binaryPath);
  } catch (err) {
    console.error('Erro crítico ao preparar o yt-dlp:', err.message);
  }
}

initYtDlp();

// Validação de segurança para impedir acesso a redes internas (SSRF) e validar protocolo
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

// Rota raiz (Status do servidor)
app.get('/', (req, res) => {
  res.json({
    status: 'CortePro Master Backend operacional',
    binaryReady: isBinaryReady,
    endpoint: '/api/extract?url=LINK_DO_VIDEO',
    downloadEndpoint: '/api/download?url=LINK_DO_VIDEO'
  });
});

// Rota 1: Extrai informações do vídeo e valida se pode ser baixado
app.get('/api/extract', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "Parâmetro 'url' não fornecido." });
  }

  if (!isValidPublicUrl(videoUrl)) {
    return res.status(400).json({ error: 'Link inválido ou não permitido.' });
  }

  if (!isBinaryReady || !ytDlpWrap) {
    return res.status(503).json({
      error: 'O servidor ainda está preparando o extrator. Aguarde 10 segundos e tente novamente.'
    });
  }

  try {
    console.log(`Verificando vídeo: ${videoUrl}`);

    // Executa o yt-dlp de forma limpa e retorna o JSON com os metadados
    const stdout = await ytDlpWrap.execPromise([
      videoUrl,
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass'
    ]);

    const metadata = JSON.parse(stdout);

    // Procura o melhor formato em MP4 que já tenha vídeo e áudio juntos
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

    // Link seguro passando pelo nosso próprio servidor para forçar o download no Android
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

// Rota 2: Faz o download real do arquivo MP4 e entrega direto para a galeria/downloads do celular
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl || !isValidPublicUrl(videoUrl)) {
    return res.status(400).send('URL inválida ou ausente.');
  }

  if (!isBinaryReady || !ytDlpWrap) {
    return res.status(503).send('Extrator iniciando. Tente novamente em instantes.');
  }

  const tempId = `video_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`;
  const tempFilePath = path.join('/tmp', tempId);

  try {
    console.log(`Baixando arquivo para envio: ${videoUrl}`);

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
      return res.status(422).send('Não foi possível gerar o arquivo de vídeo para download.');
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="cortepro_${Date.now()}.mp4"`);

    const readStream = fs.createReadStream(tempFilePath);
    readStream.pipe(res);

    // Apaga o arquivo temporário do servidor assim que o envio terminar ou se a conexão cair
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
      res.status(500).send('Falha ao baixar o arquivo de vídeo. O vídeo pode exigir login ou exceder o limite.');
    }
  }
});

app.listen(PORT, () => {
  console.log(`Servidor CortePro Master rodando na porta ${PORT}`);
});
