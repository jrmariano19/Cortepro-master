"""Extract a downloadable public video without downloading it into the function."""
import ipaddress
import json
import logging
import re
import socket
from http.server import BaseHTTPRequestHandler
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlsplit, urljoin
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError
from yt_dlp.version import __version__ as extractor_version

VERSION = "8.1.6"
USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
SOCIAL_HOSTS = ("instagram.com", "facebook.com", "fb.watch", "fb.com",
                "youtube.com", "youtu.be", "tiktok.com", "douyin.com",
                "kwai.com", "kuaishou.com")
SHOPEE_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
SHOPEE_HOSTS = ("shopee.com.br", "shp.ee")
SHOPEE_MEDIA_HOSTS = ("susercontent.com", "shopeemobile.com")
MEDIA_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v")
FORMAT = "best[ext=mp4][protocol=https]/best[ext=mp4][protocol=http]/best[protocol=https]/best[protocol=http]"


def platform_is(url, domains):
    host = (urlsplit(url).hostname or '').lower()
    return any(host == domain or host.endswith('.' + domain) for domain in domains)


def usable_media(url):
    """Probe the actual file, rather than treating an extracted URL as success."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return False
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            return False
        request = Request(url, headers={'User-Agent': USER_AGENT, 'Range': 'bytes=0-63'})
        with urlopen(request, timeout=6) as response:
            prefix = response.read(64)
            return response.status in (200, 206) and (prefix[4:8] == b'ftyp' or prefix.startswith(b'\x1a\x45\xdf\xa3'))
    except Exception:
        return False


class StructuredVideos(HTMLParser):
    """Read Kwai's public VideoObject metadata without executing page scripts."""
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.videos = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('type') == 'application/ld+json':
            self.active, self.parts = True, []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag != 'script' or not self.active:
            return
        self.active = False
        try:
            self.collect(json.loads(''.join(self.parts)))
        except (ValueError, TypeError):
            pass

    def collect(self, value):
        if isinstance(value, list):
            for item in value:
                self.collect(item)
        elif isinstance(value, dict):
            if value.get('@type') == 'VideoObject' and isinstance(value.get('contentUrl'), str):
                self.videos.append(value)
            if '@graph' in value:
                self.collect(value['@graph'])


def kwai_video(url):
    try:
        with urlopen(Request(url, headers={'User-Agent': USER_AGENT}), timeout=12) as response:
            if not platform_is(response.url, ('kwai.com', 'kuaishou.com')):
                return None
            page = response.read(2 * 1024 * 1024).decode('utf-8', 'replace')
        parser = StructuredVideos()
        parser.feed(page)
        for video in parser.videos:
            if usable_media(video['contentUrl']):
                return {'success': True, 'downloadUrl': video['contentUrl'], 'filename': 'CortePro_Kwai.mp4', 'version': VERSION}
    except Exception:
        logging.warning('kwai_public_metadata_failed')
    return None


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
    social = any(host == domain or host.endswith("." + domain) for domain in SOCIAL_HOSTS + SHOPEE_HOSTS + ("netshort.com",))
    direct = parsed.path.lower().endswith(MEDIA_EXTENSIONS)
    if not social and not direct:
        raise ExtractionError("UNSUPPORTED_URL", "Use um link do Instagram, TikTok, Facebook, YouTube, Kwai, Shopee, NetShort ou de um arquivo de vídeo.", 400)
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
            request = Request('https://www.tikwm.com/api/?' + urlencode({'url': url, 'hd': '1'}),
                              headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
        else:
            request = Request('https://getvideo.mobi/api/v2/convert',
                              data=json.dumps({'url': url}).encode(),
                              headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=12) as response:
            data = json.loads(response.read(1024 * 1024))
        if is_tiktok:
            payload = data.get('data') or {}
            candidates = [payload.get(key) for key in ('play', 'hdplay', 'wmplay')] if data.get('code') == 0 else []
        else:
            candidates = [data.get('url')]
        for media in candidates:
            if isinstance(media, str) and usable_media(media):
                return {'success': True, 'downloadUrl': media, 'filename': 'CortePro_Video.mp4', 'version': VERSION}
    except Exception:
        logging.warning('legacy_provider_failed platform=%s', 'tiktok' if is_tiktok else 'kwai')
    return None


class ShopeeNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Validate each hop before making the next network request.
        return None


def shopee_public_url(url, domains):
    try:
        parsed = urlsplit(url)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.port not in (None, 80, 443)
                or not platform_is(url, domains)):
            raise ValueError()
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError()
    except (ValueError, socket.gaierror):
        raise ExtractionError('SHOPEE_INVALID_REDIRECT', 'A Shopee retornou um endereço inválido ou indisponível.') from None
    return url


def shopee_request(url, domains, limit, media=False):
    opener = build_opener(ShopeeNoRedirect())
    for _ in range(5):
        shopee_public_url(url, domains)
        headers = {'User-Agent': SHOPEE_USER_AGENT}
        if media:
            headers['Range'] = 'bytes=0-63'
        try:
            with opener.open(Request(url, headers=headers), timeout=6) as response:
                if response.status not in (200, 206):
                    raise ExtractionError('SHOPEE_UNAVAILABLE', 'O vídeo da Shopee não está disponível agora.')
                body = response.read(limit + 1)
                if not media and len(body) > limit:
                    raise ExtractionError('SHOPEE_INVALID_PAGE', 'A página da Shopee excedeu o limite de leitura.')
                return body[:limit], url
        except HTTPError as error:
            location = error.headers.get('Location') if error.headers else None
            code = error.code
            error.close()
            if code in (301, 302, 303, 307, 308) and location:
                url = urljoin(url, location)
                continue
            if code in (401, 403):
                raise ExtractionError('SHOPEE_ACCESS_RESTRICTED', 'A Shopee bloqueou o acesso ou exigiu login para este vídeo.', 403) from None
            if code == 429:
                raise ExtractionError('SHOPEE_RATE_LIMITED', 'A Shopee limitou as solicitações. Tente novamente mais tarde.', 429) from None
            raise ExtractionError('SHOPEE_UNAVAILABLE', 'O vídeo da Shopee não está disponível agora.', 502) from None
    raise ExtractionError('SHOPEE_REDIRECT_LIMIT', 'O link da Shopee redirecionou muitas vezes. Copie novamente o link do vídeo.')


class ShopeeVideoPage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.video = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('id') == '__NEXT_DATA__':
            self.active, self.parts = True, []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag != 'script' or not self.active:
            return
        self.active = False
        try:
            payload = json.loads(''.join(self.parts))
            # Select the shared video only, never recommendations or thumbnails.
            video = payload['props']['pageProps']['mediaInfo']['video']
            if isinstance(video, dict):
                self.video = video
        except (ValueError, KeyError, TypeError):
            pass


def shopee_video(url):
    try:
        page, final_url = shopee_request(url, SHOPEE_HOSTS, 2 * 1024 * 1024)
        parser = ShopeeVideoPage()
        parser.feed(page.decode('utf-8', 'replace'))
        video = parser.video or {}
        media = video.get('watermarkVideoUrl')
        if not isinstance(media, str) or not media:
            raise ExtractionError('SHOPEE_NO_PUBLIC_VIDEO', 'Não encontramos um vídeo público neste link. Na Shopee, abra o vídeo e use Compartilhar → Copiar link.')
        prefix, media_url = shopee_request(media, SHOPEE_MEDIA_HOSTS, 64, media=True)
        if prefix[4:8] != b'ftyp':
            raise ExtractionError('SHOPEE_MEDIA_UNAVAILABLE', 'A Shopee não disponibilizou um arquivo MP4 válido. Tente novamente mais tarde.', 502)
        return {'success': True, 'downloadUrl': media_url, 'filename': 'CortePro_Shopee.mp4', 'version': VERSION}
    except ExtractionError:
        raise
    except Exception:
        logging.warning('shopee_public_metadata_failed')
        raise ExtractionError('SHOPEE_UNAVAILABLE', 'Não foi possível conectar à Shopee. Tente novamente em instantes.', 502) from None


def resolve_facebook_share(url):
    """Resolve Facebook share links only through public redirects on Facebook domains."""
    parsed = urlsplit(url)
    if not platform_is(url, ('facebook.com', 'fb.com')) or not re.match(r'^/share/(?:v|r)/[^/]+/?
    url, direct = validate_url(value)
    if direct:
        return {"success": True, "downloadUrl": url, "filename": "CortePro_Video" + urlsplit(url).path[urlsplit(url).path.rfind("."):].lower(), "version": VERSION}
    if platform_is(url, ('facebook.com', 'fb.com')):
        url = resolve_facebook_share(url)
    if platform_is(url, ('netshort.com',)):
        from lib.netshort import download_episode
        try:
            return {**download_episode(url), 'version': VERSION}
        except ValueError as error:
            raise ExtractionError('NETSHORT_UNAVAILABLE', str(error), 422) from None
        except Exception:
            raise ExtractionError('NETSHORT_UNAVAILABLE', 'Não foi possível obter o vídeo da NetShort agora. Tente novamente em instantes.', 502) from None
    if platform_is(url, SHOPEE_HOSTS):
        return shopee_video(url)
    if platform_is(url, ('kwai.com', 'kuaishou.com')):
        native = kwai_video(url)
        if native:
            return native
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
    formats = info.get("formats") or []
    original_silent = bool(formats) and all(fmt.get("acodec") == "none" for fmt in formats)
    if info.get("has_drm") or info.get("vcodec") == "none" or (info.get("acodec") == "none" and not original_silent):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Não há um arquivo completo com áudio e vídeo disponível neste link.")
    if platform_is(url, ('tiktok.com', 'douyin.com', 'kwai.com', 'kuaishou.com')) and not usable_media(info['url']):
        raise ExtractionError('MEDIA_UNAVAILABLE', 'O endereço do vídeo foi recusado pela rede social. Tente novamente em instantes.', 502)
    extension = info.get("ext", "mp4")
    if extension not in ("mp4", "webm", "mov", "m4v"):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Este vídeo não está disponível em um formato de arquivo compatível.")
    name = re.sub(r"[^\w .-]", "_", info.get("title") or "Video")[:100]
    return {"success": True, "downloadUrl": info["url"], "filename": f"CortePro_{name}.{extension}", "originalSilent": original_silent, "version": VERSION}


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
, parsed.path):
        return url
    class SafeFacebookRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            target = urlsplit(newurl)
            if target.scheme != 'https' or not platform_is(newurl, ('facebook.com', 'fb.com', 'fb.watch')):
                raise ExtractionError('FACEBOOK_REDIRECT_BLOCKED', 'O Facebook redirecionou para um endereço não permitido.', 422)
            return super().redirect_request(request, fp, code, msg, headers, newurl)
    try:
        opener = build_opener(SafeFacebookRedirect())
        request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html'})
        with opener.open(request, timeout=8) as response:
            resolved = response.geturl()
            return resolved if platform_is(resolved, ('facebook.com', 'fb.com', 'fb.watch')) else url
    except (ExtractionError, HTTPError):
        return url
    except Exception:
        return url


def extract_video(value):
    url, direct = validate_url(value)
    if direct:
        return {"success": True, "downloadUrl": url, "filename": "CortePro_Video" + urlsplit(url).path[urlsplit(url).path.rfind("."):].lower(), "version": VERSION}
    if platform_is(url, ('netshort.com',)):
        from lib.netshort import download_episode
        try:
            return {**download_episode(url), 'version': VERSION}
        except ValueError as error:
            raise ExtractionError('NETSHORT_UNAVAILABLE', str(error), 422) from None
        except Exception:
            raise ExtractionError('NETSHORT_UNAVAILABLE', 'Não foi possível obter o vídeo da NetShort agora. Tente novamente em instantes.', 502) from None
    if platform_is(url, SHOPEE_HOSTS):
        return shopee_video(url)
    if platform_is(url, ('kwai.com', 'kuaishou.com')):
        native = kwai_video(url)
        if native:
            return native
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
    formats = info.get("formats") or []
    original_silent = bool(formats) and all(fmt.get("acodec") == "none" for fmt in formats)
    if info.get("has_drm") or info.get("vcodec") == "none" or (info.get("acodec") == "none" and not original_silent):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Não há um arquivo completo com áudio e vídeo disponível neste link.")
    if platform_is(url, ('tiktok.com', 'douyin.com', 'kwai.com', 'kuaishou.com')) and not usable_media(info['url']):
        raise ExtractionError('MEDIA_UNAVAILABLE', 'O endereço do vídeo foi recusado pela rede social. Tente novamente em instantes.', 502)
    extension = info.get("ext", "mp4")
    if extension not in ("mp4", "webm", "mov", "m4v"):
        raise ExtractionError("NO_DOWNLOADABLE_VIDEO", "Este vídeo não está disponível em um formato de arquivo compatível.")
    name = re.sub(r"[^\w .-]", "_", info.get("title") or "Video")[:100]
    return {"success": True, "downloadUrl": info["url"], "filename": f"CortePro_{name}.{extension}", "originalSilent": original_silent, "version": VERSION}


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
