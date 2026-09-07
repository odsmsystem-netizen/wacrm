# agent/health_tunel.py — Vigilante del túnel de Cloudflare
# Generado por AgentKit

"""
Vigila que el túnel público siga vivo y, si se cae, lo relanza solo.

POR QUÉ EXISTE ESTO
-------------------
El agente vive detrás de un "quick tunnel" de cloudflared, que es efímero:
cuando el proceso muere, la URL desaparece — y al relanzarlo, Cloudflare
asigna una URL NUEVA y distinta. Como el webhook de Twilio apunta a la URL
vieja, el agente se queda sordo: los clientes escriben y nadie responde,
sin ningún error visible en ningún lado. Este módulo existe para que ese
silencio no pase desapercibido.

QUÉ PUEDE Y QUÉ NO PUEDE ARREGLAR SOLO
--------------------------------------
  SÍ  relanzar cloudflared y recuperar una URL pública
  SÍ  actualizar PUBLIC_BASE_URL (adjuntos de transcripciones a vendedores)
  NO  actualizar el webhook de Twilio

Lo último es una restricción de la plataforma, no una decisión de diseño:
el agente corre sobre +14155238886, el número COMPARTIDO del sandbox de
WhatsApp, que no pertenece a la cuenta. Su webhook no vive en ningún
recurso que la API pueda tocar (verificado: la cuenta tiene 0 Messaging
Services y ese número no aparece en IncomingPhoneNumbers) — solo se
configura desde la consola. Por eso, cuando la URL cambia, la alerta trae
la URL exacta lista para pegar y el agente NO recibe mensajes hasta que
alguien la pegue a mano.

Todo esto desaparece con un túnel de nombre fijo (requiere dominio en
Cloudflare) o migrando a Railway.

PUNTO CIEGO CONOCIDO
--------------------
El vigilante corre DENTRO del proceso FastAPI. Si ese proceso muere, el
vigilante muere con él y no avisa de nada. Cubre las fallas del túnel
(que es lo que de verdad se cae seguido), no las suyas propias. El panel
muestra "último chequeo hace X" justamente para que un número congelado
delate ese caso.
"""

import os
import re
import asyncio
import logging
import subprocess
from datetime import datetime

import httpx

logger = logging.getLogger("agentkit")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOUDFLARED_BIN = os.path.join(ROOT_DIR, "bin", "cloudflared.exe")
CLOUDFLARED_LOG = os.path.join(ROOT_DIR, "logs", "cloudflared.log")
HEALTH_LOG = os.path.join(ROOT_DIR, "logs", "health_tunel.log")
ENV_PATH = os.path.join(ROOT_DIR, ".env")

INTERVALO_SEG = int(os.getenv("HEALTH_TUNEL_INTERVALO", "300"))  # 5 min
TIMEOUT_CHEQUEO = 15
MAX_REINTENTOS = 3
ESPERA_URL_NUEVA = 40  # segundos máximos esperando que cloudflared publique URL

_RE_URL = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

# Proceso de cloudflared que lanzó ESTE módulo. Se guarda para no matar
# nunca un cloudflared que haya arrancado el usuario por su cuenta.
_proceso_propio: subprocess.Popen | None = None

# Estado en memoria — lo lee el panel /admin
estado_actual: dict = {
    "estado": None,          # None | "sano" | "caido" | "degradado"
    "url": None,
    "ultimo_chequeo": None,
    "ultimo_evento": None,
    "reintentos": 0,
}


# ══════════════════════════════════════════════════════════════════
# Funciones puras — el núcleo de decisión, todo testeable sin red
# ══════════════════════════════════════════════════════════════════

def extraer_url(contenido_log: str) -> str | None:
    """Saca la URL vigente del log de cloudflared.

    cloudflared reusa el mismo archivo entre reinicios, así que puede
    haber varias URLs históricas: la buena es SIEMPRE la última.
    """
    urls = _RE_URL.findall(contenido_log or "")
    return urls[-1] if urls else None


def interpretar_respuesta(status: int | None, cuerpo: str) -> tuple[bool, str]:
    """¿La respuesta HTTP significa que la cadena completa está sana?

    No basta un 200: el túnel puede estar vivo apuntando a otra cosa. Se
    exige el JSON de AgentKit para confirmar que además enruta a NUESTRA
    app — que es exactamente el camino que recorre Twilio.
    """
    if status is None:
        return False, "sin respuesta (timeout o DNS caído)"
    if status != 200:
        return False, f"HTTP {status}"
    if "agentkit" not in (cuerpo or "").lower():
        return False, "responde 200 pero no es AgentKit (el túnel apunta a otra cosa)"
    return True, "ok"


def debe_alertar(estado_previo: str | None, estado_nuevo: str) -> bool:
    """Avisar solo en CAMBIO de estado.

    Sin esto, un túnel caído toda la noche manda un WhatsApp cada 5
    minutos — 100+ mensajes que además consumen el sandbox de Twilio.
    Y arrancar el servidor con todo bien no debe despertar a nadie.
    """
    if estado_previo is None:
        return estado_nuevo != "sano"
    return estado_previo != estado_nuevo


def debe_reintentar(intentos_hechos: int) -> bool:
    """Relanzar cloudflared como máximo MAX_REINTENTOS veces seguidas.

    Si tres relanzamientos no levantaron el túnel, el problema no es
    cloudflared (sin internet, Cloudflare caído, binario corrupto) y
    seguir spawneando procesos solo empeora las cosas.
    """
    return intentos_hechos < MAX_REINTENTOS


def espera_backoff(intento: int) -> int:
    """Espera creciente entre relanzamientos: 5s, 15s, 45s."""
    return 5 * (3 ** intento)


def reescribir_env(contenido: str, clave: str, valor: str) -> str:
    """Reemplaza (o agrega) `clave=valor` conservando el resto del archivo.

    Se hace a mano en vez de con una librería porque el .env tiene
    comentarios que explican cada variable y queremos preservarlos tal
    cual — reescribirlo entero los perdería.
    """
    lineas = (contenido or "").splitlines()
    encontrada = False
    salida = []

    for linea in lineas:
        # Comparar la clave EXACTA: PUBLIC_BASE_URL_ANTERIOR no es PUBLIC_BASE_URL
        if "=" in linea and linea.split("=", 1)[0].strip() == clave:
            salida.append(f"{clave}={valor}")
            encontrada = True
        else:
            salida.append(linea)

    if not encontrada:
        salida.append(f"{clave}={valor}")

    return "\n".join(salida) + "\n"


def componer_alerta(evento: str, url_anterior: str | None,
                    url_nueva: str | None, detalle: str) -> str:
    """Arma el WhatsApp de alerta.

    Regla: si la URL cambió, el mensaje DEBE traer la URL con /webhook
    lista para copiar — es la única acción que el sistema no puede hacer
    solo, y una alerta que no dice qué hacer no sirve de nada.
    Nunca incluye tokens ni valores de configuración.
    """
    sello = datetime.now().strftime("%d/%m %H:%M")

    if evento == "caido":
        return (
            f"🔴 AgentKit — túnel caído ({sello})\n\n"
            f"Motivo: {detalle}\n"
            f"URL afectada: {url_anterior or 'desconocida'}\n\n"
            "Intentando relanzarlo automáticamente..."
        )

    if evento == "url_cambiada":
        return (
            f"⚠️ AgentKit — túnel reparado con URL NUEVA ({sello})\n\n"
            f"Anterior: {url_anterior or 'desconocida'}\n"
            f"Nueva:    {url_nueva}\n\n"
            "Ya actualicé PUBLIC_BASE_URL (las transcripciones a vendedores "
            "vuelven a funcionar).\n\n"
            "⛔ FALTA TU PASO — el agente NO recibe mensajes de clientes "
            "hasta que hagas esto:\n\n"
            "Twilio Console → Messaging → Try it out → WhatsApp Sandbox "
            "Settings\n"
            'En "When a message comes in" pega:\n'
            f"{url_nueva}/webhook"
        )

    if evento == "recuperado":
        return (
            f"✅ AgentKit — túnel recuperado ({sello})\n\n"
            f"Volvió con la misma URL, no hay nada que cambiar en Twilio.\n"
            f"URL: {url_nueva}"
        )

    if evento == "degradado":
        return (
            f"🆘 AgentKit — no pude levantar el túnel ({sello})\n\n"
            f"Fallaron {MAX_REINTENTOS} intentos de relanzar cloudflared.\n"
            f"Último error: {detalle}\n\n"
            "Dejo de reintentar para no spawnear procesos en bucle.\n"
            "Se necesita revisión manual: internet, el binario en bin/, "
            "o el estado de Cloudflare."
        )

    return f"AgentKit — evento de túnel: {evento} ({sello})"


def vigilancia_activa() -> bool:
    """HEALTH_TUNEL_ENABLED=false apaga el vigilante sin tocar código.

    Útil al depurar: evita que te relance el túnel bajo los pies.
    """
    return (os.getenv("HEALTH_TUNEL_ENABLED", "true") or "").strip().lower() not in (
        "false", "0", "no", "off"
    )


# ══════════════════════════════════════════════════════════════════
# I/O — red, disco y procesos
# ══════════════════════════════════════════════════════════════════

async def chequear_url(url: str | None) -> tuple[bool, str]:
    """Pega a la URL pública y dice si la cadena completa está sana."""
    if not url:
        return False, "no hay URL de túnel conocida"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_CHEQUEO, follow_redirects=True) as client:
            r = await client.get(f"{url.rstrip('/')}/")
            return interpretar_respuesta(r.status_code, r.text)
    except Exception as e:
        return interpretar_respuesta(None, f"{type(e).__name__}: {e}")


def leer_url_actual() -> str | None:
    """Lee la URL vigente del log de cloudflared."""
    try:
        with open(CLOUDFLARED_LOG, "r", encoding="utf-8", errors="ignore") as f:
            return extraer_url(f.read())
    except FileNotFoundError:
        return None


def _registrar(mensaje: str):
    """Escribe en logs/health_tunel.log — la fuente de verdad.

    El log es más confiable que el WhatsApp: la alerta puede fallar
    (sandbox de Twilio con ventana de 24h), el archivo no.
    """
    sello = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        os.makedirs(os.path.dirname(HEALTH_LOG), exist_ok=True)
        with open(HEALTH_LOG, "a", encoding="utf-8") as f:
            f.write(f"{sello}  {mensaje}\n")
    except OSError:
        pass
    logger.info(f"[health-tunel] {mensaje}")


def actualizar_env(nueva_url: str) -> bool:
    """Actualiza PUBLIC_BASE_URL en .env y en el proceso vivo.

    os.environ importa tanto como el archivo: agent/tools.py lee
    PUBLIC_BASE_URL con os.getenv en cada llamada, así que tocarlo aquí
    hace que las transcripciones vuelvan a funcionar sin reiniciar nada.
    """
    try:
        try:
            with open(ENV_PATH, "r", encoding="utf-8") as f:
                contenido = f.read()
        except FileNotFoundError:
            contenido = ""

        with open(ENV_PATH, "w", encoding="utf-8") as f:
            f.write(reescribir_env(contenido, "PUBLIC_BASE_URL", nueva_url))

        os.environ["PUBLIC_BASE_URL"] = nueva_url
        return True
    except OSError as e:
        _registrar(f"ERROR no pude actualizar .env: {e}")
        return False


def _matar_proceso_propio():
    """Termina SOLO el cloudflared que lanzó este módulo.

    Nunca hace un kill genérico por nombre: si el usuario arrancó su
    propio cloudflared a mano, no es asunto nuestro matarlo.
    """
    global _proceso_propio
    if _proceso_propio and _proceso_propio.poll() is None:
        try:
            _proceso_propio.terminate()
            _proceso_propio.wait(timeout=10)
        except Exception:
            try:
                _proceso_propio.kill()
            except Exception:
                pass
    _proceso_propio = None


async def relanzar_cloudflared() -> str | None:
    """Relanza el túnel y espera a que publique una URL. None si no pudo."""
    global _proceso_propio

    if not os.path.exists(CLOUDFLARED_BIN):
        _registrar(f"ERROR no encuentro el binario: {CLOUDFLARED_BIN}")
        return None

    _matar_proceso_propio()

    url_previa = leer_url_actual()
    puerto = os.getenv("PORT", "8000")

    try:
        os.makedirs(os.path.dirname(CLOUDFLARED_LOG), exist_ok=True)
        _proceso_propio = subprocess.Popen(
            [
                CLOUDFLARED_BIN, "tunnel",
                "--url", f"http://127.0.0.1:{puerto}",
                "--logfile", CLOUDFLARED_LOG,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        _registrar(f"ERROR no pude lanzar cloudflared: {e}")
        return None

    # Esperar a que aparezca una URL DISTINTA de la anterior en el log
    for _ in range(ESPERA_URL_NUEVA):
        await asyncio.sleep(1)
        url = leer_url_actual()
        if url and url != url_previa:
            _registrar(f"cloudflared relanzado, URL nueva: {url}")
            return url

    _registrar("cloudflared arrancó pero no publicó URL nueva en el tiempo esperado")
    return None


async def _alertar(mensaje: str):
    """Manda el WhatsApp de alerta. Best-effort: el log ya quedó escrito.

    confirmar_entrega=True para que quede registrado si la alerta MISMA
    no llegó (el sandbox falla con 63015 si el número no interactuó en
    las últimas 24h). Una alerta que falla en silencio es peor que no
    tenerla, porque da falsa tranquilidad.
    """
    destino = os.getenv("HEALTH_TUNEL_ALERTA_WHATSAPP", "")
    if not destino:
        _registrar("sin HEALTH_TUNEL_ALERTA_WHATSAPP configurado — solo queda en el log")
        return
    try:
        # Proveedor de AVISOS, no el de clientes: esto es una alerta interna
        # al administrador. Si saliera por el CRM, el propio administrador
        # aparecería como un contacto en la bandeja y cada alerta de sistema
        # como una conversación que atender.
        from agent.providers import obtener_proveedor_avisos
        proveedor = obtener_proveedor_avisos()
        ok = await proveedor.enviar_mensaje(destino, mensaje, confirmar_entrega=True)
        _registrar(f"alerta a {destino}: {'entregada' if ok else 'NO ENTREGADA'}")
    except Exception as e:
        _registrar(f"ERROR mandando la alerta: {type(e).__name__}: {e}")


async def _transicion(nuevo_estado: str, evento: str, url_anterior: str | None,
                      url_nueva: str | None, detalle: str):
    """Aplica un cambio de estado: registra, persiste y alerta si toca."""
    previo = estado_actual["estado"]
    estado_actual["estado"] = nuevo_estado
    estado_actual["url"] = url_nueva or url_anterior
    estado_actual["ultimo_evento"] = {
        "evento": evento,
        "cuando": datetime.now().isoformat(timespec="seconds"),
        "detalle": detalle,
    }

    _registrar(f"{previo} -> {nuevo_estado} ({evento}) {detalle}")

    try:
        from agent.memory import guardar_evento_tunel
        await guardar_evento_tunel(evento, url_anterior, url_nueva, detalle)
    except Exception as e:
        _registrar(f"ERROR guardando evento en la base: {type(e).__name__}: {e}")

    if debe_alertar(previo, nuevo_estado):
        await _alertar(componer_alerta(evento, url_anterior, url_nueva, detalle))


async def _un_ciclo():
    """Un chequeo completo, con reparación si hace falta."""
    url = leer_url_actual()
    sano, motivo = await chequear_url(url)
    estado_actual["ultimo_chequeo"] = datetime.now().isoformat(timespec="seconds")

    if sano:
        if estado_actual["estado"] is None:
            # Primer chequeo del arranque con todo bien: NO es una
            # recuperación de nada. Sin esto, cada reinicio del servidor
            # dejaría un evento "recuperado" falso en el historial.
            estado_actual["estado"] = "sano"
            estado_actual["url"] = url
            _registrar(f"arranque con el túnel sano: {url}")
        elif estado_actual["estado"] != "sano":
            await _transicion("sano", "recuperado", url, url, motivo)
        estado_actual["reintentos"] = 0
        return

    # Está caído. ¿Ya nos rendimos?
    intentos = estado_actual["reintentos"]
    if not debe_reintentar(intentos):
        if estado_actual["estado"] != "degradado":
            await _transicion("degradado", "degradado", url, None, motivo)
        return

    if estado_actual["estado"] not in ("caido", "degradado"):
        await _transicion("caido", "caido", url, None, motivo)

    await asyncio.sleep(espera_backoff(intentos))
    estado_actual["reintentos"] = intentos + 1

    url_nueva = await relanzar_cloudflared()
    if not url_nueva:
        return

    sano2, motivo2 = await chequear_url(url_nueva)
    if not sano2:
        _registrar(f"relanzado pero sigue sin responder: {motivo2}")
        return

    estado_actual["reintentos"] = 0
    if url_nueva != url:
        actualizar_env(url_nueva)
        await _transicion("sano", "url_cambiada", url, url_nueva, motivo)
    else:
        await _transicion("sano", "recuperado", url, url_nueva, motivo)


async def vigilar_tunel():
    """Bucle de vigilancia. Se arranca desde el lifespan de main.py."""
    if not vigilancia_activa():
        _registrar("vigilancia DESACTIVADA (HEALTH_TUNEL_ENABLED=false)")
        return

    _registrar(f"vigilancia iniciada — cada {INTERVALO_SEG}s")
    # Margen para que uvicorn termine de levantar antes del primer chequeo
    await asyncio.sleep(10)

    while True:
        try:
            await _un_ciclo()
        except asyncio.CancelledError:
            _registrar("vigilancia detenida")
            raise
        except Exception as e:
            # Nunca dejar que un error mate el bucle: si el vigilante
            # muere en silencio, volvemos al problema original.
            _registrar(f"ERROR inesperado en el ciclo: {type(e).__name__}: {e}")
        await asyncio.sleep(INTERVALO_SEG)
