module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let targetUrl = req.query.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Link ausente.' });
  }

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  // Desencurtador geral
  try {
    const headRes = await fetch(targetUrl, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': ua } });
    if (headRes.url && !headRes.url.includes('/login')) {
      targetUrl = headRes.url;
    }
  } catch (e) {}

  // 1. TIKTOK / DOUYIN
  if (targetUrl.includes('tiktok.com') || targetUrl.includes('douyin.com') || targetUrl.includes('v.douyin.com')) {
    try {
      const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(targetUrl), { headers: { 'User-Agent': ua } });
      const d = await r.json();
      if (d && d.data && (d.data.play || d.data.wmplay)) {
        return res.status(200).json({ success: true, downloadUrl: d.data.play || d.data.wmplay });
      }
    } catch (e) {}
  }

  // 2. FACEBOOK
  if (targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.com')) {
    try {
      const params = new URLSearchParams();
      params.append('URLz', targetUrl);
      const fbRes = await fetch('https://fdown.net/download.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ua, 'Origin': 'https://fdown.net', 'Referer': 'https://fdown.net/' },
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
  }

  // 3. INSTAGRAM (Reels / Posts)
  if (targetUrl.includes('instagram.com')) {
    try {
      const igRes = await fetch('https://snapinsta.app/action.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ua, 'Origin': 'https://snapinsta.app', 'Referer': 'https://snapinsta.app/' },
        body: new URLSearchParams({ url: targetUrl, action: 'post' }).toString()
      });
      const html = await igRes.text();
      const match = html.match(/href="([^"]+)"[^>]*class="btn[^"]*download/i) || html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
      if (match && match[1]) {
        return res.status(200).json({ success: true, downloadUrl: match[1].replace(/&amp;/g, '&') });
      }
    } catch (e) {}
  }

  // 4. KWAI
  if (targetUrl.includes('kwai.com') || targetUrl.includes('k.kwai.com')) {
    try {
      const kwaiRes = await fetch('https://getvideo.mobi/api/v2/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ url: targetUrl })
      });
      const kd = await kwaiRes.json();
      if (kd && kd.url) {
        return res.status(200).json({ success: true, downloadUrl: kd.url });
      }
    } catch (e) {}
  }

  // 5. YOUTUBE / SHORTS / INSTAGRAM / OUTROS (Motores Cobalt atualizados)
  const instances = [
    'https://co.wuk.sh/api/json',
    'https://cobalt.api.timelessnesses.me',
    'https://api.cobalt.blackcat.sweeux.org'
  ];

  for (const api of instances) {
    try {
      const r = await fetch(api, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify({ url: targetUrl, videoQuality: '720', filenameStyle: 'classic' })
      });
      if (r.ok) {
        const d = await r.json();
        const link = d.url || (d.picker && d.picker[0] && d.picker[0].url);
        if (link) return res.status(200).json({ success: true, downloadUrl: link });
      }
    } catch (e) {}
  }

  return res.status(422).json({ success: false, error: 'Não foi possível extrair o vídeo desta rede social.' });
};
