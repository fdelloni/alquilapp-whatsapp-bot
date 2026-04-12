// ═══════════════════════════════════════════════════════════
// AlquilApp — Bot de WhatsApp con Gemini AI (via Twilio)
// v3.0 — Soporte completo para propietarios E inquilinos,
//         historial persistente en Supabase, comandos especiales.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio envía form-urlencoded

// ── Variables de entorno ──────────────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  GEMINI_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  NOTIF_SECRET,
  PORT = 3000
} = process.env;

// ── Supabase client (service_role para leer todos los datos) ──
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Historial en memoria como respaldo (se usa si Supabase falla) ──
const historialMemoria = {};

// ═══════════════════════════════════════════════════════════
// WEBHOOK — Twilio envía un POST cuando llega un mensaje
// ═══════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  try {
    const body      = req.body;
    const from      = (body.From || '').replace('whatsapp:', '');
    const text      = (body.Body || '').trim();
    const numMedia  = parseInt(body.NumMedia || '0', 10);
    const mediaType = body.MediaContentType0 || '';
    const mediaUrl  = body.MediaUrl0 || '';
    const esAudio   = numMedia > 0 && mediaType.startsWith('audio/');

    if (!from || (!text && !esAudio)) {
      return res.send('<Response></Response>');
    }

    console.log(`📩 Mensaje de ${from}: ${esAudio ? `[AUDIO ${mediaType}]` : text}`);

    // ── Comandos especiales (sin necesidad de estar registrado) ──
    const textLower = text.toLowerCase().trim();
    if (textLower === 'borrar' || textLower === 'reset' || textLower === 'nueva consulta' || textLower === 'limpiar') {
      await limpiarHistorial(from);
      return res.send(`<Response><Message>${escapeXml('🧹 Historial borrado. ¡Empezamos de nuevo! ¿En qué puedo ayudarte?')}</Message></Response>`);
    }

    // ── 1. Buscar usuario por número de WhatsApp ──────────
    const usuario = await buscarUsuario(from);

    if (!usuario) {
      const msg =
        '👋 ¡Hola! No encontré tu número registrado en AlquilApp.\n\n' +
        'Para usar el asistente:\n' +
        '1. Ingresá a *alquil.app*\n' +
        '2. Andá a *Mi Perfil*\n' +
        '3. Cargá tu número de WhatsApp\n\n' +
        'Una vez registrado, escribime para consultar tus datos de alquiler. 🏠';
      console.log('⚠️ Usuario no encontrado para:', from);
      return res.send(`<Response><Message>${escapeXml(msg)}</Message></Response>`);
    }

    console.log(`👤 Usuario: ${usuario.nombre || usuario.email} (${usuario.rol || 'propietario'})`);

    // ── 2. Cargar datos del usuario desde Supabase ────────
    const datos = await cargarDatosUsuario(usuario);

    // ── 3. Procesar mensaje con Gemini ────────────────────
    let respuesta;
    if (esAudio) {
      respuesta = await consultarGeminiConAudio(from, mediaUrl, mediaType, usuario, datos);
    } else {
      respuesta = await consultarGemini(from, text, usuario, datos);
    }

    console.log(`✅ Respuesta lista para ${from}`);
    return res.send(`<Response><Message>${escapeXml(respuesta)}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error procesando mensaje:', err);
    return res.send(`<Response><Message>${escapeXml('Hubo un problema. Por favor intentá de nuevo en unos segundos.')}</Message></Response>`);
  }
});

// Escapa caracteres especiales XML para TwiML
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════
// BUSCAR USUARIO POR NÚMERO DE WHATSAPP
// Soporta tanto propietarios como inquilinos
// ═══════════════════════════════════════════════════════════
async function buscarUsuario(telefono) {
  const limpio = telefono.replace(/\s/g, '');
  // Argentina: +5493XXXXXXXXX (con 9) ↔ +543XXXXXXXXX (sin 9)
  const variantes = [
    limpio,
    limpio.replace(/^\+549/, '+54'),
    limpio.replace(/^\+54(?!9)/, '+549'),
  ];

  for (const num of variantes) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('whatsapp_phone', num)
      .single();
    if (data) return data;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// CARGAR DATOS DEL USUARIO — PROPIETARIO O INQUILINO
// ═══════════════════════════════════════════════════════════
async function cargarDatosUsuario(usuario) {
  const userId = usuario.id;
  const email  = usuario.email || '';
  const rol    = usuario.rol || 'propietario';

  const datos = {
    rol,
    propiedades: [],
    contratos:   [],
    cobros:      [],
    servicios:   [],
    expensas:    []
  };

  try {
    if (rol === 'inquilino') {
      // ── Inquilino: datos de SU alquiler ─────────────────
      // Contratos donde aparece como inquilino (por email)
      const { data: contratos } = await supabase
        .from('contratos')
        .select('*')
        .eq('inquilino_email', email);
      datos.contratos = contratos || [];

      // Cobros pendientes/pagados asociados a sus contratos
      if (datos.contratos.length > 0) {
        const propIds     = [...new Set(datos.contratos.map(c => c.propiedad_id).filter(Boolean))];
        const contratoIds = datos.contratos.map(c => c.id);

        // Propiedades que alquila (para mostrar la dirección)
        if (propIds.length > 0) {
          const { data: props } = await supabase
            .from('propiedades')
            .select('*')
            .in('id', propIds);
          datos.propiedades = props || [];

          // Servicios de SU propiedad
          const { data: servicios } = await supabase
            .from('servicios')
            .select('*')
            .in('propiedad_id', propIds);
          datos.servicios = servicios || [];

          // Expensas de SU propiedad
          const { data: expensas } = await supabase
            .from('expensas')
            .select('*')
            .in('propiedad_id', propIds)
            .order('periodo', { ascending: false })
            .limit(12);
          datos.expensas = expensas || [];
        }

        // Cobros de SUS contratos
        const { data: cobros } = await supabase
          .from('cobros')
          .select('*')
          .in('contrato_id', contratoIds)
          .order('fecha_vencimiento', { ascending: false })
          .limit(12);
        datos.cobros = cobros || [];
      }

    } else {
      // ── Propietario: todos sus datos ────────────────────
      const { data: props } = await supabase
        .from('propiedades')
        .select('*')
        .eq('propietario_id', userId);
      datos.propiedades = props || [];

      const { data: contratos } = await supabase
        .from('contratos')
        .select('*')
        .eq('propietario_id', userId);
      datos.contratos = contratos || [];

      const { data: cobros } = await supabase
        .from('cobros')
        .select('*')
        .eq('propietario_id', userId)
        .order('fecha_vencimiento', { ascending: false })
        .limit(20);
      datos.cobros = cobros || [];

      const { data: servicios } = await supabase
        .from('servicios')
        .select('*')
        .eq('propietario_id', userId);
      datos.servicios = servicios || [];

      const { data: expensas } = await supabase
        .from('expensas')
        .select('*')
        .eq('propietario_id', userId)
        .order('periodo', { ascending: false })
        .limit(12);
      datos.expensas = expensas || [];
    }
  } catch (e) {
    console.error('Error cargando datos del usuario:', e.message);
  }

  console.log(`📊 Datos cargados: ${datos.contratos.length} contratos, ${datos.cobros.length} cobros, ${datos.propiedades.length} propiedades`);
  return datos;
}

// ═══════════════════════════════════════════════════════════
// HISTORIAL DE CONVERSACIÓN — Supabase con fallback a memoria
// ═══════════════════════════════════════════════════════════
async function obtenerHistorial(telefono) {
  try {
    const { data, error } = await supabase
      .from('conversaciones_wa')
      .select('messages')
      .eq('telefono', telefono)
      .single();
    if (error || !data) return [];
    return data.messages || [];
  } catch {
    return historialMemoria[telefono] || [];
  }
}

async function guardarHistorial(telefono, messages) {
  // Mantener solo los últimos 20 turnos para no sobrecargar el contexto
  const recortados = messages.slice(-20);
  try {
    await supabase
      .from('conversaciones_wa')
      .upsert({ telefono, messages: recortados, updated_at: new Date().toISOString() }, { onConflict: 'telefono' });
  } catch {
    historialMemoria[telefono] = recortados;
  }
}

async function limpiarHistorial(telefono) {
  try {
    await supabase.from('conversaciones_wa').delete().eq('telefono', telefono);
  } catch {}
  delete historialMemoria[telefono];
}

// ═══════════════════════════════════════════════════════════
// CONSULTAR A GEMINI AI — Texto
// ═══════════════════════════════════════════════════════════
async function consultarGemini(telefono, pregunta, usuario, datos) {
  const historial = await obtenerHistorial(telefono);
  historial.push({ role: 'user', parts: [{ text: pregunta }] });

  const systemPrompt = buildSystemPrompt(usuario, datos);
  const requestBody  = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: historial
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini error:', response.status, errText);
      return '⚠️ Hubo un error al procesar tu consulta. Intentá de nuevo en un momento.';
    }

    const json = await response.json();
    if (!json.candidates?.[0]?.content) {
      console.error('Gemini respuesta vacía:', JSON.stringify(json));
      return '⚠️ No pude generar una respuesta. Intentá reformular tu pregunta.';
    }

    const respuesta = json.candidates[0].content.parts[0].text.trim();
    historial.push({ role: 'model', parts: [{ text: respuesta }] });
    await guardarHistorial(telefono, historial);
    return formatearParaWhatsApp(respuesta);

  } catch (err) {
    console.error('Gemini error:', err);
    return '⚠️ Error de conexión con el asistente. Intentá de nuevo.';
  }
}

// ═══════════════════════════════════════════════════════════
// CONSULTAR A GEMINI AI — Audio
// Descarga el audio de Twilio y lo procesa directamente.
// Gemini 2.5 Flash entiende audio nativo — sin transcripción externa.
// ═══════════════════════════════════════════════════════════
async function consultarGeminiConAudio(telefono, audioUrl, mimeType, usuario, datos) {
  const historial = await obtenerHistorial(telefono);

  console.log(`🎤 Descargando audio: ${audioUrl}`);
  const audioResp = await fetch(audioUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });

  if (!audioResp.ok) {
    console.error('Error descargando audio:', audioResp.status);
    return '⚠️ No pude procesar tu audio. Por favor escribí tu consulta en texto.';
  }

  const audioBuffer = await audioResp.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString('base64');
  console.log(`🎤 Audio descargado: ${Math.round(audioBuffer.byteLength / 1024)} KB`);

  const systemPrompt = buildSystemPrompt(usuario, datos);
  const requestBody  = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      ...historial,
      {
        role: 'user',
        parts: [
          { text: 'El usuario envió un mensaje de voz. Escuchá el audio, entendé su consulta y respondé directamente (sin repetir lo que dijo). Si el audio no es claro, pedile que repita.' },
          { inline_data: { mime_type: mimeType, data: audioBase64 } }
        ]
      }
    ]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini error (audio):', response.status, errText);
      return '⚠️ No pude procesar tu audio. Intentá escribir tu consulta.';
    }

    const json = await response.json();
    if (!json.candidates?.[0]?.content) {
      return '⚠️ No pude entender el audio. Intentá escribir tu consulta.';
    }

    const respuesta = json.candidates[0].content.parts[0].text.trim();
    historial.push({ role: 'user',  parts: [{ text: '[Mensaje de voz]' }] });
    historial.push({ role: 'model', parts: [{ text: respuesta }] });
    await guardarHistorial(telefono, historial);
    console.log(`✅ Audio procesado para ${telefono}`);
    return formatearParaWhatsApp(respuesta);

  } catch (err) {
    console.error('Error consultando Gemini con audio:', err);
    return '⚠️ Error procesando tu audio. Intentá de nuevo.';
  }
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT — Contexto completo adaptado por rol
// ═══════════════════════════════════════════════════════════
function buildSystemPrompt(usuario, datos) {
  const nombre   = usuario.nombre || 'Usuario';
  const rol      = usuario.rol || 'propietario';
  const esProp   = rol !== 'inquilino';
  const rolLabel = esProp ? 'propietario/locador' : 'inquilino/locatario';

  // Mapa de propiedades por ID
  const propMap = {};
  datos.propiedades.forEach(p => { propMap[p.id] = p.direccion || 'Sin dirección'; });

  let prompt = `Sos *Alquil*, el asistente de WhatsApp de AlquilApp. Hablás de manera clara, directa y amigable, como un experto en alquileres que le habla a un amigo. Sin tecnicismos innecesarios.

El usuario es *${nombre}* y está registrado como *${rolLabel}*.

Podés ayudarlo con tres cosas:

*1. Sus datos de alquiler*
Tenés acceso en tiempo real a todo lo que tiene cargado en AlquilApp. Si te preguntan algo que está en los datos, lo respondés directo. Si algo no está cargado, explicás cómo hacerlo en alquil.app.

*2. Consultas legales sobre alquileres (Argentina)*
El marco legal vigente es el *Código Civil y Comercial* (arts. 1187-1226). La Ley 27.551 fue *derogada* por el DNU 70/2023. Nunca la menciones como vigente.

Cambios clave del DNU 70/2023:
• *Duración*: libre acuerdo, sin mínimo de 3 años.
• *Precio y ajustes*: libre acuerdo (ICL, IPC, UVA, % fijo, etc.).
• *Depósito*: libre acuerdo, sin tope.
• *Rescisión del inquilino*: desde el 6° mes con 30 días de aviso. Penalidad: 1,5 meses si sale antes del año; 1 mes si sale después.
• *Reparaciones urgentes*: si el propietario no responde, el inquilino puede hacerlas y reclamar el reembolso.
• *Sublocación*: prohibida salvo pacto expreso.

Siempre aclarás que es orientación informativa y que para casos puntuales lo mejor es consultar a un abogado.

*3. Cómo funciona AlquilApp*
AlquilApp es una plataforma web (alquil.app) para gestionar alquileres. Secciones: Dashboard, Propiedades, Contratos, Cobros, Servicios, Expensas, Rentabilidad, Asistente legal, Mi Perfil.
Por WhatsApp solo se puede *consultar*, no modificar datos.

*Comandos disponibles:*
• Escribí *borrar* o *reset* para empezar una nueva conversación desde cero.

---
USUARIO: *${nombre}* (${rolLabel})
Email: ${usuario.email || 'No registrado'}

FORMATO: Español rioplatense. Mensajes cortos y claros. *Negrita* para lo importante. Listas con •. Sin tablas. Sin ## ni ---. Máximo 3-4 párrafos por respuesta.

REGLA DE ORO: Si el dato está en la base de datos, lo das directamente. Si no está cargado, explicás en qué sección de alquil.app puede cargarlo.

═══════════ DATOS ACTUALES ═══════════
`;

  // ── BLOQUE PROPIETARIO ───────────────────────────────────
  if (esProp) {
    // Propiedades
    if (datos.propiedades.length > 0) {
      prompt += `\nPROPIEDADES (${datos.propiedades.length}):\n`;
      datos.propiedades.forEach((p, i) => {
        prompt += `${i+1}. ${p.direccion || 'Sin dirección'}, ${[p.zona, p.localidad, p.provincia].filter(Boolean).join(' ')}\n`;
        if (p.superficie) prompt += `   ${p.superficie} m² | ${p.ambientes || 'N/A'} amb.\n`;
        if (p.valor_usd)  prompt += `   Valor: USD ${p.valor_usd}\n`;
      });
    } else {
      prompt += '\nPROPIEDADES: No tiene propiedades cargadas todavía.\n';
    }

    // Contratos
    if (datos.contratos.length > 0) {
      prompt += `\nCONTRATOS (${datos.contratos.length}):\n`;
      datos.contratos.forEach((c, i) => {
        const prop   = propMap[c.propiedad_id] || `Propiedad ID:${c.propiedad_id}`;
        const monto  = c.monto_alquiler ? `$${Number(c.monto_alquiler).toLocaleString('es-AR')}` : 'Sin monto';
        const inicio = c.fecha_inicio?.split('T')[0] || 'N/A';
        const fin    = c.fecha_fin?.split('T')[0]    || 'N/A';
        prompt += `${i+1}. *${prop}* — ${c.inquilino_nombre || 'Sin inquilino'}\n`;
        prompt += `   Monto: ${monto} | Índice: ${c.indice_ajuste || 'ICL'} | Estado: ${c.estado || 'activo'}\n`;
        prompt += `   Contrato: ${inicio} → ${fin}\n`;
        if (c.deposito)            prompt += `   Depósito: $${Number(c.deposito).toLocaleString('es-AR')}\n`;
        if (c.proximo_ajuste_fecha) prompt += `   Próximo ajuste: ${c.proximo_ajuste_fecha.split('T')[0]} (${c.proximo_ajuste_pct || 0}%)\n`;
      });
    } else {
      prompt += '\nCONTRATOS: No tiene contratos cargados.\n';
    }

    // Cobros
    if (datos.cobros.length > 0) {
      const pendientes = datos.cobros.filter(c => c.estado === 'pendiente');
      const pagados    = datos.cobros.filter(c => c.estado === 'pagado');
      prompt += `\nCOBROS (${datos.cobros.length} total | ${pendientes.length} pendientes | ${pagados.length} pagados):\n`;
      datos.cobros.slice(0, 10).forEach((c, i) => {
        const prop  = propMap[c.propiedad_id] || 'N/A';
        const vence = c.fecha_vencimiento?.split('T')[0] || 'N/A';
        prompt += `${i+1}. ${prop} | ${c.inquilino_nombre || 'N/A'} | $${c.monto || 'N/A'} | Vence: ${vence} | *${c.estado || 'N/A'}*\n`;
      });
      if (datos.cobros.length > 10) prompt += `   ... y ${datos.cobros.length - 10} cobros más.\n`;
    } else {
      prompt += '\nCOBROS: No tiene cobros registrados.\n';
    }

  // ── BLOQUE INQUILINO ─────────────────────────────────────
  } else {
    if (datos.contratos.length > 0) {
      const c    = datos.contratos[0]; // inquilino generalmente tiene 1 contrato activo
      const prop = propMap[c.propiedad_id] || 'Tu propiedad';
      const monto  = c.monto_alquiler ? `$${Number(c.monto_alquiler).toLocaleString('es-AR')}` : 'Ver contrato';
      const inicio = c.fecha_inicio?.split('T')[0] || 'N/A';
      const fin    = c.fecha_fin?.split('T')[0]    || 'N/A';
      prompt += `\nTU ALQUILER:\n`;
      prompt += `Propiedad: *${prop}*\n`;
      prompt += `Propietario: ${c.propietario_nombre || 'Ver contrato'}\n`;
      prompt += `Monto mensual: *${monto}* | Índice: ${c.indice_ajuste || 'ICL'}\n`;
      prompt += `Vigencia: ${inicio} → ${fin} | Estado: ${c.estado || 'activo'}\n`;
      if (c.deposito)            prompt += `Depósito: $${Number(c.deposito).toLocaleString('es-AR')}\n`;
      if (c.proximo_ajuste_fecha) prompt += `Próximo ajuste: ${c.proximo_ajuste_fecha.split('T')[0]} (${c.proximo_ajuste_pct || 0}%)\n`;

      if (datos.contratos.length > 1) {
        prompt += `\nOTROS CONTRATOS (${datos.contratos.length - 1} más):\n`;
        datos.contratos.slice(1).forEach((cc, i) => {
          prompt += `${i+2}. ${propMap[cc.propiedad_id] || 'Propiedad'} | $${cc.monto_alquiler || 'N/A'} | ${cc.estado || 'N/A'}\n`;
        });
      }
    } else {
      prompt += '\nALQUILER: No tenés contratos registrados en AlquilApp.\n';
    }

    // Cobros del inquilino
    if (datos.cobros.length > 0) {
      const pendientes = datos.cobros.filter(c => c.estado === 'pendiente');
      const proximos   = pendientes.sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento)).slice(0, 3);
      prompt += `\nTUS PAGOS (últimos ${datos.cobros.length}):\n`;
      if (proximos.length > 0) {
        prompt += `*Próximos a vencer:*\n`;
        proximos.forEach(c => {
          const vence = c.fecha_vencimiento?.split('T')[0] || 'N/A';
          prompt += `• $${c.monto || 'N/A'} — Vence: ${vence} | *${c.estado}*\n`;
        });
      }
      datos.cobros.slice(0, 6).forEach((c, i) => {
        const vence = c.fecha_vencimiento?.split('T')[0] || 'N/A';
        prompt += `${i+1}. $${c.monto || 'N/A'} | Vence: ${vence} | *${c.estado || 'N/A'}*\n`;
      });
    } else {
      prompt += '\nPAGOS: No tenés cobros registrados.\n';
    }
  }

  // Servicios (común para ambos roles)
  if (datos.servicios.length > 0) {
    prompt += `\nSERVICIOS (${datos.servicios.length}):\n`;
    datos.servicios.forEach((s, i) => {
      const prop = propMap[s.propiedad_id] || '';
      const diaVto = s.dia_vto ? `día ${s.dia_vto}` : 'N/A';
      prompt += `${i+1}. *${s.tipo || 'Servicio'}*${prop ? ` (${prop})` : ''} | $${s.monto || 'N/A'} | Vto: ${diaVto}\n`;
    });
  } else {
    prompt += '\nSERVICIOS: No hay servicios registrados.\n';
  }

  // Expensas (común para ambos roles)
  if (datos.expensas.length > 0) {
    prompt += `\nEXPENSAS (últimas ${Math.min(datos.expensas.length, 5)}):\n`;
    datos.expensas.slice(0, 5).forEach((e, i) => {
      prompt += `${i+1}. Período: ${e.periodo || 'N/A'} | $${e.monto || 'N/A'} | *${e.estado || 'N/A'}*\n`;
    });
  }

  prompt += '\n═══════════════════════════════════════════\n';
  return prompt;
}

// ═══════════════════════════════════════════════════════════
// FORMATEAR RESPUESTA PARA WHATSAPP
// ═══════════════════════════════════════════════════════════
function formatearParaWhatsApp(texto) {
  return texto
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .trim();
}

// ═══════════════════════════════════════════════════════════
// ENVIAR MENSAJE POR WHATSAPP VIA TWILIO (para notificaciones)
// ═══════════════════════════════════════════════════════════
async function enviarWhatsApp(to, mensaje) {
  if (mensaje.length > 1500) mensaje = mensaje.substring(0, 1497) + '...';

  const twilioNumber = TWILIO_WHATSAPP_NUMBER || '+14155238886';
  const params = new URLSearchParams();
  params.append('To',   `whatsapp:${to}`);
  params.append('From', `whatsapp:${twilioNumber}`);
  params.append('Body', mensaje);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Twilio error ${response.status}: ${err}`);
  }
  const data = await response.json();
  console.log('Twilio SID:', data.sid);
  return data;
}

// ═══════════════════════════════════════════════════════════
// NOTIFICACIONES AUTOMÁTICAS DE VENCIMIENTO
// GET /notif-automaticas?secret=XXXX → llamar una vez por día
// Envía recordatorios 5 días, 2 días y el día del vencimiento.
// Registra cada envío en `notificaciones_wa` para evitar duplicados.
// ═══════════════════════════════════════════════════════════
app.get('/notif-automaticas', async (req, res) => {
  const SECRET = NOTIF_SECRET || 'alquilapp-notif-2024';
  if (req.query.secret !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  function addDias(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r.toISOString().slice(0, 10);
  }

  const fechas = {
    '5dias':     addDias(hoy, 5),
    '2dias':     addDias(hoy, 2),
    'vence_hoy': addDias(hoy, 0)
  };

  const resultados = { enviados: 0, omitidos: 0, errores: 0, detalle: [] };

  try {
    const { data: cobros, error: errCobros } = await supabase
      .from('cobros')
      .select('id, contrato_id, inquilino_nombre, monto, fecha_vencimiento, propiedad_id')
      .in('fecha_vencimiento', Object.values(fechas))
      .eq('estado', 'pendiente');

    if (errCobros) throw new Error('Error leyendo cobros: ' + errCobros.message);
    if (!cobros || cobros.length === 0) {
      return res.json({ ...resultados, mensaje: 'Sin cobros para notificar hoy' });
    }

    for (const cobro of cobros) {
      const vtoISO = cobro.fecha_vencimiento?.slice(0, 10);
      let tipo = null;
      if (vtoISO === fechas['5dias'])     tipo = '5dias';
      else if (vtoISO === fechas['2dias']) tipo = '2dias';
      else if (vtoISO === fechas['vence_hoy']) tipo = 'vence_hoy';
      if (!tipo) continue;

      // Verificar si ya se envió
      const { data: yaEnviado } = await supabase
        .from('notificaciones_wa')
        .select('id')
        .eq('cobro_id', cobro.id)
        .eq('tipo', tipo)
        .limit(1);

      if (yaEnviado?.length > 0) {
        resultados.omitidos++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, accion: 'omitido (ya enviado)' });
        continue;
      }

      // Obtener datos del contrato
      let telefono  = null;
      let inqNombre = cobro.inquilino_nombre || 'Inquilino';
      let inqEmail  = null;

      if (cobro.contrato_id) {
        const { data: ctr } = await supabase
          .from('contratos')
          .select('inquilino_telefono, inquilino_nombre, inquilino_email')
          .eq('id', cobro.contrato_id)
          .single();
        if (ctr) {
          telefono  = ctr.inquilino_telefono || null;
          inqNombre = ctr.inquilino_nombre   || inqNombre;
          inqEmail  = ctr.inquilino_email    || null;
        }
      }

      // Si no hay teléfono en el contrato, buscar en profiles por email
      if (!telefono && inqEmail) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('whatsapp_phone')
          .eq('email', inqEmail)
          .single();
        if (profile?.whatsapp_phone) telefono = profile.whatsapp_phone;
      }

      if (!telefono) {
        resultados.omitidos++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, accion: 'omitido (sin teléfono)' });
        continue;
      }

      // Normalizar número Argentina
      let numLimpio = telefono.replace(/\D/g, '');
      if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
      if (!numLimpio.startsWith('54')) numLimpio = '54' + numLimpio;
      const numeroFinal = '+' + numLimpio;

      // Obtener dirección
      let direccion = 'tu propiedad';
      if (cobro.propiedad_id) {
        const { data: prop } = await supabase
          .from('propiedades').select('direccion').eq('id', cobro.propiedad_id).single();
        if (prop?.direccion) direccion = prop.direccion;
      }

      const montoFmt = cobro.monto ? '$' + Number(cobro.monto).toLocaleString('es-AR') : 'el monto acordado';
      const vtoDate  = new Date(vtoISO + 'T00:00:00');
      const vtoFmt   = `${vtoDate.getDate()}/${vtoDate.getMonth()+1}/${vtoDate.getFullYear()}`;
      const primerNombre = inqNombre.split(' ')[0];

      let mensaje = '';
      if (tipo === '5dias') {
        mensaje =
          '🏠 *AlquilApp — Recordatorio de pago*\n\n' +
          `Hola ${primerNombre}! Te recordamos que el alquiler de *${direccion}* vence en *5 días* (el ${vtoFmt}).\n\n` +
          `💰 Monto: *${montoFmt}*\n\n` +
          '¡Asegurate de tenerlo listo! ¿Tenés dudas? Escribime y te ayudo 🙌';
      } else if (tipo === '2dias') {
        mensaje =
          '⚠️ *AlquilApp — Pago próximo a vencer*\n\n' +
          `Hola ${primerNombre}, quedan *solo 2 días* para que venza tu alquiler de *${direccion}* (el ${vtoFmt}).\n\n` +
          `💰 Monto: *${montoFmt}*\n\n` +
          'Si ya pagaste, ignorá este mensaje. Si necesitás ayuda, escribime. 🙏';
      } else if (tipo === 'vence_hoy') {
        mensaje =
          '🔴 *AlquilApp — Vencimiento HOY*\n\n' +
          `Hola ${primerNombre}, hoy vence el pago de tu alquiler de *${direccion}*.\n\n` +
          `💰 Monto: *${montoFmt}*\n\n` +
          'Por favor efectuá el pago hoy para evitar inconvenientes. 📞';
      }

      try {
        await enviarWhatsApp(numeroFinal, mensaje);
        await supabase.from('notificaciones_wa').insert({
          cobro_id: cobro.id, tipo, telefono: numeroFinal, estado: 'enviado'
        });
        resultados.enviados++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, telefono: numeroFinal, accion: 'enviado' });
        console.log(`✅ Notif ${tipo} → ${numeroFinal}`);
      } catch (errEnvio) {
        console.error(`❌ Error enviando a ${numeroFinal}:`, errEnvio.message);
        await supabase.from('notificaciones_wa').insert({
          cobro_id: cobro.id, tipo, telefono: numeroFinal, estado: 'error'
        });
        resultados.errores++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, telefono: numeroFinal, accion: 'error', error: errEnvio.message });
      }
    }

    console.log(`📊 Notif: ${resultados.enviados} enviadas, ${resultados.omitidos} omitidas, ${resultados.errores} errores`);
    return res.json(resultados);

  } catch (err) {
    console.error('❌ Error en /notif-automaticas:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// VERIFY WHATSAPP — Verifica si el número está en el sandbox
// La web llama este endpoint desde Mi Perfil
// ═══════════════════════════════════════════════════════════
app.options('/verify-whatsapp', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/verify-whatsapp', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ connected: false, error: 'Falta el número de teléfono' });

  let numero = phone.trim();
  if (!numero.startsWith('+')) numero = '+' + numero;

  const mensajeBienvenida =
    '✅ ¡Tu asistente *Alquil* está activo!\n\n' +
    'Ahora podés escribirme para consultar:\n' +
    '• 📅 Cobros y vencimientos\n' +
    '• 💡 Servicios (luz, gas, ABL...)\n' +
    '• 🧾 Contrato y ajustes\n' +
    '• ⚖️ Dudas legales sobre alquileres\n' +
    '• 🎤 ¡También podés mandarme audios!\n\n' +
    '_Escribí *borrar* en cualquier momento para resetear la conversación._\n\n' +
    '¿En qué puedo ayudarte? 😊';

  try {
    const data = await enviarWhatsApp(numero, mensajeBienvenida);
    console.log(`✅ Bienvenida enviada a ${numero} (SID: ${data.sid})`);
    return res.json({ connected: true });
  } catch (err) {
    console.log(`⚠️ verify-whatsapp: ${numero} → ${err.message}`);
    return res.json({ connected: false, twilioError: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status:    'ok',
    app:       'AlquilApp WhatsApp Bot (Twilio)',
    version:   '3.0.0',
    timestamp: new Date().toISOString(),
    env_check: {
      TWILIO_ACCOUNT_SID:    TWILIO_ACCOUNT_SID    ? 'SET' : '❌ UNSET',
      TWILIO_AUTH_TOKEN:     TWILIO_AUTH_TOKEN     ? 'SET' : '❌ UNSET',
      TWILIO_WHATSAPP_NUMBER:TWILIO_WHATSAPP_NUMBER? 'SET' : '❌ UNSET',
      GEMINI_KEY:            GEMINI_KEY            ? 'SET' : '❌ UNSET',
      SUPABASE_URL:          SUPABASE_URL          ? 'SET' : '❌ UNSET',
      SUPABASE_SERVICE_KEY:  SUPABASE_SERVICE_KEY  ? 'SET' : '❌ UNSET',
    }
  });
});

app.get('/webhook', (req, res) => {
  res.send('AlquilApp WhatsApp Bot v3.0 — Webhook activo ✅');
});

// ═══════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║   AlquilApp WhatsApp Bot v3.0          ║');
    console.log(`║   Escuchando en puerto ${PORT}            ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  POST /webhook          → Recibe mensajes de Twilio');
    console.log('  GET  /notif-automaticas → Envía recordatorios de cobros');
    console.log('  POST /verify-whatsapp   → Verifica conexión al sandbox');
    console.log('  GET  /                  → Health check');
    console.log('');
    console.log('Variables de entorno:');
    console.log('  TWILIO_ACCOUNT_SID    :', TWILIO_ACCOUNT_SID    ? '✅' : '❌ FALTA');
    console.log('  TWILIO_AUTH_TOKEN     :', TWILIO_AUTH_TOKEN     ? '✅' : '❌ FALTA');
    console.log('  TWILIO_WHATSAPP_NUMBER:', TWILIO_WHATSAPP_NUMBER ? '✅' : '❌ FALTA');
    console.log('  GEMINI_KEY            :', GEMINI_KEY            ? '✅' : '❌ FALTA');
    console.log('  SUPABASE_URL          :', SUPABASE_URL          ? '✅' : '❌ FALTA');
    console.log('  SUPABASE_SERVICE_KEY  :', SUPABASE_SERVICE_KEY  ? '✅' : '❌ FALTA');
    console.log('');
  });
}
