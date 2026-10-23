const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

app.all('/extrair', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const rawUrl = (req.body && req.body.url) || (req.query && req.query.url);
    if (!rawUrl) {
      return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });
    }

    let targetUrl = rawUrl.trim();
    let videoUrl = null;

    // Resolver links encurtados do Facebook (/share/v/ ou /share/r/)
    if (targetUrl.includes('facebook.com/share/')) {
      try {
        const fbRedirectRes = await axios.get(targetUrl, {
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
          },
          timeout: 8000
        });
        if (fbRedirectRes.request && fbRedirectRes.request.res && fbRedirectRes.request.res.responseUrl) {
          targetUrl = fbRedirectRes.request.res.responseUrl;
        } else if (fbRedirectRes.config && fbRedirectRes.config.url) {
          targetUrl = fbRedirectRes.config.url;
        }
      } catch (e) {}
    }

    // 1. TikTok via TikWM
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

    // 2. Universal (Facebook, Instagram, YouTube, Kwai, TikTok) via Cobalt API
    if (!videoUrl) {
      const cobaltApis = [
        'https://api.cobalt.tools/api/json',
        'https://co.wuk.sh/api/json'
      ];

      for (const api of cobaltApis) {
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
      return res.status(200).json({ success: true, videoUrl: videoUrl, downloadUrl: videoUrl });
    }

    return res.status(400).json({ success: false, error: 'Não foi possível extrair o vídeo. Verifique se o vídeo é público.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro interno no servidor.' });
  }
});

module.exports = app;
