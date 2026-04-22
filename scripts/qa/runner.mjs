#!/usr/bin/env node
/**
 * QA Runner — AlquilApp WhatsApp Bot
 *
 * Corre el banco de preguntas (scripts/qa/preguntas.json) contra el endpoint
 * /ai/qa-test del bot en Railway, guarda los resultados en qa-reports/ y
 * genera un resumen (console + JSON) con:
 *   - cuántas preguntas corrieron OK
 *   - cuántas recuperaron docs RAG
 *   - tiempo promedio por pregunta
 *   - preguntas que fallaron (sin respuesta, sin docs, keywords faltantes)
 *
 * Uso:
 *   BOT_URL=https://tu-bot.railway.app QA_SECRET=xxxx node scripts/qa/runner.mjs
 *
 * Flags opcionales (via env):
 *   QA_CONCURRENCY=2   → cuántas preguntas en paralelo (default 2)
 *   QA_TIMEOUT_MS=60000 → timeout por request (default 60s)
 *   QA_BLOQUE=locacion_basica → corre solo un bloque (para debug)
 *   QA_LIMIT=5         → corre solo las primeras N preguntas
 *
 * Salidas (en qa-reports/):
 *   YYYY-MM-DD_HH-mm.json  → respuestas crudas + clasificación
 *   YYYY-MM-DD_HH-mm.md    → resumen legible
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

// ── Config ───────────────────────────────────────────────────
const BOT_URL = (process.env.BOT_URL || '').replace(/\/$/, '');
const QA_SECRET = process.env.QA_SECRET || '';
const CONCURRENCY = Math.max(1, parseInt(process.env.QA_CONCURRENCY || '2', 10));
const TIMEOUT_MS = parseInt(process.env.QA_TIMEOUT_MS || '60000', 10);
const BLOQUE_FILTRO = process.env.QA_BLOQUE || '';
const LIMIT = parseInt(process.env.QA_LIMIT || '0', 10);

if (!BOT_URL) {
  console.error('❌ Falta BOT_URL. Ejemplo: BOT_URL=https://alquilapp-bot.railway.app');
  process.exit(1);
}
if (!QA_SECRET) {
  console.error('❌ Falta QA_SECRET. Debe coincidir con QA_TEST_SECRET del bot.');
  process.exit(1);
}

// ── Cargar banco de preguntas ────────────────────────────────
const bancoPath = path.join(__dirname, 'preguntas.json');
if (!fs.existsSync(bancoPath)) {
  console.error('❌ No se encuentra preguntas.json en', bancoPath);
  process.exit(1);
}
const banco = JSON.parse(fs.readFileSync(bancoPath, 'utf8'));
let preguntas = banco.preguntas || [];

if (BLOQUE_FILTRO) {
  preguntas = preguntas.filter(p => p.bloque === BLOQUE_FILTRO);
  console.log(`🔍 Filtrando por bloque: ${BLOQUE_FILTRO} → ${preguntas.length} preguntas`);
}
if (LIMIT > 0) {
  preguntas = preguntas.slice(0, LIMIT);
  console.log(`🔍 Limitando a primeras ${LIMIT} preguntas`);
}

console.log(`📋 Banco v${banco.version} (${banco.actualizado}) — ${preguntas.length} preguntas a correr`);
console.log(`🎯 Bot: ${BOT_URL}`);
console.log(`⚙️  Concurrencia: ${CONCURRENCY} | Timeout: ${TIMEOUT_MS}ms\n`);

// ── Helpers ──────────────────────────────────────────────────
function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

// ── Helpers de matching con detección de negación ────────────
function estaNegada(texto, frase) {
  const f = frase.toLowerCase();
  const idx = texto.indexOf(f);
  if (idx < 0) return false;
  const inicioOracion = Math.max(
    texto.lastIndexOf('.', idx - 1) + 1,
    texto.lastIndexOf('\n', idx - 1) + 1,
    texto.lastIndexOf('!', idx - 1) + 1,
    texto.lastIndexOf('?', idx - 1) + 1,
    0
  );
  const ventana = texto.slice(inicioOracion, idx);
  return /\b(ya\s+no|no\s+(?:es|está|hay|existe|aplica|rige|tiene|puede|debe|sigue|corresponde|se\s+aplica)|nunca|jamás|tampoco|fue(?:ron)?\s+derogad|ha\s+sido\s+derogad|dejó\s+de|dejaron\s+de|sin\s+)/i.test(ventana);
}

function hayMarcadorDerogacion(texto) {
  return /\b(derogad[oa]s?|derog[óo]|fueron?\s+derogad|ha\s+sido\s+derogad|reemplazad[oa]\s+por|ya\s+no\s+(?:rige|aplica|existe|tiene\s+vigencia|es\s+vigente)|dnu\s*70\/?20?23)\b/i.test(texto);
}

function clasificar(p, r) {
  if (!r || r.network_error) return { clasificacion: '⚫', matcher_warning: null };
  if (!r.ok || !r.respuesta) {
    const preguntaVacia = !String(p.pregunta || '').trim() || p.vacia === true;
    if (preguntaVacia) {
      return { clasificacion: '⚪', matcher_warning: 'pregunta vacía o marcada vacia=true — test inválido, excluido del total real' };
    }
    return { clasificacion: '🔴', matcher_warning: null };
  }

  const resp = (r.respuesta || '').toLowerCase();

  if (!String(p.pregunta || '').trim() || p.vacia === true) {
    return { clasificacion: '⚪', matcher_warning: 'pregunta vacía o marcada vacia=true — test excluido del total real' };
  }

  let matcherWarning = null;
  if (Array.isArray(p.no_debe_decir)) {
    for (const frase of p.no_debe_decir) {
      const f = String(frase).toLowerCase();
      if (resp.includes(f)) {
        if (estaNegada(resp, f) || hayMarcadorDerogacion(resp)) {
          matcherWarning = `"${frase}" aparece pero el contexto indica negación o derogación — tratado como no-fallo`;
          continue;
        }
        return { clasificacion: '🔴', matcher_warning: null };
      }
    }
  }

  if (p.debe_rechazar) {
    const rechazoIndicadores = [
      'no tengo esa información',
      'no tengo información',
      'solo ayudo con alquileres',
      'solo puedo ayudarte con',
      'no es mi especialidad',
      'fuera de mi alcance',
      'solo me dedico',
      'sólo ayudo',
      'no está en mi base de conocimiento'
    ];
    const rechaza = rechazoIndicadores.some(ind => resp.includes(ind));
    return { clasificacion: rechaza ? '🟢' : '🟠', matcher_warning: matcherWarning };
  }

  if (p.ambigua || p.vacia) {
    if (resp.length > 10 && !resp.includes('error')) return { clasificacion: '🟢', matcher_warning: matcherWarning };
    return { clasificacion: '🟡', matcher_warning: matcherWarning };
  }

  if (Array.isArray(p.keywords_esperadas) && p.keywords_esperadas.length > 0) {
    const encontradas = p.keywords_esperadas.filter(kw =>
      resp.includes(String(kw).toLowerCase())
    );
    const total = p.keywords_esperadas.length;
    if (encontradas.length === total) return { clasificacion: '🟢', matcher_warning: matcherWarning };
    if (encontradas.length === 0) return { clasificacion: '🟠', matcher_warning: matcherWarning };
    return { clasificacion: '🟡', matcher_warning: matcherWarning };
  }

  return { clasificacion: '🟢', matcher_warning: matcherWarning };
}

async function correrPregunta(p) {
  const t0 = Date.now();
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(`${BOT_URL}/ai/qa-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-qa-secret': QA_SECRET
      },
      body: JSON.stringify({
        pregunta: p.pregunta,
        rol: p.rol || 'propietario'
      }),
      signal: controller.signal
    });

    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* respuesta no json */ }

    if (!r.ok) {
      return {
        ...p,
        ok: false,
        network_error: null,
        http_status: r.status,
        respuesta: '',
        rag: null,
        tiempos_ms: { total: Date.now() - t0 },
        raw: txt.slice(0, 500)
      };
    }

    return {
      ...p,
      ok: json?.ok === true,
      network_error: null,
      http_status: r.status,
      respuesta: json?.respuesta || '',
      llm_error: json?.llm_error || null,
      rag: json?.rag || null,
      tiempos_ms: json?.tiempos_ms || { total: Date.now() - t0 }
    };
  } catch (e) {
    return {
      ...p,
      ok: false,
      network_error: e.message,
      http_status: null,
      respuesta: '',
      rag: null,
      tiempos_ms: { total: Date.now() - t0 }
    };
  } finally {
    clearTimeout(to);
  }
}

// ── Pool de concurrencia ─────────────────────────────────────
async function correrConConcurrencia(preguntas, concurrency) {
  const results = new Array(preguntas.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= preguntas.length) return;
      const p = preguntas[i];
      process.stdout.write(`[${i + 1}/${preguntas.length}] ${p.id} — ${p.pregunta.slice(0, 60)}...`);
      const r = await correrPregunta(p);
      const { clasificacion, matcher_warning } = clasificar(p, r);
      r.clasificacion = clasificacion;
      r.matcher_warning = matcher_warning;
      results[i] = r;
      const warn = matcher_warning ? ' ⚠️' : '';
      process.stdout.write(` ${r.clasificacion}${warn} (${r.tiempos_ms.total}ms, ${r.rag?.docs_recuperados ?? 0} docs)\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const tStart = Date.now();
  const resultados = await correrConConcurrencia(preguntas, CONCURRENCY);
  const tTotal = Date.now() - tStart;

  const por = { '🟢': 0, '🟡': 0, '🟠': 0, '🔴': 0, '⚫': 0, '⚪': 0 };
  const fallos = [];
  const warnings = [];
  let sumTiempo = 0;
  let sumDocs = 0;

  for (const r of resultados) {
    por[r.clasificacion] = (por[r.clasificacion] || 0) + 1;
    sumTiempo += r.tiempos_ms?.total || 0;
    sumDocs += r.rag?.docs_recuperados || 0;
    if (['🟠', '🔴', '⚫'].includes(r.clasificacion)) {
      fallos.push(r);
    }
    if (r.matcher_warning) warnings.push(r);
  }

  const excluidos = por['⚪'] || 0;
  const totalEvaluable = resultados.length - excluidos;
  const promTiempo = Math.round(sumTiempo / resultados.length);
  const promDocs = (sumDocs / resultados.length).toFixed(2);

  const reportsDir = path.join(ROOT, 'qa-reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const ts = timestamp();
  const jsonPath = path.join(reportsDir, `${ts}.json`);
  const mdPath = path.join(reportsDir, `${ts}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    version_banco: banco.version,
    actualizado_banco: banco.actualizado,
    bot_url: BOT_URL,
    corrida_iniciada: new Date(tStart).toISOString(),
    corrida_duracion_ms: tTotal,
    total_preguntas: resultados.length,
    total_evaluable: totalEvaluable,
    excluidos: excluidos,
    matcher_warnings: warnings.length,
    por_clasificacion: por,
    promedio_tiempo_ms: promTiempo,
    promedio_docs_rag: parseFloat(promDocs),
    resultados
  }, null, 2));

  let md = `# QA Bot — Reporte ${ts}\n\n`;
  md += `- **Bot**: ${BOT_URL}\n`;
  md += `- **Banco**: v${banco.version} (${banco.actualizado})\n`;
  md += `- **Preguntas**: ${resultados.length}\n`;
  md += `- **Duración total**: ${(tTotal / 1000).toFixed(1)}s\n`;
  md += `- **Tiempo promedio por pregunta**: ${promTiempo}ms\n`;
  md += `- **Docs RAG promedio**: ${promDocs}\n\n`;
  md += `## Clasificación\n\n`;
  md += `| Símbolo | Significado | Cantidad |\n|---|---|---|\n`;
  md += `| 🟢 | Correcta (keywords ok o rechazo esperado) | ${por['🟢'] || 0} |\n`;
  md += `| 🟡 | Parcial (algunas keywords aparecen) | ${por['🟡'] || 0} |\n`;
  md += `| 🟠 | Débil (0 keywords o rechazo faltante) | ${por['🟠'] || 0} |\n`;
  md += `| 🔴 | Fallo (sin respuesta o dijo algo prohibido) | ${por['🔴'] || 0} |\n`;
  md += `| ⚫ | Error de red/timeout | ${por['⚫'] || 0} |\n`;
  md += `| ⚪ | Excluida (pregunta vacía o flag vacia=true) | ${por['⚪'] || 0} |\n\n`;

  md += `## Métricas reales (post-matcher)\n\n`;
  md += `- **Total evaluable**: ${totalEvaluable} de ${resultados.length} (excluye ${excluidos} tests inválidos)\n`;
  md += `- **🔴 reales**: ${por['🔴'] || 0} (ya no cuenta falsos positivos por negación/derogación)\n`;
  md += `- **Matcher warnings**: ${warnings.length} (preguntas donde el matcher detectó posible falso positivo y lo resolvió a favor del bot)\n`;
  if (warnings.length) {
    md += `\n<details><summary>Ver ${warnings.length} warning(s)</summary>\n\n`;
    for (const w of warnings) {
      md += `- **${w.id}** (${w.clasificacion}): ${w.matcher_warning}\n`;
    }
    md += `\n</details>\n`;
  }
  md += `\n`;

  if (fallos.length) {
    md += `## Fallos a revisar (${fallos.length})\n\n`;
    for (const f of fallos) {
      md += `### ${f.clasificacion} ${f.id} — ${f.bloque} (${f.rol})\n`;
      md += `**Pregunta:** ${f.pregunta}\n\n`;
      md += `**Respuesta del bot:**\n> ${(f.respuesta || '(vacía)').replace(/\n/g, '\n> ')}\n\n`;
      if (f.keywords_esperadas) {
        md += `**Keywords esperadas:** ${f.keywords_esperadas.join(', ')}\n\n`;
      }
      if (f.no_debe_decir) {
        md += `**No debe decir:** ${f.no_debe_decir.join(', ')}\n\n`;
      }
      if (f.rag) {
        md += `**Docs RAG (${f.rag.docs_recuperados}):** ${(f.rag.docs || []).map(d => `${d.titulo} (${d.similarity})`).join(' · ')}\n\n`;
      }
      if (f.network_error) md += `**Error red:** ${f.network_error}\n\n`;
      if (f.llm_error) md += `**Error LLM:** ${f.llm_error}\n\n`;
      md += `---\n\n`;
    }
  } else {
    md += `## ✅ Sin fallos críticos\n\nTodas las preguntas del banco clasificaron 🟢 o 🟡.\n`;
  }

  fs.writeFileSync(mdPath, md);

  console.log('\n════════════════════════════════════════');
  console.log(`📊 QA terminado en ${(tTotal / 1000).toFixed(1)}s`);
  console.log(`🟢 ${por['🟢'] || 0}  🟡 ${por['🟡'] || 0}  🟠 ${por['🟠'] || 0}  🔴 ${por['🔴'] || 0}  ⚫ ${por['⚫'] || 0}  ⚪ ${por['⚪'] || 0}`);
  console.log(`📈 Evaluable: ${totalEvaluable} | Matcher warnings: ${warnings.length}`);
  console.log(`⏱  Promedio: ${promTiempo}ms/pregunta | 📚 RAG promedio: ${promDocs} docs`);
  console.log(`📄 Reportes:`);
  console.log(`   - ${path.relative(ROOT, jsonPath)}`);
  console.log(`   - ${path.relative(ROOT, mdPath)}`);

  const criticos = (por['🔴'] || 0) + (por['⚫'] || 0);
  if (criticos > 0) {
    console.log(`\n⚠️  ${criticos} fallos críticos reales — exit 1`);
    process.exit(1);
  }
  console.log('\n✅ Sin fallos críticos reales');
  process.exit(0);
})();
