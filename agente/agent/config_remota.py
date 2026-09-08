# agent/config_remota.py — Configuración de Claudia IA que vive en el CRM

"""
El módulo "Configuración de Claudia IA" del CRM (wacrm, Next.js) es donde un
administrador arma, desde el navegador, la base de conocimiento (documentos,
imágenes, URLs), la personalidad (1..5) y comportamientos adicionales de
Claudia. Este archivo es el lado Python: baja esa configuración y la
mantiene en memoria para que brain.py la use.

A propósito NO depende de WHATSAPP_PROVIDER — a diferencia de
agent/wacrm_crm.py, que solo tiene sentido cuando los mensajes de verdad
entran por el CRM (necesita el conversation_id que pone el sondeo). Aquí no:
un negocio puede seguir mandando mensajes por Twilio y aun así configurar a
Claudia desde el panel del CRM. Lo único que decide si este módulo hace algo
es si hay CRM configurado (WACRM_URL + WACRM_API_KEY), ver `activo()`.

Igual que wacrm_crm, el estado vive en memoria: es la última configuración
BUENA conocida, no un registro. Si el CRM no responde se conserva y Claudia
sigue con lo último que sí bajó — nunca se queda sin prompt por un problema
de red.
"""

import asyncio
import logging
import os
import httpx

logger = logging.getLogger("agentkit")

_TIMEOUT = 20.0

# Última configuración buena conocida. Arranca vacía: antes de la primera
# vuelta exitosa (o si nunca hay CRM configurado), `obtener_prompt_extra()`
# devuelve "" y todo se comporta exactamente como antes de que existiera
# este módulo — ver el requisito en brain.py:cargar_system_prompt_base.
_ESTADO: dict = {
    "revision": 0,
    "prompt_extra": "",
}

# Una vez que el CRM contesta 403 (falta el scope claudia:read), no tiene
# caso seguir preguntando: la clave no va a ganar el permiso sola, y sin
# este freno el log se llena de la misma línea una vez por minuto durante
# días. Se avisa UNA vez y el ciclo de refresco se detiene solo.
_permiso_denegado = False

# Tareas de reporte de consumo disparadas en segundo plano (ver
# `reportar_uso_en_fondo`). Sin guardar la referencia, asyncio puede
# recolectar la tarea antes de que corra y avisar "Task was destroyed but
# it is pending" — el done_callback la saca de aquí sola al terminar.
_tareas_reporte: set = set()


def _config() -> tuple[str, str]:
    return (
        os.getenv("WACRM_URL", "").rstrip("/"),
        os.getenv("WACRM_API_KEY", "").strip(),
    )


def activo() -> bool:
    """True si hay CRM configurado para bajar la configuración de Claudia.

    Ver la nota del encabezado: no depende de WHATSAPP_PROVIDER a propósito.
    """
    url, key = _config()
    return bool(url and key)


def _intervalo() -> float:
    try:
        return max(5.0, float(os.getenv("CLAUDIA_CONFIG_INTERVALO", "60")))
    except ValueError:
        return 60.0


def obtener_prompt_extra() -> str:
    """Lo que brain.py pega al final del prompt estable. Cadena vacía si
    nunca hubo CRM configurado o si aún no bajó nada — en ambos casos el
    prompt queda igual que antes de que existiera este módulo."""
    return _ESTADO["prompt_extra"]


def _aplicar(datos: dict) -> None:
    """Reemplaza la configuración en memoria por la que acaba de llegar.

    Solo se llama cuando `sin_cambios` es False, es decir, cuando la
    revisión de verdad cambió (ver `_actualizar`). Es el único punto que
    toca `_ESTADO["prompt_extra"]` — el texto que termina dentro del
    bloque cacheado del prompt — así que es también el único lugar donde
    ese texto puede cambiar entre una llamada a Claude y la siguiente.
    """
    _ESTADO["revision"] = datos.get("revision", _ESTADO["revision"])
    _ESTADO["prompt_extra"] = datos.get("prompt_extra") or ""
    logger.info(
        "Configuración de Claudia actualizada desde el CRM (revisión %s): "
        "personalidad=%s, fuentes=%s, comportamientos=%s",
        _ESTADO["revision"], datos.get("personalidad"),
        datos.get("fuentes"), datos.get("comportamientos"),
    )


async def _actualizar(client: httpx.AsyncClient, url: str, api_key: str) -> bool:
    """Una vuelta de refresco. Devuelve False si hay que dejar de intentar
    (403 de scope) y True en cualquier otro caso — incluido un fallo de
    red, que simplemente se reintenta en la próxima vuelta conservando lo
    que ya había.

    SIEMPRE se manda el `since` de la revisión que ya se tiene, y esto es
    crítico, no un detalle de eficiencia: `prompt_extra` termina pegado
    DENTRO del bloque cacheado del prompt (ver brain.py:_system_para_api),
    y el caché de prompts de Anthropic casa por texto EXACTO. Si este
    bloque cambiara de texto sin que la configuración de verdad haya
    cambiado —por ejemplo, si se pidiera la config completa en cada vuelta
    y el CRM la sirviera con espacios o un orden de campos ligeramente
    distinto— el caché se caería en cada refresco, y CADA turno de
    conversación después de eso pagaría el precio de un prompt sin cachear
    (varias veces más caro, ver la medición en _system_para_api). Por eso
    el contrato es explícito: `sin_cambios: true` cuando la revisión no
    cambió, y con eso `_ESTADO["prompt_extra"]` ni se toca.
    """
    global _permiso_denegado

    try:
        r = await client.get(
            f"{url}/api/v1/claudia/config",
            params={"since": _ESTADO["revision"]},
            headers={"Authorization": f"Bearer {api_key}"},
        )
    except Exception as e:
        logger.warning(f"No se pudo consultar la configuración de Claudia en el CRM: {e}")
        return True

    if r.status_code == 403:
        if not _permiso_denegado:
            logger.error(
                "El CRM rechazó la consulta de configuración de Claudia (403). "
                "A la clave le falta el scope claudia:read. Se deja de "
                "consultar hasta reiniciar el proceso — hay que generar una "
                "clave nueva con ese permiso en el CRM (Ajustes > Claves de API)."
            )
            _permiso_denegado = True
        return False

    if r.status_code != 200:
        logger.warning(f"El CRM respondió {r.status_code} al pedir la configuración de Claudia")
        return True

    try:
        cuerpo = r.json()
    except Exception as e:
        logger.warning(f"Respuesta inválida del CRM al pedir la configuración de Claudia: {e}")
        return True

    # Toda ruta /api/v1/* del CRM envuelve su respuesta en {"data": ...}
    # (ver src/lib/api/v1/respond.ts). Se desenvuelve aquí y no en cada
    # lector para que el resto del archivo trabaje con los campos planos.
    datos = cuerpo.get("data") if isinstance(cuerpo, dict) else None
    if not isinstance(datos, dict):
        logger.warning("El CRM devolvió una configuración de Claudia con forma inesperada")
        return True

    if datos.get("sin_cambios"):
        # Nada que hacer: ni se toca _ESTADO. Esta rama es la que protege
        # el caché del prompt (ver el docstring de arriba).
        return True

    _aplicar(datos)
    return True


async def refrescar_config_wacrm() -> None:
    """Tarea de fondo: mantiene la configuración de Claudia sincronizada con
    lo que el admin puso en el CRM. Arranca en el lifespan de agent/main.py,
    igual que agent/sondeo_wacrm.py:sondear_wacrm.

    Se apaga sola si no hay CRM configurado (`activo()` en False) y también
    si el CRM confirma que la clave no tiene el scope — en ambos casos
    Claudia sigue funcionando con lo último que tenía (o sin bloque extra,
    si nunca hubo nada).
    """
    if not activo():
        return

    url, api_key = _config()
    intervalo = _intervalo()
    logger.info(f"Sincronizando configuración de Claudia con el CRM cada {intervalo}s")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        while True:
            try:
                seguir = await _actualizar(client, url, api_key)
                if not seguir:
                    return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Una vuelta que falla no debe matar el refresco: se
                # conserva la última configuración buena y se reintenta.
                logger.warning(f"Fallo refrescando la configuración de Claudia: {e}")
            await asyncio.sleep(intervalo)


async def reportar_uso(modelo: str, usage) -> None:
    """Manda al CRM los contadores reales de una llamada a Anthropic.

    `usage` es el objeto `response.usage` del SDK. Los dos campos de caché
    (`cache_creation_input_tokens`, `cache_read_input_tokens`) pueden venir
    ausentes o en None —pasa siempre que ese turno no usó caché— así que se
    normalizan a 0 en vez de mandarlos tal cual: un CRM que sume estos
    contadores no debería tener que saber tratar None como cero.

    No lanza NUNCA. El reporte de consumo es contabilidad, no parte de la
    conversación: que el CRM esté caído no puede tumbar ni retrasar la
    respuesta al cliente. Mismo criterio que agent/tools.py:generar_oportunidad
    al reflejar la cotización en el CRM.
    """
    if not activo():
        return

    url, api_key = _config()
    cuerpo = {
        "modelo": modelo,
        "tokens_entrada": getattr(usage, "input_tokens", None) or 0,
        "tokens_salida": getattr(usage, "output_tokens", None) or 0,
        "tokens_cache_escritura": getattr(usage, "cache_creation_input_tokens", None) or 0,
        "tokens_cache_lectura": getattr(usage, "cache_read_input_tokens", None) or 0,
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{url}/api/v1/claudia/usage",
                json=cuerpo,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if r.status_code not in (200, 201):
            logger.warning(f"El CRM respondió {r.status_code} al reportar el consumo de Claude")
    except Exception as e:
        logger.warning(f"No se pudo reportar el consumo de Claude al CRM: {e}")


def reportar_uso_en_fondo(modelo: str, usage) -> None:
    """Dispara `reportar_uso` sin esperarlo.

    brain.py lo llama una vez por CADA llamada a Anthropic dentro del bucle
    de tool-use (hasta MAX_TURNOS_HERRAMIENTA por mensaje). Esperar esa
    llamada ahí — aunque tenga su propio try/except— seguiría sumando la
    latencia de una petición HTTP al CRM, multiplicada por turno, al tiempo
    que tarda Claudia en contestarle al cliente. Por eso se lanza como
    tarea de fondo: si el CRM está lento o caído, el cliente no lo nota.
    """
    if not activo():
        return
    tarea = asyncio.create_task(reportar_uso(modelo, usage))
    _tareas_reporte.add(tarea)
    tarea.add_done_callback(_tareas_reporte.discard)
