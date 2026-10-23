const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Rota de Extração (Responde SEMPRE em JSON)
app.all('/extrair', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const rawUrl = (req.body && req.body.url) || (req.query && req.query.url);
    if (!rawUrl) {
      return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });
    }

    const targetUrl = rawUrl.trim();
    let videoUrl = null;

    // Motor 1: TikTok (TikWM)
    if (targetUrl.includes('tiktok.com')) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          const rawPlay = tikRes.data.data.hdplay || tikRes.data.data.play;
          if (rawPlay) {
            videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
          }
        }
      } catch (e) {}
    }

    // Motor 2: Universal (Facebook, Instagram, YouTube, Kwai, TikTok) via Cobalt
    if (!videoUrl) {
      const cobaltInstances = [
        'https://api.cobalt.tools/api/json',
        'https://co.wuk.sh/api/json'
      ];

      for (const api of cobaltInstances) {
        if (videoUrl) break;
        try {
          const cobRes = await axios.post(api, {
            url: targetUrl,
            vQuality: '720',
            isNoTTWatermark: true
          }, {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 8000
          });
          if (cobRes.data && cobRes.data.url) {
            videoUrl = cobRes.data.url;
          }
        } catch (e) {}
      }
    }

    if (videoUrl) {
      return res.status(200).json({
        success: true,
        videoUrl: videoUrl,
        downloadUrl: videoUrl
      });
    }

    return res.status(400).json({
      success: false,
      error: 'Não foi possível extrair este vídeo no momento. Verifique se o vídeo é público.'
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Erro interno no servidor: ' + (err.message || 'Falha desconhecida')
    });
  }
});

// 2. Rota Principal (Entrega o index.html sem dar erro 404)
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(fs.readFileSync(indexPath, 'utf8'));
  }
  return res.status(200).send('CortePro Backend Ativo e Operacional!');
});

module.exports = app;
