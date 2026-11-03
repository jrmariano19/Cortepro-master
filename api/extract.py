"""Extract a downloadable public video without downloading it into the function."""
import ipaddress
import json
import logging
import re
import socket
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
from yt_dlp.version import __version__ as extractor_version

VERSION = "8.0.3"
SOCIAL_HOSTS = ("instagram.com", "facebook.com", "fb.watch", "fb.com",
                "youtube.com", "youtu.be", "tiktok.com", "douyin.com",
                "kwai.com", "kuaishou.com")
MEDIA_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v")
FORMAT = "best[ext=mp4][protocol=https]/best[ext=mp4][protocol=http]/best[protocol=https]/best[protocol=http]"


class ExtractionError(Exception):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code, self.status = code, status


class QuietLogger:
    # yt-dlp messages can contain signed media URLs. Return classified errors only.
    def debug(self, message):
        pass

    warning = error = debug


def validate_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise ExtractionError("INVALID_URL", "Cole um link de vídeo válido.", 400)
    try:
        parsed = urlsplit(value.strip())
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.port not in (None, 80, 443)):
            raise ValueError()
    except ValueError:
        raise ExtractionError("INVALID_URL", "Use um endereço HTTP ou HTTPS válido.", 400)
    host = parsed.hostname.lower().rstrip(".")
    social = any(host == domain or host.endswith("." + domain) for domain in SOCIAL_HOSTS)
    direct = parsed.path.lower().endswith(MEDIA_EXTENSIONS)
    if not social and not direct:
        raise ExtractionError("UNSUPPORTED_URL", "Use um link do Instagram, TikTok, Facebook, YouTube, Kwai ou de um arquivo de vídeo.", 400)
    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ExtractionError("INVALID_URL", "Use um endereço público de vídeo.", 400)
    except socket.gaierror:
        raise ExtractionError("HOST_UNAVAILABLE", "Não foi possível localizar esse endereço. Confira o link.", 422)
    return value.strip(), direct


def classify_error(message):
    text = str(message).lower()
    if "requested format is not available" in text:
        return ExtractionError("NO_COMPLETE_FORMAT", "A rede social não disponibilizou um arquivo único com áudio e vídeo para este link.")
    if any(token in text for token in ("429", "rate-limit", "too many requests")):
        return ExtractionError("RATE_LIMITED", "A rede social limitou as solicitações. Tente novamente em alguns minutos.", 429)
    if any(token in text for token in ("login", "log in", "sign in", "private", "cookies", "not a bot")):
        return ExtractionError("ACCESS_RESTRICTED", "A rede social exigiu login ou bloqueou o acesso pelo servidor. Não foi possível obter este vídeo.", 403)
    if any(token in text for token in ("timed out", "timeout", "unable to download", "network")):
        return ExtractionError("UPSTREAM_UNAVAILABLE", "Não foi possível conectar à rede social. Tente novamente em instantes.", 502)
    return ExtractionError("EXTRACTION_FAILED", "Não foi possível obter o vídeo. Confira se o link está completo e se o vídeo ainda está disponível.")


def legacy_provider(url):
    """Retain the existing TikTok/Kwai providers as bounded fallbacks."""
    host = urlsplit(url).hostname.lower()
    is_tiktok = any(host == d or host.endswith('.' + d) for d in ('tiktok.com', 'douyin.com'))
    is_kwai = any(host == d or host.endswith('.' + d) for d in ('kwai.com', 'kuaishou.com'))
    if not is_tiktok and not is_kwai:
        return None
    try:
        if is_tiktok:
            from urllib.parse import urlencode
            request = Request('https://www.tikwm.com/api/?' + urlencode({'url': url}))
        else:
            request = Request('https://getvideo.mobi/api/v2/convert',
                              data=json.dumps({'url': url}).encode(),
                              headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=8) as response:
            data = json.loads(response.read(1024 * 1024))
        media = ((data.get('data') or {}).get('play') or (data.get('data') or {}).get('wmplay')) if is_tiktok else data.get('url')
        if isinstance(media, str) and urlsplit(media).scheme in ('http', 'https'):
            return {'success': True, 'downloadUrl': media, 'filename': 'CortePro_Video.mp4', 'version': VERSION}
    except Exception:
        logging.warning('legacy_provider_failed platform=%s', 'tiktok' if is_tiktok else 'kwai')
    return None


def extract_video(value):
    url, direct = validate_url(value)
    if direct:
        return {"success": True, "downloadUrl": url, "filename": "CortePro_Video" + urlsplit(url).path[urlsplit(url).path.rfind("."):].lower(), "version": VERSION}
    fallback = legacy_provider(url)
    if fallback:
        return fallback
    options = {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(),
        "skip_download": True, "noplaylist": True, "cachedir": False,
        "socket_timeout": 8, "retries": 0, "extractor_retries": 0,
        # Only complete HTTP files with audio and video; no silent adaptive tracks
        # or manifests that would require ffmpeg to assemble on the phone.
        "format": FORMAT,
    }
    try:
        with YoutubeDL(options) as extractor:
            info = extractor.extract_info(url, download=False)
    except DownloadError as exc:
        detail = re.sub(r"https?://\S+", "[url]", str(exc))[:500]
        logging.warning("extractor_error detail=%s", detail)
        raise classify_error(exc) from None
    if info and info.get("entries") is not None:
        info = next((entry for entry in info["entries"] if entry), None)
    if not info or not info.get("url") or urlsplit(info["url"]).scheme not in ("http", "https"):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Este link não retornou um arquivo de vídeo com áudio para baixar.")
    if info.get("has_drm") or info.get("vcodec") == "none" or info.get("acodec") == "none":
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Não há um arquivo completo com áudio e vídeo disponível neste link.")
    extension = info.get("ext", "mp4")
    if extension not in ("mp4", "webm", "mov", "m4v"):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Este vídeo não está disponível em um formato de arquivo compatível.")
    name = re.sub(r"[^\w .-]", "_", info.get("title") or "Video")[:100]
    return {"success": True, "downloadUrl": info["url"], "filename": f"CortePro_{name}.{extension}", "version": VERSION}


class handler(BaseHTTPRequestHandler):
    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        query = parse_qs(urlsplit(self.path).query)
        if query.get("health") == ["1"]:
            return self.respond(200, {"version": VERSION, "extractorVersion": extractor_version})
        self.process(query.get("url", [None])[0])

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 8192:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
        except (ValueError, UnicodeDecodeError):
            return self.respond(400, {"success": False, "code": "INVALID_BODY", "error": "Envie um link de vídeo válido."})
        self.process(payload.get("url"))

    def process(self, value):
        try:
            self.respond(200, extract_video(value))
        except ExtractionError as exc:
            logging.warning("video_extraction_failed code=%s", exc.code)
            self.respond(exc.status, {"success": False, "code": exc.code, "error": str(exc), "version": VERSION})
        except Exception:
            logging.error("video_extraction_failed code=INTERNAL_ERROR")
            self.respond(500, {"success": False, "code": "INTERNAL_ERROR", "error": "O servidor não conseguiu processar o vídeo. Tente novamente.", "version": VERSION})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.end_headers()
