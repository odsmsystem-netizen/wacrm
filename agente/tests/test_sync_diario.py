# tests/test_sync_diario.py — Tests del orquestador del sync diario
# Generado por AgentKit

"""
Tests de scripts/sync_diario.py.

LO QUE DE VERDAD IMPORTA AQUÍ es el código de salida. El .bat que este
script reemplaza corría las dos sincronizaciones en secuencia sin mirar si
la primera había fallado — y eso ya costó caro: el 30/07/2026 el catálogo
reventó con un IntegrityError, el .bat siguió adelante y reportó éxito, y
la base quedó a medias sin que nadie se enterara hasta días después.

Un cron (Railway o Task Scheduler) solo puede avisar de un fallo si el
proceso sale con código != 0. Si estos tests se rompen, volvemos a los
fallos silenciosos.

Correr con:  python -m pytest tests/test_sync_diario.py -v
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import sync_diario


@pytest.fixture
def log(tmp_path, monkeypatch):
    """Logger que escribe a un archivo temporal, no al log real del proyecto."""
    monkeypatch.setattr(sync_diario, "LOG_PATH", str(tmp_path / "sync.log"))
    return sync_diario.configurar_log()


# ══════════════════════════════════════════════════════════════════
# 1. Un paso que revienta se reporta como fallo (no se traga la excepción)
# ══════════════════════════════════════════════════════════════════

class _ModuloQueRevienta:
    @staticmethod
    def main():
        raise RuntimeError("NetSuite devolvio 401")


class _ModuloQueFunciona:
    @staticmethod
    def main():
        return None


def test_paso_exitoso_devuelve_true(log, monkeypatch):
    monkeypatch.setattr(sync_diario, "importar_modulo", lambda n: _ModuloQueFunciona)
    assert sync_diario.correr_paso("clientes", log) is True


def test_paso_que_revienta_devuelve_false(log, monkeypatch):
    monkeypatch.setattr(sync_diario, "importar_modulo", lambda n: _ModuloQueRevienta)
    assert sync_diario.correr_paso("clientes", log) is False


def test_el_traceback_queda_en_el_log(log, monkeypatch, tmp_path):
    """Sin el traceback en el log, un fallo nocturno es indepurable."""
    monkeypatch.setattr(sync_diario, "importar_modulo", lambda n: _ModuloQueRevienta)
    sync_diario.correr_paso("clientes", log)

    contenido = (tmp_path / "sync.log").read_text(encoding="utf-8")
    assert "NetSuite devolvio 401" in contenido
    assert "Traceback" in contenido


def test_una_excepcion_no_tumba_el_proceso(log, monkeypatch):
    """correr_paso debe atrapar, no propagar: si propaga, el segundo paso
    nunca corre aunque sea independiente del primero."""
    monkeypatch.setattr(sync_diario, "importar_modulo", lambda n: _ModuloQueRevienta)
    sync_diario.correr_paso("catalogo", log)  # no debe lanzar


# ══════════════════════════════════════════════════════════════════
# 2. El código de salida — lo que el cron necesita para poder avisar
# ══════════════════════════════════════════════════════════════════

def _preparar_main(monkeypatch, tmp_path, resultados: dict):
    """Deja main() listo para correr con resultados controlados."""
    monkeypatch.setattr(sync_diario, "LOG_PATH", str(tmp_path / "sync.log"))
    monkeypatch.setattr(sys, "argv", ["sync_diario.py"])
    monkeypatch.setattr(sync_diario, "correr_paso",
                        lambda clave, log: resultados[clave])


def test_todo_bien_sale_con_cero(monkeypatch, tmp_path):
    _preparar_main(monkeypatch, tmp_path, {"catalogo": True, "clientes": True})
    assert sync_diario.main() == 0


def test_un_paso_fallido_sale_con_uno(monkeypatch, tmp_path):
    """
    El caso exacto del 30/07: el catálogo falla, los clientes se sincronizan
    bien. El .bat reportaba éxito. Aquí DEBE reportar fallo.
    """
    _preparar_main(monkeypatch, tmp_path, {"catalogo": False, "clientes": True})
    assert sync_diario.main() == 1


def test_los_dos_fallidos_sale_con_uno(monkeypatch, tmp_path):
    _preparar_main(monkeypatch, tmp_path, {"catalogo": False, "clientes": False})
    assert sync_diario.main() == 1


def test_si_el_catalogo_falla_los_clientes_igual_se_intentan(monkeypatch, tmp_path):
    """Son independientes: que uno falle no debe cancelar el otro."""
    intentados = []

    monkeypatch.setattr(sync_diario, "LOG_PATH", str(tmp_path / "sync.log"))
    monkeypatch.setattr(sys, "argv", ["sync_diario.py"])

    def _registrar(clave, log):
        intentados.append(clave)
        return clave != "catalogo"

    monkeypatch.setattr(sync_diario, "correr_paso", _registrar)
    sync_diario.main()

    assert set(intentados) == {"catalogo", "clientes"}


def test_el_fallo_se_nombra_en_el_log(monkeypatch, tmp_path):
    _preparar_main(monkeypatch, tmp_path, {"catalogo": False, "clientes": True})
    sync_diario.main()

    contenido = (tmp_path / "sync.log").read_text(encoding="utf-8")
    assert "TERMINÓ CON ERRORES" in contenido
    assert "Catálogo" in contenido


# ══════════════════════════════════════════════════════════════════
# 3. --solo corre una sola sincronización
# ══════════════════════════════════════════════════════════════════

def test_solo_clientes_no_corre_el_catalogo(monkeypatch, tmp_path):
    intentados = []
    monkeypatch.setattr(sync_diario, "LOG_PATH", str(tmp_path / "sync.log"))
    monkeypatch.setattr(sys, "argv", ["sync_diario.py", "--solo", "clientes"])
    monkeypatch.setattr(sync_diario, "correr_paso",
                        lambda c, log: intentados.append(c) or True)

    sync_diario.main()
    assert intentados == ["clientes"]


# ══════════════════════════════════════════════════════════════════
# 4. La ruta de la base es configurable (volumen de Railway)
# ══════════════════════════════════════════════════════════════════

def test_la_ruta_de_la_base_se_puede_sobrescribir(monkeypatch, tmp_path):
    """
    En Railway el filesystem es efímero: sin poder apuntar la base a un
    volumen montado, los 3,156 artículos y 8,772 clientes se borran en
    cada redeploy.
    """
    destino = str(tmp_path / "vol" / "netsuite_sync.db")
    monkeypatch.setenv("NETSUITE_DB_PATH", destino)

    for modulo in ("db",):
        sys.modules.pop(modulo, None)
    import db as ns_db

    assert ns_db.DB_PATH == destino

    ns_db.asegurar_directorio()
    assert os.path.isdir(os.path.dirname(destino))


def test_sin_la_variable_usa_la_raiz_del_proyecto(monkeypatch):
    monkeypatch.delenv("NETSUITE_DB_PATH", raising=False)
    for modulo in ("db",):
        sys.modules.pop(modulo, None)
    import db as ns_db

    assert ns_db.DB_PATH.endswith("netsuite_sync.db")
    assert os.path.dirname(ns_db.DB_PATH) == ns_db.ROOT_DIR
