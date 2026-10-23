const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const rawUrl = (req.body && req.body.url) || (req.query && req.query.url);
    if (!rawUrl) return res.status(400).json({ success: false, error: 'Nenhum link fornecido.' });

    let targetUrl = rawUrl.trim();
    let videoUrl = null;

    // 1. EXTRAÇÃO DIRETA NATIVA PARA FACEBOOK E INSTAGRAM (Sem APIs externas)
    if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('instagram.com')) {
      try {
        const pageRes = await axios.get(targetUrl, {
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Mode': 'navigate'
          },
          timeout: 8000
        });

        const html = typeof pageRes.data === 'string' ? pageRes.data : JSON.stringify(pageRes.data);

        // Procura streams MP4 diretos no código-fonte da página do Facebook/Instagram
        const regexPatterns = [
          /"browser_native_hd_url":"([^"]+)"/,
          /"browser_native_sd_url":"([^"]+)"/,
          /"playable_url_quality_hd":"([^"]+)"/,
          /"playable_url":"([^"]+)"/,
          /"hd_src":"([^"]+)"/,
          /"sd_src":"([^"]+)"/,
          /"video_url":"([^"]+)"/,
          /<meta property="og:video:secure_url" content="([^"]+)"/i,
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

    // 2. EXTRATOR TIKTOK & DOUYIN (TikWM Oficial)
    if (!videoUrl && (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com'))) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          const rawPlay = tikRes.data.data.hdplay || tikRes.data.data.play;
          if (rawPlay) videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
        }
      } catch (e) {}
    }

    // 3. MOTOR DE RESERVA MULTIMÉDIA (Para YouTube, Kwai ou caso FB/Insta exija fallback)
    if (!videoUrl) {
      const cobaltApis = [
        { url: 'https://co.wuk.sh/api/json', v7: true },
        { url: 'https://cobalt.api.timelessnesses.me/', v7: false }
      ];

      for (const api of cobaltApis) {
        if (videoUrl) break;
        try {
          const payload = api.v7 
            ? { url: targetUrl, vQuality: '720', isNoTTWatermark: true }
            : { url: targetUrl, videoQuality: '720' };

          const cobRes = await axios.post(api.url, payload, {
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

    return res.status(400).json({
      success: false,
      error: 'Não foi possível extrair o vídeo diretamente. Verifique se o vídeo é público.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro interno no servidor: ' + err.message });
  }
};
