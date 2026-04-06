// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AlquilApp â Bot de WhatsApp con Gemini AI (via Twilio)
// Permite a usuarios consultar datos de sus alquileres
// escribiendo desde su nÃºmero de WhatsApp registrado.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio envÃ­a form-urlencoded

// ââ Variables de entorno ââââââââââââââââââââââââââââââââââ
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  GEMINI_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000
} = process.env;

// ââ Supabase client (usa service_role para leer todo) âââââ
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ââ Historial de conversaciones por nÃºmero (en memoria) âââ
const conversaciones = {};

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// WEBHOOK â Twilio envÃ­a un POST cuando llega un mensaje
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/webhook', async (req, res) => {
  // Procesamos TODO antes de responder.
  // Twilio espera hasta 15 segundos. Respondemos con TwiML <Message>
  // para que Twilio mismo envÃ­e el mensaje â sin API call aparte.
  res.set('Content-Type', 'text/xml');

  try {
    const body = req.body;
    const from  = (body.From || '').replace('whatsapp:', '');
    const text  = body.Body || '';

    // ââ Detectar si vino un audio ââââââââââââââââââââââââââ
    const numMedia   = parseInt(body.NumMedia || '0', 10);
    const mediaType  = body.MediaContentType0 || '';
    const mediaUrl   = body.MediaUrl0 || '';
    const esAudio    = numMedia > 0 && mediaType.startsWith('audio/');

    if (!from || (!text && !esAudio)) {
      return res.send('<Response></Response>');
    }

    console.log(`ð© Mensaje de ${from}: ${esAudio ? `[AUDIO ${mediaType}]` : text}`);

    // ââ 1. Buscar usuario por nÃºmero de WhatsApp ââââââââââ
    const usuario = await buscarUsuario(from);

    if (!usuario) {
      const msg = 'ð Â¡Hola! No encontrÃ© tu nÃºmero registrado en AlquilApp.\n\n' +
        'Para usar el asistente por WhatsApp:\n' +
        '1. IngresÃ¡ a alquil.app\n' +
        '2. AndÃ¡ a *Mi Perfil*\n' +
        '3. CargÃ¡ tu nÃºmero de WhatsApp\n\n' +
        'Una vez registrado, podÃ©s escribirme para consultar tus datos de alquiler.';
      console.log('â ï¸ Usuario no encontrado');
      return res.send(`<Response><Message>${escapeXml(msg)}</Message></Response>`);
    }

    // ââ 2. Cargar datos del usuario desde Supabase ââââââââ
    const datos = await cargarDatosUsuario(usuario);

    // ââ 3. Procesar mensaje (texto o audio) con Gemini ââââ
    let respuesta;
    if (esAudio) {
      respuesta = await consultarGeminiConAudio(from, mediaUrl, mediaType, usuario, datos);
    } else {
      respuesta = await consultarGemini(from, text, usuario, datos);
    }

    console.log(`â Respuesta lista para ${from}`);

    // ââ 4. Responder con TwiML (Twilio envÃ­a el mensaje) ââ
    return res.send(`<Response><Message>${escapeXml(respuesta)}</Message></Response>`);

  } catch (err) {
    console.error('â Error procesando mensaje:', err);
    const errMsg = 'Hubo un problema procesando tu consulta. Por favor intentÃ¡ de nuevo en unos segundos.';
    return res.send(`<Response><Message>${escapeXml(errMsg)}</Message></Response>`);
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// BUSCAR USUARIO POR NÃMERO DE WHATSAPP
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function buscarUsuario(telefono) {
  // El nÃºmero llega como "+5493493444071"
  // En la BD guardamos "+543493444071" o "+5493493444071"
  const limpio = telefono.replace(/\s/g, '');
  const variantes = [
    limpio,
    limpio.replace(/^\+549/, '+54'),   // +5493493... â +543493...
    limpio.replace(/^\+54/, '+549'),   // +543493... â +5493493...
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

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CARGAR DATOS DEL USUARIO (contratos, cobros, servicios, etc.)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function cargarDatosUsuario(usuario) {
  const userId = usuario.id;
  const rol = usuario.rol || 'propietario';
  const datos = { rol, propiedades: [], contratos: [], cobros: [], servicios: [], expensas: [] };

  try {
    const { data: props } = await supabase.from('propiedades').select('*').eq('propietario_id', userId);
    datos.propiedades = props || [];

    const { data: contratos } = await supabase.from('contratos').select('*').eq('propietario_id', userId);
    datos.contratos = contratos || [];

    const { data: cobros } = await supabase.from('cobros').select('*').eq('propietario_id', userId);
    datos.cobros = cobros || [];

    const { data: servicios } = await supabase.from('servicios').select('*').eq('propietario_id', userId);
    datos.servicios = servicios || [];

    const { data: expensas } = await supabase.from('expensas').select('*').eq('propietario_id', userId);
    datos.expensas = expensas || [];
  } catch (e) {
    console.error('Error cargando datos del usuario:', e.message);
  }

  return datos;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CONSULTAR A GEMINI AI
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function consultarGemini(telefono, pregunta, usuario, datos) {
  if (!conversaciones[telefono]) conversaciones[telefono] = [];
  if (conversaciones[telefono].length > 20) conversaciones[telefono] = conversaciones[telefono].slice(-20);

  conversaciones[telefono].push({ role: 'user', parts: [{ text: pregunta }] });

  const systemPrompt = buildSystemPrompt(usuario, datos);
  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: conversaciones[telefono]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini HTTP error:', response.status, errText);
      return 'â ï¸ Hubo un error al procesar tu consulta. IntentÃ¡ de nuevo en un momento.';
    }

    const json = await response.json();
    if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
      console.error('Gemini respuesta vacÃ­a:', JSON.stringify(json));
      return 'â ï¸ No pude generar una respuesta. IntentÃ¡ reformular tu pregunta.';
    }

    const respuesta = json.candidates[0].content.parts[0].text.trim();
    conversaciones[telefono].push({ role: 'model', parts: [{ text: respuesta }] });
    return formatearParaWhatsApp(respuesta);

  } catch (err) {
    console.error('Gemini error:', err);
    return 'â ï¸ Error de conexiÃ³n con el asistente. IntentÃ¡ de nuevo.';
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CONSULTAR A GEMINI AI CON AUDIO
// Descarga el audio de Twilio y lo manda directamente a Gemini,
// que entiende audio nativo â sin servicio externo de transcripciÃ³n.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function consultarGeminiConAudio(telefono, audioUrl, mimeType, usuario, datos) {
  if (!conversaciones[telefono]) conversaciones[telefono] = [];
  if (conversaciones[telefono].length > 20) conversaciones[telefono] = conversaciones[telefono].slice(-20);

  // ââ Descargar el audio desde Twilio (requiere autenticaciÃ³n) ââ
  console.log(`ð¤ Descargando audio: ${audioUrl}`);
  const audioResp = await fetch(audioUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });

  if (!audioResp.ok) {
    console.error('Error descargando audio:', audioResp.status);
    return 'â ï¸ No pude procesar tu audio. Por favor escribÃ­ tu consulta en texto.';
  }

  const audioBuffer = await audioResp.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString('base64');
  console.log(`ð¤ Audio descargado: ${Math.round(audioBuffer.byteLength / 1024)} KB`);

  const systemPrompt = buildSystemPrompt(usuario, datos);

  // ââ Armar request a Gemini con audio inline ââââââââââââââ
  // Gemini 2.5 Flash entiende audio directamente â transcribe y responde en un solo paso.
  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      // Historial previo de la conversaciÃ³n
      ...conversaciones[telefono],
      // Turno actual: instrucciÃ³n + audio
      {
        role: 'user',
        parts: [
          {
            text: 'El usuario enviÃ³ un mensaje de voz. EscuchÃ¡ el audio, entendÃ© su consulta y respondÃ© directamente (sin repetir lo que dijo, solo respondÃ©). Si el audio no es claro, pedile que repita.'
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64
            }
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini error (audio):', response.status, errText);
      return 'â ï¸ No pude procesar tu audio. IntentÃ¡ escribir tu consulta.';
    }

    const json = await response.json();
    if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
      console.error('Gemini respuesta vacÃ­a (audio):', JSON.stringify(json));
      return 'â ï¸ No pude entender el audio. IntentÃ¡ escribir tu consulta.';
    }

    const respuesta = json.candidates[0].content.parts[0].text.trim();

    // Guardar en historial como texto para futuras referencias
    conversaciones[telefono].push({ role: 'user',  parts: [{ text: '[Mensaje de voz]' }] });
    conversaciones[telefono].push({ role: 'model', parts: [{ text: respuesta }] });

    console.log(`â Audio procesado para ${telefono}`);
    return formatearParaWhatsApp(respuesta);

  } catch (err) {
    console.error('Error consultando Gemini con audio:', err);
    return 'â ï¸ Error procesando tu audio. IntentÃ¡ de nuevo.';
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SYSTEM PROMPT â Contexto completo del usuario
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function buildSystemPrompt(usuario, datos) {
  const nombre = usuario.nombre || 'Usuario';
  const rol = usuario.rol || 'propietario';
  const rolLabel = rol === 'propietario' ? 'propietario/locador' : 'inquilino/locatario';

  // Mapa de propiedades por ID para cruzar con contratos y cobros
  const propMap = {};
  datos.propiedades.forEach(p => { propMap[p.id] = p.direccion || 'Sin direcciÃ³n'; });

  let prompt = `Sos *Alquil*, el asistente de WhatsApp de AlquilApp. HablÃ¡s de manera clara, directa y amigable, como si fueras un experto en alquileres que le habla a un amigo. Nada de tecnicismos innecesarios.

PodÃ©s ayudar con tres cosas:

*1. Los datos del usuario*
TenÃ©s acceso en tiempo real a todo lo que tiene cargado en AlquilApp: sus propiedades, contratos, cobros, servicios y expensas. Si te preguntan algo que estÃ¡ en los datos, lo respondÃ©s directo, sin dar vueltas. Si algo no estÃ¡ cargado, le explicÃ¡s cÃ³mo hacerlo en alquil.app.

*2. Consultas legales sobre alquileres*
OrientÃ¡s sobre cÃ³mo funciona hoy la locaciÃ³n en Argentina. Lo mÃ¡s importante que tenÃ©s que saber:

El marco legal vigente hoy es el *CÃ³digo Civil y Comercial* (arts. 1187 a 1226). La vieja Ley de Alquileres 27.551 fue *derogada* por el DNU 70/2023 (diciembre 2023) y ya no existe. Nunca la menciones como si rigiera hoy.

Lo que cambiÃ³ con el DNU 70/2023:
â¢ *DuraciÃ³n del contrato*: las partes acuerdan libremente el plazo. Ya no hay mÃ­nimo de 3 aÃ±os.
â¢ *Precio y actualizaciones*: libre acuerdo. Pueden pactar ICL, IPC, UVA, porcentaje fijo o lo que quieran.
â¢ *DepÃ³sito*: libre acuerdo, sin tope legal.
â¢ *RescisiÃ³n por el inquilino*: puede salirse del contrato a partir del 6Âº mes, con 30 dÃ­as de aviso. Si se va antes del primer aÃ±o paga 1,5 meses de penalidad; despuÃ©s del aÃ±o, 1 mes.
â¢ *Reparaciones urgentes*: si el propietario no responde, el inquilino puede hacerlas y reclamar el reembolso.
â¢ *SublocaciÃ³n*: prohibida salvo que el contrato lo permita expresamente.

Siempre que des orientaciÃ³n legal, aclarÃ¡s que es informativa y que para casos puntuales lo mejor es consultar a un abogado.

*3. Explicar cÃ³mo funciona AlquilApp*
Cuando te pregunten quÃ© es o cÃ³mo se usa la plataforma, lo explicÃ¡s asÃ­:

AlquilApp es una plataforma web para gestionar alquileres desde el navegador (alquil.app). Tiene estas secciones:
â¢ *Dashboard*: un resumen de todo â ingresos del mes, cobros pendientes y prÃ³ximos vencimientos.
â¢ *Propiedades*: cargÃ¡s tus inmuebles con direcciÃ³n, superficie, ambientes y valor en dÃ³lares.
â¢ *Contratos*: gestionÃ¡s los contratos con cada inquilino, con montos, fechas, Ã­ndice de ajuste y archivo adjunto.
â¢ *Cobros*: registrÃ¡s y seguÃ­s el estado de los pagos mensuales de cada propiedad.
â¢ *Servicios*: controlÃ¡s los servicios (luz, gas, agua, ABL, etc.) con fechas de vencimiento.
â¢ *Expensas*: seguÃ­s el pago de expensas por perÃ­odo.
â¢ *Rentabilidad*: analizÃ¡s ingresos y gastos por propiedad.
â¢ *Asistente legal*: un chat para consultas legales sobre alquileres (tambiÃ©n soy yo, pero desde la web).
â¢ *Mi Perfil*: tus datos personales y donde registrÃ¡s tu nÃºmero de WhatsApp para usar este asistente.

Para modificar datos, siempre hay que entrar a alquil.app desde el navegador â por WhatsApp solo podÃ©s consultar, no modificar.

---
USUARIO: *${nombre}* (${rolLabel})
Email: ${usuario.email || 'No registrado'}

FORMATO: EspaÃ±ol rioplatense. Mensajes cortos y claros. *Negrita* para lo importante. Listas con â¢. Sin tablas. Sin signos ## o ---. MÃ¡ximo 3-4 pÃ¡rrafos.

REGLA DE ORO: Si el dato estÃ¡ en la base de datos del usuario, lo das directamente. Si no estÃ¡ cargado, le explicÃ¡s en quÃ© secciÃ³n de alquil.app puede cargarlo.

âââââââââââ DATOS ACTUALES DEL USUARIO âââââââââââ
`;

  // PROPIEDADES
  if (datos.propiedades.length > 0) {
    prompt += `\nPROPIEDADES (${datos.propiedades.length} en total):\n`;
    datos.propiedades.forEach((p, i) => {
      prompt += `${i + 1}. ID:${p.id} | ${p.direccion || 'Sin direcciÃ³n'}, ${p.zona || ''} ${p.localidad || ''} ${p.provincia || ''}`.trim() + '\n';
      if (p.superficie) prompt += `   Superficie: ${p.superficie} mÂ² | Ambientes: ${p.ambientes || 'N/A'}\n`;
      if (p.valor_usd)  prompt += `   Valor: USD ${p.valor_usd}\n`;
    });
  } else {
    prompt += '\nPROPIEDADES: No tiene propiedades cargadas aÃºn. Puede cargarlas en alquil.app â secciÃ³n Propiedades.\n';
  }

  // CONTRATOS
  if (datos.contratos.length > 0) {
    prompt += `\nCONTRATOS (${datos.contratos.length} en total):\n`;
    datos.contratos.forEach((c, i) => {
      const propNombre = c.propiedad_id ? (propMap[c.propiedad_id] || `Propiedad ID:${c.propiedad_id}`) : 'Sin propiedad asignada';
      const monto     = c.monto_alquiler ? `$${c.monto_alquiler}` : 'Sin monto cargado';
      const inicio    = c.fecha_inicio   ? c.fecha_inicio.split('T')[0]  : 'N/A';
      const fin       = c.fecha_fin      ? c.fecha_fin.split('T')[0]     : 'N/A';
      const indice    = c.indice_ajuste  || 'ICL';
      const estado    = c.estado         || 'activo';
      const deposito  = c.deposito       ? `$${c.deposito}` : 'N/A';
      prompt += `${i + 1}. *Propiedad:* ${propNombre}\n`;
      prompt += `   Inquilino: ${c.inquilino_nombre || 'Sin asignar'} (DNI: ${c.inquilino_dni || 'N/A'})\n`;
      prompt += `   Monto: ${monto} | Ãndice: ${indice} | Estado: ${estado}\n`;
      prompt += `   Inicio: ${inicio} | Vencimiento: ${fin}\n`;
      prompt += `   DepÃ³sito: ${deposito}\n`;
      if (c.proximo_ajuste_fecha) prompt += `   PrÃ³ximo ajuste: ${c.proximo_ajuste_fecha.split('T')[0]} (${c.proximo_ajuste_pct || 0}%)\n`;
    });
  } else {
    prompt += '\nCONTRATOS: No tiene contratos cargados. Puede cargarlos en alquil.app â secciÃ³n Contratos.\n';
  }

  // COBROS
  if (datos.cobros.length > 0) {
    const pendientes = datos.cobros.filter(c => c.estado === 'pendiente');
    const pagados    = datos.cobros.filter(c => c.estado === 'pagado');
    prompt += `\nCOBROS (${datos.cobros.length} total | ${pendientes.length} pendientes | ${pagados.length} pagados):\n`;
    datos.cobros.slice(0, 8).forEach((c, i) => {
      const propNombre = c.propiedad_id ? (propMap[c.propiedad_id] || `Prop. ID:${c.propiedad_id}`) : 'N/A';
      const vence      = c.fecha_vencimiento ? c.fecha_vencimiento.split('T')[0] : 'N/A';
      prompt += `${i + 1}. ${propNombre} | Inquilino: ${c.inquilino_nombre || 'N/A'} | Monto: $${c.monto || 'N/A'} | Vence: ${vence} | Estado: ${c.estado || 'N/A'}\n`;
    });
    if (datos.cobros.length > 8) prompt += `   ... y ${datos.cobros.length - 8} cobros mÃ¡s.\n`;
  } else {
    prompt += '\nCOBROS: No tiene cobros registrados. Puede cargarlos en alquil.app â secciÃ³n Cobros.\n';
  }

  // SERVICIOS (luz, gas, agua, ABL, impuestos, etc.)
  if (datos.servicios.length > 0) {
    prompt += `\nSERVICIOS (${datos.servicios.length} registrados):\n`;
    datos.servicios.forEach((s, i) => {
      const propNombre = s.propiedad_id ? (propMap[s.propiedad_id] || `Prop. ID:${s.propiedad_id}`) : 'N/A';
      const diaVto     = s.dia_vto ? `dÃ­a ${s.dia_vto} de cada mes` : 'N/A';
      const period     = s.periodicidad || 'mensual';
      prompt += `${i + 1}. *${s.tipo || 'Servicio'}* | Propiedad: ${propNombre}\n`;
      prompt += `   Monto: $${s.monto || 'N/A'} | Vencimiento: ${diaVto} | Periodicidad: ${perio$}\n`;
      if (s.proveedor) prompt += `   Proveedor: ${s.proveedor}\n`;
      if (s.notas)    prompt += `   Notas: ${s.notas}\n`;
    });
  } else {
    prompt += '\nSERVICIOS: No tiene servicios registrados. Puede cargar luz, gas, agua, ABL, impuestos, etc. en alquil.app â secciÃ³n Servicios.\n';
  }

  // EXPENSAS
  if (datos.expensas.length > 0) {
    prompt += `\nEXPENSAS (${datos.expensas.length}):\n`;
    datos.expensas.slice(0, 5).forEach((e, i) => {
      prompt += `${i + 1}. PerÃ­odo: ${e.periodo || 'N/A'} | Monto: $${e.monto || 'N/A'} | Estado: ${e.estado || 'N/A'}\n`;
    });
  }

  prompt += '\nâââââââââââââââââââââââââââââââââââââââââââ\n';
  return prompt;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// FORMATEAR RESPUESTA PARA WHATSAPP
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function formatearParaWhatsApp(texto) {
  return texto
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .trim();
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ENVIAR MENSAJE POR WHATSAPP VIA TWILIO
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function enviarWhatsApp(to, mensaje) {
  if (mensaje.length > 1500) {
    mensaje = mensaje.substring(0, 1497) + '...';
  }

  const twilioNumber = TWILIO_WHATSAPP_NUMBER || '+14155238886';
  const accountSid = TWILIO_ACCOUNT_SID;
  const authToken = TWILIO_AUTH_TOKEN;

  const params = new URLSearchParams();
  params.append('To', `whatsapp:${to}`);
  params.append('From', `whatsapp:${twilioNumber}`);
  params.append('Body', mensaje);

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Error enviando WhatsApp via Twilio:', response.status, err);
    } else {
      const data = await response.json();
      console.log('Twilio message SID:', data.sid);
    }
  } catch (err) {
    console.error('Error de red enviando WhatsApp:', err);
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// NOTIFICACIONES AUTOMÃTICAS DE VENCIMIENTO
// Un cron job llama GET /notif-automaticas?secret=XXXX una vez por dÃ­a.
// EnvÃ­a 3 mensajes distintos segÃºn cuÃ¡ntos dÃ­as faltan para el vencimiento:
//   â¢ 5 dÃ­as â recordatorio amigable
//   â¢ 2 dÃ­as â aviso urgente
//   â¢ 0 dÃ­as â vence HOY
// Cada envÃ­o queda registrado en la tabla `notificaciones_wa` para
// evitar duplicados (nunca se manda el mismo mensaje dos veces al mismo cobro).
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/notif-automaticas', async (req, res) => {
  // ââ Seguridad: verificar el secret âââââââââââââââââââââââ
  const SECRET = process.env.NOTIF_SECRET || 'alquilapp-notif-2024';
  if (req.query.secret !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  // Fechas objetivo: hoy, hoy+2, hoy+5
  function addDias(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  }

  const fechas = {
    '5dias':     addDias(hoy, 5),
    '2dias':     addDias(hoy, 2),
    'vence_hoy': addDias(hoy, 0)
  };

  const resultados = { enviados: 0, omitidos: 0, errores: 0, detalle: [] };

  try {
    // ââ 1. Traer cobros pendientes que vencen en esas 3 fechas ââ
    const fechasList = Object.values(fechas).join(',');
    const { data: cobros, error: errCobros } = await supabase
      .from('cobros')
      .select('id, contrato_id, inquilino_nombre, monto, fecha_vencimiento, propiedad_id')
      .in('fecha_vencimiento', Object.values(fechas))
      .eq('estado', 'pendiente');

    if (errCobros) throw new Error('Error leyendo cobros: ' + errCobros.message);
    if (!cobros || cobros.length === 0) {
      return res.json({ ...resultados, mensaje: 'Sin cobros para notificar hoy' });
    }

    // ââ 2. Para cada cobro, buscar el telÃ©fono del inquilino ââ
    for (const cobro of cobros) {
      const vtoISO = cobro.fecha_vencimiento ? cobro.fecha_vencimiento.slice(0, 10) : null;

      // Determinar tipo de notificaciÃ³n
      let tipo = null;
      if (vtoISO === fechas['5dias'])     tipo = '5dias';
      else if (vtoISO === fechas['2dias']) tipo = '2dias';
      else if (vtoISO === fechas['vence_hoy']) tipo = 'vence_hoy';
      if (!tipo) continue;

      // ââ Verificar si ya se enviÃ³ este mensaje âââââââââââââ
      const { data: yaEnviado } = await supabase
        .from('notificaciones_wa')
        .select('id')
        .eq('cobro_id', cobro.id)
        .eq('tipo', tipo)
        .limit(1);

      if (yaEnviado && yaEnviado.length > 0) {
        resultados.omitidos++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, accion: 'omitido (ya enviado)' });
        continue;
      }

      // ââ Obtener telÃ©fono del inquilino desde el contrato ââ
      let telefono = null;
      let inqNombre = cobro.inquilino_nombre || 'Inquilino';

      if (cobro.contrato_id) {
        const { data: ctr } = await supabase
          .from('contratos')
          .select('inquilino_telefono, inquilino_nombre')
          .eq('id', cobro.contrato_id)
          .single();

        if (ctr) {
          telefono   = ctr.inquilino_telefono || null;
          inqNombre  = ctr.inquilino_nombre || inqNombre;
        }
      }

      if (!telefono) {
        resultados.omitidos++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, accion: 'omitido (sin telÃ©fono)' });
        continue;
      }

      // ââ Normalizar nÃºmero (Argentina: +54XXXXXXXXXX) ââââââ
      let numLimpio = telefono.replace(/\D/g, '');
      if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
      if (!numLimpio.startsWith('54')) numLimpio = '54' + numLimpio;
      const numeroFinal = '+' + numLimpio;

      // ââ Obtener direcciÃ³n de la propiedad âââââââââââââââââ
      let direccion = 'tu propiedad';
      if (cobro.propiedad_id) {
        const { data: prop } = await supabase
          .from('propiedades')
          .select('direccion')
          .eq('id', cobro.propiedad_id)
          .single();
        if (prop && prop.direccion) direccion = prop.direccion;
      }

      const montoFmt  = cobro.monto ? '$' + Number(cobro.monto).toLocaleString('es-AR') : 'el monto acordado';
      const vtoDate   = new Date(vtoISO + 'T00:00:00');
      const vtoFmt    = vtoDate.getDate() + '/' + (vtoDate.getMonth() + 1) + '/' + vtoDate.getFullYear();

      // ââ Construir mensaje segÃºn tipo ââââââââââââââââââââââ
      let mensaje = '';

      if (tipo === '5dias') {
        mensaje =
          'ð  *AlquilApp â Recordatorio de pago*\n\n' +
          'Hola ' + inqNombre.split(' ')[0] + '! Te recordamos que el alquiler de ' +
          '*' + direccion + '* vence en *5 dÃ­as* (el ' + vtoFmt + ').\n\n' +
          'ð° Monto: *' + montoFmt + '*\n\n' +
          'Por favor asegurate de tenerlo listo para el vencimiento. Â¡Gracias! ð';
      } else if (tipo === '2dias') {
        mensaje =
          'â ï¸ *AlquilApp â Pago prÃ³ximo a vencer*\n\n' +
          'Hola ' + inqNombre.split(' ')[0] + ', quedan *solo 2 dÃ­as* para que venza ' +
          'tu alquiler de *' + direccion + '* (el ' + vtoFmt + ').\n\n' +
          'ð° Monto a pagar: *' + montoFmt + '*\n\n' +
          'Si ya lo realizaste, podÃ©s ignorar este mensaje. De lo contrario, ' +
          'te pedimos que lo gestiones a la brevedad. ð';
      } else if (tipo === 'vence_hoy') {
        mensaje =
          'ð´ *AlquilApp â Vencimiento HOY*\n\n' +
          'Hola ' + inqNombre.split(' ')[0] + ', hoy vence el pago de tu alquiler ' +
          'de *' + direccion + '*.\n\n' +
          'ð° Monto: *' + montoFmt + '*\n\n' +
          'Por favor efectuÃ¡ el pago hoy para evitar inconvenientes. ' +
          'Ante cualquier consulta, contactÃ¡ a tu propietario. ð';
      }

      // ââ Enviar por Twilio âââââââââââââââââââââââââââââââââ
      try {
        await enviarWhatsApp(numeroFinal, mensaje);

        // ââ Registrar en notificaciones_wa ââââââââââââââââ
        await supabase.from('notificaciones_wa').insert({
          cobro_id:   cobro.id,
          tipo:       tipo,
          telefono:   numeroFinal,
          estado:     'enviado'
        });

        resultados.enviados++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, telefono: numeroFinal, accion: 'enviado' });
        console.log(`â Notif ${tipo} enviada a ${numeroFinal} (cobro ${cobro.id})`);

      } catch (errEnvio) {
        console.error(`â Error enviando a ${numeroFinal}:`, errEnvio.message);

        // Registrar el error igual para no reintentar
        await supabase.from('notificaciones_wa').insert({
          cobro_id:   cobro.id,
          tipo:       tipo,
          telefono:   numeroFinal,
          estado:     'error'
        });

        resultados.errores++;
        resultados.detalle.push({ cobro_id: cobro.id, tipo, telefono: numeroFinal, accion: 'error', error: errEnvio.message });
      }
    }

    console.log(`ð Notificaciones: ${resultados.enviados} enviadas, ${resultados.omitidos} omitidas, ${resultados.errores} errores`);
    return res.json(resultados);

  } catch (err) {
    console.error('â Error en /notif-automaticas:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// VERIFY WHATSAPP â La web llama este endpoint para verificar
// si el nÃºmero ya se uniÃ³ al Twilio Sandbox y enviarle bienvenida
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
  if (!phone) {
    return res.status(400).json({ connected: false, error: 'Falta el nÃºmero de telÃ©fono' });
  }

  // Normalizar nÃºmero: asegurar formato E.164
  let numero = phone.trim();
  if (!numero.startsWith('+')) numero = '+' + numero;

  const toWhatsapp  = `whatsapp:${numero}`;
  const fromWhatsapp = `whatsapp:${TWILIO_WHATSAPP_NUMBER || '+14155238886'}`;

  const mensajeBienvenida =
    'â Â¡Tu asistente *Alquil* estÃ¡ activo!\n\n' +
    'Ahora podÃ©s escribirme para consultar:\n' +
    'â¢ ð Cobros y vencimientos\n' +
    'â¢ ð¡ Servicios (luz, gas, ABL...)\n' +
    'â¢ ð§¾ Comprobantes y recibos\n' +
    'â¢ âï¸ Dudas legales\n' +
    'â¢ ð¤ Â¡TambiÃ©n podÃ©s mandarme audios!\n\n' +
    '_Â¿QuÃ© querÃ©s saber?_';

  try {
    // Intentar enviar un mensaje via Twilio REST API
    const authStr = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

    const params = new URLSearchParams();
    params.append('To', toWhatsapp);
    params.append('From', fromWhatsapp);
    params.append('Body', mensajeBienvenida);

    const resp = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authStr}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const data = await resp.json();

    if (resp.ok && data.sid) {
      // Mensaje enviado correctamente â nÃºmero estÃ¡ en el sandbox
      console.log(`â Bienvenida enviada a ${numero} (SID: ${data.sid})`);
      return res.json({ connected: true });
    } else {
      // Twilio rechazÃ³ â probablemente no estÃ¡ en el sandbox
      const errMsg = data.message || data.error_message || 'No conectado al sandbox';
      console.log(`â ï¸ verify-whatsapp: ${numero} â ${errMsg}`);
      return res.json({ connected: false, twilioError: errMsg });
    }
  } catch (err) {
    console.error('â verify-whatsapp error:', err.message);
    return res.status(500).json({ connected: false, error: err.message });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// HEALTH CHECK
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AlquilApp WhatsApp Bot (Twilio)',
    version: '2.6.0',
    timestamp: new Date().toISOString(),
    env_check: {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? 'SET' : 'UNSET',
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'UNSET',
      GEMINI_KEY: process.env.GEMINI_KEY ? 'SET' : 'UNSET',
      SUPABASE_URL: process.env.SUPABASE_URL ? 'SET' : 'UNSET'
    }
  });
});

// Mantener el webhook GET para compatibilidad
app.get('/webhook', (req, res) => {
  res.send('AlquilApp WhatsApp Bot - Webhook activo');
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// INICIAR SERVIDOR / EXPORTAR PARA VERCEL
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('');
    console.log('âââââââââââââââââââââââââââââââââââââââââââ');
    console.log('  ð¤ AlquilApp WhatsApp Bot (Twilio)');
    console.log(`  ð Servidor corriendo en puerto ${PORT}`);
    console.log('  ð± Esperando mensajes de WhatsApp...');
    console.log('âââââââââââââââââââââââââââââââââââââââââââ');
    console.log('');
  });
}
