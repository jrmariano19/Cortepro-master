const PLATFORM_HOSTS = [
  { platform: "TikTok", domains: ["tiktok.com"] },
  { platform: "Kwai", domains: ["kwai.com", "kw.ai"] },
  { platform: "Instagram", domains: ["instagram.com"] },
  { platform: "Facebook", domains: ["facebook.com", "fb.watch"] },
  { platform: "YouTube", domains: ["youtube.com", "youtu.be"] }
];
function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}
export function detectPlatform(input) {
  if (typeof input !== "string" || input.length > 2048) return { valid: false, platform: null, error: "Informe um link válido." };
  let parsed;
  try { parsed = new URL(input); } catch { return { valid: false, platform: null, error: "O link não é uma URL válida." }; }
  if (parsed.protocol !== "https:") return { valid: false, platform: null, error: "Por segurança, use um link HTTPS." };
  if (parsed.username || parsed.password || parsed.port) return { valid: false, platform: null, error: "O link contém componentes não permitidos." };
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const match = PLATFORM_HOSTS.find(({ domains }) => domains.some(domain => hostMatches(hostname, domain)));
  if (!match) return { valid: false, platform: null, error: "Plataforma não reconhecida. Use TikTok, Kwai, Instagram, Facebook ou YouTube." };
  return { valid: true, platform: match.platform, normalizedUrl: parsed.toString() };
}
