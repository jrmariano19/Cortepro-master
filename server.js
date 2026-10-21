const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Função auxiliar para limpar URLs escapadas no HTML do Facebook/Instagram
function limparUrlEscapada(str) {
  if (!str) return null;
  return str
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

// 1. ROTA DE STATUS
app.get('/', (req, res) => {
  res.send('CortePro Backend 3.1 Ativo e Operacional!');
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
    // CASO 1: TIKTOK (Usa API dedicada c/ Áudio)
    // ==========================================
    if (targetUrl.includes('tiktok.com')) {
      const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`);
      if (tikRes.data && tikRes.data.data && tikRes.data.data.play) {
        videoUrl = tikRes.data.data.play;
      }
    }

    // ==========================================
    // CASO 2: FACEBOOK (Links /share/r/, /reel/, watch)
    // ==========================================
    if (!videoUrl && (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.com'))) {
      // Passo A: Resolver o redirecionamento /share/r/ fingindo ser o crawler oficial
      const fbResponse = await axios.get(targetUrl, {
        maxRedirects: 10,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });

      const html = fbResponse.data;

      // Procura nas meta tags og:video (entregues diretamente ao facebookexternalhit)
      const ogMatch =
        html.match(/property="og:video:secure_url"\s+content="([^"]+)"/i) ||
        html.match(/property="og:video"\s+content="([^"]+)"/i) ||
        html.match(/content="([^"]+)"\s+property="og:video:secure_url"/i) ||
        html.match(/content="([^"]+)"\s+property="og:video"/i);

      if (ogMatch && ogMatch[1]) {
        videoUrl = limparUrlEscapada(ogMatch[1]);
      }

      // Passo B: Se não veio na meta tag, busca no JSON interno da página com User-Agent Mobile
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
          mobileHtml.match(/sd_src\s*:\s*"([^"]+)"/) ||
          mobileHtml.match(/hd_src\s*:\s*"([^"]+)"/);

        if (jsonMatch && jsonMatch[1]) {
          videoUrl = limparUrlEscapada(jsonMatch[1]);
        }
      }
    }

    // ==========================================
    // CASO 3: KWAI & INSTAGRAM (ou Fallback Geral)
    // ==========================================
    if (!videoUrl) {
      const genRes = await axios.get(targetUrl, {
        maxRedirects: 10,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
        }
      });

      const html = genRes.data;
      const match =
        html.match(/property="og:video:secure_url"\s+content="([^"]+)"/i) ||
        html.match(/property="og:video"\s+content="([^"]+)"/i) ||
        html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i) ||
        html.match(/"video_url"\s*:\s*"([^"]+)"/i);

      if (match && match[1]) {
        videoUrl = limparUrlEscapada(match[1]);
      }
    }

    // Se encontrou o vídeo com sucesso:
    if (videoUrl) {
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const proxyDownloadUrl = `${hostUrl}/proxy-download?url=${encodeURIComponent(videoUrl)}`;

      return res.json({
        success: true,
        videoUrl: videoUrl,
        downloadUrl: proxyDownloadUrl,
        url: proxyDownloadUrl // Mantém compatibilidade com qualquer variável no teu index.html
      });
    }

    return res.status(404).json({
      success: false,
      error: 'Não foi possível extrair o vídeo com áudio deste link. Verifique se é público.'
    });

  } catch (error) {
    console.error('Erro na extração:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao processar o link no servidor.'
    });
  }
}

// Aceita tanto /extrair como /api/extrair ou /download (para não quebrar teu index.html atual)
app.post('/extrair', processarExtracao);
app.get('/extrair', processarExtracao);
app.post('/api/extrair', processarExtracao);
app.post('/download', processarExtracao);

// 3. ROTA DE PROXY PARA BAIXAR DIRETO NO TELEMÓVEL (Sem erro de CORS)
app.get('/proxy-download', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('URL do vídeo ausente.');

  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

app.listen(PORT, () => {
  console.log(`Servidor CortePro rodando na porta ${PORT}`);
});
