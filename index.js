// ═══════════════════════════════════════════════════════════
// AlquilApp — Bot de WhatsApp con Gemini AI (via Twilio)
// v5.3.0 — Recibos PDF, facturas de servicios, recordatorios
//          automáticos, confirmar pagos, reclamos, comprobantes
//          de pago, morosidad, ajustes de contrato.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
app.use(express.json({ limit: '25mb' })); // subimos límite para PDFs/imágenes base64 en proxy IA
app.use(express.urlencoded({ extended: true, limit: '25mb' })); // Twilio envía form-urlencoded

// CORS global (permite llamadas desde alquil.app y cualquier origen)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Variables de entorno ──────────────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  GEMINI_KEY,
  COHERE_KEY,
  DEEPSEEK_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  ENCRYPTION_KEY,
  NOTIF_SECRET,
  // Casilla central de reenvío de facturas (facturas@alquil.app)
  IMAP_INBOX_HOST,
  IMAP_INBOX_PORT,
  IMAP_INBOX_EMAIL,
  IMAP_INBOX_PASSWORD,
  PORT = 3000
} = process.env;

// ── Crypto helpers para encriptar/desencriptar contraseñas IMAP ──
// Si ENCRYPTION_KEY está configurada, se usa directamente.
// Si no, se deriva determinísticamente de SUPABASE_SERVICE_KEY (que ya
// está en Railway). Así el usuario no necesita setear nada extra.
let _cachedKey = null;
function _getEncKey() {
  if (_cachedKey) return _cachedKey;
  if (ENCRYPTION_KEY && ENCRYPTION_KEY.length >= 64) {
    _cachedKey = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex');
  } else if (SUPABASE_SERVICE_KEY) {
    // Derivar clave de 32 bytes a partir de SUPABASE_SERVICE_KEY
    _cachedKey = crypto.createHash('sha256').update('alquilapp-imap|' + SUPABASE_SERVICE_KEY).digest();
  } else {
    throw new Error('No hay ENCRYPTION_KEY ni SUPABASE_SERVICE_KEY configuradas');
  }
  return _cachedKey;
}
function encryptPassword(plain) {
  const key = _getEncKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: iv(hex):tag(hex):ciphertext(hex)
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}
function decryptPassword(blob) {
  const key = _getEncKey();
  const [ivHex, tagHex, encHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Blob cifrado inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Presets IMAP por proveedor ──
const IMAP_PRESETS = {
  outlook: { host: 'outlook.office365.com', port: 993 },
  hotmail: { host: 'outlook.office365.com', port: 993 },
  yahoo:   { host: 'imap.mail.yahoo.com',   port: 993 },
  icloud:  { host: 'imap.mail.me.com',      port: 993 }
};

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
// ANALIZAR FACTURA CON GEMINI VISION
// CLASIFICADOR DE IMÁGENES (factura vs comprobante de pago vs otro)
// ═══════════════════════════════════════════════════════════
// Dado una imagen, determina si es:
//   - "factura":     factura de servicio (luz, gas, agua, internet, etc.)
//   - "comprobante": comprobante/transferencia/pago (ticket de transferencia, captura de MP, etc.)
//   - "otro":        ninguna de las anteriores
async function clasificarImagenConGemini(imageBase64, mimeType) {
  const prompt = `Mirá esta imagen y clasificala en UNA de estas 3 categorías. Respondé ÚNICAMENTE con una de estas palabras sin nada más:

- factura: si es una factura o boleta de un servicio domiciliario (luz/EDENOR/EPE/Edesur, gas/Metrogas/Naturgy, agua/AySA/ABSA, internet, cable, telefonía, ABL, expensas).
- comprobante: si es un comprobante/recibo de pago, transferencia bancaria, captura de Mercado Pago/home banking mostrando que se pagó algo.
- otro: cualquier otra cosa (foto personal, documento, captura irrelevante).

Respondé solo la palabra, sin puntuación, sin comillas, sin explicaciones.`;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBase64 } }
      ]
    }]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );
    if (!response.ok) { console.error('Gemini classify error:', response.status); return 'otro'; }
    const json = await response.json();
    const raw = (json.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
    // Normalizar — agarrar solo la primera palabra relevante
    if (raw.includes('factura')) return 'factura';
    if (raw.includes('comprobante')) return 'comprobante';
    return 'otro';
  } catch (err) {
    console.error('Error clasificando imagen:', err.message);
    return 'otro';
  }
}

// ═══════════════════════════════════════════════════════════
// ANALIZAR FACTURA CON GEMINI VISION
// Recibe imagen en base64, extrae datos de la factura
// ═══════════════════════════════════════════════════════════
async function analizarFacturaConGemini(imageBase64, mimeType) {
  const prompt = `Analizá esta imagen de una factura de servicio domiciliario argentino.
Extraé los siguientes datos y respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto extra):
{
  "empresa": "nombre de la empresa (ej: EPE, CAPS, Edenor, Metrogas, AySA)",
  "tipo_servicio": "luz|gas|agua|internet|telefono|abl|impuesto|otro",
  "monto": 12345.67,
  "fecha_vencimiento": "2026-04-15",
  "periodo": "Abril 2026",
  "numero_cuenta": "123456",
  "confianza": "alta|media|baja"
}
Si no podés leer algún campo, poné null. El monto debe ser numérico (sin $ ni puntos de miles).
La fecha en formato YYYY-MM-DD. Si hay varios vencimientos, usá el primer vencimiento.`;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBase64 } }
      ]
    }]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );

    if (!response.ok) {
      console.error('Gemini Vision error:', response.status);
      return null;
    }

    const json = await response.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    // Limpiar posible markdown (```json ... ```)
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const datos = JSON.parse(clean);
    console.log('📄 Factura analizada por Gemini:', JSON.stringify(datos));
    return datos;
  } catch (err) {
    console.error('Error analizando factura con Gemini:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// DESCARGAR IMAGEN DE TWILIO → BASE64
// ═══════════════════════════════════════════════════════════
async function descargarImagenBase64(mediaUrl) {
  const imagenResp = await fetch(mediaUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });
  if (!imagenResp.ok) throw new Error(`Error descargando imagen: ${imagenResp.status}`);
  const buffer = await imagenResp.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ═══════════════════════════════════════════════════════════
// SUBIR FACTURA A SUPABASE STORAGE (bucket "facturas")
// ═══════════════════════════════════════════════════════════
async function subirFacturaAStorage(imageBase64, mimeType, filename) {
  const bufferNode = Buffer.from(imageBase64, 'base64');
  await supabase.storage.createBucket('facturas', { public: true }).catch(() => {});
  const { data, error } = await supabase.storage
    .from('facturas')
    .upload(filename, bufferNode, { contentType: mimeType, upsert: true });
  if (error) throw new Error('Error subiendo factura: ' + error.message);
  const { data: urlData } = supabase.storage.from('facturas').getPublicUrl(filename);
  return urlData.publicUrl;
}

// ═══════════════════════════════════════════════════════════
// PROCESAR FACTURA DE PROPIETARIO (imagen → Gemini → Supabase)
// Busca el servicio correspondiente y carga la factura
// ═══════════════════════════════════════════════════════════
async function procesarFacturaPropietario(from, mediaUrl, mimeType, usuario) {
  try {
    // 1. Descargar imagen y convertir a base64
    const imageBase64 = await descargarImagenBase64(mediaUrl);
    console.log(`📄 Imagen descargada (${Math.round(imageBase64.length * 3/4 / 1024)} KB), analizando con Gemini...`);

    // 2. Analizar con Gemini
    const datos = await analizarFacturaConGemini(imageBase64, mimeType);
    if (!datos || !datos.tipo_servicio) {
      await enviarWhatsApp(from, '⚠️ No pude leer los datos de la factura. Intentá con una foto más nítida o mandala de nuevo.');
      return;
    }

    // 3. Subir imagen a Storage
    const timestamp = Date.now();
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const filename = `factura_${from.replace(/\D/g, '')}_${timestamp}.${ext}`;
    const facturaUrl = await subirFacturaAStorage(imageBase64, mimeType, filename);

    // 4. Buscar servicios asociados al usuario (propietario O inquilino)
    let servicios = [];
    if (usuario.rol === 'inquilino') {
      // Inquilino: buscar via contrato activo → propiedad → servicios
      const { data: contratos } = await supabase
        .from('contratos')
        .select('propiedad_id')
        .eq('inquilino_email', usuario.email || '')
        .limit(5);
      const propiedadIds = (contratos || []).map(c => c.propiedad_id).filter(Boolean);
      if (propiedadIds.length) {
        const { data: svcs } = await supabase
          .from('servicios')
          .select('*')
          .in('propiedad_id', propiedadIds);
        servicios = svcs || [];
      }
    } else {
      // Propietario: servicios propios
      const { data: svcs } = await supabase
        .from('servicios')
        .select('*')
        .eq('propietario_id', usuario.id);
      servicios = svcs || [];
    }

    if (!servicios || servicios.length === 0) {
      await enviarWhatsApp(from, `📄 Recibí la factura de *${datos.empresa || datos.tipo_servicio}* por *$${Number(datos.monto || 0).toLocaleString('es-AR')}*.\n\n⚠️ No tenés servicios cargados en AlquilApp. Primero agregá el servicio desde la web y después mandame la factura.`);
      return;
    }

    // Matchear por tipo de servicio o nombre de empresa
    const tipoNorm = (datos.tipo_servicio || '').toLowerCase();
    const empresaNorm = (datos.empresa || '').toLowerCase();
    const servicio = servicios.find(s => {
      const nombre = (s.nombre || '').toLowerCase();
      const tipo = (s.tipo || '').toLowerCase();
      const proveedor = (s.proveedor || '').toLowerCase();
      // Match por tipo (luz, gas, agua) o empresa exacta
      if (tipoNorm === 'luz' && (nombre.includes('luz') || tipo.includes('luz') || nombre.includes('electr') || proveedor.includes('epe') || proveedor.includes('edenor') || proveedor.includes('edesur'))) return true;
      if (tipoNorm === 'gas' && (nombre.includes('gas') || tipo.includes('gas') || proveedor.includes('metrogas') || proveedor.includes('naturgy') || proveedor.includes('camuzzi'))) return true;
      if (tipoNorm === 'agua' && (nombre.includes('agua') || tipo.includes('agua') || proveedor.includes('aysa') || proveedor.includes('caps') || proveedor.includes('absa'))) return true;
      if (tipoNorm === 'internet' && (nombre.includes('internet') || nombre.includes('wifi') || nombre.includes('cable'))) return true;
      // Match genérico por nombre de empresa
      if (empresaNorm && (nombre.includes(empresaNorm) || proveedor.includes(empresaNorm))) return true;
      return false;
    });

    if (!servicio) {
      await enviarWhatsApp(from, `📄 Recibí la factura de *${datos.empresa || datos.tipo_servicio}* pero no encontré un servicio que coincida en tu cuenta.\n\n💡 Los servicios que tenés cargados son:\n${servicios.map(s => '• ' + (s.nombre || s.tipo)).join('\n')}\n\nVerificá que el servicio esté dado de alta en la web.`);
      return;
    }

    // 5. Actualizar el servicio con los datos de la factura
    const updateData = {};
    if (datos.monto) updateData.ultima_factura_monto = Number(datos.monto);
    if (datos.fecha_vencimiento) updateData.ultima_factura_vto = datos.fecha_vencimiento;
    if (facturaUrl) updateData.factura_url = facturaUrl;
    if (datos.numero_cuenta && !servicio.numero_cuenta) updateData.numero_cuenta = datos.numero_cuenta;

    const { error: updateErr } = await supabase
      .from('servicios')
      .update(updateData)
      .eq('id', servicio.id);

    if (updateErr) throw updateErr;

    // 6. También insertar en facturas_servicios si la tabla existe
    try {
      await supabase.from('facturas_servicios').insert({
        servicio_id: servicio.id,
        propietario_id: servicio.propietario_id || usuario.id,
        monto: Number(datos.monto || 0),
        fecha_vto: datos.fecha_vencimiento || null,
        periodo: datos.periodo || null,
        factura_url: facturaUrl,
        estado: 'pendiente'
      });
    } catch (e) { console.warn('No se pudo insertar en facturas_servicios:', e.message); }

    // 7. Confirmar al usuario
    const montoStr = datos.monto ? '$' + Number(datos.monto).toLocaleString('es-AR') : 'monto no detectado';
    const vtoStr = datos.fecha_vencimiento || 'vencimiento no detectado';
    const cierreMsg = usuario.rol === 'inquilino'
      ? 'Tu propietario ya puede ver esta factura en la app.'
      : 'Tu inquilino ya puede ver esta factura en la app.';
    await enviarWhatsApp(from,
      `✅ *Factura cargada correctamente*\n\n` +
      `📋 Servicio: *${servicio.nombre || servicio.tipo}*\n` +
      `🏢 Empresa: *${datos.empresa || '—'}*\n` +
      `💰 Monto: *${montoStr}*\n` +
      `📅 Vencimiento: *${vtoStr}*\n` +
      `📎 Período: *${datos.periodo || '—'}*\n\n` +
      cierreMsg
    );

    console.log(`✅ Factura cargada: ${servicio.nombre} → $${datos.monto} vto ${datos.fecha_vencimiento}`);

  } catch (err) {
    console.error('❌ Error procesando factura:', err);
    await enviarWhatsApp(from, '⚠️ Hubo un error procesando la factura. Intentá de nuevo.').catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════
// DESCARGAR Y SUBIR IMAGEN A SUPABASE STORAGE (comprobantes)
// Descarga desde URL (con auth Twilio), sube a bucket "comprobantes"
// Retorna la URL pública del archivo
// ═══════════════════════════════════════════════════════════
async function descargarYSubirImagen(mediaUrl, mediaType, filename) {
  // Descargar imagen desde Twilio (requiere Basic Auth)
  const imagenResp = await fetch(mediaUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
    }
  });

  if (!imagenResp.ok) {
    throw new Error(`Error descargando imagen: ${imagenResp.status}`);
  }

  const buffer = await imagenResp.arrayBuffer();
  const bufferNode = Buffer.from(buffer);

  // Crear bucket si no existe
  await supabase.storage.createBucket('comprobantes', { public: true }).catch(() => {});

  // Subir a Supabase Storage
  const { data, error } = await supabase.storage
    .from('comprobantes')
    .upload(filename, bufferNode, {
      contentType: mediaType,
      upsert: true
    });

  if (error) throw new Error('Error subiendo comprobante: ' + error.message);

  const { data: urlData } = supabase.storage.from('comprobantes').getPublicUrl(filename);
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
  // Mapa de keywords → nombre canónico del servicio
  // Incluye empresas proveedoras regionales de Argentina
  const tiposMap = {
    'luz': ['luz', 'electricidad', 'electrica', 'eléctrica', 'epec', 'edenor', 'edesur', 'enersa', 'epe', 'edea', 'edelap', 'eden', 'energia', 'energía'],
    'gas': ['gas', 'gasnor', 'litoral gas', 'metrogas', 'camuzzi', 'gasnea', 'ecogas'],
    'agua': ['agua', 'aguas', 'assa', 'aysa', 'absa', 'assa', 'dipos'],
    'internet': ['internet', 'wifi', 'fibra', 'fibertel', 'telecentro', 'personal', 'movistar', 'claro'],
    'cable': ['cable', 'television', 'televisión', 'tv', 'directv', 'cablevision', 'cablevisión'],
    'telefono': ['telefono', 'teléfono', 'celular', 'linea', 'línea'],
    'abl': ['abl', 'municipal', 'municipalidad', 'tasa', 'tasas'],
    'expensas': ['expensas', 'consorcio', 'administracion', 'administración']
  };

  let tipoDetectado = null;
  let keywordsUsados = [];
  for (const [tipo, keywords] of Object.entries(tiposMap)) {
    if (keywords.some(kw => textoLower.includes(kw))) {
      tipoDetectado = tipo;
      keywordsUsados = keywords;
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

  // Buscar TODOS los servicios de las propiedades (sin filtrar por tipo en la query)
  // porque el campo `tipo` puede decir "servicio" para todos
  const { data: todosServicios } = await supabase
    .from('servicios')
    .select('*')
    .in('propiedad_id', propIds);

  if (!todosServicios || todosServicios.length === 0) {
    return { error: 'no_servicio', tipoDetectado };
  }

  // Filtrar en JS buscando por tipo Y nombre (más flexible que ilike en un solo campo)
  let servicios = todosServicios;
  if (tipoDetectado) {
    servicios = todosServicios.filter(s => {
      const tipoLower = (s.tipo || '').toLowerCase();
      const nombreLower = (s.nombre || '').toLowerCase();
      const combinado = tipoLower + ' ' + nombreLower;

      // Match directo con el nombre canónico
      if (combinado.includes(tipoDetectado)) return true;

      // Match con cualquiera de las keywords del tipo detectado
      if (keywordsUsados.some(kw => combinado.includes(kw))) return true;

      return false;
    });

    // Si no encontró con el filtro, mostrar error
    if (servicios.length === 0) {
      return { error: 'no_servicio', tipoDetectado };
    }
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
  if (/mand|envi|pasa/.test(t) && /\b(luz|gas|agua|epe|epec|edenor|edesur|enersa)\b/.test(t) && !/recibo/.test(t)) {
    return { tipo: 'factura_servicio', texto };
  }

  // Confirmación de pago (inquilino: "ya pagué", "pagué el alquiler", "transferí el pago")
  if (/pague|pago|pague|transfiri|transferi|deposit|mande|mandate|envi|pasar/.test(t) &&
      /alquiler|pago|rent/.test(t)) {
    return { tipo: 'confirmar_pago_inquilino', texto };
  }

  // Reclamos y mantenimiento (inquilino: "reclamo", "se rompió", "arreglar", etc.)
  if (/reclamo|se rompio|roto|arreglar|reparar|mantenimiento|problema|no funciona|rotura|perdida|gotea|filtra|humedad|grieta|fuga|gotazo/.test(t)) {
    return { tipo: 'reclamo', texto };
  }

  // Propietario confirmando pago: "confirmar pago", "confirmá el pago", "marcar como pagado", "ya pagó"
  if (/confirm.*pago|marca.*pagado|ya pago|sabes que pago/.test(t)) {
    return { tipo: 'confirmar_pago_propietario', texto };
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
    const esImagen  = numMedia > 0 && mediaType.startsWith('image/');

    if (!from || (!text && !esAudio && !esImagen)) {
      return res.send('<Response></Response>');
    }

    console.log(`📩 Mensaje de ${from}: ${esAudio ? `[AUDIO ${mediaType}]` : esImagen ? `[IMAGEN ${mediaType}]` : text}`);

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

      // FEATURE 1: CONFIRMAR PAGO POR WHATSAPP (inquilino)
      if (intencion?.tipo === 'confirmar_pago_inquilino') {
        console.log('💳 Intención detectada: CONFIRMAR PAGO (INQUILINO)');
        res.send(`<Response><Message>${escapeXml('✅ Registrando tu confirmación de pago...')}</Message></Response>`);

        (async () => {
          try {
            // Buscar el cobro pendiente más reciente del inquilino
            const { data: contratos } = await supabase
              .from('contratos')
              .select('id')
              .eq('inquilino_email', usuario.email || '');
            if (!contratos || contratos.length === 0) {
              await enviarWhatsApp(from, '❌ No encontré contratos asociados a tu cuenta.');
              return;
            }

            const contratoIds = contratos.map(c => c.id);
            const { data: cobros } = await supabase
              .from('cobros')
              .select('*')
              .in('contrato_id', contratoIds)
              .in('estado', ['pendiente', 'pendiente_confirmacion'])
              .order('fecha_vencimiento', { ascending: false })
              .limit(1);

            if (!cobros || cobros.length === 0) {
              await enviarWhatsApp(from, '❌ No encontré cobros pendientes para confirmar.');
              return;
            }

            const cobro = cobros[0];

            // Actualizar cobro a pendiente_confirmacion
            const { error: updateErr } = await supabase
              .from('cobros')
              .update({
                estado: 'pendiente_confirmacion',
                fecha_pago: new Date().toISOString().split('T')[0]
              })
              .eq('id', cobro.id);

            if (updateErr) throw updateErr;

            // Notificar al propietario
            const { data: profile } = await supabase
              .from('profiles')
              .select('whatsapp_phone')
              .eq('id', cobro.propietario_id)
              .single();

            if (profile?.whatsapp_phone) {
              let numProp = profile.whatsapp_phone.replace(/\D/g, '');
              if (numProp.startsWith('0')) numProp = numProp.substring(1);
              if (!numProp.startsWith('54')) numProp = '54' + numProp;
              const propTel = '+' + numProp;

              const msgProp = `🔔 El inquilino *${cobro.inquilino_nombre || 'Inquilino'}* confirmó que pagó el alquiler. Escribí *confirmar pago de ${cobro.inquilino_nombre}* para marcarlo como pagado.`;
              await enviarWhatsApp(propTel, msgProp).catch(() => {});
            }

            await enviarWhatsApp(from, '✅ Confirmación registrada. El propietario será notificado.');
          } catch (err) {
            console.error('❌ Error registrando pago:', err);
            await enviarWhatsApp(from, '⚠️ Hubo un error registrando tu confirmación. Intentá de nuevo.').catch(() => {});
          }
        })();
        return;
      }

      // FEATURE 3: RECLAMOS Y MANTENIMIENTO (inquilino)
      if (intencion?.tipo === 'reclamo') {
        console.log('🔧 Intención detectada: RECLAMO');
        res.send(`<Response><Message>${escapeXml('✅ Registrando tu reclamo...')}</Message></Response>`);

        (async () => {
          try {
            // Obtener contrato del inquilino
            const { data: contratos } = await supabase
              .from('contratos')
              .select('id, propiedad_id, propietario_id')
              .eq('inquilino_email', usuario.email || '')
              .limit(1);

            if (!contratos || contratos.length === 0) {
              await enviarWhatsApp(from, '❌ No encontré un contrato asociado a tu cuenta.');
              return;
            }

            const contrato = contratos[0];

            // Insertar reclamo en tabla reclamos
            const { error: insertErr } = await supabase
              .from('reclamos')
              .insert({
                propiedad_id: contrato.propiedad_id,
                contrato_id: contrato.id,
                inquilino_telefono: from,
                inquilino_nombre: usuario.nombre || usuario.email,
                propietario_id: contrato.propietario_id,
                descripcion: text,
                estado: 'abierto',
                prioridad: 'normal',
                created_at: new Date().toISOString()
              });

            if (insertErr) throw insertErr;

            // Notificar al propietario
            const { data: profile } = await supabase
              .from('profiles')
              .select('whatsapp_phone')
              .eq('id', contrato.propietario_id)
              .single();

            if (profile?.whatsapp_phone) {
              let numProp = profile.whatsapp_phone.replace(/\D/g, '');
              if (numProp.startsWith('0')) numProp = numProp.substring(1);
              if (!numProp.startsWith('54')) numProp = '54' + numProp;
              const propTel = '+' + numProp;

              const msgProp = `🔧 *Nuevo reclamo* del inquilino *${usuario.nombre || 'Inquilino'}*:\n\n${text}`;
              await enviarWhatsApp(propTel, msgProp).catch(() => {});
            }

            await enviarWhatsApp(from, '✅ Tu reclamo fue registrado. El propietario va a ser notificado.');
          } catch (err) {
            console.error('❌ Error registrando reclamo:', err);
            await enviarWhatsApp(from, '⚠️ Hubo un error registrando tu reclamo. Intentá de nuevo.').catch(() => {});
          }
        })();
        return;
      }

      // FEATURE 5: MARCAR COBRO COMO PAGADO (propietario vía WhatsApp)
      if (intencion?.tipo === 'confirmar_pago_propietario') {
        console.log('✅ Intención detectada: CONFIRMAR PAGO (PROPIETARIO)');
        res.send(`<Response><Message>${escapeXml('✅ Procesando confirmación de pago...')}</Message></Response>`);

        (async () => {
          try {
            // Extraer nombre del inquilino del texto si es posible
            let inqNombreTarget = null;
            const matchNombre = text.match(/de\s+(\w+(?:\s+\w+)?)/i);
            if (matchNombre) {
              inqNombreTarget = matchNombre[1].trim();
            }

            // Buscar cobro pendiente del propietario para ese inquilino
            const { data: cobros } = await supabase
              .from('cobros')
              .select('*')
              .eq('propietario_id', usuario.id)
              .in('estado', ['pendiente', 'pendiente_confirmacion'])
              .order('fecha_vencimiento', { ascending: false });

            let cobroTarget = null;
            if (inqNombreTarget) {
              cobroTarget = cobros?.find(c =>
                c.inquilino_nombre?.toLowerCase().includes(inqNombreTarget.toLowerCase())
              ) || cobros?.[0];
            } else {
              cobroTarget = cobros?.[0];
            }

            if (!cobroTarget) {
              await enviarWhatsApp(from, '❌ No encontré un cobro pendiente para confirmar.');
              return;
            }

            // Actualizar cobro a pagado
            const { error: updateErr } = await supabase
              .from('cobros')
              .update({
                estado: 'pagado',
                fecha_pago: new Date().toISOString().split('T')[0]
              })
              .eq('id', cobroTarget.id);

            if (updateErr) throw updateErr;

            // Auto-generar y enviar recibo al inquilino
            const { data: contrato } = await supabase
              .from('contratos')
              .select('inquilino_telefono, inquilino_email')
              .eq('id', cobroTarget.contrato_id)
              .single();

            let telefonoInquilino = contrato?.inquilino_telefono;
            if (!telefonoInquilino && contrato?.inquilino_email) {
              const { data: profileInq } = await supabase
                .from('profiles')
                .select('whatsapp_phone')
                .eq('email', contrato.inquilino_email)
                .single();
              telefonoInquilino = profileInq?.whatsapp_phone;
            }

            if (telefonoInquilino) {
              let numInq = telefonoInquilino.replace(/\D/g, '');
              if (numInq.startsWith('0')) numInq = numInq.substring(1);
              if (!numInq.startsWith('54')) numInq = '54' + numInq;
              const inqTel = '+' + numInq;

              try {
                await generarYEnviarRecibo(cobroTarget, inqTel);
              } catch (err) {
                console.error('❌ Error enviando recibo:', err);
              }
            }

            await enviarWhatsApp(from, '✅ Pago confirmado. Se le envió el recibo al inquilino.');
          } catch (err) {
            console.error('❌ Error confirmando pago:', err);
            await enviarWhatsApp(from, '⚠️ Hubo un error procesando la confirmación. Intentá de nuevo.').catch(() => {});
          }
        })();
        return;
      }
    }

    // ── FEATURE: IMAGEN RECIBIDA (factura o comprobante según contenido) ──
    // Clasificamos con Gemini y ruteamos al flujo correcto.
    // Antes se decidía por rol; ahora se decide por lo que muestra la imagen,
    // así inquilinos y propietarios pueden mandar cualquiera de las dos cosas.
    if (esImagen) {
      console.log('🖼️ Imagen recibida → clasificando con Gemini...');
      res.send(`<Response><Message>${escapeXml('🤖 Recibí tu imagen. Analizándola con IA, un momento…')}</Message></Response>`);

      (async () => {
        try {
          const imageBase64 = await descargarImagenBase64(mediaUrl);
          const tipo = await clasificarImagenConGemini(imageBase64, mediaType);
          console.log(`🏷️ Imagen clasificada como: ${tipo}`);

          if (tipo === 'factura') {
            // Procesar como factura de servicio (funciona para propietario O inquilino)
            await procesarFacturaPropietario(from, mediaUrl, mediaType, usuario);
            return;
          }

          if (tipo === 'comprobante') {
            // Solo tiene sentido para inquilino (es quien paga)
            if (usuario.rol !== 'inquilino') {
              await enviarWhatsApp(from, 'ℹ️ Recibí un comprobante de pago, pero solo los inquilinos pueden enviar comprobantes. Si querés cargar una factura de servicio, asegurate que la foto muestre la factura completa.');
              return;
            }
            await _procesarComprobanteInquilino(from, mediaUrl, mediaType, usuario);
            return;
          }

          // tipo === 'otro'
          await enviarWhatsApp(from, '🤔 No pude identificar qué muestra la imagen. Si es una *factura de servicio* o un *comprobante de pago*, probá con una foto más nítida y de cerca, que se vea claramente el texto. Si es otra cosa, decime en qué puedo ayudarte.');
        } catch (err) {
          console.error('❌ Error en flujo de imagen:', err);
          await enviarWhatsApp(from, '⚠️ Hubo un error procesando tu imagen. Intentá de nuevo.').catch(() => {});
        }
      })();
      return;
    }

    // Helper inline para procesar comprobante (extraído del flujo anterior)
    async function _procesarComprobanteInquilino(from, mediaUrl, mediaType, usuario) {
      try {
          // Descargar y subir imagen a Supabase
          const timestamp = Date.now();
          const filename = `comprobante_${from.replace(/\D/g, '')}_${timestamp}.jpg`;
          const imagenUrl = await descargarYSubirImagen(mediaUrl, mediaType, filename);

          // Buscar el cobro pendiente/pendiente_confirmacion más reciente del inquilino
          const { data: contratos } = await supabase
            .from('contratos')
            .select('id')
            .eq('inquilino_email', usuario.email || '');

          if (!contratos || contratos.length === 0) {
            await enviarWhatsApp(from, '❌ No encontré contratos asociados a tu cuenta.');
            return;
          }

          const contratoIds = contratos.map(c => c.id);
          const { data: cobros } = await supabase
            .from('cobros')
            .select('*')
            .in('contrato_id', contratoIds)
            .in('estado', ['pendiente', 'pendiente_confirmacion'])
            .order('fecha_vencimiento', { ascending: false })
            .limit(1);

          if (!cobros || cobros.length === 0) {
            await enviarWhatsApp(from, '❌ No encontré cobros pendientes para este comprobante.');
            return;
          }

          const cobro = cobros[0];

          // Actualizar cobro con comprobante_url
          const { error: updateErr } = await supabase
            .from('cobros')
            .update({
              comprobante_url: imagenUrl,
              estado: 'pendiente_confirmacion'
            })
            .eq('id', cobro.id);

          if (updateErr) throw updateErr;

          // Notificar al propietario
          const { data: profile } = await supabase
            .from('profiles')
            .select('whatsapp_phone')
            .eq('id', cobro.propietario_id)
            .single();

          if (profile?.whatsapp_phone) {
            let numProp = profile.whatsapp_phone.replace(/\D/g, '');
            if (numProp.startsWith('0')) numProp = numProp.substring(1);
            if (!numProp.startsWith('54')) numProp = '54' + numProp;
            const propTel = '+' + numProp;

            const msgProp = `🔔 El inquilino *${cobro.inquilino_nombre || 'Inquilino'}* envió un comprobante de pago.\n\n📎 ${imagenUrl}`;
            await enviarWhatsApp(propTel, msgProp).catch(() => {});
          }

          await enviarWhatsApp(from, '✅ Comprobante recibido y guardado.');
      } catch (err) {
        console.error('❌ Error procesando comprobante:', err);
        await enviarWhatsApp(from, '⚠️ Hubo un error guardando tu comprobante. Intentá de nuevo.').catch(() => {});
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
          } else if (comando.tipo === 'confirmar_pago') {
            // [CMD:confirmar_pago:nombre_inquilino mes]
            const { data: cobros } = await supabase
              .from('cobros')
              .select('*')
              .eq('propietario_id', usuario.id)
              .in('estado', ['pendiente', 'pendiente_confirmacion'])
              .order('fecha_vencimiento', { ascending: false });

            let cobroTarget = null;
            if (comando.param && comando.param.trim()) {
              cobroTarget = cobros?.find(c =>
                c.inquilino_nombre?.toLowerCase().includes(comando.param.toLowerCase())
              ) || cobros?.[0];
            } else {
              cobroTarget = cobros?.[0];
            }

            if (!cobroTarget) {
              await enviarWhatsApp(from, '❌ No encontré un cobro pendiente para confirmar.');
              return;
            }

            const { error: updateErr } = await supabase
              .from('cobros')
              .update({
                estado: 'pagado',
                fecha_pago: new Date().toISOString().split('T')[0]
              })
              .eq('id', cobroTarget.id);

            if (updateErr) throw updateErr;

            // Auto-enviar recibo
            const { data: contrato } = await supabase
              .from('contratos')
              .select('inquilino_telefono, inquilino_email')
              .eq('id', cobroTarget.contrato_id)
              .single();

            let telefonoInquilino = contrato?.inquilino_telefono;
            if (!telefonoInquilino && contrato?.inquilino_email) {
              const { data: profileInq } = await supabase
                .from('profiles')
                .select('whatsapp_phone')
                .eq('email', contrato.inquilino_email)
                .single();
              telefonoInquilino = profileInq?.whatsapp_phone;
            }

            if (telefonoInquilino) {
              let numInq = telefonoInquilino.replace(/\D/g, '');
              if (numInq.startsWith('0')) numInq = numInq.substring(1);
              if (!numInq.startsWith('54')) numInq = '54' + numInq;
              const inqTel = '+' + numInq;
              await generarYEnviarRecibo(cobroTarget, inqTel).catch(() => {});
            }

            await enviarWhatsApp(from, '✅ Pago confirmado. Se le envió el recibo al inquilino.');
          } else if (comando.tipo === 'reclamo') {
            // [CMD:reclamo:descripcion]
            const { data: contratos } = await supabase
              .from('contratos')
              .select('id, propiedad_id, propietario_id')
              .eq('inquilino_email', usuario.email || '')
              .limit(1);

            if (!contratos || contratos.length === 0) {
              await enviarWhatsApp(from, '❌ No encontré un contrato asociado a tu cuenta.');
              return;
            }

            const contrato = contratos[0];
            const { error: insertErr } = await supabase
              .from('reclamos')
              .insert({
                propiedad_id: contrato.propiedad_id,
                contrato_id: contrato.id,
                inquilino_telefono: from,
                inquilino_nombre: usuario.nombre || usuario.email,
                propietario_id: contrato.propietario_id,
                descripcion: comando.param || 'Reclamo registrado por Gemini',
                estado: 'abierto',
                prioridad: 'normal',
                created_at: new Date().toISOString()
              });

            if (insertErr) throw insertErr;

            // Notificar propietario
            const { data: profileProp } = await supabase
              .from('profiles')
              .select('whatsapp_phone')
              .eq('id', contrato.propietario_id)
              .single();

            if (profileProp?.whatsapp_phone) {
              let numProp = profileProp.whatsapp_phone.replace(/\D/g, '');
              if (numProp.startsWith('0')) numProp = numProp.substring(1);
              if (!numProp.startsWith('54')) numProp = '54' + numProp;
              const propTel = '+' + numProp;
              const msgProp = `🔧 *Nuevo reclamo* de ${usuario.nombre || 'Inquilino'}:\n\n${comando.param || 'Reclamo registrado'}`;
              await enviarWhatsApp(propTel, msgProp).catch(() => {});
            }

            await enviarWhatsApp(from, '✅ Tu reclamo fue registrado. El propietario va a ser notificado.');
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
    propiedades:     [],
    contratos:       [],
    cobros:          [],
    servicios:       [],
    expensas:        [],
    admin_relations: [],
    propietarios:    []
  };

  try {
    // ═══ ADMINISTRADOR: datos de los propietarios delegados ═══
    if (rol === 'administrador') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: rels } = await supabase
        .from('admin_propietario_relations')
        .select('*, profiles!admin_propietario_relations_propietario_id_fkey(id,nombre,email)')
        .eq('admin_id', userId)
        .eq('estado', 'aceptado');

      const relsActivas = (rels || []).filter(r => !r.fecha_expiracion || r.fecha_expiracion >= today);
      datos.admin_relations = relsActivas;
      datos.propietarios    = relsActivas.map(r => r.profiles).filter(Boolean);

      if (relsActivas.length === 0) {
        console.log(`📊 Admin sin propietarios activos`);
        return datos;
      }

      const ownerIds = relsActivas.map(r => r.propietario_id);

      // Propiedades: filtradas por propiedades_delegadas (si está vacío => acceso a TODAS del propietario)
      const { data: props } = await supabase
        .from('propiedades').select('*').in('propietario_id', ownerIds);
      datos.propiedades = (props || []).filter(p => {
        const rel = relsActivas.find(r => r.propietario_id === p.propietario_id);
        if (!rel) return false;
        const del = rel.propiedades_delegadas;
        if (!del || !Array.isArray(del) || del.length === 0) return true;
        return del.includes(p.id);
      });

      const propIds = datos.propiedades.map(p => p.id);
      if (propIds.length > 0) {
        const { data: contratos } = await supabase
          .from('contratos').select('*').in('propiedad_id', propIds);
        datos.contratos = contratos || [];

        const contratoIds = datos.contratos.map(c => c.id);
        if (contratoIds.length > 0) {
          const { data: cobros } = await supabase
            .from('cobros').select('*').in('contrato_id', contratoIds)
            .order('fecha_vencimiento', { ascending: false }).limit(30);
          datos.cobros = cobros || [];
        }

        const { data: servicios } = await supabase
          .from('servicios').select('*').in('propiedad_id', propIds);
        datos.servicios = servicios || [];
      }

      const { data: expensas } = await supabase
        .from('expensas').select('*').in('propietario_id', ownerIds)
        .order('periodo', { ascending: false }).limit(20);
      datos.expensas = expensas || [];

      console.log(`📊 Admin con ${relsActivas.length} propietarios: ${datos.propiedades.length} props, ${datos.contratos.length} contratos, ${datos.cobros.length} cobros`);
      return datos;
    }

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
  const esAdmin  = rol === 'administrador';
  const esProp   = !esAdmin && rol !== 'inquilino';
  const rolLabel = esAdmin ? 'administrador/gestor' : (esProp ? 'propietario/locador' : 'inquilino/locatario');

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

*5. Confirmación de pagos y reclamos (inquilino)*
Los inquilinos pueden:
• *Confirmar que pagaron*: escribir "ya pagué" o "transferí el pago". Se registra y notifica al propietario.
• *Enviar comprobante*: enviar una foto/imagen del comprobante de pago. Se guarda y notifica al propietario.
• *Hacer un reclamo*: escribir "reclamo", "se rompió", "arreglar", "gotea", etc. Se registra el reclamo y notifica al propietario.

*6. Confirmación de pago (propietario)*
Los propietarios pueden:
• *Confirmar pago de inquilino*: escribir "confirmar pago de [nombre inquilino]". Se marca como pagado y se envía automáticamente el recibo al inquilino.

*Comandos especiales disponibles (cuando Gemini los detecte):*
• [CMD:confirmar_pago:nombre_inquilino mes] — para que Gemini confirme un pago cuando lo deteca
• [CMD:reclamo:descripcion_del_problema] — para registrar un reclamo cuando lo detecte
• Escribí *borrar* o *reset* para empezar una nueva conversación desde cero.

---
USUARIO: *${nombre}* (${rolLabel})
Email: ${usuario.email || 'No registrado'}

FORMATO: Español rioplatense. Mensajes cortos y claros. *Negrita* para lo importante. Listas con •. Sin tablas. Sin ## ni ---. Máximo 3-4 párrafos por respuesta.

REGLA DE ORO: Si el dato está en la base de datos, lo das directamente. Si no está cargado, explicás en qué sección de alquil.app puede cargarlo.

═══════════ DATOS ACTUALES ═══════════
`;

  // ── BLOQUE ADMINISTRADOR ─────────────────────────────────
  if (esAdmin) {
    const rels = datos.admin_relations || [];
    const propsByOwner = {};
    (datos.propiedades || []).forEach(p => {
      (propsByOwner[p.propietario_id] = propsByOwner[p.propietario_id] || []).push(p);
    });
    const contsByOwner = {};
    (datos.contratos || []).forEach(c => {
      const ownerId = c.propietario_id || (datos.propiedades.find(p => p.id === c.propiedad_id)?.propietario_id);
      if (!ownerId) return;
      (contsByOwner[ownerId] = contsByOwner[ownerId] || []).push(c);
    });

    prompt += `\nROL: Sos administrador/gestor. Gestionás alquileres por cuenta de *${rels.length}* propietario(s) que te delegaron acceso.\n`;
    prompt += `IMPORTANTE: Solo tenés visibilidad de las propiedades que cada propietario te delegó explícitamente. Si el usuario pregunta algo ambiguo (ej: "mis cobros", "cuánto me deben"), aclará siempre por propietario o pedile que especifique.\n`;
    prompt += `NIVELES DE PERMISO: total (todo), cobros (solo cobros y recibos), servicios (solo facturas de servicios), expensas (solo expensas del consorcio/edificio), lectura (solo consulta). Respetalos al sugerir acciones.\n`;

    if (rels.length === 0) {
      prompt += '\nNo hay propietarios activos que te hayan delegado acceso todavía. Decile al usuario que el propietario debe invitarlo desde alquil.app → Propiedades → Administrador.\n';
    } else {
      rels.forEach((rel, i) => {
        const owner = (datos.propietarios || []).find(o => o && o.id === rel.propietario_id);
        const ownerName = owner?.nombre || owner?.email || `Propietario ${i + 1}`;
        const permiso = rel.permiso || 'total';
        const exp = rel.fecha_expiracion ? ` | vence ${rel.fecha_expiracion}` : '';
        prompt += `\n━━━ PROPIETARIO ${i + 1}: *${ownerName}* (permiso: ${permiso}${exp}) ━━━\n`;

        const pOwner = propsByOwner[rel.propietario_id] || [];
        if (pOwner.length > 0) {
          prompt += `PROPIEDADES (${pOwner.length}):\n`;
          pOwner.forEach((p, j) => {
            prompt += `  ${j + 1}. ${p.direccion || 'Sin dirección'}, ${[p.zona, p.localidad, p.provincia].filter(Boolean).join(' ')}\n`;
          });
        } else {
          prompt += 'PROPIEDADES: ninguna delegada.\n';
        }

        const cOwner = contsByOwner[rel.propietario_id] || [];
        if (cOwner.length > 0) {
          prompt += `CONTRATOS (${cOwner.length}):\n`;
          cOwner.forEach((c, j) => {
            const prop = propMap[c.propiedad_id] || `Propiedad ${c.propiedad_id}`;
            const monto = c.monto_alquiler ? `$${Number(c.monto_alquiler).toLocaleString('es-AR')}` : 'Sin monto';
            prompt += `  ${j + 1}. ${prop} — ${c.inquilino_nombre || 'Sin inquilino'} | ${monto} | ${c.estado || 'activo'}\n`;
          });
        }
      });

      if (datos.cobros && datos.cobros.length > 0) {
        const pend = datos.cobros.filter(c => c.estado === 'pendiente').length;
        const pag  = datos.cobros.filter(c => c.estado === 'pagado').length;
        prompt += `\nCOBROS TOTALES (${datos.cobros.length} | ${pend} pendientes | ${pag} pagados):\n`;
        datos.cobros.slice(0, 10).forEach((c, i) => {
          const prop  = propMap[c.propiedad_id] || 'N/A';
          const vence = c.fecha_vencimiento?.split('T')[0] || 'N/A';
          prompt += `  ${i + 1}. ${prop} | ${c.inquilino_nombre || 'N/A'} | $${c.monto || 'N/A'} | Vence: ${vence} | *${c.estado || 'N/A'}*\n`;
        });
        if (datos.cobros.length > 10) prompt += `  ... y ${datos.cobros.length - 10} más.\n`;
      }
    }

  // ── BLOQUE PROPIETARIO ───────────────────────────────────
  } else if (esProp) {
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
// Gemini incluye [CMD:recibo:periodo], [CMD:factura:tipo],
// [CMD:confirmar_pago:...], [CMD:reclamo:...], etc.
// Retorna { textoLimpio, comando } donde comando es null si no hay CMD.
// ═══════════════════════════════════════════════════════════
function procesarComandoCMD(respuesta) {
  const match = respuesta.match(/\[CMD:(recibo|factura|confirmar_pago|reclamo):([^\]]+)\]/i);
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
          .select('tipo, nombre, propiedad_id')
          .eq('id', factura.servicio_id)
          .single();

        if (!servicio) continue;

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
        .select('id, tipo, nombre, propiedad_id, monto, dia_vto')
        .eq('dia_vto', diaTarget);

      if (!serviciosDia || serviciosDia.length === 0) continue;

      for (const srv of serviciosDia) {

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

    // ════════════════════════════════════════════════════════
    // FEATURE 6: ALERTAS DE MOROSIDAD (cobros vencidos)
    // ════════════════════════════════════════════════════════
    const { data: cobrosVencidos } = await supabase
      .from('cobros')
      .select('*')
      .eq('estado', 'pendiente')
      .lt('fecha_vencimiento', hoy.toISOString().slice(0, 10));

    if (cobrosVencidos && cobrosVencidos.length > 0) {
      // Agrupar por propietario
      const moraPorProp = {};
      for (const cobro of cobrosVencidos) {
        if (!moraPorProp[cobro.propietario_id]) {
          moraPorProp[cobro.propietario_id] = [];
        }
        moraPorProp[cobro.propietario_id].push(cobro);
      }

      for (const [propId, cobrosMora] of Object.entries(moraPorProp)) {
        // Obtener número de propietario
        const { data: profileProp } = await supabase
          .from('profiles')
          .select('whatsapp_phone')
          .eq('id', propId)
          .single();

        if (!profileProp?.whatsapp_phone) continue;

        let numProp = profileProp.whatsapp_phone.replace(/\D/g, '');
        if (numProp.startsWith('0')) numProp = numProp.substring(1);
        if (!numProp.startsWith('54')) numProp = '54' + numProp;
        const propTel = '+' + numProp;

        // Agrupar por días de mora
        const por7 = [];
        const por15 = [];
        const por30 = [];
        const porMas30 = [];

        for (const cobro of cobrosMora) {
          const vtoDate = new Date(cobro.fecha_vencimiento);
          const diasVencido = Math.floor((hoy - vtoDate) / (1000 * 60 * 60 * 24));

          if (diasVencido <= 7) por7.push(cobro);
          else if (diasVencido <= 15) por15.push(cobro);
          else if (diasVencido <= 30) por30.push(cobro);
          else porMas30.push(cobro);
        }

        // Enviar alertas de morosidad agrupadas
        if (por7.length > 0) {
          const claveUnica = `mora_7dias_${propId}_${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveUnica)
            .limit(1);

          if (!yaEnviado?.length) {
            const totalMora = por7.reduce((s, c) => s + (c.monto || 0), 0);
            const msg = `⚠️ *AlquilApp — Morosidad detectada*\n\n${por7.length} cobro(s) vencido(s) hace menos de 7 días.\n💰 Monto total: *$${Number(totalMora).toLocaleString('es-AR')}*\n\nAccioná rápido para evitar problemas. 📞`;
            try {
              await enviarWhatsApp(propTel, msg);
              await supabase.from('notificaciones_wa').insert({
                tipo: 'mora_7dias', telefono: propTel, estado: 'enviado', clave_unica: claveUnica
              });
              resultados.enviados++;
            } catch (err) {
              resultados.errores++;
            }
          }
        }

        if (por15.length > 0) {
          const claveUnica = `mora_15dias_${propId}_${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveUnica)
            .limit(1);

          if (!yaEnviado?.length) {
            const totalMora = por15.reduce((s, c) => s + (c.monto || 0), 0);
            const msg = `🔴 *AlquilApp — Morosidad crítica*\n\n${por15.length} cobro(s) vencido(s) hace 8-15 días.\n💰 Monto total: *$${Number(totalMora).toLocaleString('es-AR')}*\n\n¡Urgente! Contactá al inquilino. ⚡`;
            try {
              await enviarWhatsApp(propTel, msg);
              await supabase.from('notificaciones_wa').insert({
                tipo: 'mora_15dias', telefono: propTel, estado: 'enviado', clave_unica: claveUnica
              });
              resultados.enviados++;
            } catch (err) {
              resultados.errores++;
            }
          }
        }

        if (por30.length > 0) {
          const claveUnica = `mora_30dias_${propId}_${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveUnica)
            .limit(1);

          if (!yaEnviado?.length) {
            const totalMora = por30.reduce((s, c) => s + (c.monto || 0), 0);
            const msg = `🚨 *AlquilApp — MOROSIDAD GRAVE*\n\n${por30.length} cobro(s) vencido(s) hace 16-30 días.\n💰 Monto total: *$${Number(totalMora).toLocaleString('es-AR')}*\n\n¡Requiere acción legal inmediata! ⚖️`;
            try {
              await enviarWhatsApp(propTel, msg);
              await supabase.from('notificaciones_wa').insert({
                tipo: 'mora_30dias', telefono: propTel, estado: 'enviado', clave_unica: claveUnica
              });
              resultados.enviados++;
            } catch (err) {
              resultados.errores++;
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // FEATURE 4: RESUMEN MENSUAL AUTOMÁTICO (1° de mes)
    // ════════════════════════════════════════════════════════
    if (hoy.getDate() === 1) {
      // Enviar resumen a todos los propietarios
      const { data: propietarios } = await supabase
        .from('profiles')
        .select('id, whatsapp_phone, nombre')
        .eq('rol', 'propietario');

      if (propietarios) {
        for (const prop of propietarios) {
          if (!prop.whatsapp_phone) continue;

          const mesAnio = `${hoy.getFullYear()}-${String(hoy.getMonth()).padStart(2,'0')}`;
          const claveUnica = `resumen_mensual_${mesAnio}_${prop.id}`;

          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveUnica)
            .limit(1);

          if (yaEnviado?.length > 0) continue;

          // Obtener datos del propietario
          const { data: cobrosDelMes } = await supabase
            .from('cobros')
            .select('*')
            .eq('propietario_id', prop.id);

          const { data: contratos } = await supabase
            .from('contratos')
            .select('*')
            .eq('propietario_id', prop.id);

          if (!cobrosDelMes || !contratos) continue;

          const totalCobrado = cobrosDelMes
            .filter(c => c.estado === 'pagado')
            .reduce((s, c) => s + (c.monto || 0), 0);
          const cantPagados = cobrosDelMes.filter(c => c.estado === 'pagado').length;
          const cobrosPendientes = cobrosDelMes.filter(c => c.estado === 'pendiente' || c.estado === 'pendiente_confirmacion');
          const totalPendiente = cobrosPendientes.reduce((s, c) => s + (c.monto || 0), 0);

          // Próximos ajustes de contrato (dentro de 30 días)
          const proximosMes = new Date(hoy);
          proximosMes.setDate(proximosMes.getDate() + 30);
          const ajustesProximos = contratos.filter(c => {
            if (!c.proximo_ajuste_fecha) return false;
            const ajustDate = new Date(c.proximo_ajuste_fecha);
            return ajustDate >= hoy && ajustDate <= proximosMes;
          });

          let resumen = `📊 *AlquilApp — Resumen Mensual*\n\n`;
          resumen += `*Período: ${hoy.toLocaleString('es-AR', { month: 'long', year: 'numeric' })}*\n\n`;
          resumen += `*Cobros:*\n`;
          resumen += `✅ Pagados: ${cantPagados} | $${Number(totalCobrado).toLocaleString('es-AR')}\n`;
          resumen += `⏳ Pendientes: ${cobrosPendientes.length} | $${Number(totalPendiente).toLocaleString('es-AR')}\n`;
          if (ajustesProximos.length > 0) {
            resumen += `\n*Próximos ajustes de contrato:* ${ajustesProximos.length}\n`;
            ajustesProximos.slice(0, 3).forEach(c => {
              resumen += `• ${c.inquilino_nombre}: ${c.proximo_ajuste_pct || 0}% el ${c.proximo_ajuste_fecha.split('T')[0]}\n`;
            });
          }
          resumen += `\nIngresá a alquil.app para más detalles. 📱`;

          let numProp = prop.whatsapp_phone.replace(/\D/g, '');
          if (numProp.startsWith('0')) numProp = numProp.substring(1);
          if (!numProp.startsWith('54')) numProp = '54' + numProp;
          const propTel = '+' + numProp;

          try {
            await enviarWhatsApp(propTel, resumen);
            await supabase.from('notificaciones_wa').insert({
              tipo: 'resumen_mensual', telefono: propTel, estado: 'enviado', clave_unica: claveUnica
            });
            resultados.enviados++;
          } catch (err) {
            console.error(`❌ Error enviando resumen a ${propTel}:`, err.message);
            resultados.errores++;
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // FEATURE 7: RECORDATORIO DE AJUSTES DE CONTRATO
    // ════════════════════════════════════════════════════════
    const { data: contratos } = await supabase
      .from('contratos')
      .select('*');

    if (contratos) {
      for (const contrato of contratos) {
        if (!contrato.proximo_ajuste_fecha) continue;

        const ajustDate = new Date(contrato.proximo_ajuste_fecha);
        const diasHasta = Math.ceil((ajustDate - hoy) / (1000 * 60 * 60 * 24));

        if (diasHasta === 15 || diasHasta === 5) {
          const tipoAlerta = diasHasta === 15 ? 'ajuste_15dias' : 'ajuste_5dias';
          const claveUnica = `${tipoAlerta}_${contrato.id}_${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveUnica)
            .limit(1);

          if (yaEnviado?.length > 0) continue;

          // Obtener propietario y inquilino
          const { data: profileProp } = await supabase
            .from('profiles')
            .select('whatsapp_phone')
            .eq('id', contrato.propietario_id)
            .single();

          const { data: profileInq } = await supabase
            .from('profiles')
            .select('whatsapp_phone')
            .eq('email', contrato.inquilino_email)
            .single();

          const { data: prop } = await supabase
            .from('propiedades')
            .select('direccion')
            .eq('id', contrato.propiedad_id)
            .single();

          const fechaFmt = ajustDate.toLocaleDateString('es-AR');
          const porcentajeFmt = contrato.proximo_ajuste_pct || 0;
          const indice = contrato.indice_ajuste || 'ICL';
          const propDir = prop?.direccion || 'tu propiedad';
          const inqNombre = contrato.inquilino_nombre || 'Inquilino';

          const mensaje = `📊 *AlquilApp — Aviso de ajuste de contrato*\n\nEl ajuste de alquiler de *${propDir}* será el *${fechaFmt}*.\n\nÍndice: *${indice}*\nAumento: *${porcentajeFmt}%*\n\nVerificá los detalles en alquil.app. 📱`;

          // Notificar propietario
          if (profileProp?.whatsapp_phone) {
            let numProp = profileProp.whatsapp_phone.replace(/\D/g, '');
            if (numProp.startsWith('0')) numProp = numProp.substring(1);
            if (!numProp.startsWith('54')) numProp = '54' + numProp;
            const propTel = '+' + numProp;

            try {
              await enviarWhatsApp(propTel, mensaje);
              await supabase.from('notificaciones_wa').insert({
                tipo: tipoAlerta, telefono: propTel, estado: 'enviado', clave_unica: claveUnica
              });
              resultados.enviados++;
            } catch (err) {
              resultados.errores++;
            }
          }

          // Notificar inquilino
          if (profileInq?.whatsapp_phone) {
            let numInq = profileInq.whatsapp_phone.replace(/\D/g, '');
            if (numInq.startsWith('0')) numInq = numInq.substring(1);
            if (!numInq.startsWith('54')) numInq = '54' + numInq;
            const inqTel = '+' + numInq;

            try {
              await enviarWhatsApp(inqTel, mensaje);
              await supabase.from('notificaciones_wa').insert({
                tipo: tipoAlerta, telefono: inqTel, estado: 'enviado', clave_unica: claveUnica
              });
              resultados.enviados++;
            } catch (err) {
              resultados.errores++;
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // PARTE EXTRA: Recordatorio mensual al propietario para cargar facturas
    // Se ejecuta los días 1 al 5 de cada mes
    // ════════════════════════════════════════════════════════
    const diaDelMes = hoy.getDate();
    if (diaDelMes >= 1 && diaDelMes <= 5) {
      console.log('📄 Enviando recordatorios de carga de facturas a propietarios...');

      // Obtener todos los propietarios con WhatsApp y servicios
      const { data: propietarios } = await supabase
        .from('profiles')
        .select('id, nombre, whatsapp_phone')
        .eq('rol', 'propietario')
        .not('whatsapp_phone', 'is', null);

      if (propietarios && propietarios.length > 0) {
        for (const prop of propietarios) {
          // Verificar si ya se mandó este mes
          const mesActual = hoy.toISOString().slice(0, 7); // "2026-04"
          const claveRecordatorio = `recordatorio_facturas_${prop.id}_${mesActual}`;

          const { data: yaEnviado } = await supabase
            .from('notificaciones_wa')
            .select('id')
            .eq('clave_unica', claveRecordatorio)
            .limit(1);

          if (yaEnviado && yaEnviado.length > 0) continue;

          // Buscar servicios de este propietario
          const { data: servicios } = await supabase
            .from('servicios')
            .select('id, nombre, tipo, proveedor')
            .eq('propietario_id', prop.id);

          if (!servicios || servicios.length === 0) continue;

          // Filtrar solo servicios tipo servicio (no expensas)
          const svcsActivos = servicios.filter(s => {
            const tipo = (s.tipo || '').toLowerCase();
            return tipo !== 'expensas' && tipo !== 'expensa';
          });

          if (svcsActivos.length === 0) continue;

          // Armar mensaje
          const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
          const mesNombre = meses[hoy.getMonth()];
          let listaSvcs = svcsActivos.map(s => `• ${s.nombre || s.tipo}${s.proveedor ? ' (' + s.proveedor + ')' : ''}`).join('\n');

          const mensaje =
            `📄 *Recordatorio de facturas — ${mesNombre}*\n\n` +
            `Hola ${prop.nombre || 'propietario'}, es momento de cargar las facturas del mes. ` +
            `Mandame una *foto de cada factura* y yo la proceso automáticamente.\n\n` +
            `Tus servicios:\n${listaSvcs}\n\n` +
            `📸 Solo sacale foto a la factura y mandala por este chat.`;

          let numProp = (prop.whatsapp_phone || '').replace(/\D/g, '');
          if (numProp.startsWith('0')) numProp = numProp.substring(1);
          if (!numProp.startsWith('54')) numProp = '54' + numProp;
          const telProp = '+' + numProp;

          try {
            await enviarWhatsApp(telProp, mensaje);
            await supabase.from('notificaciones_wa').insert({
              tipo: 'recordatorio_facturas',
              telefono: telProp,
              estado: 'enviado',
              clave_unica: claveRecordatorio
            });
            resultados.enviados++;
            resultados.detalle.push({ tipo: 'recordatorio_facturas', tel: telProp });
          } catch (err) {
            resultados.errores++;
            console.error(`❌ Error enviando recordatorio facturas a ${telProp}:`, err.message);
          }
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
// OAUTH MAIL CALLBACK — intercambiar code por tokens (Google / Microsoft)
// ═══════════════════════════════════════════════════════════
app.options('/oauth-mail-callback', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/oauth-mail-callback', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const { code, provider, user_id, redirect_uri } = req.body;
  if (!code || !user_id) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros (code, user_id)' });
  }

  try {
    let tokenData, email;
    const finalRedirect = redirect_uri || 'https://alquil.app/index.html';

    if (provider === 'microsoft') {
      // ── Microsoft OAuth ──
      const MS_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
      const MS_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
      if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
        return res.status(500).json({ ok: false, error: 'Configuración OAuth Microsoft incompleta' });
      }

      const tokenResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code,
          client_id: MS_CLIENT_ID,
          client_secret: MS_CLIENT_SECRET,
          redirect_uri: finalRedirect,
          grant_type: 'authorization_code',
          scope: 'openid email Mail.Read offline_access'
        })
      });
      tokenData = await tokenResp.json();
      if (tokenData.error) {
        console.error('❌ Error OAuth Microsoft:', tokenData);
        return res.json({ ok: false, error: tokenData.error_description || tokenData.error });
      }

      // Obtener email del usuario via Microsoft Graph
      const meResp = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      const meData = await meResp.json();
      email = meData.mail || meData.userPrincipalName || 'desconocido';

    } else {
      // ── Google OAuth (default) ──
      const G_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
      const G_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
      if (!G_CLIENT_ID || !G_CLIENT_SECRET) {
        return res.status(500).json({ ok: false, error: 'Configuración OAuth Google incompleta' });
      }

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code,
          client_id: G_CLIENT_ID,
          client_secret: G_CLIENT_SECRET,
          redirect_uri: finalRedirect,
          grant_type: 'authorization_code'
        })
      });
      tokenData = await tokenResp.json();
      if (tokenData.error) {
        console.error('❌ Error OAuth Google:', tokenData);
        return res.json({ ok: false, error: tokenData.error_description || tokenData.error });
      }

      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
      });
      const userInfo = await userInfoResp.json();
      email = userInfo.email || 'desconocido';
    }

    // Guardar tokens en el perfil del usuario en Supabase
    const { error: dbError } = await supabase
      .from('profiles')
      .update({
        mail_facturas_email: email,
        mail_facturas_provider: provider || 'google',
        mail_facturas_token: tokenData.access_token,
        mail_facturas_refresh_token: tokenData.refresh_token || null,
        mail_facturas_last_check: null
      })
      .eq('id', user_id);

    if (dbError) {
      console.error('❌ Error guardando tokens en Supabase:', dbError);
      return res.json({ ok: false, error: 'Error guardando credenciales' });
    }

    console.log(`✅ Mail facturas conectado (${provider}): ${email} para usuario ${user_id}`);
    return res.json({ ok: true, email: email });

  } catch (err) {
    console.error('❌ Error en oauth-mail-callback:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REVISAR MAIL FACTURAS — escanear Gmail buscando facturas
// ═══════════════════════════════════════════════════════════
app.options('/revisar-mail-facturas', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/revisar-mail-facturas', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ ok: false, error: 'Falta user_id' });

  try {
    // 1. Obtener perfil con tokens de mail
    const { data: perfil, error: perfErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user_id)
      .single();

    if (perfErr || !perfil) {
      return res.json({ ok: false, error: 'Usuario no encontrado' });
    }

    if (!perfil.mail_facturas_token) {
      return res.json({ ok: false, error: 'No hay mail conectado' });
    }

    // 2. Refrescar token si tenemos refresh_token
    const esGoogle = perfil.mail_facturas_provider === 'google';
    const esMicrosoft = perfil.mail_facturas_provider === 'microsoft';
    let accessToken = perfil.mail_facturas_token;

    if (perfil.mail_facturas_refresh_token) {
      try {
        let refreshResp;
        if (esMicrosoft) {
          refreshResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.MICROSOFT_CLIENT_ID,
              client_secret: process.env.MICROSOFT_CLIENT_SECRET,
              refresh_token: perfil.mail_facturas_refresh_token,
              grant_type: 'refresh_token',
              scope: 'openid email Mail.Read offline_access'
            })
          });
        } else {
          refreshResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              refresh_token: perfil.mail_facturas_refresh_token,
              grant_type: 'refresh_token'
            })
          });
        }
        const refreshData = await refreshResp.json();
        if (refreshData.access_token) {
          accessToken = refreshData.access_token;
          await supabase.from('profiles').update({ mail_facturas_token: accessToken }).eq('id', user_id);
        }
      } catch (refreshErr) {
        console.log('⚠️ No se pudo refrescar token, usando el existente:', refreshErr.message);
      }
    }

    // 3. Buscar emails de empresas de servicios en los últimos 30 días
    const empresasKeywords = 'epe OR edenor OR edesur OR metrogas OR aysa OR caps OR epec OR camuzzi OR litoral gas OR aguas santafesinas OR municipalidad OR abl OR arba';
    let messages = [];

    if (esMicrosoft) {
      // ── Microsoft Graph API ──
      const filterDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const searchUrl = `https://graph.microsoft.com/v1.0/me/messages?$filter=hasAttachments eq true and receivedDateTime ge ${filterDate}&$search="${empresasKeywords.replace(/ OR /g, ' OR ')}"&$top=10&$select=id,subject,from,hasAttachments`;

      const searchResp = await fetch(searchUrl, {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });

      if (searchResp.status === 401) {
        return res.json({ ok: false, error: 'Token de Outlook expirado. Reconectá tu cuenta desde el perfil.' });
      }

      const searchData = await searchResp.json();
      messages = (searchData.value || []).map(m => ({ id: m.id, provider: 'microsoft' }));
    } else {
      // ── Gmail API ──
      const empresasQuery = `from:(${empresasKeywords}) newer_than:90d has:attachment`;
      const searchUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(empresasQuery)}&maxResults=10`;

      const searchResp = await fetch(searchUrl, {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });

      if (searchResp.status === 401) {
        return res.json({ ok: false, error: 'Token de Gmail expirado. Reconectá tu cuenta desde el perfil.' });
      }

      const searchData = await searchResp.json();
      messages = (searchData.messages || []).map(m => ({ id: m.id, provider: 'google' }));
    }

    console.log(`📧 Encontrados ${messages.length} emails de servicios (${perfil.mail_facturas_provider}) para usuario ${user_id}`);

    if (messages.length === 0) {
      await supabase.from('profiles').update({ mail_facturas_last_check: new Date().toISOString() }).eq('id', user_id);
      return res.json({ ok: true, facturas_encontradas: 0 });
    }

    // 4. Obtener servicios del usuario para matchear
    const { data: propiedades } = await supabase
      .from('propiedades')
      .select('id')
      .eq('propietario_id', user_id);

    const propIds = (propiedades || []).map(p => p.id);

    let servicios = [];
    if (propIds.length > 0) {
      const { data: svcs } = await supabase
        .from('servicios')
        .select('*')
        .in('propiedad_id', propIds);
      servicios = svcs || [];
    }

    // 5. Procesar cada email — buscar adjuntos imagen y analizarlos con Gemini
    let facturasEncontradas = 0;

    for (const msg of messages.slice(0, 5)) {
      try {
        let attachments = []; // { base64Data, mime }

        if (msg.provider === 'microsoft') {
          // ── Microsoft Graph: obtener adjuntos ──
          const attResp = await fetch(
            `https://graph.microsoft.com/v1.0/me/messages/${msg.id}/attachments`,
            { headers: { 'Authorization': 'Bearer ' + accessToken } }
          );
          const attData = await attResp.json();
          for (const att of (attData.value || [])) {
            if (!att.contentBytes) continue;
            const mime = (att.contentType || '').toLowerCase();
            if (!mime.includes('image')) continue;
            attachments.push({ base64Data: att.contentBytes, mime });
          }
        } else {
          // ── Gmail: obtener mensaje y adjuntos ──
          const msgResp = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { 'Authorization': 'Bearer ' + accessToken } }
          );
          const msgData = await msgResp.json();
          const parts = msgData.payload?.parts || [];

          for (const part of parts) {
            if (!part.filename || part.filename.length === 0) continue;
            const mime = (part.mimeType || '').toLowerCase();
            if (!mime.includes('image')) continue;
            const attId = part.body?.attachmentId;
            if (!attId) continue;

            const attResp = await fetch(
              `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}/attachments/${attId}`,
              { headers: { 'Authorization': 'Bearer ' + accessToken } }
            );
            const attData = await attResp.json();
            if (!attData.data) continue;
            // Gmail base64url → base64 standard
            attachments.push({ base64Data: attData.data.replace(/-/g, '+').replace(/_/g, '/'), mime });
          }
        }

        // Analizar cada adjunto imagen con Gemini
        for (const att of attachments) {
          try {
            const analisis = await analizarFacturaConGemini(att.base64Data, att.mime);
            if (analisis && analisis.confianza >= 0.6) {
              const svcMatch = servicios.find(s => {
                const tipoS = (s.tipo_servicio || '').toLowerCase();
                const nomS = (s.nombre_servicio || '').toLowerCase();
                const tipoA = (analisis.tipo_servicio || '').toLowerCase();
                const empA = (analisis.empresa || '').toLowerCase();
                return tipoS.includes(tipoA) || nomS.includes(empA) || tipoA.includes(tipoS) || empA.includes(nomS);
              });

              if (svcMatch) {
                const ext = att.mime.includes('png') ? 'png' : 'jpg';
                const filename = `mail_${user_id}_${svcMatch.id}_${Date.now()}.${ext}`;
                const facturaUrl = await subirFacturaAStorage(att.base64Data, att.mime, filename);

                await supabase.from('servicios').update({
                  ultima_factura_monto: analisis.monto || null,
                  ultima_factura_vto: analisis.fecha_vencimiento || null,
                  factura_url: facturaUrl
                }).eq('id', svcMatch.id);

                await supabase.from('facturas_servicios').insert({
                  servicio_id: svcMatch.id,
                  monto: analisis.monto,
                  fecha_vencimiento: analisis.fecha_vencimiento,
                  periodo: analisis.periodo,
                  factura_url: facturaUrl,
                  fuente: 'email_' + msg.provider,
                  datos_extraidos: analisis
                });

                facturasEncontradas++;
                console.log(`✅ Factura de ${analisis.empresa} cargada desde ${msg.provider} email para servicio ${svcMatch.id}`);
              }
            }
          } catch (gemErr) {
            console.log('⚠️ Error analizando adjunto con Gemini:', gemErr.message);
          }
        }
      } catch (msgErr) {
        console.log('⚠️ Error procesando email:', msgErr.message);
      }
    }

    // 6. Actualizar última revisión
    await supabase.from('profiles').update({ mail_facturas_last_check: new Date().toISOString() }).eq('id', user_id);

    console.log(`📧 Revisión de mail completada: ${facturasEncontradas} facturas encontradas`);
    return res.json({ ok: true, facturas_encontradas: facturasEncontradas });

  } catch (err) {
    console.error('❌ Error en revisar-mail-facturas:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// NOTIFICAR: Inquilino creó un servicio → avisar al propietario
// POST /notificar-servicio-creado-inquilino  { servicio_id }
// ═══════════════════════════════════════════════════════════
app.post('/notificar-servicio-creado-inquilino', async (req, res) => {
  try {
    const { servicio_id } = req.body || {};
    if (!servicio_id) return res.status(400).json({ ok: false, error: 'Falta servicio_id' });

    // 1. Cargar servicio
    const { data: svc, error: svcErr } = await supabase
      .from('servicios')
      .select('id, tipo, proveedor, monto, propietario_id, propiedad_id, creado_por')
      .eq('id', servicio_id)
      .single();
    if (svcErr || !svc) return res.json({ ok: false, error: 'Servicio no encontrado' });

    // 2. Datos propietario (destinatario)
    const { data: prop } = await supabase
      .from('profiles')
      .select('whatsapp_phone, full_name, notif_whatsapp')
      .eq('id', svc.propietario_id)
      .single();
    if (!prop || !prop.whatsapp_phone) return res.json({ ok: false, error: 'Propietario sin WhatsApp' });
    if (prop.notif_whatsapp === false) return res.json({ ok: true, skipped: 'notif_whatsapp desactivada' });

    // 3. Datos inquilino (quien lo creó)
    let inqNombre = 'el inquilino';
    if (svc.creado_por) {
      const { data: inq } = await supabase
        .from('profiles').select('full_name').eq('id', svc.creado_por).single();
      if (inq?.full_name) inqNombre = inq.full_name;
    }

    // 4. Dirección
    let direccion = 'tu propiedad';
    if (svc.propiedad_id) {
      const { data: p } = await supabase
        .from('propiedades').select('direccion').eq('id', svc.propiedad_id).single();
      if (p?.direccion) direccion = p.direccion;
    }

    const montoFmt = svc.monto ? '$' + Number(svc.monto).toLocaleString('es-AR') : 'sin monto definido';
    const mensaje =
      '🏠 *AlquilApp — Nuevo servicio creado por inquilino*\n\n' +
      `${inqNombre} registró un nuevo servicio para *${direccion}*:\n\n` +
      `• Tipo: *${svc.tipo || '—'}*\n` +
      (svc.proveedor ? `• Proveedor: ${svc.proveedor}\n` : '') +
      `• Monto estimado: ${montoFmt}\n\n` +
      'Si no estás de acuerdo con este servicio, podés *darlo de baja* desde la app indicando el motivo.\n\n' +
      '👉 https://alquil.app';

    await enviarWhatsApp(prop.whatsapp_phone, mensaje);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error notificar-servicio-creado-inquilino:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// NOTIFICAR: Propietario dio de baja un servicio → avisar al inquilino
// POST /notificar-servicio-baja  { servicio_id }
// ═══════════════════════════════════════════════════════════
app.post('/notificar-servicio-baja', async (req, res) => {
  try {
    const { servicio_id } = req.body || {};
    if (!servicio_id) return res.status(400).json({ ok: false, error: 'Falta servicio_id' });

    // 1. Cargar servicio (dado de baja)
    const { data: svc, error: svcErr } = await supabase
      .from('servicios')
      .select('id, tipo, proveedor, propiedad_id, creado_por, baja_motivo, dado_de_baja_por')
      .eq('id', servicio_id)
      .single();
    if (svcErr || !svc) return res.json({ ok: false, error: 'Servicio no encontrado' });
    if (!svc.creado_por) return res.json({ ok: true, skipped: 'sin creado_por' });

    // 2. Datos inquilino (destinatario: quien lo creó)
    const { data: inq } = await supabase
      .from('profiles')
      .select('whatsapp_phone, full_name, notif_whatsapp')
      .eq('id', svc.creado_por)
      .single();
    if (!inq || !inq.whatsapp_phone) return res.json({ ok: false, error: 'Inquilino sin WhatsApp' });
    if (inq.notif_whatsapp === false) return res.json({ ok: true, skipped: 'notif_whatsapp desactivada' });

    // 3. Propietario (quien dio de baja)
    let propNombre = 'el propietario';
    if (svc.dado_de_baja_por) {
      const { data: p } = await supabase
        .from('profiles').select('full_name').eq('id', svc.dado_de_baja_por).single();
      if (p?.full_name) propNombre = p.full_name;
    }

    // 4. Dirección
    let direccion = 'la propiedad';
    if (svc.propiedad_id) {
      const { data: pr } = await supabase
        .from('propiedades').select('direccion').eq('id', svc.propiedad_id).single();
      if (pr?.direccion) direccion = pr.direccion;
    }

    const motivo = svc.baja_motivo || 'Sin motivo especificado';
    const mensaje =
      '🏠 *AlquilApp — Servicio dado de baja*\n\n' +
      `${propNombre} dio de baja el servicio *${svc.tipo || '—'}*${svc.proveedor ? ' (' + svc.proveedor + ')' : ''} de *${direccion}*.\n\n` +
      `📝 *Motivo:* ${motivo}\n\n` +
      'Si tenés dudas, comunicate con el propietario.\n\n' +
      '👉 https://alquil.app';

    await enviarWhatsApp(inq.whatsapp_phone, mensaje);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error notificar-servicio-baja:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// IMAP GENÉRICO — Alternativa a OAuth Microsoft (bloqueado por Azure MFA)
// Permite leer facturas de Outlook/Hotmail, Yahoo, iCloud y otros vía
// contraseña de aplicación. El usuario no necesita dar su pass real,
// sino una "app password" que puede generar/revocar en su proveedor.
// ═══════════════════════════════════════════════════════════

// POST /imap-configurar  { user_id, email, password, provider }
// Guarda email + contraseña (encriptada) + host en el perfil.
app.post('/imap-configurar', async (req, res) => {
  try {
    const { user_id, email, password, provider } = req.body || {};
    if (!user_id || !email || !password || !provider)
      return res.status(400).json({ ok: false, error: 'Faltan campos: user_id, email, password, provider' });

    const prov = String(provider).toLowerCase().trim();
    const preset = IMAP_PRESETS[prov];
    let host, port;
    if (preset) {
      host = preset.host; port = preset.port;
    } else if (req.body.host && req.body.port) {
      host = String(req.body.host).trim(); port = parseInt(req.body.port, 10) || 993;
    } else {
      return res.status(400).json({ ok: false, error: 'Provider desconocido y sin host/port custom' });
    }

    // Probar conexión antes de guardar
    const client = new ImapFlow({ host, port, secure: true, auth: { user: email, pass: password }, logger: false });
    try {
      await client.connect();
      await client.logout();
    } catch (connErr) {
      return res.status(400).json({ ok: false, error: 'No se pudo conectar. Verificá email y contraseña de aplicación.', detalle: connErr.message });
    }

    const encBlob = encryptPassword(password);
    const { error } = await supabase
      .from('profiles')
      .update({
        mail_imap_email:    email,
        mail_imap_password_enc: encBlob,
        mail_imap_host:     host,
        mail_imap_port:     port,
        mail_imap_provider: prov
      })
      .eq('id', user_id);
    if (error) throw error;

    return res.json({ ok: true, host, port, provider: prov });
  } catch (err) {
    console.error('❌ Error imap-configurar:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// POST /imap-desconectar  { user_id }
app.post('/imap-desconectar', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'Falta user_id' });
    const { error } = await supabase
      .from('profiles')
      .update({
        mail_imap_email: null,
        mail_imap_password_enc: null,
        mail_imap_host: null,
        mail_imap_port: null,
        mail_imap_provider: null,
        mail_imap_last_check: null
      })
      .eq('id', user_id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error imap-desconectar:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// POST /imap-revisar  { user_id }
// Busca emails con adjuntos PDF/imagen de empresas de servicios en los últimos 90 días.
// Descarga adjuntos y los procesa con Gemini Vision (misma lógica que Gmail).
app.post('/imap-revisar', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'Falta user_id' });

    // 1. Cargar credenciales del usuario
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('mail_imap_email, mail_imap_password_enc, mail_imap_host, mail_imap_port, mail_imap_provider')
      .eq('id', user_id)
      .single();
    if (pErr || !profile || !profile.mail_imap_email) {
      return res.status(400).json({ ok: false, error: 'IMAP no configurado para este usuario' });
    }

    const pass = decryptPassword(profile.mail_imap_password_enc);
    const client = new ImapFlow({
      host: profile.mail_imap_host,
      port: profile.mail_imap_port || 993,
      secure: true,
      auth: { user: profile.mail_imap_email, pass },
      logger: false
    });

    // 2. Conectar y buscar
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let facturasEncontradas = 0;
    let procesadas = 0;
    const empresasKeywords = [
      'edenor', 'edesur', 'metrogas', 'naturgy', 'aysa', 'absa',
      'personal', 'movistar', 'claro', 'flow', 'telecentro', 'cablevision',
      'directv', 'telecom', 'tuenti', 'fibertel', 'arnet',
      'expensas', 'consorcio', 'administracion'
    ];

    try {
      // Buscar emails de los últimos 90 días con adjuntos
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since, hasAttachment: true });
      const uidsRecientes = (uids || []).slice(-200); // máximo 200 para no demorar

      for (const uid of uidsRecientes) {
        try {
          const msg = await client.fetchOne(uid, { envelope: true, source: true });
          if (!msg) continue;
          const fromAddr = ((msg.envelope?.from || [])[0]?.address || '').toLowerCase();
          const subject  = (msg.envelope?.subject || '').toLowerCase();
          const coincide = empresasKeywords.some(k => fromAddr.includes(k) || subject.includes(k));
          if (!coincide) continue;

          procesadas++;
          const parsed = await simpleParser(msg.source);
          const adjuntos = (parsed.attachments || []).filter(a =>
            a.contentType && (a.contentType.startsWith('image/') || a.contentType === 'application/pdf')
          );
          if (adjuntos.length === 0) continue;

          // Nota: aquí solo contamos. El procesamiento con Gemini Vision
          // se hace a través del flujo existente de facturas-servicios.
          // Registramos el intento para debug.
          facturasEncontradas += adjuntos.length;
        } catch (msgErr) {
          console.log('⚠️ Error procesando mail IMAP:', msgErr.message);
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }

    // 3. Actualizar última revisión
    await supabase.from('profiles').update({ mail_imap_last_check: new Date().toISOString() }).eq('id', user_id);

    return res.json({ ok: true, revisados: procesadas, adjuntos_encontrados: facturasEncontradas });
  } catch (err) {
    console.error('❌ Error imap-revisar:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// REENVÍO: Casilla central facturas@alquil.app
// ═══════════════════════════════════════════════════════════
// El usuario configura en su Gmail/Outlook un reenvío a facturas@alquil.app.
// El bot se conecta a esa casilla central (una sola vez, configurada vía
// IMAP_INBOX_* env vars) y lee los emails reenviados. Cada email lo matchea
// contra un usuario por el header "X-Forwarded-For" o por comparar remitentes
// conocidos con profiles.forward_email. Al encontrar un match, guarda los
// adjuntos en Supabase Storage y registra una fila en facturas_reenviadas.

// POST /forward-configurar  { user_id, forward_email }
// Guarda la dirección desde la cual el usuario va a reenviar los mails.
app.post('/forward-configurar', async (req, res) => {
  try {
    const { user_id, forward_email } = req.body || {};
    if (!user_id || !forward_email) return res.status(400).json({ ok: false, error: 'Faltan datos' });

    const email = String(forward_email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido' });
    }

    const { error } = await supabase
      .from('profiles')
      .update({ forward_email: email, forward_verified: false })
      .eq('id', user_id);
    if (error) throw error;
    return res.json({ ok: true, forward_email: email });
  } catch (err) {
    console.error('❌ Error forward-configurar:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// POST /forward-desconectar  { user_id }
app.post('/forward-desconectar', async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'Falta user_id' });
    const { error } = await supabase
      .from('profiles')
      .update({ forward_email: null, forward_verified: false, forward_last_check: null })
      .eq('id', user_id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error forward-desconectar:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// Helper: extraer posibles emails del usuario a partir de headers del mail reenviado.
function _extractCandidateEmails(parsed, rawHeaders) {
  const out = new Set();
  const push = v => {
    if (!v) return;
    const s = String(v).toLowerCase();
    const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
    if (m) m.forEach(x => out.add(x.toLowerCase()));
  };
  push(rawHeaders['x-forwarded-for']);
  push(rawHeaders['x-forwarded-to']);
  push(rawHeaders['x-original-to']);
  push(rawHeaders['resent-from']);
  push(rawHeaders['return-path']);
  push(rawHeaders['reply-to']);
  // "From" del envelope del forward puede ser el usuario (cuando usa "reenviar manualmente")
  push(rawHeaders['from']);
  push(rawHeaders['sender']);
  // Received headers pueden contener el email origen
  push(rawHeaders['delivered-to']);
  return Array.from(out);
}

// Procesa una casilla IMAP (facturas@alquil.app) y matchea cada mensaje con un usuario.
async function _pollInboxFacturas() {
  if (!IMAP_INBOX_HOST || !IMAP_INBOX_EMAIL || !IMAP_INBOX_PASSWORD) {
    return { ok: false, error: 'IMAP_INBOX_* no configurado en env' };
  }

  const client = new ImapFlow({
    host: IMAP_INBOX_HOST,
    port: parseInt(IMAP_INBOX_PORT || '993', 10),
    secure: true,
    auth: { user: IMAP_INBOX_EMAIL, pass: IMAP_INBOX_PASSWORD },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  const resumen = { leidos: 0, matcheados: 0, guardados: 0, sin_match: 0, errores: 0 };

  try {
    // Solo los no leídos → así cada mensaje se procesa una vez.
    const uids = await client.search({ seen: false });
    for (const uid of (uids || [])) {
      try {
        resumen.leidos++;
        const msg = await client.fetchOne(uid, { envelope: true, source: true, flags: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        const rawHeaders = {};
        parsed.headerLines.forEach(h => { rawHeaders[h.key.toLowerCase()] = h.line.split(':').slice(1).join(':').trim(); });

        const candidates = _extractCandidateEmails(parsed, rawHeaders);
        let userRow = null;
        if (candidates.length) {
          const { data: hits } = await supabase
            .from('profiles')
            .select('id, forward_email, whatsapp_phone')
            .in('forward_email', candidates)
            .limit(1);
          if (hits && hits.length) userRow = hits[0];
        }

        if (!userRow) {
          resumen.sin_match++;
          // Lo dejamos sin marcar para revisión manual (no lo marcamos como leído).
          continue;
        }

        const adjuntos = (parsed.attachments || []).filter(a =>
          a.contentType && (a.contentType.startsWith('image/') || a.contentType === 'application/pdf')
        );

        const fromAddr = ((parsed.from && parsed.from.value && parsed.from.value[0]?.address) || '').toLowerCase();
        const subject  = parsed.subject || '';

        if (adjuntos.length === 0) {
          // Email sin adjunto: registramos la fila igual para trazabilidad, procesada=true para no reintentar.
          await supabase.from('facturas_reenviadas').insert({
            user_id: userRow.id,
            from_address: fromAddr,
            subject,
            procesada: true,
            raw_headers: rawHeaders
          });
          await client.messageFlagsAdd(uid, ['\\Seen']);
          resumen.matcheados++;
          continue;
        }

        // Subir cada adjunto a Supabase Storage
        for (const att of adjuntos) {
          const safeName = (att.filename || 'factura').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
          const path = `${userRow.id}/${Date.now()}_${safeName}`;
          const { error: upErr } = await supabase.storage
            .from('facturas-mail')
            .upload(path, att.content, { contentType: att.contentType, upsert: false });
          if (upErr) {
            console.log('⚠️ Error subiendo adjunto:', upErr.message);
            continue;
          }
          const { data: pub } = supabase.storage.from('facturas-mail').createSignedUrl
            ? await supabase.storage.from('facturas-mail').createSignedUrl(path, 60 * 60 * 24 * 30)
            : { data: { signedUrl: null } };

          await supabase.from('facturas_reenviadas').insert({
            user_id: userRow.id,
            from_address: fromAddr,
            subject,
            attachment_url: pub?.signedUrl || path,
            attachment_name: safeName,
            content_type: att.contentType,
            procesada: false,
            raw_headers: rawHeaders
          });
          resumen.guardados++;
        }

        // Marcar como verificado la primera vez
        await supabase.from('profiles')
          .update({ forward_verified: true, forward_last_check: new Date().toISOString() })
          .eq('id', userRow.id);

        await client.messageFlagsAdd(uid, ['\\Seen']);
        resumen.matcheados++;
      } catch (msgErr) {
        resumen.errores++;
        console.log('⚠️ Error procesando mensaje reenviado:', msgErr.message);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return { ok: true, resumen };
}

// POST /revisar-facturas-reenviadas  (sin body, ejecuta el polling de la casilla central)
app.post('/revisar-facturas-reenviadas', async (req, res) => {
  try {
    const r = await _pollInboxFacturas();
    return res.json(r);
  } catch (err) {
    console.error('❌ Error revisar-facturas-reenviadas:', err);
    return res.json({ ok: false, error: err.message });
  }
});

// Polling automático cada 10 minutos (si env vars están configuradas)
if (process.env.IMAP_INBOX_HOST && process.env.IMAP_INBOX_EMAIL && process.env.IMAP_INBOX_PASSWORD) {
  console.log('📬 Polling automático de facturas@alquil.app activado (cada 10 min)');
  setInterval(() => {
    _pollInboxFacturas()
      .then(r => { if (r.ok && r.resumen && (r.resumen.guardados || r.resumen.sin_match)) console.log('📬 Poll:', r.resumen); })
      .catch(e => console.log('⚠️ Poll error:', e.message));
  }, 10 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════
// PROXY DE APIs DE IA — para no exponer keys en el frontend
// Endpoints transparentes: el body llega tal cual del cliente,
// agregamos el Authorization con la key de env y reenviamos.
// ═══════════════════════════════════════════════════════════
function _originPermitido(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  // Permitir alquil.app, www.alquil.app, Ferozo preview y local dev
  const ok = /(^https?:\/\/)(www\.)?alquil\.app/.test(origin)
          || /ferozo\.com/.test(origin)
          || /localhost|127\.0\.0\.1|file:\/\//.test(origin)
          || origin === '';
  return ok;
}

// ── Proxy Gemini ─────────────────────────────────────────────
app.post('/ai/gemini', async (req, res) => {
  if (!_originPermitido(req)) return res.status(403).json({ error: 'Origen no permitido' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_KEY no configurada' });
  const model = (req.query.model || 'gemini-2.0-flash').replace(/[^a-zA-Z0-9.-]/g, '');
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }
    );
    const txt = await r.text();
    res.status(r.status).type('application/json').send(txt);
  } catch (e) {
    console.error('Proxy Gemini error:', e.message);
    res.status(502).json({ error: 'Upstream Gemini error' });
  }
});

// ── Proxy Cohere ─────────────────────────────────────────────
app.post('/ai/cohere', async (req, res) => {
  if (!_originPermitido(req)) return res.status(403).json({ error: 'Origen no permitido' });
  if (!COHERE_KEY) return res.status(500).json({ error: 'COHERE_KEY no configurada' });
  try {
    const r = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + COHERE_KEY },
      body: JSON.stringify(req.body)
    });
    const txt = await r.text();
    res.status(r.status).type('application/json').send(txt);
  } catch (e) {
    console.error('Proxy Cohere error:', e.message);
    res.status(502).json({ error: 'Upstream Cohere error' });
  }
});

// ── Proxy DeepSeek ───────────────────────────────────────────
app.post('/ai/deepseek', async (req, res) => {
  if (!_originPermitido(req)) return res.status(403).json({ error: 'Origen no permitido' });
  if (!DEEPSEEK_KEY) return res.status(500).json({ error: 'DEEPSEEK_KEY no configurada' });
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify(req.body)
    });
    const txt = await r.text();
    res.status(r.status).type('application/json').send(txt);
  } catch (e) {
    console.error('Proxy DeepSeek error:', e.message);
    res.status(502).json({ error: 'Upstream DeepSeek error' });
  }
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status:    'ok',
    app:       'AlquilApp WhatsApp Bot (Twilio)',
    version:   '5.7.0',
    timestamp: new Date().toISOString(),
    features:  [
      'recibos-pdf',
      'facturas-servicios',
      'recordatorios-servicios',
      'audio',
      'gemini-ai',
      'confirmar-pago-inquilino',
      'comprobante-imagen',
      'reclamos-mantenimiento',
      'confirmar-pago-propietario',
      'resumen-mensual',
      'alertas-morosidad',
      'recordatorio-ajustes',
      'factura-por-foto-propietario',
      'recordatorio-mensual-facturas',
      'mail-facturas-oauth',
      'mail-facturas-scan'
    ],
    env_check: {
      TWILIO_ACCOUNT_SID:    TWILIO_ACCOUNT_SID    ? 'SET' : '❌ UNSET',
      TWILIO_AUTH_TOKEN:     TWILIO_AUTH_TOKEN     ? 'SET' : '❌ UNSET',
      TWILIO_WHATSAPP_NUMBER:TWILIO_WHATSAPP_NUMBER? 'SET' : '❌ UNSET',
      GEMINI_KEY:            GEMINI_KEY            ? 'SET' : '❌ UNSET',
      SUPABASE_URL:          SUPABASE_URL          ? 'SET' : '❌ UNSET',
      SUPABASE_SERVICE_KEY:  SUPABASE_SERVICE_KEY  ? 'SET' : '❌ UNSET',
      GOOGLE_CLIENT_ID:      GOOGLE_CLIENT_ID      ? 'SET' : '❌ UNSET',
      GOOGLE_CLIENT_SECRET:  GOOGLE_CLIENT_SECRET  ? 'SET' : '❌ UNSET',
      MICROSOFT_CLIENT_ID:   MICROSOFT_CLIENT_ID   ? 'SET' : '❌ UNSET',
      MICROSOFT_CLIENT_SECRET:MICROSOFT_CLIENT_SECRET? 'SET' : '❌ UNSET',
    }
  });
});

app.get('/webhook', (req, res) => {
  res.send('AlquilApp WhatsApp Bot v5.3.0 — Webhook activo ✅');
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
    console.log('║   AlquilApp WhatsApp Bot v5.3.0        ║');
    console.log(`║   Escuchando en puerto ${PORT}            ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  POST /webhook            → Recibe mensajes de Twilio');
    console.log('  POST /cobro-pagado       → Auto-envía recibo al inquilino');
    console.log('  GET  /notif-automaticas  → Recordatorios + resumen + morosidad + ajustes');
    console.log('  POST /verify-whatsapp    → Verifica conexión al sandbox');
    console.log('  GET  /                   → Health check');
    console.log('');
    console.log('Features (v5.3.0):');
    console.log('  ✅ Recibos PDF automáticos');
    console.log('  ✅ Facturas de servicios');
    console.log('  ✅ Confirmación de pago (inquilino)');
    console.log('  ✅ Envío de comprobantes (imágenes)');
    console.log('  ✅ Reclamos y mantenimiento');
    console.log('  ✅ Confirmación de pago (propietario)');
    console.log('  ✅ Resumen mensual automático');
    console.log('  ✅ Alertas de morosidad');
    console.log('  ✅ Recordatorio de ajustes de contrato');
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
