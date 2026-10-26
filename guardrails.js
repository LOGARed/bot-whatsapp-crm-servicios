/**
 * GUARDRAILS DETERMINISTAS DE SEGURIDAD COMERCIAL
 * Intercepta cada respuesta generada por la IA ANTES de enviarla al cliente por WhatsApp.
 * Si detecta una violación a las políticas comerciales, corrige o sustituye la respuesta.
 */

// Lista de reglas configurables para cualquier empresa
const REGLAS_PERSONALIZADAS = [
  {
    id: 'PROMESA_PRECIO_CERRADO_SIN_EVALUACION',
    // Detecta si la IA intentó dar un precio fijo definitivo inventado
    test: t => /\$\s?\d[\d,.]*\s*(mxn|pesos|usd|dólares)?\s*(cerrado|fijo|definitivo|total|neto)/i.test(t),
    correccion: 'NUNCA garantices un precio cerrado final sin evaluación previa del especialista. Ofrece un rango orientativo o invita a la llamada diagnóstica.'
  },
  {
    id: 'SERVICIOS_NO_AUTORIZADOS',
    test: t => /servicio\s+(gratuito|de por vida|sin costo para siempre)/i.test(t),
    correccion: 'No prometas servicios gratuitos ilimitados salvo que estén expresamente configurados en la oferta comercial.'
  }
];

/**
 * Evalúa si el texto cumple los guardrails
 */
export function evaluarRespuesta(texto = '') {
  const violaciones = REGLAS_PERSONALIZADAS.filter(r => r.test(texto)).map(({ id, correccion }) => ({ id, correccion }));
  return { ok: violaciones.length === 0, violaciones };
}

/**
 * Limpieza cosmética segura: remueve prefijos repetitivos, etiquetas residuales y exceso de emojis
 */
export function pulirRespuesta(texto = '') {
  let t = String(texto)
    .replace(/^\s*(Asistente|Bot|IA|Agente)\s*:\s*/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[(?!CITA_AGENDADA|TRANSFERIR_HUMANO)[A-Z_]{4,}\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Limitar a máximo 2 emojis en todo el mensaje
  const emojiRe = /\p{Extended_Pictographic}/gu;
  let count = 0;
  t = t.replace(emojiRe, m => (++count <= 2 ? m : ''));
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Respuesta segura por defecto si persiste alguna violación
 */
export const RESPUESTA_SEGURA =
  'Con mucho gusto le atiendo. Para brindarle una propuesta seria, transparente y a la medida de sus requerimientos, ¿le resultaría conveniente coordinar una breve llamada con uno de nuestros especialistas hoy o mañana? ✨';
