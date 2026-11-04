import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from api.music import music_config
from music_service import app as service
from music_service.processing import process_video, ProcessingError

ENV = {'MUSIC_SERVICE_URL': 'https://audio.example.com', 'MUSIC_SERVICE_SECRET': 'test-secret-' * 4}


class ConfigTests(unittest.TestCase):
    def test_unconfigured_and_invalid_hosts_are_unavailable(self):
        for url in ['', 'http://localhost', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?q=secret']:
            with patch.dict(os.environ, {**ENV, 'MUSIC_SERVICE_URL': url}, clear=True):
                status, data = music_config()
                self.assertEqual(status, 503)
                self.assertNotIn('token', data)

    def test_short_secret_rejected(self):
        with patch.dict(os.environ, {**ENV, 'MUSIC_SERVICE_SECRET': 'short'}, clear=True):
            self.assertEqual(music_config()[0], 503)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, ENV)
        self.env.start()
        self.client = TestClient(service.app)
        self.token = music_config()[1]['token']
        self.headers = {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/octet-stream'}
        self.submit = patch.object(service.worker, 'submit')
        self.submit.start()

    def tearDown(self):
        self.submit.stop()
        for job in service.jobs.values():
            shutil.rmtree(job['directory'], ignore_errors=True)
        service.jobs.clear()
        self.env.stop()

    def upload(self):
        response = self.client.post('/jobs', content=b'fake video', headers=self.headers)
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()['id']

    def test_auth_upload_status_owner_and_file(self):
        self.assertEqual(self.client.post('/jobs', content=b'bad').status_code, 401)
        job_id = self.upload()
        self.assertEqual(self.client.get('/jobs/' + job_id, headers=self.headers).json()['status'], 'queued')
        other = {'Authorization': 'Bearer ' + music_config()[1]['token']}
        self.assertEqual(self.client.get('/jobs/' + job_id, headers=other).status_code, 404)
        self.assertEqual(self.client.get('/jobs/' + job_id + '/file', headers=self.headers).status_code, 409)
        job = service.jobs[job_id]
        Path(job['directory'], 'voz.mp4').write_bytes(b'output video')
        job['status'] = 'completed'
        response = self.client.get('/jobs/' + job_id + '/file', headers=self.headers)
        self.assertEqual(response.content, b'output video')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertNotIn('directory', self.client.get('/jobs/' + job_id, headers=self.headers).json())

    def test_empty_oversized_and_duplicate_uploads(self):
        self.assertEqual(self.client.post('/jobs', content=b'', headers=self.headers).status_code, 400)
        self.assertFalse(service.jobs)
        with patch.object(service, 'MAX_BYTES', 4):
            self.assertEqual(self.client.post('/jobs', content=b'12345', headers=self.headers).status_code, 413)
        self.upload()
        self.assertEqual(self.client.post('/jobs', content=b'new', headers=self.headers).status_code, 409)

    def test_queue_is_bounded(self):
        for i in range(1):
            self.token = music_config()[1]['token']
            self.headers['Authorization'] = 'Bearer ' + self.token
            self.upload()
        self.headers['Authorization'] = 'Bearer ' + music_config()[1]['token']
        self.assertEqual(self.client.post('/jobs', content=b'next', headers=self.headers).status_code, 429)

    def test_tampered_and_expired_tokens(self):
        headers = {**self.headers, 'Authorization': self.headers['Authorization'] + 'bad'}
        self.assertEqual(self.client.post('/jobs', content=b'x', headers=headers).status_code, 401)
        with patch('api.music.time.time', return_value=time.time() - 4000):
            token = music_config()[1]['token']
        headers['Authorization'] = 'Bearer ' + token
        self.assertEqual(self.client.post('/jobs', content=b'x', headers=headers).status_code, 401)

    def test_failed_processing_does_not_publish_silent_video(self):
        job_id = self.upload()
        directory = service.jobs[job_id]['directory']
        with patch.object(service, 'process_video', side_effect=ProcessingError('Sem áudio.')):
            service.execute(job_id)
        self.assertEqual(service.jobs[job_id]['status'], 'failed')
        self.assertFalse(Path(directory).exists())
        self.assertEqual(self.client.get('/jobs/' + job_id + '/file', headers=self.headers).status_code, 409)

    def test_cleanup_preserves_running_jobs_and_removes_expired_results(self):
        job_id = self.upload()
        job = service.jobs[job_id]
        service.cleanup(time.time() + 4000)
        self.assertIn(job_id, service.jobs)
        job['status'] = 'completed'
        service.cleanup(time.time() + 4000)
        self.assertNotIn(job_id, service.jobs)
        self.assertFalse(Path(job['directory']).exists())


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg needed')
class MediaTests(unittest.TestCase):
    def test_real_ffmpeg_mux_retains_video_audio_and_duration(self):
        # Only model inference is substituted; extraction and muxing use real FFmpeg.
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, 'input.video')
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x120:d=1',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264',
                            '-c:a', 'aac', '-shortest', '-f', 'mp4', str(source)], check=True)
            from music_service import processing
            real_run = processing.run
            def fake_separator(command, timeout=180):
                if 'demucs' in command:
                    vocals = Path(directory, 'stems/htdemucs/audio/vocals.wav')
                    vocals.parent.mkdir(parents=True)
                    shutil.copyfile(Path(directory, 'audio.wav'), vocals)
                    return None
                return real_run(command, timeout)
            with patch.object(processing, 'run', side_effect=fake_separator):
                output = process_video(directory, lambda _: None)
            info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
            self.assertEqual({s['codec_type'] for s in info['streams']}, {'audio', 'video'})
            self.assertAlmostEqual(float(info['format']['duration']), 1, delta=0.15)

    def test_no_audio_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x120:d=1',
                            '-c:v', 'libx264', '-f', 'mp4', str(Path(directory, 'input.video'))], check=True)
            with self.assertRaisesRegex(ProcessingError, 'não possui áudio'):
                process_video(directory, lambda _: None)
