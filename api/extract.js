const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Erro ao ler resposta.')); }
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'URL não fornecida.' });
  }

  try {
    const apiUrl = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(videoUrl) + '&hd=1';
    const json = await fetchJson(apiUrl);

    if (!json || json.code !== 0 || !json.data) {
      throw new Error('Não foi possível extrair o vídeo desta plataforma.');
    }

    const downloadUrl = json.data.play || json.data.hdplay || json.data.wmplay;

    return res.json({
      success: true,
      title: json.data.title || 'Vídeo processado',
      downloadUrl: downloadUrl
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Erro no processamento.' });
  }
};
