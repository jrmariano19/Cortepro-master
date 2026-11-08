"""Extract only the explicitly unlocked current episode from public page data."""
import json
import re
from urllib.parse import urlsplit, unquote, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('A NetShort redirecionou a consulta. Copie o link oficial do episódio.')


def read_public(url, hosts, limit, media=False):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None,443):
        raise ValueError('A NetShort retornou um endereço de vídeo inválido.')
    headers={'User-Agent':'Mozilla/5.0'}
    if media:headers['Range']='bytes=0-63'
    with build_opener(NoRedirect()).open(Request(url,headers=headers),timeout=15) as response:
        if response.status not in (200,206):raise ValueError('A NetShort não disponibilizou o vídeo agora.')
        data=response.read(limit+1)
        if not media and len(data)>limit:raise ValueError('A página excedeu o limite de leitura.')
        return data[:limit]


def current_episode(html, expected):
    decoder=json.JSONDecoder()
    for match in re.finditer(r'self\.__next_f\.push\(',html):
        try:
            chunk,_=decoder.raw_decode(html[match.end():])
            if not isinstance(chunk,list) or len(chunk)<2 or not isinstance(chunk[1],str):continue
            payload=chunk[1]
            marker='"initialCurrentEpisodeInfo":'
            pos=payload.find(marker)
            if pos<0:continue
            episode,_=decoder.raw_decode(payload[pos+len(marker):])
            if not isinstance(episode,dict) or episode.get('episodeNo')!=expected:continue
            if episode.get('isLock') is not False:
                raise ValueError('Este episódio está bloqueado na NetShort. O CortePro não pode baixar o conteúdo bloqueado.')
            media=episode.get('playVoucher')
            if not isinstance(media,str) or not media.startswith('https://'):
                raise ValueError('A NetShort não forneceu um vídeo público para este episódio.')
            return episode
        except (json.JSONDecodeError,TypeError,IndexError):continue
    raise ValueError('Não encontramos o vídeo público deste episódio. Confira o link na NetShort.')


def download_episode(url):
    parsed=urlsplit(url)
    path=unquote(parsed.path)
    match=re.fullmatch(r'/pt/episode/[\w-]+-\d{10,25}(?:-ep-(\d+))?',path)
    if not match or parsed.query or parsed.fragment or parsed.hostname not in ('netshort.com','www.netshort.com'):
        raise ValueError('Use o link de um episódio individual da NetShort, não a lista da série.')
    expected=int(match[1] or '1')
    canonical='https://netshort.com'+quote(path,safe='/')
    page=read_public(canonical,('netshort.com',),3_000_000).decode('utf-8')
    episode=current_episode(page,expected)
    media=episode['playVoucher']
    prefix=read_public(media,('cfcdn.netshort.com',),64,media=True)
    if prefix[4:8]!=b'ftyp':raise ValueError('A fonte não retornou um arquivo MP4 válido para este episódio.')
    try:duration=float(episode.get('duration',0))
    except (ValueError,TypeError):duration=0
    return {'success':True,'downloadUrl':media,'filename':f'CortePro_NetShort_Episodio_{expected:02d}.mp4','episode':expected,'duration':duration}
