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

    // 1. RESOLVEDOR UNIVERSAL DE LINKS CURTOS (Funciona para FB, Insta, YT, TikTok)
    try {
      const expandRes = await axios.get(targetUrl, {
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 6000
      });
      
      // Captura o link final se houve redirecionamento HTTP nativo
      if (expandRes.request && expandRes.request.res && expandRes.request.res.responseUrl) {
        targetUrl = expandRes.request.res.responseUrl;
      }
      
      // Procura a URL canónica universal em qualquer página HTML
      const html = expandRes.data || '';
      const matchOg = html.match(/<meta property="og:url" content="([^"]+)"/i);
      if (matchOg && matchOg[1] && matchOg[1].startsWith('http') && !matchOg[1].includes('/share/')) {
        targetUrl = matchOg[1].replace(/&amp;/g, '&');
      }
    } catch (e) {
      // Ignora falhas de expansão e continua com o link original
    }

    // 2. EXTRATOR TIKTOK (Rápido e sem marca d'água)
    if (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com')) {
      try {
        const tikRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, { timeout: 8000 });
        if (tikRes.data && tikRes.data.data) {
          const rawPlay = tikRes.data.data.hdplay || tikRes.data.data.play;
          if (rawPlay) videoUrl = rawPlay.startsWith('http') ? rawPlay : `https://www.tikwm.com${rawPlay}`;
        }
      } catch (e) {}
    }

    // 3. EXTRATOR UNIVERSAL (Instagram, Kwai, Facebook, YouTube, X/Twitter)
    if (!videoUrl) {
      // Lista de Servidores Cobalt Públicos (Redundância automática)
      const cobaltInstances = [
        'https://api.cobalt.tools/api/json',
        'https://co.wuk.sh/api/json',
        'https://cobalt-api.kwiatekit.com/api/json',
        'https://cobalt.cattube.org/api/json'
      ];

      for (const api of cobaltInstances) {
        if (videoUrl) break; // Se já encontrou, para de tentar
        
        try {
          const cobRes = await axios.post(api, {
            url: targetUrl,
            vQuality: '720', // Tenta sempre em 720p ou superior
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
    
    return res.status(400).json({ success: false, error: 'Não foi possível extrair o vídeo. Verifique se a conta não é privada ou restrita.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro interno no servidor.' });
  }
};
