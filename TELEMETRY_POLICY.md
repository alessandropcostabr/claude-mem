# Política de telemetria

Este fork não coleta nem envia telemetria de produto, analytics de uso ou
identificadores de instalação para serviços de terceiros.

São permitidos apenas:

- logs e métricas operacionais mantidos no ambiente administrado pelo usuário;
- contadores locais usados para diagnóstico e health checks;
- chamadas explícitas aos provedores configurados pelo usuário para gerar ou
  buscar memórias;
- cabeçalhos opcionais de atribuição do OpenRouter, quando configurados pelo
  próprio usuário.

Dependências ou endpoints de analytics (PostHog, Sentry, Mixpanel, Amplitude e
Segment) não podem ser adicionados ao código executável nem aos manifestos. O
teste `tests/infrastructure/no-product-telemetry.test.ts` protege esse contrato.
