
const express = require("express");
const cors = require("cors");
const YTDlpWrap = require("yt-dlp-wrap").default;
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "CortePro Master Backend operacional",
    endpoint: "/api/extract?url=LINK_DO_VIDEO"
  });
});

app.get("/api/extract", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: "URL não fornecida."
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({
      success: false,
      error: "Link inválido."
    });
  }

  const allowedHosts = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "instagram.com",
    "www.instagram.com",
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "tiktok.com",
    "www.tiktok.com",
    "vm.tiktok.com",
    "kwai.com",
    "www.kwai.com"
  ];

  if (
    parsedUrl.protocol !== "https:" ||
    !allowedHosts.includes(parsedUrl.hostname.toLowerCase())
  ) {
    return res.status(400).json({
      success: false,
      error: "Plataforma não permitida ou link inválido."
    });
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cortepro-")
  );

  const outputTemplate = path.join(tempDir, "video.%(ext)s");
  let filePath;

  try {
    const ytDlp = new YTDlpWrap();

    await ytDlp.execPromise([
      url,
      "--no-playlist",
      "--no-warnings",
      "--format",
      "best[ext=mp4]/best",
      "--output",
      outputTemplate
    ]);

    const files = fs.readdirSync(tempDir);
    filePath = files.length
      ? path.join(tempDir, files[0])
      : null;

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("Nenhum arquivo de vídeo foi gerado.");
    }

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="cortepro-video.mp4"'
    );
    res.setHeader("Content-Type", "video/mp4");

    const stream = fs.createReadStream(filePath);

    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Erro ao enviar o vídeo."
        });
      } else {
        res.destroy();
      }
    });

    stream.on("close", () => {
      fs.rm(tempDir, { recursive: true, force: true }, () => {});
    });

    stream.pipe(res);
  } catch (error) {
    fs.rm(tempDir, { recursive: true, force: true }, () => {});

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Não foi possível extrair o vídeo. Verifique se é público e se a plataforma permite o acesso."
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CortePro Master iniciado na porta ${PORT}`);
});
