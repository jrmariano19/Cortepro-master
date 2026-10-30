export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Método não permitido.' });

  const target = req.query?.url;
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ success: false, error: 'Informe um link válido.' });
  }
  let parsed;
  try {
    parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ success: false, error: 'O endereço informado não é válido.' });
  }

  try {
    // Integração opcional com uma instância Cobalt configurada pelo proprietário.
    // Configure COBALT_API_URL e, se exigido pela instância, COBALT_API_KEY na Vercel.
    const cobaltBase = process.env.COBALT_API_URL;
    if (cobaltBase) {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (process.env.COBALT_API_KEY) headers.Authorization = 'Api-Key ' + process.env.COBALT_API_KEY;
      const cobalt = await fetch(cobaltBase.replace(/\/+$/, '') + '/', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: parsed.href, downloadMode: 'auto', filenameStyle: 'basic' })
      });
      const result = await cobalt.json().catch(() => ({}));
      if (cobalt.ok && result.status === 'tunnel' && result.url) {
        return res.status(200).json({ success: true, downloadUrl: result.url, source: 'cobalt' });
      }
      if (cobalt.ok && result.status === 'redirect' && result.url) {
        return res.status(200).json({ success: true, downloadUrl: result.url, source: 'cobalt' });
      }
      const reason = result.error?.code || result.text || 'O serviço de extração não aceitou este link.';
      return res.status(502).json({ success: false, error: String(reason) });
    }

    // Fallback legado: TikWM é voltado ao TikTok, não a todas as redes sociais.
    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname) && !/(^|\.)vm\.tiktok\.com$/i.test(parsed.hostname) && !/(^|\.)vt\.tiktok\.com$/i.test(parsed.hostname)) {
      return res.status(501).json({
        success: false,
        error: 'Este link precisa de um extrator de plataforma configurado. Para ampliar o suporte a Instagram, Facebook e outras redes, configure uma instância Cobalt em COBALT_API_URL na Vercel.'
      });
    }
    const response = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(parsed.href), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error('O serviço TikWM está indisponível no momento.');
    const data = await response.json();
    if (data?.code !== 0 || !data?.data?.play) {
      return res.status(502).json({ success: false, error: 'O TikTok não disponibilizou este vídeo. Verifique se o link é público.' });
    }
    return res.status(200).json({ success: true, downloadUrl: data.data.play, source: 'tikwm' });
  } catch (error) {
    return res.status(502).json({ success: false, error: error.message || 'Falha ao extrair o vídeo.' });
  }
}