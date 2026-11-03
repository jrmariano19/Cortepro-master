import unittest
from unittest.mock import patch, MagicMock
from api.extract import extract_video, validate_url, ExtractionError, classify_error, FORMAT
from yt_dlp import YoutubeDL
from api.extract import legacy_provider, usable_media, StructuredVideos, kwai_video
import json
from urllib.error import HTTPError

PUBLIC_DNS = [(2, 1, 6, '', ('93.184.216.34', 443))]

class ExtractionTests(unittest.TestCase):
    def test_format_selection_accepts_missing_codec_metadata_but_not_silent_track(self):
        formats = [
            {'format_id': 'instagram', 'ext': 'mp4', 'protocol': 'https', 'url': 'https://cdn.example.com/a.mp4'},
            {'format_id': 'silent', 'ext': 'mp4', 'protocol': 'https', 'url': 'https://cdn.example.com/b.mp4', 'acodec': 'none', 'vcodec': 'h264'},
        ]
        with YoutubeDL({'quiet': True, 'no_warnings': True}) as engine:
            selected = list(engine.build_format_selector(FORMAT)({'formats': formats, 'has_merged_format': True, 'incomplete_formats': False}))
        self.assertEqual([item['format_id'] for item in selected], ['instagram'])

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_direct_mp4_does_not_call_social_extractor(self, dns):
        with patch('api.extract.YoutubeDL') as engine:
            result = extract_video('https://example.com/video.mp4?token=123')
        self.assertTrue(result['success'])
        self.assertEqual(result['downloadUrl'], 'https://example.com/video.mp4?token=123')
        engine.assert_not_called()

    def test_rejects_fake_social_hostname_and_non_http(self):
        for url in ['https://instagram.com.evil.example/reel/abc', 'file:///a.mp4', 'https://u:p@instagram.com/p/a', None, ['https://instagram.com']]:
            with self.subTest(url=url), self.assertRaises(ExtractionError):
                validate_url(url)

    @patch('api.extract.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))])
    def test_rejects_private_direct_media(self, dns):
        with self.assertRaises(ExtractionError):
            validate_url('https://example.com/test.mp4')

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_social_video_contract_and_filename(self, dns):
        with patch('api.extract.YoutubeDL') as engine:
            engine.return_value.__enter__.return_value.extract_info.return_value = {
                'url': 'https://cdn.example.com/a.mp4', 'title': '<test>', 'ext': 'mp4', 'acodec': 'aac', 'vcodec': 'h264'}
            result = extract_video('https://www.instagram.com/reel/abc/')
        self.assertTrue(result['success'])
        self.assertEqual(result['filename'], 'CortePro__test_.mp4')

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_silent_track_is_not_success(self, dns):
        with patch('api.extract.YoutubeDL') as engine:
            engine.return_value.__enter__.return_value.extract_info.return_value = {
                'url': 'https://cdn.example.com/a.mp4', 'ext': 'mp4', 'acodec': 'none'}
            with self.assertRaises(ExtractionError):
                extract_video('https://www.youtube.com/watch?v=abc')

    def test_platform_block_has_actionable_error(self):
        self.assertEqual(classify_error('Please log in to continue').code, 'ACCESS_RESTRICTED')
        self.assertEqual(classify_error('HTTP Error 429').status, 429)
        self.assertEqual(classify_error('Connection timed out').status, 502)

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_original_video_without_audio_is_supported(self, dns):
        with patch('api.extract.YoutubeDL') as engine:
            engine.return_value.__enter__.return_value.extract_info.return_value = {
                'url': 'https://cdn.example.com/a.mp4', 'ext': 'mp4', 'vcodec': 'h264', 'acodec': 'none',
                'formats': [{'vcodec': 'h264', 'acodec': 'none'}]}
            result = extract_video('https://www.instagram.com/reel/abc/')
        self.assertTrue(result['success'])
        self.assertTrue(result['originalSilent'])

class SocialDownloadTests(unittest.TestCase):
    def test_kwai_reads_public_video_jsonld_and_not_thumbnail(self):
        parser = StructuredVideos()
        parser.feed('<script type="application/ld+json">'+json.dumps({
            '@graph': [{'@type': 'ImageObject', 'contentUrl': 'https://cdn.example.com/cover.jpg'},
                       {'@type': 'VideoObject', 'contentUrl': 'https://cdn.example.com/a.mp4?x=1&y=2'}]})+'</script>')
        self.assertEqual([v['contentUrl'] for v in parser.videos], ['https://cdn.example.com/a.mp4?x=1&y=2'])

    @patch('api.extract.usable_media', side_effect=[False, True])
    @patch('api.extract.urlopen')
    def test_tiktok_skips_blocked_file_and_uses_valid_alternative(self, open_url, probe):
        response = open_url.return_value.__enter__.return_value
        response.read.return_value = json.dumps({'code': 0, 'data': {
            'play': 'https://blocked.example.com/a.mp4', 'hdplay': 'https://cdn.example.com/a.mp4'}}).encode()
        result = legacy_provider('https://vt.tiktok.com/abc/')
        self.assertEqual(result['downloadUrl'], 'https://cdn.example.com/a.mp4')
        request = open_url.call_args.args[0]
        self.assertIn('hd=1', request.full_url)
        self.assertIn('Mozilla', request.get_header('User-agent'))

    @patch('api.extract.usable_media', return_value=False)
    @patch('api.extract.urlopen')
    def test_tiktok_never_reports_success_for_blocked_files(self, open_url, probe):
        open_url.return_value.__enter__.return_value.read.return_value = json.dumps({
            'code': 0, 'data': {'play': 'https://cdn.example.com/forbidden.mp4'}}).encode()
        self.assertIsNone(legacy_provider('https://vt.tiktok.com/abc/'))

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.urlopen')
    def test_media_probe_rejects_html_and_accepts_mp4_bytes(self, open_url, dns):
        response = open_url.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'<html>Forbidden</html>'
        self.assertFalse(usable_media('https://cdn.example.com/file.mp4'))
        response.status = 206
        response.read.return_value = b'\x00\x00\x00\x20ftypisom'
        self.assertTrue(usable_media('https://cdn.example.com/file.mp4'))
        open_url.side_effect = HTTPError('https://cdn.example.com/file.mp4',403,'Forbidden',{},None)
        self.assertFalse(usable_media('https://cdn.example.com/file.mp4'))

    @patch('api.extract.usable_media', return_value=True)
    @patch('api.extract.urlopen')
    def test_kwai_native_returns_public_metadata_video(self, open_url, probe):
        response = open_url.return_value.__enter__.return_value
        response.url = 'https://www.kwai.com/@author/video/123'
        response.read.return_value = b'<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.com/a.mp4"}</script>'
        result = kwai_video('https://k.kwai.com/p/abc')
        self.assertEqual(result['downloadUrl'],'https://cdn.example.com/a.mp4')

if __name__ == '__main__':
    unittest.main()
