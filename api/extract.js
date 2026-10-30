import https from 'https';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Link inválido ou ausente.' });
  }

  try {
    const fetchVideoMeta = (targetUrl) => {
      return new Promise((resolve, reject) => {
        const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`;
        https.get(api, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json && json.code === 0 && json.data && json.data.play) {
                resolve(json.data.play);
              } else {
                reject(new Error('Não foi possível extrair o vídeo direto.'));
              }
            } catch (e) {
              reject(new Error('Erro ao interpretar resposta da mídia.'));
            }
          });
        }).on('error', err => reject(err));
      });
    };

    const videoUrl = await fetchVideoMeta(url);
    return res.status(200).json({ success: true, downloadUrl: videoUrl });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Falha ao processar o vídeo.' });
  }
}
