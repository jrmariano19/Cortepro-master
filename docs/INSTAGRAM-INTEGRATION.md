# Integração do Instagram — CortePro

## Estado atual

A integração de download do Instagram ainda não está ativa. O CortePro reconhece links, mas não deve indicar que um vídeo foi baixado enquanto não houver um fluxo real, autorizado e testado.

## Limite da API oficial

A Instagram Platform API documentada pela Meta atende contas profissionais (Business ou Creator). Contas pessoais comuns não são suportadas. A API atua dentro das permissões concedidas pela conta que autorizou o aplicativo; ela não é uma API para baixar qualquer vídeo público de terceiros.

Fonte: documentação da Meta — https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## Próximos passos técnicos

1. Criar/configurar um aplicativo em Meta for Developers.
2. Definir o fluxo Instagram Login e a URL de redirecionamento HTTPS do CortePro.
3. Solicitar somente as permissões necessárias para o caso de uso aprovado.
4. Implementar OAuth no servidor, validar o parâmetro state e proteger tokens em variáveis de ambiente/armazenamento seguro.
5. Acessar somente mídia e operações disponibilizadas pela API para a conta que autorizou o aplicativo.
6. Implementar testes de autorização, expiração de token, erros e ausência de mídia.
7. Só então habilitar a integração no registro de provedores.

## O que não será implementado

- Coleta automatizada/scraping sem autorização expressa da Meta.
- Bypass de login, DRM, paywall, controles de privacidade ou outras proteções.
- Download de mídia de terceiros fora das permissões e condições aplicáveis.

## Situação desta versão

Esta alteração prepara a documentação e a interface. Não adiciona OAuth, não acessa contas Instagram e não realiza downloads.
