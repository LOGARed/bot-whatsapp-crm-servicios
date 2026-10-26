/**
 * BASE DE CONOCIMIENTO MODULAR Y CONFIGURABLE DE LA EMPRESA
 * Modifica estos valores para adaptar el bot a cualquier giro comercial:
 * (Inmobiliaria, Salud, Agencia de Marketing, Construcción, Despacho Legal, E-commerce, etc.)
 */

export const CONOCIMIENTO_EMPRESA = {
  // 1. Identidad de Marca
  empresa: {
    nombre: process.env.NOMBRE_NEGOCIO || 'Tu Empresa',
    eslogan: 'Soluciones profesionales a tu medida',
    añoFundacion: '2020',
    descripcionCorta: process.env.RUBRO || 'Servicios profesionales y asesoría especializada',
    propuestaValor: 'Atención personalizada, altos estándares de calidad y garantía formal por escrito.',
    coberturaGeografica: process.env.UBICACION || 'Nacional / Local'
  },

  // 2. Catálogo de Servicios o Productos Principales (Ejemplos para Carpinterías, Proyectos y Servicios)
  servicios: [
    {
      nombre: 'Fabricación y Proyectos a la Medida',
      descripcion: 'Diseño y fabricación personalizada de mobiliario, carpintería residencial/comercial o servicios técnicos especializados.',
      beneficios: [
        'Propuesta y modelado 3D interactivo previo a fabricar',
        'Materiales de alta durabilidad y herrajes garantizados',
        'Ajuste milimétrico según espacio del cliente'
      ]
    },
    {
      nombre: 'Asesoría Técnica y Levantamiento en Sitio',
      descripcion: 'Evaluación técnica de requerimientos, cotas de muros o diagnóstico para cotización precisa sin sobrecostos.',
      beneficios: [
        'Orientación directa con especialista',
        'Presupuesto formal y transparente por escrito',
        'Asesoría de materiales según presupuesto'
      ]
    },
    {
      nombre: 'Servicio / Proyecto Integral Llave en Mano',
      descripcion: 'Atención completa desde el diseño inicial, fabricación, transporte hasta instalación y entrega formal.',
      beneficios: [
        'Contrato formal con fechas garantizadas',
        'Garantía por escrito de mano de obra e instalación',
        'Atención postventa garantizada'
      ]
    }
  ],

  // 3. Políticas Comerciales y Reglas de Precios
  politicasComerciales: {
    reglaPrecios: 'No brindar precios definitivos cerrados sin evaluar antes el caso o requerimientos del cliente en una breve llamada o diagnóstico.',
    esquemaPagos: 'Anticipo al formalizar y liquidación contra entrega o avance convenido.',
    garantias: 'Contrato formal por escrito con garantía de satisfacción y cumplimiento de fechas.',
    metodosPago: process.env.METODOS_PAGO || 'Transferencia interbancaria, tarjetas bancarias y planes de pago.'
  },

  // 4. Manejo de Objeciones Comunes
  objecionesFrecuentes: [
    {
      objecion: '¿Por qué no me das un precio fijo por mensaje?',
      respuestaGuia: 'Explicar cordialmente que cada proyecto o caso es personalizado y único. Dar una cifra al aire sin conocer sus requerimientos exactos sería irresponsable; por ello, un especialista le orienta en 10 minutos para darle un presupuesto exacto y sin sobrecostos.'
    },
    {
      objecion: 'Otro proveedor me cobra más barato',
      respuestaGuia: 'Destacar los 3 pilares de la empresa: materiales o metodología garantizada, contrato legal por escrito y respaldo postventa garantizado.'
    },
    {
      objecion: 'Tengo que consultarlo con mi socio / pareja',
      respuestaGuia: 'Proponer una breve sesión virtual o llamada conjunta de 15 minutos para resolver dudas técnicas con ambas partes de forma clara y transparente.'
    }
  ],

  // 5. Documentos o Materiales de Apoyo (Opcionales)
  materialesApoyo: {
    brochureGeneral: 'Brochure informativo institucional en PDF',
    catalogoServicios: 'Catálogo de servicios y casos de éxito'
  }
};
