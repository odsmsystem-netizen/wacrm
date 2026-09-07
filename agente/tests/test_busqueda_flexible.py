# tests/test_busqueda_flexible.py — Reintento cuando la busqueda da cero
# Generado por AgentKit

"""
Tests del reintento progresivo de consultar_catalogo (agent/tools.py).

EL PROBLEMA
-----------
La busqueda exige que TODAS las palabras aparezcan en el nombre del
articulo. Basta una que el catalogo no use para devolver cero — y cero
resultados es, para el modelo, "no tenemos ese producto".

La palabra que mas dano hace es "acero". Medido en el catalogo real:

    articulos que son CABLE:      432
      dicen "ACERO" en el nombre:  40  (9%)
      NO lo dicen:                392  (91%)

"Cable de acero" es como se le llama en Mexico al producto principal del
negocio, asi que el cliente lo escribe siempre. Consultas naturales que
daban CERO:

    cable de acero inoxidable 3/4   -> 0
    grillete de acero 1/2           -> 0
    cadena de acero 3/8             -> 0

La primera es, literalmente, el caso documentado en
APRENDIZAJE_CONOCIMIENTO.md como fallo real con un cliente. Se atribuyo a
que el modelo sustituyo "inoxidable" por "galvanizado"; la causa de fondo
era que la palabra "acero" tumbaba la busqueda entera.

LA SOLUCION
-----------
Si la busqueda completa da cero, reintentar quitando las palabras menos
selectivas (las que aparecen en mas articulos) hasta encontrar algo. Y
DECIR cuales se ignoraron, para que Claudia pueda ser honesta con el
cliente en vez de presentar el resultado como si fuera exacto.

Correr con:  python -m pytest tests/test_busqueda_flexible.py -v
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from agent import tools

DB = os.path.join(ROOT, "netsuite_sync.db")
requiere_catalogo = pytest.mark.skipif(
    not os.path.exists(DB), reason="netsuite_sync.db no existe (correr el sync primero)"
)


# ══════════════════════════════════════════════════════════════════
# 1. Los casos reales que daban cero
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
@pytest.mark.parametrize("consulta", [
    "cable de acero inoxidable 3/4",
    "cable de acero galvanizado 1/2",
    "grillete de acero 1/2",
    "cadena de acero 3/8",
    "cable de acero 5/8",
])
def test_consultas_naturales_ya_no_dan_cero(consulta):
    """Como las escribe un cliente real, con 'de acero' incluido."""
    r = tools.consultar_catalogo(consulta, limite=10)
    assert r["total_coincidencias"] > 0, f"{consulta!r} sigue dando cero"


@requiere_catalogo
def test_el_caso_documentado_del_cable_inoxidable():
    """APRENDIZAJE_CONOCIMIENTO.md: el cliente pidio cable de acero
    inoxidable 3/4 y se le respondio que no habia. Si existe."""
    r = tools.consultar_catalogo("cable de acero inoxidable 3/4", limite=10)
    nombres = " | ".join(x["nombre"].upper() for x in r["resultados"])
    assert "INOXIDABLE" in nombres or "INOX" in nombres
    assert "3/4" in nombres


# ══════════════════════════════════════════════════════════════════
# 2. Transparencia: decir que se ignoro
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_avisa_que_palabras_ignoro():
    """Sin esto, Claudia presentaria un resultado aproximado como si fuera
    exacto — y ofrecer un producto que no es el pedido es peor que decir
    'no lo encontre'."""
    r = tools.consultar_catalogo("grillete de acero 1/2", limite=10)
    assert r.get("palabras_ignoradas"), "no reporta que ignoro alguna palabra"
    assert "acero" in [p.lower() for p in r["palabras_ignoradas"]]


@requiere_catalogo
def test_no_reporta_ignoradas_cuando_no_hizo_falta():
    """Una busqueda que encuentra a la primera no debe decir que ignoro nada."""
    r = tools.consultar_catalogo("polipasto polimax", limite=10)
    assert r["total_coincidencias"] > 0
    assert not r.get("palabras_ignoradas")


@requiere_catalogo
def test_la_busqueda_exacta_tiene_prioridad():
    """Si con todas las palabras hay resultados, NO debe relajarse: los
    exactos son mejores que los aproximados."""
    r = tools.consultar_catalogo("polipasto polimax 5 ton", limite=10)
    assert not r.get("palabras_ignoradas")
    assert r["total_coincidencias"] < 30


# ══════════════════════════════════════════════════════════════════
# 3. Que quite las palabras GENERICAS, no las que definen el producto
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_nunca_sacrifica_la_medida():
    """Quitar '3/4' devolveria cables de cualquier medida: seria peor que
    no encontrar nada, porque el cliente pidio una medida concreta."""
    r = tools.consultar_catalogo("cable de acero inoxidable 3/4", limite=10)
    ignoradas = [p.lower() for p in (r.get("palabras_ignoradas") or [])]
    assert "3/4" not in ignoradas


@requiere_catalogo
def test_nunca_sacrifica_el_material():
    """'inoxidable' es lo que distingue el producto — quitarlo llevaria a
    ofrecer galvanizado, que es exactamente el error documentado."""
    r = tools.consultar_catalogo("cable de acero inoxidable 3/4", limite=10)
    ignoradas = [p.lower() for p in (r.get("palabras_ignoradas") or [])]
    assert "inoxidable" not in ignoradas


@requiere_catalogo
def test_prefiere_quitar_la_palabra_mas_comun():
    """Entre varias candidatas, sale la que menos discrimina."""
    r = tools.consultar_catalogo("cable de acero galvanizado 1/2", limite=10)
    ignoradas = [p.lower() for p in (r.get("palabras_ignoradas") or [])]
    assert "galvanizado" not in ignoradas


@requiere_catalogo
@pytest.mark.parametrize("consulta,tipo", [
    ("cadena de acero 3/8", "cadena"),
    ("grillete de acero 1/2", "grillete"),
    ("cable de acero galvanizado 1/2", "cable"),
    ("polipasto de 5 toneladas electrico", "polipasto"),
])
def test_nunca_sacrifica_el_tipo_de_producto(consulta, tipo):
    """
    La palabra que dice QUÉ es el producto es intocable.

    Sin esta regla la heurística se volvía en contra: "cadena" aparece en
    muchos artículos, así que salía como poco selectiva y era la primera
    en caer — "cadena de acero 3/8" terminaba ofreciendo "CASQUILLO DE
    ACERO 3/8". Darle al cliente un producto distinto al que pidió es peor
    que no encontrarlo.
    """
    r = tools.consultar_catalogo(consulta, limite=10)
    ignoradas = [p.lower() for p in (r.get("palabras_ignoradas") or [])]
    assert tipo not in ignoradas, f"se sacrifico el tipo de producto en {consulta!r}"

    if r["resultados"]:
        nombres = " | ".join(x["nombre"].upper() for x in r["resultados"][:3])
        assert tipo.upper()[:5] in nombres, (
            f"el primer resultado de {consulta!r} no parece un {tipo}: {nombres}"
        )


# ══════════════════════════════════════════════════════════════════
# 4. Limites: no relajar hasta lo absurdo
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_un_producto_inexistente_sigue_dando_cero():
    """Relajar no debe convertir 'no existe' en 'aqui hay cualquier cosa'."""
    r = tools.consultar_catalogo("submarino nuclear de titanio", limite=10)
    assert r["total_coincidencias"] == 0


@requiere_catalogo
def test_no_relaja_una_sola_palabra():
    """Con una palabra no hay nada que quitar sin quedarse sin busqueda."""
    r = tools.consultar_catalogo("xyzabcinexistente", limite=10)
    assert r["total_coincidencias"] == 0
    assert not r.get("palabras_ignoradas")


@requiere_catalogo
def test_conserva_al_menos_una_palabra_significativa():
    r = tools.consultar_catalogo("de acero para el taller", limite=10)
    ignoradas = r.get("palabras_ignoradas") or []
    palabras = len("de acero para el taller".split())
    assert len(ignoradas) < palabras
