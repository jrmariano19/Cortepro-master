"""Small configuration endpoint. Video bytes never pass through the downloader."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


def music_config():
    service = os.environ.get('MUSIC_SERVICE_URL', '').rstrip('/')
    secret = os.environ.get('MUSIC_SERVICE_SECRET', '')
    parsed = urlsplit(service)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path
            or len(secret) < 32):
        return 503, {'error': 'O removedor de música ainda não está disponível. Tente novamente mais tarde.'}
    claims = {'sub': secrets.token_hex(24), 'exp': int(time.time()) + 3600}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b'=').decode()
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return 200, {'serviceUrl': service, 'token': payload + '.' + signature, 'maxBytes': 200 * 1024 * 1024}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, data = music_config()
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
