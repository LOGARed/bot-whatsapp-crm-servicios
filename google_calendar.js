import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const LOGS_DIR = path.resolve('./conversaciones_guardadas');
const CITAS_FILE = path.join(LOGS_DIR, '_citas_agendadas.json');

function asegurarDirectorio() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function leerCitasAgendadas() {
  try {
    asegurarDirectorio();
    if (!fs.existsSync(CITAS_FILE)) return [];
    return JSON.parse(fs.readFileSync(CITAS_FILE, 'utf8')) || [];
  } catch {
    return [];
  }
}

export function guardarCitaEnDisco(cita) {
  try {
    asegurarDirectorio();
    const citas = leerCitasAgendadas();
    const estadoCita = cita.estado || 'pendiente_de_confirmacion';
    const idx = citas.findIndex(c => c.jid === cita.jid || c.telefono === cita.telefono);
    if (idx >= 0) {
      citas[idx] = { ...citas[idx], ...cita, estado: estadoCita, actualizadaEn: new Date().toISOString() };
    } else {
      citas.unshift({ ...cita, estado: estadoCita, creadaEn: new Date().toISOString() });
    }
    fs.writeFileSync(CITAS_FILE, JSON.stringify(citas, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error guardando cita en disco:', e.message);
    return false;
  }
}

/**
 * Verifica si un horario ya se encuentra ocupado por otra cita en el sistema
 */
export function verificarDisponibilidadHorario(fechaInicio, duracionMinutos = 45, excludeJid = null) {
  try {
    const inicioMs = (fechaInicio instanceof Date ? fechaInicio : new Date(fechaInicio)).getTime();
    if (isNaN(inicioMs)) return { disponible: true };

    const finMs = inicioMs + duracionMinutos * 60 * 1000;
    const margenMs = 10 * 60 * 1000; // 10 minutos de margen

    const citas = leerCitasAgendadas();
    for (const cita of citas) {
      if (excludeJid && cita.jid === excludeJid) continue;
      if (cita.estado === 'cancelada') continue;

      const citaInicioMs = new Date(cita.fechaInicioISO || cita.fechaInicio).getTime();
      if (isNaN(citaInicioMs)) continue;
      const citaFinMs = citaInicioMs + (cita.duracionMinutos || 45) * 60 * 1000;

      if (inicioMs < (citaFinMs + margenMs) && finMs > (citaInicioMs - margenMs)) {
        return {
          disponible: false,
          conflictoCon: {
            cliente: cita.nombreCliente || 'Otro cliente',
            horario: cita.fechaLegible || new Date(citaInicioMs).toLocaleTimeString()
          }
        };
      }
    }
    return { disponible: true };
  } catch {
    return { disponible: true };
  }
}

/**
 * Devuelve un resumen de horarios ocupados para orientar al modelo
 */
export function obtenerHorariosOcupados(fechaReferencia = new Date()) {
  try {
    const citas = leerCitasAgendadas();
    const refDate = new Date(fechaReferencia);
    const hace7d = refDate.getTime() - 2 * 86400000;
    const proximos7d = refDate.getTime() + 7 * 86400000;

    return citas
      .filter(c => {
        if (c.estado === 'cancelada') return false;
        const t = new Date(c.fechaInicioISO || c.fechaInicio).getTime();
        return t >= hace7d && t <= proximos7d;
      })
      .map(c => ({
        fechaLegible: c.fechaLegible,
        fechaInicioISO: c.fechaInicioISO,
        cliente: c.nombreCliente || 'Reservado'
      }));
  } catch {
    return [];
  }
}

/**
 * Genera la URL pública de Google Calendar para agregar el evento con 1 clic
 */
export function generarUrlGoogleCalendar(datos) {
  const {
    nombreCliente = 'Prospecto',
    telefono = '',
    fechaInicio,
    fechaFin,
    ubicacion = process.env.UBICACION || 'Llamada Telefónica / Virtual',
    tipoObra = process.env.RUBRO || 'Servicio Profesional'
  } = datos;

  const nombreEmpresa = process.env.NOMBRE_NEGOCIO || 'Tu Empresa';
  const start = (fechaInicio instanceof Date ? fechaInicio : new Date(fechaInicio))
    .toISOString().replace(/-|:|\.\d\d\d/g, '');
  const end = (fechaFin instanceof Date ? fechaFin : new Date(fechaFin))
    .toISOString().replace(/-|:|\.\d\d\d/g, '');

  const titulo = encodeURIComponent(`Cita / Llamada: ${nombreCliente} • ${nombreEmpresa}`);
  const detalles = encodeURIComponent(
    `Sesión de Asesoría Comercial - ${nombreEmpresa}\n\n` +
    `👤 Cliente: ${nombreCliente}\n` +
    `📞 Teléfono: ${telefono}\n` +
    `📌 Requerimiento: ${tipoObra}\n` +
    `📍 Ubicación: ${ubicacion}\n\n` +
    `Generado automáticamente por el Bot CRM de ${nombreEmpresa}.`
  );
  const loc = encodeURIComponent(ubicacion);

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${titulo}&dates=${start}/${end}&details=${detalles}&location=${loc}`;
}

/**
 * Sincroniza la cita con Google Calendar
 */
export async function sincronizarCitaConGoogleCalendar(datosCita) {
  const fechaInicio = datosCita.fechaInicioISO ? new Date(datosCita.fechaInicioISO) : new Date(Date.now() + 24 * 3600 * 1000);
  const fechaFin = new Date(fechaInicio.getTime() + (datosCita.duracionMinutos || 45) * 60 * 1000);

  const googleCalendarUrl = generarUrlGoogleCalendar({
    ...datosCita,
    fechaInicio,
    fechaFin
  });

  const registroCita = {
    ...datosCita,
    fechaInicioISO: fechaInicio.toISOString(),
    fechaFinISO: fechaFin.toISOString(),
    duracionMinutos: datosCita.duracionMinutos || 45,
    googleCalendarUrl,
    sincronizadoAutomatico: false
  };

  const disponibilidad = verificarDisponibilidadHorario(fechaInicio, registroCita.duracionMinutos, datosCita.jid);
  if (!disponibilidad.disponible) {
    registroCita.estado = 'pendiente_de_confirmacion';
    registroCita.conflicto = disponibilidad.conflictoCon;
  }

  // Webhook directo de Google Apps Script si está configurado en .env
  const webhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
  if (webhookUrl && webhookUrl.startsWith('https://')) {
    try {
      const correosCompartidos = (process.env.REPORT_EMAILS || '')
        .split(',')
        .map(e => e.trim())
        .filter(e => e.includes('@'));

      if (datosCita.emailCliente && datosCita.emailCliente.includes('@') && !correosCompartidos.includes(datosCita.emailCliente.trim())) {
        correosCompartidos.push(datosCita.emailCliente.trim());
      }

      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...registroCita,
          invitados: correosCompartidos,
          emailCliente: datosCita.emailCliente || null,
          token: process.env.CALENDAR_WEBHOOK_SECRET || 'WebhookSecureKey_2026'
        })
      });
      if (resp.ok) {
        registroCita.sincronizadoAutomatico = true;
        console.log('📅 [GOOGLE CALENDAR] Evento creado vía Webhook con invitados:', correosCompartidos.join(', '));
      }
    } catch (err) {
      console.error('⚠️ Error en Webhook de Google Calendar:', err.message);
    }
  }

  guardarCitaEnDisco(registroCita);
  return { ok: true, googleCalendarUrl, eventId: registroCita.eventId || '' };
}
