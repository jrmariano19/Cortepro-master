module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let targetUrl = req.query.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Link ausente.' });
  }

  const uaMobile = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  const uaDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // PASSO 0: Desencurtar links do tipo facebook.com/share/r/... ou vm.tiktok.com
  try {
    const headRes = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': uaDesktop }
    });
    if (headRes.url && !headRes.url.includes('/login')) {
      targetUrl = headRes.url;
    }
  } catch (e) {}

  // PASSO 1: Extração Nativa do Facebook (Lê o MP4 direto da página do Facebook e do FDown)
  if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.com')) {
    // 1A: Via FDown com URL desencurtada
    try {
      const params = new URLSearchParams();
      params.append('URLz', targetUrl);
      const fbRes = await fetch('https://fdown.net/download.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': uaMobile,
          'Origin': 'https://fdown.net',
          'Referer': 'https://fdown.net/'
        },
        body: params.toString()
      });
      const html = await fbRes.text();
      const hdMatch = html.match(/id="hdlink"[^>]*href="([^"]+)"/i);
      const sdMatch = html.match(/id="sdlink"[^>]*href="([^"]+)"/i);
      const rawUrl = (hdMatch && hdMatch[1]) || (sdMatch && sdMatch[1]);
      if (rawUrl) {
        return res.status(200).json({ success: true, downloadUrl: rawUrl.replace(/&amp;/g, '&') });
      }
    } catch (e) {}

    // 1B: Raspagem direta do código-fonte do Facebook (browser_native_hd_url / playable_url)
    try {
      const pageRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': uaDesktop,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8'
        }
      });
      const pageHtml = await pageRes.text();
      const patterns = [
        /"browser_native_hd_url":"([^"]+)"/,
        /"browser_native_sd_url":"([^"]+)"/,
        /"playable_url_quality_hd":"([^"]+)"/,
        /"playable_url":"([^"]+)"/,
        /"hd_src":"([^"]+)"/,
        /"sd_src":"([^"]+)"/
      ];
      for (const regex of patterns) {
        const match = pageHtml.match(regex);
        if (match && match[1]) {
          const clean = JSON.parse('"' + match[1] + '"').replace(/\\\//g, '/');
          if (clean.startsWith('http')) {
            return res.status(200).json({ success: true, downloadUrl: clean });
          }
        }
      }
    } catch (e) {}
  }

  // PASSO 2: Extrator Direto para TikTok / Douyin
  if (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com')) {
    try {
      const tikRes = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(targetUrl), {
        headers: { 'User-Agent': uaMobile }
      });
      const tikData = await tikRes.json();
      if (tikData && tikData.data && (tikData.data.play || tikData.data.wmplay)) {
        return res.status(200).json({
          success: true,
          downloadUrl: tikData.data.play || tikData.data.wmplay
        });
      }
    } catch (e) {}
  }

  // PASSO 3: Motores Universais (Instagram, YouTube, Kwai, X, Facebook)
  const instances = [
    'https://cobalt-api.kwiatekmiki.com',
    'https://cobalt.api.timelessnesses.me',
    'https://api.cobalt.blackcat.sweeux.org'
  ];

  for (const api of instances) {
    try {
      const r = await fetch(api, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': uaMobile
        },
        body: JSON.stringify({
          url: targetUrl,
          videoQuality: '720',
          filenameStyle: 'classic'
        })
      });
      if (r.ok) {
        const d = await r.json();
        const link = d.url || (d.picker && d.picker[0] && d.picker[0].url);
        if (link) return res.status(200).json({ success: true, downloadUrl: link });
      }
    } catch (e) {}
  }

  return res.status(422).json({
    success: false,
    resolvedUrl: targetUrl,
    error: 'Extração automática bloqueada pela rede.'
  });
};
