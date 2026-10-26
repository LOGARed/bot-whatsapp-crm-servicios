import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { obtenerRutasExpedienteCliente } from './historial_conversaciones.js';

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
 * Lee el archivo JSON del cliente en disco
 */
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
 * AGENTE ESPECIALISTA MULTIMODAL & ANÁLISIS VISUAL
 * Decodifica imágenes y documentos enviados por el cliente (fotos de espacios,
 * referencias, croquis, planos, especificaciones o muestras) usando Gemini Vision.
 */
export async function analizarMediaVisual({ mediaAttachment, userMessage, contactInfo, history = [] }) {
  if (!mediaAttachment || !mediaAttachment.data || !mediaAttachment.mimeType) {
    return null;
  }

  const esImagen = mediaAttachment.type === 'image' || mediaAttachment.mimeType.startsWith('image/');
  const esDocumento = mediaAttachment.type === 'document' || mediaAttachment.mimeType.includes('pdf');

  if (!esImagen && !esDocumento) {
    return null;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';
  const rubro = process.env.RUBRO || 'Servicios Profesionales';

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODELO_IA,
      generationConfig: {
        maxOutputTokens: 600,
        temperature: 0.1,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    const promptVision = `Eres el Especialista Técnico de Análisis Visual de ${nombreEmpresa} (${rubro}).
Examina este archivo visual enviado por un cliente en WhatsApp (foto, plano, croquis o documento).

Analiza detalladamente:
1. Tipo de archivo visual (Foto de espacio / Documento técnico / Muestra de producto / Croquis / Referencia de diseño).
2. Elementos observables principales (dimensiones visibles, estado actual, modelo o características relevantes).
3. Oportunidad de solución profesional según los servicios de ${nombreEmpresa}.
4. "capsulaAsistente": Redacta UNA SOLA frase corta y cordial (máximo 1 línea y media, entre 12 y 18 palabras), destacando un detalle positivo observable para que el bot responda de forma natural y empática.

Mensaje del cliente: "${userMessage || 'Sin texto adjunto'}"

Devuelve EXCLUSIVAMENTE este objeto JSON:
{
  "tipoVisual": "Foto / Documento / Plano / Muestra",
  "elementosObservables": "Descripción de lo observado",
  "dimensionesEstimadas": "Dimensiones o cotas observables o 'No especificadas'",
  "oportunidad": "Oportunidad de solución profesional",
  "capsulaAsistente": "Frase corta y halagadora para el cliente"
}`;

    const inlinePart = {
      inlineData: {
        data: mediaAttachment.data,
        mimeType: mediaAttachment.mimeType
      }
    };

    console.log(`👁️ [AGENTE VISUAL]: Analizando archivo (${mediaAttachment.fileName || mediaAttachment.type}) con visión multimodal...`);
    const res = await generarConReintento(model, [inlinePart, promptVision]);
    const rawText = res.response.text();
    const diagnostico = JSON.parse(rawText);

    // Persistir en el expediente del cliente
    try {
      const { jsonPath, data } = leerExpedienteCliente(contactInfo?.senderJid, contactInfo);
      if (jsonPath && data) {
        data.ultimoAnalisisVisual = {
          fechaISO: new Date().toISOString(),
          tipoVisual: diagnostico.tipoVisual,
          elementosObservables: diagnostico.elementosObservables,
          dimensionesEstimadas: diagnostico.dimensionesEstimadas,
          oportunidad: diagnostico.oportunidad,
          capsulaAsistente: diagnostico.capsulaAsistente
        };
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('Error guardando análisis visual:', e.message);
    }

    return diagnostico;
  } catch (error) {
    console.error('⚠️ [AGENTE VISUAL] Error al procesar imagen/documento:', error.message);
    return null;
  }
}
