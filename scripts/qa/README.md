# QA Bot — AlquilApp

Sistema de QA automatizado del chatbot de WhatsApp. Corre un banco de preguntas reales contra el bot en Railway y clasifica las respuestas.

## Archivos

- `preguntas.json` — banco de preguntas (64+, organizadas por bloque: locacion_basica, dnu_70, sellado_provincial, desalojo, fianza, casos_especiales, features_alquilapp, impuestos, jurisprudencia, edge_cases, ccyc_articulos).
- `runner.mjs` — script que corre el banco contra el bot y genera reporte.

## Endpoint testeado

El runner llama al endpoint `POST /ai/qa-test` del bot. Este endpoint:

1. Genera embedding de la pregunta con Gemini.
2. Llama al RPC `match_documentos_chatbot` en Supabase (threshold 0.35, k=4).
3. Arma el mismo system prompt que el bot real (con reglas de estilo + inyección RAG).
4. Llama a Gemini 2.5 Flash con la pregunta.
5. Devuelve `{respuesta, rag:{docs_recuperados, docs:[...]}, tiempos_ms, llm_error?}`.

### Autenticación

El endpoint requiere el header `x-qa-secret` con un valor que debe coincidir con la env var `QA_TEST_SECRET` del bot.

## Cómo usar (local)

```bash
# Desde la raíz del repo
export BOT_URL="https://alquilapp-bot.railway.app"
export QA_SECRET="<valor idéntico a QA_TEST_SECRET en Railway>"
node scripts/qa/runner.mjs
```

### Flags opcionales (env vars)

| Variable | Default | Uso |
|---|---|---|
| `QA_CONCURRENCY` | `2` | Preguntas en paralelo. No subir mucho o Gemini tira 429. |
| `QA_TIMEOUT_MS` | `60000` | Timeout por request. |
| `QA_BLOQUE` | — | Correr solo un bloque. Ej: `QA_BLOQUE=fianza`. |
| `QA_LIMIT` | — | Correr solo las primeras N preguntas (útil para debug). |

## Reportes

El runner escribe dos archivos en `qa-reports/`:

- `YYYY-MM-DD_HH-mm.json` — resultados crudos (pregunta, respuesta, docs RAG, tiempos, clasificación).
- `YYYY-MM-DD_HH-mm.md` — resumen legible con conteo por clasificación y detalle de fallos.

## Sistema de clasificación

| Símbolo | Significado |
|---|---|
| 🟢 | Respuesta correcta. Todas las `keywords_esperadas` aparecen, o la pregunta debía rechazarse y fue rechazada. |
| 🟡 | Parcial. Algunas keywords aparecen pero no todas. Requiere revisión. |
| 🟠 | Débil. 0 keywords aparecen o no rechazó una pregunta fuera de tema. |
| 🔴 | Fallo. Sin respuesta, error LLM, o dijo alguna frase prohibida (`no_debe_decir`). |
| ⚫ | Error de red o timeout. |

El runner termina con **exit code 1** si hay al menos un 🔴 o ⚫, lo cual hace fallar el workflow de GitHub Actions.

## Cómo agregar preguntas al banco

Editar `preguntas.json`. Estructura mínima:

```json
{
  "id": "blq-NN",
  "bloque": "locacion_basica",
  "rol": "inquilino",
  "pregunta": "¿Texto de la pregunta?",
  "keywords_esperadas": ["palabra", "otra"]
}
```

Campos opcionales:

- `no_debe_decir: ["frase prohibida"]` — si aparece en la respuesta, fail automático.
- `debe_rechazar: true` — la respuesta debe contener un indicador de rechazo (ej: "no tengo esa información").
- `ambigua: true` — pregunta mal formulada; basta que el bot responda algo coherente.
- `vacia: true` — input vacío o con espacios; basta que no alucine.

## Cadencia de corridas automáticas

Ver `.github/workflows/qa-bot.yml`.

- **Abril–julio 2026**: cada 2 días (`0 3 */2 * *`).
- **A partir de agosto 2026**: cada 15 días (ajustar cron a `0 3 1,15 * *` o similar).

## Troubleshooting

- **`QA_TEST_SECRET no configurada`**: falta agregar la env var en Railway. Settings → Variables → `QA_TEST_SECRET=<random>`.
- **`QA secret inválido`**: el secret en GitHub Actions (`QA_SECRET` en Secrets) no coincide con Railway (`QA_TEST_SECRET`).
- **Muchos ⚫ timeouts**: bajar `QA_CONCURRENCY=1` o subir `QA_TIMEOUT_MS=90000`.
- **Muchos 🟠 por keywords ausentes**: revisar el doc RAG que cubra esa pregunta. Puede faltar ingesta o el threshold 0.35 está filtrando el match.
