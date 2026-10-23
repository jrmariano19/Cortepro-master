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

    // Descodificar e extrair o link real de partilha do Facebook (/share/r/ ou /share/v/)
    if (targetUrl.includes('facebook.com/share/')) {
      try {
        const fbRes = await axios.get(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
          },
          timeout: 8000
        });
        const html = fbRes.data || '';
        
        // Procura o link canónico de Reel ou Watch dentro do HTML do Facebook
        const matchReel = html.match(/https:\/\/(?:www\.)?facebook\.com\/(?:reel|watch)\/\d+/);
        if (matchReel) {
          targetUrl = matchReel[0];
        } else {
          // Procura og:url alternativa
          const matchOgUrl = html.match(/<meta property="og:url" content="([^"]+)"/);
          if (matchOgUrl && matchOgUrl[1] && !matchOgUrl[1].includes('/share/')) {
            targetUrl = matchOgUrl[1].replace(/&amp;/g, '&');
          }
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

    // 2. Universal (Facebook Reels, Instagram, YouTube, Kwai) via Cobalt API
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

    return res.status(400).json({ success: false, error: 'Não foi possível extrair o vídeo. Certifique-se de que o vídeo do Facebook é público.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro interno no servidor.' });
  }
};
