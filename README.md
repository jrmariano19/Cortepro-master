# CortePro

Interface web para reconhecer links públicos de TikTok, Kwai, Instagram, Facebook e YouTube.

## Estado atual
- Reconhecimento de plataforma e validação de URL: implementados.
- Interface responsiva em português: implementada.
- API `POST /api/detect`: implementada.
- Extração/download: desabilitado até existir integração oficial ou contratualmente autorizada para cada plataforma.
- Testes automatizados: `npm test`.

## Segurança
Somente URLs HTTPS de domínios explicitamente permitidos são reconhecidas. A aplicação não busca URLs fornecidas pelo usuário, não funciona como proxy aberto e não contorna autenticação, DRM, privacidade ou restrições das plataformas.

## API
`POST /api/detect` recebe JSON `{"url":"https://..." }` e retorna a plataforma reconhecida.
`POST /api/extract` retorna HTTP 501 (`INTEGRATION_UNAVAILABLE`) para links reconhecidos até que exista um adaptador autorizado.

## Desenvolvimento
Requer Node.js 20 ou superior. Execute `npm test`.

## Direitos
Use somente vídeos próprios, licenciados ou cujo titular autorizou o download. Disponibilidade técnica e permissão legal são coisas diferentes. Consulte os termos e APIs oficiais antes de habilitar adaptadores.
