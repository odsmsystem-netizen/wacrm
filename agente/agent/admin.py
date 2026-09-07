# agent/admin.py — Panel de administración de Claudia (backend)
# Generado por AgentKit + /diseno-desarrollo-web

"""
Panel web para que el dueño del negocio (no un programador) pueda:
  - Editar los parámetros del agente (datos del negocio, prompt).
  - Ver métricas de clientes contactados.
  - Subir archivos o ligas de conocimiento para que Claudia los use.
  - Sincronizar el catálogo/clientes de NetSuite a demanda y ver la tabla.
  - Dar de alta/editar/eliminar vendedores y sus WhatsApp.
  - Ver indicadores (mensajes por vendedor, tiempo de respuesta, etc.).

Todo bajo /admin, protegido con una sesión de un solo usuario (contraseña
en .env — ADMIN_PASSWORD). Nunca se exponen secretos (tokens, API keys) en
ninguna respuesta de este router.
"""

import os
import re
import sys
import hmac
import time
import yaml
import secrets
import hashlib
import logging
import sqlite3
import asyncio
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Request, Response, HTTPException, UploadFile, File

from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy import select, func, text

from agent import memory
from agent.ssrf import url_es_alcanzable

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))
import db as ns_db  # noqa: E402  motor SQLite de catálogo/clientes sincronizados

logger = logging.getLogger("agentkit")
router = APIRouter(prefix="/admin")

KNOWLEDGE_DIR = os.path.join(ROOT_DIR, "knowledge")
VENDEDORES_PATH = os.path.join(ROOT_DIR, "config", "vendedores_whatsapp.yaml")
BUSINESS_PATH = os.path.join(ROOT_DIR, "config", "business.yaml")
PROMPTS_PATH = os.path.join(ROOT_DIR, "config", "prompts.yaml")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static_admin")
APRENDIZAJE_PATH = os.path.join(ROOT_DIR, "APRENDIZAJE_CONOCIMIENTO.md")

_NOMBRE_ARCHIVO_OK = re.compile(r"^[A-Za-z0-9._-]{1,200}$")


# ── Autenticación (multi-usuario, sesión firmada con HMAC) ───────────────
#
# Sin dependencias nuevas: el "token" es "usuario.expira.firma", donde
# firma = HMAC-SHA256(ADMIN_SECRET_KEY, "admin:usuario:expira"). No hay
# estado en el servidor que se pueda perder al reiniciar (a diferencia de
# un dict en memoria), y no se puede falsificar sin conocer ADMIN_SECRET_KEY.
#
# Las contraseñas viven en la tabla usuarios_admin (agent/memory.py),
# hasheadas con PBKDF2-SHA256 + salt — nunca en claro. ADMIN_PASSWORD en
# .env solo se usa una vez, para crear el primer usuario ("admin") si la
# tabla está vacía (ver sembrar_usuario_inicial, llamado desde main.py).

_SESION_HORAS = 12
_ITERACIONES_PBKDF2 = 100_000
_USUARIO_OK = re.compile(r"^[A-Za-z0-9_-]{3,40}$")


def _hash_password(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt_hex = salt_hex or secrets.token_hex(16)
    hash_hex = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), _ITERACIONES_PBKDF2
    ).hex()
    return hash_hex, salt_hex


def _verificar_password(password: str, hash_guardado: str, salt_hex: str) -> bool:
    calculado, _ = _hash_password(password, salt_hex)
    return hmac.compare_digest(calculado, hash_guardado)


async def sembrar_usuario_inicial():
    """Si no existe ningún usuario admin, crea 'admin' a partir de ADMIN_PASSWORD.
    Compatibilidad con instalaciones existentes que solo tenían esa variable."""
    if await memory.contar_usuarios_admin() > 0:
        return
    password = os.getenv("ADMIN_PASSWORD", "")
    if not password:
        logger.warning("ADMIN_PASSWORD no configurado — no se pudo crear el usuario admin inicial")
        return
    hash_hex, salt_hex = _hash_password(password)
    await memory.crear_usuario_admin("admin", hash_hex, salt_hex)
    logger.info("Usuario admin inicial creado ('admin') a partir de ADMIN_PASSWORD")


def _firmar(usuario: str, expira: int) -> str:
    clave = os.getenv("ADMIN_SECRET_KEY", "")
    firma = hmac.new(clave.encode(), f"admin:{usuario}:{expira}".encode(), hashlib.sha256).hexdigest()
    return f"{usuario}.{expira}.{firma}"


def _token_valido(token: str) -> str | None:
    """Retorna el nombre de usuario si el token es válido, o None."""
    if not token or token.count(".") != 2:
        return None
    usuario, expira_s, firma = token.split(".", 2)
    try:
        expira = int(expira_s)
    except ValueError:
        return None
    if expira < time.time():
        return None
    esperado = _firmar(usuario, expira).rsplit(".", 1)[1]
    if not hmac.compare_digest(firma, esperado):
        return None
    return usuario


def _requiere_admin(request: Request) -> str:
    """Valida la sesión y retorna el usuario autenticado."""
    usuario = _token_valido(request.cookies.get("admin_session", ""))
    if not usuario:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada, inicia sesión de nuevo.")
    return usuario


@router.post("/api/login")
async def login(request: Request):
    body = await request.json()
    usuario = str(body.get("usuario", "")).strip() or "admin"
    password = str(body.get("password", ""))
    fila = await memory.obtener_usuario_admin(usuario)
    if not fila or not _verificar_password(password, fila["password_hash"], fila["password_salt"]):
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    expira = int(time.time()) + _SESION_HORAS * 3600
    token = _firmar(usuario, expira)
    resp = JSONResponse({"ok": True, "usuario": usuario})
    # `secure` solo cuando de verdad se sirve por HTTPS: fijarlo siempre
    # rompe el acceso local por http (el navegador descarta la cookie y el
    # login parece fallar sin decir por que). Detras de un proxy —Traefik,
    # Easypanel— el esquema que ve la app es http aunque el cliente use
    # https, asi que manda la cabecera que pone el proxy.
    #
    # `strict` en vez de `lax`: este panel administra el agente entero, y
    # ningun flujo legitimo llega a el desde otro sitio.
    esquema = request.headers.get("x-forwarded-proto", request.url.scheme)
    resp.set_cookie(
        "admin_session", token,
        httponly=True,
        samesite="strict",
        secure=(esquema == "https"),
        max_age=_SESION_HORAS * 3600,
    )
    return resp


@router.post("/api/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("admin_session")
    return resp


@router.get("/api/whoami")
async def whoami(request: Request):
    usuario = _token_valido(request.cookies.get("admin_session", ""))
    return {"ok": True, "autenticado": bool(usuario), "usuario": usuario}


# ── Usuarios con acceso al panel ──────────────────────────────────────────

@router.get("/api/usuarios")
async def listar_usuarios(request: Request):
    _requiere_admin(request)
    return {"ok": True, "usuarios": await memory.listar_usuarios_admin()}


@router.post("/api/usuarios")
async def crear_usuario(request: Request):
    _requiere_admin(request)
    body = await request.json()
    usuario = str(body.get("usuario", "")).strip()
    password = str(body.get("password", ""))
    if not _USUARIO_OK.match(usuario):
        raise HTTPException(status_code=400, detail="Usuario inválido (3-40 caracteres: letras, números, _ o -)")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 8 caracteres")
    if await memory.obtener_usuario_admin(usuario):
        raise HTTPException(status_code=409, detail="Ese usuario ya existe")
    hash_hex, salt_hex = _hash_password(password)
    try:
        await memory.crear_usuario_admin(usuario, hash_hex, salt_hex)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"ok": True}


@router.put("/api/usuarios/{usuario}/password")
async def cambiar_password(request: Request, usuario: str):
    usuario_actual = _requiere_admin(request)
    body = await request.json()
    password_nueva = str(body.get("password_nueva", ""))
    if len(password_nueva) < 8:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 8 caracteres")
    fila = await memory.obtener_usuario_admin(usuario)
    if not fila:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    # Cambiar la propia contraseña exige confirmar la actual; restablecer la
    # de otro usuario (ya autenticado como admin) no la requiere.
    if usuario == usuario_actual:
        password_actual = str(body.get("password_actual", ""))
        if not _verificar_password(password_actual, fila["password_hash"], fila["password_salt"]):
            raise HTTPException(status_code=401, detail="La contraseña actual no es correcta")
    hash_hex, salt_hex = _hash_password(password_nueva)
    await memory.actualizar_password_usuario_admin(usuario, hash_hex, salt_hex)
    return {"ok": True}


@router.delete("/api/usuarios/{usuario}")
async def eliminar_usuario(request: Request, usuario: str):
    usuario_actual = _requiere_admin(request)
    if usuario == usuario_actual:
        raise HTTPException(status_code=400, detail="No puedes eliminar tu propio usuario mientras tienes sesión activa")
    if await memory.contar_usuarios_admin() <= 1:
        raise HTTPException(status_code=400, detail="Debe quedar al menos un usuario con acceso")
    if not await memory.eliminar_usuario_admin(usuario):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"ok": True}


# ── Página del panel (el shell HTML no revela datos; las APIs sí exigen sesión) ──

@router.get("")
async def panel_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@router.get("/app.js")
async def panel_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"), media_type="application/javascript")


# ── Parámetros del agente (business.yaml + prompts.yaml) ─────────────────

@router.get("/api/config")
async def obtener_config(request: Request):
    _requiere_admin(request)
    with open(BUSINESS_PATH, "r", encoding="utf-8") as f:
        business = yaml.safe_load(f) or {}
    with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
        prompts = yaml.safe_load(f) or {}
    return {
        "ok": True,
        "negocio": business.get("negocio", {}),
        "agente": business.get("agente", {}),
        "system_prompt": prompts.get("system_prompt", ""),
        "fallback_message": prompts.get("fallback_message", ""),
        "error_message": prompts.get("error_message", ""),
    }


@router.post("/api/config")
async def guardar_config(request: Request):
    _requiere_admin(request)
    body = await request.json()

    with open(BUSINESS_PATH, "r", encoding="utf-8") as f:
        business = yaml.safe_load(f) or {}
    negocio = business.setdefault("negocio", {})
    for campo in ("nombre", "descripcion", "horario"):
        if campo in body.get("negocio", {}):
            negocio[campo] = str(body["negocio"][campo])
    agente = business.setdefault("agente", {})
    for campo in ("nombre", "tono"):
        if campo in body.get("agente", {}):
            agente[campo] = str(body["agente"][campo])
    with open(BUSINESS_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(business, f, allow_unicode=True, sort_keys=False)

    if "system_prompt" in body or "fallback_message" in body or "error_message" in body:
        with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
            prompts = yaml.safe_load(f) or {}
        if "system_prompt" in body:
            prompts["system_prompt"] = str(body["system_prompt"])
        if "fallback_message" in body:
            prompts["fallback_message"] = str(body["fallback_message"])
        if "error_message" in body:
            prompts["error_message"] = str(body["error_message"])
        with open(PROMPTS_PATH, "w", encoding="utf-8") as f:
            yaml.safe_dump(prompts, f, allow_unicode=True, sort_keys=False, width=100)

    return {"ok": True}


# ── Métricas de clientes contactados ──────────────────────────────────────

@router.get("/api/metricas")
async def metricas(request: Request):
    _requiere_admin(request)
    async with memory.async_session() as session:
        clientes_unicos = (await session.execute(
            select(func.count(func.distinct(memory.Mensaje.telefono)))
        )).scalar_one()

        mensajes_totales = (await session.execute(
            select(func.count()).select_from(memory.Mensaje).where(memory.Mensaje.role == "user")
        )).scalar_one()

        leads_nuevos = (await session.execute(
            select(func.count()).select_from(memory.NotificacionVendedor)
            .where(memory.NotificacionVendedor.categoria == "lead_nuevo")
        )).scalar_one()

        clientes_existentes = (await session.execute(
            select(func.count()).select_from(memory.NotificacionVendedor)
            .where(memory.NotificacionVendedor.categoria == "cliente_existente")
        )).scalar_one()

        citas = (await session.execute(select(func.count()).select_from(memory.Cita))).scalar_one()
        tickets = (await session.execute(select(func.count()).select_from(memory.Ticket))).scalar_one()

        # Serie diaria de clientes distintos y mensajes, últimos 14 días.
        filas = (await session.execute(text(
            "SELECT substr(timestamp,1,10) AS dia, "
            "COUNT(DISTINCT telefono) AS clientes, COUNT(*) AS mensajes "
            "FROM mensajes WHERE role='user' "
            "GROUP BY dia ORDER BY dia DESC LIMIT 14"
        ))).mappings().all()
        serie = [dict(f) for f in reversed(filas)]

        # Tiempo de respuesta: delta entre cada mensaje de cliente y la
        # siguiente respuesta de Claudia en la misma conversación.
        filas_tr = (await session.execute(text(
            "SELECT AVG(delta) AS promedio FROM ("
            "  SELECT (julianday(a.timestamp) - julianday(u.timestamp)) * 86400 AS delta"
            "  FROM mensajes u"
            "  JOIN mensajes a ON a.telefono = u.telefono AND a.id = ("
            "    SELECT MIN(id) FROM mensajes a2 WHERE a2.telefono = u.telefono "
            "    AND a2.role = 'assistant' AND a2.id > u.id"
            "  )"
            "  WHERE u.role = 'user'"
            ")"
        ))).mappings().first()
        tiempo_respuesta_prom = round(filas_tr["promedio"], 1) if filas_tr and filas_tr["promedio"] is not None else None

    return {
        "ok": True,
        "clientes_unicos": clientes_unicos,
        "mensajes_totales": mensajes_totales,
        "leads_nuevos": leads_nuevos,
        "clientes_existentes_atendidos": clientes_existentes,
        "citas_agendadas": citas,
        "tickets_soporte": tickets,
        "tiempo_respuesta_promedio_seg": tiempo_respuesta_prom,
        "serie_diaria": serie,
    }


@router.get("/api/indicadores")
async def indicadores(request: Request):
    _requiere_admin(request)
    async with memory.async_session() as session:
        filas = (await session.execute(text(
            "SELECT vendedor_asignado AS vendedor, categoria, "
            "SUM(CASE WHEN notificado=1 THEN 1 ELSE 0 END) AS entregados, "
            "COUNT(*) AS total "
            "FROM notificaciones_vendedor "
            "WHERE vendedor_asignado != '' "
            "GROUP BY vendedor_asignado, categoria "
            "ORDER BY vendedor"
        ))).mappings().all()

        por_vendedor: dict[str, dict] = {}
        for f in filas:
            v = por_vendedor.setdefault(f["vendedor"], {
                "vendedor": f["vendedor"], "lead_nuevo": 0, "cliente_existente": 0,
                "entregados": 0, "total": 0,
            })
            v[f["categoria"]] = f["total"]
            v["entregados"] += f["entregados"]
            v["total"] += f["total"]

        tasa = (await session.execute(text(
            "SELECT "
            "SUM(CASE WHEN notificado=1 THEN 1 ELSE 0 END) AS entregados, COUNT(*) AS total "
            "FROM notificaciones_vendedor"
        ))).mappings().first()

    tasa_entrega = round((tasa["entregados"] / tasa["total"]) * 100, 1) if tasa and tasa["total"] else None
    return {
        "ok": True,
        "por_vendedor": sorted(por_vendedor.values(), key=lambda x: -x["total"]),
        "tasa_entrega_pct": tasa_entrega,
        "total_notificaciones": tasa["total"] if tasa else 0,
    }


# ── KPIs estratégicos (del Centro de Aprendizaje, aprobados 2026-07-31) ──
#
# Los 5 KPIs propuestos por el análisis comercial y aprobados por el
# administrador — implementados aquí como cálculos reales, no solo texto.
# Ver APRENDIZAJE_CONOCIMIENTO.md para el detalle de cada uno.

_PALABRAS_MOTIVO = {
    "Cotización / precio": ("precio", "cotiz", "cuanto cuesta", "cuánto cuesta", "cuesta", "costo"),
    "Soporte / problema": ("problema", "falla", "no funciona", "no sirve", "reparar", "garantia", "garantía", "soporte"),
    "Cita / servicio técnico": ("cita", "visita", "mantenimiento", "servicio tecnico", "servicio técnico", "agendar"),
}


def _clasificar_motivo(texto: str) -> str:
    t = (texto or "").lower()
    for etiqueta, palabras in _PALABRAS_MOTIVO.items():
        if any(p in t for p in palabras):
            return etiqueta
    return "Información general / otro"


@router.get("/api/indicadores/estrategicos")
async def indicadores_estrategicos(request: Request):
    _requiere_admin(request)
    async with memory.async_session() as session:
        # 1) Tasa de conversión: conversación -> interés accionable para ventas
        clientes_unicos = (await session.execute(text(
            "SELECT COUNT(DISTINCT telefono) AS c FROM mensajes WHERE role = 'user'"
        ))).mappings().first()["c"]
        convertidos = (await session.execute(text(
            "SELECT COUNT(DISTINCT telefono) AS c FROM ("
            "  SELECT telefono FROM notificaciones_vendedor"
            "  UNION SELECT telefono FROM leads"
            ")"
        ))).mappings().first()["c"]
        tasa_conversion = round((convertidos / clientes_unicos) * 100, 1) if clientes_unicos else None

        # 2) Tasa de abandono de carrito
        carritos = (await session.execute(text(
            "SELECT telefono, MAX(confirmado) AS algo_confirmado FROM carrito GROUP BY telefono"
        ))).mappings().all()
        total_carritos = len(carritos)
        abandonados = sum(1 for c in carritos if not c["algo_confirmado"])
        tasa_abandono = round((abandonados / total_carritos) * 100, 1) if total_carritos else None

        # 3) Notificaciones fallidas recientes por vendedor (últimos 7 días) — alerta temprana
        filas_recientes = (await session.execute(text(
            "SELECT vendedor_asignado AS vendedor, "
            "SUM(CASE WHEN notificado = 1 THEN 1 ELSE 0 END) AS entregados, COUNT(*) AS total "
            "FROM notificaciones_vendedor "
            "WHERE vendedor_asignado != '' AND creado >= datetime('now', '-7 days') "
            "GROUP BY vendedor_asignado"
        ))).mappings().all()

        # Qué CLIENTES quedaron esperando. Saber que un vendedor tiene 2 de 3
        # avisos entregados no sirve para recuperar la venta; saber a qué
        # teléfono hay que marcarle, sí. Es la diferencia entre un indicador
        # y una lista de pendientes.
        pendientes = (await session.execute(text(
            "SELECT vendedor_asignado AS vendedor, telefono, categoria, creado "
            "FROM notificaciones_vendedor "
            "WHERE vendedor_asignado != '' AND notificado = 0 "
            "  AND creado >= datetime('now', '-7 days') "
            "ORDER BY creado DESC"
        ))).mappings().all()
        por_vendedor_pend: dict[str, list] = {}
        for p in pendientes:
            por_vendedor_pend.setdefault(p["vendedor"], []).append({
                "telefono": p["telefono"],
                "categoria": p["categoria"],
                "creado": p["creado"],
            })

        alertas_vendedor = [
            {"vendedor": f["vendedor"], "entregados": f["entregados"], "total": f["total"],
             "tasa_pct": round((f["entregados"] / f["total"]) * 100, 1),
             "clientes_esperando": por_vendedor_pend.get(f["vendedor"], [])}
            for f in filas_recientes if f["entregados"] < f["total"]
        ]

        # 4) Distribución de motivos de contacto (primer mensaje de cada conversación)
        primeros = (await session.execute(text(
            "SELECT m.telefono, m.content FROM mensajes m "
            "INNER JOIN (SELECT telefono, MIN(id) AS primer_id FROM mensajes WHERE role='user' GROUP BY telefono) t "
            "ON t.telefono = m.telefono AND t.primer_id = m.id"
        ))).mappings().all()
        distribucion: dict[str, int] = {}
        for f in primeros:
            etiqueta = _clasificar_motivo(f["content"])
            distribucion[etiqueta] = distribucion.get(etiqueta, 0) + 1

        # 5) Tasa de re-contacto en 30 días
        filas_re = (await session.execute(text(
            "WITH primer AS ("
            "  SELECT telefono, MIN(timestamp) AS primera FROM mensajes WHERE role='user' GROUP BY telefono"
            ") "
            "SELECT p.telefono, COUNT(DISTINCT substr(m.timestamp,1,10)) AS dias_distintos "
            "FROM primer p JOIN mensajes m ON m.telefono = p.telefono AND m.role = 'user' "
            "  AND julianday(m.timestamp) - julianday(p.primera) <= 30 "
            "GROUP BY p.telefono"
        ))).mappings().all()
        total_clientes_recontacto = len(filas_re)
        recontactados = sum(1 for f in filas_re if f["dias_distintos"] > 1)
        tasa_recontacto = round((recontactados / total_clientes_recontacto) * 100, 1) if total_clientes_recontacto else None

    return {
        "ok": True,
        "tasa_conversion_pct": tasa_conversion,
        "clientes_unicos": clientes_unicos,
        "convertidos": convertidos,
        "tasa_abandono_carrito_pct": tasa_abandono,
        "carritos_abandonados": abandonados,
        "carritos_total": total_carritos,
        "alertas_notificacion_7d": alertas_vendedor,
        "distribucion_motivos": [{"motivo": k, "total": v} for k, v in sorted(distribucion.items(), key=lambda x: -x[1])],
        "tasa_recontacto_30d_pct": tasa_recontacto,
        "recontactados": recontactados,
        "clientes_evaluados_recontacto": total_clientes_recontacto,
    }


# ── Conocimiento (archivos y ligas para que Claudia consulte) ────────────

@router.get("/api/knowledge")
async def listar_knowledge(request: Request):
    _requiere_admin(request)
    os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
    items = []
    for nombre in sorted(os.listdir(KNOWLEDGE_DIR)):
        if nombre.startswith("."):
            continue
        ruta = os.path.join(KNOWLEDGE_DIR, nombre)
        if not os.path.isfile(ruta):
            continue
        items.append({
            "nombre": nombre,
            "tamano": os.path.getsize(ruta),
            "actualizado": datetime.fromtimestamp(os.path.getmtime(ruta), tz=timezone.utc).isoformat(timespec="seconds"),
        })
    return {"ok": True, "archivos": items}


@router.post("/api/knowledge/upload")
async def subir_knowledge(request: Request, archivo: UploadFile = File(...)):
    _requiere_admin(request)
    nombre = os.path.basename(archivo.filename or "")
    if not _NOMBRE_ARCHIVO_OK.match(nombre):
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido (solo letras, números, . _ -)")
    os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
    ruta = os.path.join(KNOWLEDGE_DIR, nombre)
    contenido = await archivo.read()
    if len(contenido) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Archivo mayor a 10 MB")
    with open(ruta, "wb") as f:
        f.write(contenido)
    return {"ok": True, "nombre": nombre}


@router.post("/api/knowledge/link")
async def agregar_link_knowledge(request: Request):
    _requiere_admin(request)
    body = await request.json()
    url = str(body.get("url", "")).strip()

    # La descarga sale desde DENTRO de la red, con el acceso del servidor.
    # Sin esta comprobación, una URL apuntando a 127.0.0.1, a un
    # 192.168.x.x o a los metadatos de nube convertiría al agente en un
    # puente para sondear servicios internos. Que el panel pida contraseña
    # no basta: una sesión robada bastaría, y aquí los vecinos de red son
    # el CRM y el firewall de la empresa.
    permitida, motivo = url_es_alcanzable(url)
    if not permitida:
        raise HTTPException(status_code=400, detail=f"URL no permitida: {motivo}")

    try:
        # Sin seguir redirecciones: una URL pública puede responder 302
        # hacia una interna y saltarse la comprobación de arriba. Igual
        # que hace el CRM con sus webhooks salientes.
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            r = await client.get(url)
            if r.is_redirect:
                raise HTTPException(
                    status_code=400,
                    detail="La liga redirige a otra dirección; usa la definitiva.",
                )
            r.raise_for_status()
            # Tope de tamaño: sin él, una URL a un archivo enorme llena el
            # disco y tumba al agente. 5 MB sobra para una página de texto.
            if len(r.content) > 5 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="El contenido supera 5 MB")
            texto = r.text
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo descargar la liga: {exc}")

    # Guardamos el HTML/texto crudo tal cual: buscar_en_knowledge ya hace
    # búsqueda de texto plano sobre el contenido del archivo.
    slug = re.sub(r"[^a-z0-9]+", "-", url.lower())[:60].strip("-") or "liga"
    nombre = f"liga-{slug}-{int(time.time())}.txt"
    os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
    with open(os.path.join(KNOWLEDGE_DIR, nombre), "w", encoding="utf-8") as f:
        f.write(f"Fuente: {url}\nDescargado: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n\n{texto}")
    return {"ok": True, "nombre": nombre}


@router.delete("/api/knowledge/{nombre}")
async def borrar_knowledge(request: Request, nombre: str):
    _requiere_admin(request)
    if not _NOMBRE_ARCHIVO_OK.match(nombre):
        raise HTTPException(status_code=400, detail="Nombre de archivo inválido")
    ruta = os.path.join(KNOWLEDGE_DIR, nombre)
    if not os.path.isfile(ruta):
        raise HTTPException(status_code=404, detail="No encontrado")
    os.remove(ruta)
    return {"ok": True}


# ── Conversaciones ───────────────────────────────────────────────────────

@router.delete("/api/conversaciones/{telefono}")
async def borrar_conversacion(request: Request, telefono: str):
    """Borra el historial de UNA conversación. Irreversible.

    Sirve para dos cosas reales: un cliente que pide que borren lo que
    habló con Claudia, y un chat descarrilado que conviene reiniciar para
    que ella no siga arrastrando contexto malo.

    El borrado es por igualdad exacta del teléfono (ver memory.py), así
    que no puede llevarse conversaciones vecinas por delante."""
    _requiere_admin(request)
    telefono = (telefono or "").strip()
    if not telefono:
        raise HTTPException(status_code=400, detail="Falta el teléfono")
    borrados = await memory.limpiar_historial(telefono)
    logger.info(f"Conversación borrada desde el panel: {telefono} ({borrados} mensajes)")
    return {"ok": True, "telefono": telefono, "mensajes_borrados": borrados}


# ── Salud del túnel de Cloudflare ────────────────────────────────────────

@router.get("/api/health-tunel")
async def salud_tunel(request: Request):
    """Estado del túnel público y el historial de caídas/reparaciones.

    'segundos_desde_chequeo' es el dato importante: si deja de crecer y se
    congela, significa que el proceso del servidor murió y el vigilante
    murió con él — el único fallo del que el vigilante no puede avisar
    por sí mismo (ver agent/health_tunel.py)."""
    _requiere_admin(request)
    from agent.health_tunel import estado_actual, INTERVALO_SEG, vigilancia_activa
    from agent.memory import listar_eventos_tunel

    ultimo = estado_actual.get("ultimo_chequeo")
    segundos = None
    if ultimo:
        try:
            # ultimo_chequeo se guarda en hora local (datetime.now), no UTC
            segundos = int((datetime.now() - datetime.fromisoformat(ultimo)).total_seconds())
        except ValueError:
            segundos = None

    return {
        "activo": vigilancia_activa(),
        "estado": estado_actual.get("estado"),
        "url": estado_actual.get("url"),
        "ultimo_chequeo": ultimo,
        "segundos_desde_chequeo": segundos,
        "intervalo_seg": INTERVALO_SEG,
        # Si pasó más del doble del intervalo sin chequear, algo va mal
        "vigilante_estancado": bool(segundos and segundos > INTERVALO_SEG * 2),
        "reintentos": estado_actual.get("reintentos", 0),
        "ultimo_evento": estado_actual.get("ultimo_evento"),
        "historial": await listar_eventos_tunel(limite=30),
    }


# ── Catálogo de NetSuite (sincronización a demanda + tabla) ──────────────

@router.post("/api/sync")
async def sincronizar_ahora(request: Request):
    _requiere_admin(request)
    python = sys.executable
    resultados = {}
    for nombre_script in ("sync_netsuite_catalogo.py", "sync_netsuite_clientes.py"):
        ruta = os.path.join(ROOT_DIR, "scripts", nombre_script)
        proc = await asyncio.create_subprocess_exec(
            python, ruta, cwd=ROOT_DIR,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            salida, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            resultados[nombre_script] = {"ok": False, "salida": "Tiempo de espera agotado (120s)"}
            continue
        resultados[nombre_script] = {
            "ok": proc.returncode == 0,
            "salida": salida.decode("utf-8", errors="replace")[-4000:],
        }
    ok_total = all(r["ok"] for r in resultados.values())
    if ok_total:
        # Mismo motivo que en agent/programador.py: el catálogo nuevo puede
        # traer abreviaturas que antes no existían, y quedarían invisibles
        # en las búsquedas hasta reiniciar el servidor.
        try:
            from agent.tools import invalidar_cache_raices
            invalidar_cache_raices()
        except Exception as exc:
            logger.warning(f"no pude refrescar las abreviaturas del catálogo: {exc}")
    return {"ok": ok_total, "resultados": resultados}


@router.get("/api/sync/estado")
async def estado_sync(request: Request):
    _requiere_admin(request)
    con = ns_db.conectar()
    articulos_actualizado = ns_db.get_meta(con, "articulos_actualizado")
    clientes_actualizado = ns_db.get_meta(con, "clientes_actualizado")
    n_articulos = con.execute("SELECT COUNT(*) c FROM articulos").fetchone()["c"]
    n_clientes = con.execute("SELECT COUNT(*) c FROM clientes").fetchone()["c"]
    con.close()
    return {
        "ok": True,
        "articulos_actualizado": articulos_actualizado, "n_articulos": n_articulos,
        "clientes_actualizado": clientes_actualizado, "n_clientes": n_clientes,
    }


_ORDEN_COLUMNAS_OK = {
    "codigo", "nombre", "tipo", "grupo", "linea", "existencia", "importado",
    "precio_escala_1", "precio_escala_2", "precio_escala_3", "precio_escala_4", "precio_escala_5",
}


@router.get("/api/catalogo")
async def consultar_catalogo_admin(request: Request, buscar: str = "", pagina: int = 1,
                                    tam: int = 25, orden: str = "nombre"):
    _requiere_admin(request)
    pagina = max(1, pagina)
    tam = min(max(1, tam), 200)
    orden = orden if orden in _ORDEN_COLUMNAS_OK else "nombre"

    con = ns_db.conectar()
    where, params = "", ()
    if buscar.strip():
        palabras = buscar.strip().split()
        condiciones = " AND ".join("(nombre LIKE ? COLLATE NOCASE OR codigo LIKE ? COLLATE NOCASE)" for _ in palabras)
        where = f"WHERE {condiciones}"
        params = tuple(f"%{p}%" for p in palabras for _ in range(2))

    total = con.execute(f"SELECT COUNT(*) c FROM articulos {where}", params).fetchone()["c"]
    offset = (pagina - 1) * tam
    filas = con.execute(
        f"SELECT codigo, nombre, tipo, grupo, linea, existencia, importado, "
        f"precio_escala_1, precio_escala_2, precio_escala_3, precio_escala_4, precio_escala_5 "
        f"FROM articulos {where} ORDER BY {orden} LIMIT ? OFFSET ?",
        params + (tam, offset),
    ).fetchall()
    con.close()

    return {
        "ok": True, "total": total, "pagina": pagina, "tam": tam,
        "articulos": [dict(f) for f in filas],
    }


# ── Clientes sincronizados de NetSuite (roster + vendedor asignado) ──────

_ORDEN_COLUMNAS_CLIENTES_OK = {"nombre", "rfc", "salesrep_nombre"}


@router.get("/api/clientes")
async def consultar_clientes_admin(request: Request, buscar: str = "", pagina: int = 1,
                                    tam: int = 25, orden: str = "nombre"):
    _requiere_admin(request)
    pagina = max(1, pagina)
    tam = min(max(1, tam), 200)
    orden = orden if orden in _ORDEN_COLUMNAS_CLIENTES_OK else "nombre"

    con = ns_db.conectar()
    where, params = "", ()
    if buscar.strip():
        palabras = buscar.strip().split()
        condiciones = " AND ".join(
            "(nombre LIKE ? COLLATE NOCASE OR rfc LIKE ? COLLATE NOCASE OR salesrep_nombre LIKE ? COLLATE NOCASE)"
            for _ in palabras
        )
        where = f"WHERE {condiciones}"
        params = tuple(f"%{p}%" for p in palabras for _ in range(3))

    total = con.execute(f"SELECT COUNT(*) c FROM clientes {where}", params).fetchone()["c"]
    offset = (pagina - 1) * tam
    filas = con.execute(
        f"SELECT netsuite_id, nombre, rfc, salesrep_nombre "
        f"FROM clientes {where} ORDER BY {orden} LIMIT ? OFFSET ?",
        params + (tam, offset),
    ).fetchall()
    con.close()

    return {
        "ok": True, "total": total, "pagina": pagina, "tam": tam,
        "clientes": [dict(f) for f in filas],
    }


# ── Vendedores (CRUD sobre la tabla `vendedores`) ─────────────────────────
#
# Antes vivían en config/vendedores_whatsapp.yaml. Se movieron a la base
# porque ese archivo tiene datos personales de empleados y el repo de
# GitHub es público: está en .gitignore, y lo ignorado no llega a Railway
# — pero el agente lo necesita en ejecución. Además el filesystem de
# Railway es efímero, así que editar desde aquí un archivo no sobreviviría
# al siguiente redeploy. El YAML quedó solo como semilla inicial.
#
# La URL sigue usando netsuite_id como clave (no el id de la fila) para no
# romper el frontend en static_admin/app.js.

async def _buscar_por_netsuite_id(netsuite_id: str) -> dict | None:
    for v in await memory.listar_vendedores():
        if str(v.get("netsuite_id") or "") == str(netsuite_id or ""):
            return v
    return None


async def _refrescar_cache():
    """La caché de agent/tools.py alimenta el sorteo y la canalización: si no
    se refresca, el agente sigue usando los vendedores viejos hasta el
    próximo reinicio."""
    from agent.tools import refrescar_cache_vendedores
    await refrescar_cache_vendedores()


@router.get("/api/vendedores")
async def listar_vendedores(request: Request):
    _requiere_admin(request)
    return {"ok": True, "vendedores": await memory.listar_vendedores()}


@router.post("/api/vendedores")
async def crear_vendedor(request: Request):
    _requiere_admin(request)
    body = await request.json()
    nombre = str(body.get("nombre", "")).strip()
    netsuite_id = str(body.get("netsuite_id", "")).strip()
    if not nombre or not netsuite_id:
        raise HTTPException(status_code=400, detail="nombre y netsuite_id son obligatorios")
    if await _buscar_por_netsuite_id(netsuite_id):
        raise HTTPException(status_code=409, detail="Ya existe un vendedor con ese netsuite_id")
    await memory.crear_vendedor(
        nombre=nombre,
        netsuite_id=netsuite_id,
        email=str(body.get("email", "")).strip(),
        whatsapp=str(body.get("whatsapp", "")).strip(),
    )
    await _refrescar_cache()
    return {"ok": True}


@router.put("/api/vendedores/{netsuite_id}")
async def editar_vendedor(request: Request, netsuite_id: str):
    _requiere_admin(request)
    body = await request.json()
    v = await _buscar_por_netsuite_id(netsuite_id)
    if not v:
        raise HTTPException(status_code=404, detail="Vendedor no encontrado")
    campos = {c: str(body[c]).strip() for c in ("nombre", "email", "whatsapp") if c in body}
    await memory.actualizar_vendedor(v["id"], campos)
    await _refrescar_cache()
    return {"ok": True}


@router.delete("/api/vendedores/{netsuite_id}")
async def borrar_vendedor(request: Request, netsuite_id: str):
    _requiere_admin(request)
    v = await _buscar_por_netsuite_id(netsuite_id)
    if not v:
        raise HTTPException(status_code=404, detail="Vendedor no encontrado")
    await memory.eliminar_vendedor(v["id"])
    await _refrescar_cache()
    return {"ok": True}


# ── Centro de Aprendizaje ─────────────────────────────────────────────────
#
# Propuestas de estrategia comercial / KPI (de análisis de IA o agregadas a
# mano) que el administrador aprueba o rechaza — nada se aplica solo. Al
# aprobar, se agrega una sección a APRENDIZAJE_CONOCIMIENTO.md. Además, una
# bandeja simple de notas/peticiones para que Claude Code las revise en una
# próxima sesión real de trabajo (NO es un chat en vivo ni ejecuta nada).

_CATEGORIAS_PROPUESTA_OK = {"estrategia_ventas", "kpi", "mejora_prompt", "otro"}
_ETIQUETAS_CATEGORIA = {
    "estrategia_ventas": "Estrategia de ventas", "kpi": "KPI / indicador",
    "mejora_prompt": "Mejora al prompt de Claudia", "otro": "Otro",
}


def _agregar_seccion_aprendizaje(propuesta: dict):
    """Agrega la propuesta aprobada como una sección nueva al documento vivo
    del proyecto — mismo formato que las secciones ya escritas a mano."""
    encabezado = _ETIQUETAS_CATEGORIA.get(propuesta["categoria"], "Aprendizaje")
    bloque = (
        f"\n---\n\n"
        f"## {propuesta['titulo']} ({encabezado})\n\n"
        f"**Origen:** aprobado desde el panel de administración "
        f"({'análisis de IA' if propuesta.get('origen') == 'analisis_ia' else 'agregado manualmente'}), "
        f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.\n\n"
        f"{propuesta['descripcion']}\n"
    )
    if propuesta.get("evidencia"):
        bloque += f"\n**Evidencia:** {propuesta['evidencia']}\n"
    with open(APRENDIZAJE_PATH, "a", encoding="utf-8") as f:
        f.write(bloque)


@router.get("/api/aprendizaje/documento")
async def obtener_documento_aprendizaje(request: Request):
    _requiere_admin(request)
    if not os.path.isfile(APRENDIZAJE_PATH):
        return {"ok": True, "contenido": ""}
    with open(APRENDIZAJE_PATH, "r", encoding="utf-8") as f:
        return {"ok": True, "contenido": f.read()}


@router.get("/api/aprendizaje/propuestas")
async def listar_propuestas(request: Request, estado: str = ""):
    _requiere_admin(request)
    return {"ok": True, "propuestas": await memory.listar_propuestas_aprendizaje(estado)}


@router.post("/api/aprendizaje/propuestas")
async def crear_propuesta(request: Request):
    _requiere_admin(request)
    body = await request.json()
    titulo = str(body.get("titulo", "")).strip()
    categoria = str(body.get("categoria", "")).strip()
    descripcion = str(body.get("descripcion", "")).strip()
    evidencia = str(body.get("evidencia", "")).strip()
    origen = str(body.get("origen", "manual")).strip() or "manual"
    if not titulo or not descripcion:
        raise HTTPException(status_code=400, detail="Título y descripción son obligatorios")
    if categoria not in _CATEGORIAS_PROPUESTA_OK:
        raise HTTPException(status_code=400, detail="Categoría inválida")
    if origen not in ("manual", "analisis_ia"):
        origen = "manual"
    propuesta_id = await memory.crear_propuesta_aprendizaje(titulo, categoria, descripcion, evidencia, origen)
    return {"ok": True, "id": propuesta_id}


@router.put("/api/aprendizaje/propuestas/{propuesta_id}")
async def revisar_propuesta(request: Request, propuesta_id: int):
    _requiere_admin(request)
    body = await request.json()
    estado = str(body.get("estado", "")).strip()
    if estado not in ("aprobada", "rechazada"):
        raise HTTPException(status_code=400, detail="estado debe ser 'aprobada' o 'rechazada'")
    propuesta = await memory.actualizar_estado_propuesta(propuesta_id, estado)
    if not propuesta:
        raise HTTPException(status_code=404, detail="Propuesta no encontrada")
    if estado == "aprobada":
        _agregar_seccion_aprendizaje(propuesta)
    return {"ok": True}


@router.get("/api/aprendizaje/notas")
async def listar_notas(request: Request, estado: str = ""):
    _requiere_admin(request)
    return {"ok": True, "notas": await memory.listar_notas_claude_code(estado)}


@router.post("/api/aprendizaje/notas")
async def crear_nota(request: Request):
    _requiere_admin(request)
    body = await request.json()
    texto = str(body.get("texto", "")).strip()
    if not texto:
        raise HTTPException(status_code=400, detail="El texto de la nota no puede estar vacío")
    nota_id = await memory.crear_nota_claude_code(texto)
    return {"ok": True, "id": nota_id}


@router.put("/api/aprendizaje/notas/{nota_id}")
async def marcar_nota(request: Request, nota_id: int):
    _requiere_admin(request)
    body = await request.json()
    estado = str(body.get("estado", "")).strip()
    if estado not in ("pendiente", "atendida"):
        raise HTTPException(status_code=400, detail="estado debe ser 'pendiente' o 'atendida'")
    ok = await memory.actualizar_estado_nota(nota_id, estado)
    if not ok:
        raise HTTPException(status_code=404, detail="Nota no encontrada")
    return {"ok": True}
