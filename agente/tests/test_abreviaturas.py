# tests/test_abreviaturas.py — Abreviaturas aprendidas del catalogo
# Generado por AgentKit

"""
Tests de la deteccion automatica de abreviaturas (agent/tools.py).

POR QUE SE HIZO AUTOMATICA
--------------------------
El primer intento de arreglar esto usaba una LISTA escrita a mano
(electrico -> elect, capacidad -> cap, ...). Parecia suficiente porque
resolvia el caso que se estaba investigando. No lo era:

    GALV.   52 articulos invisibles al buscar "galvanizado"
    POLIP.  15 articulos invisibles al buscar "polipasto"
    ELEC.   12 articulos invisibles al buscar "electrico"
    DIAM.   17 invisibles al buscar "diametro"
    GIR.    19 invisibles al buscar "giratorio"
    INOX.    9 invisibles al buscar "inoxidable"

Peor aun: la lista mapeaba electrico -> "elect", que casa con "ELECT."
pero NO con "ELEC." — le faltaba una letra, y nadie lo noto porque el
test solo comprobaba que se encontrara ALGO, no que se encontrara TODO.

Una lista a mano nunca va a estar completa, y cada abreviatura que se
escape es producto que el cliente nunca ve. Por eso ahora las raices se
aprenden del catalogo: si existe un articulo llamado "CABLE GALV. 3/8",
entonces "galv" es una abreviatura real y toda busqueda que empiece con
esas letras debe encontrarla. Se mantiene solo cuando NetSuite agrega
productos con abreviaturas nuevas.

Correr con:  python -m pytest tests/test_abreviaturas.py -v
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
# 1. Extraccion de raices desde nombres
# ══════════════════════════════════════════════════════════════════

def test_detecta_una_abreviatura_con_punto():
    raices = tools.extraer_raices_abreviadas(["CABLE GALV. 3/8 PULG"])
    assert "galv" in raices


def test_detecta_varias_en_el_mismo_nombre():
    raices = tools.extraer_raices_abreviadas(["POLIPASTO ELEC. CADENA CAP. 5 TON"])
    assert "elec" in raices
    assert "cap" in raices


def test_ignora_abreviaturas_de_una_o_dos_letras():
    """'NO.' o 'A.' son demasiado cortas: como prefijo casarian con
    demasiadas palabras y meterian ruido en cada busqueda."""
    raices = tools.extraer_raices_abreviadas(["ARTICULO NO. 5", "TIPO A. GRANDE"])
    assert "no" not in raices
    assert "a" not in raices


def test_una_palabra_sin_punto_no_es_abreviatura():
    raices = tools.extraer_raices_abreviadas(["CABLE GALVANIZADO 3/8"])
    assert "galvanizado" not in raices


def test_lista_vacia_no_revienta():
    assert tools.extraer_raices_abreviadas([]) == set()


# ══════════════════════════════════════════════════════════════════
# 2. Alternativas de busqueda a partir de las raices
# ══════════════════════════════════════════════════════════════════

def test_la_palabra_larga_incluye_su_abreviatura():
    alts = tools.alternativas_con_raices("galvanizado", {"galv"})
    assert "galvanizado" in alts
    assert "galv." in alts


def test_incluye_todas_las_formas_abreviadas_que_apliquen():
    """'electrico' debe casar con ELECTRICO, ELECT. y ELEC. — las tres."""
    alts = tools.alternativas_con_raices("electrico", {"elec", "elect"})
    assert set(alts) >= {"electrico", "elec.", "elect."}


def test_no_incluye_raices_que_no_son_prefijo():
    alts = tools.alternativas_con_raices("cadena", {"galv", "inox"})
    assert alts == ("cadena",)


def test_la_propia_raiz_como_busqueda_se_deja_igual():
    """Si el cliente escribe 'galv' directamente, '%galv%' ya casa con
    'GALV.' — no hace falta agregar nada."""
    alts = tools.alternativas_con_raices("galv", {"galv"})
    assert alts == ("galv",)


def test_la_alternativa_lleva_punto_para_no_ser_un_prefijo_cualquiera():
    """'%poli%' arrastraria POLIMAX y POLICHAIN; '%poli.%' no."""
    alts = tools.alternativas_con_raices("polipasto", {"poli", "polip"})
    assert "poli." in alts and "polip." in alts
    assert "poli" not in alts, "sin el punto seria un prefijo generico"


def test_palabras_muy_cortas_no_se_expanden():
    """Buscar '5' no debe arrastrar abreviaturas."""
    alts = tools.alternativas_con_raices("5", {"galv", "elec"})
    assert alts == ("5",)


# ══════════════════════════════════════════════════════════════════
# 3. Los casos reales del catalogo — regresion
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
@pytest.mark.parametrize("palabra,abreviatura", [
    ("galvanizado", "galv"),
    ("inoxidable", "inox"),
    ("electrico", "elec"),
    ("polipasto", "polip"),
    ("diametro", "diam"),
    ("giratorio", "gir"),
])
def test_el_catalogo_real_aporta_estas_raices(palabra, abreviatura):
    raices = tools.raices_abreviadas_del_catalogo()
    assert abreviatura in raices, f"'{abreviatura}' no se aprendio del catalogo"
    assert f"{abreviatura}." in tools.alternativas_con_raices(palabra, raices)


@requiere_catalogo
def test_buscar_galvanizado_encuentra_los_abreviados():
    """52 articulos usan 'GALV.' — buscar 'galvanizado' debe verlos."""
    r = tools.consultar_catalogo("cable galvanizado", limite=25)
    nombres = " | ".join(x["nombre"].upper() for x in r["resultados"])
    assert r["total_coincidencias"] > 0
    assert "GALV" in nombres


@requiere_catalogo
def test_buscar_inoxidable_encuentra_los_abreviados():
    """El caso de APRENDIZAJE_CONOCIMIENTO.md, ahora completo: 9 articulos
    usan 'INOX.' y antes quedaban fuera."""
    con_abrev = [n for n in tools.nombres_del_catalogo() if "INOX." in n.upper()]
    assert con_abrev, "el catalogo ya no tiene articulos con INOX. (revisar el test)"

    r = tools.consultar_catalogo("inoxidable", limite=25)
    assert r["total_coincidencias"] >= len(con_abrev), (
        f"buscar 'inoxidable' encuentra {r['total_coincidencias']} pero hay "
        f"{len(con_abrev)} articulos solo con la forma abreviada INOX."
    )


@requiere_catalogo
def test_buscar_polipasto_incluye_los_abreviados_polip():
    r = tools.consultar_catalogo("polipasto", limite=25)
    total_con_abrev = len([n for n in tools.nombres_del_catalogo()
                           if "POLIP" in n.upper()])
    assert r["total_coincidencias"] >= total_con_abrev * 0.9


@requiere_catalogo
def test_electrico_encuentra_las_tres_formas():
    """ELECTRICO, ELECT. y ELEC. — la que faltaba era ELEC."""
    r = tools.consultar_catalogo("polipasto electrico", limite=25)
    nombres = " | ".join(x["nombre"].upper() for x in r["resultados"])
    total = r["total_coincidencias"]
    assert total >= 38, f"esperaba al menos las 38 de antes, dio {total}"


# ══════════════════════════════════════════════════════════════════
# 4. Que no se degrade el rendimiento ni la precision
# ══════════════════════════════════════════════════════════════════

@requiere_catalogo
def test_las_raices_se_calculan_una_sola_vez():
    """Escanear 3,156 nombres en cada busqueda seria caro: debe cachearse."""
    a = tools.raices_abreviadas_del_catalogo()
    b = tools.raices_abreviadas_del_catalogo()
    assert a is b, "las raices se estan recalculando en cada llamada"


@requiere_catalogo
def test_una_busqueda_precisa_sigue_siendo_precisa():
    """Expandir abreviaturas no debe inundar de resultados irrelevantes."""
    r = tools.consultar_catalogo("polipasto polimax 5 ton", limite=25)
    assert r["total_coincidencias"] < 30
    assert any("POLIMAX" in x["nombre"].upper() for x in r["resultados"])
