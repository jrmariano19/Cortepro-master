const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rawUrl = body.url || (req.query && req.query.url);
    if (!rawUrl) return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });

    let targetUrl = rawUrl.trim();
    let videoUrl = null;

    // 1. EXTRAÇÃO FACEBOOK E INSTAGRAM (Emulando Crawler para saltar bloqueio de /share/r/)
    if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('instagram.com')) {
      const userAgents = [
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ];

      for (const ua of userAgents) {
        if (videoUrl) break;
        try {
          const pageRes = await axios.get(targetUrl, {
            maxRedirects: 10,
            headers: {
              'User-Agent': ua,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8'
            },
            timeout: 8000
          });

          const html = typeof pageRes.data === 'string' ? pageRes.data : JSON.stringify(pageRes.data);

          const regexPatterns = [
            /"browser_native_hd_url":"([^"]+)"/,
            /"browser_native_sd_url":"([^"]+)"/,
            /"playable_url_quality_hd":"([^"]+)"/,
            /"playable_url":"([^"]+)"/,
            /"hd_src":"([^"]+)"/,
            /"sd_src":"([^"]+)"/,
            /"video_url":"([^"]+)"/,
            /<meta property="og:video:secure_url" content="([^"]+)"/i,
            /<meta property="og:video:url" content="([^"]+)"/i,
            /<meta property="og:video" content="([^"]+)"/i
          ];

          for (const regex of regexPatterns) {
            const match = html.match(regex);
            if (match && match[1]) {
              let cleanUrl = match[1]
                .replace(/\\u0025/g, '%')
                .replace(/\\u0026/g, '&')
                .replace(/\\\//g, '/')
                .replace(/&amp;/g, '&');
              if (cleanUrl.startsWith('http')) {
                videoUrl = cleanUrl;
                break;
              }
            }
          }
        } catch (e) {}
      }
    }

    // 2. EXTRATOR TIKTOK & DOUYIN
    if (!videoUrl && (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com'))) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          const rawPlay = tikRes.data.data.hdplay || tikRes.data.data.play;
          if (rawPlay) videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
        }
      } catch (e) {}
    }

    if (videoUrl) {
      return res.status(200).json({ success: true, videoUrl: videoUrl, downloadUrl: videoUrl });
    }

    return res.status(400).json({
      success: false,
      error: 'Não foi possível extrair o vídeo diretamente. Verifique se o vídeo é público.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro interno: ' + err.message });
  }
};
