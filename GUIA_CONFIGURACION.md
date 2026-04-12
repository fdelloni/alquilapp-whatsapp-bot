# AlquilApp — Guía de Configuración del Bot de WhatsApp

## Resumen

El bot permite que los usuarios de AlquilApp consulten datos de sus alquileres escribiendo por WhatsApp. El bot identifica al usuario por su número (registrado en "Mi Perfil" de la web), consulta sus datos en Supabase, y usa Gemini AI para responder en lenguaje natural.

---

## Paso 1: Crear cuenta de Meta Business (WhatsApp Business API)

1. Andá a https://developers.facebook.com/
2. Creá una cuenta de desarrollador (o logueate con tu cuenta de Facebook)
3. Hacé click en "Crear app" → elegí "Otro" → "Empresa"
4. Ponele nombre: "AlquilApp Bot"
5. En el panel de la app, buscá "WhatsApp" y hacé click en "Configurar"
6. Te va a dar:
   - Un **Token temporal** (después se cambia por uno permanente)
   - Un **Phone Number ID** (el número desde el que envía el bot)
   - Un **número de prueba** para testear

## Paso 2: Configurar el Webhook

El webhook es la URL donde Meta envía los mensajes que recibe tu bot.

1. Primero necesitás desplegar el bot en un servidor (ver Paso 4)
2. Una vez que tengas la URL (ej: `https://tu-bot.railway.app`), volvé a la config de WhatsApp en Meta
3. En "Configuración del webhook", poné:
   - **URL del callback**: `https://tu-bot.railway.app/webhook`
   - **Token de verificación**: `alquilapp_verify_2026` (mismo que en tu .env)
4. Hacé click en "Verificar y guardar"
5. Suscribite al campo **messages**

## Paso 3: Obtener el Service Role Key de Supabase

El bot necesita una clave especial de Supabase para leer datos de todos los usuarios (no la anon key pública).

1. Andá a https://supabase.com → tu proyecto AlquilApp
2. Settings → API
3. Copiá la clave **service_role** (la que dice "This key has the ability to bypass Row Level Security")
4. ⚠️ IMPORTANTE: Esta clave es privada, nunca la pongas en el frontend

## Paso 4: Desplegar en Railway (gratis)

Railway es la forma más fácil y gratis de hostear el bot.

1. Andá a https://railway.app/ y creá una cuenta (con GitHub)
2. Hacé click en "New Project" → "Deploy from GitHub repo"
3. Subí la carpeta `whatsapp-bot` a un repo de GitHub, o usá "Deploy from template" y subí los archivos
4. Configurá las variables de entorno en Railway:
   - `WHATSAPP_TOKEN` = el token de Meta
   - `WHATSAPP_VERIFY_TOKEN` = `alquilapp_verify_2026`
   - `WHATSAPP_PHONE_NUMBER_ID` = el Phone Number ID de Meta
   - `GEMINI_KEY` = `AIzaSyCGFxebdc4Bv9vkMtyBkQ5185_jj8YZ3mc`
   - `SUPABASE_URL` = `https://rrgdwwaalozhsizngqrx.supabase.co`
   - `SUPABASE_SERVICE_KEY` = la service_role key del Paso 3
   - `PORT` = `3000`
5. Railway te va a dar una URL pública (ej: `https://alquilapp-bot.up.railway.app`)
6. Usá esa URL para configurar el webhook en Meta (Paso 2)

## Paso 5: Probar el bot

1. En Meta Developers, andá a WhatsApp → "Enviar y recibir mensajes"
2. Agregá tu número personal como número de prueba
3. Enviá un mensaje al número del bot desde WhatsApp
4. Deberías recibir una respuesta del asistente

## Paso 6: Actualizar la web

En la sección "Mi Perfil" de AlquilApp, donde dice "Estado del Bot de WhatsApp", podés actualizar el número del bot para que los usuarios sepan a qué número escribir.

---

## Estructura de archivos

```
whatsapp-bot/
├── index.js              ← Servidor principal (Express + webhooks)
├── package.json          ← Dependencias (express, supabase)
├── .env.example          ← Template de variables de entorno
└── GUIA_CONFIGURACION.md ← Esta guía
```

## Flujo del bot

```
Usuario escribe por WhatsApp
       ↓
Meta envía POST a /webhook
       ↓
Bot extrae el número del remitente
       ↓
Busca en Supabase: profiles.whatsapp_phone
       ↓
Si lo encuentra → carga datos (propiedades, contratos, cobros, etc.)
       ↓
Envía pregunta + contexto a Gemini AI
       ↓
Gemini responde con datos reales del usuario
       ↓
Bot envía la respuesta por WhatsApp
```

## Costos estimados

| Servicio | Costo |
|----------|-------|
| WhatsApp Business API | Gratis primeras 1,000 conversaciones/mes |
| Railway (hosting) | Gratis (tier hobby, 500 horas/mes) |
| Gemini AI | ~$0.001 por consulta |
| Supabase | Gratis (tier free) |

**Total estimado: $0/mes** para empezar (hasta 1,000 usuarios activos).
