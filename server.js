const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('CortePro Master Backend is running!');
});

// Função para expandir links curtos (como facebook.com/share/r/ ou vt.tiktok.com)
async function expandUrl(shortUrl) {
    try {
        const response = await axios.get(shortUrl, {
            maxRedirects: 5,
            validateStatus: function (status) { return status >= 200 && status < 400; },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });
        if (response.request && response.request.res && response.request.res.responseUrl) {
            return response.request.res.responseUrl;
        }
    } catch (e) {
        // Se falhar a expansão por axios, tenta retornar o original
    }
    return shortUrl;
}

app.get('/api/extract', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ success: false, error: 'URL não fornecida.' });
    }

    try {
        // Se for link encurtado, expande primeiro para o URL real da publicação
        if (targetUrl.includes('facebook.com/share/') || targetUrl.includes('fb.watch') || targetUrl.includes('vt.tiktok.com') || targetUrl.includes('instagram.com/reel/')) {
            targetUrl = await expandUrl(targetUrl);
        }

        const apiExtractUrl = `https://api.cobalt.tools/api/json`;
        const cobaltResponse = await axios.post(apiExtractUrl, {
            url: targetUrl,
            vQuality: '720',
            filenamePattern: 'classic'
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'CorteProMaster/3.0'
            },
            timeout: 25000
        });

        const data = cobaltResponse.data;

        if (data && (data.status === 'stream' || data.status === 'redirect' || data.url)) {
            return res.json({
                success: true,
                videoUrl: data.url || (data.picker && data.picker[0] ? data.picker[0].url : null),
                title: data.filename || 'video_cortepro.mp4'
            });
        } else if (data && data.status === 'picker' && data.picker && data.picker.length > 0) {
            return res.json({
                success: true,
                videoUrl: data.picker[0].url,
                title: 'video_cortepro.mp4'
            });
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Não foi possível extrair o vídeo. Verifique se a publicação é estritamente pública.' 
            });
        }

    } catch (err) {
        return res.status(500).json({ 
            success: false, 
            error: 'Erro no servidor Render ao processar o link. Tente novamente em instantes.' 
        });
    }
});

app.get('/api/download-proxy', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL em falta.');

    try {
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        res.setHeader('Content-Disposition', 'attachment; filename="video_cortepro.mp4"');
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Erro ao descarregar vídeo.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CortePro Server running on port ${PORT}`);
});
