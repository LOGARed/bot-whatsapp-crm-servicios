import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  obtenerProspectos,
  leerDirectricesDisco as leerDirectrices,
  guardarDirectricesDisco as guardarDirectrices,
  leerEstadoBotGlobalDisco,
  guardarEstadoBotGlobalDisco,
  leerChatsPausadosDisco,
  guardarChatsPausadosDisco,
  obtenerUrlGlobalApp
} from './app_crm.js';
import { leerCitasAgendadas } from './google_calendar.js';
import {
  leerCriteriosDirector,
  guardarCriteriosDirector,
  agregarCriterioDirector
} from './criterios_escalamiento.js';

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

function formatToJid(phone) {
  const clean = String(phone).replace(/\D/g, '');
  const digits = clean.startsWith('521') ? clean.replace(/^521/, '52') : clean.startsWith('52') ? clean : `52${clean}`;
  return `${digits}@s.whatsapp.net`;
}

/**
 * AGENTE COPILOTO DE DIRECCIÓN POR WHATSAPP
 * Permite a los dueños y asesores interactuar directamente con el bot
 * desde su propio WhatsApp para pedir métricas, estatus de leads,
 * citas agendadas o dar órdenes de control en lenguaje natural.
 */
export async function atenderConsultaDirectorWhatsApp({
  senderJid,
  senderPhone,
  messageText,
  contactInfo,
  sock,
  humanHandledChats,
  trackBotMessage
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const cleanText = (messageText || '').trim();
  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';
  const nombreDirector = contactInfo?.displayName || 'Director / Asesor';

  // Comandos rápidos de acceso
  if (cleanText.toLowerCase() === '#app' || cleanText.toLowerCase() === '#crm' || cleanText.toLowerCase() === '#link') {
    const urlGlobal = obtenerUrlGlobalApp();
    return `👑 *Hola ${nombreDirector}*\n\n🌎 *Acceso al Panel CRM (4G/5G):*\n${urlGlobal || 'Generando enlace, intente en 5 segundos...'}\n\n_Puede abrirlo desde su celular con datos móviles o Wi-Fi._`;
  }

  if (cleanText.toLowerCase() === '#criterios' || cleanText.toLowerCase() === '#reglas') {
    const criterios = leerCriteriosDirector();
    const listaCriterios = criterios.map((c, i) => `• *${c.nombre}* (${c.regex || 'Condición especial'}): ${c.descripcion}`).join('\n\n');
    return `👑 *Criterios de Escalamiento a Asesores Humanos:*\n\n${listaCriterios}\n\n📌 *Comportamiento del Bot:*\n- Si el prospecto cumple alguno de estos criterios, te salta alerta prioritaria inmediata a ti y a los asesores.\n- Si no los cumple, el asistente continúa atendiéndolo fluidamente hasta recopilar datos y agendar la cita en Google Calendar.\n\n_Puedes dictarme un nuevo criterio en lenguaje natural aquí por WhatsApp en cualquier momento (ej: "pásame los clientes que pidan cotización de mayoreo")._`;
  }

  // Recopilar estado vivo del CRM
  const leads = obtenerProspectos();
  const citas = leerCitasAgendadas();
  const directrices = leerDirectrices();
  const criteriosEscalamiento = leerCriteriosDirector();
  const botActivoGlobal = leerEstadoBotGlobalDisco();
  const chatsPausados = leerChatsPausadosDisco();

  const ahoraMs = Date.now();
  const UN_DIA_MS = 24 * 3600 * 1000;
  const leadsHoy = leads.filter(l => (ahoraMs - (l.ultimaActividadMs || 0)) <= UN_DIA_MS);
  const leadsNivelA = leads.filter(l => l.perfilLead === 'NIVEL_A' || l.categoriaCRM === 'VIP_HOT');
  const citasProximas = citas.slice(0, 5);

  const resumenCartera = `
- Total de prospectos en CRM: ${leads.length}
- Prospectos activos hoy (últimas 24h): ${leadsHoy.length}
- Leads Calificados Nivel A / Alta Prioridad: ${leadsNivelA.length}
- Citas agendadas totales: ${citas.length}
- Estado del Bot: ${botActivoGlobal ? '🟢 ACTIVO Y RESPONDIENDO' : '⏸️ EN PAUSA GLOBAL'}
- Chats silenciados por asesor humano: ${chatsPausados.size}
`;

  const detalleHoy = leadsHoy.map(l =>
    `• ${l.nombre} (${l.telefonoFormato}) | Ubicación: ${l.ubicacion || 'Por confirmar'} | Estatus: ${l.pausado ? 'En manos de Asesor' : 'Atendido por Bot'}`
  ).join('\n') || '(No hay actividad nueva en las últimas 24h)';

  const detalleCitas = citasProximas.map(c =>
    `📅 ${c.fechaLegible || c.fechaInicioISO} - ${c.nombreCliente} (${c.telefono}) [${c.tipoObra || 'Servicio'}]`
  ).join('\n') || '(No hay citas programadas próximamente)';

  if (!apiKey) {
    return `👑 *Hola ${nombreDirector}*\n\n${resumenCartera}\n\n*Actividad de hoy:*\n${detalleHoy}`;
  }

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      generationConfig: {
        maxOutputTokens: 750,
        temperature: 0.15,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const promptCopiloto = `Eres el Asistente Ejecutivo y Copiloto Comercial de Dirección de ${nombreEmpresa}.
Estás respondiendo a través de WhatsApp a tu Director Comercial / Asesor: ${nombreDirector} (${senderPhone}).

PANORAMA EN VIVO DEL NEGOCIO:
${resumenCartera}

PROSPECTOS ACTIVOS HOY:
${detalleHoy}

PRÓXIMAS CITAS EN AGENDA:
${detalleCitas}

DIRECTRICES COMERCIALES VIGENTES:
${directrices.length > 0 ? directrices.map((d, i) => `${i + 1}. ${d.regla}`).join('\n') : '(Ninguna directriz adicional registrada)'}

CRITERIOS DE ESCALAMIENTO ACTIVOS:
${criteriosEscalamiento.map((c, i) => `${i + 1}. ${c.nombre} (${c.regex || 'Condición'}) - ${c.descripcion}`).join('\n')}

MENSAJE O CONSULTA DEL DIRECTOR:
"${cleanText}"

Analiza lo que solicita el Director y responde con máxima claridad, cortesía y datos reales.
Si pregunta por un cliente específico o zona, búscalo en la cartera y dale el resumen ejecutivo de su caso.
Si pide pausar un chat, reactivarlo, pausar el bot globalmente, guardar una directriz o definir un nuevo criterio para pasarle prospectos, procesa la acción correspondiente en el JSON.

Devuelve EXCLUSIVAMENTE este objeto JSON:
{
  "respuestaWhatsApp": "Mensaje en WhatsApp claro, ejecutivo, conciso y bien formateado con negritas y emojis.",
  "accion": {
    "tipo": "NINGUNA / PAUSAR_CHAT / REACTIVAR_CHAT / CONTROL_BOT_GLOBAL / GUARDAR_DIRECTRIZ / GUARDAR_CRITERIO_ESCALAMIENTO",
    "telefonoObjetivo": "Número del cliente si pidió pausar o reactivar (o vacío)",
    "nuevoEstadoGlobal": true,
    "nuevaDirectriz": "Texto de la regla si dio una instrucción de ventas",
    "nuevoCriterio": {
      "nombre": "Nombre descriptivo del criterio",
      "regex": "Expresión regular o palabras clave",
      "descripcion": "Descripción del criterio para alertar"
    }
  }
}`;

    const res = await generarConReintento(model, promptCopiloto);
    const parsed = JSON.parse(res.response.text());

    if (parsed.accion?.tipo === 'CONTROL_BOT_GLOBAL') {
      const nuevoEstado = Boolean(parsed.accion.nuevoEstadoGlobal);
      guardarEstadoBotGlobalDisco(nuevoEstado, `Orden por WhatsApp de ${nombreDirector}`);
    } else if (parsed.accion?.tipo === 'PAUSAR_CHAT' && parsed.accion?.telefonoObjetivo) {
      const targetJid = formatToJid(parsed.accion.telefonoObjetivo);
      humanHandledChats.add(targetJid);
      guardarChatsPausadosDisco(humanHandledChats);
    } else if (parsed.accion?.tipo === 'REACTIVAR_CHAT' && parsed.accion?.telefonoObjetivo) {
      const targetJid = formatToJid(parsed.accion.telefonoObjetivo);
      humanHandledChats.delete(targetJid);
      guardarChatsPausadosDisco(humanHandledChats);
    } else if (parsed.accion?.tipo === 'GUARDAR_DIRECTRIZ' && parsed.accion?.nuevaDirectriz) {
      directrices.push({
        id: Date.now(),
        regla: parsed.accion.nuevaDirectriz,
        fechaISO: new Date().toISOString(),
        origen: `WhatsApp (${nombreDirector})`
      });
      guardarDirectrices(directrices);
    } else if (parsed.accion?.tipo === 'GUARDAR_CRITERIO_ESCALAMIENTO' && parsed.accion?.nuevoCriterio) {
      agregarCriterioDirector(parsed.accion.nuevoCriterio);
    }

    return parsed.respuestaWhatsApp || `Con gusto, a sus órdenes para cualquier consulta de prospectos o agenda comercial de ${nombreEmpresa}. 👑`;
  } catch (error) {
    console.error('⚠️ [COPILOTO DIRECTOR] Error procesando consulta:', error.message);
    return `👑 *Hola ${nombreDirector}*\n\nHe recibido su mensaje. Actualmente hay ${leads.length} prospectos en cartera y ${leadsHoy.length} con actividad hoy.\n\nPara ver el panel completo: ${obtenerUrlGlobalApp()}`;
  }
}
