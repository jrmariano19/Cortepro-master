FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 TORCH_HOME=/opt/models
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY music_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r /tmp/requirements.txt
# Cache the exact separator during build, rather than downloading it per video.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"
COPY music_service /app/music_service
RUN useradd -m processor && chmod -R a+rX /opt/models
USER processor
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "music_service.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
