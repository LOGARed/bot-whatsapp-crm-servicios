import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { ejecutarReporteDiario } from './generar_reporte.js';
import { registrarMensajeEnHistorial } from './historial_conversaciones.js';
import { generarUrlGoogleCalendar, leerCitasAgendadas } from './google_calendar.js';
import { generateAIResponse } from './ai_agent.js';

const PORT = parseInt(process.env.CRM_PORT || '3090', 10);
const LOGS_DIR = path.resolve('./conversaciones_guardadas');
const REPORTS_DIR = path.resolve('./reportes_generados');
const PUBLIC_DIR = path.resolve('./public');
const PAUSED_STATE_FILE = path.resolve('./conversaciones_guardadas/_chats_pausados.json');
const GLOBAL_URL_FILE = path.resolve('./conversaciones_guardadas/_url_global_app.txt');
const MEDIA_DIR = path.resolve('./conversaciones_guardadas/media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

let globalTunnelUrl = '';
let tunnelProcess = null;
let tunnelWatchdogTimer = null;

/**
 * Inicia y mantiene activo un túnel HTTPS global con Cloudflare Tunnel (trycloudflare.com)
 * Alta estabilidad 24/7 para acceso desde datos móviles 4G/5G y cualquier red externa.
 */
function iniciarTunelGlobal() {
  try {
    if (tunnelProcess) {
      try {
        tunnelProcess.removeAllListeners('close');
        tunnelProcess.kill();
      } catch {}
    }

    const cfPath = path.resolve('./cloudflared.exe');
    const cmd = fs.existsSync(cfPath) ? cfPath : 'cloudflared';

    tunnelProcess = spawn(cmd, [
      'tunnel',
      '--url', `http://127.0.0.1:${PORT}`,
      '--no-autoupdate',
      '--protocol', 'http2'
    ], { windowsHide: true });

    const handleOutput = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && match[0] !== globalTunnelUrl) {
        globalTunnelUrl = match[0];
        try {
          if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
          fs.writeFileSync(GLOBAL_URL_FILE, globalTunnelUrl, 'utf8');
        } catch {}
        console.log(`🌎 [ACCESO MUNDIAL CLOUDFLARE 4G/5G ACTIVO]: ${globalTunnelUrl}`);
      }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('close', () => {
      // Reconectar automáticamente si la conexión de internet parpadea
      setTimeout(iniciarTunelGlobal, 5000);
    });

    tunnelProcess.on('error', (err) => {
      console.error('⚠️ Error en proceso cloudflared:', err.message);
    });

    // Watchdog cada 2 minutos: si el túnel deja de responder tras un corte de Wi-Fi, lo regenera automáticamente.
    // Usa la ruta PÚBLICA /api/auth-status (no requiere contraseña) y exige 3 fallos seguidos
    // antes de regenerar, porque cada regeneración cambia la URL de trycloudflare.
    if (!tunnelWatchdogTimer) {
      let fallosSeguidos = 0;
      tunnelWatchdogTimer = setInterval(async () => {
        if (!globalTunnelUrl) return;
        let sano = false;
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 15000);
          const res = await fetch(`${globalTunnelUrl}/api/auth-status`, { signal: controller.signal });
          clearTimeout(t);
          // Cualquier respuesta de nuestro servidor (incluso 401) significa que el túnel funciona;
          // Cloudflare responde 502/530 cuando el túnel está caído.
          sano = res.status < 500;
        } catch {
          sano = false;
        }
        if (sano) {
          fallosSeguidos = 0;
          return;
        }
        fallosSeguidos++;
        console.log(`⚠️ [WATCHDOG CLOUDFLARE] Túnel sin respuesta (${fallosSeguidos}/3)`);
        if (fallosSeguidos >= 3) {
          fallosSeguidos = 0;
          console.log('🔄 [WATCHDOG CLOUDFLARE] Regenerando túnel global...');
          iniciarTunelGlobal();
        }
      }, 120000);
    }
  } catch (err) {
    console.error('⚠️ Error iniciando túnel global Cloudflare:', err.message);
  }
}

export function obtenerUrlGlobalApp() {
  if (globalTunnelUrl) return globalTunnelUrl;
  try {
    if (fs.existsSync(GLOBAL_URL_FILE)) {
      return fs.readFileSync(GLOBAL_URL_FILE, 'utf8').trim();
    }
  } catch {}
  return '';
}

let activeContext = {
  getSock: () => null,
  humanHandledChats: new Set(),
  trackBotMessage: () => {}
};

/**
 * Obtiene la dirección IP local (Wi-Fi / LAN) para conectar celulares
 */
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Lee y sincroniza el estado de chats pausados en disco
 */
export function leerChatsPausadosDisco() {
  try {
    if (fs.existsSync(PAUSED_STATE_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PAUSED_STATE_FILE, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    // Ignorar errores de lectura
  }
  return new Set();
}

export function guardarChatsPausadosDisco(setOfJids) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(PAUSED_STATE_FILE, JSON.stringify([...setOfJids], null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando estado de chats pausados:', e.message);
  }
}

const BOT_GLOBAL_STATE_FILE = path.resolve('./conversaciones_guardadas/_estado_bot.json');

/**
 * Lee el estado global del bot en disco (activo o pausado completamente)
 */
export function leerEstadoBotGlobalDisco() {
  try {
    if (fs.existsSync(BOT_GLOBAL_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(BOT_GLOBAL_STATE_FILE, 'utf8'));
      if (typeof data.activo === 'boolean') return data.activo;
    }
  } catch (e) {}
  return true; // Activo por defecto
}

/**
 * Guarda el estado global del bot en disco (Master Switch)
 */
export function guardarEstadoBotGlobalDisco(activo, motivo = '') {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(BOT_GLOBAL_STATE_FILE, JSON.stringify({
      activo: Boolean(activo),
      motivo,
      actualizado: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })
    }, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando estado global del bot:', e.message);
  }
}

/**
 * Escanea de forma inteligente y segura las conversaciones recientes (máximo 48 horas / 2 días)
 * para atender o dar seguimiento a prospectos activos que se quedaron esperando respuesta.
 */
let escaneo48hEnCurso = false;

function formatToJid(phone) {
  const clean = (phone || '').replace(/\D/g, '');
  if (clean.startsWith('52') && clean.length >= 12) {
    return `${clean}@s.whatsapp.net`;
  }
  return `521${clean}@s.whatsapp.net`;
}

export async function escanearChatsRecientes48H(forzar = false) {
  if (escaneo48hEnCurso) {
    return { ok: false, motivo: 'Ya hay un escaneo en curso' };
  }

  // 🛡️ El escaneo SIEMPRE respeta la pausa global: si el bot está pausado, no se envía nada.
  if (!leerEstadoBotGlobalDisco()) {
    console.log('⏸️ [SCANNER 48H]: Bot en pausa global. Escaneo cancelado.');
    return { ok: false, motivo: 'El bot está en PAUSA global' };
  }

  const sock = activeContext.getSock ? activeContext.getSock() : null;
  if (!sock || !sock.user) {
    console.log('⚠️ [SCANNER 48H]: WhatsApp desconectado o socket no listo.');
    return { ok: false, motivo: 'WhatsApp no está conectado' };
  }

  escaneo48hEnCurso = true;
  try {
    return await ejecutarEscaneo48H(sock, forzar);
  } finally {
    escaneo48hEnCurso = false;
  }
}

async function ejecutarEscaneo48H(sock, forzar = false) {
  const VENTANA_48H_MS = 2 * 24 * 60 * 60 * 1000; // 48 horas exactas
  const ahora = Date.now();

  if (!fs.existsSync(LOGS_DIR)) return { ok: true, totalCandidatos: 0, respondidos: 0, candidatos: [] };

  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  let respondidos = 0;
  let candidatosEncontrados = [];

  console.log(`\n🔍 [SCANNER 48H]: Analizando conversaciones recientes (máximo 48 horas / 2 días)...`);

  for (const file of files) {
    try {
      const filePath = path.join(LOGS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // 1. Validar antigüedad exacta
      let ultimoTimestamp = 0;
      if (data.ultimaActualizacionISO) {
        ultimoTimestamp = new Date(data.ultimaActualizacionISO).getTime();
      } else if (Array.isArray(data.mensajes) && data.mensajes.length > 0) {
        const lastM = data.mensajes[data.mensajes.length - 1];
        ultimoTimestamp = lastM.timestampMs || 0;
      }

      if (!ultimoTimestamp) continue;
      const edadMs = ahora - ultimoTimestamp;

      // 🛡️ REGLA ESTRICTA 1: Menor o igual a 2 días (48 hrs)
      if (edadMs > VENTANA_48H_MS || edadMs < 0) {
        continue;
      }

      const jid = data.contacto?.jid;
      if (!jid) continue;

      // 🛡️ REGLA ESTRICTA 2: No molestar si un humano está atendiendo activamente (a menos que se fuerce el escaneo)
      if (!forzar && (data.pausadoPorAsesor || activeContext.humanHandledChats.has(jid))) {
        continue;
      }

      // 🛡️ REGLA ESTRICTA 3: No molestar si ya tiene cita agendada
      if (data.citaAgendada) {
        continue;
      }

      // 🛡️ REGLA ESTRICTA 4: El último mensaje DEBE ser del cliente
      const mensajes = Array.isArray(data.mensajes) ? data.mensajes : [];
      if (mensajes.length === 0) continue;
      const ultimoMensaje = mensajes[mensajes.length - 1];
      if (ultimoMensaje.rol !== 'Cliente' && ultimoMensaje.rol !== 'Cliente (con asesor)') {
        continue;
      }

      // 🛡️ REGLA ESTRICTA 5: Si ya se envió seguimiento posterior a este último mensaje del cliente, no repetir
      if (!forzar && data.ultimoSeguimientoISO) {
        const tsSeguimiento = new Date(data.ultimoSeguimientoISO).getTime();
        if (tsSeguimiento >= (ultimoMensaje.timestampMs || 0)) {
          continue;
        }
      }

      const horasAtras = Math.max(1, Math.round(edadMs / (3600 * 1000)));
      candidatosEncontrados.push({
        nombre: data.contacto.nombre,
        telefono: data.contacto.telefonoFormato,
        ultimoMensaje: ultimoMensaje.contenido,
        horasAtras
      });

      console.log(`📌 [CANDIDATO 48H]: ${data.contacto.nombre} (${data.contacto.telefonoFormato}) - Mensaje de hace ${horasAtras}h: "${ultimoMensaje.contenido}"`);

      // 2. Generar respuesta humana y contextualizada
      const instruccionContextual = `El cliente ${data.contacto.nombre} nos escribió dentro de las últimas 48 horas: "${ultimoMensaje.contenido}".
Responde con calidez humana, empatía y profesionalismo en español de México, como un asesor de arquitectura que da seguimiento atento a su proyecto de cocina.
Máximo 2 párrafos cortos. No uses lenguaje robótico, divisiones ni disclaimers. Invítale cordialmente a continuar platicando sobre su espacio o dimensiones.`;

      const aiRes = await generateAIResponse(jid, ultimoMensaje.contenido, data.contacto, null, instruccionContextual);
      let reply = aiRes?.reply;
      if (!reply) continue;

      // 3. Simulación de tipeo humano
      try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 2600));
        await sock.sendPresenceUpdate('paused', jid);
      } catch {}

      // Si en el intermedio se pausó el bot, frenar inmediatamente
      if (!leerEstadoBotGlobalDisco()) break;

      let sent = null;
      try {
        sent = await sock.sendMessage(jid, { text: reply });
      } catch (errLid) {
        console.warn(`⚠️ [SCANNER 48H]: Envío a JID [${jid}] falló (${errLid.message}). Reintentando con formato de teléfono estándar...`);
        const fallbackJid = formatToJid(data.contacto.telefono || jid);
        sent = await sock.sendMessage(fallbackJid, { text: reply });
      }
      if (activeContext.trackBotMessage && sent) activeContext.trackBotMessage(sent);

      // 4. Registrar respuesta en el expediente y actualizar estado
      await registrarMensajeEnHistorial(data.contacto, 'Alex de ventas', reply);

      try {
        const updated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        updated.seguimientoRecienteEnviado = true;
        updated.ultimoSeguimientoISO = new Date().toISOString();
        updated.estatusAtencion = 'ATENDIDO';
        updated.pausadoPorAsesor = false;
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
      } catch (_) {}

      // Si estaba en humanHandledChats, remover para que pueda seguir conversando
      if (activeContext.humanHandledChats.has(jid)) {
        activeContext.humanHandledChats.delete(jid);
      }
      respondidos++;

      // Pausa prudente de 4 segundos entre clientes (anti-bloqueo y naturalidad)
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      console.error(`⚠️ Error en scanner 48h con archivo ${file}:`, err.message);
    }
  }

  console.log(`✅ [SCANNER 48H FINALIZADO]: ${candidatosEncontrados.length} candidatos encontrados, ${respondidos} respondidos.`);
  return {
    ok: true,
    totalCandidatos: candidatosEncontrados.length,
    respondidos,
    candidatos: candidatosEncontrados
  };
}

/**
 * Revisa y audita todas las conversaciones del día de hoy (o últimas 24 horas).
 * Analiza quién escribió, qué solicitó, quién está pendiente de atención y genera un dictamen ejecutivo con IA.
 */
export async function revisarConversacionesDeHoy() {
  const ahora = new Date();
  const inicioDeHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0, 0).getTime();
  const hace24h = ahora.getTime() - (24 * 3600 * 1000);

  const leads = obtenerProspectos();
  const chatsHoy = [];

  for (const lead of leads) {
    const mensajes = Array.isArray(lead.mensajes) ? lead.mensajes : [];
    const msgsHoy = mensajes.filter(m => {
      const ts = m.timestampMs || (m.fecha ? new Date(m.fecha).getTime() : 0);
      return ts >= inicioDeHoy || ts >= hace24h;
    });

    if (msgsHoy.length > 0) {
      const ultimo = msgsHoy[msgsHoy.length - 1];
      const pendiente = ultimo.rol === 'Cliente' || ultimo.rol === 'Cliente (con asesor)';
      chatsHoy.push({
        id: lead.id,
        nombre: lead.nombre,
        telefono: lead.telefonoFormato,
        jid: lead.jid,
        ubicacion: lead.ubicacion || 'Por confirmar',
        tipoObra: lead.tipoObra || 'Por confirmar',
        pausado: Boolean(lead.pausadoPorAsesor),
        totalHoy: msgsHoy.length,
        ultimoRol: ultimo.rol,
        ultimoMensaje: ultimo.contenido,
        pendienteRespuesta: pendiente,
        mensajes: msgsHoy.slice(-6)
      });
    }
  }

  // Ordenar: primero los que tienen mensajes del cliente esperando respuesta
  chatsHoy.sort((a, b) => (b.pendienteRespuesta ? 1 : 0) - (a.pendienteRespuesta ? 1 : 0));

  const fechaHoyLegible = ahora.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Mexico_City'
  });

  const totalActivos = chatsHoy.length;
  const pendientes = chatsHoy.filter(c => c.pendienteRespuesta);

  let resumenTexto = `📅 *REVISIÓN EJECUTIVA DE CONVERSACIONES — ${fechaHoyLegible.toUpperCase()}*\n`;
  resumenTexto += `📊 *Actividad detectada:* ${totalActivos} prospecto(s) con mensajes recientes.\n`;
  resumenTexto += `🚨 *Pendientes de atención:* ${pendientes.length} prospecto(s) esperan respuesta.\n\n`;

  if (totalActivos === 0) {
    resumenTexto += `ℹ️ _No se han registrado mensajes nuevos el día de hoy hasta este momento. El bot está en línea y listo para recibir y contestar en cuanto escriba un cliente._`;
    return {
      ok: true,
      fecha: fechaHoyLegible,
      totalActivos: 0,
      pendientes: 0,
      resumen: resumenTexto,
      chats: []
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-3.8-flash',
        generationConfig: {
          maxOutputTokens: 900,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const detalleChats = chatsHoy.map(c => `
• Cliente: ${c.nombre} (${c.telefono}) | Ubicación: ${c.ubicacion} | Obra: ${c.tipoObra}
  Estatus: ${c.pendienteRespuesta ? '🚨 ESPERA RESPUESTA DEL ASESOR' : '✅ ATENDIDO / ÚLTIMO POR EL ASISTENTE'}
  Último mensaje (${c.ultimoRol}): "${c.ultimoMensaje}"
  Mensajes recientes:
${c.mensajes.map(m => `    [${m.rol}]: ${m.contenido}`).join('\n')}
`).join('\n');

      const promptAnalisis = `Eres "Alex", Asistente Ejecutivo de Dirección en ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}.
Hoy es ${fechaHoyLegible} (hora actual: ${ahora.toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' })}).
El Director te ha pedido revisar las conversaciones del día de hoy.

Aquí está el registro exacto de las conversaciones con actividad hoy o en las últimas 24 horas (${totalActivos} clientes):
${detalleChats}

Genera un dictamen ejecutivo claro, profesional y directo para el Director Comercial con esta estructura:
1. 📊 RESUMEN EJECUTIVO DEL DÍA (balance de prospectos activos y estado de atención).
2. 🚨 CLIENTES QUE REQUIEREN ATENCIÓN O SEGUIMIENTO HOY (quiénes se quedaron esperando respuesta y qué necesitan).
3. 🤝 CITAS, PLANOS O COMPROMISOS ACORDADOS (si hay llamadas, citas o revisiones pactadas).
4. 💡 ACCIÓN RECOMENDADA PARA EL EQUIPO COMERCIAL (1 o 2 pasos concretos para hoy).

Sé específico, menciona los nombres y teléfonos reales de los clientes analizados. Habla de "Usted", con elegancia y visión de alta gama.`;

      const aiRes = await model.generateContent(promptAnalisis);
      const dictamen = aiRes?.response?.text() || '';
      if (dictamen.trim()) {
        resumenTexto = dictamen.trim();
      }
    } catch (err) {
      console.error('Error generando dictamen de hoy con IA:', err);
    }
  }

  return {
    ok: true,
    fecha: fechaHoyLegible,
    totalActivos,
    pendientes: pendientes.length,
    resumen: resumenTexto,
    chats: chatsHoy
  };
}

/**
 * Analiza los mensajes del chat para extraer automáticamente:
 * - Ubicación, fase de obra y estatus de planos
 * - Puntuación de potencial (Lead Score 0-100) y Clasificación CRM (VIP, Alto Potencial, Seguimiento)
 * - Etapa del embudo de ventas (Metodología Alex Dey)
 */
function extraerFichaArquitectonica(mensajes, rawPhone, horasInactivo = 0, seguimiento20hEnviado = false, citaConfirmada = null) {
  const textoCompleto = (mensajes || []).map(m => m.contenido || '').join(' \n ');
  const textoLower = textoCompleto.toLowerCase();

  // Detectar si es teléfono de asesor interno
  const asesores = (process.env.TELEFONOS_ASESORES || '')
    .split(',')
    .map(n => n.trim().replace(/\D/g, ''))
    .filter(n => n.length >= 7);
  if (asesores.some(a => rawPhone.endsWith(a))) {
    return {
      ubicacion: 'Oficina / Sede Principal',
      tipoObra: 'Control Interno Asesor',
      estatusPlanos: 'Equipo Técnico',
      prioridad: 'Interno',
      score: 10,
      categoriaCRM: 'INTERNO',
      etiquetaCRM: '⚙️ Equipo Interno',
      etapaEmbudo: 'Control Operativo'
    };
  }

  let score = 25; // Base por iniciar conversación

  // 1. Detectar ubicación (+20 pts)
  let ubicacion = 'Zona por confirmar';
  const regexUbicacion = /(?:en|de|para|ubicaci[oó]n|zona|colonia|municipio|ciudad)\s+([a-záéíóúñ\s]{3,30})/i;
  const matchUbi = textoLower.match(regexUbicacion);
  if (matchUbi && matchUbi[1]) {
    ubicacion = matchUbi[1].trim();
    score += 22;
  } else if (textoLower.includes('cdmx') || textoLower.includes('ciudad')) {
    ubicacion = 'Zona Metropolitana';
    score += 20;
  }

  // 2. Detectar tipo de proyecto / servicio (+25 pts Proyecto Nuevo, +20 pts Remodelación/Mantenimiento)
  let tipoObra = 'Por confirmar';
  if (textoLower.includes('nuevo') || textoLower.includes('fabricación') || textoLower.includes('a medida') || textoLower.includes('obra')) {
    tipoObra = 'Proyecto Nuevo / A Medida';
    score += 25;
  } else if (textoLower.includes('remodelación') || textoLower.includes('renovación') || textoLower.includes('renovar') || textoLower.includes('mantenimiento')) {
    tipoObra = 'Remodelación / Renovación';
    score += 20;
  }

  // 3. Detectar estatus de planos o medidas (+25 pts)
  let estatusPlanos = 'Solicitados por IA';
  if (textoLower.includes('📄') || textoLower.includes('📷')) {
    estatusPlanos = 'Archivo / Planos Recibidos';
    score += 30;
  } else if (textoLower.includes('planos') && (textoLower.includes('si.') || textoLower.includes('sí') || textoLower.includes('más tarde') || textoLower.includes('enviar') || textoLower.includes('tengo'))) {
    estatusPlanos = 'Cuenta con Planos (Por enviar)';
    score += 25;
  } else if (textoLower.includes('no cuento con las medidas') || textoLower.includes('no tengo las medidas') || textoLower.includes('sin medidas')) {
    estatusPlanos = 'Solicita Levantamiento / Llamada';
    score += 20;
  } else if (textoLower.includes('medidas')) {
    estatusPlanos = 'Medidas Preliminares';
    score += 15;
  }

  // 4. Intención de compra / cita agendada
  const tieneCita = Boolean(citaConfirmada) ||
    textoLower.includes('confirmada su llamada') ||
    textoLower.includes('confirmada su cita') ||
    textoLower.includes('quedarían agendados');

  if (tieneCita) {
    score += 30;
  } else if (textoLower.includes('cuanto me cobrarían') || textoLower.includes('cuánto') || textoLower.includes('cotización') || textoLower.includes('cotizacion') || textoLower.includes('cita') || textoLower.includes('diseño')) {
    score += 10;
  }

  if (score > 99) score = 99;

  // 5. Clasificación CRM y Prioridad
  let categoriaCRM = 'PROSPECTO';
  let etiquetaCRM = '🌱 En Calificación Inicial';
  let prioridad = 'Media';
  let etapaEmbudo = '1. Descubrimiento de Necesidad';

  if (tieneCita) {
    categoriaCRM = 'VIP';
    etiquetaCRM = '📅 CITA AGENDADA • VIP';
    prioridad = '🔥 VIP • Cita Confirmada';
    etapaEmbudo = citaConfirmada?.resumenHorario
      ? `📅 Cita: ${citaConfirmada.resumenHorario}`
      : '📅 Cita Agendada con Arquitecto';
  } else if (score >= 80) {
    categoriaCRM = 'VIP';
    etiquetaCRM = '🔥 VIP • Muy Alto Potencial';
    prioridad = '🔥 VIP • Prioridad Máxima';
    etapaEmbudo = '3. Listo para Diseño / Cotización';
  } else if (score >= 55) {
    categoriaCRM = 'ALTO';
    etiquetaCRM = '⭐ Alto Potencial';
    prioridad = '⭐ Alta • Proyecto Calificado';
    etapaEmbudo = '2. Calificación Técnica';
  }

  if (horasInactivo >= 20 && categoriaCRM !== 'INTERNO' && !tieneCita) {
    etapaEmbudo = seguimiento20hEnviado
      ? '4. Seguimiento 20h Enviado (10 Razones)'
      : '⚠️ +20h Inactivo (Requiere 10 Razones PDF)';
  }

  return {
    ubicacion,
    tipoObra,
    estatusPlanos,
    prioridad,
    score,
    categoriaCRM,
    etiquetaCRM,
    etapaEmbudo,
    tieneCita
  };
}

/**
 * Calcula las horas de inactividad desde el último mensaje de la conversación
 */
function calcularHorasInactividad(data, fullPath) {
  try {
    if (data.ultimaActualizacionISO) {
      const diffMs = Date.now() - new Date(data.ultimaActualizacionISO).getTime();
      return Math.max(0, +(diffMs / (1000 * 60 * 60)).toFixed(1));
    }
    const mensajes = data.mensajes || [];
    const lastMsg = mensajes.length > 0 ? mensajes[mensajes.length - 1] : null;
    if (lastMsg && lastMsg.timestampMs) {
      const diffMs = Date.now() - lastMsg.timestampMs;
      return Math.max(0, +(diffMs / (1000 * 60 * 60)).toFixed(1));
    }
    const stat = fs.statSync(fullPath);
    const diffMs = Date.now() - stat.mtimeMs;
    return Math.max(0, +(diffMs / (1000 * 60 * 60)).toFixed(1));
  } catch {
    return 0;
  }
}

/**
 * Obtiene todos los prospectos filtrando canales de spam (@newsletter) y grupos (@g.us)
 * y ordenándolos automáticamente por Importancia / Potencial (VIP primero)
 */
export function obtenerProspectos() {
  if (!fs.existsSync(LOGS_DIR)) return [];

  const pausedDisk = leerChatsPausadosDisco();
  const citasAgendadas = leerCitasAgendadas();
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const leads = [];

  for (const file of files) {
    try {
      const fullPath = path.join(LOGS_DIR, file);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const jid = data?.contacto?.jid || '';

      // Ignorar canales (@newsletter) y grupos (@g.us)
      if (jid.endsWith('@newsletter') || jid.endsWith('@g.us')) continue;

      const id = file.replace('.json', '');
      const mensajes = data.mensajes || [];
      const ultimoMsgObj = mensajes.length > 0 ? mensajes[mensajes.length - 1] : null;

      const isPaused =
        Boolean(data.pausadoPorAsesor) ||
        pausedDisk.has(jid) ||
        activeContext.humanHandledChats.has(jid);

      const rawPhone = (data.contacto?.telefono || jid.replace(/@.*$/, '')).replace(/\D/g, '');
      const horasInactivo = calcularHorasInactividad(data, fullPath);
      const seguimiento20hEnviado = Boolean(data.seguimiento20hEnviado);
      const citaGuardada = data.citaGoogleCalendar || citasAgendadas.find(c => c.jid === jid || (rawPhone && c.telefonoLimpio === rawPhone)) || null;
      const ficha = extraerFichaArquitectonica(mensajes, rawPhone, horasInactivo, seguimiento20hEnviado, citaGuardada);

      const nombreContacto = data.contacto?.nombre || 'Prospecto WhatsApp';
      const telefonoFormato = data.contacto?.telefonoFormato || data.contacto?.telefono || rawPhone;
      const googleCalendarUrl = citaGuardada?.googleCalendarUrl || generarUrlGoogleCalendar({
        nombre: nombreContacto,
        telefonoFormato,
        telefonoLimpio: rawPhone,
        ubicacion: ficha.ubicacion,
        tipoObra: ficha.tipoObra,
        notas: ultimoMsgObj ? ultimoMsgObj.contenido : ''
      });

      // Determinar estatus de atención del cliente: 'ATENDIDO' o 'NO_ATENDIDO'
      const asesorRespondio = mensajes.some(m => (m.rol || '').toLowerCase().includes('asesor') || (m.rol || '').toLowerCase().includes('humano'));
      const estatusAtencion = data.estatusAtencion || ((isPaused || asesorRespondio) ? 'ATENDIDO' : 'NO_ATENDIDO');

      const ultimaActividadMs = ultimoMsgObj?.timestampMs
        || (data.ultimaActualizacionISO ? new Date(data.ultimaActualizacionISO).getTime() : 0)
        || fs.statSync(fullPath).mtimeMs;

      leads.push({
        id,
        jid,
        nombre: nombreContacto,
        telefonoLimpio: rawPhone,
        telefonoFormato,
        fechaInicio: data.fechaInicio || '',
        ultimaActualizacion: data.ultimaActualizacion || '',
        ultimaActividadMs,
        horasInactivo,
        inactivoMasDe20h: horasInactivo >= 20 && ficha.categoriaCRM !== 'INTERNO',
        seguimiento20hEnviado,
        totalMensajes: mensajes.length,
        pausadoPorAsesor: isPaused,
        estatusAtencion,
        ultimoMensaje: ultimoMsgObj ? ultimoMsgObj.contenido : 'Sin mensajes',
        ubicacion: ficha.ubicacion,
        tipoObra: ficha.tipoObra,
        estatusPlanos: ficha.estatusPlanos,
        prioridad: ficha.prioridad,
        score: ficha.score,
        categoriaCRM: ficha.categoriaCRM,
        etiquetaCRM: ficha.etiquetaCRM,
        etapaEmbudo: ficha.etapaEmbudo,
        tieneCita: ficha.tieneCita,
        citaGoogleCalendar: citaGuardada,
        googleCalendarUrl,
        mensajes,
        fullPath
      });
    } catch (e) {
      // Ignorar archivo corrupto
    }
  }

  // Ordenar por defecto: Los clientes más potenciales/importantes (mayor score) primero
  leads.sort((a, b) => b.score - a.score);

  return leads;
}

/**
 * Envía el seguimiento estratégico de +20 horas de inactividad usando la Metodología Alex Dey
 * y adjuntando el PDF "10 Razones por las cuales realizar su proyecto con ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}"
 */
export async function enviarSeguimiento20Horas10Razones(leadId) {
  try {
    const jsonPath = path.join(LOGS_DIR, `${leadId}.json`);
    if (!fs.existsSync(jsonPath)) {
      return { ok: false, error: 'Prospecto no encontrado' };
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const jid = data?.contacto?.jid;
    const nombre = data?.contacto?.nombre || 'Cliente';
    const pdfPath = path.join(PUBLIC_DIR, 'Brochure_Informativo.pdf');
    const existePdf = fs.existsSync(pdfPath);

    // Mensaje de Reactivación Estratégica con Metodología Comercial (Valor + Doble Alternativa)
    const textoAlexDey = `¡Hola, *${nombre}*! Le saluda nuevamente el equipo de **${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}**. ✨\n\nEsperamos que se encuentre excelente. Le comparto este brochure informativo con información clave sobre nuestros servicios y garantías. 📋✨\n\nPara orientarle a detalle y resolver cualquier duda: **¿le resulta más cómodo una breve llamada hoy por la tarde, o prefiere que coordinemos para mañana por la mañana? 🤝**`;

    const sock = activeContext.getSock ? activeContext.getSock() : null;
    let enviadoWhatsApp = false;

    if (sock && jid) {
      if (existePdf) {
        const sentDoc = await sock.sendMessage(jid, {
          document: fs.readFileSync(pdfPath),
          mimetype: 'application/pdf',
          fileName: 'Brochure_Informativo.pdf',
          caption: textoAlexDey
        });
        if (activeContext.trackBotMessage) activeContext.trackBotMessage(sentDoc);
      } else {
        const sentTxt = await sock.sendMessage(jid, { text: textoAlexDey });
        if (activeContext.trackBotMessage) activeContext.trackBotMessage(sentTxt);
      }
      enviadoWhatsApp = true;
    }

    // Marcar como enviado en el JSON y registrar en historial
    data.seguimiento20hEnviado = true;
    data.fechaSeguimiento20h = new Date().toISOString();
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    const contactInfo = {
      senderJid: jid,
      displayName: nombre,
      displayPhone: data.contacto?.telefonoFormato || data.contacto?.telefono || '',
      phone: data.contacto?.telefono || ''
    };
    const etiquetaHistorial = existePdf
      ? `[SEGUIMIENTO +20H • PDF 10 RAZONES ADJUNTO]\n${textoAlexDey}`
      : `[SEGUIMIENTO +20H • 10 RAZONES ALEX DEY]\n${textoAlexDey}`;

    await registrarMensajeEnHistorial(contactInfo, 'Alex de ventas', etiquetaHistorial);

    return { ok: true, enviadoWhatsApp, conPdf: existePdf };
  } catch (err) {
    console.error('⚠️ Error enviando seguimiento 20h:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Revisa periódicamente los prospectos que superan las 20 horas de inactividad.
 * Si el archivo public/Brochure_Informativo.pdf ya fue cargado, se lo envía automáticamente.
 */
export async function verificarInactividad20Horas() {
  try {
    // 🛡️ Si el bot está en pausa global, no enviar seguimientos automáticos
    if (!leerEstadoBotGlobalDisco()) return;

    const pdfPath = path.join(PUBLIC_DIR, 'Brochure_Informativo.pdf');
    if (!fs.existsSync(pdfPath)) return; // Espera a que el usuario proporcione el PDF oficial para el auto-envío

    const leads = obtenerProspectos();
    for (const lead of leads) {
      if (
        lead.inactivoMasDe20h &&
        !lead.seguimiento20hEnviado &&
        !lead.pausadoPorAsesor &&
        lead.categoriaCRM !== 'INTERNO'
      ) {
        console.log(`⏰ [SEGUIMIENTO AUTOMÁTICO +20H] Enviando PDF "Brochure Informativo" a ${lead.nombre} (${lead.telefonoFormato})...`);
        await enviarSeguimiento20Horas10Razones(lead.id);
      }
    }
  } catch (err) {
    console.error('⚠️ Error en verificación de 20h:', err.message);
  }
}

const DIRECTRICES_FILE = path.resolve('./conversaciones_guardadas/_directrices_director.json');
const COPILOT_CHAT_FILE = path.resolve('./conversaciones_guardadas/_chat_copiloto.json');
const TRASH_DIR = path.resolve('./conversaciones_guardadas/_eliminados');

export function leerDirectricesDisco() {
  try {
    if (fs.existsSync(DIRECTRICES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DIRECTRICES_FILE, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch {}
  return [];
}

export function guardarDirectricesDisco(arr) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(DIRECTRICES_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch {}
}

function leerChatCopilotoDisco() {
  try {
    if (fs.existsSync(COPILOT_CHAT_FILE)) {
      const arr = JSON.parse(fs.readFileSync(COPILOT_CHAT_FILE, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch {}
  return [
    {
      rol: 'bot',
      fecha: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      texto: '¡Hola! Soy **Alex, tu Copiloto de Ventas IA de Centro de Control CRM**. 🤖🏛️\n\nAquí puedes hablar directamente conmigo para:\n1️⃣ **Ordenarme que le escriba o le pregunte algo por WhatsApp a cualquier cliente** (ej. *"Pregúntale a Josue en qué municipio está su proyecto y si quiere cita mañana a las 5 pm"*).\n2️⃣ **Darme nuevas instrucciones o modificaciones directas** sobre cómo debo atender y cerrar ventas.\n3️⃣ **Pedirme un resumen** de quiénes faltan por atender o quién tiene cita agendada.'
    }
  ];
}

function guardarChatCopilotoDisco(arr) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(COPILOT_CHAT_FILE, JSON.stringify(arr.slice(-40), null, 2), 'utf8');
  } catch {}
}

// ============================================================================
// SEGURIDAD Y CONTROL DE ACCESO P0 (AUTENTICACIÓN CON CONTRASEÑA Y SESIONES)
// ============================================================================
const SESSIONS_FILE = path.resolve('./conversaciones_guardadas/_sesiones_activas.json');

function leerSesionesDisco() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function guardarSesionesDisco(sesiones) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sesiones, null, 2), 'utf8');
  } catch (err) {
    console.error('Error al guardar sesiones:', err.message);
  }
}

function esSesionValida(req) {
  try {
    let token = null;
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/crm_session=([a-f0-9]+)/i);
      if (match) token = match[1];
    }
    if (!token && req.headers['x-crm-token']) {
      token = req.headers['x-crm-token'];
    }
    if (!token && req.headers.authorization) {
      const matchAuth = req.headers.authorization.match(/^Bearer\s+([a-f0-9]+)$/i);
      if (matchAuth) token = matchAuth[1];
    }

    if (!token) return false;

    const sesiones = leerSesionesDisco();
    const data = sesiones[token];
    if (!data) return false;

    if (new Date(data.expira).getTime() < Date.now()) {
      delete sesiones[token];
      guardarSesionesDisco(sesiones);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function generarHtmlLogin() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Acceso Seguro • ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #07090E; color: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .gold-border { border-color: rgba(212, 175, 55, 0.35); }
    .gold-gradient { background: linear-gradient(135deg, #D4AF37 0%, #AA8010 100%); }
    .gold-text { color: #E5C158; }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="max-w-sm w-full bg-[#0D121F] border gold-border rounded-3xl p-7 shadow-2xl space-y-6 text-center backdrop-blur-xl">
    <div class="space-y-2">
      <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10 border gold-border text-2xl shadow-inner">
        👑
      </div>
      <h1 class="text-lg font-bold text-white tracking-wide">${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}</h1>
      <p class="text-[11px] text-gray-400 uppercase tracking-widest font-semibold gold-text">Centro de Control & CRM</p>
    </div>

    <form id="login-form" onsubmit="handleLogin(event)" class="space-y-4 text-left">
      <div>
        <label class="block text-xs font-semibold text-gray-300 mb-1.5">Contraseña de Acceso:</label>
        <div class="relative">
          <input
            type="password"
            id="password-input"
            required
            autofocus
            placeholder="Introduce la contraseña"
            class="w-full bg-[#070A10] border border-gray-700 focus:border-yellow-500 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 outline-none transition"
          />
          <button type="button" onclick="togglePassVisibility()" class="absolute right-3 top-3 text-gray-400 hover:text-white text-sm cursor-pointer">
            👁️
          </button>
        </div>
      </div>

      <div id="error-box" class="hidden text-xs text-red-400 bg-red-950/60 border border-red-500/40 rounded-xl p-2.5 text-center font-medium"></div>

      <button
        type="submit"
        id="submit-btn"
        class="w-full gold-gradient hover:opacity-95 text-gray-950 font-bold py-3 px-4 rounded-xl text-sm transition shadow-lg shadow-yellow-500/20 flex items-center justify-center gap-2 cursor-pointer"
      >
        <span>🔒</span> <span id="btn-text">Entrar al CRM</span>
      </button>
    </form>

    <div class="pt-2 border-t border-gray-800/80 text-[11px] text-gray-500 flex items-center justify-center gap-1.5">
      <span>🛡️</span> <span>Acceso Restringido y Supervisado</span>
    </div>
  </div>

  <script>
    function togglePassVisibility() {
      const input = document.getElementById('password-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    async function handleLogin(e) {
      e.preventDefault();
      const input = document.getElementById('password-input');
      const errBox = document.getElementById('error-box');
      const btnText = document.getElementById('btn-text');
      const btn = document.getElementById('submit-btn');

      errBox.classList.add('hidden');
      btn.disabled = true;
      btnText.textContent = 'Verificando...';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value })
        });
        const data = await res.json();
        if (data.ok) {
          btnText.textContent = '¡Bienvenido!';
          window.location.reload();
        } else {
          errBox.textContent = data.error || 'Contraseña incorrecta';
          errBox.classList.remove('hidden');
          input.value = '';
          input.focus();
        }
      } catch (err) {
        errBox.textContent = 'Error de conexión: ' + err.message;
        errBox.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        if (btnText.textContent === 'Verificando...') btnText.textContent = 'Entrar al CRM';
      }
    }
  </script>
</body>
</html>`;
}

/**
 * Inicia el servidor web / API de la aplicación Centro de Control CRM
 */
export function iniciarServidorCRM(context = {}) {
  activeContext = { ...activeContext, ...context };
  const listenPort = context.port || PORT;
  const isTestMode = Boolean(context.testMode);

  if (!isTestMode) {
    // El envío de las 10 Razones se realiza bajo demanda desde el Panel CRM o cuando el bot argumenta en la conversación
    // Se desactiva el auto-disparo ciego en bucle para no enviar mensajes inesperados a prospectos históricos
    // setInterval(verificarInactividad20Horas, 15 * 60 * 1000);
  }

  // Sincronizar chats pausados previos desde disco
  const initialPaused = leerChatsPausadosDisco();
  for (const jid of initialPaused) {
    activeContext.humanHandledChats.add(jid);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // --- ENDPOINT PÚBLICO 0A: Iniciar Sesión con Contraseña ---
      if (req.method === 'POST' && url.pathname === '/api/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { password } = JSON.parse(body || '{}');
            const CRM_PASS = process.env.CRM_PASSWORD || 'Admin_2026_Secure';
            if (password === CRM_PASS) {
              const token = crypto.randomBytes(24).toString('hex');
              const sesiones = leerSesionesDisco();
              const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
              sesiones[token] = {
                creado: new Date().toISOString(),
                expira,
                ip: req.socket.remoteAddress || '',
                userAgent: req.headers['user-agent'] || ''
              };
              guardarSesionesDisco(sesiones);

              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Set-Cookie': `crm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
              });
              return res.end(JSON.stringify({ ok: true, token }));
            } else {
              await new Promise(r => setTimeout(r, 600));
              res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify({ ok: false, error: 'Contraseña de acceso incorrecta' }));
            }
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // --- ENDPOINT PÚBLICO 0B: Cerrar Sesión ---
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const cookieHeader = req.headers.cookie || '';
        const match = cookieHeader.match(/crm_session=([a-f0-9]+)/i);
        if (match) {
          const sesiones = leerSesionesDisco();
          delete sesiones[match[1]];
          guardarSesionesDisco(sesiones);
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'crm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      // --- ENDPOINT PÚBLICO 0C: Estado de Autenticación ---
      if (req.method === 'GET' && url.pathname === '/api/auth-status') {
        const auth = esSesionValida(req);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, authenticated: auth }));
      }

      // --- ENDPOINT PÚBLICO 0D: Entregables y Catálogos en PDF (Acceso libre para clientes en WhatsApp) ---
      const esPdfPublico = url.pathname === '/Brochure_Informativo.pdf' ||
                           url.pathname === '/catalogo-piedra-sinterizada.pdf' ||
                           url.pathname === '/catalogo.pdf' ||
                           url.pathname === '/Catalogo_Servicios.pdf';
      if (req.method === 'GET' && esPdfPublico) {
        const targetPdf = url.pathname.includes('10_Razones')
          ? 'Brochure_Informativo.pdf'
          : 'Catalogo_Servicios.pdf';
        const pdfFile = path.join(PUBLIC_DIR, targetPdf);
        if (fs.existsSync(pdfFile)) {
          const stat = fs.statSync(pdfFile);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': stat.size,
            'Content-Disposition': `inline; filename="${targetPdf}"`,
            'Cache-Control': 'public, max-age=86400'
          });
          return fs.createReadStream(pdfFile).pipe(res);
        }
      }

      // --- BARRERA DE SEGURIDAD P0: Proteger todo el CRM y la API ---
      const estaAutenticado = esSesionValida(req);
      const tieneClaveValidaUrl = url.searchParams.get('key') === 'Admin_2026_Secure' || url.searchParams.get('clave') === 'Admin_2026_Secure';
      const esDescargaDirectaAutorizada = (url.pathname === '/descargar-bot' || url.pathname === '/crm_bot_starter.zip' || url.pathname === '/api/descargar-laptop') && tieneClaveValidaUrl;
      const esRutaPublica = url.pathname === '/manifest.json' || url.pathname === '/api/login' || url.pathname === '/api/auth-status' || esDescargaDirectaAutorizada;

      if (!estaAutenticado && !esRutaPublica) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'No autorizado. Se requiere inicio de sesión con contraseña en ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}.',
            code: 'AUTH_REQUIRED'
          }));
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(generarHtmlLogin());
      }

      // --- DESCARGA DEL PAQUETE PORTÁTIL PARA LAPTOP (ZIP) ---
      if (req.method === 'GET' && (url.pathname === '/descargar-bot' || url.pathname === '/crm_bot_starter.zip' || url.pathname === '/api/descargar-laptop')) {
        const zipPath = path.join(PUBLIC_DIR, 'crm_bot_starter.zip');
        if (!fs.existsSync(zipPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Archivo crm_bot_starter.zip no encontrado. Genere el paquete primero.');
        }

        const stat = fs.statSync(zipPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="crm_bot_starter.zip"',
          'Content-Length': stat.size
        });
        const stream = fs.createReadStream(zipPath);
        return stream.pipe(res);
      }

      // --- ENDPOINT 1: Obtener lista de prospectos y conversaciones ---
      if (req.method === 'GET' && url.pathname === '/api/leads') {
        const leads = obtenerProspectos();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ leads }));
      }

      // --- ENDPOINT GLOBAL 1: Consultar Estado Global del Bot ---
      if (req.method === 'GET' && url.pathname === '/api/bot-global-status') {
        const activo = leerEstadoBotGlobalDisco();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, activo }));
      }

      // --- ENDPOINT GLOBAL 2: Pausar o Reactivar el Bot Globalmente (Master Switch) ---
      if (req.method === 'POST' && url.pathname === '/api/bot-global-status') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const activo = typeof payload.activo === 'boolean' ? payload.activo : true;
          const motivo = payload.motivo || (activo ? 'Reactivado desde panel' : 'Pausado globalmente desde panel');
          guardarEstadoBotGlobalDisco(activo, motivo);
          console.log(`\n🛑 [MASTER SWITCH]: ${activo ? '🟢 BOT ACTIVADO GLOBALMENTE' : '⏸️ BOT PAUSADO GLOBALMENTE (SILENCIO TOTAL)'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, activo, motivo }));
        });
        return;
      }

      // --- ENDPOINT GLOBAL 3: Consultar Estado de Conexión y QR de WhatsApp ---
      if (req.method === 'GET' && url.pathname === '/api/whatsapp-status') {
        const sock = activeContext.getSock ? activeContext.getSock() : null;
        const qr = activeContext.getQr ? activeContext.getQr() : null;
        const status = activeContext.getConnectionStatus ? activeContext.getConnectionStatus() : 'connecting';
        const isConnected = !!(sock && sock.user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          connected: isConnected,
          status: isConnected ? 'open' : status,
          user: sock?.user || null,
          qr: isConnected ? null : qr
        }));
      }

      // --- ENDPOINT GLOBAL 3A: Vista Dedicada de Pantalla Completa del Código QR (/qr) ---
      if (req.method === 'GET' && (url.pathname === '/qr' || url.pathname === '/vincular')) {
        const qr = activeContext.getQr ? activeContext.getQr() : null;
        const sock = activeContext.getSock ? activeContext.getSock() : null;
        const isConnected = !!(sock && sock.user);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vincular WhatsApp • ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <meta http-equiv="refresh" content="6">
  <style>
    body { background-color: #0b0f19; color: #f3f4f6; font-family: system-ui, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-gray-900 border border-yellow-500/40 rounded-3xl p-6 text-center shadow-2xl space-y-5">
    <div class="flex items-center justify-center gap-2 text-yellow-400 font-bold text-lg">
      <span>👑</span> <span>${process.env.NOMBRE_NEGOCIO || "Tu Empresa"} CRM</span>
    </div>
    <h1 class="text-xl font-bold text-white">Vincular Dispositivo WhatsApp</h1>
    ${isConnected ? `
      <div class="bg-emerald-950/80 border border-emerald-500 rounded-2xl p-6 space-y-2">
        <div class="text-4xl">✅</div>
        <div class="text-emerald-300 font-bold text-lg">¡WhatsApp Conectado!</div>
        <p class="text-xs text-gray-400">El bot y el panel ya están sincronizados correctamente.</p>
        <a href="/" class="inline-block mt-4 px-5 py-2.5 bg-yellow-500 hover:bg-yellow-400 text-gray-950 font-bold rounded-xl text-sm transition">
          Ir al Panel CRM
        </a>
      </div>
    ` : qr ? `
      <div class="bg-white p-4 rounded-2xl inline-block shadow-inner">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}" alt="QR WhatsApp" class="w-64 h-64 mx-auto rounded-lg">
      </div>
      <div class="space-y-2 text-left bg-gray-800/80 p-4 rounded-xl text-xs text-gray-300">
        <p class="font-bold text-yellow-400 text-sm">📲 Pasos en tu celular:</p>
        <p>1. Abre <strong>WhatsApp</strong> en tu teléfono.</p>
        <p>2. Ve a <strong>Ajustes / Configuración</strong> (o los 3 puntos arriba a la derecha).</p>
        <p>3. Toca <strong>Dispositivos vinculados</strong>.</p>
        <p>4. Toca <strong>Vincular un dispositivo</strong> y apunta tu cámara a este código QR.</p>
      </div>
      <p class="text-[11px] text-gray-500">Esta pantalla se actualiza automáticamente cada 6 segundos.</p>
      <a href="/" class="inline-block text-xs text-gray-400 hover:text-white underline">Volver al panel principal</a>
    ` : `
      <div class="py-12 space-y-4">
        <div class="animate-spin text-4xl">⏳</div>
        <p class="text-sm text-gray-300">Generando código de conexión con WhatsApp...</p>
        <p class="text-xs text-gray-500">Un momento por favor...</p>
      </div>
    `}
  </div>
</body>
</html>`);
      }

      // --- ENDPOINT GLOBAL 3B: Solicitar Código de Vinculación Numérico (Pairing Code) ---
      if (req.method === 'POST' && url.pathname === '/api/request-pairing-code') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { phone, usePrefix1 } = JSON.parse(body || '{}');
            let cleanPhone = (phone || '').replace(/\D/g, '');
            if (!cleanPhone || cleanPhone.length < 10) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Por favor ingresa un número de teléfono válido a 10 dígitos.' }));
            }
            const sock = activeContext.getSock ? activeContext.getSock() : null;
            if (!sock) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'El servicio del bot no está iniciado todavía.' }));
            }

            // Normalización de número telefónico:
            // Para México, la mayoría de cuentas WhatsApp actuales usan '52' + 10 dígitos (ej: 527299665714).
            // Si el usuario especificó usePrefix1 o venía con 521, se puede probar con 521.
            let localDigits = cleanPhone;
            if (localDigits.startsWith('521') && localDigits.length === 13) {
              localDigits = localDigits.slice(3);
            } else if (localDigits.startsWith('52') && localDigits.length === 12) {
              localDigits = localDigits.slice(2);
            }

            // Si usePrefix1 es true, usamos 521, de lo contrario el estándar mexicano 52 + 10 dígitos
            const fullPhone = usePrefix1 ? `521${localDigits}` : `52${localDigits}`;

            console.log(`\n📲 Solicitando Pairing Code a WhatsApp para: ${fullPhone}...`);
            const pairingCode = await sock.requestPairingCode(fullPhone);
            console.log(`\n🔑 [CÓDIGO DE VINCULACIÓN GENERADO]: ${pairingCode} para ${fullPhone}\n`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: true, code: pairingCode, phone: fullPhone }));
          } catch (err) {
            console.error('Error al solicitar pairing code:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // --- ENDPOINT GLOBAL 4: Escaneo y seguimiento de chats recientes (<= 48 horas) ---
      if (req.method === 'POST' && url.pathname === '/api/scan-recent-48h') {
        const resultado = await escanearChatsRecientes48H(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resultado));
      }

      // --- ENDPOINT GLOBAL 4B: Revisión y auditoría de conversaciones de hoy ---
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/revisar-hoy') {
        const resultado = await revisarConversacionesDeHoy();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(resultado));
      }

      // --- ENDPOINT 2: Pausar o Reactivar el Bot para un cliente ---
      if (req.method === 'POST' && url.pathname === '/api/toggle-bot') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const { id, jid, pausar } = payload;
          const pausedSet = leerChatsPausadosDisco();

          if (pausar) {
            if (jid) {
              pausedSet.add(jid);
              activeContext.humanHandledChats.add(jid);
            }
          } else {
            if (jid) {
              pausedSet.delete(jid);
              activeContext.humanHandledChats.delete(jid);
            }
          }
          guardarChatsPausadosDisco(pausedSet);

          // Actualizar también el archivo JSON del cliente
          if (id) {
            const jsonPath = path.join(LOGS_DIR, `${id}.json`);
            if (fs.existsSync(jsonPath)) {
              try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                data.pausadoPorAsesor = Boolean(pausar);
                fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
              } catch (e) {}
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pausado: Boolean(pausar) }));
        });
        return;
      }

      // --- ENDPOINT 2B: Cambiar Estatus del Cliente (ATENDIDO / NO_ATENDIDO) ---
      if (req.method === 'POST' && url.pathname === '/api/update-lead-status') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const { id, estatusAtencion } = payload;
          if (!id || !estatusAtencion) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Faltan parámetros id o estatusAtencion' }));
          }
          const jsonPath = path.join(LOGS_DIR, `${id}.json`);
          if (fs.existsSync(jsonPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
              data.estatusAtencion = estatusAtencion;
              fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
            } catch (e) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id, estatusAtencion }));
        });
        return;
      }

      // --- ENDPOINT 2C: Eliminar Cliente del CRM (mueve a _eliminados de forma segura) ---
      if (req.method === 'POST' && url.pathname === '/api/delete-lead') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const { id } = payload;
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'ID requerido' }));
          }
          if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true });

          const jsonPath = path.join(LOGS_DIR, `${id}.json`);
          const txtPath = path.join(LOGS_DIR, `${id}.txt`);

          if (fs.existsSync(jsonPath)) {
            fs.renameSync(jsonPath, path.join(TRASH_DIR, `${Date.now()}_${id}.json`));
          }
          if (fs.existsSync(txtPath)) {
            fs.renameSync(txtPath, path.join(TRASH_DIR, `${Date.now()}_${id}.txt`));
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deletedId: id }));
        });
        return;
      }

      // --- ENDPOINT 3: Enviar mensaje como Asesor Humano desde la App ---
      if (req.method === 'POST' && url.pathname === '/api/send-message') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const { id, jid, telefono, mensaje } = payload;
          if (!mensaje) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Mensaje vacío' }));
          }

          // 1. Pausar automáticamente el bot para este cliente
          const pausedSet = leerChatsPausadosDisco();
          if (jid) {
            pausedSet.add(jid);
            activeContext.humanHandledChats.add(jid);
          }
          guardarChatsPausadosDisco(pausedSet);

          // 2. Si el socket de WhatsApp está activo en este proceso, enviar por WhatsApp
          const sock = activeContext.getSock ? activeContext.getSock() : null;
          let sentViaWhatsApp = false;
          if (sock && jid) {
            try {
              const sent = await sock.sendMessage(jid, { text: mensaje });
              if (activeContext.trackBotMessage) activeContext.trackBotMessage(sent);
              sentViaWhatsApp = true;
            } catch (err) {
              console.error('Error enviando por socket:', err.message);
            }
          }

          // 3. Registrar en el archivo del cliente y marcar como ATENDIDO
          const jsonPath = path.join(LOGS_DIR, `${id}.json`);
          if (fs.existsSync(jsonPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
              data.pausadoPorAsesor = true;
              data.estatusAtencion = 'ATENDIDO';
              fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
              const contactInfo = {
                senderJid: data.contacto?.jid || jid,
                displayName: data.contacto?.nombre || 'Prospecto',
                displayPhone: data.contacto?.telefonoFormato || telefono,
                phone: data.contacto?.telefono || telefono
              };
              await registrarMensajeEnHistorial(contactInfo, 'Asesor Humano (App)', mensaje);
            } catch (e) {}
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sentViaWhatsApp }));
        });
        return;
      }

      // --- ENDPOINT 3B: Chat Directo con el Bot (Copiloto IA de Ventas) ---
      if (req.method === 'GET' && url.pathname === '/api/bot-copilot') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          history: leerChatCopilotoDisco(),
          directrices: leerDirectricesDisco()
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/bot-copilot') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            let payload = {};
            try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
            const message = payload.prompt || payload.message;
            const targetLeadId = payload.targetLeadId;

            if (!message) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Mensaje o prompt vacío' }));
            }

            const chatHistory = leerChatCopilotoDisco();
            const horaStr = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            chatHistory.push({ rol: 'user', fecha: horaStr, texto: message });

            const leads = obtenerProspectos();
            const directrices = leerDirectricesDisco();
            const selectedLead = targetLeadId ? leads.find(l => l.id === targetLeadId) : null;

            const resumenCartera = leads.slice(0, 20).map(l =>
              `• ID: "${l.id}" | Nombre: ${l.nombre} | Tel: ${l.telefonoFormato} | Estatus: ${l.estatusAtencion} | Ubicación: ${l.ubicacion} | Obra: ${l.tipoObra} | Score: ${l.score}% | Último msg: "${(l.ultimoMensaje || '').slice(0, 90)}"`
            ).join('\n');

            const detalleSeleccionado = selectedLead
              ? `\nCLIENTE SELECCIONADO EN EL SELECTOR:\nID: "${selectedLead.id}", Nombre: ${selectedLead.nombre}, Tel: ${selectedLead.telefonoFormato}, JID: ${selectedLead.jid}\nHistorial reciente:\n${(selectedLead.mensajes || []).slice(-6).map(m => `[${m.rol}]: ${m.contenido}`).join('\n')}\n`
              : '';

            // Detección determinista inmediata si el Director ordena pausar, detener o reactivar el bot
            // (se usan límites de palabra para que "desactiva" o "inactivos" NO activen el bot por error)
            const msgLower = (message || '').toLowerCase();
            let accionRealizada = null;

            const esOrdenPausa =
              /\b(pausa|pausar|p[aá]usalo|det[eé]n|detente|detener|apaga|apagar|stop|desactiva|desactivar|desact[ií]valo|silencia|silenciar)\b/.test(msgLower) ||
              msgLower.includes('no mandes mensajes') ||
              msgLower.includes('deja de mandar');

            const esOrdenActivar = !esOrdenPausa &&
              /\b(activa|activar|act[ií]valo|reanuda|reanudar|enciende|encender)\b/.test(msgLower);

            const esOrdenEscanear = !esOrdenPausa && !esOrdenActivar && (
              /\b(escanea|escanear|escan[eé]a)\b/.test(msgLower) ||
              msgLower.includes('últimos 2 días') ||
              msgLower.includes('ultimos 2 dias') ||
              msgLower.includes('48 horas')
            );

            const esOrdenRevisarHoy = !esOrdenPausa && !esOrdenActivar && !esOrdenEscanear && (
              /\b(revisa|revisar|revisi[oó]n|audita|auditar)\b/.test(msgLower) ||
              msgLower.includes('conversaciones de hoy') ||
              msgLower.includes('conversaciones del d') ||
              msgLower.includes('chats de hoy') ||
              msgLower.includes('mensajes de hoy') ||
              msgLower.includes('reporte de hoy') ||
              msgLower.includes('resumen de hoy') ||
              msgLower.includes('quién escribió') ||
              msgLower.includes('quien escribio')
            );

            let resultadoEscaneo = null;
            let resultadoRevisionHoy = null;

            if (esOrdenPausa) {
              guardarEstadoBotGlobalDisco(false, 'Orden del Director en Copiloto');
              accionRealizada = '🛑 Bot pausado globalmente en todos los chats';
            } else if (esOrdenActivar) {
              guardarEstadoBotGlobalDisco(true, 'Orden del Director en Copiloto');
              accionRealizada = '🟢 Bot reactivado globalmente';
            } else if (esOrdenEscanear) {
              resultadoEscaneo = await escanearChatsRecientes48H();
              accionRealizada = resultadoEscaneo?.ok
                ? `🔍 Escaneo 48h completado: ${resultadoEscaneo.totalCandidatos || 0} evaluados, ${resultadoEscaneo.respondidos || 0} respondidos`
                : `⚠️ Escaneo no realizado: ${resultadoEscaneo?.motivo || 'error'}`;
            } else if (esOrdenRevisarHoy) {
              resultadoRevisionHoy = await revisarConversacionesDeHoy();
              accionRealizada = `📋 Revisión de hoy completada: ${resultadoRevisionHoy.totalActivos} prospectos evaluados (${resultadoRevisionHoy.pendientes} pendientes)`;
            }

            const apiKey = process.env.GEMINI_API_KEY;
            let respuestaBot = esOrdenPausa
              ? 'Entendido Director. He pausado el bot por completo en todos los chats. Ningún mensaje automático será enviado por WhatsApp hasta que usted me dé la orden de reactivarlo.'
              : esOrdenActivar
              ? 'Entendido Director. El bot vuelve a estar activo globalmente para responder a nuevos mensajes en tiempo real.'
              : esOrdenEscanear
              ? (resultadoEscaneo?.ok
                ? `Con gusto Director. Revisé los prospectos de las últimas 48 horas: localicé ${resultadoEscaneo.totalCandidatos || 0} que esperaban respuesta y envié ${resultadoEscaneo.respondidos || 0} mensajes de seguimiento.`
                : `No pude realizar el escaneo: ${resultadoEscaneo?.motivo || 'error desconocido'}. Si el bot está pausado, actívelo primero.`)
              : esOrdenRevisarHoy
              ? (resultadoRevisionHoy?.resumen || 'Revisión del día procesada.')
              : 'Entendido. He procesado tu instrucción.';

            if (apiKey && !accionRealizada) {
              const { GoogleGenerativeAI } = await import('@google/generative-ai');
              const genAI = new GoogleGenerativeAI(apiKey);
              const model = genAI.getGenerativeModel({
                model: 'gemini-3.8-flash',
                generationConfig: {
                  maxOutputTokens: 700,
                  temperature: 0.2,
                  responseMimeType: 'application/json',
                  thinkingConfig: { thinkingBudget: 0 }
                }
              });

              const promptCopiloto = `Eres "Alex de ventas", el Copiloto IA de Ventas y Asistente Ejecutivo del Director de **Centro de Control CRM (${process.env.NOMBRE_NEGOCIO || "Tu Empresa"})**.
El Director Comercial está hablando contigo desde la pestaña "Hablar con el Bot" dentro del Centro de Control CRM.

CARTERA ACTUAL DE CLIENTES EN EL CRM (${leads.length} total):
${resumenCartera}
${detalleSeleccionado}

REGLAS / DIRECTRICES ACTIVAS QUE TE HA DADO EL DIRECTOR:
${directrices.length > 0 ? directrices.map((d, i) => `${i + 1}. ${d.regla}`).join('\n') : '(Ninguna regla adicional aún)'}

HISTORIAL RECIENTE DE TU CHARLA CON EL DIRECTOR:
${chatHistory.slice(-6).map(c => `${c.rol === 'user' ? 'Director' : 'Alex Bot'}: ${c.texto}`).join('\n')}

INSTRUCCIÓN ACTUAL DEL DIRECTOR:
"${message}"

Analiza lo que pide el Director y devuelve EXCLUSIVAMENTE un objeto JSON válido con esta estructura exacta:
{
  "respuestaAlDirector": "Tu respuesta clara, ejecutiva y útil para el Director (confirma si enviaste un mensaje por WhatsApp, si guardaste una nueva regla de ventas, si pausaste el bot o responde su consulta sobre la cartera).",
  "controlBotGlobal": {
    "activar": false,
    "nuevoEstado": false
  },
  "enviarWhatsAppACliente": {
    "activar": false,
    "leadId": "ID exacto del cliente de la lista si el Director pidió escribirle o preguntarle algo a un cliente por WhatsApp",
    "mensajeWhatsApp": "El texto exacto, formal (de Usted) y persuasivo como Alex de ventas de ${process.env.NOMBRE_NEGOCIO || "Tu Empresa"} que se enviará por WhatsApp al cliente"
  },
  "guardarNuevaDirectriz": {
    "activar": false,
    "regla": "Si el Director te dio una orden general o modificación de cómo debes atender o preguntar cosas en el futuro, redacta aquí la regla clara en 1 línea"
  },
  "cambiarEstatusCliente": {
    "activar": false,
    "leadId": "ID exacto del cliente",
    "nuevoEstatus": "ATENDIDO o NO_ATENDIDO"
  }
}`;

              const result = await model.generateContent(promptCopiloto);
              const parsed = JSON.parse(result.response.text());
              respuestaBot = parsed.respuestaAlDirector || respuestaBot;

              // 0. ¿Pidió pausar o reactivar el bot globalmente?
              if (parsed.controlBotGlobal?.activar) {
                const nuevoEstado = Boolean(parsed.controlBotGlobal.nuevoEstado);
                guardarEstadoBotGlobalDisco(nuevoEstado, 'Orden de Copiloto IA');
                accionRealizada = nuevoEstado ? '🟢 Bot activado globalmente' : '🛑 Bot pausado globalmente en todos los chats';
              }

              // 1. ¿Pidió enviar un mensaje por WhatsApp a un cliente? (Guarda de Seguridad P0.3)
              if (parsed.enviarWhatsAppACliente?.activar && parsed.enviarWhatsAppACliente?.mensajeWhatsApp) {
                const targetId = parsed.enviarWhatsAppACliente.leadId || targetLeadId;
                const leadObj = leads.find(l => l.id === targetId) ||
                  leads.find(l => l.nombre.toLowerCase().includes((targetId || '').toLowerCase()));

                if (leadObj && leadObj.jid) {
                  const textoWA = parsed.enviarWhatsAppACliente.mensajeWhatsApp;
                  if (!payload.confirmado) {
                    // Propuesta que requiere confirmación explícita
                    accionRealizada = `⚠️ Propuesta de mensaje para ${leadObj.nombre} generada (Requiere su confirmación antes de enviar)`;
                    respuestaBot += `\n\n📌 *PROPUESTA DE ENVÍO PARA ${leadObj.nombre.toUpperCase()}:*\n"${textoWA}"\n\n_Para enviarlo, pulse el botón de confirmación o responda "Confirmar envío"._`;
                  } else {
                    // Solo si el usuario confirmó explícitamente
                    const sock = activeContext.getSock ? activeContext.getSock() : null;
                    if (sock) {
                      const sent = await sock.sendMessage(leadObj.jid, { text: textoWA });
                      if (activeContext.trackBotMessage) activeContext.trackBotMessage(sent);
                    }
                    const contactInfo = {
                      senderJid: leadObj.jid,
                      displayName: leadObj.nombre,
                      displayPhone: leadObj.telefonoFormato,
                      phone: leadObj.telefonoLimpio
                    };
                    await registrarMensajeEnHistorial(contactInfo, 'Alex de ventas', textoWA);
                    accionRealizada = `📤 Mensaje confirmado y enviado por WhatsApp a ${leadObj.nombre}`;
                  }
                }
              }

              // 2. ¿Pidió guardar una nueva regla o modificación de comportamiento del bot?
              if (parsed.guardarNuevaDirectriz?.activar && parsed.guardarNuevaDirectriz?.regla) {
                const nuevas = leerDirectricesDisco();
                nuevas.push({
                  regla: parsed.guardarNuevaDirectriz.regla,
                  fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })
                });
                guardarDirectricesDisco(nuevas);
                accionRealizada = `🧠 Nueva directriz guardada en la memoria del Bot`;
              }

              // 3. ¿Pidió cambiar el estatus de un cliente?
              if (parsed.cambiarEstatusCliente?.activar && parsed.cambiarEstatusCliente?.leadId) {
                const jsonPath = path.join(LOGS_DIR, `${parsed.cambiarEstatusCliente.leadId}.json`);
                if (fs.existsSync(jsonPath)) {
                  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                  data.estatusAtencion = parsed.cambiarEstatusCliente.nuevoEstatus || 'ATENDIDO';
                  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
                  accionRealizada = `✅ Estatus actualizado a ${data.estatusAtencion}`;
                }
              }
            }

            chatHistory.push({
              rol: 'bot',
              fecha: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
              texto: respuestaBot,
              accion: accionRealizada
            });
            guardarChatCopilotoDisco(chatHistory);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              ok: true,
              reply: respuestaBot,
              accion: accionRealizada,
              accionRealizada: accionRealizada,
              history: chatHistory,
              directrices: leerDirectricesDisco()
            }));
          } catch (err) {
            console.error('Error en /api/bot-copilot:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // --- ENDPOINT 3C: Eliminar una directriz del bot ---
      if (req.method === 'POST' && url.pathname === '/api/delete-bot-rule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
          const { index } = payload;
          const rules = leerDirectricesDisco();
          if (typeof index === 'number' && index >= 0 && index < rules.length) {
            rules.splice(index, 1);
            guardarDirectricesDisco(rules);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, directrices: rules }));
        });
        return;
      }

      // --- ENDPOINT 4: Obtener el último reporte ejecutivo generado ---
      if (req.method === 'GET' && url.pathname === '/api/latest-report') {
        if (!fs.existsSync(REPORTS_DIR)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ filename: '', content: 'No hay reportes aún.' }));
        }
        const txtReports = fs.readdirSync(REPORTS_DIR)
          .filter(f => f.endsWith('.txt'))
          .sort()
          .reverse();

        if (txtReports.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ filename: '', content: 'No hay reportes generados todavía.' }));
        }

        const latest = txtReports[0];
        const content = fs.readFileSync(path.join(REPORTS_DIR, latest), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ filename: latest, content }));
      }

      // --- ENDPOINT 5: Generar y enviar nuevo reporte ejecutivo bajo demanda ---
      if (req.method === 'POST' && url.pathname === '/api/generate-report') {
        const result = await ejecutarReporteDiario();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, result }));
      }

      // --- ENDPOINT 6: Información de red local y mundial (4G/5G) para instalar en celular ---
      if (req.method === 'GET' && url.pathname === '/api/server-info') {
        const ip = getLocalIpAddress();
        const pdfPath = path.join(PUBLIC_DIR, 'Brochure_Informativo.pdf');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ip,
          port: PORT,
          lanUrl: `http://${ip}:${PORT}`,
          globalUrl: obtenerUrlGlobalApp(),
          pdf10RazonesListo: fs.existsSync(pdfPath)
        }));
      }

      // --- ENDPOINT 7: Enviar Seguimiento 20h ("10 Razones PDF" + Cierre Alex Dey) ---
      if (req.method === 'POST' && url.pathname === '/api/send-10-razones') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          const { id } = JSON.parse(body || '{}');
          const resEnvio = await enviarSeguimiento20Horas10Razones(id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(resEnvio));
        });
        return;
      }

      // --- ENDPOINT 8: Enviar Archivos Multimedia desde el CRM (Fotos, Planos, PDF, Audio) ---
      if (req.method === 'POST' && url.pathname === '/api/send-media') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { leadId, jid, mediaType, base64Data, mimeType, fileName, caption } = JSON.parse(body || '{}');
            if (!jid || !base64Data) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Faltan parámetros obligatorios (jid o base64Data).' }));
            }

            const sock = activeContext.getSock ? activeContext.getSock() : null;
            if (!sock) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'WhatsApp no está conectado todavía.' }));
            }

            const buffer = Buffer.from(base64Data, 'base64');
            const ext = fileName ? path.extname(fileName) : (mediaType === 'image' ? '.jpg' : mediaType === 'audio' ? '.ogg' : '.pdf');
            const safeName = `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
            const diskPath = path.join(MEDIA_DIR, safeName);
            fs.writeFileSync(diskPath, buffer);

            const mediaUrl = `/media/${safeName}`;

            // Envío por WhatsApp a través del socket de Baileys
            let sentMessage = null;
            if (mediaType === 'image') {
              sentMessage = await sock.sendMessage(jid, {
                image: buffer,
                caption: caption || ''
              });
            } else if (mediaType === 'audio') {
              sentMessage = await sock.sendMessage(jid, {
                audio: buffer,
                mimetype: mimeType || 'audio/mp4',
                ptt: true
              });
            } else {
              sentMessage = await sock.sendMessage(jid, {
                document: buffer,
                mimetype: mimeType || 'application/pdf',
                fileName: fileName || 'Documento_Informativo.pdf',
                caption: caption || ''
              });
            }

            if (activeContext.trackBotMessage && sentMessage) {
              activeContext.trackBotMessage(sentMessage);
            }

            // Registrar en el expediente del cliente
            const leads = obtenerProspectos();
            const lead = leads.find(l => l.id === leadId || l.jid === jid);
            const contactInfo = {
              senderJid: jid,
              displayName: lead?.nombre || 'Prospecto',
              displayPhone: lead?.telefonoFormato || '',
              phone: lead?.telefonoLimpio || ''
            };

            const mediaMeta = {
              type: mediaType || 'document',
              url: mediaUrl,
              mimeType: mimeType || 'application/octet-stream',
              fileName: fileName || safeName
            };

            const textContent = caption ? `${caption} (📎 Adjunto)` : `📎 [Adjunto ${mediaType}: ${fileName || safeName}]`;
            await registrarMensajeEnHistorial(contactInfo, 'Asesor Humano (App)', textContent, mediaMeta);

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: true, mediaUrl, fileName: safeName }));
          } catch (err) {
            console.error('Error al enviar archivo multimedia:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // --- SERVIR ARCHIVOS MULTIMEDIA ALMACENADOS (/media/*) ---
      if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
        const safeFile = path.basename(url.pathname);
        const filePath = path.join(MEDIA_DIR, safeFile);
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.ogg': 'audio/ogg',
            '.mp3': 'audio/mpeg',
            '.m4a': 'audio/mp4',
            '.mp4': 'video/mp4',
            '.pdf': 'application/pdf'
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'private, max-age=86400'
          });
          const stream = fs.createReadStream(filePath);
          return stream.pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Archivo multimedia no encontrado' }));
        }
      }

      // --- ARCHIVOS ESTÁTICOS DE LA APP (PWA Y ENTREGABLES PDF) ---
      if (req.method === 'GET' && url.pathname === '/manifest.json') {
        const manifest = fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(manifest);
      }

      // Servir Catálogo de Piedra Sinterizada y Entregable PDF de forma pública y directa
      if (req.method === 'GET' && (
        url.pathname === '/catalogo-piedra-sinterizada.pdf' ||
        url.pathname === '/catalogo.pdf' ||
        url.pathname === '/Catalogo_Servicios.pdf' ||
        url.pathname === '/Brochure_Informativo.pdf'
      )) {
        const targetPdf = url.pathname.includes('10_Razones')
          ? 'Brochure_Informativo.pdf'
          : 'Catalogo_Servicios.pdf';
        const pdfFile = path.join(PUBLIC_DIR, targetPdf);
        if (fs.existsSync(pdfFile)) {
          const stat = fs.statSync(pdfFile);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': stat.size,
            'Content-Disposition': `inline; filename="${targetPdf}"`,
            'Cache-Control': 'public, max-age=86400'
          });
          return fs.createReadStream(pdfFile).pipe(res);
        }
      }

      // Servir index.html por defecto
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`📱 [APP CRM] El servidor CRM ya se encuentra activo en http://localhost:${PORT}`);
    } else {
      console.error('⚠️ Error en servidor CRM:', err.message);
    }
  });

  server.listen(listenPort, '0.0.0.0', () => {
    const ip = getLocalIpAddress();
    if (!isTestMode) {
      console.log('\n================================================================================');
      console.log('📱 ¡APP MÓVIL Y CENTRO DE CONTROL CRM ACTIVO!');
      console.log(`💻 En esta computadora (Chrome): http://localhost:${listenPort}`);
      console.log(`📲 En su celular (vía Wi-Fi):     http://${ip}:${listenPort}`);
      console.log('🌎 Activando enlace mundial 4G/5G para acceso desde cualquier lugar...');
      console.log('================================================================================\n');
      iniciarTunelGlobal();

      // Abrir automáticamente el navegador en la pantalla del CRM
      try {
        spawn('cmd.exe', ['/c', 'start', `http://localhost:${listenPort}`], { detached: true, stdio: 'ignore' }).unref();
      } catch (_) {}
    }
  });

  return server;
}

// Permitir ejecución directa
if (process.argv[1]?.endsWith('app_crm.js')) {
  iniciarServidorCRM();
}
