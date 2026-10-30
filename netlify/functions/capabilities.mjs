import { listProviders } from "../../lib/provider-registry.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ success: false, error: "Método não permitido." }, 405);
  }
  return json({
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
