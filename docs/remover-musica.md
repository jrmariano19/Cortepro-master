# Remover música — 8.1.0 (em preparação)

A aba Divisor é substituída por Remover música. O formulário, as funções JavaScript do baixador, `api/extract.py`, suas dependências e configuração continuam iguais. Não publicar a mudança em produção antes de disponibilizar e validar o processador.

## Processamento

O navegador envia o vídeo diretamente ao serviço dedicado, sem passar pelo endpoint de download nem pelo limite de upload das funções Vercel. FFmpeg extrai a primeira faixa de áudio, Demucs `htdemucs` separa `vocals` e FFmpeg combina essa faixa com o vídeo. Nunca há fallback para silenciar todo o áudio. O vídeo é copiado quando possível; codecs incompatíveis com MP4 são convertidos para H.264. Limites iniciais: 200 MiB, 600 segundos, um envio/processamento por vez, recusando novos vídeos enquanto ocupado. Canto pode permanecer, instrumentos podem vazar e a voz pode sofrer artefatos; não promete separação perfeita de diálogo.

## Hospedagem necessária

Usar um container de longa duração, uma réplica e um worker Uvicorn, com HTTPS, pelo menos 4 GB de RAM (8 GB recomendado) e espaço temporário de disco. CPU funciona; validar tempo e memória no host escolhido. Esta implementação mantém a fila em memória e arquivos em disco temporário; não usar como função serverless nem escalar para várias réplicas. Reinício perde os trabalhos; a interface apresenta erro. Para escalar, trocar fila e arquivos por armazenamento compartilhado.

Na raiz do repositório:

```sh
docker build -f music_service/Dockerfile -t cortepro-musica .
```

Configurar no container sem versionar valores:

- `MUSIC_SERVICE_SECRET`: segredo aleatório de pelo menos 32 caracteres.
- `MUSIC_ALLOWED_ORIGIN`: `https://cortepro-master.vercel.app` (origem exata; ajustar para uma prévia ao testar).
- `MUSIC_DEVICE`: `cpu` por padrão.

No projeto Vercel CortePro, definir:

- `MUSIC_SERVICE_URL`: origem HTTPS do container, sem caminho.
- `MUSIC_SERVICE_SECRET`: mesmo segredo do container.

`GET /api/music` emite uma sessão assinada de uma hora. O segredo nunca chega ao navegador. Upload, consulta e download exigem Bearer token e isolam resultados por sessão; tokens não são colocados em URLs nem armazenamento do navegador. O frontend público não autentica usuários: antes de exposição ampla, aplicar rate limit no proxy do processador e em `/api/music`. A fila limitada evita paralelismo ilimitado, mas não substitui cotas por usuário.

Configure o proxy do container para aceitar 200 MiB e uploads de até 10 minutos. Resultado e metadados expiram uma hora após conclusão, com limpeza periódica. Intermediários são excluídos após sucesso/falha. Um reinício inesperado pode deixar temporários no volume: usar disco efêmero e política de limpeza do host. Não montar armazenamento permanente contendo vídeos pessoais sem política de retenção.

## Validação antes de publicar

1. Executar `node tests/frontend.test.js`, `node tests/music.test.js`, `python -m unittest discover -s tests`.
2. Construir a imagem e testar `/health`, emissão de token, upload, consulta, download e expiração com o container real.
3. Processar clipe com fala e música conhecidas; ouvir antes/depois, conferir sincronização, duração, reprodução e download no Android. Demucs e a imagem precisam ser testados no host; testes com mocks não demonstram a qualidade de separação.
4. Revalidar os mesmos links de Instagram, TikTok e Kwai usados na versão 8.0.4. O baixador não depende da configuração de áudio.

Fontes técnicas: https://github.com/facebookresearch/demucs e https://vercel.com/docs/functions/limitations.
