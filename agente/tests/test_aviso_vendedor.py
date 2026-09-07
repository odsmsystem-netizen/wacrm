# tests/test_aviso_vendedor.py — Canalización de un cliente a su vendedor
# Generado por AgentKit

"""
Tests del momento mas delicado de todo el flujo: cuando Claudia deja de
atender al cliente y lo pasa a un vendedor humano.

POR QUE EXISTE
--------------
Salio de revisar una conversacion real (cliente existente, 100 m de cadena
grado 80, ~$26,000). Se encontraron dos fallas distintas en ese traspaso:

1. El cierre que se le manda al cliente ("en breve sera atendido por su
   asesor X") era el MISMO aunque el WhatsApp al vendedor no se hubiera
   entregado. En dos simulaciones reales el aviso fallo por la ventana de
   24h de Twilio cerrada (error 63016) y el cliente igual se despidio
   creyendo que ya lo iban a buscar. Nadie se enteraba.

2. La transcripcion que se le adjunta al vendedor se leia con
   obtener_historial, que aplica una ventana de sesion de 5 minutos. Si el
   cliente tardaba mas de 5 minutos en contestar — normal en WhatsApp — el
   vendedor recibia un archivo VACIO, solo con el encabezado.

LO QUE MAS IMPORTA PROBAR
-------------------------
Que nunca se le prometa al cliente algo que no ocurrio, y que el vendedor
reciba la conversacion completa y en orden. Las dos cosas fallan en
silencio: el sistema responde ok, el cliente se va tranquilo, y la venta
se pierde sin dejar rastro.

Correr con:  python -m pytest tests/test_aviso_vendedor.py -v
"""

import os
import sys
import asyncio
import datetime

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    """Base SQLite aislada + carpeta de transcripciones temporal."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'prueba.db'}")
    # Este archivo prueba justamente el envío del aviso, así que se fija
    # encendido: si no, hereda el .env de quien corra los tests y los
    # resultados dependerían de la máquina en vez del código.
    monkeypatch.setenv("AVISO_VENDEDOR_ENABLED", "true")
    for mod in [m for m in list(sys.modules) if m.startswith("agent.")]:
        sys.modules.pop(mod, None)
    import importlib
    memoria = importlib.import_module("agent.memory")
    herramientas = importlib.import_module("agent.tools")
    importlib.reload(memoria)
    importlib.reload(herramientas)
    herramientas.memory = memoria
    herramientas.TRANSCRIPTS_DIR = str(tmp_path / "transcripts")
    asyncio.run(memoria.inicializar_db())
    return memoria, herramientas


def _vendedora(herramientas, whatsapp):
    """Deja una sola vendedora en la cache (salesrep 115, la del caso real)."""
    herramientas._CACHE_VENDEDORES = [herramientas.normalizar_vendedor({
        "nombre": "Wendy Ariadna Penelope Lopez Reyes", "netsuite_id": "115",
        "email": "ventas4@ambarcargo.com", "whatsapp": whatsapp,
    })]


def _envejecer(memoria, tel, minutos):
    """Mueve los mensajes de esa conversacion N minutos hacia atras."""
    from sqlalchemy import update

    async def _run():
        async with memoria.async_session() as s:
            await s.execute(
                update(memoria.Mensaje).where(memoria.Mensaje.telefono == tel)
                .values(timestamp=datetime.datetime.utcnow() - datetime.timedelta(minutes=minutos))
            )
            await s.commit()
    asyncio.run(_run())


# ══════════════════════════════════════════════════════════════════
# 1. Lo que se le promete al cliente depende de si el aviso salio
# ══════════════════════════════════════════════════════════════════

def test_no_promete_atencion_si_el_aviso_no_se_entrego(entorno):
    """Vendedora sin WhatsApp dado de alta: el aviso es imposible de entregar,
    asi que el cierre NO puede afirmar que la van a atender en breve."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="")

    res = asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+521999", salesrep_id="115", cliente_netsuite_id="562",
        cliente_nombre="TUBOS PIRAMIDE S.A. DE C.V."))

    assert res["notificado"] is False
    assert "en breve será atendido" not in res["mensaje_cliente"]
    assert "quedó registrada" in res["mensaje_cliente"]


def test_si_promete_atencion_cuando_el_aviso_si_se_entrego(entorno, monkeypatch):
    """Con el aviso entregado, el cierre si puede prometer contacto directo."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="+5213338316311")

    async def _entregado(vendedor, resumen, media_url=None, datos_plantilla=None):
        return True
    monkeypatch.setattr(herramientas, "_notificar_vendedor", _entregado)

    res = asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+521999", salesrep_id="115", cliente_netsuite_id="562",
        cliente_nombre="TUBOS PIRAMIDE S.A. DE C.V."))

    assert res["notificado"] is True
    assert "en breve será atendido" in res["mensaje_cliente"]
    assert "Wendy Ariadna Penelope Lopez Reyes" in res["mensaje_cliente"]


def test_el_aviso_queda_registrado_aunque_no_se_entregue(entorno):
    """Aunque el WhatsApp falle, tiene que quedar la fila con notificado=0
    para que el panel lo muestre y alguien lo levante a mano."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="")

    asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+521999", salesrep_id="115"))

    from sqlalchemy import select

    async def _leer():
        async with memoria.async_session() as s:
            r = await s.execute(select(memoria.NotificacionVendedor))
            return r.scalars().all()

    filas = asyncio.run(_leer())
    assert len(filas) == 1
    assert filas[0].categoria == "cliente_existente"
    assert not filas[0].notificado  # SQLite lo guarda como 0, no como False


# ══════════════════════════════════════════════════════════════════
# 2. Plantilla de respaldo (ventana de 24h cerrada)
# ══════════════════════════════════════════════════════════════════

class _ProveedorFalso:
    """Proveedor de WhatsApp de mentiras: el mensaje libre siempre rebota
    (ventana de 24h cerrada) y la plantilla se comporta segun se le diga."""

    def __init__(self, plantilla_entrega):
        self.plantilla_entrega = plantilla_entrega
        self.variables_recibidas = None
        self.intentos_libres = 0

    async def enviar_mensaje(self, telefono, mensaje, media_url=None, confirmar_entrega=False):
        self.intentos_libres += 1
        return False

    async def enviar_plantilla(self, telefono, variables):
        self.variables_recibidas = variables
        return self.plantilla_entrega


def _con_proveedor(monkeypatch, proveedor):
    """Hace que el codigo use este proveedor falso, venga por donde venga.

    Se parchean las DOS puertas a proposito. Los avisos a vendedores salen
    por `obtener_proveedor_avisos`, que segun el .env de quien corra los
    tests puede resolver el proveedor por su cuenta en vez de delegar en
    `obtener_proveedor`. Parchear solo la segunda dejaba estos tests a
    merced de una variable de entorno local: pasaban o fallaban segun la
    maquina, que es la peor clase de test.
    """
    import agent.providers as providers
    monkeypatch.setattr(providers, "obtener_proveedor", lambda: proveedor)
    monkeypatch.setattr(providers, "obtener_proveedor_avisos", lambda: proveedor)


def test_si_el_mensaje_libre_rebota_se_reintenta_con_plantilla(entorno, monkeypatch):
    """El caso real: la vendedora no le ha escrito al bot en 24h. El aviso
    normal no pasa, pero la plantilla si — el aviso NO se pierde."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="+5213338316311")
    falso = _ProveedorFalso(plantilla_entrega=True)
    _con_proveedor(monkeypatch, falso)

    res = asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+5213330019019", salesrep_id="115", cliente_netsuite_id="562",
        cliente_nombre="TUBOS PIRAMIDE S.A. DE C.V."))

    assert falso.intentos_libres == 1
    assert res["notificado"] is True
    assert "en breve será atendido" in res["mensaje_cliente"]


def test_la_plantilla_recibe_vendedor_cliente_y_telefono_en_orden(entorno, monkeypatch):
    """Las variables van por posicion: si se desordenan, al vendedor le llega
    un mensaje con el telefono donde va el nombre."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="+5213338316311")
    falso = _ProveedorFalso(plantilla_entrega=True)
    _con_proveedor(monkeypatch, falso)

    asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+5213330019019", salesrep_id="115", cliente_netsuite_id="562",
        cliente_nombre="TUBOS PIRAMIDE S.A. DE C.V."))

    assert falso.variables_recibidas == {
        "1": "Wendy",
        "2": "TUBOS PIRAMIDE S.A. DE C.V.",
        "3": "+5213330019019",
    }


def test_si_la_plantilla_tampoco_pasa_no_se_le_miente_al_cliente(entorno, monkeypatch):
    """Ultimo recurso agotado: ni libre ni plantilla. El cierre con el cliente
    tiene que seguir siendo honesto."""
    memoria, herramientas = entorno
    _vendedora(herramientas, whatsapp="+5213338316311")
    _con_proveedor(monkeypatch, _ProveedorFalso(plantilla_entrega=False))

    res = asyncio.run(herramientas.notificar_vendedor_cliente_existente(
        "+5213330019019", salesrep_id="115", cliente_nombre="TUBOS PIRAMIDE S.A. DE C.V."))

    assert res["notificado"] is False
    assert "en breve será atendido" not in res["mensaje_cliente"]


def test_sin_plantilla_configurada_el_proveedor_no_intenta_nada(monkeypatch):
    """Si no se dio de alta la plantilla, enviar_plantilla regresa False sin
    llamar a Twilio — el sistema sigue igual que antes, sin romperse."""
    monkeypatch.delenv("TWILIO_CONTENT_SID_AVISO_VENDEDOR", raising=False)
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "ACtest")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setenv("TWILIO_PHONE_NUMBER", "+14155238886")
    from agent.providers.twilio import ProveedorTwilio

    proveedor = ProveedorTwilio()
    assert proveedor.content_sid_aviso == ""
    assert asyncio.run(proveedor.enviar_plantilla("+521999", {"1": "x"})) is False


# ══════════════════════════════════════════════════════════════════
# 3. La transcripcion que recibe el vendedor
# ══════════════════════════════════════════════════════════════════

def test_la_transcripcion_no_se_vacia_si_el_cliente_tardo_en_contestar(entorno):
    """Mas de 5 minutos sin escribir corta la sesion para efectos de contexto,
    pero NO debe borrar la conversacion que se le manda al vendedor."""
    memoria, herramientas = entorno
    tel = "+521999"

    async def _sembrar():
        await memoria.guardar_mensaje(tel, "user", "Necesito 100 metros de cadena de 3/8")
        await memoria.guardar_mensaje(tel, "assistant", "Manejamos grado 43, 70 y 80")
    asyncio.run(_sembrar())
    _envejecer(memoria, tel, minutos=7)

    # El contexto si se corta (comportamiento deseado, no lo tocamos)
    assert asyncio.run(memoria.obtener_historial(tel)) == []

    archivo = asyncio.run(herramientas._guardar_transcripcion(tel))
    contenido = open(os.path.join(herramientas.TRANSCRIPTS_DIR, archivo), encoding="utf-8").read()

    assert "100 metros de cadena" in contenido
    assert "grado 43, 70 y 80" in contenido


def test_la_transcripcion_respeta_el_orden_de_la_conversacion(entorno):
    """Aunque dos mensajes caigan en el mismo timestamp, la pregunta va antes
    que la respuesta — si no, el vendedor lee la conversacion al reves."""
    memoria, herramientas = entorno
    tel = "+521999"

    async def _sembrar():
        await memoria.guardar_mensaje(tel, "user", "PRIMERO pregunta el cliente")
        await memoria.guardar_mensaje(tel, "assistant", "DESPUES contesta Claudia")
    asyncio.run(_sembrar())
    _envejecer(memoria, tel, minutos=0)  # los deja con el MISMO timestamp

    archivo = asyncio.run(herramientas._guardar_transcripcion(tel))
    contenido = open(os.path.join(herramientas.TRANSCRIPTS_DIR, archivo), encoding="utf-8").read()

    assert contenido.index("PRIMERO") < contenido.index("DESPUES")
