const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const rawUrl = (req.body && req.body.url) || (req.query && req.query.url);
    if (!rawUrl) {
      return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });
    }

    let targetUrl = rawUrl.trim();
    let videoUrl = null;

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

    // 2. Universal (Facebook, Instagram, YouTube, Kwai) via Cobalt API
    if (!videoUrl) {
      const apis = ['https://api.cobalt.tools/api/json', 'https://co.wuk.sh/api/json'];
      for (const api of apis) {
        if (videoUrl) break;
        try {
          const cobRes = await axios.post(api, {
            url: targetUrl,
            vQuality: '720',
            isNoTTWatermark: true
          }, {
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
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
};
