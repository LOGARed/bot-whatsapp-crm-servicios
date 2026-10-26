import dotenv from 'dotenv';
import { sincronizarCitaConGoogleCalendar, obtenerHorariosOcupados } from './google_calendar.js';

dotenv.config();

const MODELO_IA = 'gemini-3.8-flash';

/**
 * Reintento seguro ante errores transitorios de API
 */
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

/**
 * Obtiene el contexto horario actual
 */
function obtenerContextoHorarioActual() {
  const ahora = new Date();
  const fechaHoraTexto = ahora.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  return { fechaHoraTexto, ahoraISO: ahora.toISOString() };
}

/**
 * AGENTE GUARDIÁN DE AGENDA & GOOGLE CALENDAR
 * Extrae la fecha/hora acordada en el chat y registra la cita en Google Calendar.
 */
export async function extraerYAgendarCitaOficial(userId, contactInfo, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';
  const { fechaHoraTexto, ahoraISO } = obtenerContextoHorarioActual();

  const displayName = contactInfo?.displayName || 'Prospecto';
  const displayPhone = contactInfo?.displayPhone || contactInfo?.phone || '';

  let datosExtraidos = {
    fechaInicioISO: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
    fechaLegible: 'Mañana (Ver horario en chat)',
    ubicacion: 'Por confirmar',
    tipoServicio: process.env.RUBRO || 'Servicio Profesional',
    resumen: `Sesión informativa / Llamada con Especialista de ${nombreEmpresa}`
  };
  let extraccionOk = false;

  if (apiKey && history.length > 0) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: MODELO_IA,
        generationConfig: {
          maxOutputTokens: 350,
          temperature: 0.1,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const promptCita = `Eres el Especialista de Agenda de ${nombreEmpresa}.
Analiza la siguiente conversación de WhatsApp y extrae la fecha y hora EXACTA pactada para la cita, llamada o visita.
Contexto actual: ${fechaHoraTexto} (ISO: ${ahoraISO}).

Historial de conversación:
${history.join('\n')}

Cliente: ${displayName} | Teléfono: ${displayPhone}

Reglas estrictas de extracción:
1. "fechaInicioISO": Formato ISO 8601 con zona horaria de México (-06:00) o UTC. Si dijeron "mañana a las 4pm", calcula el día siguiente exacto a las 16:00 hrs.
2. "fechaLegible": Ejemplo: "Martes 27 de Octubre, 4:00 PM".
3. "emailCliente": Si el cliente mencionó su correo electrónico en el chat, extráelo aquí. Si no, déjalo vacío "".
4. "tipoServicio": Tipo de servicio o requerimiento solicitado.
5. "ubicacion": Municipio o ciudad del cliente si la mencionó, o 'Por confirmar'.

Devuelve EXCLUSIVAMENTE este objeto JSON:
{
  "fechaInicioISO": "YYYY-MM-DDTHH:mm:ss-06:00",
  "fechaLegible": "Día y hora legible",
  "emailCliente": "correo@ejemplo.com o vacío",
  "tipoServicio": "Descripción del servicio",
  "ubicacion": "Ciudad / Zona"
}`;

      console.log(`📅 [AGENTE AGENDA]: Extrayendo fecha/hora para ${displayName}...`);
      const res = await generarConReintento(model, promptCita);
      const rawText = res.response.text();
      const parsed = JSON.parse(rawText);

      if (parsed.fechaInicioISO) {
        datosExtraidos = { ...datosExtraidos, ...parsed };
        extraccionOk = true;
      }
    } catch (err) {
      console.error('⚠️ [AGENTE AGENDA] Error analizando horario:', err.message);
    }
  }

  // Sincronizar con Google Calendar
  const resultadoSync = await sincronizarCitaConGoogleCalendar({
    nombreCliente: displayName,
    telefono: displayPhone,
    fechaInicioISO: datosExtraidos.fechaInicioISO,
    fechaLegible: datosExtraidos.fechaLegible,
    ubicacion: datosExtraidos.ubicacion,
    tipoObra: datosExtraidos.tipoServicio,
    emailCliente: datosExtraidos.emailCliente || ''
  });

  return {
    ...datosExtraidos,
    googleCalendarUrl: resultadoSync?.googleCalendarUrl || '',
    eventId: resultadoSync?.eventId || '',
    sincronizado: resultadoSync?.ok || false
  };
}
