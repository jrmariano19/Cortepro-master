import { detectPlatform } from "../lib/platform-detector.js";
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ success: false, error: "Método não permitido." }); }
  const result = detectPlatform(req.body?.url);
  if (!result.valid) return res.status(400).json({ success: false, error: result.error });
  return res.status(200).json({ success: true, platform: result.platform, message: "Link reconhecido. A disponibilidade de download depende de uma integração autorizada." });
}
