export async function handler(event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { ...headers, Allow: "GET" }, body: JSON.stringify({ success: false, error: "Método não permitido." }) };
  }
  const { listProviders } = await import("../../lib/provider-registry.js");
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      providers: listProviders(),
      policy: {
        downloadsRequireAuthorization: true,
        bypassAuthentication: false,
        bypassDrm: false,
        openProxy: false
      }
    })
  };
}
