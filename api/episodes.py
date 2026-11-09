"""List public episode-page links; does not extract or unlock media."""
import json
import re
import math
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit, urljoin, unquote, quote, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler
from lib.netshort import current_episode


def series_path(value):
    if not isinstance(value, str) or len(value) > 2000:
        raise ValueError('Link inválido.')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or parsed.netloc not in ('netshort.com', 'www.netshort.com')
            or parsed.query or parsed.fragment):
        raise ValueError('Informe uma página de episódios da NetShort.')
    match = re.fullmatch(r'/pt/(?:episode|full-episodes)/([^/]+)-(\d{10,25})(?:-ep-\d+)?', unquote(parsed.path))
    if not match or not re.fullmatch(r'[\w-]+', match[1]):
        raise ValueError('Formato de série não reconhecido.')
    return '/pt/episode/' + match[1] + '-' + match[2]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('A fonte redirecionou a consulta. Abra a lista oficial.')


class EpisodeLinks(HTMLParser):
    def __init__(self, base):
        super().__init__()
        self.base = base
        self.links = {}

    def handle_starttag(self, tag, attrs):
        if tag != 'a':
            return
        href = dict(attrs).get('href', '')
        parsed = urlsplit(urljoin('https://netshort.com', href))
        if parsed.scheme != 'https' or parsed.netloc != 'netshort.com' or parsed.query or parsed.fragment:
            return
        path = unquote(parsed.path)
        match = re.fullmatch(re.escape(self.base) + r'(?:-ep-(\d+))?', path)
        if not match:
            return
        number = int(match[1] or '1')
        if 1 <= number <= 1000:
            self.links[number] = 'https://netshort.com' + quote(path, safe='/')


def parse_episodes(html, base):
    parser = EpisodeLinks(base)
    parser.feed(html)
    return [{'number':n, 'url':parser.links[n]} for n in sorted(parser.links)]


def fetch_page(source):
    request = Request(source, headers={'User-Agent':'Mozilla/5.0', 'Accept':'text/html'})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        data = response.read(3_000_001)
        if len(data) > 3_000_000:
            raise ValueError('Lista muito grande. Abra a página oficial.')
    return data.decode('utf-8')


def verify_free_episode(item):
    """Only expose a download candidate when public page data explicitly marks it free."""
    try:
        page = fetch_page(item['url'])
        episode = current_episode(page, item['number'])
        return {**item, 'access': 'free'} if episode.get('isLock') is False else None
    except Exception:
        return None


def get_episodes(value):
    base = series_path(value)
    source = 'https://netshort.com' + quote(base.replace('/episode/', '/full-episodes/'), safe='/')
    html = fetch_page(source)
    # Official pagination uses /page/N, 20 episodes per page.
    text = re.sub(r'<[^>]*>', '', html)
    total_match = re.search(r'(\d+)\s*episódios no total', text)
    total = int(total_match[1]) if total_match else None
    episodes = {e['number']: e for e in parse_episodes(html, base)}
    failed = False
    page_count = min(math.ceil(total / 20), 10) if total else 1
    if page_count > 1:
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(fetch_page, source + '/page/' + str(n)) for n in range(2, page_count + 1)]
            for future in futures:
                try:
                    for episode in parse_episodes(future.result(), base):
                        episodes[episode['number']] = episode
                except Exception:
                    failed = True
    if not episodes:
        raise ValueError('A fonte não forneceu links de episódios nesta consulta. Abra a lista oficial.')
    complete = bool(total and not failed and set(episodes) == set(range(1, total + 1)))
    # Limit network work and do not advertise unverified or locked episodes.
    # The first page is a bounded preview; it is not a complete free catalog.
    candidates = [episodes[n] for n in sorted(episodes)][:20]
    with ThreadPoolExecutor(max_workers=4) as pool:
        checked = list(pool.map(verify_free_episode, candidates))
    free = [item for item in checked if item is not None]
    return {'episodes':free, 'source':source, 'total':total, 'complete':False,
            'checked':len(candidates), 'freeOnly':True}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            value = parse_qs(urlsplit(self.path).query).get('url', [''])[0]
            # Validate separately to distinguish invalid input from provider failures.
            series_path(value)
        except ValueError as exc:
            return self.reply(400, {'error':str(exc)})
        try:
            return self.reply(200, get_episodes(value))
        except Exception:
            return self.reply(502, {'error':'Não foi possível obter os episódios agora. Tente novamente ou abra a lista oficial.'})

    def reply(self, status, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'public, max-age=300, s-maxage=3600' if status == 200 else 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
