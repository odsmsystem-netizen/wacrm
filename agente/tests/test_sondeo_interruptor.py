# tests/test_sondeo_interruptor.py — El interruptor general de Claudia

"""
Cubre el contrato del interruptor verde/rojo que el admin mueve en la
barra superior del CRM (campo `activa`, ver agent/config_remota.py):

- Apagada, el sondeo NO genera ni envía respuesta, pero SÍ avanza el
  marcador de mensajes vistos — la decisión clave documentada en
  agent/sondeo_wacrm.py:_revisar. Si el marcador se congelara, al
  reactivarla Claudia respondería de golpe a todo lo acumulado, incluidas
  las conversaciones que un vendedor ya atendió a mano mientras estaba
  apagada.
- Encendida, el sondeo se comporta exactamente como antes de que
  existiera el interruptor.
- El aviso de "está apagada" se loguea solo al CAMBIAR de estado, nunca
  una vez por conversación por vuelta (el sondeo corre cada pocos
  segundos; eso serían miles de líneas por hora).
"""

import pytest

from agent import config_remota, sondeo_wacrm


class _RespuestaFalsa:
    """Doble mínimo de una respuesta de httpx: solo lo que _pedir usa."""

    def __init__(self, datos):
        self.status_code = 200
        self._datos = {"data": datos}
        self.text = ""

    def json(self):
        return self._datos


class ClienteFalso:
    """Doble de httpx.AsyncClient que enruta por la URL pedida: la lista
    de conversaciones, o los mensajes de una conversación en particular
    (agent/sondeo_wacrm.py:_pedir solo llama a client.get)."""

    def __init__(self, conversaciones: list[dict], mensajes_por_conv: dict[str, list[dict]]):
        self._conversaciones = conversaciones
        self._mensajes_por_conv = mensajes_por_conv

    async def get(self, url, **kwargs):
        if "/messages" in url:
            conv_id = url.split("/conversations/")[1].split("/messages")[0]
            return _RespuestaFalsa(self._mensajes_por_conv.get(conv_id, []))
        return _RespuestaFalsa(self._conversaciones)


def _conversacion_con_mensaje_nuevo() -> tuple[dict, dict]:
    """Una conversación abierta, sin dueño humano, con un mensaje entrante
    que todavía no se atendió (la marca cambió desde `estado`)."""
    conv = {
        "id": "c1",
        "last_message_at": "2026-01-02T00:00:00Z",
        "contact": {"phone": "5210000000"},
        "contact_id": "ct1",
    }
    mensajes = [{"id": "m1", "direction": "inbound", "content_text": "hola"}]
    return conv, mensajes


@pytest.mark.asyncio
async def test_apagada_no_responde_pero_avanza_el_marcador(monkeypatch):
    """El requisito central: apagada, Claudia no genera respuesta, pero el
    marcador (`ultimo_id`) sigue avanzando como si hubiera atendido."""
    monkeypatch.setattr(config_remota, "claudia_activa", lambda: False)

    llamadas = []

    async def atender_falso(telefono, texto):
        llamadas.append((telefono, texto))

    monkeypatch.setattr(sondeo_wacrm, "atender_mensaje", atender_falso)

    conv, mensajes = _conversacion_con_mensaje_nuevo()
    cliente = ClienteFalso([conv], {"c1": mensajes})
    estado = {"c1": {"marca": "marca-vieja", "ultimo_id": None}}
    fallos: dict = {}

    await sondeo_wacrm._revisar(cliente, "https://crm.test", "clave", estado, fallos, primera_vuelta=False)

    assert llamadas == [], "apagada, Claudia no debe generar ni enviar respuesta"
    assert estado["c1"]["ultimo_id"] == "m1", "el marcador debe avanzar aunque esté apagada"
    assert estado["c1"]["marca"] == "2026-01-02T00:00:00Z"


@pytest.mark.asyncio
async def test_encendida_responde_igual_que_antes(monkeypatch):
    """Con el interruptor encendido, el sondeo se comporta exactamente
    como antes de que existiera: genera y envía la respuesta, y avanza
    el marcador."""
    monkeypatch.setattr(config_remota, "claudia_activa", lambda: True)

    llamadas = []

    async def atender_falso(telefono, texto):
        llamadas.append((telefono, texto))

    monkeypatch.setattr(sondeo_wacrm, "atender_mensaje", atender_falso)

    conv, mensajes = _conversacion_con_mensaje_nuevo()
    cliente = ClienteFalso([conv], {"c1": mensajes})
    estado = {"c1": {"marca": "marca-vieja", "ultimo_id": None}}
    fallos: dict = {}

    await sondeo_wacrm._revisar(cliente, "https://crm.test", "clave", estado, fallos, primera_vuelta=False)

    assert llamadas == [("5210000000", "hola")], "encendida, debe atender el mensaje como siempre"
    assert estado["c1"]["ultimo_id"] == "m1"


@pytest.mark.asyncio
async def test_apagada_no_reintenta_como_si_hubiera_fallado(monkeypatch):
    """Saltarse la respuesta por estar apagada NO es un fallo: no debe
    sumar a `fallos` ni disparar el aviso de MAX_INTENTOS."""
    monkeypatch.setattr(config_remota, "claudia_activa", lambda: False)
    monkeypatch.setattr(sondeo_wacrm, "atender_mensaje", None)  # si se llamara, TypeError

    conv, mensajes = _conversacion_con_mensaje_nuevo()
    cliente = ClienteFalso([conv], {"c1": mensajes})
    estado = {"c1": {"marca": "marca-vieja", "ultimo_id": None}}
    fallos: dict = {}

    await sondeo_wacrm._revisar(cliente, "https://crm.test", "clave", estado, fallos, primera_vuelta=False)

    assert fallos == {}, "apagada no es un fallo: no debe registrarse como intento fallido"


def test_aviso_de_apagado_se_loguea_solo_al_cambiar_de_estado(caplog):
    """Con el sondeo cada pocos segundos, avisar en cada vuelta inundaría
    el log. Solo debe aparecer cuando el estado de verdad cambia."""
    sondeo_wacrm._activa_avisada = True
    try:
        with caplog.at_level("WARNING", logger="agentkit"):
            sondeo_wacrm._avisar_cambio_activa(False)
            sondeo_wacrm._avisar_cambio_activa(False)
            sondeo_wacrm._avisar_cambio_activa(False)
        avisos_apagado = [r for r in caplog.records if "apagada" in r.message]
        assert len(avisos_apagado) == 1, "debe avisar una sola vez, no una por vuelta"
    finally:
        sondeo_wacrm._activa_avisada = True  # no contaminar otras pruebas


def test_aviso_de_reactivado_se_loguea_al_volver_a_encender(caplog):
    """El otro lado del cambio de estado: al reactivarla también debe
    quedar constancia en el log (una sola vez)."""
    sondeo_wacrm._activa_avisada = False
    try:
        with caplog.at_level("INFO", logger="agentkit"):
            sondeo_wacrm._avisar_cambio_activa(True)
            sondeo_wacrm._avisar_cambio_activa(True)
        avisos = [r for r in caplog.records if "reactivada" in r.message]
        assert len(avisos) == 1
    finally:
        sondeo_wacrm._activa_avisada = True
