import json
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError
from api.extract import (ShopeeVideoPage, shopee_request, shopee_video, extract_video,
                         validate_url, ExtractionError, SHOPEE_HOSTS, SHOPEE_MEDIA_HOSTS)

PUBLIC_DNS = [(2, 1, 6, '', ('93.184.216.34', 443))]
MEDIA = 'https://down-ws-br.vod.susercontent.com/api/v4/test.mp4'
PAGE = ('<script id="__NEXT_DATA__" type="application/json">' + json.dumps({
    'props': {'pageProps': {'mediaInfo': {'video': {'watermarkVideoUrl': MEDIA,
        'watermarkCoverUrl': 'https://mms.img.susercontent.com/cover.jpg'}}}},
    'recommendations': [{'videoUrl': 'https://example.com/wrong.mp4'}]
}) + '</script>').encode()


class ShopeeTests(unittest.TestCase):
    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_accepts_brazilian_video_and_short_links(self, dns):
        for url in ('https://br.shp.ee/example?fromSource=share',
                    'https://sv.shopee.com.br/share-video/example==',
                    'https://s.shopee.com.br/example'):
            self.assertEqual(validate_url(url), (url, False))
        for url in ('https://br.shp.ee.evil.example/a', 'https://shopee.com.br.evil.example/a'):
            with self.assertRaises(ExtractionError):
                validate_url(url)

    def test_parser_selects_shared_video_not_cover_or_recommendation(self):
        parser = ShopeeVideoPage()
        parser.feed(PAGE.decode())
        self.assertEqual(parser.video['watermarkVideoUrl'], MEDIA)
        parser = ShopeeVideoPage()
        parser.feed('<script id="__NEXT_DATA__">not json</script>')
        self.assertIsNone(parser.video)

    @patch('api.extract.shopee_request')
    def test_returns_probed_mp4_with_watermark_url_unchanged(self, request):
        request.side_effect = [(PAGE, 'https://sv.shopee.com.br/share-video/x'),
                               (b'\x00\x00\x00\x20ftypisom', MEDIA)]
        result = shopee_video('https://br.shp.ee/x')
        self.assertEqual(result['downloadUrl'], MEDIA)
        self.assertEqual(result['filename'], 'CortePro_Shopee.mp4')
        self.assertTrue(result['success'])

    @patch('api.extract.shopee_request')
    def test_rejects_missing_video_and_html_instead_of_media(self, request):
        request.return_value = (b'<html>login</html>', 'https://shopee.com.br/login')
        with self.assertRaises(ExtractionError) as ctx:
            shopee_video('https://br.shp.ee/x')
        self.assertEqual(ctx.exception.code, 'SHOPEE_NO_PUBLIC_VIDEO')
        request.side_effect = [(PAGE, 'https://sv.shopee.com.br/share-video/x'),
                               (b'<html>Forbidden</html>', MEDIA)]
        with self.assertRaises(ExtractionError) as ctx:
            shopee_video('https://br.shp.ee/x')
        self.assertEqual(ctx.exception.code, 'SHOPEE_MEDIA_UNAVAILABLE')

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.build_opener')
    def test_redirect_is_validated_before_following(self, build, dns):
        opener = build.return_value
        opener.open.side_effect = HTTPError('https://br.shp.ee/x', 302, 'Found',
                                            {'Location': 'http://127.0.0.1/internal'}, None)
        with self.assertRaises(ExtractionError):
            shopee_request('https://br.shp.ee/x', SHOPEE_HOSTS, 100)
        self.assertEqual(opener.open.call_count, 1)
        self.assertNotIn('Android', opener.open.call_args.args[0].get_header('User-agent'))

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.build_opener')
    def test_safe_relative_redirect_is_followed(self, build, dns):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status, response.read.return_value = 200, b'public'
        build.return_value.open.side_effect = [HTTPError('https://br.shp.ee/x', 302, 'Found',
                                               {'Location': '/public'}, None), response]
        self.assertEqual(shopee_request('https://br.shp.ee/x', SHOPEE_HOSTS, 100),
                         (b'public', 'https://br.shp.ee/public'))

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.build_opener')
    def test_cdns_are_allowlisted_and_login_not_bypassed(self, build, dns):
        for url in ('https://evil.example/file.mp4', 'https://susercontent.com.evil.example/a.mp4'):
            with self.assertRaises(ExtractionError):
                shopee_request(url, SHOPEE_MEDIA_HOSTS, 64, media=True)
        build.return_value.open.assert_not_called()
        build.return_value.open.side_effect = HTTPError(MEDIA, 403, 'Forbidden', {}, None)
        with self.assertRaises(ExtractionError) as ctx:
            shopee_request(MEDIA, SHOPEE_MEDIA_HOSTS, 64, media=True)
        self.assertEqual(ctx.exception.status, 403)

    @patch('api.extract.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))])
    @patch('api.extract.build_opener')
    def test_private_dns_never_fetched(self, build, dns):
        with self.assertRaises(ExtractionError):
            shopee_request('https://sv.shopee.com.br/a', SHOPEE_HOSTS, 100)
        build.return_value.open.assert_not_called()

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.shopee_video', return_value={'success': True})
    @patch('api.extract.legacy_provider')
    @patch('api.extract.YoutubeDL')
    def test_shopee_does_not_touch_existing_providers(self, engine, legacy, native, dns):
        self.assertTrue(extract_video('https://br.shp.ee/x')['success'])
        engine.assert_not_called()
        legacy.assert_not_called()

    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    @patch('api.extract.shopee_video')
    @patch('api.extract.legacy_provider', return_value=None)
    @patch('api.extract.YoutubeDL')
    def test_existing_platforms_do_not_call_shopee(self, engine, legacy, shopee, dns):
        engine.return_value.__enter__.return_value.extract_info.return_value = {
            'url': 'https://cdn.example.com/a.mp4', 'ext': 'mp4', 'vcodec': 'h264', 'acodec': 'aac'}
        for url in ('https://www.instagram.com/reel/test/', 'https://facebook.com/watch/?v=123'):
            self.assertTrue(extract_video(url)['success'])
        shopee.assert_not_called()


if __name__ == '__main__':
    unittest.main()
