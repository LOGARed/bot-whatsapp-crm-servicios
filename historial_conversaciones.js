import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.resolve('./conversaciones_guardadas');

// Asegurar que la carpeta exista
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Obtiene la fecha y hora formateada en horario de México
 */
function getTimestamp() {
  return new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'short',
    timeStyle: 'medium'
  });
}

/**
 * Limpia un texto para usarlo como nombre de archivo válido en Windows
 */
function sanitizeFileName(text) {
  return (text || 'cliente')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

/**
 * Obtiene la ruta canónica del expediente del cliente basada en identificador único estable (teléfono/JID)
 * para evitar fragmentación si el cliente cambia su pushName (DATA-01 y DATA-02)
 */
export function obtenerRutasExpedienteCliente(contactInfo = {}) {
  const { senderJid, displayName, phone } = contactInfo;
  const rawDigits = (phone || senderJid?.replace(/@.*$/, '') || '').replace(/\D/g, '');
  const canonicalId = rawDigits ? `cliente_${rawDigits}` : `cliente_${sanitizeFileName(senderJid || 'anon')}`;

  let jsonPath = path.join(LOGS_DIR, `${canonicalId}.json`);
  let txtPath = path.join(LOGS_DIR, `${canonicalId}.txt`);

  // Si no existe con nombre canónico pero existe en formato anterior con el mismo número, migrarlo sin pérdida
  if (!fs.existsSync(jsonPath) && rawDigits) {
    try {
      const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
      const oldFile = files.find(f => f.endsWith(`_${rawDigits}.json`) && !f.startsWith('cliente_'));
      if (oldFile) {
        const oldJson = path.join(LOGS_DIR, oldFile);
        const oldTxt = path.join(LOGS_DIR, oldFile.replace('.json', '.txt'));
        fs.renameSync(oldJson, jsonPath);
        if (fs.existsSync(oldTxt)) fs.renameSync(oldTxt, txtPath);
      }
    } catch (e) {}
  }

  return { canonicalId, jsonPath, txtPath };
}

/**
 * Guarda un mensaje en el archivo de historial del cliente (.txt y .json)
 * con soporte para metadatos de multimedia (fotos, audios, planos en PDF)
 */
export async function registrarMensajeEnHistorial(contactInfo, rol, contenido, mediaMeta = null, customTimestampMs = null) {
  try {
    const senderJid = contactInfo?.senderJid || contactInfo?.jid || '';
    const displayName = contactInfo?.displayName || contactInfo?.nombre || 'Prospecto';
    const displayPhone = contactInfo?.displayPhone || contactInfo?.telefonoFormato || contactInfo?.telefono || '';
    const phone = contactInfo?.phone || contactInfo?.telefono || '';
    const normalizedInfo = { senderJid, displayName, displayPhone, phone };

    const { canonicalId, jsonPath, txtPath } = obtenerRutasExpedienteCliente(normalizedInfo);
    const msgTimestampMs = customTimestampMs || Date.now();
    const timestamp = customTimestampMs
      ? new Date(customTimestampMs).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'medium' })
      : getTimestamp();

    // 1. Si el archivo .txt no existe, crear encabezado institucional
    if (!fs.existsSync(txtPath)) {
      const nombreEmpresa = (process.env.NOMBRE_NEGOCIO || 'CENTRO DE ATENCIÓN COMERCIAL').toUpperCase();
      const header = `================================================================================
${nombreEmpresa}
REGISTRO HISTÓRICO DE CONVERSACIÓN DE VENTAS
--------------------------------------------------------------------------------
Cliente / Contacto:  ${displayName || 'Desconocido'}
Teléfono / WhatsApp: ${displayPhone || phone || 'Por confirmar'}
ID de WhatsApp:      ${senderJid}
Fecha de inicio:     ${timestamp}
================================================================================\n\n`;
      fs.writeFileSync(txtPath, header, 'utf8');
    }

    // 2. Anexar el mensaje al archivo .txt
    const icono = rol === 'Cliente' ? '👤' : (rol === 'Alex de ventas' ? '🤖' : '🚨');
    let entradaTxt = `[${timestamp}] ${icono} ${rol}:\n${contenido}\n`;
    if (mediaMeta?.url) {
      entradaTxt += `📎 [Adjunto ${mediaMeta.type || 'archivo'}: ${mediaMeta.fileName || mediaMeta.url}]\n`;
    }
    entradaTxt += '\n';
    fs.appendFileSync(txtPath, entradaTxt, 'utf8');

    // 3. Actualizar metadata estructurada en .json
    let metadata = {
      id: canonicalId,
      contacto: {
        nombre: displayName || 'Prospecto',
        telefono: phone || '',
        telefonoFormato: displayPhone || '',
        jid: senderJid,
        aliasPrevios: []
      },
      fechaInicio: timestamp,
      ultimaActualizacion: timestamp,
      totalMensajes: 0,
      atencionHumanaRequerida: false,
      estatusAtencion: 'PENDIENTE',
      mensajes: []
    };

    if (fs.existsSync(jsonPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (e) {}
    }

    // Preservar historial de nombres (DATA-01) si el cliente cambió de nombre en WhatsApp
    if (displayName && metadata.contacto?.nombre && metadata.contacto.nombre !== displayName) {
      if (!metadata.contacto.aliasPrevios) metadata.contacto.aliasPrevios = [];
      if (!metadata.contacto.aliasPrevios.includes(metadata.contacto.nombre)) {
        metadata.contacto.aliasPrevios.push(metadata.contacto.nombre);
      }
      metadata.contacto.nombre = displayName;
    }

    // Comprobar duplicado idéntico en ventana de 60 segundos
    const yaExiste = Array.isArray(metadata.mensajes) && metadata.mensajes.some(m =>
      m.rol === rol &&
      m.contenido === contenido &&
      Math.abs((m.timestampMs || 0) - msgTimestampMs) < 60000
    );
    if (yaExiste) {
      return { txtPath, jsonPath, canonicalId };
    }

    metadata.id = canonicalId;
    metadata.ultimaActualizacion = timestamp;
    metadata.ultimaActualizacionISO = new Date(msgTimestampMs).toISOString();
    metadata.totalMensajes = (metadata.totalMensajes || 0) + 1;
    if (rol === 'Sistema' && contenido.includes('TRANSFERENCIA')) {
      metadata.atencionHumanaRequerida = true;
    }

    // Estado de atención: si habla el cliente -> PENDIENTE; si responde el bot -> ATENDIDO
    if (rol === 'Cliente' || rol === 'Cliente (con asesor)') {
      metadata.estatusAtencion = 'PENDIENTE';
    } else if (rol === 'Alex de ventas') {
      metadata.estatusAtencion = 'ATENDIDO';
    }

    const nuevoMensaje = {
      fecha: timestamp,
      timestampMs: msgTimestampMs,
      rol,
      contenido
    };
    if (mediaMeta) {
      nuevoMensaje.media = mediaMeta;
    }

    metadata.mensajes.push(nuevoMensaje);

    // Guardar los últimos 60 mensajes en el JSON
    if (metadata.mensajes.length > 60) {
      metadata.mensajes = metadata.mensajes.slice(-60);
    }

    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');

    return { txtPath, jsonPath, canonicalId };
  } catch (error) {
    console.error('⚠️ Error al registrar conversación en disco:', error.message);
    return null;
  }
}

/**
 * Muestra en la pantalla de la consola un bloque visual limpio y profesional
 */
export function mostrarEnPantalla({ tipo, contactInfo, mensaje, extra }) {
  const time = new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
  const nombre = contactInfo?.displayName || 'Prospecto';
  const tel = contactInfo?.displayPhone || contactInfo?.phone || contactInfo?.senderJid || '';

  if (tipo === 'ENTRANTE') {
    console.log(`\n┌─────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`│ 📩 [${time}] MENSAJE RECIBIDO de: ${nombre} (${tel})`);
    console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`  "${mensaje.replace(/\n/g, '\n  ')}"`);
    console.log(`└─────────────────────────────────────────────────────────────────────────────┘`);
  } else if (tipo === 'SALIENTE') {
    console.log(`┌─────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`│ 📤 [${time}] RESPUESTA ENVIADA (Alex de ventas -> ${nombre}):`);
    console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`  ${mensaje.replace(/\n/g, '\n  ')}`);
    console.log(`├─────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`│ 💾 Guardado en: conversaciones_guardadas/`);
    console.log(`└─────────────────────────────────────────────────────────────────────────────┘\n`);
  } else if (tipo === 'ALERTA_HUMANO') {
    console.log(`\n🚨🚨🚨 [${time}] ¡SOLICITUD DE ASESOR HUMANO DETECTADA! 🚨🚨🚨`);
    console.log(`👤 Prospecto: ${nombre}`);
    console.log(`📞 Teléfono real verificado: ${tel}`);
    console.log(`🔗 Enlace directo WhatsApp: ${contactInfo?.waLink || 'https://wa.me/' + contactInfo?.phone}`);
    if (extra?.asesores) {
      console.log(`📢 Notificación enviada a los 3 asesores: ${extra.asesores.join(', ')}`);
    }
    console.log(`🤖 El bot se ha pausado para este chat. Un asesor puede responder libremente.\n`);
  } else if (tipo === 'SEGUIMIENTO') {
    console.log(`\n⏰ [${time}] SEGUIMIENTO POR INACTIVIDAD (2 min) enviado a ${nombre} (${tel})`);
  }
}
