const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.get('/', (req, res) => {
    res.json({ status: 'CortePro Backend Operacional (TikTok, Kwai, Instagram, Facebook + Proxy)' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Extração de links (TikTok, Kwai, Instagram, Facebook)
app.get('/api/extract', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).json({ success: false, error: 'URL não fornecida.' });
    }

    try {
        // 1. Cobalt API
        try {
            const cobaltRes = await fetch('https://api.cobalt.tools/api/json', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                },
                body: JSON.stringify({
                    url: videoUrl,
                    vQuality: '720'
                })
            });
            
            if (cobaltRes.ok) {
                const data = await cobaltRes.json();
                const finalUrl = data.url || (data.picker && data.picker[0] && data.picker[0].url);
                if (finalUrl) {
                    return res.json({
                        success: true,
                        title: data.filename || 'video_cortepro',
                        videoUrl: finalUrl
                    });
                }
            }
        } catch (err) {
            console.log('Cobalt API falhou:', err.message);
        }

        // 2. TikTok específico
        if (videoUrl.includes('tiktok.com')) {
            try {
                const tikRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`);
                const tikData = await tikRes.json();
                if (tikData && tikData.data && tikData.data.play) {
                    return res.json({
                        success: true,
                        title: tikData.data.title || 'video_tiktok',
                        videoUrl: tikData.data.play
                    });
                }
            } catch (e) {}
        }

        // 3. Kwai específico
        if (videoUrl.includes('kwai.com') || videoUrl.includes('kuaishou.com')) {
            try {
                const kwaiRes = await fetch(`https://api.vreden.my.id/api/kwaidownload?url=${encodeURIComponent(videoUrl)}`);
                const kwaiData = await kwaiRes.json();
                if (kwaiData && kwaiData.result && kwaiData.result.download_url) {
                    return res.json({
                        success: true,
                        title: 'video_kwai',
                        videoUrl: kwaiData.result.download_url
                    });
                }
            } catch (e) {}
        }

        return res.status(404).json({ success: false, error: 'Não foi possível extrair o vídeo com áudio deste link. Verifique se é público.' });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Proxy para download direto sem bloqueio de CORS
app.get('/api/download-proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('URL não fornecida.');
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://www.instagram.com/'
            }
        });

        if (!response.ok) {
            return res.status(500).send('Erro ao obter o ficheiro de vídeo externo.');
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="cortepro_video.mp4"');
        response.body.pipe(res);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});