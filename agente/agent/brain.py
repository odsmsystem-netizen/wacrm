# agent/brain.py — Cerebro del agente: conexión con Claude API
# Generado por AgentKit

"""
Lógica de IA del agente. Lee el system prompt de prompts.yaml y genera
respuestas usando la API de Anthropic Claude, con tool-use habilitado para
que el agente pueda consultar el catálogo, agendar citas, tomar pedidos,
registrar leads y abrir tickets de soporte durante la conversación.
"""

import os
import yaml
import logging
import inspect
from datetime import datetime
from functools import partial
from anthropic import AsyncAnthropic
from dotenv import load_dotenv

from agent import tools as biz_tools

load_dotenv()
logger = logging.getLogger("agentkit")

client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
MODEL = "claude-sonnet-4-6"
MAX_TURNOS_HERRAMIENTA = 8  # tope de idas y vueltas de tool-use por mensaje


def cargar_config_prompts() -> dict:
    """Lee toda la configuración desde config/prompts.yaml."""
    try:
        with open("config/prompts.yaml", "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        logger.error("config/prompts.yaml no encontrado")
        return {}


_DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
_MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
          "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def _contexto_fecha() -> str:
    """Fecha real de HOY, en español. Sin esto, el modelo no tiene forma de
    saber qué año es y puede agendar citas o interpretar plazos en el año
    equivocado (se detectó en pruebas: una cita para "el 5 de agosto" se
    agendó en 2025 en vez de 2026)."""
    ahora = datetime.now()
    dia_semana = _DIAS[ahora.weekday()]
    return (f"Hoy es {dia_semana} {ahora.day} de {_MESES[ahora.month]} de {ahora.year}, "
            f"{ahora.strftime('%H:%M')} hora local. Usa esta fecha como referencia real "
            f"para cualquier plazo, cita o fecha relativa que mencione el cliente "
            f"('mañana', 'el próximo lunes', 'el 5 de agosto', etc.). Nunca asumas un año "
            f"distinto al de hoy salvo que el cliente lo diga explícitamente.")


def cargar_system_prompt_base() -> str:
    """La parte ESTABLE del prompt: la misma en cada llamada y para cada
    cliente. Se mantiene separada de la fecha a propósito — es lo que
    permite cachearla (ver `_system_para_api`)."""
    config = cargar_config_prompts()
    return config.get("system_prompt", "Eres un asistente útil. Responde en español.")


def cargar_system_prompt() -> str:
    """Prompt completo, con la fecha. Se conserva para quien lo use suelto
    (pruebas, el playground); la ruta de producción arma los bloques por
    separado para no romper el caché."""
    return f"{cargar_system_prompt_base()}\n\n## Fecha y hora actual\n{_contexto_fecha()}"


def _system_para_api() -> list[dict]:
    """El prompt en dos bloques, y el orden importa.

    El primero es el texto estable —unos 5.300 tokens que, con las 16
    herramientas, suman más de 10.000 de entrada en CADA ida y vuelta, y
    una cotización encadena cuatro o cinco—. Va marcado como cacheable:
    el marcador cachea todo lo que tiene delante, herramientas incluidas.

    El segundo es la fecha y hora, y va DESPUÉS y sin marcar por una razón
    concreta: incluye los minutos, así que cambia cada 60 segundos. Dentro
    del bloque cacheado invalidaría el caché una vez por minuto — es
    decir, casi siempre, porque las conversaciones no son continuas. Fuera,
    el bloque grande sobrevive y solo viajan los ~90 tokens de la fecha.

    Medido: 2,5-3,0 s por turno sin caché, 1,9-2,0 s con él, y el 97 % de
    los tokens de entrada pasan a costar una décima parte.
    """
    return [
        {
            "type": "text",
            "text": cargar_system_prompt_base(),
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": f"## Fecha y hora actual\n{_contexto_fecha()}",
        },
    ]


def obtener_mensaje_error() -> str:
    config = cargar_config_prompts()
    return config.get("error_message", "Lo siento, estoy teniendo problemas técnicos. Por favor intenta de nuevo en unos minutos.")


def obtener_mensaje_fallback() -> str:
    config = cargar_config_prompts()
    return config.get("fallback_message", "Disculpa, no entendí tu mensaje. ¿Podrías reformularlo?")


# ── Herramientas disponibles para Claude ──────────────────────────────────
#
# El número de teléfono NUNCA se expone como parámetro que el modelo tenga
# que adivinar o escribir: se inyecta aquí desde el mensaje real de WhatsApp,
# así el modelo no puede (ni por error ni por instrucción de un tercero en el
# chat) actuar sobre un número de teléfono distinto al de la conversación.

TOOLS_SCHEMA = [
    {
        "name": "consultar_catalogo",
        "description": (
            "Busca artículos, precios y existencias en el catálogo de Ambar Cargo "
            "(sincronizado desde NetSuite). Úsala siempre que el cliente pregunte por "
            "un producto, precio o disponibilidad — nunca inventes precios. El resultado "
            "ya viene con el precio correcto resuelto (no decidas tú la escala). Si el "
            "artículo es cable o cadena y el cliente ya dijo cuántos metros necesita, "
            "pasa 'cantidad' para que el precio salga en la escala correcta.\n\n"
            "CÓMO LEER LA RESPUESTA:\n"
            "- 'total_coincidencias' es cuántos artículos coinciden EN TOTAL.\n"
            "- 'mostrados' es cuántos te devolví (los más relevantes).\n"
            "- 'hay_mas': si viene en true, NO has visto todo el catálogo que coincide. "
            "NUNCA digas 'esto es todo lo que tenemos', 'solo manejamos esta marca' ni "
            "'no hay otra opción' cuando hay_mas sea true — sería falso. En ese caso, o "
            "subes 'limite' para ver más, o buscas con términos más específicos, o le "
            "preguntas al cliente para acotar.\n"
            "- 'palabras_ignoradas': si viene con algo, tu búsqueda exacta no encontró "
            "nada y se relajó quitando esas palabras. Los resultados son APROXIMADOS. "
            "Díselo al cliente ('no encontré exactamente eso, pero tengo esto otro') en "
            "vez de presentarlos como si fueran justo lo que pidió.\n"
            "- Si buscas algo genérico ('polipasto de 5 ton') sube 'limite' a 15 o 20 "
            "para poder comparar marcas y precios antes de responder. Presenta las "
            "opciones con existencia ordenadas de menor a mayor precio: el cliente tiene "
            "derecho a ver la más barata que le sirva."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "consulta": {"type": "string", "description": "Nombre o código del artículo a buscar"},
                "cantidad": {"type": "number", "description": "Cantidad que el cliente ya mencionó (metros, si es cable/cadena). Omite si no la ha dicho."},
                "limite": {"type": "integer", "description": "Cuántos resultados devolver (default 5). Súbelo a 15-20 en búsquedas genéricas donde haya que comparar marcas o precios."},
            },
            "required": ["consulta"],
        },
    },
    {
        "name": "obtener_horario",
        "description": "Devuelve el horario de atención de Ambar Cargo.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "buscar_en_knowledge",
        "description": "Busca en los archivos de referencia del negocio (FAQ, políticas, catálogos generales) subidos por Ambar Cargo.",
        "input_schema": {
            "type": "object",
            "properties": {"consulta": {"type": "string", "description": "Tema o palabra clave a buscar"}},
            "required": ["consulta"],
        },
    },
    {
        "name": "agendar_cita",
        "description": "Agenda una cita o visita de servicio técnico para el cliente que está escribiendo. Si la visita es en las instalaciones del cliente (servicio técnico a domicilio), pide también la dirección — sin eso el técnico no sabe a dónde presentarse.",
        "input_schema": {
            "type": "object",
            "properties": {
                "servicio": {"type": "string", "description": "Qué servicio se va a atender (ej. mantenimiento de polipasto)"},
                "fecha": {"type": "string", "description": "Fecha en formato YYYY-MM-DD"},
                "hora": {"type": "string", "description": "Hora en formato HH:MM (24h)"},
                "nombre_cliente": {"type": "string", "description": "Nombre de la persona o empresa, si lo dio"},
                "direccion": {"type": "string", "description": "Dirección donde se debe presentar el técnico, si la visita es a domicilio/planta del cliente"},
            },
            "required": ["servicio", "fecha", "hora"],
        },
    },
    {
        "name": "ver_mis_citas",
        "description": "Lista las citas ya agendadas por el cliente que está escribiendo.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "cancelar_cita",
        "description": "Cancela una cita existente del cliente que está escribiendo.",
        "input_schema": {
            "type": "object",
            "properties": {"cita_id": {"type": "integer", "description": "ID de la cita a cancelar"}},
            "required": ["cita_id"],
        },
    },
    {
        "name": "registrar_interes_venta",
        "description": "Registra un interés de compra o proyecto (lead) Y le avisa de inmediato por WhatsApp a un vendedor sorteado al azar para que le dé seguimiento real. Úsala cuando el cliente muestre intención de compra clara, o cada vez que le digas que 'un ejecutivo de ventas lo va a contactar' — respalda esa promesa con esta herramienta en el mismo turno. Antes de llamarla, pide nombre y empresa si no los tienes (para que el vendedor sepa a quién está contactando).",
        "input_schema": {
            "type": "object",
            "properties": {
                "interes": {"type": "string", "description": "Qué le interesa comprar o qué proyecto tiene"},
                "nombre": {"type": "string", "description": "Nombre del cliente, si lo dio"},
                "empresa": {"type": "string", "description": "Empresa a la que pertenece el cliente, si la dio"},
            },
            "required": ["interes"],
        },
    },
    {
        "name": "agregar_al_pedido",
        "description": "Agrega un artículo del catálogo al pedido en curso del cliente. Usa el código exacto que devolvió consultar_catalogo.",
        "input_schema": {
            "type": "object",
            "properties": {
                "codigo": {"type": "string", "description": "Código del artículo en el catálogo"},
                "cantidad": {"type": "number", "description": "Cantidad solicitada"},
            },
            "required": ["codigo", "cantidad"],
        },
    },
    {
        "name": "ver_pedido_actual",
        "description": "Muestra los artículos y el total del pedido en curso del cliente.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "confirmar_pedido",
        "description": "Confirma y cierra un pedido SENCILLO del cliente, sin generar nada formal en NetSuite. Úsala solo si el cliente NO pidió cotización formal — si la pidió, sigue el flujo de verificar_cliente_existente / generar_oportunidad en su lugar.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "verificar_cliente_existente",
        "description": "Cuando el cliente pide una cotización formal, ANTES de generar nada, pregúntale si ya es cliente registrado de Ambar Cargo. Si dice que sí, pídele el nombre exacto con el que se registró (razón social o nombre de la persona) y llama esta herramienta con 'nombre'. Si no encuentra un match seguro, prueba con 'rfc'. Si encontrado=true, el cliente YA tiene un vendedor asignado — dile que lo vas a conectar con él y usa notificar_vendedor_cliente_existente (NO generes cotización/oportunidad). Si encontrado=false, no adivines: pídele al cliente que confirme o corrija el nombre/RFC exacto; si después de intentarlo sigue sin encontrarse, trátalo como cliente nuevo.",
        "input_schema": {
            "type": "object",
            "properties": {
                "nombre": {"type": "string", "description": "Nombre o razón social exacta con la que el cliente dice estar registrado"},
                "rfc": {"type": "string", "description": "RFC del cliente, si el nombre no dio un match seguro"},
            },
        },
    },
    {
        "name": "notificar_vendedor_cliente_existente",
        "description": "Cliente YA encontrado por verificar_cliente_existente: canaliza el aviso a su vendedor asignado (NO genera ningún Estimate/Opportunity — el vendedor da seguimiento con su propio proceso). Pasa salesrep_id, cliente_netsuite_id y cliente_nombre exactamente como los devolvió verificar_cliente_existente. La herramienta regresa 'mensaje_cliente': usa ESE texto (tal cual o casi textual) como tu respuesta al cliente — no compongas tú el cierre.",
        "input_schema": {
            "type": "object",
            "properties": {
                "salesrep_id": {"type": "string", "description": "salesrep_id devuelto por verificar_cliente_existente"},
                "cliente_netsuite_id": {"type": "string", "description": "cliente.netsuite_id devuelto por verificar_cliente_existente"},
                "cliente_nombre": {"type": "string", "description": "cliente.nombre devuelto por verificar_cliente_existente"},
            },
            "required": ["salesrep_id"],
        },
    },
    {
        "name": "registrar_datos_cliente",
        "description": "Guarda los datos de contacto y fiscales de un cliente NUEVO (no encontrado por verificar_cliente_existente): nombre completo, empresa, correo, RFC. Pídelos y llama esta herramienta ANTES de generar_oportunidad — sin estos datos completos no se puede generar.",
        "input_schema": {
            "type": "object",
            "properties": {
                "nombre_completo": {"type": "string"},
                "empresa": {"type": "string"},
                "correo": {"type": "string"},
                "rfc": {"type": "string"},
            },
        },
    },
    {
        "name": "generar_oportunidad",
        "description": "SOLO para clientes NUEVOS (no encontrados por verificar_cliente_existente): genera una Opportunity FORMAL en NetSuite con los artículos del pedido en curso, y sortea un vendedor de Ambar Cargo para darle seguimiento. Requiere que el cliente ya haya aceptado el/los precio(s), que ya haya artículos en su pedido (agregar_al_pedido), y que ya se hayan guardado sus datos completos (registrar_datos_cliente). Si faltan datos, el resultado te dice cuáles — pídelos y reintenta.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "crear_ticket_soporte",
        "description": "Abre un ticket de soporte post-venta para un problema reportado por el cliente.",
        "input_schema": {
            "type": "object",
            "properties": {"problema": {"type": "string", "description": "Descripción del problema reportado"}},
            "required": ["problema"],
        },
    },
    {
        "name": "consultar_tickets_soporte",
        "description": "Lista los tickets de soporte abiertos por el cliente que está escribiendo.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

# Herramientas que necesitan el teléfono del cliente inyectado automáticamente
_REQUIERE_TELEFONO = {
    "consultar_catalogo",
    "agendar_cita", "ver_mis_citas", "cancelar_cita", "registrar_interes_venta",
    "agregar_al_pedido", "ver_pedido_actual", "confirmar_pedido",
    "notificar_vendedor_cliente_existente",
    "registrar_datos_cliente", "generar_oportunidad",
    "crear_ticket_soporte", "consultar_tickets_soporte",
}

_FUNCIONES = {
    "consultar_catalogo": biz_tools.consultar_catalogo,
    "obtener_horario": biz_tools.obtener_horario,
    "buscar_en_knowledge": biz_tools.buscar_en_knowledge,
    "agendar_cita": biz_tools.agendar_cita,
    "ver_mis_citas": biz_tools.ver_mis_citas,
    "cancelar_cita": biz_tools.cancelar_cita,
    "registrar_interes_venta": biz_tools.registrar_interes_venta,
    "agregar_al_pedido": biz_tools.agregar_al_pedido,
    "ver_pedido_actual": biz_tools.ver_pedido_actual,
    "confirmar_pedido": biz_tools.confirmar_pedido,
    "verificar_cliente_existente": biz_tools.verificar_cliente_existente,
    "notificar_vendedor_cliente_existente": biz_tools.notificar_vendedor_cliente_existente,
    "registrar_datos_cliente": biz_tools.registrar_datos_cliente,
    "generar_oportunidad": biz_tools.generar_oportunidad,
    "crear_ticket_soporte": biz_tools.crear_ticket_soporte,
    "consultar_tickets_soporte": biz_tools.consultar_tickets_soporte,
}


async def _ejecutar_herramienta(nombre: str, entrada: dict, telefono: str):
    fn = _FUNCIONES.get(nombre)
    if fn is None:
        return {"ok": False, "error": f"Herramienta desconocida: {nombre}"}

    kwargs = dict(entrada or {})
    if nombre in _REQUIERE_TELEFONO:
        kwargs["telefono"] = telefono

    try:
        resultado = fn(**kwargs)
        if inspect.isawaitable(resultado):
            resultado = await resultado
        return resultado
    except Exception as exc:
        logger.exception(f"Error ejecutando herramienta {nombre}")
        return {"ok": False, "error": str(exc)}


async def generar_respuesta(mensaje: str, historial: list[dict], telefono: str = "") -> str:
    """
    Genera una respuesta usando Claude API, con tool-use para las herramientas
    de negocio (catálogo, citas, pedidos, leads, soporte).

    Args:
        mensaje: El mensaje nuevo del usuario
        historial: Lista de mensajes anteriores [{"role": "user/assistant", "content": "..."}]
        telefono: Número del cliente (para ligar citas/pedidos/leads/tickets a él)

    Returns:
        La respuesta final generada por Claude
    """
    if not mensaje or len(mensaje.strip()) < 2:
        return obtener_mensaje_fallback()

    system_prompt = _system_para_api()

    mensajes = [{"role": m["role"], "content": m["content"]} for m in historial]
    mensajes.append({"role": "user", "content": mensaje})

    try:
        for _ in range(MAX_TURNOS_HERRAMIENTA):
            response = await client.messages.create(
                model=MODEL,
                max_tokens=1024,
                system=system_prompt,
                tools=TOOLS_SCHEMA,
                messages=mensajes,
            )

            if response.stop_reason != "tool_use":
                textos = [b.text for b in response.content if b.type == "text"]
                return "\n".join(textos).strip() or obtener_mensaje_fallback()

            # El modelo pidió usar una o más herramientas: ejecutarlas y
            # devolver los resultados en el mismo turno de conversación.
            mensajes.append({"role": "assistant", "content": response.content})
            bloques_resultado = []
            for bloque in response.content:
                if bloque.type != "tool_use":
                    continue
                resultado = await _ejecutar_herramienta(bloque.name, bloque.input, telefono)
                bloques_resultado.append({
                    "type": "tool_result",
                    "tool_use_id": bloque.id,
                    "content": str(resultado),
                })
            mensajes.append({"role": "user", "content": bloques_resultado})

        logger.warning("Se agotaron los turnos de tool-use sin respuesta final")
        return obtener_mensaje_error()

    except Exception as e:
        logger.error(f"Error Claude API: {e}")
        return obtener_mensaje_error()
