# tests/test_catalogo.py — Busqueda en el catalogo de NetSuite
# Generado por AgentKit

"""
Tests de consultar_catalogo (agent/tools.py).

POR QUE EXISTEN ESTOS TESTS
---------------------------
Claudia rechazo tres ventas reales diciendo que no habia producto cuando
si lo habia. Se creia un problema de prompt; era del codigo. Dos bugs que
se reforzaban entre si:

BUG 1 — total_coincidencias mentia.
    filas = sorted(filas, ...)[:limite]      # trunca a 5
    "total_coincidencias": len(resultados)   # reporta 5, no el total real
  Para "polipasto 5 ton" habia 49 coincidencias reales; la herramienta le
  informaba 5. Claudia no alucinaba el negativo: reportaba fielmente lo
  que se le decia. Por eso preguntarle "¿que otras marcas manejas?" no
  servia — buscaba otra vez y recibia la misma mentira.

BUG 2 — las abreviaturas ocultaban marcas enteras.
  La busqueda exige que cada palabra aparezca como subcadena, y NetSuite
  mezcla formas en los nombres:
      POLIPASTO ELECTRICO DE CADENA POLIMAX 5 TON       "ELECTRICO"
      POLIPASTO ELECT. DE CADENA POLICHAIN FIJO 5 TON   "ELECT."
  '%electrico%' no coincide con 'ELECT.', asi que buscar "polipasto
  electrico" escondia el Polichain de $64,837.61 — $11,425.99 mas barato
  que el POLIMAX que si mostraba, mismo tipo y misma elevacion.

Estos tests corren contra el catalogo REAL sincronizado. Si no existe
netsuite_sync.db se saltan: prefiero saltarlos a tener tests verdes que
no prueban nada.

Correr con:  python -m pytest tests/test_catalogo.py -v
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
# 1. Normalizacion de abreviaturas — el bug que escondia marcas
# ══════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("entrada,esperado", [
    ("toneladas", "ton"),
    ("tonelada", "ton"),
    ("metros", "mts"),
])
def test_los_sinonimos_explicitos_se_normalizan(entrada, esperado):
    """Equivalencias que NO son abreviaturas del catálogo y por eso siguen
    declaradas a mano."""
    assert tools._normalizar_palabras_busqueda([entrada]) == [esperado]


@pytest.mark.parametrize("entrada", ["electrico", "eléctrico", "capacidad", "elevación"])
def test_las_abreviaturas_ya_no_se_normalizan_aqui(entrada):
    """
    Antes se mapeaban a mano (electrico -> 'elect'). Ese enfoque fallaba:
    'elect' no casa con 'ELEC.' (le falta una letra) y la lista dejaba
    fuera GALV., INOX., POLIP. y varias más. Ahora las abreviaturas se
    aprenden del catálogo — ver tests/test_abreviaturas.py.

    Aquí la palabra debe pasar entera (solo sin acentos); la expansión
    ocurre después, en _alternativas_de.
    """
    salida = tools._normalizar_palabras_busqueda([entrada])
    assert salida == [tools._sin_acentos(entrada).lower()]


def test_las_palabras_normales_no_se_tocan():
    assert tools._normalizar_palabras_busqueda(["polipasto", "polichain"]) == ["polipasto", "polichain"]


def test_los_acentos_se_quitan():
    """Los nombres de NetSuite vienen sin acentos; los clientes escriben con."""
    assert tools._normalizar_palabras_busqueda(["cadéna"]) == ["cadena"]


# ══════════════════════════════════════════════════════════════════
# 2. Los tres casos reales, como regresion
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_polipasto_electrico_5ton_encuentra_las_dos_marcas():
    """
    EL CASO. Un cliente pidio polipasto electrico de 5 toneladas.
    Claudia mostro solo POLIMAX ($76,263.60) y omitio POLICHAIN
    ($64,837.61) — $11,425.99 mas barato, mismo tipo, misma elevacion,
    tambien en stock. Ambos deben aparecer.
    """
    r = tools.consultar_catalogo("polipasto electrico 5 toneladas", limite=20)
    nombres = " | ".join(x["nombre"].upper() for x in r["resultados"])
    assert "POLIMAX" in nombres
    assert "POLICHAIN" in nombres, (
        "el Polichain 5 TON sigue oculto: la abreviatura 'ELECT.' no "
        f"coincide con 'electrico'. Resultados: {nombres}"
    )


@requiere_catalogo
def test_preguntar_por_marcas_devuelve_mas_de_una():
    """Segundo caso: le preguntaron '¿que otras marcas manejas?' y contesto
    que solo POLIMAX."""
    r = tools.consultar_catalogo("polipasto electrico cadena 5 ton", limite=20)
    marcas = {m for m in ("POLIMAX", "POLICHAIN", "POLICRANE", "POLISTAR")
              if any(m in x["nombre"].upper() for x in r["resultados"])}
    assert len(marcas) >= 2, f"solo se encontro: {marcas or 'ninguna marca'}"


@requiere_catalogo
def test_cable_inoxidable_tres_cuartos_existe():
    """Tercer caso, el documentado en APRENDIZAJE_CONOCIMIENTO.md: Claudia
    respondio 'no contamos con 3/4 en inoxidable' — falso."""
    r = tools.consultar_catalogo("cable acero inoxidable 3/4", limite=20)
    assert r["total_coincidencias"] > 0
    assert any("INOXIDABLE" in x["nombre"].upper() for x in r["resultados"])


# ══════════════════════════════════════════════════════════════════
# 3. total_coincidencias debe decir la VERDAD — el bug central
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_total_coincidencias_es_el_total_real_no_el_truncado():
    """
    El bug que hacia que Claudia afirmara negativos con seguridad. Si la
    herramienta reporta 5 cuando hay 49, el modelo no tiene forma de saber
    que existe algo mas — y decir "esto es todo lo que hay" es, para el,
    literalmente cierto.
    """
    r = tools.consultar_catalogo("polipasto 5 ton", limite=5)
    assert len(r["resultados"]) <= 5
    assert r["total_coincidencias"] > 5, (
        "total_coincidencias sigue contando solo los resultados devueltos "
        f"({r['total_coincidencias']}) en vez del total real de coincidencias"
    )


@requiere_catalogo
def test_avisa_cuando_hay_resultados_ocultos():
    """El modelo debe poder distinguir 'esto es todo' de 'hay mas'."""
    r = tools.consultar_catalogo("polipasto", limite=3)
    assert r.get("hay_mas") is True
    assert r.get("mostrados") == 3
    assert r["total_coincidencias"] > 3


@requiere_catalogo
def test_no_avisa_de_ocultos_cuando_cabe_todo():
    r = tools.consultar_catalogo("polipasto electrico cadena polimax 5 ton", limite=20)
    if r["total_coincidencias"] <= 20:
        assert r.get("hay_mas") is False


@requiere_catalogo
def test_sin_coincidencias_es_cero_y_no_dice_hay_mas():
    r = tools.consultar_catalogo("xyzabc-articulo-que-no-existe")
    assert r["total_coincidencias"] == 0
    assert r["resultados"] == []
    assert r.get("hay_mas") is False


# ══════════════════════════════════════════════════════════════════
# 4. Que no se rompa lo que ya funcionaba
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_sigue_encontrando_por_palabras_en_cualquier_orden():
    """'cadena 3/8' debe encontrar 'CADENA GRADO 80 3/8' aunque haya
    palabras en medio."""
    r = tools.consultar_catalogo("cadena 3/8", limite=10)
    assert r["total_coincidencias"] > 0


@requiere_catalogo
def test_los_resultados_traen_precio_y_existencia():
    r = tools.consultar_catalogo("polipasto polimax 5 ton", limite=5)
    assert r["resultados"], "sin resultados"
    primero = r["resultados"][0]
    for campo in ("codigo", "nombre", "disponible", "existencia", "precio"):
        assert campo in primero


@requiere_catalogo
def test_consulta_vacia_no_revienta():
    r = tools.consultar_catalogo("   ")
    assert r["total_coincidencias"] == 0
    assert r["resultados"] == []
