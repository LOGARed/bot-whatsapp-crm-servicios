import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { generateAIResponse, extraerYAgendarCitaGoogleCalendar, classifyLead } from './ai_agent.js';
import { leerCitasAgendadas } from './google_calendar.js';
import { registrarMensajeEnHistorial, mostrarEnPantalla } from './historial_conversaciones.js';
import { iniciarServidorCRM, leerChatsPausadosDisco, guardarChatsPausadosDisco, obtenerUrlGlobalApp, leerEstadoBotGlobalDisco } from './app_crm.js';
import { atenderConsultaDirectorWhatsApp } from './agente_copiloto_director.js';

dotenv.config();

// Marca de tiempo exacta del inicio del bot para ignorar cualquier mensaje viejo de WhatsApp
const BOT_START_TIME_SEC = Math.floor(Date.now() / 1000);

// Lista de números de asesores a notificar cuando hay un nuevo prospecto calificado, cita agendada o solicitud de humano
// Se leen automáticamente desde process.env.TELEFONOS_ASESORES (ej. "5500000001,5500000002")
const ASESORES_TELEFONOS = (process.env.TELEFONOS_ASESORES || '')
  .split(',')
  .map(n => n.trim().replace(/\D/g, ''))
  .filter(n => n.length >= 7);

// Directorio para almacenamiento de multimedia (fotos, audios, planos)
const MEDIA_DIR = path.resolve('./conversaciones_guardadas/media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Registro de chats transferidos o tomados por asesores humanos (el bot se detiene por completo en estos chats)
const humanHandledChats = leerChatsPausadosDisco();
let currentSock = null;
let currentQr = null;
let connectionStatus = 'connecting';

// Registro de IDs de mensajes enviados por el bot para distinguirlos de los mensajes escritos por un humano en el celular/WhatsApp Web
const botSentMessageIds = new Set();

function trackBotMessage(sentMsg) {
  if (sentMsg?.key?.id) {
    botSentMessageIds.add(sentMsg.key.id);
    if (botSentMessageIds.size > 3000) {
      const first = botSentMessageIds.values().next().value;
      botSentMessageIds.delete(first);
    }
  }
}

// Temporizadores de seguimiento por inactividad (15 minutos en horario comercial diurno, silenciado de noche)
const followupTimers = new Map();
const followupSent = new Set();
const FOLLOWUP_DELAY_MS = 15 * 60 * 1000; // 15 minutos (evita presionar al cliente a los 5 minutos)

// Caché de información de contactos (nombre, teléfono real, LID)
const contactCache = new Map();

function formatToJid(phone) {
  const clean = phone.replace(/\D/g, '');
  if (clean.startsWith('52') && clean.length >= 12) {
    return `${clean}@s.whatsapp.net`;
  }
  return `521${clean}@s.whatsapp.net`;
}

/**
 * Envía una alerta por WhatsApp a los 3 asesores comerciales (resuelve tanto @s.whatsapp.net como @lid)
 */
async function enviarAlertaAAsesores(sock, leadInfo) {
  if (!sock || !leadInfo) return;
  for (const asesorPhone of ASESORES_TELEFONOS) {
    try {
      const jidStandard = formatToJid(asesorPhone);
      const sentAlert = await sock.sendMessage(jidStandard, { text: leadInfo });
      trackBotMessage(sentAlert);
      console.log(`📲 [ALERTA ENVIADA A ASESOR]: ${asesorPhone}`);
    } catch (err) {
      console.error(`⚠️ Error al enviar alerta al asesor [${asesorPhone}]:`, err.message);
    }
  }
}

/**
 * Resuelve de forma robusta el número telefónico real y el nombre del cliente,
 * solucionando la privacidad de WhatsApp cuando el remitente llega como un LID (@lid).
 */
async function resolveContactInfo(sock, senderJid, pushName = '') {
  const cached = contactCache.get(senderJid);
  if (cached && cached.phone && (!pushName || cached.displayName === pushName)) {
    return cached;
  }

  let rawPhone = '';
  let isLid = false;

  if (senderJid.endsWith('@lid')) {
    isLid = true;
    const lidUser = senderJid.replace(/@.*$/, '');

    // 1. Intentar resolver mediante el repositorio de señales nativo de Baileys
    try {
      if (sock?.signalRepository?.lidMapping?.getPNForLID) {
        const pnJid = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
        if (pnJid) {
          rawPhone = pnJid.replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '');
        }
      }
    } catch (e) {
      // Ignorar y pasar al siguiente método
    }

    // 2. Si no se resolvió, buscar en los archivos de mapeo inverso de la sesión local
    if (!rawPhone) {
      try {
        const reverseFilePath = path.join('./auth_session', `lid-mapping-${lidUser}_reverse.json`);
        if (fs.existsSync(reverseFilePath)) {
          const content = JSON.parse(fs.readFileSync(reverseFilePath, 'utf8'));
          if (content && typeof content === 'string') {
            rawPhone = content.replace(/\D/g, '');
          }
        }
      } catch (e) {
        // Ignorar
      }
    }

    // Si aún no se resolvió, conservar el identificador de usuario
    if (!rawPhone) {
      rawPhone = lidUser;
    }
  } else {
    // Es un @s.whatsapp.net tradicional
    rawPhone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
  }

  // Normalizar y formatear el número para México y enlaces wa.me
  let cleanPhone = rawPhone;
  let waMePhone = rawPhone;
  let displayPhone = rawPhone;

  // Si es un número mexicano de 13 dígitos con 521 (ej: 5215540518993)
  if (cleanPhone.startsWith('521') && cleanPhone.length === 13) {
    const local = cleanPhone.slice(3); // 10 dígitos (ej: 5540518993)
    waMePhone = `52${local}`;
    displayPhone = `+52 ${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`;
  } else if (cleanPhone.startsWith('52') && cleanPhone.length === 12) {
    const local = cleanPhone.slice(2);
    waMePhone = `52${local}`;
    displayPhone = `+52 ${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`;
  } else if (cleanPhone.length === 10) {
    waMePhone = `52${cleanPhone}`;
    displayPhone = `+52 ${cleanPhone.slice(0, 2)} ${cleanPhone.slice(2, 6)} ${cleanPhone.slice(6)}`;
  }

  const displayName = pushName && pushName.trim() ? pushName.trim() : (cached?.displayName || 'Prospecto WhatsApp');
  const waLink = `https://wa.me/${waMePhone}`;

  const info = {
    senderJid,
    isLid,
    phone: waMePhone,
    displayPhone,
    displayName,
    waLink
  };

  contactCache.set(senderJid, info);
  return info;
}

// Rate Limiter: Protección contra ataques de spam y agotamiento de crédito (máximo 12 mensajes/min por remitente)
const rateLimits = new Map();

function checkRateLimit(senderJid) {
  const now = Date.now();
  const limit = rateLimits.get(senderJid) || { count: 0, firstMsgTime: now };

  if (now - limit.firstMsgTime > 60000) {
    limit.count = 1;
    limit.firstMsgTime = now;
    rateLimits.set(senderJid, limit);
    return true;
  }

  limit.count += 1;
  rateLimits.set(senderJid, limit);

  if (limit.count > 12) {
    console.log(`🛡️ [SEGURIDAD] Rate limit excedido para [${senderJid}]. Mensaje ignorado para proteger saldo y CPU.`);
    return false;
  }
  return true;
}

// Cola de mensajes pendientes por remitente para consolidar textos seguidos
const pendingTimeouts = new Map();
const messageBuffers = new Map();
const mediaBuffers = new Map();
const lastMessageKeyMap = new Map();

async function connectToWhatsApp() {
  // Guarda la sesión en la carpeta local "auth_session" para no volver a pedir QR
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

  let version = [2, 3000, 1043857760];
  try {
    const vInfo = await fetchLatestBaileysVersion();
    if (vInfo?.version) version = vInfo.version;
  } catch (_) {}

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // Silenciar logs técnicos
    printQRInTerminal: false,
    syncFullHistory: false, // BLINDAJE: NO sincronizar historial antiguo para no contestar mensajes pasados
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: true
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = qr;
      connectionStatus = 'qr_ready';
      console.log('\n============================================================');
      console.log('📌 ESCANEA ESTE CÓDIGO QR EN WHATSAPP (Dispositivos vinculados):');
      console.log('============================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      connectionStatus = 'close';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isRevoked = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden || statusCode === 403 || statusCode === 401;
      const shouldReconnect = !isRevoked;
      console.log('⚠️ Conexión cerrada. Código:', statusCode, '¿Reintentando reconectar?:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('\n============================================================');
        console.log('❌ [SESIÓN REVOCADA / FORBIDDEN 403]:');
        console.log('WhatsApp cerró la sesión anterior por duplicidad de conexión.');
        try {
          if (fs.existsSync('./auth_session')) {
            fs.rmSync('./auth_session', { recursive: true, force: true });
            console.log('🔄 Sesión anterior limpiada automáticamente.');
          }
        } catch (e) {}
        console.log('👉 Para reconectar: ejecuta "RECONECTAR_QR.bat" o vuelve a iniciar');
        console.log('   y escanea el nuevo código QR desde tu celular.');
        console.log('============================================================\n');
      }
    } else if (connection === 'open') {
      currentQr = null;
      connectionStatus = 'open';
      console.log('\n================================================================================');
      console.log('✅ ¡BOT CONECTADO EXITOSAMENTE A WHATSAPP!');
      console.log(`🤖 Agente: "${process.env.NOMBRE_BOT || 'Asistente de Ventas'}" • ${process.env.NOMBRE_NEGOCIO || 'Tu Empresa'}`);
      console.log(`📞 Asesores vinculados para alertas directas: ${ASESORES_TELEFONOS.join(', ')}`);
      console.log('🛑 Detección automática de asesor: ACTIVA (El bot se pausa al escribir un humano)');
      console.log('🛡️ Blindaje contra chats antiguos: ACTIVO (Solo atiende mensajes nuevos en tiempo real)');
      console.log('💾 Módulo de guardado de conversaciones activo en: ./conversaciones_guardadas/');
      console.log('================================================================================\n');

      // 🔒 AUTO-BROADCAST DESACTIVADO: El bot atiende exclusivamente mensajes entrantes en tiempo real
      // y no realiza envíos masivos automáticos a chats históricos.
    }
  });

  // Registro para no procesar dos veces el mismo ID de mensaje
  const processedMsgIds = new Set();

  // Sincronización de historial reciente (recupera mensajes no leídos y recientes de hoy/ayer que llegaron mientras el bot estaba fuera de línea)
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return;
      console.log(`📥 [HISTORIAL RECIBIDO]: Analizando ${messages.length} mensajes sincronizados de WhatsApp...`);

      const ahoraSec = Math.floor(Date.now() / 1000);
      const VENTANA_48H_SEC = 48 * 3600;
      let syncCount = 0;

      for (const msg of messages) {
        if (!msg.message || !msg.key?.id) continue;
        const senderJid = msg.key.remoteJid;
        if (!senderJid || senderJid === 'status@broadcast' || senderJid.includes('@broadcast') || senderJid.endsWith('@newsletter') || senderJid.endsWith('@g.us')) continue;

        const msgTimestampSec = Number(msg.messageTimestamp || 0);
        if (msgTimestampSec > 0 && (ahoraSec - msgTimestampSec) > VENTANA_48H_SEC) {
          continue;
        }

        const innerMsg =
          msg.message.ephemeralMessage?.message ||
          msg.message.viewOnceMessage?.message ||
          msg.message.viewOnceMessageV2?.message ||
          msg.message;

        const messageText =
          innerMsg.conversation ||
          innerMsg.extendedTextMessage?.text ||
          innerMsg.templateButtonReplyMessage?.selectedDisplayText ||
          innerMsg.buttonsResponseMessage?.selectedDisplayText ||
          innerMsg.listResponseMessage?.title ||
          (innerMsg.imageMessage ? (innerMsg.imageMessage.caption || '📷 [Fotografía adjunta]') :
           innerMsg.videoMessage ? (innerMsg.videoMessage.caption || '🎥 [Video adjunto]') :
           innerMsg.audioMessage ? '🎙️ [Nota de voz]' :
           innerMsg.documentMessage ? '📄 [Documento / Plano]' :
           '');

        if (!messageText.trim()) continue;

        const pushName = msg.pushName || '';
        const contactInfo = await resolveContactInfo(sock, senderJid, pushName);
        const rol = msg.key.fromMe ? (botSentMessageIds.has(msg.key.id) ? 'Alex de ventas' : 'Asesor Humano') : 'Cliente';
        const msgMs = msgTimestampSec > 0 ? (msgTimestampSec * 1000) : Date.now();

        await registrarMensajeEnHistorial(contactInfo, rol, messageText.trim(), null, msgMs);
        syncCount++;
      }

      if (syncCount > 0) {
        console.log(`✅ [HISTORIAL 48H]: Se sincronizaron exitosamente ${syncCount} mensajes recientes en el CRM.`);
      }
    } catch (err) {
      console.error('⚠️ Error al procesar messaging-history.set:', err.message);
    }
  });

  // Procesamiento de mensajes entrantes estrictamente en tiempo real
  sock.ev.on('messages.upsert', async (event) => {
    try {
      // 0. Si el bot está en pausa global desde el Panel de Control, ignorar
      if (!leerEstadoBotGlobalDisco()) {
        return;
      }

      const { messages, type } = event;

      for (const msg of messages) {
        if (!msg.message || !msg.key?.id) continue;
        if (processedMsgIds.has(msg.key.id)) continue;
        processedMsgIds.add(msg.key.id);

        const senderJid = msg.key.remoteJid;
        if (!senderJid || senderJid === 'status@broadcast' || senderJid.includes('@broadcast') || senderJid.endsWith('@newsletter') || senderJid.endsWith('@g.us')) continue;

        // Ignorar mensajes internos de protocolo / reacciones / sincronización de llaves de WhatsApp
        if (
          msg.message.protocolMessage ||
          msg.message.reactionMessage ||
          msg.message.senderKeyDistributionMessage ||
          msg.message.keepInChatMessage ||
          msg.message.pollUpdateMessage
        ) {
          continue;
        }

        // 🛡️ BLINDAJE DE MENSAJES Y SINCRONIZACIÓN DE HOY:
        // Mensajes de más de 48 horas se ignoran por completo (historial antiguo).
        // Mensajes recientes de hoy (incluso sincronizados vía 'append' al reconectar) se registran en el CRM.
        const msgTimestampSec = Number(msg.messageTimestamp || 0);
        const ahoraSec = Math.floor(Date.now() / 1000);
        const edadSegundos = msgTimestampSec > 0 ? (ahoraSec - msgTimestampSec) : 0;

        if (msgTimestampSec > 0 && edadSegundos > (48 * 3600)) {
          continue;
        }

        // Es mensaje fresco para respuesta automática si llegó en vivo ('notify') o hace menos de 5 minutos
        const esMensajeFresco = type === 'notify' || edadSegundos < 300;

        // Extraer texto o descripción del mensaje (incluyendo respuestas a botones / anuncios de Meta)
        const innerMsg =
          msg.message.ephemeralMessage?.message ||
          msg.message.viewOnceMessage?.message ||
          msg.message.viewOnceMessageV2?.message ||
          msg.message;

        const messageText =
          innerMsg.conversation ||
          innerMsg.extendedTextMessage?.text ||
          innerMsg.templateButtonReplyMessage?.selectedDisplayText ||
          innerMsg.buttonsResponseMessage?.selectedDisplayText ||
          innerMsg.listResponseMessage?.title ||
          (innerMsg.imageMessage ? (innerMsg.imageMessage.caption || '📷 [Fotografía adjunta]') :
           innerMsg.videoMessage ? (innerMsg.videoMessage.caption || '🎥 [Video adjunto]') :
           innerMsg.audioMessage ? '🎙️ [Nota de voz]' :
           innerMsg.documentMessage ? '📄 [Documento / Plano]' :
           '');

        // Si no hay contenido real (ni texto ni multimedia reconocida), ignorar
        if (!messageText.trim()) continue;

        const pushName = msg.pushName || '';
        // Resolver datos de contacto primero (desencriptar @lid para conocer el número real)
        const contactInfo = await resolveContactInfo(sock, senderJid, pushName);

        // Descarga activa de multimedia si el mensaje incluye nota de voz, foto o plano/documento
        let mediaAttachment = null;
        if (innerMsg.audioMessage) {
          try {
            console.log(`🎙️ [MULTIMODAL] Descargando nota de voz de ${contactInfo.displayName}...`);
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
              }
            );
            if (buffer && buffer.length > 0) {
              const rawMime = innerMsg.audioMessage.mimetype || 'audio/ogg';
              const cleanMime = rawMime.split(';')[0].trim() || 'audio/ogg';
              const ext = cleanMime.includes('mp4') || cleanMime.includes('m4a') ? 'm4a' : 'ogg';
              const fileName = `audio_${Date.now()}_${msg.key.id.replace(/\W/g, '').slice(0, 8)}.${ext}`;
              const filePath = path.join(MEDIA_DIR, fileName);
              fs.writeFileSync(filePath, buffer);

              mediaAttachment = {
                type: 'audio',
                url: `/media/${fileName}`,
                fileName,
                data: buffer.toString('base64'),
                mimeType: cleanMime
              };
              console.log(`🎙️ [MULTIMODAL] Nota de voz guardada en: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
            }
          } catch (err) {
            console.error('⚠️ Error al descargar nota de voz:', err.message);
          }
        } else if (innerMsg.imageMessage) {
          try {
            console.log(`📸 [MULTIMODAL] Descargando fotografía/plano de ${contactInfo.displayName}...`);
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
              }
            );
            if (buffer && buffer.length > 0) {
              const rawMime = innerMsg.imageMessage.mimetype || 'image/jpeg';
              const cleanMime = rawMime.split(';')[0].trim() || 'image/jpeg';
              const ext = cleanMime.includes('png') ? 'png' : 'jpg';
              const fileName = `foto_${Date.now()}_${msg.key.id.replace(/\W/g, '').slice(0, 8)}.${ext}`;
              const filePath = path.join(MEDIA_DIR, fileName);
              fs.writeFileSync(filePath, buffer);

              mediaAttachment = {
                type: 'image',
                url: `/media/${fileName}`,
                fileName,
                data: buffer.toString('base64'),
                mimeType: cleanMime
              };
              console.log(`📸 [MULTIMODAL] Fotografía guardada en: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
            }
          } catch (err) {
            console.error('⚠️ Error al descargar fotografía:', err.message);
          }
        } else if (innerMsg.documentMessage) {
          try {
            console.log(`📄 [MULTIMODAL] Descargando documento/plano de ${contactInfo.displayName}...`);
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
              }
            );
            if (buffer && buffer.length > 0) {
              const rawMime = innerMsg.documentMessage.mimetype || 'application/pdf';
              const cleanMime = rawMime.split(';')[0].trim() || 'application/pdf';
              const origName = innerMsg.documentMessage.fileName || 'plano.pdf';
              const ext = path.extname(origName) || '.pdf';
              const fileName = `doc_${Date.now()}_${msg.key.id.replace(/\W/g, '').slice(0, 8)}${ext}`;
              const filePath = path.join(MEDIA_DIR, fileName);
              fs.writeFileSync(filePath, buffer);

              mediaAttachment = {
                type: 'document',
                url: `/media/${fileName}`,
                fileName: origName,
                data: buffer.toString('base64'),
                mimeType: cleanMime
              };
              console.log(`📄 [MULTIMODAL] Documento guardado en: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
            }
          } catch (err) {
            console.error('⚠️ Error al descargar documento:', err.message);
          }
        }

        if (mediaAttachment) {
          mediaBuffers.set(senderJid, mediaAttachment);
        }
        lastMessageKeyMap.set(senderJid, msg.key);

        // ============================================================================
        // 1. DETECCIÓN AUTOMÁTICA DE INTERVENCIÓN HUMANA (fromMe = true)
        // ============================================================================
        // Si el mensaje fue enviado desde nuestra cuenta (celular o WhatsApp Web):
        if (msg.key.fromMe) {
          // Si el mensaje NO fue generado por el código del bot, ¡LO ESCRIBIÓ UN HUMANO!
          if (!botSentMessageIds.has(msg.key.id)) {
            const targetJid = senderJid;
            const cleanText = messageText.trim();

            // Comando especial de reactivación por parte del asesor
            if (cleanText.toLowerCase() === '#reactivar' || cleanText.toLowerCase() === '#bot') {
              humanHandledChats.delete(targetJid);
              guardarChatsPausadosDisco(humanHandledChats);
              const sentReactivate = await sock.sendMessage(targetJid, { text: '🤖 _El Asistente Virtual ha sido reactivado para este chat._' });
              trackBotMessage(sentReactivate);
              console.log(`\n🔄 [BOT REACTIVADO] Asesor reactivó al bot para: ${contactInfo.displayName} (${contactInfo.displayPhone})`);
              continue;
            }

            // Si es un mensaje normal del asesor hacia el cliente:
            // 🛑 Pausar inmediatamente el bot en este chat
            humanHandledChats.add(targetJid);
            guardarChatsPausadosDisco(humanHandledChats);

            // Cancelar cualquier respuesta que el bot estuviera procesando
            if (pendingTimeouts.has(targetJid)) {
              clearTimeout(pendingTimeouts.get(targetJid));
              pendingTimeouts.delete(targetJid);
            }
            messageBuffers.delete(targetJid);

            // Cancelar seguimiento de inactividad
            if (followupTimers.has(targetJid)) {
              clearTimeout(followupTimers.get(targetJid));
              followupTimers.delete(targetJid);
            }

            console.log(`\n┌─────────────────────────────────────────────────────────────────────────────┐`);
            console.log(`│ 👨‍💼 [ASESOR HUMANO EN CONTROL] Un asesor respondió a:`);
            console.log(`│ 👤 Cliente: ${contactInfo.displayName} (${contactInfo.displayPhone})`);
            console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);
            console.log(`  "${cleanText}"`);
            console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);
            console.log(`│ 🛑 EL BOT SE HA DETENIDO AUTOMÁTICAMENTE PARA ESTA CONVERSACIÓN.           │`);
            console.log(`│ 💡 (Si en el futuro desea que el bot vuelva a atenderlo, escriba: #reactivar)│`);
            console.log(`└─────────────────────────────────────────────────────────────────────────────┘\n`);

            await registrarMensajeEnHistorial(contactInfo, 'Asesor Humano', cleanText, mediaAttachment);
          }
          continue;
        }

        // ============================================================================
        // 2. ATENCIÓN AL DIRECTOR / ASESORES (COPILOTO EJECUTIVO EN TIEMPO REAL)
        // ============================================================================
        const resolvedPhoneDigits = (contactInfo.phone || senderJid.replace(/@.*$/, '')).replace(/\D/g, '').replace(/^521/, '52').replace(/^52/, '');
        const isFromAdvisor = ASESORES_TELEFONOS.some(a => resolvedPhoneDigits.endsWith(a) || a.endsWith(resolvedPhoneDigits));

        if (isFromAdvisor) {
          console.log(`\n👑 [COPILOTO DIRECTIVO]: Mensaje recibido de ${contactInfo.displayName} (${resolvedPhoneDigits}): "${messageText.trim()}"`);

          try {
            if (typeof sock.presenceSubscribe === 'function') {
              await sock.presenceSubscribe(senderJid);
            }
            await sock.sendPresenceUpdate('composing', senderJid);

            const respuestaDirector = await atenderConsultaDirectorWhatsApp({
              senderJid,
              senderPhone: resolvedPhoneDigits,
              messageText: messageText.trim(),
              contactInfo,
              sock,
              humanHandledChats,
              trackBotMessage
            });

            await sock.sendPresenceUpdate('paused', senderJid);
            const sentCopilotMsg = await sock.sendMessage(senderJid, { text: respuestaDirector });
            trackBotMessage(sentCopilotMsg);
            await registrarMensajeEnHistorial(contactInfo, 'Alex (Copiloto Director)', respuestaDirector);
          } catch (errCopilot) {
            console.error('⚠️ Error respondiendo al Director por WhatsApp:', errCopilot.message);
          }
          continue; // Termina aquí: nunca tratar al asesor/director como cliente
        }

        // 🛡️ Blindaje de Ciberseguridad: Rate Limit por usuario (máximo 12 msgs/min)
        if (!checkRateLimit(senderJid)) continue;

        // Sanitización: limitar longitud máxima del mensaje a 600 caracteres para evitar inyecciones o saturar tokens
        const cleanMessage = messageText.trim().slice(0, 600);

        // ============================================================================
        // 3. SI EL CHAT ESTÁ EN MANOS DE UN ASESOR HUMANO -> BOT SILENCIOSO
        // ============================================================================
        if (humanHandledChats.has(senderJid)) {
          // Permite reactivar si el cliente escribe explícitamente #reactivar o #bot
          if (cleanMessage.toLowerCase() === '#reactivar' || cleanMessage.toLowerCase() === '#bot') {
            humanHandledChats.delete(senderJid);
            const sentReactivated = await sock.sendMessage(senderJid, { text: '🤖 _El Asistente Virtual ha sido reactivado para este chat._' });
            trackBotMessage(sentReactivated);
            console.log(`🔄 Bot reactivado para [${contactInfo.displayName} - ${contactInfo.displayPhone}]`);
          } else {
            // Guardar lo que el cliente escribe para mantener el historial completo en disco
            await registrarMensajeEnHistorial(contactInfo, 'Cliente (con asesor)', cleanMessage, mediaAttachment);
          }
          // El bot NO responde, deja que el asesor humano hable sin interrupciones
          continue;
        }

        // Cancelar temporizador de seguimiento por inactividad si el cliente respondió
        if (followupTimers.has(senderJid)) {
          clearTimeout(followupTimers.get(senderJid));
          followupTimers.delete(senderJid);
        }

        // Si el mensaje proviene de sincronización ('append') o tiene más de 5 minutos:
        // Se guarda en el expediente para el CRM y para la revisión de hoy, pero sin disparar respuesta tardía
        if (!esMensajeFresco) {
          await registrarMensajeEnHistorial(contactInfo, 'Cliente', cleanMessage, mediaAttachment);
          console.log(`💾 [SINCRONIZADO]: Mensaje de ${contactInfo.displayName} registrado en CRM (hace ${Math.round(edadSegundos / 60)} min).`);
          continue;
        }

        // Acumulador de mensajes: si el cliente manda 3 mensajes seguidos, se unen en uno solo
        const currentBuffer = messageBuffers.get(senderJid) || [];
        currentBuffer.push(cleanMessage);
        messageBuffers.set(senderJid, currentBuffer);

        // Cancelar temporizador previo
        if (pendingTimeouts.has(senderJid)) {
          clearTimeout(pendingTimeouts.get(senderJid));
        }

        // Consolidación ultrarrápida (1.2 segundos) para agrupar mensajes continuos
        const timeout = setTimeout(async () => {
          if (humanHandledChats.has(senderJid) || !leerEstadoBotGlobalDisco()) {
            messageBuffers.delete(senderJid);
            mediaBuffers.delete(senderJid);
            lastMessageKeyMap.delete(senderJid);
            pendingTimeouts.delete(senderJid);
            return;
          }

          const allText = (messageBuffers.get(senderJid) || []).join('\n');
          messageBuffers.delete(senderJid);
          pendingTimeouts.delete(senderJid);

          const targetMedia = mediaBuffers.get(senderJid) || null;
          mediaBuffers.delete(senderJid);
          const lastKey = lastMessageKeyMap.get(senderJid) || null;
          lastMessageKeyMap.delete(senderJid);

          // 💾 1. Guardar mensaje recibido en el archivo del cliente y mostrar en consola
          await registrarMensajeEnHistorial(contactInfo, 'Cliente', allText, targetMedia);
          mostrarEnPantalla({ tipo: 'ENTRANTE', contactInfo, mensaje: allText });

          // 2. Simulación de Comportamiento Humano Real (Lectura + Tipeo Natural):
          // a) Marcar como leído (palomitas azules)
          if (lastKey && typeof sock.readMessages === 'function') {
            try {
              await sock.readMessages([lastKey]);
            } catch {}
          }

          // b) Breve pausa natural de lectura mental (800 ms)
          await new Promise(r => setTimeout(r, 800));

          // c) Indicar "Escribiendo..." (composing) en WhatsApp
          try {
            if (typeof sock.presenceSubscribe === 'function') {
              await sock.presenceSubscribe(senderJid);
            }
            await sock.sendPresenceUpdate('composing', senderJid);
          } catch {}

          // d) Invocar IA pasando texto y multimedia (nota de voz o foto/plano)
          const { reply, transferHuman, notifyAdvisors, leadInfo } = await generateAIResponse(
            senderJid,
            allText,
            contactInfo,
            targetMedia
          );

          if (humanHandledChats.has(senderJid) || !leerEstadoBotGlobalDisco()) {
            try { await sock.sendPresenceUpdate('paused', senderJid); } catch {}
            return;
          }

          // e) Simulación de velocidad humana de tipeo (~28ms por caracter, acotado entre 2.2s y 5.2s)
          const typingDelayMs = Math.min(Math.max((reply?.length || 50) * 28, 2200), 5200);
          await new Promise(r => setTimeout(r, typingDelayMs));

          // f) Finalizar indicador de tipeo y enviar mensaje
          try { await sock.sendPresenceUpdate('paused', senderJid); } catch {}
          if (!leerEstadoBotGlobalDisco()) return;
          const sentClientMsg = await sock.sendMessage(senderJid, { text: reply });
          trackBotMessage(sentClientMsg);

          // 💾 4. Guardar respuesta en el archivo del cliente y mostrar en consola
          await registrarMensajeEnHistorial(contactInfo, 'Alex de ventas', reply);
          mostrarEnPantalla({ tipo: 'SALIENTE', contactInfo, mensaje: reply });

          // 5. Si se solicitó humano, pausar el bot en este chat
          if (transferHuman) {
            humanHandledChats.add(senderJid);
            guardarChatsPausadosDisco(humanHandledChats);
            if (followupTimers.has(senderJid)) {
              clearTimeout(followupTimers.get(senderJid));
              followupTimers.delete(senderJid);
            }
          }

          // 6. Enviar alerta por WhatsApp a los 3 asesores (cuando hay Nuevo Prospecto Calificado, Cita Agendada en Google Calendar o Solicitud de Humano)
          if ((notifyAdvisors || transferHuman) && leadInfo) {
            await registrarMensajeEnHistorial(contactInfo, 'Sistema', `ALERTA ENVIADA A ASESORES:\n${leadInfo}`);
            mostrarEnPantalla({
              tipo: 'ALERTA_HUMANO',
              contactInfo,
              mensaje: leadInfo,
              extra: { asesores: ASESORES_TELEFONOS }
            });

            await enviarAlertaAAsesores(sock, leadInfo);
          } else if (!humanHandledChats.has(senderJid) && !followupSent.has(senderJid) && leerEstadoBotGlobalDisco()) {
            // 7. Programar seguimiento por inactividad (5 min) ÚNICAMENTE si el cliente solo mandó el primer saludo y no ha dado datos
            if (followupTimers.has(senderJid)) {
              clearTimeout(followupTimers.get(senderJid));
            }

            const followupTimeout = setTimeout(async () => {
              try {
                if (humanHandledChats.has(senderJid) || !leerEstadoBotGlobalDisco()) return;

                // 🌙 BLINDAJE HORARIO: Verificar hora en Tiempo del Centro de México (CDMX)
                const horaActualCDMX = parseInt(new Intl.DateTimeFormat('es-MX', {
                  timeZone: 'America/Mexico_City',
                  hour: 'numeric',
                  hour12: false
                }).format(new Date()), 10);

                // Silenciar seguimientos fuera de horario comercial (antes de las 9:00 am o después de las 8:30 pm / 20:30 hrs)
                if (horaActualCDMX < 9 || horaActualCDMX >= 20) {
                  console.log(`🌙 [SEGUIMIENTO SILENCIADO]: Fuera de horario comercial (${horaActualCDMX}:00 hrs) para no molestar a ${contactInfo.displayName}.`);
                  return;
                }

                const urlGlobal = obtenerUrlGlobalApp();
                const linkCatalogo = urlGlobal ? `${urlGlobal}/catalogo.pdf` : (process.env.INSTAGRAM_URL || process.env.WEB_URL || '');

                const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'nuestro equipo';
                const followupMsg = `Le comparto mientras tanto nuestro catálogo digital de soluciones para que pueda conocer más sobre lo que realizamos en ${nombreEmpresa}:\n\n📄 Ver Catálogo / Información: ${linkCatalogo}\n\nCon toda tranquilidad, cuando tenga oportunidad me cuenta más detalles sobre lo que busca y con gusto le orientamos. ✨`;

                const sentFollowup = await sock.sendMessage(senderJid, { text: followupMsg });
                trackBotMessage(sentFollowup);
                followupSent.add(senderJid);

                await registrarMensajeEnHistorial(contactInfo, 'Alex de ventas', followupMsg);
                mostrarEnPantalla({ tipo: 'SEGUIMIENTO', contactInfo, mensaje: followupMsg });
              } catch (err) {
                console.error(`⚠️ Error enviando seguimiento a [${senderJid}]:`, err.message);
              }
            }, FOLLOWUP_DELAY_MS);

            followupTimers.set(senderJid, followupTimeout);
          }
        }, 1200);

        pendingTimeouts.set(senderJid, timeout);
      }
    } catch (err) {
      console.error('Error procesando mensaje entrante:', err);
    }
  });
}

// ============================================================================
// CRON AUTOMÁTICO DE REPORTES POR CORREO (8:00 AM, 1:00 PM y 7:00 PM)
// ============================================================================
let ultimoReporteEnviadoKey = '';

setInterval(async () => {
  try {
    const ahora = new Date();
    const formatter = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const partes = formatter.formatToParts(ahora);
    const hora = parseInt(partes.find(p => p.type === 'hour')?.value || '-1', 10);
    const minuto = parseInt(partes.find(p => p.type === 'minute')?.value || '-1', 10);

    // Horarios de reporte seleccionados por la dirección: 8:00 AM, 13:00 (1 PM), 19:00 (7 PM)
    const horasReporte = [8, 13, 19];
    if (horasReporte.includes(hora) && minuto === 0) {
      const fechaClave = `${ahora.getFullYear()}-${ahora.getMonth()}-${ahora.getDate()}_${hora}`;
      if (ultimoReporteEnviadoKey !== fechaClave) {
        ultimoReporteEnviadoKey = fechaClave;
        console.log(`\n⏰ [CRON INTERNO] Ejecutando reporte programado de las ${hora}:00...`);
        const { ejecutarReporteDiario } = await import('./generar_reporte.js');
        await ejecutarReporteDiario();
      }
    }
  } catch (err) {
    console.error('⚠️ Error en verificación de horario de reporte:', err.message);
  }
}, 30000); // Evaluar cada 30 segundos

// Iniciar el servidor de la App Móvil y Centro de Control CRM (http://localhost:3090)
iniciarServidorCRM({
  getSock: () => currentSock,
  getQr: () => currentQr,
  getConnectionStatus: () => connectionStatus,
  humanHandledChats,
  trackBotMessage
});

connectToWhatsApp();
