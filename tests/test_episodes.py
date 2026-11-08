import unittest
from unittest.mock import patch
from api.episodes import series_path, parse_episodes, get_episodes

BASE = '/pt/episode/example-2108502039966322689'
class EpisodeTests(unittest.TestCase):
    def test_input(self):
        self.assertEqual(series_path('https://netshort.com' + BASE + '-ep-10'), BASE)
        self.assertEqual(series_path('https://netshort.com' + BASE.replace('/episode/', '/full-episodes/')), BASE)
        for url in ['http://netshort.com'+BASE, 'https://evil.test'+BASE, 'https://netshort.com@evil.test'+BASE, 'https://netshort.com:443'+BASE, 'https://netshort.com/pt/episode/../test-2108502039966322689']:
            with self.assertRaises(ValueError):series_path(url)
    def test_only_observed_same_series_links(self):
        html = ''.join('<a href="'+href+'">Link</a>' for href in [BASE+'-ep-3',BASE,BASE+'-ep-1',BASE+'-ep-2',BASE+'-ep-2','https://evil.test'+BASE+'-ep-4',BASE+'-other-ep-5',BASE+'-ep-0'])
        results = parse_episodes(html,BASE)
        self.assertEqual([e['number'] for e in results],[1,2,3])
        self.assertTrue(all(e['url'].startswith('https://netshort.com/') for e in results))
    def test_pagination_and_partial_failure(self):
        def page(url):
            numbers = range(21, 24) if url.endswith('/page/2') else range(1,21)
            return '23 episódios no total' + ''.join('<a href="'+BASE+'-ep-'+str(n)+'">e</a>' for n in numbers)
        with patch('api.episodes.fetch_page',side_effect=page):
            result = get_episodes('https://netshort.com'+BASE)
            self.assertEqual(len(result['episodes']),23)
            self.assertTrue(result['complete'])
        def broken(url):
            if '/page/' in url:raise TimeoutError()
            return page(url)
        with patch('api.episodes.fetch_page',side_effect=broken):
            result = get_episodes('https://netshort.com'+BASE)
            self.assertEqual(len(result['episodes']),20)
            self.assertFalse(result['complete'])
if __name__ == '__main__':unittest.main()
