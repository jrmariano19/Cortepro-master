const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Rota principal para o link abrir limpo
app.get('/', (req, res) => {
  res.status(200).send('CortePro Backend Ativo e Operacional!');
});

// Rota de extração
async function processarExtracao(req, res) {
  const rawUrl = req.body.url || req.query.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });
  }

  let targetUrl = rawUrl.trim();
  let videoUrl = null;

  try {
    if (targetUrl.includes('tiktok.com')) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          let rawPlay = tikRes.data.data.play || tikRes.data.data.hdplay;
          if (rawPlay) {
            videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
          }
        }
      } catch (e) {}
    }

    if (!videoUrl) {
      try {
        const altRes = await axios.post('https://api.cobalt.tools/api/json', {
          url: targetUrl,
          vQuality: '1080',
          isNoTTWatermark: true
        }, {
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          timeout: 10000
        });
        if (altRes.data && altRes.data.url) {
          videoUrl = altRes.data.url;
        }
      } catch (e) {}
    }

    if (videoUrl) {
      return res.json({ success: true, videoUrl: videoUrl, downloadUrl: videoUrl, url: videoUrl });
    }

    return res.status(400).json({ success: false, error: 'Não foi possível extrair o vídeo limpo.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Erro interno ao processar o link.' });
  }
}

app.post('/extrair', processarExtracao);
app.get('/extrair', processarExtracao);

// Exportação obrigatória para a Vercel (sem app.listen)
module.exports = app;
