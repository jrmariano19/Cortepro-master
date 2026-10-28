const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializa o yt-dlp-wrap e baixa o binário executável mais recente se necessário
const ytDlpWrap = new YTDlpWrap();

// Assegura que o binário do yt-dlp está disponível no ambiente do Render
(async () => {
  try {
    const binaryPath = await YTDlpWrap.downloadBinary();
    console.log(`yt-dlp binário pronto em: ${binaryPath}`);
  } catch (error) {
    console.error("Erro ao baixar o binário do yt-dlp:", error);
  }
})();

// Rota raiz para verificação de status operacional
app.get('/', (req, res) => {
  res.json({
    status: "CortePro Master Backend operacional",
    endpoint: "/api/extract?url=LINK_DO_VIDEO"
  });
});

// Rota de extração de vídeos
app.get('/api/extract', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: "Parâmetro 'url' não fornecido." });
  }

  try {
    // Validação básica de URL
    const parsedUrl = new URL(videoUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "URL inválida." });
    }

    console.log(`Extraindo informações para: ${videoUrl}`);

    // Obtém metadados e o link direto de download do vídeo
    const metadata = await ytDlpWrap.getVideoInfo([
      videoUrl,
      '--no-playlist',
      '--dump-json'
    ]);

    // Seleciona a melhor URL de formato direto disponível
    let downloadUrl = metadata.url;
    if (!downloadUrl && metadata.formats && metadata.formats.length > 0) {
      // Pega o último formato com vídeo e áudio ou apenas vídeo progressivo
      const bestFormat = metadata.formats.reverse().find(f => f.url && f.vcodec !== 'none');
      if (bestFormat) downloadUrl = bestFormat.url;
    }

    if (!downloadUrl) {
      return res.status(422).json({ error: "Não foi possível extrair o link direto de mídia deste vídeo. Verifique se é público." });
    }

    res.json({
      success: true,
      title: metadata.title || "Vídeo CortePro",
      duration: metadata.duration || 0,
      thumbnail: metadata.thumbnail || "",
      downloadUrl: downloadUrl
    });

  } catch (error) {
    console.error("Erro na extração:", error.message);
    res.status(500).json({ 
      error: "Falha ao processar a extração do vídeo. O conteúdo pode ser privado, protegido ou a plataforma bloqueou o acesso temporariamente.",
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
