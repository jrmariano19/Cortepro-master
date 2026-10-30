export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const targetUrl = req.query.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Link ausente.' });
  }

  const ua = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

  // 1. Extrator Direto para Facebook (Extrai o MP4 direto do FDown em background!)
  if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.com')) {
    try {
      const params = new URLSearchParams();
      params.append('URLz', targetUrl);
      const fbRes = await fetch('https://fdown.net/download.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ua,
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
        const cleanUrl = rawUrl.replace(/&amp;/g, '&');
        return res.status(200).json({ success: true, downloadUrl: cleanUrl });
      }
    } catch (e) {}
  }

  // 2. Extrator Direto para TikTok / Douyin
  if (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com')) {
    try {
      const tikRes = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(targetUrl), {
        headers: { 'User-Agent': ua }
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

  // 3. Cascata de Motores Universais (Instagram, YouTube, Kwai, X, Facebook)
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
          'User-Agent': ua
        },
        body: JSON.stringify({
          url: targetUrl,
          videoQuality: '720',
          filenameStyle: 'classic',
          downloadMode: 'auto'
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
    error: 'Extração direta indisponível para este link.'
  });
}
