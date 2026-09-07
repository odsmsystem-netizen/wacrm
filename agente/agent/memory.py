# agent/memory.py — Memoria de conversaciones y datos operativos (SQLite)
# Generado por AgentKit

"""
Sistema de memoria del agente. Guarda el historial de conversaciones por
número de teléfono, y las tablas operativas que usan las herramientas de
negocio (citas, leads, pedidos, tickets de soporte) usando SQLite (local)
o PostgreSQL (producción).
"""

import os
from datetime import datetime, timedelta
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, Text, DateTime, Integer, Float, select, func
from sqlalchemy.exc import IntegrityError
from dotenv import load_dotenv

load_dotenv()

# Configuración de base de datos
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./agentkit.db")

# Si es PostgreSQL en producción, ajustar el esquema de URL
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Mensaje(Base):
    """Historial de conversación por número de teléfono."""
    __tablename__ = "mensajes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    role: Mapped[str] = mapped_column(String(20))  # "user" o "assistant"
    content: Mapped[str] = mapped_column(Text)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Cita(Base):
    """Citas / reservaciones agendadas por clientes."""
    __tablename__ = "citas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    nombre_cliente: Mapped[str] = mapped_column(String(200), default="")
    direccion: Mapped[str] = mapped_column(String(300), default="")
    servicio: Mapped[str] = mapped_column(String(300))
    fecha: Mapped[str] = mapped_column(String(20))   # YYYY-MM-DD
    hora: Mapped[str] = mapped_column(String(10))    # HH:MM
    estado: Mapped[str] = mapped_column(String(20), default="pendiente")  # pendiente | confirmada | cancelada
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Lead(Base):
    """Prospectos / oportunidades de venta detectadas en la conversación."""
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    nombre: Mapped[str] = mapped_column(String(200), default="")
    empresa: Mapped[str] = mapped_column(String(200), default="")
    interes: Mapped[str] = mapped_column(Text)
    calificacion: Mapped[str] = mapped_column(String(20), default="nuevo")  # nuevo | calificado | descartado
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ItemCarrito(Base):
    """Artículos que un cliente va agregando a su pedido en curso."""
    __tablename__ = "carrito"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    codigo: Mapped[str] = mapped_column(String(100))
    nombre_articulo: Mapped[str] = mapped_column(String(300))
    cantidad: Mapped[float] = mapped_column(Float, default=1.0)
    precio_unitario: Mapped[float] = mapped_column(Float, default=0.0)
    confirmado: Mapped[bool] = mapped_column(Integer, default=0)  # 0/1 — se marca al confirmar el pedido
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Cliente(Base):
    """Datos de contacto y fiscales del cliente, capturados por Claudia antes
    de generar una cotización formal."""
    __tablename__ = "clientes"

    telefono: Mapped[str] = mapped_column(String(50), primary_key=True)
    nombre_completo: Mapped[str] = mapped_column(String(200), default="")
    empresa: Mapped[str] = mapped_column(String(200), default="")
    correo: Mapped[str] = mapped_column(String(200), default="")
    rfc: Mapped[str] = mapped_column(String(20), default="")
    actualizado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class NotificacionVendedor(Base):
    """
    Cada vez que se le avisa a un vendedor por WhatsApp — sea porque se
    generó una Opportunity para un LEAD NUEVO, o porque se canalizó un
    CLIENTE EXISTENTE a su cartera. Es la fuente de los indicadores del
    panel de administración (mensajes por vendedor, por categoría, etc.).
    """
    __tablename__ = "notificaciones_vendedor"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    categoria: Mapped[str] = mapped_column(String(30), index=True)  # lead_nuevo | cliente_existente
    netsuite_ref: Mapped[str] = mapped_column(String(50), default="")  # opportunity id (solo lead_nuevo)
    total: Mapped[float] = mapped_column(Float, default=0.0)
    vendedor_asignado: Mapped[str] = mapped_column(String(200), default="")
    vendedor_whatsapp: Mapped[str] = mapped_column(String(50), default="")
    notificado: Mapped[bool] = mapped_column(Integer, default=0)
    # El folio es el número de documento que ve el cliente. Se guarda junto al
    # id interno porque al bloquear una cotización duplicada hay que devolverle
    # al cliente el folio de la PRIMERA, y volver a pedírselo a NetSuite en cada
    # intento sería una llamada de red por un dato que ya teníamos.
    folio: Mapped[str] = mapped_column(String(50), default="")
    # Huella del pedido que originó esta oportunidad: qué artículos y cuántos.
    # Es lo que distingue "el cliente confirmó dos veces por error" (misma
    # huella) de "el cliente quiere cotizar otra cosa" (huella distinta), para
    # bloquear lo primero sin estorbar lo segundo.
    huella_pedido: Mapped[str] = mapped_column(String(500), default="", index=True)
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class UsuarioAdmin(Base):
    """Usuarios con acceso al panel de administración (/admin). La contraseña
    nunca se guarda en claro: se almacena su hash PBKDF2-SHA256 + salt
    (ver agent/admin.py: _hash_password / _verificar_password)."""
    __tablename__ = "usuarios_admin"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    usuario: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    password_salt: Mapped[str] = mapped_column(String(64))
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Ticket(Base):
    """Tickets de soporte post-venta."""
    __tablename__ = "tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    telefono: Mapped[str] = mapped_column(String(50), index=True)
    problema: Mapped[str] = mapped_column(Text)
    estado: Mapped[str] = mapped_column(String(20), default="abierto")  # abierto | en_proceso | cerrado
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PropuestaAprendizaje(Base):
    """Propuestas de estrategia comercial o KPI (generadas por análisis de IA
    o agregadas a mano por el administrador) para el Centro de Aprendizaje
    del panel. Nada se aplica solo — el administrador aprueba o rechaza cada
    una; al aprobar se agrega a APRENDIZAJE_CONOCIMIENTO.md."""
    __tablename__ = "propuestas_aprendizaje"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    titulo: Mapped[str] = mapped_column(String(200))
    categoria: Mapped[str] = mapped_column(String(30))  # estrategia_ventas | kpi | mejora_prompt | otro
    descripcion: Mapped[str] = mapped_column(Text)
    evidencia: Mapped[str] = mapped_column(Text, default="")
    origen: Mapped[str] = mapped_column(String(20), default="manual")  # analisis_ia | manual
    estado: Mapped[str] = mapped_column(String(20), default="pendiente")  # pendiente | aprobada | rechazada
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    revisado: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class NotaClaudeCode(Base):
    """Bandeja de notas/peticiones del administrador para que Claude Code las
    revise y actúe en una próxima sesión de trabajo real — NO ejecuta nada
    por sí sola, es solo una cola de pendientes."""
    __tablename__ = "notas_claude_code"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    texto: Mapped[str] = mapped_column(Text)
    estado: Mapped[str] = mapped_column(String(20), default="pendiente")  # pendiente | atendida
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    atendido: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class Vendedor(Base):
    """Vendedores de Ambar Cargo: sorteo de leads nuevos y canalización directa.

    Vive en la base y NO en config/vendedores_whatsapp.yaml por tres razones
    que se dan juntas: el archivo tiene datos personales de empleados y el
    repo de GitHub es público; lo que está en .gitignore no se sube a Railway,
    pero el agente lo necesita en ejecución; y el filesystem de Railway es
    efímero, así que las ediciones desde /admin no sobrevivirían un redeploy.
    El YAML se conserva solo como semilla inicial (ver migrar_vendedores)."""
    __tablename__ = "vendedores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    nombre: Mapped[str] = mapped_column(String(200))
    netsuite_id: Mapped[str] = mapped_column(String(30), default="", index=True)
    email: Mapped[str] = mapped_column(String(200), default="")
    whatsapp: Mapped[str] = mapped_column(String(30), default="")
    activo: Mapped[int] = mapped_column(Integer, default=1)
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


async def listar_vendedores() -> list[dict]:
    """Todos los vendedores activos, en orden alfabético."""
    async with async_session() as session:
        query = select(Vendedor).where(Vendedor.activo == 1).order_by(Vendedor.nombre)
        result = await session.execute(query)
        return [
            {"id": v.id, "nombre": v.nombre, "netsuite_id": v.netsuite_id,
             "email": v.email, "whatsapp": v.whatsapp}
            for v in result.scalars().all()
        ]


async def contar_vendedores() -> int:
    async with async_session() as session:
        result = await session.execute(select(func.count()).select_from(Vendedor))
        return int(result.scalar() or 0)


async def migrar_vendedores(filas: list[dict]) -> int:
    """Siembra la tabla desde el YAML la PRIMERA vez y nada más.

    Idempotente a propósito: si la tabla ya tiene datos, no toca nada. Sin
    esto, cada reinicio del servidor pisaría las ediciones hechas desde el
    panel con el contenido viejo del archivo."""
    if await contar_vendedores() > 0:
        return 0
    async with async_session() as session:
        for f in filas:
            if not (f.get("nombre") or "").strip():
                continue
            session.add(Vendedor(
                nombre=f.get("nombre", ""),
                netsuite_id=str(f.get("netsuite_id") or ""),
                email=f.get("email", ""),
                whatsapp=f.get("whatsapp", ""),
            ))
        await session.commit()
    return await contar_vendedores()


async def crear_vendedor(nombre: str, netsuite_id: str = "", email: str = "",
                         whatsapp: str = "") -> int:
    async with async_session() as session:
        v = Vendedor(nombre=nombre, netsuite_id=str(netsuite_id or ""),
                     email=email, whatsapp=whatsapp)
        session.add(v)
        await session.commit()
        await session.refresh(v)
        return v.id


async def actualizar_vendedor(vendedor_id: int, campos: dict) -> bool:
    async with async_session() as session:
        result = await session.execute(select(Vendedor).where(Vendedor.id == vendedor_id))
        v = result.scalar_one_or_none()
        if not v:
            return False
        for clave in ("nombre", "netsuite_id", "email", "whatsapp"):
            if clave in campos:
                setattr(v, clave, str(campos[clave] or ""))
        await session.commit()
        return True


async def eliminar_vendedor(vendedor_id: int) -> bool:
    """Baja lógica: se marca inactivo en vez de borrarlo, para no perder
    el rastro de a quién se le asignaron leads históricos."""
    async with async_session() as session:
        result = await session.execute(select(Vendedor).where(Vendedor.id == vendedor_id))
        v = result.scalar_one_or_none()
        if not v:
            return False
        v.activo = 0
        await session.commit()
        return True


class EventoTunel(Base):
    """Historial de caídas y reparaciones del túnel de Cloudflare.

    Lo alimenta agent/health_tunel.py y lo lee el panel /admin. Se guarda
    en base (además del log) para poder mostrar el historial en el panel
    sin parsear texto plano."""
    __tablename__ = "eventos_tunel"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    evento: Mapped[str] = mapped_column(String(30), index=True)  # caido | recuperado | url_cambiada | degradado
    url_anterior: Mapped[str] = mapped_column(String(300), default="")
    url_nueva: Mapped[str] = mapped_column(String(300), default="")
    detalle: Mapped[str] = mapped_column(Text, default="")
    creado: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


async def guardar_evento_tunel(evento: str, url_anterior: str | None,
                               url_nueva: str | None, detalle: str) -> int:
    """Registra un cambio de estado del túnel."""
    async with async_session() as session:
        e = EventoTunel(
            evento=evento,
            url_anterior=url_anterior or "",
            url_nueva=url_nueva or "",
            detalle=(detalle or "")[:2000],
        )
        session.add(e)
        await session.commit()
        await session.refresh(e)
        return e.id


async def listar_eventos_tunel(limite: int = 30) -> list[dict]:
    """Últimos eventos del túnel, del más reciente al más viejo."""
    async with async_session() as session:
        query = select(EventoTunel).order_by(EventoTunel.creado.desc()).limit(limite)
        result = await session.execute(query)
        return [
            {"id": e.id, "evento": e.evento, "url_anterior": e.url_anterior,
             "url_nueva": e.url_nueva, "detalle": e.detalle,
             "creado": e.creado.isoformat(timespec="seconds")}
            for e in result.scalars().all()
        ]


async def _migrar(conn):
    """Agrega columnas nuevas a bases de datos creadas antes de que existieran
    (create_all no altera tablas ya existentes). Idempotente."""
    from sqlalchemy import text
    resultado = await conn.execute(text("PRAGMA table_info(citas)"))
    columnas = {fila[1] for fila in resultado.fetchall()}
    if "direccion" not in columnas:
        await conn.execute(text("ALTER TABLE citas ADD COLUMN direccion VARCHAR(300) DEFAULT ''"))

    resultado = await conn.execute(text("PRAGMA table_info(leads)"))
    columnas = {fila[1] for fila in resultado.fetchall()}
    if "empresa" not in columnas:
        await conn.execute(text("ALTER TABLE leads ADD COLUMN empresa VARCHAR(200) DEFAULT ''"))

    resultado = await conn.execute(text("PRAGMA table_info(notificaciones_vendedor)"))
    columnas = {fila[1] for fila in resultado.fetchall()}
    if "folio" not in columnas:
        await conn.execute(text(
            "ALTER TABLE notificaciones_vendedor ADD COLUMN folio VARCHAR(50) DEFAULT ''"))
    if "huella_pedido" not in columnas:
        await conn.execute(text(
            "ALTER TABLE notificaciones_vendedor ADD COLUMN huella_pedido VARCHAR(500) DEFAULT ''"))


async def inicializar_db():
    """Crea las tablas si no existen."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrar(conn)


# ── Historial de conversación ───────────────────────────────────────────

async def guardar_mensaje(telefono: str, role: str, content: str):
    """Guarda un mensaje en el historial de conversación."""
    async with async_session() as session:
        mensaje = Mensaje(telefono=telefono, role=role, content=content, timestamp=datetime.utcnow())
        session.add(mensaje)
        await session.commit()


MINUTOS_SESION_ACTIVA = 5  # más de este tiempo sin mensajes = conversación nueva


async def _ultimos_mensajes(telefono: str, limite: int) -> list[Mensaje]:
    """Los últimos N mensajes de una conversación, en orden cronológico."""
    async with async_session() as session:
        result = await session.execute(
            select(Mensaje)
            .where(Mensaje.telefono == telefono)
            # El id desempata: dos mensajes pueden caer en el mismo timestamp
            # (el del cliente y la respuesta se guardan casi juntos) y sin este
            # criterio el orden queda al azar — la transcripción que lee el
            # vendedor saldría con la respuesta antes de la pregunta.
            .order_by(Mensaje.timestamp.desc(), Mensaje.id.desc())
            .limit(limite)
        )
        mensajes = list(result.scalars().all())
    mensajes.reverse()
    return mensajes


async def obtener_historial(telefono: str, limite: int = 16) -> list[dict]:
    """
    Contexto para responder: los últimos N mensajes de la conversación ACTIVA.

    Si el último mensaje es de hace más de MINUTOS_SESION_ACTIVA, se trata
    como una conversación NUEVA (regresa vacío) — así Claudia se vuelve a
    presentar y no arrastra contexto de una charla que el cliente ya dio
    por terminada (se despidió, o simplemente dejó de escribir hace rato).

    OJO: esta ventana es SOLO para armar el contexto de la respuesta. Para
    leer la conversación completa (transcripción al vendedor, respaldos,
    panel) usa obtener_conversacion_completa — si no, un cliente que tardó
    6 minutos en contestar produce una lectura vacía.
    """
    mensajes = await _ultimos_mensajes(telefono, limite)
    if mensajes and (datetime.utcnow() - mensajes[-1].timestamp) > timedelta(minutes=MINUTOS_SESION_ACTIVA):
        return []
    return [{"role": m.role, "content": m.content} for m in mensajes]


async def obtener_conversacion_completa(telefono: str, limite: int = 200) -> list[dict]:
    """
    La conversación tal como ocurrió, SIN la ventana de sesión activa.

    Es lo que necesita quien va a leer la charla completa (el vendedor que
    recibe la transcripción), a diferencia de obtener_historial, que solo
    sirve para darle contexto reciente al modelo.
    """
    mensajes = await _ultimos_mensajes(telefono, limite)
    return [{"role": m.role, "content": m.content} for m in mensajes]


async def limpiar_historial(telefono: str) -> int:
    """Borra el historial de UNA conversación. Devuelve cuántos mensajes borró.

    La comparación es por igualdad exacta (no LIKE) a propósito: así
    '+52111' nunca arrastra a '+5211122', y un teléfono vacío no vacía la
    base entera. Es un borrado irreversible; conviene que sea imposible
    que se lleve de más."""
    async with async_session() as session:
        result = await session.execute(select(Mensaje).where(Mensaje.telefono == telefono))
        mensajes = result.scalars().all()
        for msg in mensajes:
            await session.delete(msg)
        await session.commit()
        return len(mensajes)


# ── Citas ────────────────────────────────────────────────────────────────

async def crear_cita(telefono: str, servicio: str, fecha: str, hora: str,
                      nombre_cliente: str = "", direccion: str = "") -> int:
    async with async_session() as session:
        cita = Cita(telefono=telefono, servicio=servicio, fecha=fecha, hora=hora,
                     nombre_cliente=nombre_cliente, direccion=direccion, estado="pendiente")
        session.add(cita)
        await session.commit()
        await session.refresh(cita)
        return cita.id


async def listar_citas(telefono: str) -> list[dict]:
    async with async_session() as session:
        result = await session.execute(
            select(Cita).where(Cita.telefono == telefono).order_by(Cita.fecha, Cita.hora)
        )
        return [
            {"id": c.id, "servicio": c.servicio, "fecha": c.fecha, "hora": c.hora,
             "estado": c.estado, "direccion": c.direccion}
            for c in result.scalars().all()
        ]


async def cancelar_cita(telefono: str, cita_id: int) -> bool:
    async with async_session() as session:
        result = await session.execute(
            select(Cita).where(Cita.id == cita_id, Cita.telefono == telefono)
        )
        cita = result.scalar_one_or_none()
        if not cita:
            return False
        cita.estado = "cancelada"
        await session.commit()
        return True


# ── Leads ────────────────────────────────────────────────────────────────

async def registrar_lead(telefono: str, interes: str, nombre: str = "", empresa: str = "") -> int:
    async with async_session() as session:
        lead = Lead(telefono=telefono, nombre=nombre, empresa=empresa, interes=interes, calificacion="nuevo")
        session.add(lead)
        await session.commit()
        await session.refresh(lead)
        return lead.id


# ── Carrito / pedidos ───────────────────────────────────────────────────

async def agregar_al_carrito(telefono: str, codigo: str, nombre_articulo: str,
                              cantidad: float, precio_unitario: float) -> int:
    async with async_session() as session:
        item = ItemCarrito(telefono=telefono, codigo=codigo, nombre_articulo=nombre_articulo,
                            cantidad=cantidad, precio_unitario=precio_unitario, confirmado=0)
        session.add(item)
        await session.commit()
        await session.refresh(item)
        return item.id


async def ver_carrito(telefono: str) -> list[dict]:
    async with async_session() as session:
        result = await session.execute(
            select(ItemCarrito).where(ItemCarrito.telefono == telefono, ItemCarrito.confirmado == 0)
        )
        return [
            {"id": i.id, "codigo": i.codigo, "nombre_articulo": i.nombre_articulo,
             "cantidad": i.cantidad, "precio_unitario": i.precio_unitario,
             "subtotal": round(i.cantidad * i.precio_unitario, 2)}
            for i in result.scalars().all()
        ]


async def confirmar_pedido(telefono: str) -> dict:
    async with async_session() as session:
        result = await session.execute(
            select(ItemCarrito).where(ItemCarrito.telefono == telefono, ItemCarrito.confirmado == 0)
        )
        items = result.scalars().all()
        if not items:
            return {"ok": False, "error": "El carrito está vacío."}
        total = 0.0
        for i in items:
            i.confirmado = 1
            total += i.cantidad * i.precio_unitario
        await session.commit()
        return {"ok": True, "articulos": len(items), "total": round(total, 2)}


# ── Datos del cliente ────────────────────────────────────────────────────

async def guardar_cliente(telefono: str, nombre_completo: str = "", empresa: str = "",
                           correo: str = "", rfc: str = "") -> dict:
    async with async_session() as session:
        result = await session.execute(select(Cliente).where(Cliente.telefono == telefono))
        cliente = result.scalar_one_or_none()
        if cliente is None:
            cliente = Cliente(telefono=telefono)
            session.add(cliente)
        if nombre_completo:
            cliente.nombre_completo = nombre_completo
        if empresa:
            cliente.empresa = empresa
        if correo:
            cliente.correo = correo
        if rfc:
            cliente.rfc = rfc
        cliente.actualizado = datetime.utcnow()
        await session.commit()
        return {"telefono": telefono, "nombre_completo": cliente.nombre_completo,
                "empresa": cliente.empresa, "correo": cliente.correo, "rfc": cliente.rfc}


async def obtener_cliente(telefono: str) -> dict | None:
    async with async_session() as session:
        result = await session.execute(select(Cliente).where(Cliente.telefono == telefono))
        c = result.scalar_one_or_none()
        if not c:
            return None
        return {"telefono": c.telefono, "nombre_completo": c.nombre_completo,
                "empresa": c.empresa, "correo": c.correo, "rfc": c.rfc}


# ── Notificaciones a vendedores (leads nuevos + clientes existentes) ────

async def registrar_notificacion_vendedor(telefono: str, categoria: str, netsuite_ref: str,
                                           total: float, vendedor_asignado: str,
                                           vendedor_whatsapp: str, notificado: bool,
                                           folio: str = "", huella_pedido: str = "") -> int:
    async with async_session() as session:
        n = NotificacionVendedor(
            telefono=telefono, categoria=categoria, netsuite_ref=netsuite_ref, total=total,
            vendedor_asignado=vendedor_asignado, vendedor_whatsapp=vendedor_whatsapp,
            notificado=1 if notificado else 0,
            folio=folio, huella_pedido=huella_pedido,
        )
        session.add(n)
        await session.commit()
        await session.refresh(n)
        return n.id


async def oportunidad_reciente(telefono: str, huella_pedido: str,
                               dentro_de_minutos: int) -> dict | None:
    """La oportunidad que este teléfono ya generó por ESTE mismo pedido, si
    ocurrió dentro de la ventana. None si no hay.

    Es el candado contra cotizaciones duplicadas. El caso real que lo motivó:
    el cliente escribió "l a1" (un dedazo), Claudia lo leyó como confirmación
    y cotizó; el cliente corrigió con "opcion1" y Claudia cotizó otra vez. Dos
    documentos formales en NetSuite para un solo pedido.

    Se compara la huella y no solo el teléfono a propósito: un cliente que
    luego quiere cotizar OTRA cosa tiene todo el derecho a un folio nuevo. Lo
    que se bloquea es repetir el mismo pedido, no volver a cotizar.
    """
    if not huella_pedido:
        return None
    corte = datetime.utcnow() - timedelta(minutes=dentro_de_minutos)
    async with async_session() as session:
        result = await session.execute(
            select(NotificacionVendedor)
            .where(NotificacionVendedor.telefono == telefono,
                   NotificacionVendedor.categoria == "lead_nuevo",
                   NotificacionVendedor.huella_pedido == huella_pedido,
                   NotificacionVendedor.creado >= corte)
            .order_by(NotificacionVendedor.creado.desc())
            .limit(1)
        )
        n = result.scalar_one_or_none()
        if n is None:
            return None
        return {"folio": n.folio, "opportunity_id": n.netsuite_ref, "total": n.total,
                "vendedor_asignado": n.vendedor_asignado, "notificado": bool(n.notificado)}


# ── Tickets de soporte ──────────────────────────────────────────────────

async def crear_ticket(telefono: str, problema: str) -> int:
    async with async_session() as session:
        ticket = Ticket(telefono=telefono, problema=problema, estado="abierto")
        session.add(ticket)
        await session.commit()
        await session.refresh(ticket)
        return ticket.id


async def consultar_tickets(telefono: str) -> list[dict]:
    async with async_session() as session:
        result = await session.execute(
            select(Ticket).where(Ticket.telefono == telefono).order_by(Ticket.creado.desc())
        )
        return [
            {"id": t.id, "problema": t.problema, "estado": t.estado}
            for t in result.scalars().all()
        ]


# ── Usuarios del panel de administración (/admin) ───────────────────────

async def contar_usuarios_admin() -> int:
    async with async_session() as session:
        return (await session.execute(select(func.count()).select_from(UsuarioAdmin))).scalar_one()


async def crear_usuario_admin(usuario: str, password_hash: str, password_salt: str):
    async with async_session() as session:
        session.add(UsuarioAdmin(usuario=usuario, password_hash=password_hash, password_salt=password_salt))
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise ValueError(f"El usuario '{usuario}' ya existe")


async def obtener_usuario_admin(usuario: str) -> dict | None:
    async with async_session() as session:
        result = await session.execute(select(UsuarioAdmin).where(UsuarioAdmin.usuario == usuario))
        u = result.scalar_one_or_none()
        if not u:
            return None
        return {"usuario": u.usuario, "password_hash": u.password_hash, "password_salt": u.password_salt}


async def listar_usuarios_admin() -> list[dict]:
    async with async_session() as session:
        result = await session.execute(select(UsuarioAdmin).order_by(UsuarioAdmin.creado))
        return [
            {"usuario": u.usuario, "creado": u.creado.isoformat(timespec="seconds")}
            for u in result.scalars().all()
        ]


async def actualizar_password_usuario_admin(usuario: str, password_hash: str, password_salt: str) -> bool:
    async with async_session() as session:
        result = await session.execute(select(UsuarioAdmin).where(UsuarioAdmin.usuario == usuario))
        u = result.scalar_one_or_none()
        if not u:
            return False
        u.password_hash = password_hash
        u.password_salt = password_salt
        await session.commit()
        return True


async def eliminar_usuario_admin(usuario: str) -> bool:
    async with async_session() as session:
        result = await session.execute(select(UsuarioAdmin).where(UsuarioAdmin.usuario == usuario))
        u = result.scalar_one_or_none()
        if not u:
            return False
        await session.delete(u)
        await session.commit()
        return True


# ── Centro de Aprendizaje: propuestas de estrategia/KPI ──────────────────

async def crear_propuesta_aprendizaje(titulo: str, categoria: str, descripcion: str,
                                       evidencia: str = "", origen: str = "manual") -> int:
    async with async_session() as session:
        p = PropuestaAprendizaje(titulo=titulo, categoria=categoria, descripcion=descripcion,
                                  evidencia=evidencia, origen=origen)
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return p.id


async def listar_propuestas_aprendizaje(estado: str = "") -> list[dict]:
    async with async_session() as session:
        query = select(PropuestaAprendizaje).order_by(PropuestaAprendizaje.creado.desc())
        if estado:
            query = query.where(PropuestaAprendizaje.estado == estado)
        result = await session.execute(query)
        return [
            {"id": p.id, "titulo": p.titulo, "categoria": p.categoria, "descripcion": p.descripcion,
             "evidencia": p.evidencia, "origen": p.origen, "estado": p.estado,
             "creado": p.creado.isoformat(timespec="seconds"),
             "revisado": p.revisado.isoformat(timespec="seconds") if p.revisado else None}
            for p in result.scalars().all()
        ]


async def actualizar_estado_propuesta(propuesta_id: int, estado: str) -> dict | None:
    async with async_session() as session:
        result = await session.execute(select(PropuestaAprendizaje).where(PropuestaAprendizaje.id == propuesta_id))
        p = result.scalar_one_or_none()
        if not p:
            return None
        p.estado = estado
        p.revisado = datetime.utcnow()
        await session.commit()
        return {"id": p.id, "titulo": p.titulo, "categoria": p.categoria, "origen": p.origen,
                "descripcion": p.descripcion, "evidencia": p.evidencia, "estado": p.estado}


# ── Centro de Aprendizaje: notas para Claude Code ─────────────────────────

async def crear_nota_claude_code(texto: str) -> int:
    async with async_session() as session:
        n = NotaClaudeCode(texto=texto)
        session.add(n)
        await session.commit()
        await session.refresh(n)
        return n.id


async def listar_notas_claude_code(estado: str = "") -> list[dict]:
    async with async_session() as session:
        query = select(NotaClaudeCode).order_by(NotaClaudeCode.creado.desc())
        if estado:
            query = query.where(NotaClaudeCode.estado == estado)
        result = await session.execute(query)
        return [
            {"id": n.id, "texto": n.texto, "estado": n.estado,
             "creado": n.creado.isoformat(timespec="seconds"),
             "atendido": n.atendido.isoformat(timespec="seconds") if n.atendido else None}
            for n in result.scalars().all()
        ]


async def actualizar_estado_nota(nota_id: int, estado: str) -> bool:
    async with async_session() as session:
        result = await session.execute(select(NotaClaudeCode).where(NotaClaudeCode.id == nota_id))
        n = result.scalar_one_or_none()
        if not n:
            return False
        n.estado = estado
        n.atendido = datetime.utcnow() if estado == "atendida" else None
        await session.commit()
        return True
