# AlquilApp — Bot de WhatsApp

Asistente de gestión de alquileres por WhatsApp para [alquil.app](https://alquil.app), construido sobre Twilio + Supabase + LLMs (Gemini/Groq/Cohere/DeepSeek). Responde consultas jurídico-operativas sobre locaciones en Argentina usando RAG (pgvector) sobre normativa vigente (CCyC, DNU 70/2023, normativa provincial), y opera flujos de gestión: recibos en PDF, facturas de servicios, recordatorios, confirmación de pagos, reclamos y morosidad.

## Características

- **RAG jurídico** con embeddings de Gemini + `pgvector` en Supabase (threshold 0.50, k=8), con guardrails de temporalidad normativa (vigente vs. derogada) y citación obligatoria de artículos cuando están en el contexto recuperado.
- **Clasificador de intención con LLM** (Gemini Flash, temperature 0) en lugar de regex, para evitar falsos positivos entre consultas y flujos operativos.
- **Disclaimer legal automático**: post-procesador que agrega la recomendación de consultar a un abogado cuando la respuesta cita normativa nominada.
- **Recibos PDF** (pdfkit), gestión de facturas por IMAP/forwarding, delegación de administradores y permisos.
- **Proxy de IA** (`/ai/*`) para no exponer API keys en el frontend, con allowlist de orígenes y secret compartido opcional (`AI_PROXY_SECRET`).

## QA automatizado

El repo incluye un sistema de evaluación continua en [`scripts/qa/`](scripts/qa/):

- Banco de **105 preguntas** organizadas por bloque temático (locación básica, DNU 70, sellado provincial, desalojo, fianza, impuestos, jurisprudencia, edge cases, artículos del CCyC).
- `runner.mjs` corre el banco contra el endpoint `POST /ai/qa-test` (autenticado por `x-qa-secret`), que reproduce el pipeline real (embedding → RAG → LLM) de forma aislada.
- GitHub Action con cron cada 2 días que ejecuta la corrida y commitea el reporte en [`qa-reports/`](qa-reports/) (JSON + Markdown).
- El changelog de versiones (header de `index.js`) documenta qué caso del QA cierra cada cambio.

## Configuración

1. Copiar `.env.example` a `.env` y completar credenciales (Twilio, Gemini, Supabase service key, secrets).
2. `npm install && npm start` (Node ≥ 18).
3. Aplicar las migraciones SQL (`supabase-migrations.sql` y `migration-admin*.sql`) en Supabase.
4. Configurar el webhook de Twilio apuntando a `POST /webhook`.

Deploy soportado en Railway (`railway.toml`), Render (`render.yaml`) o Docker (`Dockerfile`).

> ⚠️ **Seguridad**: generar valores aleatorios propios para `NOTIF_SECRET`, `QA_TEST_SECRET` y `AI_PROXY_SECRET` (ej. `openssl rand -hex 24`). Nunca reutilizar los valores de ejemplo.

## Guía completa

Ver [`GUIA_CONFIGURACION.md`](GUIA_CONFIGURACION.md) para el paso a paso detallado.
