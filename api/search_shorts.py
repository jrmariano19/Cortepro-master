"""Live NetShort title discovery via a public search index (not a static catalog).

Search results are episode page links, not proof of free access or downloadable media.
"""
import json
import re
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, unquote, urlsplit, urlencode
from urllib.request import Request, urlopen

def search_titles(query):
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 100:
        raise ValueError('Digite de 2 a 100 caracteres.')
    query = query.strip()
    params = urlencode({'q': 'site:netshort.com/pt/episode/ ' + query, 'format': 'rss', 'setlang': 'pt-BR'})
    req = Request('https://www.bing.com/search?' + params,
                  headers={'User-Agent':'Mozilla/5.0 (compatible; CortePro/8.1.6)'})
    with urlopen(req, timeout=12) as response:
        raw = response.read(500_001)
        if len(raw) > 500_000:
            raise ValueError('Resposta de busca muito grande.')
    root = ET.fromstring(raw)
    results, seen = [], set()
    for item in root.findall('./channel/item'):
        link = (item.findtext('link') or '').strip()
        parsed = urlsplit(link)
        path = unquote(parsed.path)
        if (parsed.scheme != 'https' or parsed.hostname not in ('netshort.com','www.netshort.com')
                or parsed.username or parsed.password or parsed.port not in (None,443)
                or not re.fullmatch(r'/pt/episode/[\w-]+-\d{10,25}(?:-ep-\d+)?',path)):
            continue
        canonical = 'https://netshort.com' + quote(path, safe='/')
        base = re.sub(r'-ep-\d+$','',canonical)
        if base in seen:
            continue
        seen.add(base)
        title = (item.findtext('title') or '').strip()
        title = re.sub(r'\s*[-|]\s*NetShort.*$', '', title, flags=re.I)[:150]
        results.append({'title':title or 'Drama curto', 'url':canonical, 'access':'unverified'})
        if len(results) >= 15:
            break
    return {'results':results,'live':True,'source':'Bing public search index',
            'notice':'Resultados indexados, não necessariamente atualizados imediatamente. A gratuidade precisa ser verificada por episódio.'}

class handler(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        data=json.dumps(payload,ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        query=parse_qs(urlsplit(self.path).query).get('q',[''])[0]
        try:
            self.reply(200,search_titles(query))
        except ValueError as exc:
            self.reply(400,{'error':str(exc)})
        except Exception:
            self.reply(502,{'error':'A pesquisa em tempo real está indisponível. Tente novamente.'})
