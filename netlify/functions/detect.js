export async function handler(event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...headers, Allow: "POST" }, body: JSON.stringify({ success: false, error: "Método não permitido." }) };
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Corpo da solicitação inválido." }) };
  }
  const { detectPlatform } = await import("../../lib/platform-detector.js");
  const result = detectPlatform(body.url);
  if (!result.valid) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: result.error }) };
  }
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      platform: result.platform,
      message: "Link reconhecido. A disponibilidade de download depende de uma integração autorizada."
    })
  };
}
