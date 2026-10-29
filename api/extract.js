const https = require('https');
const http = require('http');

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...headers
      },
      timeout: 12000
    }, res => {
      let data = '';
      res.on('data', chunk => { if (data.length < 200000) data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Erro ao processar JSON da API.')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo limite excedido na requisição.')); });
    req.on('error', reject);
  });
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => { if (data.length < 200000) data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ao aceder à página.')); });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'Por favor, informe o link do vídeo.' });
  }

  try {
    let downloadUrl = null;
    let title = 'Vídeo descarregado';

    // 1. TikTok
    if (/tiktok\.com/i.test(videoUrl)) {
      const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(videoUrl) + '&hd=1';
      const json = await fetchJson(api);
      if (json && json.code === 0 && json.data) {
        downloadUrl = json.data.hdplay || json.data.play;
        title = json.data.title || 'TikTok Video';
      }
    }

    // 2. YouTube (Shorts e Vídeos normais)
    else if (/youtube\.com|youtu\.be/i.test(videoUrl)) {
      // Utiliza API pública de conversão rápida para YouTube compatível com Vercel
      const api = 'https://co.wuk.sh/api/json';
      const postData = JSON.stringify({ url: videoUrl, isAudioOnly: false, quality: '720' });
      
      downloadUrl = await new Promise((resolve, reject) => {
        const req = https.request('https://co.wuk.sh/api/json', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          timeout: 12000
        }, response => {
          let body = '';
          response.on('data', c => body += c);
          response.on('end', () => {
            try {
              const resJson = JSON.parse(body);
              resolve(resJson.url || resJson.picker?.[0]?.url);
            } catch (e) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(postData);
        req.end();
      });
    }

    // 3. Instagram, Facebook e Kwai (Extração via Metatags OpenGraph)
    if (!downloadUrl) {
      const html = await fetchHtml(videoUrl);
      const match = 
        html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i) ||
        html.match(/content=["']([^"']+)["']\s+property=["']og:video["']/i) ||
        html.match(/property=["']og:video:secure_url["']\s+content=["']([^"']+)["']/i) ||
        html.match(/itemprop=["']contentUrl["']\s+content=["']([^"']+)["']/i);

      if (match && match[1]) {
        downloadUrl = match[1].replace(/&amp;/g, '&');
      }
    }

    if (!downloadUrl) {
      throw new Error('Não foi possível obter o link de vídeo desta publicação. Certifique-se de que o link é público.');
    }

    return res.json({
      success: true,
      title: title,
      downloadUrl: downloadUrl
    });

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao processar o vídeo. Tente novamente.' 
    });
  }
};
