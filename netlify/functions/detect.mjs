import { detectPlatform } from "../../lib/platform-detector.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ success: false, error: "Método não permitido." }, 405);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Envie um corpo JSON válido." }, 400);
  }
  const result = detectPlatform(body?.url);
  if (!result.valid) return json({ success: false, error: result.error }, 400);
  return json({
    success: true,
    platform: result.platform,
    message: "Link reconhecido. A disponibilidade de download depende de uma integração autorizada."
  });
}
