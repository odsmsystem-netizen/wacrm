# agent/main.py — Servidor FastAPI + Webhook de WhatsApp
# Generado por AgentKit

"""
Servidor principal del agente de WhatsApp.
Funciona con cualquier proveedor (Meta, Twilio) gracias a la capa de providers.
"""

import os
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import PlainTextResponse, FileResponse
from dotenv import load_dotenv

from agent.memory import inicializar_db, migrar_vendedores
from agent.tools import leer_vendedores_semilla, refrescar_cache_vendedores
from agent.providers import obtener_proveedor
from agent.admin import router as admin_router, sembrar_usuario_inicial
from agent.conversacion import atender_mensaje
from agent.health_tunel import vigilar_tunel
from agent.programador import programar_sync_diario
from agent.sondeo_wacrm import sondear_wacrm

load_dotenv()

# Configuración de logging — LOG_LEVEL es independiente de ENVIRONMENT (que
# no controla nada más en el código): así se puede tener logging normal
# (INFO) mientras se sigue en desarrollo/pruebas, sin fingir que ya es
# producción. Sube a DEBUG en .env solo cuando de verdad haga falta
# depurar algo puntual — DEBUG genera muchísimo ruido (aiosqlite, httpx).
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, LOG_LEVEL, logging.INFO)
logging.basicConfig(level=log_level)
logger = logging.getLogger("agentkit")

# Proveedor de WhatsApp (se configura en .env con WHATSAPP_PROVIDER)
proveedor = obtener_proveedor()
PORT = int(os.getenv("PORT", 8000))

# Transcripciones que se le mandan al vendedor asignado con cada cotización
# (ver agent/tools.py: generar_cotizacion). Se sirven por HTTP porque Twilio
# necesita una URL pública para poder adjuntar el archivo al WhatsApp.
TRANSCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "transcripts")
os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializa la base de datos y arranca el vigilante del túnel."""
    await inicializar_db()
    await sembrar_usuario_inicial()
    logger.info("Base de datos inicializada")

    # Vendedores: viven en la base (no en el YAML) para que funcionen en
    # Railway sin publicar datos de empleados en el repo público. El YAML
    # solo siembra la tabla la primera vez; después manda la base.
    sembrados = await migrar_vendedores(leer_vendedores_semilla())
    if sembrados:
        # La semilla viene del YAML en local y de VENDEDORES_SEED_JSON en
        # Railway (el YAML no llega alla, ver agent/tools.py).
        logger.info(f"Vendedores sembrados: {sembrados}")
    await refrescar_cache_vendedores()
    logger.info(f"Servidor AgentKit corriendo en puerto {PORT}")
    logger.info(f"Proveedor de WhatsApp: {proveedor.__class__.__name__}")

    # Tareas de fondo. Cada una trae su propio interruptor en .env:
    #   HEALTH_TUNEL_ENABLED     — vigilante del túnel (solo aplica en local)
    #   SYNC_PROGRAMADO_ENABLED  — sync diario de NetSuite (sustituye al
    #                              Task Scheduler de Windows en Railway)
    #   SONDEO_WACRM_ENABLED     — trae los mensajes nuevos del CRM (solo
    #                              corre si WHATSAPP_PROVIDER=wacrm)
    tareas_fondo = [
        asyncio.create_task(vigilar_tunel()),
        asyncio.create_task(programar_sync_diario()),
        asyncio.create_task(sondear_wacrm()),
    ]

    yield

    # Apagado limpio: cancelar todas para que no queden colgadas
    for tarea in tareas_fondo:
        tarea.cancel()
    for tarea in tareas_fondo:
        try:
            await tarea
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="AgentKit — WhatsApp AI Agent (Ambar Cargo)",
    version="1.0.0",
    lifespan=lifespan
)
app.include_router(admin_router)


@app.middleware("http")
async def cabeceras_seguridad(request: Request, call_next):
    """Cabeceras mínimas sin dependencias — sobre todo relevantes para /admin."""
    respuesta = await call_next(request)
    respuesta.headers["X-Content-Type-Options"] = "nosniff"
    respuesta.headers["X-Frame-Options"] = "SAMEORIGIN"
    respuesta.headers["Referrer-Policy"] = "no-referrer"
    return respuesta


@app.get("/")
async def health_check():
    """Endpoint de salud para Railway/monitoreo."""
    return {"status": "ok", "service": "agentkit"}


@app.get("/transcripts/{archivo}")
async def descargar_transcripcion(archivo: str):
    """
    Sirve el archivo de transcripción que se le manda al vendedor asignado
    junto con cada cotización. El nombre es un id opaco (no el teléfono del
    cliente — ver agent/tools.py), y se valida que no incluya separadores de
    ruta para no poder salir de TRANSCRIPTS_DIR.
    """
    if "/" in archivo or "\\" in archivo or ".." in archivo:
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")
    ruta = os.path.join(TRANSCRIPTS_DIR, archivo)
    if not os.path.isfile(ruta):
        raise HTTPException(status_code=404, detail="Transcripción no encontrada")
    return FileResponse(ruta, media_type="text/plain", filename=archivo)


@app.get("/webhook")
async def webhook_verificacion(request: Request):
    """Verificación GET del webhook (requerido por Meta Cloud API, no-op para otros)."""
    resultado = await proveedor.validar_webhook(request)
    if resultado is not None:
        return PlainTextResponse(str(resultado))
    return {"status": "ok"}


@app.post("/webhook")
async def webhook_handler(request: Request):
    """
    Recibe mensajes de WhatsApp via el proveedor configurado.
    Procesa el mensaje, genera respuesta con Claude y la envía de vuelta.
    """
    try:
        # Parsear webhook — el proveedor normaliza el formato
        mensajes = await proveedor.parsear_webhook(request)

        for msg in mensajes:
            # Ignorar mensajes propios o vacíos
            if msg.es_propio or not msg.texto:
                continue

            logger.info(f"Mensaje de {msg.telefono}: {msg.texto}")

            # Mismo camino que usa el sondeo del CRM (agent/conversacion.py):
            # historial, guardado y envío viven ahí para que las dos vías de
            # entrada no puedan desincronizarse.
            await atender_mensaje(msg.telefono, msg.texto, proveedor=proveedor)

        return {"status": "ok"}

    except Exception as e:
        logger.error(f"Error en webhook: {e}")
        raise HTTPException(status_code=500, detail=str(e))
