const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Função auxiliar para limpar URLs escapadas no HTML do Facebook/Instagram/Kwai
function limparUrlEscapada(str) {
  if (!str) return null;
  return str
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\\/g, '/')
    .replace(/&amp;/g, '&');
}

// Função auxiliar para extração limpa via API unificada (YouTube, Kwai, Instagram, Facebook, TikTok)
async function extrairViaCobalt(url) {
  const endpoints = [
    'https://api.cobalt.tools/api/json',
    'https://cobalt-api.kwiatekmiki.com/api/json'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.post(
        endpoint,
        {
          url: url,
          vQuality: '1080',
          filenamePattern: 'basic',
          isNoTTWatermark: true,
          tiktokFullAudio: true
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          timeout: 8000
        }
      );

      if (res.data && res.data.url) {
        return res.data.url;
      }
    } catch (e) {
      // Tenta o próximo endpoint silenciosamente
    }
  }
  return null;
}

// 1. ROTA DE STATUS
app.get('/', (req, res) => {
  res.send('CortePro Backend 3.2 Ativo e Operacional!');
});

// 2. ROTA PRINCIPAL DE EXTRAÇÃO (/extrair ou /api/extrair)
async function processarExtracao(req, res) {
  const rawUrl = req.body.url || req.query.url;
  if (!rawUrl) {
    return res.status(400).json({ error: 'Nenhum link fornecido.' });
  }

  try {
    let targetUrl = rawUrl.trim();
    let videoUrl = null;

    // ==========================================
    // CASO 1: TIKTOK (Sem marca d'água em HD)
    // ==========================================
    if (targetUrl.includes('tiktok.com')) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`);
        if (tikRes.data && tikRes.data.data) {
          let rawPlay = tikRes.data.data.play || tikRes.data.data.hdplay;
          if (rawPlay) {
            videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
          }
        }
      } catch (e) {
        console.error('Aviso TikTok API:', e.message);
      }
    }

    // ==========================================
    // CASO 2: YOUTUBE (Shorts e Vídeos Longos)
    // ==========================================
    if (!videoUrl && (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be'))) {
      videoUrl = await extrairViaCobalt(targetUrl);
    }

    // ==========================================
    // CASO 3: KWAI (Extração da stream original sem logo)
    // ==========================================
    if (!videoUrl && (targetUrl.includes('kwai.com') || targetUrl.includes('kw.ai'))) {
      videoUrl = await extrairViaCobalt(targetUrl);

      if (!videoUrl) {
        try {
          const kwaiRes = await axios.get(targetUrl, {
            maxRedirects: 10,
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            }
          });
          const kwaiHtml = kwaiRes.data;
          const cleanKwaiMatch =
            kwaiHtml.match(/"mainMvUrls"\\s*:\\s*\[\\s*\{\\s*[^}]*"url"\\s*:\\s*"([^"]+)"/i) ||
            kwaiHtml.match(/"playUrl"\\s*:\\s*"([^"]+)"/i) ||
            kwaiHtml.match(/"contentUrl"\\s*:\\s*"([^"]+\.mp4[^"]*)"/i);

          if (cleanKwaiMatch && cleanKwaiMatch[1]) {
            videoUrl = limparUrlEscapada(cleanKwaiMatch[1]);
          }
        } catch (e) {
          console.error('Aviso Kwai HTML:', e.message);
        }
      }
    }

    // ==========================================
    // CASO 4: FACEBOOK (Links /share/r/, /reel/, watch)
    // ==========================================
    if (!videoUrl && (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.com'))) {
      try {
        const fbResponse = await axios.get(targetUrl, {
          maxRedirects: 10,
          headers: {
            'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });

        const html = fbResponse.data;

        const ogMatch =
          html.match(/property="og:video:secure_url"\\s+content="([^"]+)"/i) ||
          html.match(/property="og:video"\\s+content="([^"]+)"/i) ||
          html.match(/content="([^"]+)"\\s+property="og:video:secure_url"/i) ||
          html.match(/content="([^"]+)"\\s+property="og:video"/i);

        if (ogMatch && ogMatch[1]) {
          videoUrl = limparUrlEscapada(ogMatch[1]);
        }

        if (!videoUrl) {
          const finalUrl = fbResponse.request?.res?.responseUrl || targetUrl;
          const mobileRes = await axios.get(finalUrl, {
            maxRedirects: 10,
            headers: {
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
          });

          const mobileHtml = mobileRes.data;
          const jsonMatch =
            mobileHtml.match(/"playable_url_quality_hd":"([^"]+)"/) ||
            mobileHtml.match(/"playable_url":"([^"]+)"/) ||
            mobileHtml.match(/"browser_native_hd_url":"([^"]+)"/) ||
            mobileHtml.match(/"browser_native_sd_url":"([^"]+)"/) ||
            mobileHtml.match(/hd_src\\s*:\\s*"([^"]+)"/) ||
            mobileHtml.match(/sd_src\\s*:\\s*"([^"]+)"/);

          if (jsonMatch && jsonMatch[1]) {
            videoUrl = limparUrlEscapada(jsonMatch[1]);
          }
        }
      } catch (e) {
        console.error('Aviso Facebook:', e.message);
      }
    }

    // ==========================================
    // CASO 5: INSTAGRAM & FALLBACK GERAL
    // ==========================================
    if (!videoUrl) {
      videoUrl = await extrairViaCobalt(targetUrl);

      if (!videoUrl) {
        try {
          const genRes = await axios.get(targetUrl, {
            maxRedirects: 10,
            headers: {
              'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
            }
          });

          const html = genRes.data;
          const match =
            html.match(/"video_versions"\\s*:\\s*\[\\s*\{\\s*[^}]*"url"\\s*:\\s*"([^"]+)"/i) ||
            html.match(/"video_url"\\s*:\\s*"([^"]+)"/i) ||
            html.match(/"contentUrl"\\s*:\\s*"([^"]+\.mp4[^"]*)"/i) ||
            html.match(/property="og:video:secure_url"\\s+content="([^"]+)"/i) ||
            html.match(/property="og:video"\\s+content="([^"]+)"/i);

          if (match && match[1]) {
            videoUrl = limparUrlEscapada(match[1]);
          }
        } catch (e) {
          console.error('Aviso Fallback Geral:', e.message);
        }
      }
    }

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

    return res.status(404).json({
      success: false,
      error: 'Não foi possível extrair o vídeo limpo deste link. Verifique se é público.'
    });

  } catch (error) {
    console.error('Erro na extração:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao processar o link no servidor.'
    });
  }
}

app.post('/extrair', processarExtracao);
app.get('/extrair', processarExtracao);
app.post('/api/extrair', processarExtracao);
app.post('/download', processarExtracao);

app.get('/proxy-download', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('URL do vídeo ausente.');

  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.google.com/'
      }
    });

    res.setHeader('Content-Disposition', 'attachment; filename="cortepro-video.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    response.data.pipe(res);
  } catch (err) {
    console.error('Erro no proxy de download:', err.message);
    res.status(500).send('Erro ao baixar o ficheiro de vídeo.');
  }
});

if (process.env.NODE_ENV !== 'production' || process.env.RENDER) {
  app.listen(PORT, () => {
    console.log(`Servidor CortePro rodando na porta ${PORT}`);
  });
}

module.exports = app;
