"""El candado que impide cotizar dos veces el mismo pedido.

El caso real: el cliente escribió "l a1" (un dedazo), Claudia lo leyó como
confirmación y generó el folio 28; el cliente corrigió con "opcion1" y se
generó el folio 29. Dos documentos formales en NetSuite para un solo pedido.

Lo delicado es que el estado del carrito NO delata el problema: la primera
cotización lo deja confirmado, así que en el segundo intento Claudia vuelve
a agregar el artículo y el carrito luce igual de legítimo que la primera vez.
"""

import pytest

from agent.tools import _huella_pedido


def item(codigo, cantidad):
    return {"codigo": codigo, "cantidad": cantidad}


def test_el_mismo_pedido_da_la_misma_huella():
    assert _huella_pedido([item("2008-619", 100)]) == _huella_pedido([item("2008-619", 100)])


def test_el_orden_en_que_se_agregaron_no_cambia_la_huella():
    """Claudia puede agregar las líneas en distinto orden en cada intento;
    seguiría siendo el mismo pedido del cliente."""
    a = _huella_pedido([item("A-1", 2), item("B-2", 5)])
    b = _huella_pedido([item("B-2", 5), item("A-1", 2)])
    assert a == b


def test_otra_cantidad_es_otro_pedido():
    """Si pide 200 en vez de 100 quiere otra cosa: debe poder cotizarla."""
    assert _huella_pedido([item("2008-619", 100)]) != _huella_pedido([item("2008-619", 200)])


def test_otro_articulo_es_otro_pedido():
    assert _huella_pedido([item("2008-619", 100)]) != _huella_pedido([item("NXA7191-002", 100)])


def test_agregar_una_linea_extra_es_otro_pedido():
    uno = _huella_pedido([item("A-1", 1)])
    dos = _huella_pedido([item("A-1", 1), item("B-2", 1)])
    assert uno != dos


def test_la_cantidad_no_arrastra_ceros_decimales():
    """cantidad es float en la BD. Sin normalizar, 100 y 100.0 darían huellas
    distintas y el candado no cerraría."""
    assert _huella_pedido([item("A-1", 100)]) == _huella_pedido([item("A-1", 100.0)])


def test_pedido_vacio_no_produce_huella_que_bloquee():
    """Una huella vacía haría que oportunidad_reciente bloqueara cualquier
    cosa contra cualquier cosa. Debe devolver algo que nunca coincida por
    accidente — y oportunidad_reciente además la rechaza explícitamente."""
    assert _huella_pedido([]) == ""


@pytest.mark.asyncio
async def test_no_se_cotiza_dos_veces_el_mismo_pedido(monkeypatch):
    """La prueba que importa: dos llamadas seguidas a generar_oportunidad con
    el mismo pedido deben producir UNA sola oportunidad en NetSuite."""
    from agent import tools, memory

    telefono = "521999" + "0001"
    creadas = []

    cliente = {"nombre_completo": "Jesús Prueba", "empresa": "ACME",
               "correo": "j@acme.mx", "rfc": "AAA010101AAA"}
    carrito = [{"codigo": "2008-619", "nombre_articulo": "CABLE BOA 3/8",
                "cantidad": 100.0, "precio_unitario": 10.0}]

    # El carrito se vacía al confirmar, y Claudia lo vuelve a llenar en el
    # segundo intento — exactamente lo que pasó en producción.
    estado = {"confirmado": False}

    async def fake_ver_carrito(tel):
        return [] if estado["confirmado"] else list(carrito)

    async def fake_confirmar(tel):
        estado["confirmado"] = True
        return {"ok": True}

    guardadas = []

    async def fake_registrar(tel, categoria, ref, total, vend, wa, notif,
                             folio="", huella_pedido=""):
        guardadas.append({"telefono": tel, "categoria": categoria, "netsuite_ref": ref,
                          "total": total, "folio": folio, "huella_pedido": huella_pedido,
                          "vendedor_asignado": vend, "notificado": notif})
        return len(guardadas)

    async def fake_reciente(tel, huella, minutos):
        for g in reversed(guardadas):
            if (g["telefono"] == tel and g["categoria"] == "lead_nuevo"
                    and huella and g["huella_pedido"] == huella):
                return {"folio": g["folio"], "opportunity_id": g["netsuite_ref"],
                        "total": g["total"], "vendedor_asignado": g["vendedor_asignado"],
                        "notificado": bool(g["notificado"])}
        return None

    async def fake_obtener_cliente(tel):
        return cliente

    def fake_crear_oportunidad(lineas, memo, titulo):
        creadas.append(titulo)
        return {"ok": True, "opportunity_id": f"2600{len(creadas)}", "folio": str(27 + len(creadas))}

    class FakeFila(dict):
        """Debe ser TRUTHY: el código hace `if fila` para saber si el artículo
        existe en NetSuite. Un dict vacío se leería como "no encontrado"."""
        def __init__(self):
            super().__init__(item_id="ITEM-1")

    class FakeCon:
        def execute(self, *a, **k):
            return type("R", (), {"fetchone": lambda s: FakeFila()})()
        def close(self):
            pass

    monkeypatch.setattr(memory, "ver_carrito", fake_ver_carrito)
    monkeypatch.setattr(memory, "confirmar_pedido", fake_confirmar)
    monkeypatch.setattr(memory, "obtener_cliente", fake_obtener_cliente)
    monkeypatch.setattr(memory, "registrar_notificacion_vendedor", fake_registrar)
    monkeypatch.setattr(memory, "oportunidad_reciente", fake_reciente)
    monkeypatch.setattr(tools.ns, "crear_oportunidad", fake_crear_oportunidad)
    monkeypatch.setattr(tools.ns_db, "conectar", lambda: FakeCon())
    monkeypatch.setattr(tools, "_sortear_vendedor", lambda: None)

    # 1er intento: el dedazo "l a1". Cotiza de verdad.
    primera = await tools.generar_oportunidad(telefono)
    assert primera["ok"] and not primera.get("duplicado")
    assert primera["folio"] == "28"

    # Claudia vuelve a llenar el carrito al recibir "opcion1".
    estado["confirmado"] = False

    # 2º intento: NO debe crear nada nuevo en NetSuite.
    segunda = await tools.generar_oportunidad(telefono)
    assert segunda["ok"], "el cliente no debe ver un error por su propio dedazo"
    assert segunda["duplicado"] is True
    assert segunda["folio"] == "28", "debe repetir el folio original, no inventar otro"

    assert len(creadas) == 1, f"se crearon {len(creadas)} oportunidades en NetSuite, debía ser 1"
    assert estado["confirmado"], "el pedido repetido debe quedar confirmado, no arrastrarse"
