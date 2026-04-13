// ═══════════════════════════════════════════════════════════
// AlquilApp — Bot de WhatsApp con Gemini AI (via Twilio)
// v4.1 — Recibos PDF, facturas de servicios, recordatorios
//         automáticos de alquiler y servicios.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');

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
// GENERAR PDF RECIBO DE PAGO (con pdfkit)
// Replica el diseño del frontend: header azul, filas, monto
// ═══════════════════════════════════════════════════════════
function generarPDFRecibo(cobro, contrato, propiedad) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];
      doc.on('data', d => buffers.push(d));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const W = 595.28; // A4 width in points
      const M = 50;
      const CW = W - 2 * M;

      const now = new Date();
      const fechaHoy = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
      const nroRecibo = cobro.id ? String(cobro.id).slice(-6).toUpperCase() : ('R' + Date.now().toString().slice(-6));

      const inqNombre = cobro.inquilino_nombre || contrato?.inquilino_nombre || '—';
      const direccion = propiedad?.direccion || '—';
      const monto = cobro.monto || 0;
      const montoFmt = '$' + Number(monto).toLocaleString('es-AR');

      // Periodo: usar fecha_vencimiento para deducir mes/año
      let periodo = '—';
      if (cobro.fecha_vencimiento) {
        const d = new Date(cobro.fecha_vencimiento);
        const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        periodo = `${meses[d.getMonth()]} ${d.getFullYear()}`;
      }

      const metodoPago = cobro.metodo_pago || 'Manual';
      const fechaPago = cobro.fecha_pago
        ? cobro.fecha_pago.slice(0,10).split('-').reverse().join('/')
        : fechaHoy;

      // ── Header azul ──
      doc.save();
      doc.roundedRect(M, M, CW, 65, 8).fill('#1E5FAD');
      doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
         .text('Alquil.app', M + 15, M + 12, { width: CW - 30 });
      doc.fontSize(10).font('Helvetica')
         .text('Recibo de Pago de Alquiler', M + 15, M + 38);
      doc.fontSize(11).font('Helvetica-Bold')
         .text('N° ' + nroRecibo, M + 15, M + 12, { width: CW - 30, align: 'right' });
      doc.fontSize(9).font('Helvetica')
         .text('Emitido: ' + fechaHoy, M + 15, M + 38, { width: CW - 30, align: 'right' });
      doc.restore();

      let y = M + 80;

      // ── Filas de datos ──
      function pdfRow(label, value, isBold) {
        doc.save();
        doc.rect(M, y, CW, 28).fill('#F8FAFC');
        doc.rect(M, y, CW, 28).stroke('#E2E8F0');
        doc.fillColor('#64748B').fontSize(10).font('Helvetica')
           .text(label, M + 10, y + 8, { width: CW/2 });
        doc.fillColor('#1E293B').fontSize(10).font(isBold ? 'Helvetica-Bold' : 'Helvetica')
           .text(String(value), M + CW/2, y + 8, { width: CW/2 - 10, align: 'right' });
        doc.restore();
        y += 28;
      }

      pdfRow('Inquilino / Locatario', inqNombre, false);
      pdfRow('Propiedad', direccion, false);
      pdfRow('Período', periodo, false);
      pdfRow('Fecha de pago', fechaPago, false);
      pdfRow('Método de pago', metodoPago, false);
      y += 10;

      // ── Monto total destacado ──
      doc.save();
      doc.roundedRect(M, y, CW, 50, 8).fill('#1E5FAD');
      doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica')
         .text('MONTO TOTAL RECIBIDO', M + 15, y + 10);
      doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
         .text(montoFmt, M + 15, y + 10, { width: CW - 30, align: 'right' });
      doc.restore();
      y += 65;

      // ── Nota legal ──
      doc.fillColor('#94A3B8').fontSize(8).font('Helvetica')
         .text('El presente recibo acredita el pago del canon locativo correspondiente al periodo indicado. Conservar como comprobante.', M, y, { width: CW });
      y += 30;

      // ── Footer ──
      doc.strokeColor('#E2E8F0').moveTo(M, y).lineTo(M + CW, y).stroke();
      y += 10;
      doc.fillColor('#94A3B8').fontSize(7).font('Helvetica')
         .text('Generado por Alquil.app  —  alquil.app', M, y, { width: CW, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SUBIR PDF A SUPABASE STORAGE
// Bucket: "recibos" (se crea automáticamente si no existe)
// Retorna la URL pública del archivo
// ═══════════════════════════════════════════════════════════
async function subirPDFaStorage(buffer, filename, bucket = 'recibos') {
  // Intentar crear el bucket si no existe (ignora error si ya existe)
  await supabase.storage.createBucket(bucket, { public: true }).catch(() => {});

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, buffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) throw new Error('Error subiendo PDF: ' + error.message);

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
  return urlData.publicUrl;
}

// ═══════════════════════════════════════════════════════════
// ENVIAR WHATSAPP CON PDF ADJUNTO (MediaUrl de Twilio)
// ═══════════════════════════════════════════════════════════
async function enviarWhatsAppConPDF(to, mensaje, pdfUrl) {
  if (mensaje.length > 1500) mensaje = mensaje.substring(0, 1497) + '...';

  const twilioNumber = TWILIO_WHATSAPP_NUMBER || '+14155238886';
  const params = new URLSearchParams();
  params.append('To',   `whatsapp:${to}`);
  params.append('From', `whatsapp:${twilioNumber}`);
  params.append('Body', mensaje);
  if (pdfUrl) params.append('MediaUrl', pdfUrl);

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
  console.log('Twilio SID (con PDF):', data.sid);
  return data;
}

// ═══════════════════════════════════════════════════════════
// GENERAR Y ENVIAR RECIBO DE UN COBRO PAGADO
// Se usa tanto desde el webhook (pedido del usuario) como
// desde el endpoint /cobro-pagado (auto-envío)
// ═══════════════════════════════════════════════════════════
async function generarYEnviarRecibo(cobro, telefono) {
  // Obtener contrato y propiedad para el PDF
  let contrato = null;
  let propiedad = null;

  if (cobro.contrato_id) {
    const { data: ctr } = await supabase
      .from('contratos')
      .select('*')
      .eq('id', cobro.contrato_id)
      .single();
    contrato = ctr;
  }
  if (cobro.propiedad_id) {
    const { data: prop } = await supabase
      .from('propiedades')
      .select('*')
      .eq('id', cobro.propiedad_id)
      .single();
    propiedad = prop;
  }

  // Generar PDF
  const pdfBuffer = await generarPDFRecibo(cobro, contrato, propiedad);
  const nroRecibo = cobro.id ? String(cobro.id).slice(-6).toUpperCase() : Date.now().toString().slice(-6);
  const filename = `recibo_${nroRecibo}_${Date.now()}.pdf`;

  // Subir a Supabase Storage
  const pdfUrl = await subirPDFaStorage(pdfBuffer, filename, 'recibos');
  console.log(`📄 Recibo PDF generado: ${pdfUrl}`);

  // Deducir periodo
  let periodo = '';
  if (cobro.fecha_vencimiento) {
    const d = new Date(cobro.fecha_vencimiento);
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    periodo = `${meses[d.getMonth()]} ${d.getFullYear()}`;
  }

  const montoFmt = cobro.monto ? '$' + Number(cobro.monto).toLocaleString('es-AR') : '';
  const mensaje =
    '🧾 *AlquilApp — Recibo de Pago*\n\n' +
    `Acá tenés tu recibo de pago${periodo ? ` de *${periodo}*` : ''}` +
    `${montoFmt ? ` por *${montoFmt}*` : ''}.\n\n` +
    '📎 El PDF está adjunto a este mensaje.\n' +
    'Guardalo como comprobante. ¡Gracias! 🙌';

  await enviarWhatsAppConPDF(telefono, mensaje, pdfUrl);
  console.log(`✅ Recibo enviado a ${telefono}`);
  return pdfUrl;
}

// ═══════════════════════════════════════════════════════════
// BUSCAR COBRO PAGADO POR PERIODO (para cuando el usuario pide un recibo)
// ═══════════════════════════════════════════════════════════
async function buscarCobroPorPeriodo(usuario, textoMes) {
  const email = usuario.email || '';
  const rol = usuario.rol || 'propietario';

  // Mapear texto a número de mes
  const mesesMap = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
    'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
  };

  let mesTarget = null;
  let anioTarget = new Date().getFullYear();

  // Buscar mes en el texto
  const textoLower = textoMes.toLowerCase();
  for (const [key, val] of Object.entries(mesesMap)) {
    if (textoLower.includes(key)) {
      mesTarget = val;
      break;
    }
  }

  // Buscar año si se mencionó
  const anioMatch = textoLower.match(/20\d{2}/);
  if (anioMatch) anioTarget = parseInt(anioMatch[0]);

  // Si dice "último" o "ultimo" o no especifica mes, buscar el más reciente
  const buscarUltimo = textoLower.includes('ultimo') || textoLower.includes('último') || mesTarget === null;

  let query;
  if (rol === 'inquilino') {
    // Obtener contratos del inquilino
    const { data: contratos } = await supabase
      .from('contratos')
      .select('id')
      .eq('inquilino_email', email);
    if (!contratos || contratos.length === 0) return null;
    const contratoIds = contratos.map(c => c.id);

    query = supabase
      .from('cobros')
      .select('*')
      .in('contrato_id', contratoIds)
      .eq('estado', 'pagado')
      .order('fecha_vencimiento', { ascending: false });
  } else {
    query = supabase
      .from('cobros')
      .select('*')
      .eq('propietario_id', usuario.id)
      .eq('estado', 'pagado')
      .order('fecha_vencimiento', { ascending: false });
  }

  const { data: cobros } = await query;
  if (!cobros || cobros.length === 0) return null;

  if (buscarUltimo) return cobros[0]; // El más reciente

  // Filtrar por mes y año
  const encontrado = cobros.find(c => {
    if (!c.fecha_vencimiento) return false;
    const d = new Date(c.fecha_vencimiento);
    return d.getMonth() === mesTarget && d.getFullYear() === anioTarget;
  });

  return encontrado || null;
}

// ═══════════════════════════════════════════════════════════
// BUSCAR FACTURA DE SERVICIO (luz, gas, agua, etc.)
// ═══════════════════════════════════════════════════════════
async function buscarFacturaServicio(usuario, texto) {
  const email = usuario.email || '';
  const rol = usuario.rol || 'propietario';

  // Detectar tipo de servicio
  const textoLower = texto.toLowerCase();
  const tiposMap = {
    'luz': ['luz', 'electricidad', 'electrica', 'eléctrica', 'epec', 'edenor', 'edesur', 'enersa'],
    'gas': ['gas', 'gasnor', 'litoral gas', 'metrogas', 'camuzzi'],
    'agua': ['agua', 'aguas', 'assa', 'aysa', 'absa'],
    'internet': ['internet', 'wifi', 'fibra'],
    'cable': ['cable', 'television', 'televisión', 'tv'],
    'telefono': ['telefono', 'teléfono', 'celular'],
    'abl': ['abl', 'municipal', 'municipalidad', 'tasa'],
    'expensas': ['expensas', 'consorcio']
  };

  let tipoDetectado = null;
  for (const [tipo, keywords] of Object.entries(tiposMap)) {
    if (keywords.some(kw => textoLower.includes(kw))) {
      tipoDetectado = tipo;
      break;
    }
  }

  // Obtener propiedad IDs según rol
  let propIds = [];
  if (rol === 'inquilino') {
    const { data: contratos } = await supabase
      .from('contratos')
      .select('propiedad_id')
      .eq('inquilino_email', email);
    if (contratos) propIds = contratos.map(c => c.propiedad_id).filter(Boolean);
  } else {
    const { data: props } = await supabase
      .from('propiedades')
      .select('id')
      .eq('propietario_id', usuario.id);
    if (props) propIds = props.map(p => p.id);
  }

  if (propIds.length === 0) return { error: 'no_propiedades' };

  // Buscar servicios
  let queryServ = supabase
    .from('servicios')
    .select('*')
    .in('propiedad_id', propIds);

  if (tipoDetectado) {
    // Buscar por tipo (case insensitive via ilike)
    queryServ = queryServ.ilike('tipo', `%${tipoDetectado}%`);
  }

  const { data: servicios } = await queryServ;
  if (!servicios || servicios.length === 0) {
    return { error: 'no_servicio', tipoDetectado };
  }

  // Para cada servicio encontrado, buscar la factura más reciente en facturas_servicios
  for (const servicio of servicios) {
    const { data: facturas } = await supabase
      .from('facturas_servicios')
      .select('*')
      .eq('servicio_id', servicio.id)
      .order('fecha_vto', { ascending: false })
      .limit(1);

    if (facturas && facturas.length > 0 && facturas[0].factura_url) {
      return {
        servicio,
        factura: facturas[0],
        facturaUrl: facturas[0].factura_url
      };
    }

    // Si no hay en facturas_servicios, check factura_url del servicio mismo
    if (servicio.factura_url) {
      return {
        servicio,
        factura: null,
        facturaUrl: servicio.factura_url
      };
    }
  }

  return { error: 'no_factura', tipoDetectado, servicios };
}

// ═══════════════════════════════════════════════════════════
// DETECTAR INTENCIÓN DEL MENSAJE (regex antes de Gemini)
// ═══════════════════════════════════════════════════════════
function detectarIntencion(texto) {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Pedido de recibo
  if (/recibo|comprobante|comprobant/.test(t) && /mand|envi|pasa|quiero|necesito|dame|genera/.test(t)) {
    return { tipo: 'recibo', texto };
  }
  // "mandame el recibo de marzo", etc.
  if (/recibo/.test(t)) {
    return { tipo: 'recibo', texto };
  }

  // Pedido de factura de servicio
  if (/factura|boleta/.test(t) && /mand|envi|pasa|quiero|necesito|dame/.test(t)) {
    return { tipo: 'factura_servicio', texto };
  }
  // "pasame la factura de luz"
  if (/factura/.test(t) && /luz|gas|agua|internet|cable|abl|expensas|servicio/.test(t)) {
    return { tipo: 'factura_servicio', texto };
  }
  // "mandame la de luz/gas/agua" (sin decir factura explícitamente)
  if (/mand|envi|pasa/.test(t) && /\b(luz|gas|agua)\b/.test(t) && !/recibo/.test(t)) {
    return { tipo: 'factura_servicio', texto };
  }

  return null; // No es un comando especial → va a Gemini
}

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

    // ── 2. Detectar intención especial (recibo, factura) ──
    if (!esAudio && text) {
      const intencion = detectarIntencion(text);

      if (intencion?.tipo === 'recibo') {
        console.log('🧾 Intención detectada: RECIBO');
        // Respuesta inmediata a Twilio (no hacer esperar)
        res.send(`<Response><Message>${escapeXml('🧾 Buscando tu recibo... un momento.')}</Message></Response>`);

        // Procesar en background
        (async () => {
          try {
            const cobro = await buscarCobroPorPeriodo(usuario, text);
            if (!cobro) {
              await enviarWhatsApp(from, '❌ No encontré un cobro pagado para ese período. Verificá que el pago esté registrado en AlquilApp.');
              return;
            }
            await generarYEnviarRecibo(cobro, from);
          } catch (err) {
            console.error('❌ Error generando recibo:', err);
            await enviarWhatsApp(from, '⚠️ Hubo un error generando el recibo. Intentá de nuevo en un momento.').catch(() => {});
          }
        })();
        return;
      }

      if (intencion?.tipo === 'factura_servicio') {
        console.log('📄 Intención detectada: FACTURA SERVICIO');
        res.send(`<Response><Message>${escapeXml('📄 Buscando la factura... un momento.')}</Message></Response>`);

        (async () => {
          try {
            const resultado = await buscarFacturaServicio(usuario, text);

            if (resultado.error === 'no_propiedades') {
              await enviarWhatsApp(from, '❌ No tenés propiedades asociadas en AlquilApp. Verificá tu cuenta en alquil.app.');
              return;
            }
            if (resultado.error === 'no_servicio') {
              const tipoMsg = resultado.tipoDetectado ? ` de *${resultado.tipoDetectado}*` : '';
              await enviarWhatsApp(from, `❌ No encontré un servicio${tipoMsg} registrado en tu propiedad. Verificá en la sección *Servicios* de alquil.app.`);
              return;
            }
            if (resultado.error === 'no_factura') {
              const tipoMsg = resultado.tipoDetectado ? ` de *${resultado.tipoDetectado}*` : '';
              await enviarWhatsApp(from, `📄 Encontré el servicio${tipoMsg}, pero no tiene una factura cargada todavía. El propietario puede subir la factura en la sección *Servicios* de alquil.app.`);
              return;
            }

            // Tenemos la factura URL
            const servNombre = resultado.servicio.tipo || resultado.servicio.nombre || 'Servicio';
            let montoMsg = '';
            if (resultado.factura?.monto) {
              montoMsg = `\n💰 Monto: *$${Number(resultado.factura.monto).toLocaleString('es-AR')}*`;
            }
            let vtoMsg = '';
            if (resultado.factura?.fecha_vto) {
              const d = new Date(resultado.factura.fecha_vto);
              vtoMsg = `\n📅 Vencimiento: *${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}*`;
            }

            const mensaje =
              `📄 *AlquilApp — Factura de ${servNombre}*\n` +
              montoMsg + vtoMsg +
              '\n\n📎 Acá va la factura adjunta. ¡Guardala! 📋';

            await enviarWhatsAppConPDF(from, mensaje, resultado.facturaUrl);
            console.log(`✅ Factura de ${servNombre} enviada a ${from}`);
          } catch (err) {
            console.error('❌ Error enviando factura:', err);
            await enviarWhatsApp(from, '⚠️ Hubo un error buscando la factura. Intentá de nuevo en un momento.').catch(() => {});
          }
        })();
        return;
      }
    }

    // ── 3. Cargar datos del usuario desde Supabase ────────
    const datos = await cargarDatosUsuario(usuario);

    // ── 4. Procesar mensaje con Gemini ────────────────────
    let respuesta;
    if (esAudio) {
      respuesta = await consultarGeminiConAudio(from, mediaUrl, mediaType, usuario, datos);
    } else {
      respuesta = await consultarGemini(from, text, usuario, datos);
    }

    // ── 5. Verificar si Gemini incluyó un comando [CMD:...] ──
    const { textoLimpio, comando } = procesarComandoCMD(respuesta);

    if (comando) {
      console.log(`🤖 Comando CMD detectado: ${comando.tipo} → ${comando.param}`);
      // Enviar respuesta limpia inmediatamente
      res.send(`<Response><Message>${escapeXml(textoLimpio)}</Message></Response>`);

      // Ejecutar acción en background
      (async () => {
        try {
          if (comando.tipo === 'recibo') {
            const cobro = await buscarCobroPorPeriodo(usuario, comando.param);
            if (!cobro) {
              await enviarWhatsApp(from, '❌ No encontré un cobro pagado para ese período. Verificá que el pago esté registrado en AlquilApp.');
              return;
            }
            await generarYEnviarRecibo(cobro, from);
          } else if (comando.tipo === 'factura') {
            const resultado = await buscarFacturaServicio(usuario, comando.param);
            if (resultado.error === 'no_propiedades') {
              await enviarWhatsApp(from, '❌ No tenés propiedades asociadas en AlquilApp.');
              return;
            }
            if (resultado.error === 'no_servicio') {
              await enviarWhatsApp(from, `❌ No encontré un servicio de *${comando.param}* registrado. Verificá en *Servicios* de alquil.app.`);
              return;
            }
            if (resultado.error === 'no_factura') {
              await enviarWhatsApp(from, `📄 Encontré el servicio de *${comando.param}*, pero no tiene factura cargada. El propietario puede subirla en *Servicios* de alquil.app.`);
              return;
            }
            const servNombre = resultado.servicio.tipo || resultado.servicio.nombre || 'Servicio';
            let montoMsg = resultado.factura?.monto ? `\n💰 Monto: *$${Number(resultado.factura.monto).toLocaleString('es-AR')}*` : '';
            let vtoMsg = '';
            if (resultado.factura?.fecha_vto) {
              const d = new Date(resultado.factura.fecha_vto);
              vtoMsg = `\n📅 Vencimiento: *${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}*`;
            }
            const mensaje = `📄 *AlquilApp — Factura de ${servNombre}*\n` + montoMsg + vtoMsg + '\n\n📎 Acá va la factura adjunta. 📋';
            await enviarWhatsAppConPDF(from, mensaje, resultado.facturaUrl);
            console.log(`✅ Factura de ${servNombre} enviada a ${from}`);
          }
        } catch (err) {
          console.error('❌ Error ejecutando comando CMD:', err);
          await enviarWhatsApp(from, '⚠️ Hubo un error procesando tu pedido. Intentá de nuevo.').catch(() => {});
        }
      })();
      return;
    }

    console.log(`✅ Respuesta lista para ${from}`);
    return res.send(`<Response><Message>${escapeXml(textoLimpio)}</Message></Response>`);

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
// ENDPOINT: COBRO PAGADO → Auto-envío de recibo
// La web llama este endpoint cuando un cobro se marca "pagado"
// POST /cobro-pagado { cobro_id, secret }
// ═══════════════════════════════════════════════════════════
app.options('/cobro-pagado', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/cobro-pagado', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const SECRET = NOTIF_SECRET || 'alquilapp-notif-2024';
  const { cobro_id, secret } = req.body;

  if (secret !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (!cobro_id) {
    return res.status(400).json({ error: 'Falta cobro_id' });
  }

  try {
    // Obtener cobro
    const { data: cobro, error: errCobro } = await supabase
      .from('cobros')
      .select('*')
      .eq('id', cobro_id)
      .single();

    if (errCobro || !cobro) {
      return res.status(404).json({ error: 'Cobro no encontrado' });
    }

    if (cobro.estado !== 'pagado') {
      return res.json({ ok: false, mensaje: 'El cobro no está marcado como pagado' });
    }

    // Buscar teléfono del inquilino
    let telefono = null;
    if (cobro.contrato_id) {
      const { data: ctr } = await supabase
        .from('contratos')
        .select('inquilino_telefono, inquilino_email')
        .eq('id', cobro.contrato_id)
        .single();

      if (ctr?.inquilino_telefono) {
        telefono = ctr.inquilino_telefono;
      } else if (ctr?.inquilino_email) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('whatsapp_phone')
          .eq('email', ctr.inquilino_email)
          .single();
        if (profile?.whatsapp_phone) telefono = profile.whatsapp_phone;
      }
    }

    if (!telefono) {
      return res.json({ ok: false, mensaje: 'No se encontró teléfono del inquilino' });
    }

    // Normalizar número
    let numLimpio = telefono.replace(/\D/g, '');
    if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
    if (!numLimpio.startsWith('54')) numLimpio = '54' + numLimpio;
    const numeroFinal = '+' + numLimpio;

    // Generar y enviar
    const pdfUrl = await generarYEnviarRecibo(cobro, numeroFinal);
    console.log(`🧾 Recibo auto-enviado para cobro ${cobro_id} → ${numeroFinal}`);
    return res.json({ ok: true, pdfUrl, telefono: numeroFinal });

  } catch (err) {
    console.error('❌ Error en /cobro-pagado:', err);
    return res.status(500).json({ error: err.message });
  }
});

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
      const { data: contratos } = await supabase
        .from('contratos')
        .select('*')
        .eq('inquilino_email', email);
      datos.contratos = contratos || [];

      if (datos.contratos.length > 0) {
        const propIds     = [...new Set(datos.contratos.map(c => c.propiedad_id).filter(Boolean))];
        const contratoIds = datos.contratos.map(c => c.id);

        if (propIds.length > 0) {
          const { data: props } = await supabase
            .from('propiedades')
            .select('*')
            .in('id', propIds);
          datos.propiedades = props || [];

          const { data: servicios } = await supabase
            .from('servicios')
            .select('*')
            .in('propiedad_id', propIds);
          datos.servicios = servicios || [];

          const { data: expensas } = await supabase
            .from('expensas')
            .select('*')
            .in('propiedad_id', propIds)
            .order('periodo', { ascending: false })
            .limit(12);
          datos.expensas = expensas || [];
        }

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

Podés ayudarlo con estas cosas:

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

*4. Recibos y facturas por WhatsApp*
El usuario puede pedir:
• *Recibo de pago*: escribiendo algo como "mandame el recibo de marzo" o "quiero el recibo del último pago". Se genera un PDF y se envía automáticamente.
• *Factura de servicio*: escribiendo "mandame la factura de luz" o "pasame la boleta de gas". Se envía el PDF de la última factura cargada.

IMPORTANTE — Cuando el usuario pide un recibo de pago o una factura de servicio (ya sea por texto o por audio), DEBÉS incluir un comando especial AL INICIO de tu respuesta para que el sistema lo procese automáticamente:
• Para recibos: empezá tu respuesta con [CMD:recibo:PERIODO] donde PERIODO es el mes (ej: "marzo 2026", "ultimo").
• Para facturas de servicio: empezá tu respuesta con [CMD:factura:TIPO] donde TIPO es el servicio (ej: "luz", "gas", "agua").
Después del comando, escribí un mensaje corto confirmando que se está procesando (ej: "🧾 Buscando tu recibo de marzo...").
Ejemplos: "[CMD:recibo:marzo 2026] 🧾 Buscando tu recibo de marzo, ya te lo mando!" o "[CMD:factura:luz] 📄 Buscando la factura de luz, un momento!"

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
      const c    = datos.contratos[0];
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
// ═══════════════════════════════════════════════════════════
// PROCESAR COMANDO CMD EN RESPUESTA DE GEMINI
// Gemini incluye [CMD:recibo:periodo] o [CMD:factura:tipo]
// cuando el usuario pide un recibo/factura por audio.
// Retorna { textoLimpio, comando } donde comando es null si no hay CMD.
// ═══════════════════════════════════════════════════════════
function procesarComandoCMD(respuesta) {
  const match = respuesta.match(/\[CMD:(recibo|factura):([^\]]+)\]/i);
  if (!match) return { textoLimpio: respuesta, comando: null };

  const tipo = match[1].toLowerCase();
  const param = match[2].trim();
  const textoLimpio = respuesta.replace(match[0], '').trim();

  return { textoLimpio, comando: { tipo, param } };
}

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
// ENVIAR MENSAJE POR WHATSAPP VIA TWILIO (solo texto)
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
// Envía recordatorios 5 días, 2 días y el día del vencimiento
// para COBROS de alquiler y FACTURAS DE SERVICIOS.
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
    // ════════════════════════════════════════════════════════
    // PARTE 1: Recordatorios de COBROS de alquiler
    // ════════════════════════════════════════════════════════
    const { data: cobros, error: errCobros } = await supabase
      .from('cobros')
      .select('id, contrato_id, inquilino_nombre, monto, fecha_vencimiento, propiedad_id')
      .in('fecha_vencimiento', Object.values(fechas))
      .eq('estado', 'pendiente');

    if (errCobros) throw new Error('Error leyendo cobros: ' + errCobros.message);

    if (cobros && cobros.length > 0) {
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
          console.log(`✅ Notif cobro ${tipo} → ${numeroFinal}`);
        } catch (errEnvio) {
          console.error(`❌ Error enviando a ${numeroFinal}:`, errEnvio.message);
          await supabase.from('notificaciones_wa').insert({
            cobro_id: cobro.id, tipo, telefono: numeroFinal, estado: 'error'
          });
          resultados.errores++;
          resultados.detalle.push({ cobro_id: cobro.id, tipo, telefono: numeroFinal, accion: 'error', error: errEnvio.message });
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // PARTE 2: Recordatorios de FACTURAS DE SERVICIOS
    // ════════════════════════════════════════════════════════
    const { data: facturas, error: errFacturas } = await supabase
      .from('facturas_servicios')
      .select('id, servicio_id, monto, fecha_vto, periodo, estado')
      .in('fecha_vto', Object.values(fechas))
      .in('estado', ['pendiente', 'Pendiente']);

    if (errFacturas) {
      console.error('Error leyendo facturas_servicios:', errFacturas.message);
    }

    if (facturas && facturas.length > 0) {
      for (const factura of facturas) {
        const vtoISO = factura.fecha_vto?.slice(0, 10);
        let tipo = null;
        if (vtoISO === fechas['5dias'])     tipo = 'serv_5dias';
        else if (vtoISO === fechas['2dias']) tipo = 'serv_2dias';
        else if (vtoISO === fechas['vence_hoy']) tipo = 'serv_vence_hoy';
        if (!tipo) continue;

        // Verificar si ya se envió (usando servicio_factura_id)
        const { data: yaEnviado } = await supabase
          .from('notificaciones_wa')
          .select('id')
          .eq('servicio_factura_id', factura.id)
          .eq('tipo', tipo)
          .limit(1);

        if (yaEnviado?.length > 0) {
          resultados.omitidos++;
          resultados.detalle.push({ factura_id: factura.id, tipo, accion: 'omitido (ya enviado)' });
          continue;
        }

        // Obtener servicio → propiedad → contrato → inquilino
        const { data: servicio } = await supabase
          .from('servicios')
          .select('tipo, nombre, propiedad_id, a_cargo_de')
          .eq('id', factura.servicio_id)
          .single();

        if (!servicio) continue;

        // Solo notificar si está a cargo del inquilino (o si no está especificado)
        if (servicio.a_cargo_de && servicio.a_cargo_de !== 'inquilino') {
          resultados.omitidos++;
          resultados.detalle.push({ factura_id: factura.id, tipo, accion: 'omitido (a cargo del propietario)' });
          continue;
        }

        // Buscar contrato activo de esta propiedad para obtener el inquilino
        const { data: contratos } = await supabase
          .from('contratos')
          .select('inquilino_telefono, inquilino_nombre, inquilino_email')
          .eq('propiedad_id', servicio.propiedad_id)
          .eq('estado', 'activo')
          .limit(1);

        if (!contratos || contratos.length === 0) continue;
        const ctr = contratos[0];

        let telefono = ctr.inquilino_telefono || null;
        if (!telefono && ctr.inquilino_email) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('whatsapp_phone')
            .eq('email', ctr.inquilino_email)
            .single();
          if (profile?.whatsapp_phone) telefono = profile.whatsapp_phone;
        }

        if (!telefono) {
          resultados.omitidos++;
          resultados.detalle.push({ factura_id: factura.id, tipo, accion: 'omitido (sin teléfono inquilino)' });
          continue;
        }

        // Normalizar número
        let numLimpio = telefono.replace(/\D/g, '');
        if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
        if (!numLimpio.startsWith('54')) numLimpio = '54' + numLimpio;
        const numeroFinal = '+' + numLimpio;

        const servNombre = servicio.tipo || servicio.nombre || 'Servicio';
        const montoFmt = factura.monto ? '$' + Number(factura.monto).toLocaleString('es-AR') : 'el monto indicado';
        const vtoDate = new Date(vtoISO + 'T00:00:00');
        const vtoFmt  = `${vtoDate.getDate()}/${vtoDate.getMonth()+1}/${vtoDate.getFullYear()}`;
        const primerNombre = (ctr.inquilino_nombre || 'Inquilino').split(' ')[0];

        // Obtener dirección
        let direccion = '';
        if (servicio.propiedad_id) {
          const { data: prop } = await supabase
            .from('propiedades').select('direccion').eq('id', servicio.propiedad_id).single();
          if (prop?.direccion) direccion = ` de *${prop.direccion}*`;
        }

        let mensaje = '';
        const tipoBase = tipo.replace('serv_', '');
        if (tipoBase === '5dias') {
          mensaje =
            `💡 *AlquilApp — Recordatorio de ${servNombre}*\n\n` +
            `Hola ${primerNombre}! La factura de *${servNombre}*${direccion} vence en *5 días* (el ${vtoFmt}).\n\n` +
            `💰 Monto: *${montoFmt}*\n\n` +
            '¡No te olvides de pagarla a tiempo! 😊';
        } else if (tipoBase === '2dias') {
          mensaje =
            `⚠️ *AlquilApp — ${servNombre} próximo a vencer*\n\n` +
            `Hola ${primerNombre}, quedan *solo 2 días* para que venza la factura de *${servNombre}*${direccion} (el ${vtoFmt}).\n\n` +
            `💰 Monto: *${montoFmt}*\n\n` +
            'Si ya la pagaste, ignorá este mensaje. 🙏';
        } else if (tipoBase === 'vence_hoy') {
          mensaje =
            `🔴 *AlquilApp — ${servNombre} vence HOY*\n\n` +
            `Hola ${primerNombre}, hoy vence la factura de *${servNombre}*${direccion}.\n\n` +
            `💰 Monto: *${montoFmt}*\n\n` +
            'Pagala hoy para evitar recargos. 📋';
        }

        try {
          await enviarWhatsApp(numeroFinal, mensaje);
          await supabase.from('notificaciones_wa').insert({
            servicio_factura_id: factura.id, tipo, telefono: numeroFinal, estado: 'enviado'
          });
          resultados.enviados++;
          resultados.detalle.push({ factura_id: factura.id, tipo, telefono: numeroFinal, accion: 'enviado' });
          console.log(`✅ Notif servicio ${tipo} → ${numeroFinal}`);
        } catch (errEnvio) {
          console.error(`❌ Error enviando a ${numeroFinal}:`, errEnvio.message);
          await supabase.from('notificaciones_wa').insert({
            servicio_factura_id: factura.id, tipo, telefono: numeroFinal, estado: 'error'
          });
          resultados.errores++;
          resultados.detalle.push({ factura_id: factura.id, tipo, telefono: numeroFinal, accion: 'error', error: errEnvio.message });
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // PARTE 3: Recordatorios por día de vencimiento fijo (servicios sin facturas_servicios)
    // Para servicios que solo tienen dia_vto en la tabla servicios
    // ════════════════════════════════════════════════════════
    const diaHoy = hoy.getDate();
    const diasCheck = [diaHoy + 5, diaHoy + 2, diaHoy]; // Días a verificar

    for (const diaTarget of diasCheck) {
      if (diaTarget < 1 || diaTarget > 31) continue;

      const tipoNotif = diaTarget === diaHoy ? 'serv_dia_vence_hoy'
                      : diaTarget === diaHoy + 2 ? 'serv_dia_2dias'
                      : 'serv_dia_5dias';

      const { data: serviciosDia } = await supabase
        .from('servicios')
        .select('id, tipo, nombre, propiedad_id, monto, dia_vto, a_cargo_de')
        .eq('dia_vto', diaTarget);

      if (!serviciosDia || serviciosDia.length === 0) continue;

      for (const srv of serviciosDia) {
        if (srv.a_cargo_de && srv.a_cargo_de !== 'inquilino') continue;

        // Clave única para evitar duplicados: servicio_id + tipo + mes/año
        const mesAnio = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;
        const claveUnica = `${srv.id}_${tipoNotif}_${mesAnio}`;

        const { data: yaEnviado } = await supabase
          .from('notificaciones_wa')
          .select('id')
          .eq('clave_unica', claveUnica)
          .limit(1);

        if (yaEnviado?.length > 0) continue;

        // Buscar inquilino activo
        const { data: contratos } = await supabase
          .from('contratos')
          .select('inquilino_telefono, inquilino_nombre, inquilino_email')
          .eq('propiedad_id', srv.propiedad_id)
          .eq('estado', 'activo')
          .limit(1);

        if (!contratos || contratos.length === 0) continue;
        const ctr = contratos[0];

        let telefono = ctr.inquilino_telefono || null;
        if (!telefono && ctr.inquilino_email) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('whatsapp_phone')
            .eq('email', ctr.inquilino_email)
            .single();
          if (profile?.whatsapp_phone) telefono = profile.whatsapp_phone;
        }
        if (!telefono) continue;

        let numLimpio = telefono.replace(/\D/g, '');
        if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
        if (!numLimpio.startsWith('54')) numLimpio = '54' + numLimpio;
        const numeroFinal = '+' + numLimpio;

        const servNombre = srv.tipo || srv.nombre || 'Servicio';
        const montoFmt = srv.monto ? '$' + Number(srv.monto).toLocaleString('es-AR') : '';
        const primerNombre = (ctr.inquilino_nombre || 'Inquilino').split(' ')[0];

        let diasFalta = diaTarget - diaHoy;
        let mensaje = '';
        if (diasFalta === 5) {
          mensaje = `💡 *AlquilApp — Recordatorio*\n\nHola ${primerNombre}! El servicio de *${servNombre}* vence en *5 días* (día ${diaTarget}).${montoFmt ? `\n💰 Monto aprox: *${montoFmt}*` : ''}\n\n¡Tené en cuenta! 😊`;
        } else if (diasFalta === 2) {
          mensaje = `⚠️ *AlquilApp — ${servNombre} próximo*\n\nHola ${primerNombre}, faltan *2 días* para el vencimiento de *${servNombre}* (día ${diaTarget}).${montoFmt ? `\n💰 Monto aprox: *${montoFmt}*` : ''}\n\nSi ya pagaste, ignorá este mensaje. 🙏`;
        } else {
          mensaje = `🔴 *AlquilApp — ${servNombre} vence HOY*\n\nHola ${primerNombre}, hoy vence *${servNombre}*.${montoFmt ? `\n💰 Monto aprox: *${montoFmt}*` : ''}\n\nPagalo hoy para evitar recargos. 📋`;
        }

        try {
          await enviarWhatsApp(numeroFinal, mensaje);
          await supabase.from('notificaciones_wa').insert({
            tipo: tipoNotif, telefono: numeroFinal, estado: 'enviado', clave_unica: claveUnica
          });
          resultados.enviados++;
          resultados.detalle.push({ servicio_id: srv.id, tipo: tipoNotif, telefono: numeroFinal, accion: 'enviado' });
          console.log(`✅ Notif servicio-dia ${tipoNotif} → ${numeroFinal}`);
        } catch (errEnvio) {
          console.error(`❌ Error enviando a ${numeroFinal}:`, errEnvio.message);
          resultados.errores++;
        }
      }
    }

    console.log(`📊 Notif total: ${resultados.enviados} enviadas, ${resultados.omitidos} omitidas, ${resultados.errores} errores`);
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
    '• 📄 *Recibos de pago* — escribí "mandame el recibo de [mes]"\n' +
    '• 📋 *Facturas de servicios* — escribí "mandame la factura de luz"\n' +
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
    version:   '4.1.0',
    timestamp: new Date().toISOString(),
    features:  ['recibos-pdf', 'facturas-servicios', 'recordatorios-servicios', 'audio', 'gemini-ai'],
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
  res.send('AlquilApp WhatsApp Bot v4.1 — Webhook activo ✅');
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
    console.log('║   AlquilApp WhatsApp Bot v4.1          ║');
    console.log(`║   Escuchando en puerto ${PORT}            ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  POST /webhook          → Recibe mensajes de Twilio');
    console.log('  POST /cobro-pagado     → Auto-envía recibo al inquilino');
    console.log('  GET  /notif-automaticas → Recordatorios de cobros y servicios');
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
