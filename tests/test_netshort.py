import json
import unittest
from unittest.mock import patch
from lib.netshort import current_episode, download_episode, read_public

URL='https://netshort.com/pt/episode/example-2110223176241958913-ep-4'
def page(**kwargs):
    episode={'episodeNo':4,'isLock':False,'playVoucher':'https://cfcdn.netshort.com/public','duration':'275.25',**kwargs}
    return 'self.__next_f.push('+json.dumps([1,'0:'+json.dumps({'initialCurrentEpisodeInfo':episode},separators=(',',':'))])+')'
class NetShortTests(unittest.TestCase):
    def test_current_episode(self):
        self.assertEqual(current_episode(page(),4)['episodeNo'],4)
        for html in [page(isLock=True),page(isLock=None),page(episodeNo=3),page(playVoucher=''),'<html>no video</html>']:
            with self.assertRaises(ValueError):current_episode(html,4)
    def test_public_media(self):
        with patch('lib.netshort.read_public',side_effect=[page().encode(),b'\x00\x00\x00\x20ftypisom']):
            result=download_episode(URL)
            self.assertEqual(result['episode'],4)
            self.assertEqual(result['duration'],275.25)
            self.assertEqual(result['filename'],'CortePro_NetShort_Episodio_04.mp4')
    def test_locked_does_not_probe_media(self):
        with patch('lib.netshort.read_public',return_value=page(isLock=True).encode()) as read:
            with self.assertRaises(ValueError):download_episode(URL)
            self.assertEqual(read.call_count,1)
    def test_invalid_media(self):
        with patch('lib.netshort.read_public',side_effect=[page().encode(),b'<html>blocked</html>']):
            with self.assertRaises(ValueError):download_episode(URL)
        with self.assertRaises(ValueError):read_public('https://evil.test/file',('cfcdn.netshort.com',),64)
    def test_wrong_page(self):
        with self.assertRaises(ValueError):download_episode(URL.replace('/episode/','/full-episodes/'))
if __name__=='__main__':unittest.main()
