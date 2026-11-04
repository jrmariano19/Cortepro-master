"""Real source separation; never falls back to muting or filtering the full track."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys


class ProcessingError(Exception):
    pass


def run(command, timeout=180):
    return subprocess.run(command, check=True, capture_output=True, timeout=timeout)


def process_video(directory, progress):
    directory = Path(directory)
    source = directory / 'input.video'
    probe = run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', str(source)], timeout=30)
    info = json.loads(probe.stdout)
    streams = info.get('streams', [])
    if not any(s['codec_type'] == 'video' for s in streams):
        raise ProcessingError('O arquivo não contém vídeo.')
    if not any(s['codec_type'] == 'audio' for s in streams):
        raise ProcessingError('Este vídeo não possui áudio para tratar.')
    try:
        duration = float(info['format']['duration'])
    except (KeyError, TypeError, ValueError):
        raise ProcessingError('Não foi possível identificar a duração do vídeo.')
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ProcessingError('Selecione um vídeo com até 10 minutos.')
    progress('Extraindo o áudio do vídeo...')
    audio = directory / 'audio.wav'
    run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:a:0',
         '-vn', '-ac', '2', '-ar', '44100', str(audio)], timeout=120)
    progress('Separando a voz da música... isso pode levar vários minutos.')
    run([sys.executable, '-m', 'demucs', '-n', 'htdemucs', '-d', os.getenv('MUSIC_DEVICE', 'cpu'),
         '--two-stems', 'vocals', '--shifts', '1', '--segment', '7', '-j', '1',
         '-o', str(directory / 'stems'), str(audio)], timeout=1800)
    vocals = directory / 'stems' / 'htdemucs' / 'audio' / 'vocals.wav'
    if not vocals.is_file() or vocals.stat().st_size <= 44:
        raise ProcessingError('O modelo não conseguiu gerar a faixa de voz.')
    progress('Montando o vídeo com o áudio tratado...')
    target = directory / 'voz.mp4'
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-i', str(vocals),
               '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
               '-b:a', '192k', '-af', 'apad', '-t', str(duration), '-movflags', '+faststart', str(target)]
    try:
        run(command, timeout=180)
    except subprocess.CalledProcessError:
        # Non-MP4 video codecs must be transcoded for Android/browser playback.
        index = command.index('copy')
        command[index:index + 1] = ['libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
        run(command, timeout=180)
    if not target.is_file() or not target.stat().st_size:
        raise ProcessingError('Não foi possível montar o vídeo tratado.')
    # Keep only the deliverable; intermediate audio is deleted even on success.
    return target
