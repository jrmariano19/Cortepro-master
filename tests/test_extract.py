import unittest
from unittest.mock import patch
from api.extract import extract_video, validate_url, ExtractionError, classify_error, FORMAT
from yt_dlp import YoutubeDL

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

if __name__ == '__main__':
    unittest.main()
