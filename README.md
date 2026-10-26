# 🤖 Bot de WhatsApp con IA & CRM para Negocios de Servicios, Carpinterías y Más

Sistema libre y modular de **Bot de WhatsApp con Inteligencia Artificial Multi-Agente (Google Gemini 3.8 Flash)**, Centro de Control CRM Web integrado, sincronización automática con **Google Calendar** y **Copiloto de Dirección por WhatsApp**.

Diseñado para **negocios de servicios, carpinterías de autor, talleres de fabricación a medida, despachos, remodelaciones y empresas de atención personalizada**. 100% marca blanca (white-label) y adaptable en menos de 5 minutos cambiando únicamente variables de entorno y catálogo.

---

## 🌟 Características Principales

- 🤖 **Arquitectura Multi-Agente Especializada:**
  - **Agente Principal de Ventas:** Conversación natural, empática y comercial.
  - **Agente Analista Visual (Gemini Multimodal):** Examina fotos de espacios, croquis, planos, documentos PDF y muestras de clientes.
  - **Agente Guardián de Agenda:** Extrae fechas/horas de las citas pactadas y las programa directamente en Google Calendar.
  - **Agente Calificador de Leads:** Genera automáticamente la Ficha Técnica Oficial en formato YAML con Lead Scoring (Nivel A, B, B2B, C).
  - **Agente Copiloto de Dirección:** Reconoce los números de WhatsApp de los dueños/asesores y les permite consultar métricas, estatus de leads o dar órdenes de control en tiempo real.
  - **Evaluador de Criterios de Escalamiento:** Dispara alertas inmediatas a asesores humanos cuando un prospecto supera umbrales de alto valor o criterios VIP.

- 📏 **Motor Conversacional de Longitud Adaptativa:**
  - **Breve por defecto:** Respuestas ágiles de 2 a 3 líneas (Fórmula 1 validación + 1 pregunta) para evitar abandono en móvil.
  - **Discurso profundo cuando es necesario:** Capacidad de argumentar con solidez cuando el cliente exige precios, cuestiona presupuestos o pide justificación técnica de garantías.

- 🛡️ **Detección Automática de Asesor Humano (Zero-Collision):**
  - Si un asesor o vendedor humano responde en el chat desde el celular o WhatsApp Web, el bot se silencia automáticamente para no interrumpir.

- 📅 **Sincronización Total con Google Calendar:**
  - Incluye Webhook directo de Google Apps Script con invitación automática por correo y enlace de guardado con 1 solo clic.

- 💻 **Panel CRM Web Integrado:**
  - Visualización en tiempo real de prospectos, notas de seguimiento, citas agendadas, audios, fotos y control del bot con túnel seguro 4G/5G para acceso desde el móvil.

---

## 📁 Estructura del Proyecto

```text
├── .env.example                     # Plantilla de variables de entorno y claves
├── conocimiento_empresa.js          # Cerebro y catálogo de servicios de tu empresa
├── guardrails.js                    # Filtros de seguridad comercial y anti-precios falsos
├── criterios_escalamiento.js        # Motor de reglas y alertas de clientes de alto valor
├── index.js                         # Orquestador del bot Baileys y webhook de WhatsApp
├── app_crm.js                       # Servidor API y backend del Centro de Control CRM
├── ai_agent.js                      # Agente principal con motor conversacional Gemini
├── agente_analista_visual.js        # Especialista en visión multimodal (imágenes/PDFs)
├── agente_agenda_calendar.js        # Especialista en extracción y normalización de citas
├── agente_calificador_crm.js        # Lead Scoring y generador de Ficha Técnica YAML
├── agente_copiloto_director.js      # Copiloto de Dirección ejecutiva por WhatsApp
├── google_calendar.js               # Helper de sincronización y generación de enlaces .ics
├── google_apps_script_calendar.gs   # Código listo para pegar en Google Apps Script
├── public/                          # Interfaz web del Panel CRM (HTML5/Tailwind/JS)
├── 1_INICIAR_BOT_Y_PANEL.bat        # Lanzador 1-clic para Windows
├── 2_INICIAR_EN_SEGUNDO_PLANO.vbs   # Ejecución silenciosa en segundo plano
├── 3_DETENER_BOT.bat                # Detención limpia de procesos
└── RECONECTAR_QR.bat                # Reinicio de sesión para escanear nuevo QR
```

---

## ⚡ Instalación Rápida (5 Minutos)

### 1. Clonar el repositorio e instalar dependencias
```bash
git clone https://github.com/TU_USUARIO/whatsapp-ai-crm-starter.git
cd whatsapp-ai-crm-starter
npm install
```

### 2. Configurar variables de entorno
Copia el archivo `.env.example` a `.env`:
```bash
copy .env.example .env
```
Abre `.env` y define:
- `NOMBRE_NEGOCIO`: El nombre oficial de tu empresa o marca.
- `RUBRO`: El giro de tu negocio (ej. "Clínica Dental", "Inmobiliaria", "Agencia Digital").
- `TELEFONOS_ASESORES`: Los números de WhatsApp de los asesores/dueños que recibirán alertas (ej. `"5215512345678,5215587654321"`).
- `GEMINI_API_KEY`: Tu clave gratuita de [Google AI Studio](https://aistudio.google.com/).
- `CRM_PASSWORD`: Contraseña segura para acceder al panel web.

### 3. Personalizar el conocimiento de tu empresa
Edita el archivo `conocimiento_empresa.js`:
- Define tus servicios o productos principales.
- Describe tus políticas de precios y esquemas de pago.
- Agrega las objeciones frecuentes de tus clientes con su respuesta ideal.

### 4. Iniciar el bot y escanear el QR
En Windows, haz doble clic en `1_INICIAR_BOT_Y_PANEL.bat` o ejecuta en consola:
```bash
node index.js
```
Aparecerá el código QR en la terminal. Escanéalo desde tu WhatsApp (**Dispositivos vinculados -> Vincular un dispositivo**).

¡Listo! El bot estará respondiendo mensajes y el CRM estará disponible en:  
👉 **http://localhost:3090**

---

## 📅 Configuración de Google Calendar (Opcional)

1. Ingresa a [Google Apps Script](https://script.google.com/) con la cuenta de Google de tu empresa.
2. Crea un **Nuevo proyecto** y pega el contenido del archivo `google_apps_script_calendar.gs`.
3. Configura tu token secreto en la constante `CALENDAR_AUTH_SECRET`.
4. Haz clic en **Implementar > Nueva implementación**:
   - Tipo: *Aplicación web*
   - Ejecutar como: *Yo (tu correo)*
   - Quién tiene acceso: *Cualquier persona (Anyone)*
5. Copia la URL generada y pégala en tu archivo `.env` en `GOOGLE_CALENDAR_WEBHOOK_URL`.

---

## 👑 Comandos del Copiloto por WhatsApp

Los números configurados en `TELEFONOS_ASESORES` pueden escribirle al bot desde su propio WhatsApp:
- **`#app` o `#crm`**: Envía el enlace público seguro para abrir el panel CRM desde el celular con 4G/5G.
- **`#criterios`**: Muestra las reglas de escalamiento activas.
- **Consultas ejecutivas**: *"¿Quién escribió hoy?"*, *"¿Cómo va el prospecto Carlos?"*, *"Pásame los clientes de Querétaro"*.
- **Control**: *"Pausa el bot en este chat"*, *"Pausa el bot globalmente"*, *"Reanuda el bot"*.

---

## 📄 Licencia

Este proyecto es de código abierto bajo la licencia [MIT](LICENSE). Eres libre de usarlo, modificarlo e implementarlo comercialmente para tus propios clientes.
