import { listProviders } from "../lib/provider-registry.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Método não permitido." });
  }

  return res.status(200).json({
    success: true,
    providers: listProviders(),
    policy: {
      downloadsRequireAuthorization: true,
      bypassAuthentication: false,
      bypassDrm: false,
      openProxy: false
    }
  });
}
