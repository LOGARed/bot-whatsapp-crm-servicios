import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.resolve('./conversaciones_guardadas');
const CRITERIOS_FILE = path.join(LOGS_DIR, '_criterios_escalamiento.json');

/**
 * Lee criterios de escalamiento activos
 */
export function leerCriteriosDirector() {
  try {
    if (fs.existsSync(CRITERIOS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CRITERIOS_FILE, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [
    {
      id: 1,
      nombre: 'Cuentas B2B / Corporativas',
      regex: '(empresa|corporativo|desarrollo|constructora|licitación|mayoreo|distribución|varias unidades|volumen)',
      descripcion: 'Cliente de perfil empresarial o compra mayorista. Requiere atención directa de asesor comercial.',
      activo: true
    },
    {
      id: 2,
      nombre: 'Presupuesto Alto / Proyecto Integral',
      regex: '(presupuesto alto|alta gama|premium|lujo|proyecto completo|casa completa|todo incluido)',
      descripcion: 'Prospecto con interés en paquete completo de alta inversión.',
      activo: true
    },
    {
      id: 3,
      nombre: 'Urgencia Inmediata',
      regex: '(urgente|de inmediato|hoy mismo|para ya|esta semana)',
      descripcion: 'Cliente con alta intención y urgencia de compra inmediata.',
      activo: true
    }
  ];
}

/**
 * Guarda los criterios en disco
 */
export function guardarCriteriosDirector(criterios) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(CRITERIOS_FILE, JSON.stringify(criterios, null, 2), 'utf8');
  } catch {}
}

/**
 * Agrega un nuevo criterio personalizado
 */
export function agregarCriterioDirector(criterio) {
  const criterios = leerCriteriosDirector();
  const nuevo = {
    id: Date.now(),
    nombre: criterio.nombre || 'Criterio Personalizado',
    regex: criterio.regex || '',
    descripcion: criterio.descripcion || criterio.nombre || '',
    fechaCreacionISO: new Date().toISOString(),
    activo: true
  };
  criterios.push(nuevo);
  guardarCriteriosDirector(criterios);
  return nuevo;
}

/**
 * EVALUADOR DE CRITERIOS DE ESCALAMIENTO A ASESORES HUMANOS
 * - Si cumple un criterio configurado -> Salta alerta inmediata al Director y asesores de venta.
 * - Si NO cumple -> El bot continúa atendiendo de forma ágil y natural hasta recopilar datos o cerrar cita.
 */
export function evaluarCriteriosEscalamiento({
  history = [],
  userMessage = '',
  diagnosticoVisual = null,
  expediente = null
}) {
  const lineasCliente = history
    .filter(l => l.startsWith('Cliente:'))
    .map(l => l.replace(/^Cliente:\s*/i, ''))
    .concat([userMessage]);

  const textoCompleto = lineasCliente.join(' \n ').toLowerCase();
  const criterios = leerCriteriosDirector();

  for (const c of criterios) {
    if (c.activo === false) continue;
    if (c.regex && new RegExp(c.regex, 'i').test(textoCompleto)) {
      return {
        debeEscalarInmediato: true,
        motivo: `🚨 PROSPECTO PRIORITARIO: ${c.nombre.toUpperCase()}`,
        tipoCriterio: c.nombre,
        explicacion: c.descripcion || c.nombre
      };
    }
  }

  return {
    debeEscalarInmediato: false,
    motivo: null,
    tipoCriterio: null,
    explicacion: 'El prospecto continúa siendo atendido por el asistente virtual.'
  };
}
