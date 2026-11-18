import unittest
from unittest.mock import patch
from api.extract import MercadoLivreVideoPage, mercadolivre_video, validate_url, ExtractionError

PUBLIC_DNS = [(2, 1, 6, '', ('93.184.216.34', 443))]
MEDIA = 'https://video.mlstatic.com/product.mp4'

class MercadoLivreTests(unittest.TestCase):
    @patch('api.extract.socket.getaddrinfo', return_value=PUBLIC_DNS)
    def test_accepts_short_and_product_links(self, dns):
        for url in ('https://meli.la/1P9JpCn', 'https://www.mercadolivre.com.br/produto'):
            self.assertEqual(validate_url(url), (url, False))
        with self.assertRaises(ExtractionError):
            validate_url('https://meli.la.evil.example/product')

    def test_video_object_metadata(self):
        parser = MercadoLivreVideoPage()
        parser.feed('<script type="application/ld+json">{"@type":"Product","video":{"@type":"VideoObject","contentUrl":"'+MEDIA+'"}}'+'</script>')
        self.assertEqual(parser.videos, [MEDIA])

    @patch('api.extract.shopee_request')
    def test_public_mp4(self, request):
        page = ('<meta property="og:video" content="'+MEDIA+'">').encode()
        request.side_effect = [(page, 'https://www.mercadolivre.com.br/item'), (b'\\x00\\x00\\x00\\x20ftypisom', MEDIA)]
        self.assertEqual(mercadolivre_video('https://meli.la/1P9JpCn')['downloadUrl'], MEDIA)

    @patch('api.extract.shopee_request')
    def test_no_video(self, request):
        request.return_value = (b'<html></html>', 'https://www.mercadolivre.com.br/item')
        with self.assertRaises(ExtractionError) as ctx:
            mercadolivre_video('https://meli.la/1P9JpCn')
        self.assertEqual(ctx.exception.code, 'MELI_NO_PUBLIC_VIDEO')

if __name__ == '__main__':
    unittest.main()
