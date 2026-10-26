/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: WEBHOOK DE GOOGLE CALENDAR
 * ==============================================================================
 * Instrucciones de instalación:
 * 1. Ve a https://script.google.com/ e inicia sesión con la cuenta de Google de la empresa.
 * 2. Crea un "Nuevo proyecto" y pega este código reemplazando todo.
 * 3. En la línea 19, define tu CALENDAR_AUTH_SECRET (debe coincidir con CALENDAR_WEBHOOK_SECRET en tu .env).
 * 4. Haz clic en "Implementar" -> "Nueva implementación".
 *    - Tipo: Aplicación web
 *    - Ejecutar como: Yo (tu correo)
 *    - Quién tiene acceso: Cualquier persona (Anyone)
 * 5. Copia la URL generada y pégala en tu archivo .env en GOOGLE_CALENDAR_WEBHOOK_URL.
 * ==============================================================================
 */

const CALENDAR_AUTH_SECRET = "TuSecretKeySegura2026";

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: "No se recibieron datos en la petición."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const payload = JSON.parse(e.postData.contents);

    // Validación de seguridad por token compartido
    if (!payload.token || payload.token !== CALENDAR_AUTH_SECRET) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: "403 Acceso Denegado: Token de seguridad no autorizado o ausente."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const calendar = CalendarApp.getDefaultCalendar();
    const nombre = payload.nombreCliente || "Prospecto";
    const telefono = payload.telefono || "Sin teléfono";
    const ubicacion = payload.ubicacion || "Llamada Telefónica / Virtual";
    const tipoServicio = payload.tipoObra || "Servicio Profesional";

    const fechaInicio = payload.fechaInicioISO ? new Date(payload.fechaInicioISO) : new Date(Date.now() + 24 * 3600 * 1000);
    const duracionMinutos = payload.duracionMinutos || 45;
    const fechaFin = payload.fechaFinISO ? new Date(payload.fechaFinISO) : new Date(fechaInicio.getTime() + duracionMinutos * 60 * 1000);

    const titulo = "📅 Cita Comercial: " + nombre + " (" + tipoServicio + ")";
    const descripcion = "Sesión de Asesoría Comercial\n\n" +
      "👤 Cliente: " + nombre + "\n" +
      "📞 WhatsApp: " + telefono + "\n" +
      "📌 Requerimiento: " + tipoServicio + "\n" +
      "📍 Ubicación: " + ubicacion + "\n\n" +
      "Generado automáticamente por el Bot CRM con IA.";

    const options = {
      description: descripcion,
      location: ubicacion,
      sendInvites: true
    };

    if (Array.isArray(payload.invitados) && payload.invitados.length > 0) {
      options.guests = payload.invitados.join(",");
    }

    const event = calendar.createEvent(titulo, fechaInicio, fechaFin, options);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      eventId: event.getId(),
      titulo: titulo,
      fechaInicio: fechaInicio.toISOString(),
      fechaFin: fechaFin.toISOString(),
      invitados: options.guests || ""
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
