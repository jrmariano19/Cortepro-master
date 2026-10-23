const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Função auxiliar para limpar URLs escapadas
function limparUrlEscapada(str) {
  if (!str) return null;
  return str
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\\/g, '/')
    .replace(/&amp;/g, '&');
}

// ROTA DE STATUS
app.get('/', (req, res) => {
  res.send('CortePro Backend 3.3 Ativo e Operacional!');
});

// ROTA PRINCIPAL DE EXTRAÇÃO
async function processarExtracao(req, res) {
  const rawUrl = req.body.url || req.query.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });
  }

  let targetUrl = rawUrl.trim();
  let videoUrl = null;

  try {
    // ==========================================
    // 1. TIKTOK (Via TikWM - Altamente fiável)
    // ==========================================
    if (targetUrl.includes('tiktok.com')) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          let rawPlay = tikRes.data.data.play || tikRes.data.data.hdplay;
          if (rawPlay) {
            videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
          }
        }
      } catch (e) {
        console.error('Erro TikTok:', e.message);
      }
    }

    // ==========================================
    // 2. YOUTUBE, INSTAGRAM, FACEBOOK, KWAI (Via API Pura e Scraping Direto)
    // ==========================================
    if (!videoUrl) {
      try {
        // Tenta extração via serviço público de suporte multiplataforma
        const altRes = await axios.post('https://api.cobalt.tools/api/json', {
          url: targetUrl,
          vQuality: '1080',
          isNoTTWatermark: true
        }, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          timeout: 10000
        });

        if (altRes.data && altRes.data.url) {
          videoUrl = altRes.data.url;
        }
      } catch (e) {
        console.error('Aviso API Alternativa:', e.message);
      }
    }

    // Se ainda não encontrou, tenta raspagem de metatags genéricas (og:video)
    if (!videoUrl) {
      try {
        const genRes = await axios.get(targetUrl, {
          maxRedirects: 5,
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
          }
        });
        const html = genRes.data;
        const match =
          html.match(/property="og:video:secure_url"\s+content="([^"]+)"/i) ||
          html.match(/property="og:video"\s+content="([^"]+)"/i) ||
          html.match(/"video_url"\s*:\s*"([^"]+)"/i);

        if (match && match[1]) {
          videoUrl = limparUrlEscapada(match[1]);
        }
      } catch (e) {
        console.error('Erro Raspagem HTML:', e.message);
      }
    }

    // Resposta final
    if (videoUrl) {
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const proxyDownloadUrl = `${hostUrl}/proxy-download?url=${encodeURIComponent(videoUrl)}`;

      return res.json({
        success: true,
        videoUrl: videoUrl,
        downloadUrl: proxyDownloadUrl,
        url: proxyDownloadUrl
      });
    }

    return res.status(400).json({
      success: false,
      error: 'Não foi possível extrair o vídeo limpo deste link. Certifique-se de que a publicação é pública.'
    });

  } catch (error) {
    console.error('Erro geral no servidor:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao processar o link no servidor.'
    });
  }
}

app.post('/extrair', processarExtracao);
app.get('/extrair', processarExtracao);
app.post('/api/extrair', processarExtracao);
app.post('/download', processarExtracao);

// ROTA DE PROXY PARA DESCARREGAR SEM ERRO DE CORS
app.get('/proxy-download', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('URL do vídeo ausente.');

  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.google.com/'
      },
      timeout: 15000
    });

    res.setHeader('Content-Disposition', 'attachment; filename="cortepro-video.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    response.data.pipe(res);
  } catch (err) {
    console.error('Erro no proxy de download:', err.message);
    res.status(500).send('Erro ao descarregar o ficheiro de vídeo.');
  }
});

if (process.env.NODE_ENV !== 'production' || process.env.RENDER) {
  app.listen(PORT, () => {
    console.log(`Servidor CortePro rodando na porta ${PORT}`);
  });
}

module.exports = app;
