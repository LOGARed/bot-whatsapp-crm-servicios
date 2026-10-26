import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { CONOCIMIENTO_EMPRESA } from './conocimiento_empresa.js';
import { sincronizarCitaConGoogleCalendar, obtenerHorariosOcupados } from './google_calendar.js';
import { obtenerRutasExpedienteCliente } from './historial_conversaciones.js';
import { evaluarRespuesta, pulirRespuesta, RESPUESTA_SEGURA } from './guardrails.js';
import { analizarMediaVisual } from './agente_analista_visual.js';
import { extraerYAgendarCitaOficial } from './agente_agenda_calendar.js';
import { calificarLeadYGenerarFicha } from './agente_calificador_crm.js';
import { evaluarCriteriosEscalamiento } from './criterios_escalamiento.js';

dotenv.config();

const LOGS_DIR = path.resolve('./conversaciones_guardadas');
const MAX_HISTORIAL_LINEAS = 30;
const MODELO_IA = 'gemini-3.8-flash';

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

async function generarConReintento(model, contenido) {
  try {
    return await model.generateContent(contenido);
  } catch (e) {
    const msg = String(e?.message || e);
    const transitorio = /429|500|502|503|504|overloaded|unavailable|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
    if (!transitorio) throw e;
    await new Promise(r => setTimeout(r, 2500));
    return await model.generateContent(contenido);
  }
}

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
  return { fechaHoraTexto };
}

function getSystemPrompt() {
  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';
  const rubro = process.env.RUBRO || 'Servicios Profesionales';
  const ubicacion = process.env.UBICACION || 'Nacional / Local';
  const { fechaHoraTexto } = obtenerContextoHorarioActual();

  const serviciosTexto = CONOCIMIENTO_EMPRESA.servicios
    .map(s => `• ${s.nombre}: ${s.descripcion}\n  Beneficios: ${s.beneficios.join(', ')}`)
    .join('\n');

  const objecionesTexto = CONOCIMIENTO_EMPRESA.objecionesFrecuentes
    .map(o => `• Objeción: "${o.objecion}"\n  Guía de respuesta: ${o.respuestaGuia}`)
    .join('\n');

  return `Eres el Asesor Virtual y Consultor Comercial Inteligente de **${nombreEmpresa}** (${rubro}).
Tu misión es atender con calidez, empatía y rigor profesional a prospectos en WhatsApp, responder sus dudas y guiarlos hacia una llamada o cita con un especialista.

--- CONTEXTO ACTUAL ---
- Fecha y hora actual: ${fechaHoraTexto}
- Empresa: ${nombreEmpresa}
- Giro: ${rubro}
- Ubicación / Cobertura: ${ubicacion}

--- SERVICIOS Y PROPUESTA DE VALOR ---
${serviciosTexto}

--- POLÍTICAS COMERCIALES Y PRECIOS ---
- Regla de Precios: ${CONOCIMIENTO_EMPRESA.politicasComerciales.reglaPrecios}
- Esquema de Pagos: ${CONOCIMIENTO_EMPRESA.politicasComerciales.esquemaPagos}
- Garantías: ${CONOCIMIENTO_EMPRESA.politicasComerciales.garantias}

--- MANEJO DE OBJECIONES ---
${objecionesTexto}

--- MOTOR CONVERSACIONAL ADAPTATIVO (ÁGIL POR DEFECTO, EXPLICATIVO SOLO CUANDO SEA NECESARIO) ---
1. REGLA POR DEFECTO (Intercambio Cotidiano):
- Respuestas CORTAS, naturales y humanas (máximo 2 a 3 líneas, 20 a 35 palabras promedio).
- Estructura Ágil (1 + 1): 1 validación cordial + 1 sola pregunta directa para conocer el requerimiento.
- NO enviar textos largos cuando el cliente solo saluda o responde datos simples.

2. DISCURSO MÁS LARGO Y PROFUNDO (SOLO CUANDO SEA ESTRICTAMENTE NECESARIO):
El bot PUEDE y DEBE elaborar una respuesta más extensa y persuasiva (1 a 2 párrafos sólidos con autoridad profesional) ÚNICAMENTE cuando la situación lo justifique:
- Cuando el cliente cuestione precios, pida tarifas fijas al aire o pregunte por qué elegir esta empresa.
- Cuando pregunte detalles técnicos específicos o compare con la competencia.
- Cuando exprese dudas de seriedad o garantías de entrega.
- Rematando SIEMPRE con una sola pregunta de avance hacia la llamada técnica o diagnóstico.

--- FORMATO EN WHATSAPP ---
- Trato formal de "Usted", cálido, educado y seguro.
- Máximo 1 a 2 emojis elegantes (✨, 📌).
- NUNCA agrupes múltiples preguntas.
- Si se acuerda día y hora de cita o llamada, confirma amablemente e incluye la etiqueta técnica: [CITA_AGENDADA].
- Si el cliente solicita hablar con una persona humana, responde con cortesía e incluye: [TRANSFERIR_HUMANO].
`;
}

const conversationHistory = new Map();
const qualifiedAlertSentSet = new Set();
const appointmentAlertSentSet = new Set();
const escalationAlertSentSet = new Set();

function sincronizarEstadoDesdeDisco(userId, contactInfo) {
  try {
    const { jsonPath, data } = leerExpedienteCliente(userId, contactInfo);
    if (data?.mensajes && Array.isArray(data.mensajes) && data.mensajes.length > 0) {
      const restaurados = data.mensajes.slice(-MAX_HISTORIAL_LINEAS).map(m => {
        const rol = (m.rol === 'bot' || m.rol === 'Asistente') ? 'Asistente' : 'Cliente';
        return `${rol}: ${m.contenido}`;
      });
      if (restaurados.length > 0) {
        conversationHistory.set(userId, restaurados);
      }
    }
  } catch {}
}

export async function callGoogleAIStudio(userId, message, contactInfo = null, mediaAttachment = null, customInstruction = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  const sanitizedMessage = (message || '').trim();

  if (!apiKey) {
    return {
      reply: 'Gracias por comunicarse con nosotros. En unos instantes un asesor especializado le atenderá personalmente.',
      transferHuman: false,
      appointmentScheduled: false,
      notifyAdvisors: false,
      leadInfo: null
    };
  }

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      generationConfig: {
        maxOutputTokens: 450,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    sincronizarEstadoDesdeDisco(userId, contactInfo);
    const history = conversationHistory.get(userId) || [];

    if (mediaAttachment?.type === 'audio') {
      history.push(`Cliente: [Nota de voz de WhatsApp: "${sanitizedMessage || 'Audio enviado'}"]`);
    } else if (mediaAttachment?.type === 'image' || mediaAttachment?.mimeType?.startsWith('image/')) {
      history.push(`Cliente: [Imagen adjunta: "${sanitizedMessage || 'Foto enviada'}"]`);
    } else if (mediaAttachment?.type === 'document' || mediaAttachment?.mimeType?.includes('pdf')) {
      history.push(`Cliente: [Documento PDF adjunto: ${mediaAttachment.fileName || 'archivo.pdf'}]`);
    } else {
      history.push(`Cliente: ${sanitizedMessage}`);
    }

    if (history.length > MAX_HISTORIAL_LINEAS) {
      history.splice(0, history.length - MAX_HISTORIAL_LINEAS);
    }

    let extraContext = '';
    let inlinePart = null;
    let diagnosticoVisual = null;

    if (mediaAttachment?.type === 'image' || mediaAttachment?.type === 'document' || mediaAttachment?.mimeType?.startsWith('image/') || mediaAttachment?.mimeType?.includes('pdf')) {
      try {
        diagnosticoVisual = await analizarMediaVisual({
          mediaAttachment,
          userMessage: sanitizedMessage,
          contactInfo,
          history
        });
        if (diagnosticoVisual?.capsulaAsistente) {
          extraContext = `\n[ANÁLISIS VISUAL DE LA IMAGEN/DOCUMENTO]:\n"${diagnosticoVisual.capsulaAsistente}"\n• Elementos: ${diagnosticoVisual.elementosObservables}\n🚨 Incorpora este detalle cordial en tu respuesta y guía hacia la asesoría.`;
        }
      } catch (errVisual) {
        inlinePart = {
          inlineData: { data: mediaAttachment.data, mimeType: mediaAttachment.mimeType }
        };
      }
    }

    const promptText = `${getSystemPrompt()}\n\nHistorial reciente:\n${history.join('\n')}${extraContext}\n\nResponde como Asesor Virtual de forma natural:`;

    let result;
    if (inlinePart) {
      result = await generarConReintento(model, [inlinePart, promptText]);
    } else {
      result = await generarConReintento(model, promptText);
    }

    let reply = (result?.response?.text() || 'Con mucho gusto le atiendo, ¿en qué podemos apoyarle hoy?').trim();

    const evaluacion = evaluarRespuesta(reply);
    if (!evaluacion.ok) {
      reply = RESPUESTA_SEGURA;
    }
    reply = pulirRespuesta(reply);

    let transferHuman = false;
    let appointmentScheduled = false;
    let notifyAdvisors = false;
    let leadInfo = null;

    if (reply.includes('[TRANSFERIR_HUMANO]')) {
      transferHuman = true;
      notifyAdvisors = true;
      reply = reply.replace(/\[TRANSFERIR_HUMANO\]/g, '').trim();
    }

    if (reply.includes('[CITA_AGENDADA]')) {
      appointmentScheduled = true;
      reply = reply.replace(/\[CITA_AGENDADA\]/g, '').trim();
    }

    history.push(`Asistente: ${reply}`);
    conversationHistory.set(userId, history);

    const replyLower = reply.toLowerCase();
    const confirmacionCitaTexto =
      replyLower.includes('agendada su llamada') ||
      replyLower.includes('agendada su cita') ||
      replyLower.includes('confirmada su llamada') ||
      replyLower.includes('confirmado su horario');

    // Criterios de escalamiento prioritario
    const evaluacionEscalamiento = evaluarCriteriosEscalamiento({
      history,
      userMessage: sanitizedMessage,
      diagnosticoVisual
    });

    if ((appointmentScheduled || confirmacionCitaTexto) && !appointmentAlertSentSet.has(userId)) {
      appointmentScheduled = true;
      notifyAdvisors = true;
      appointmentAlertSentSet.add(userId);
      qualifiedAlertSentSet.add(userId);
      escalationAlertSentSet.add(userId);

      const citaGoogle = await extraerYAgendarCitaOficial(userId, contactInfo, history);
      const motivo = evaluacionEscalamiento.debeEscalarInmediato
        ? `📅 Cita Agendada | ${evaluacionEscalamiento.motivo}`
        : '📅 Cita Agendada y Prospecto Calificado';
      leadInfo = await calificarLeadYGenerarFicha(userId, contactInfo, motivo, citaGoogle, history);

      if (citaGoogle?.googleCalendarUrl && !reply.includes('calendar.google.com')) {
        reply += `\n\n📅 *Invitación a la Sesión:*\nPuede guardar la cita en su Google Calendar con 1 clic aquí:\n${citaGoogle.googleCalendarUrl}`;
      }
    } else if (evaluacionEscalamiento.debeEscalarInmediato && !escalationAlertSentSet.has(userId)) {
      escalationAlertSentSet.add(userId);
      qualifiedAlertSentSet.add(userId);
      notifyAdvisors = true;
      leadInfo = await calificarLeadYGenerarFicha(userId, contactInfo, evaluacionEscalamiento.motivo, null, history);
    } else if (transferHuman) {
      leadInfo = await calificarLeadYGenerarFicha(userId, contactInfo, 'Solicitud de Asesor Humano', null, history);
    }

    return {
      reply,
      transferHuman,
      appointmentScheduled,
      notifyAdvisors,
      leadInfo
    };
  } catch (error) {
    console.error('Error al consultar Gemini:', error);
    return {
      reply: 'Hemos recibido su mensaje con gusto. En unos momentos un asesor de nuestro equipo le dará seguimiento puntual.',
      transferHuman: false,
      appointmentScheduled: false,
      notifyAdvisors: false,
      leadInfo: null
    };
  }
}

export async function generateAIResponse(userId, userMessage, contactInfo, mediaAttachment = null, customInstruction = null) {
  return await callGoogleAIStudio(userId, userMessage, contactInfo, mediaAttachment, customInstruction);
}
