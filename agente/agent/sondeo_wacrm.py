# agent/sondeo_wacrm.py — Trae los mensajes nuevos del CRM

"""
Pregunta al CRM cada pocos segundos si llegó algo nuevo, en vez de esperar
a que el CRM avise.

Suena al revés, pero aquí es lo correcto. wacrm entrega sus webhooks con UN
SOLO intento y 5 segundos de plazo, sin reintentos, y a los 15 fallos
seguidos desactiva el endpoint por su cuenta. Claudia tarda bastante más
que eso (hasta 8 turnos de herramientas, más NetSuite en vivo), así que
cada entrega se marcaría como fallida y el webhook se apagaría solo a los
quince mensajes. Además wacrm exige que el destino sea https público y
rechaza direcciones privadas, lo que obligaría a exponer este servidor a
internet.

Sondeando, todas las llamadas SALEN de aquí: nada tiene que entrar. No hace
falta URL pública, ni certificado, ni túnel, ni abrir nada en el firewall.
El costo es latencia —unos segundos— que en WhatsApp no se nota.
"""

import asyncio
import logging
import os
import httpx

from agent import wacrm_crm
from agent.conversacion import atender_mensaje
from agent.memory import guardar_mensaje

logger = logging.getLogger("agentkit")

_TIMEOUT = 20.0

# Cuántos mensajes recientes se piden de una conversación con actividad.
# Es un tope de seguridad, no un objetivo: normalmente hay uno o dos nuevos.
_MAX_MENSAJES = 20

# Tope de conversaciones que se revisan por vuelta. Es el maximo que
# acepta el CRM; pedidas por actividad, son las 100 que se movieron mas
# recientemente.
_MAX_CONVERSACIONES = 100

# Cuántas veces se reintenta una conversación que falló antes de darla por
# perdida. Sin este tope, un mensaje que siempre rompe algo se reintentaría
# cada pocos segundos para siempre, quemando llamadas a Claude.
_MAX_INTENTOS = 3


def _config() -> tuple[str, str, float]:
    url = os.getenv("WACRM_URL", "").rstrip("/")
    api_key = os.getenv("WACRM_API_KEY", "").strip()
    # El límite del CRM son 120 peticiones por minuto POR CLAVE, y lo
    # cuenta sobre todas las rutas de /api/v1 juntas, no solo esta.
    #
    # En reposo el costo es 1 llamada por vuelta: a 2 s son 30/min, un
    # cuarto del presupuesto. Cada conversación que se mueve añade otra
    # (leer sus mensajes) más las de responder, registrar la cotización o
    # etiquetar. Con varias conversaciones activas a la vez el consumo
    # sube deprisa, así que subir el intervalo es lo primero que hay que
    # tocar si empiezan a aparecer 429 en el log.
    try:
        intervalo = float(os.getenv("SONDEO_WACRM_INTERVALO", "5"))
    except ValueError:
        intervalo = 5.0
    return url, api_key, max(2.0, intervalo)


async def _pedir(client: httpx.AsyncClient, url: str, api_key: str, ruta: str) -> dict | None:
    r = await client.get(
        f"{url}{ruta}",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    if r.status_code == 200:
        return r.json()
    # 429 es esperable si alguien baja mucho el intervalo; no es un error
    # que amerite ruido en cada vuelta, pero sí hay que verlo.
    nivel = logger.warning if r.status_code == 429 else logger.error
    nivel(f"CRM respondió {r.status_code} a {ruta}: {r.text[:200]}")
    return None


async def _mensajes(client, url, api_key, conv_id: str) -> list[dict] | None:
    """Mensajes recientes de una conversación, del más nuevo al más viejo.
    None si la llamada falló (distinto de una lista vacía)."""
    datos = await _pedir(
        client, url, api_key,
        f"/api/v1/conversations/{conv_id}/messages?limit={_MAX_MENSAJES}",
    )
    return None if datos is None else datos.get("data", [])


def _entrantes_desde(mensajes: list[dict], ultimo_id: str | None) -> tuple[list[str], str | None]:
    """Textos entrantes posteriores a `ultimo_id`, en orden cronológico, más
    el id del mensaje más reciente de la conversación.

    Se avanza por ID, no por fecha, y la razón es concreta: en wacrm el
    `last_message_at` de la conversación lo escribe la app con su propio
    reloj, mientras que el `created_at` de cada mensaje lo pone Postgres con
    el suyo. Comparar uno contra otro es comparar dos relojes distintos, y
    unos milisegundos de desfase bastarían para descartar un mensaje nuevo
    por viejo — dejando al cliente sin respuesta y sin rastro del fallo.
    Un id no depende de ningún reloj.
    """
    nuevos: list[str] = []
    encontrado = ultimo_id is None
    for m in mensajes:
        if m.get("id") == ultimo_id:
            encontrado = True
            break
        if m.get("direction") != "inbound":
            # Lo saliente incluye las propias respuestas de Claudia:
            # atenderlas sería contestarse a sí misma.
            continue
        texto = m.get("content_text")
        if texto:
            nuevos.append(texto)

    nuevos.reverse()

    # El corte quedó fuera de la ventana que pedimos: hubo más mensajes
    # de los que caben desde la última vuelta. Sin esto, la ventana
    # entera se tomaría como nueva y Claudia volvería a responder cosas
    # que ya contestó — mensajes repetidos al cliente, que es peor que
    # tardar. Se atiende solo el último, que es el que espera respuesta.
    if not encontrado:
        logger.warning(
            "La conversación avanzó más de %s mensajes desde la última "
            "revisión; se atiende solo el último para no repetir respuestas.",
            _MAX_MENSAJES,
        )
        nuevos = nuevos[-1:]

    id_mas_reciente = mensajes[0].get("id") if mensajes else ultimo_id
    return nuevos, id_mas_reciente


async def _revisar(client, url, api_key, estado: dict, fallos: dict, primera_vuelta: bool) -> None:
    # `sort=activity` y un limite explicito, y las dos cosas importan.
    #
    # Sin el orden por actividad, el CRM devuelve las conversaciones mas
    # RECIENTEMENTE CREADAS. Y una conversacion se crea una sola vez por
    # contacto y se reutiliza para siempre: un cliente de hace meses que
    # escribe hoy sigue en el puesto donde nacio su hilo. Pasados 50
    # contactos, ese cliente deja de aparecer en la primera pagina y su
    # mensaje no se responde NUNCA — sin error, sin log, sin nada que
    # distinga eso de "no escribio".
    #
    # El limite de 100 es el maximo del CRM. Si mas de 100 conversaciones
    # se mueven entre dos vueltas, el problema no es la pagina.
    datos = await _pedir(
        client, url, api_key,
        f"/api/v1/conversations?status=open&sort=activity&limit={_MAX_CONVERSACIONES}",
    )
    if not datos:
        return

    # Olvidar las conversaciones que ya no vienen en la lista (cerradas, o
    # desplazadas por otras más activas). Sin esto, `estado` y `fallos`
    # crecen para siempre en un proceso que corre semanas.
    #
    # Si una conversación olvidada se reabre, vuelve a entrar como nueva y
    # se atiende solo su último mensaje — que es exactamente lo que
    # queremos: no arrastrar a la memoria del modelo una conversación de
    # hace meses.
    vivas = {c.get("id") for c in datos.get("data", []) if c.get("id")}
    for muerta in [cid for cid in estado if cid not in vivas]:
        estado.pop(muerta, None)
        fallos.pop(muerta, None)

    for conv in datos.get("data", []):
        conv_id = conv.get("id")
        marca = conv.get("last_message_at")
        if not conv_id:
            continue

        anterior = estado.get(conv_id)

        # Atajo barato: si la conversación no se ha movido, no se pide nada
        # más. Aquí sí vale comparar `last_message_at` contra sí mismo — es
        # el mismo campo del mismo origen, no dos relojes distintos.
        if anterior and anterior["marca"] == marca and conv_id not in fallos:
            continue

        mensajes = await _mensajes(client, url, api_key, conv_id)
        if mensajes is None:
            continue  # falló la llamada; se reintenta en la próxima vuelta

        ultimo_id = anterior["ultimo_id"] if anterior else None
        textos, id_reciente = _entrantes_desde(mensajes, ultimo_id)

        # Conversación que no teníamos vista: un cliente nuevo, o un hilo
        # cerrado que se reabre. Solo interesa lo último que dijo; arrastrar
        # a la memoria del modelo mensajes de hace semanas lo confunde más
        # de lo que le aporta.
        if anterior is None:
            textos = textos[-1:]

        def marcar_visto():
            estado[conv_id] = {"marca": marca, "ultimo_id": id_reciente}
            fallos.pop(conv_id, None)

        # Primera vuelta: solo se toma nota de dónde está cada conversación.
        # Sin esto, al arrancar Claudia respondería de golpe a todos los
        # mensajes viejos de la bandeja — a clientes que quizá escribieron
        # hace semanas.
        if primera_vuelta:
            marcar_visto()
            continue

        # Un humano tomó el hilo, o alguien la silenció aquí con "Tomar
        # control". Son cosas distintas —una dice que el hilo tiene dueño,
        # la otra que aquí no se contesta— y cualquiera basta para callarse.
        # Se dan por vistos: los atendió una persona.
        if conv.get("assigned_agent_id") or conv.get("ai_autoreply_disabled"):
            # Si estaba esperando reparto automático, ya no hace falta:
            # alguien llegó antes que el temporizador.
            await wacrm_crm.marcar_tomada(conv_id)
            marcar_visto()
            continue

        if not textos:
            marcar_visto()
            continue

        telefono = (conv.get("contact") or {}).get("phone")
        if not telefono:
            logger.warning(f"Conversación {conv_id} sin teléfono; se omite")
            marcar_visto()
            continue

        # Claudia razona en teléfonos, el CRM en ids. Se apuntan aquí para
        # que las herramientas puedan registrar la cotización en el panel
        # de ESTE contacto sin volver a buscarlo.
        contact_id = conv.get("contact_id") or (conv.get("contact") or {}).get("id")
        if contact_id:
            wacrm_crm.recordar(telefono, conv_id, contact_id)

        try:
            # Si el cliente mandó varios seguidos, se responde UNA vez al
            # último: contestar cada uno sería atropellarlo. Los anteriores
            # se guardan en memoria para que el modelo los tenga de contexto.
            for previo in textos[:-1]:
                await guardar_mensaje(telefono, "user", previo)

            logger.info(f"Mensaje nuevo de {telefono} (conv {conv_id}): {textos[-1]}")
            await atender_mensaje(telefono, textos[-1])
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # El estado NO se avanza: el mensaje sigue pendiente y se
            # reintenta en la próxima vuelta. Avanzarlo antes de responder
            # haría que un fallo pasajero —Claude que no contesta, el CRM
            # reiniciándose al desplegar— perdiera el mensaje del cliente
            # para siempre, sin que nadie se entere.
            intentos = fallos.get(conv_id, 0) + 1
            fallos[conv_id] = intentos
            if intentos >= _MAX_INTENTOS:
                logger.error(
                    f"Conversación {conv_id} falló {intentos} veces; se deja de "
                    f"reintentar. ATENDER A MANO en la bandeja. Último error: {e}"
                )
                # Dejar rastro EN LA BANDEJA, no solo en el log. Aquí hay
                # un cliente esperando una respuesta que no va a llegar, y
                # un mensaje de log solo lo ve quien esté mirando la
                # consola en ese momento. Con la etiqueta, el vendedor
                # puede filtrar por ella y encontrarlo.
                try:
                    await wacrm_crm.etiquetar(telefono, ["Requiere atención"])
                except Exception:
                    logger.warning("Tampoco se pudo etiquetar %s", conv_id)
                marcar_visto()
            else:
                logger.warning(
                    f"Fallo atendiendo {conv_id} (intento {intentos}/{_MAX_INTENTOS}): {e}"
                )
            continue

        marcar_visto()


# Sin estos tres Claudia no puede atender a nadie, así que no arranca.
# Son tres y no dos: leer la lista de conversaciones y leer sus mensajes
# son permisos distintos, y es fácil crear la clave sin el segundo. Sin
# él el sondeo corre y no responde nunca — un 403 por vuelta que solo ve
# quien mire los logs.
_SCOPES_NECESARIOS = ("messages:send", "messages:read", "conversations:read")

# Estos habilitan cosas útiles pero no imprescindibles. Faltando uno,
# Claudia sigue atendiendo clientes: solo deja de hacer ese extra. Por eso
# se avisa al arrancar en vez de negarse a trabajar — y se avisa DICIENDO
# QUÉ SE PIERDE, que es lo que uno quiere saber para decidir si le importa.
_SCOPES_OPCIONALES = {
    "deals:write": "registrar la cotización en el panel del contacto",
    "conversations:write": "asignar sola la conversación que nadie toma",
    "contacts:read": "leer las etiquetas que ya tiene el contacto",
    "contacts:write": "etiquetar el contacto como Cotizado",
}


async def _revisar_permisos(client, url, api_key) -> bool:
    """Comprueba la clave contra el CRM antes de empezar. Devuelve False si
    no sirve, con un mensaje que dice exactamente qué falta."""
    try:
        datos = await _pedir(client, url, api_key, "/api/v1/me")
    except Exception as e:
        logger.error(f"No se pudo verificar la clave del CRM: {e}")
        return False
    if not datos:
        logger.error(
            "El CRM rechazó la clave (WACRM_API_KEY). Revisar que sea correcta "
            "y que no esté revocada."
        )
        return False

    tiene = set((datos.get("data", {}).get("key") or {}).get("scopes") or [])

    faltan = [s for s in _SCOPES_NECESARIOS if s not in tiene]
    if faltan:
        logger.error(
            "La clave del CRM no tiene los permisos mínimos. Faltan: %s. "
            "Los permisos no se pueden editar después de crear la clave: hay "
            "que generar otra en el CRM (Ajustes > Claves de API).",
            ", ".join(faltan),
        )
        return False

    # Los opcionales no impiden arrancar, pero callarlos sería peor: el
    # fallo aparecería más tarde como un 403 suelto, a mitad de una
    # conversación real, en vez de aquí donde se puede hacer algo.
    sin_opcionales = [s for s in _SCOPES_OPCIONALES if s not in tiene]
    if sin_opcionales:
        detalle = "; ".join(f"{s} → sin {_SCOPES_OPCIONALES[s]}" for s in sin_opcionales)
        logger.warning(
            "La clave del CRM no tiene estos permisos opcionales: %s. "
            "Claudia atenderá igual, pero esas partes no funcionarán.",
            detalle,
        )

    cuenta = (datos.get("data", {}).get("account") or {}).get("name", "?")
    logger.info(f"Clave del CRM verificada (cuenta: {cuenta})")
    return True


async def sondear_wacrm() -> None:
    """Tarea de fondo. Se apaga sola si no aplica."""
    if os.getenv("WHATSAPP_PROVIDER", "").lower().strip() != "wacrm":
        return
    if os.getenv("SONDEO_WACRM_ENABLED", "true").lower() in ("false", "0", "no"):
        logger.info("Sondeo al CRM deshabilitado (SONDEO_WACRM_ENABLED)")
        return

    url, api_key, intervalo = _config()
    if not (url and api_key):
        logger.error("Sondeo al CRM inactivo: faltan WACRM_URL o WACRM_API_KEY")
        return

    estado: dict[str, dict] = {}
    fallos: dict[str, int] = {}
    primera_vuelta = True

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        # Se comprueba antes de entrar al bucle: si la clave no sirve, más
        # vale un error claro al arrancar que un sondeo silencioso que nunca
        # responde a nadie.
        if not await _revisar_permisos(client, url, api_key):
            logger.error("Sondeo al CRM NO arrancó. Claudia no responderá por el CRM.")
            return

        logger.info(f"Sondeando el CRM cada {intervalo}s en {url}")
        while True:
            try:
                await _revisar(client, url, api_key, estado, fallos, primera_vuelta)
                # Reparte lo que nadie tomó a tiempo. Va aquí porque este
                # bucle ya está vivo cada pocos segundos: un temporizador
                # de 30 s no necesita cron ni cola propia.
                if not primera_vuelta:
                    await wacrm_crm.asignar_pendientes_vencidas()
                if primera_vuelta:
                    logger.info(
                        f"Estado inicial tomado: {len(estado)} conversaciones abiertas. "
                        "A partir de aquí solo se atiende lo nuevo."
                    )
                    primera_vuelta = False
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Una vuelta que falla no debe matar el sondeo: la red se
                # cae, el CRM se reinicia al desplegar, y esto tiene que
                # seguir vivo cuando vuelvan.
                logger.error(f"Fallo en una vuelta del sondeo: {e}")
            await asyncio.sleep(intervalo)
