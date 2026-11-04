"""Single-instance, single-worker container. Do not deploy as a serverless function."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .processing import process_video, ProcessingError

MAX_BYTES = 200 * 1024 * 1024
TTL = 3600
jobs = {}
lock = threading.RLock()
worker = ThreadPoolExecutor(max_workers=1)
log = logging.getLogger(__name__)


def authenticate(request):
    secret = os.environ.get('MUSIC_SERVICE_SECRET', '')
    if len(secret) < 32:
        raise HTTPException(503, 'Serviço de áudio não configurado.')
    token = request.headers.get('authorization', '').removeprefix('Bearer ')
    try:
        payload, signature = token.split('.')
        expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if (not isinstance(claims.get('exp'), int) or not time.time() < claims['exp'] <= time.time() + TTL + 10
                or not isinstance(claims.get('sub'), str) or len(claims['sub']) != 48):
            raise ValueError()
        return claims['sub']
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise HTTPException(401, 'Sessão expirada. Selecione o vídeo e tente novamente.')


def cleanup(now=None):
    now = time.time() if now is None else now
    with lock:
        for job_id, job in list(jobs.items()):
            if job['status'] in ('completed', 'failed') and now - job['updated'] > TTL:
                shutil.rmtree(job['directory'], ignore_errors=True)
                del jobs[job_id]


@asynccontextmanager
async def lifespan(app):
    if len(os.environ.get('MUSIC_SERVICE_SECRET', '')) < 32:
        raise RuntimeError('MUSIC_SERVICE_SECRET must contain at least 32 characters')
    if not os.environ.get('MUSIC_ALLOWED_ORIGIN'):
        raise RuntimeError('Set MUSIC_ALLOWED_ORIGIN to the exact CortePro origin')
    async def janitor():
        while True:
            await asyncio.sleep(60)
            cleanup()
    task = asyncio.create_task(janitor())
    try:
        yield
    finally:
        task.cancel()
        worker.shutdown(wait=True)
        for job in list(jobs.values()):
            shutil.rmtree(job['directory'], ignore_errors=True)


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware,
                   allow_origins=[os.environ.get('MUSIC_ALLOWED_ORIGIN', 'https://cortepro-master.vercel.app')],
                   allow_methods=['GET', 'POST'], allow_headers=['Authorization', 'Content-Type'])


@app.middleware('http')
async def no_cache(request, call_next):
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.exception_handler(HTTPException)
async def error_response(request, error):
    return JSONResponse({'error': error.detail}, status_code=error.status_code)


@app.get('/health')
def health():
    return {'status': 'ok'}


def execute(job_id):
    job = jobs[job_id]
    def progress(message):
        with lock:
            job.update(status='processing', message=message, updated=time.time())
    try:
        progress('Preparando o áudio...')
        output = process_video(job['directory'], progress)
        # All intermediate copies are removed before publishing the result.
        for path in Path(job['directory']).iterdir():
            if path != output:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
        with lock:
            job.update(status='completed', message='Áudio tratado.', updated=time.time())
    except Exception as error:
        log.exception('Audio processing failed: %s', job_id)
        message = str(error) if isinstance(error, ProcessingError) else 'Não foi possível tratar o áudio. Tente um vídeo mais curto ou outro formato.'
        shutil.rmtree(job['directory'], ignore_errors=True)
        with lock:
            job.update(status='failed', error=message, updated=time.time())


@app.post('/jobs', status_code=202)
async def upload(request: Request):
    owner = authenticate(request)
    if request.headers.get('content-type', '').split(';')[0] != 'application/octet-stream':
        raise HTTPException(415, 'Envie um arquivo de vídeo.')
    length = request.headers.get('content-length')
    if length:
        try:
            size = int(length)
        except ValueError:
            raise HTTPException(400, 'Tamanho de arquivo inválido.')
        if size < 0 or size > MAX_BYTES:
            raise HTTPException(413, 'Selecione um vídeo com até 200 MB.')
    cleanup()
    with lock:
        if any(j['owner'] == owner for j in jobs.values()):
            raise HTTPException(409, 'Este envio já foi iniciado. Aguarde o resultado.')
        active = sum(j['status'] not in ('completed', 'failed') for j in jobs.values())
        if active >= 1 or len(jobs) >= 12:
            raise HTTPException(429, 'O serviço está ocupado. Tente novamente em alguns minutos.')
        job_id = secrets.token_hex(24)
        directory = tempfile.mkdtemp(prefix='cortepro-music-')
        jobs[job_id] = dict(owner=owner, directory=directory, status='uploading',
                            message='Recebendo vídeo...', updated=time.time())
    try:
        received = 0
        # The deadline also limits incomplete uploads holding a queue slot.
        async with asyncio.timeout(600):
            with open(Path(directory) / 'input.video', 'wb') as target:
                async for chunk in request.stream():
                    received += len(chunk)
                    if received > MAX_BYTES:
                        raise HTTPException(413, 'Selecione um vídeo com até 200 MB.')
                    target.write(chunk)
        if not received:
            raise HTTPException(400, 'O vídeo enviado está vazio.')
        with lock:
            jobs[job_id].update(status='queued', message='Na fila para tratar o áudio...', updated=time.time())
        worker.submit(execute, job_id)
    except BaseException:
        with lock:
            jobs.pop(job_id, None)
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return {'id': job_id, 'status': 'queued'}


def owned_job(job_id, owner):
    cleanup()
    with lock:
        job = jobs.get(job_id)
        if not job or job['owner'] != owner:
            raise HTTPException(404, 'O arquivo expirou ou não foi encontrado.')
        return job


@app.get('/jobs/{job_id}')
def status(job_id: str, request: Request):
    job = owned_job(job_id, authenticate(request))
    with lock:
        return {key: job[key] for key in ('status', 'message', 'error') if key in job}


@app.get('/jobs/{job_id}/file')
def download(job_id: str, request: Request):
    job = owned_job(job_id, authenticate(request))
    if job['status'] != 'completed':
        raise HTTPException(409, 'O vídeo ainda não está pronto.')
    return FileResponse(Path(job['directory']) / 'voz.mp4', media_type='video/mp4', filename='CortePro_voz.mp4')
