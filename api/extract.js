import { detectPlatform } from "../lib/platform-detector.js";
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ success: false, error: "Método não permitido." }); }
  const result = detectPlatform(req.body?.url);
  if (!result.valid) return res.status(400).json({ success: false, error: result.error });
  // Sem scraping, proxy aberto ou bypass. Ativar somente adaptadores oficiais/autorizados.
  return res.status(501).json({ success: false, code: "INTEGRATION_UNAVAILABLE", platform: result.platform, error: `O link é do ${result.platform}, mas o download ainda não está habilitado. A integração precisa de uma API autorizada para esta plataforma.` });
}
