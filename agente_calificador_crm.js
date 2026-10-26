import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { obtenerRutasExpedienteCliente } from './historial_conversaciones.js';

dotenv.config();

const MODELO_IA = 'gemini-3.8-flash';

async function generarConReintento(model, contenido) {
  try {
    return await model.generateContent(contenido);
  } catch (e) {
    const msg = String(e?.message || e);
    const transitorio = /429|500|502|503|504|overloaded|unavailable|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
    if (!transitorio) throw e;
    await new Promise(r => setTimeout(r, 2000));
    return await model.generateContent(contenido);
  }
}

function leerExpedienteCliente(userId, contactInfo) {
  try {
    const { jsonPath } = obtenerRutasExpedienteCliente({
      senderJid: contactInfo?.senderJid || userId,
      phone: contactInfo?.phone || userId.replace(/@.*$/, '')
    });
    if (fs.existsSync(jsonPath)) {
      return { jsonPath, data: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) };
    }
  } catch {}
  return { jsonPath: null, data: null };
}

/**
 * AGENTE CALIFICADOR & LEAD SCORING CRM
 * Clasifica objetivamente el nivel de compra del lead y genera la Ficha Técnica para traspaso comercial.
 */
export async function calificarLeadYGenerarFicha(userId, contactInfo, motivo = 'Nuevo Prospecto Calificado', citaGoogle = null, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';

  let displayName = 'Prospecto';
  let displayPhone = 'Por confirmar';
  let waLink = '';

  if (typeof contactInfo === 'object' && contactInfo !== null) {
    displayName = contactInfo.displayName || 'Prospecto';
    displayPhone = contactInfo.displayPhone || contactInfo.phone || 'Por confirmar';
    waLink = contactInfo.waLink || `https://wa.me/${contactInfo.phone || ''}`;
  } else if (typeof contactInfo === 'string') {
    const raw = contactInfo.replace(/@.*$/, '');
    displayPhone = raw;
    waLink = `https://wa.me/${raw}`;
  }

  const calendarBlock = citaGoogle?.googleCalendarUrl
    ? `\n\n📅 *CITA AGENDADA EN GOOGLE CALENDAR:*\n🕒 *Horario:* ${citaGoogle.fechaLegible}\n📲 *Guardar en Google Calendar (1 Clic):*\n${citaGoogle.googleCalendarUrl}`
    : '';

  const { jsonPath, data: expedientePrevio } = leerExpedienteCliente(userId, contactInfo);

  if (!apiKey || history.length === 0) {
    return `🚨 *¡${motivo.toUpperCase()}!* Por favor atiendan pronto a:\n👤 *Nombre:* ${displayName}\n📞 *Teléfono:* ${displayPhone}\n💬 *Contacto directo:* ${waLink}${calendarBlock}`;
  }

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const prompt = `Eres el Auditor de Calificación Comercial de ${nombreEmpresa}.
Analiza la siguiente conversación de WhatsApp y genera la Ficha Técnica Oficial para el traspaso a los asesores humanos (${motivo}).

Historial de conversación:
${history.join('\n')}

Cliente: ${displayName} | Teléfono: ${displayPhone} | Contacto: ${waLink}

Estructura tu respuesta exactamente así:
🚨 *¡${motivo.toUpperCase()}!*
👤 *Contacto:* ${displayName} (${displayPhone})
💬 *WhatsApp directo:* ${waLink}

\`\`\`yaml
[FICHA TÉCNICA - TRASPASO COMERCIAL]
- Nombre del Cliente: ${displayName}
- Teléfono / WhatsApp: ${displayPhone}
- Perfil del Lead: [Nivel A (Prioridad Alta - Cita Directa) / Nivel B (En Seguimiento / Dudas) / Cuenta B2B (Corporativo) / Nivel C (Descarte Cortés)]
- Score Estimado: [0 a 100 según intención de compra]
- Ubicación / Zona: [Municipio / Ciudad o 'Por confirmar']
- Requerimiento Solicitado: [Descripción del servicio/producto solicitado]
- Urgencia / Tiempo Estimado: [Mes o fecha estimada de compra]
- Presupuesto / Capacidad Estimada: [Rango referencial o 'Por definir']
- Dolor o Preocupación Principal: [Tiempo / Calidad / Costo / Experiencia previa]
- Siguiente Paso Acordado: [Llamada diagnóstica / Cita presencial / Envío de cotización]
- Horario Acordado: [Día y hora de cita o estado de la conversación]
\`\`\``;

    console.log(`📊 [AGENTE CALIFICADOR]: Generando Ficha Técnica para ${displayName}...`);
    const res = await generarConReintento(model, prompt);
    const textoFicha = res.response.text().trim();

    try {
      if (jsonPath && expedientePrevio) {
        expedientePrevio.fichaTecnica = textoFicha;
        expedientePrevio.perfilLead = textoFicha.includes('Nivel A') ? 'NIVEL_A' : textoFicha.includes('Cuenta B2B') ? 'B2B' : textoFicha.includes('Nivel B') ? 'NIVEL_B' : 'CALIFICADO';
        expedientePrevio.fechaUltimaCalificacionISO = new Date().toISOString();
        fs.writeFileSync(jsonPath, JSON.stringify(expedientePrevio, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('Error persistiendo ficha técnica:', e.message);
    }

    return textoFicha + calendarBlock;
  } catch (err) {
    console.error('⚠️ [AGENTE CALIFICADOR] Error al calificar lead:', err.message);
    return `🚨 *¡${motivo.toUpperCase()}!* Por favor atiendan pronto a:\n👤 *Nombre:* ${displayName}\n📞 *Teléfono:* ${displayPhone}\n💬 *Contacto directo:* ${waLink}${calendarBlock}`;
  }
}
