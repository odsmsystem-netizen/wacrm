"""Qué mensajes considera nuevos el sondeo, y cuáles no.

Es la decisión más delicada de la integración: equivocarse por un lado
deja a un cliente sin respuesta, y por el otro le manda la misma dos
veces. Ninguna de las dos se nota mirando los logs por encima.
"""

import pytest

from agent.sondeo_wacrm import _entrantes_desde, _MAX_MENSAJES


def msg(mid, direccion="inbound", texto="hola"):
    """El CRM los devuelve del más nuevo al más viejo."""
    return {"id": mid, "direction": direccion, "content_text": texto}


def test_sin_marca_previa_devuelve_los_entrantes():
    """Primera vez que se ve la conversación. Quien llama decide qué
    hacer con ellos — el sondeo solo atiende el último."""
    hist = [msg("m3", texto="hola"), msg("m2", "outbound", "resp"), msg("m1", texto="viejo")]
    textos, ultimo = _entrantes_desde(hist, None)
    assert textos == ["viejo", "hola"]
    assert ultimo == "m3"


def test_sin_nada_nuevo_no_devuelve_nada():
    hist = [msg("m3"), msg("m2", "outbound"), msg("m1")]
    assert _entrantes_desde(hist, "m3") == ([], "m3")


def test_un_mensaje_nuevo():
    hist = [msg("m4", texto="nuevo"), msg("m3"), msg("m2", "outbound")]
    assert _entrantes_desde(hist, "m3") == (["nuevo"], "m4")


def test_varios_seguidos_en_orden_cronologico():
    hist = [msg("m5", texto="segundo"), msg("m4", texto="primero"), msg("m3")]
    assert _entrantes_desde(hist, "m3") == (["primero", "segundo"], "m5")


def test_lo_saliente_no_cuenta():
    """Las respuestas de Claudia salen en la misma lista. Tratarlas como
    entrantes la haría contestarse a sí misma en bucle."""
    hist = [msg("m5", "outbound", "respuesta de Claudia"), msg("m4")]
    assert _entrantes_desde(hist, "m4") == ([], "m5")


def test_entrante_sin_texto_no_dispara_respuesta():
    """Una imagen sin pie llega con content_text vacío."""
    hist = [msg("m4", texto=None), msg("m3")]
    assert _entrantes_desde(hist, "m3") == ([], "m4")


def test_conversacion_vacia_conserva_la_marca():
    assert _entrantes_desde([], "m3") == ([], "m3")


def test_si_el_corte_se_salio_de_la_ventana_solo_se_atiende_el_ultimo():
    """El caso que provoca respuestas duplicadas.

    Si desde la última revisión entraron más mensajes de los que caben en
    la ventana, el id que marcaba el corte ya no viene en la lista. Sin
    protección, TODA la ventana se tomaría como nueva y Claudia
    respondería otra vez a mensajes que ya contestó.
    """
    # Del más nuevo (t25) al más viejo (t1), como los devuelve el CRM.
    hist = [msg(f"m{i}", texto=f"t{i}") for i in range(_MAX_MENSAJES + 5, 0, -1)]
    textos, ultimo = _entrantes_desde(hist, "ya-no-esta-en-la-ventana")
    assert len(textos) == 1, "debe atender solo el último, no repetir la ventana"
    # El último es el MÁS RECIENTE: es el que el cliente acaba de
    # escribir y el que espera respuesta.
    assert textos == ["t25"]
    assert ultimo == "m25"


def test_el_id_devuelto_es_siempre_el_mas_reciente():
    """Aunque el más reciente sea saliente: es el corte para la próxima
    vuelta, no algo que atender."""
    hist = [msg("m9", "outbound"), msg("m8"), msg("m7")]
    _, ultimo = _entrantes_desde(hist, "m8")
    assert ultimo == "m9"
