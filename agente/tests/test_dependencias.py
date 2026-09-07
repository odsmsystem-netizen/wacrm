# tests/test_dependencias.py — Toda import de terceros debe estar declarada
# Generado por AgentKit

"""
Verifica que cada libreria de terceros que el codigo importa este declarada
en requirements.txt (o en requirements-dev.txt si solo la usan los tests).

POR QUE EXISTE ESTE TEST
------------------------
El primer despliegue a Railway fallo con:

    File "/app/agent/netsuite_client.py", line 18, in <module>
        import requests
    ModuleNotFoundError: No module named 'requests'

En la maquina de desarrollo `requests` y `requests-oauthlib` estaban
instaladas globalmente, asi que todo funcionaba — pero el contenedor
arranca limpio y solo instala lo que dice requirements.txt. El error no
aparece hasta que ya construiste la imagen y desplegaste: costoso y lento
de descubrir.

Este test lo detecta en menos de un segundo, antes de subir nada.

Correr con:  python -m pytest tests/test_dependencias.py -v
"""

import ast
import sys
import pathlib

import pytest

RAIZ = pathlib.Path(__file__).resolve().parent.parent
CARPETAS_APP = ["agent", "scripts"]
CARPETA_TESTS = "tests"

def _modulos_locales() -> set[str]:
    """Modulos del propio proyecto, DERIVADOS del disco.

    Varios se importan por nombre suelto (`import db`, `import credenciales`)
    porque scripts/ entra al sys.path — ver agent/admin.py y agent/tools.py.
    Se calcula en vez de mantenerse a mano: una lista fija obliga a editar
    este test cada vez que se agrega un modulo, y olvidarlo da un falso
    positivo que parece una dependencia sin declarar.
    """
    nombres = {"agent", "scripts", "tests"}
    for carpeta in ("agent", "scripts", "tests"):
        for ruta in (RAIZ / carpeta).rglob("*.py"):
            if "__pycache__" not in ruta.parts:
                nombres.add(ruta.stem)
    return nombres


LOCALES = _modulos_locales()

# Cuando el nombre del import no coincide con el del paquete en pip.
NOMBRE_PIP = {
    "yaml": "pyyaml",
    "dotenv": "python-dotenv",
    "requests_oauthlib": "requests-oauthlib",
    "multipart": "python-multipart",
}


def _imports_de(carpetas: list[str]) -> dict[str, set[str]]:
    """{modulo_raiz: {archivos donde se importa}} para las carpetas dadas."""
    encontrados: dict[str, set[str]] = {}
    for carpeta in carpetas:
        for ruta in (RAIZ / carpeta).rglob("*.py"):
            if "__pycache__" in ruta.parts:
                continue
            try:
                arbol = ast.parse(ruta.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for nodo in ast.walk(arbol):
                if isinstance(nodo, ast.Import):
                    for alias in nodo.names:
                        encontrados.setdefault(alias.name.split(".")[0], set()).add(ruta.name)
                elif isinstance(nodo, ast.ImportFrom) and nodo.level == 0 and nodo.module:
                    encontrados.setdefault(nodo.module.split(".")[0], set()).add(ruta.name)
    return encontrados


def _terceros(encontrados: dict[str, set[str]]) -> dict[str, set[str]]:
    """Descarta stdlib y modulos del propio proyecto."""
    return {
        modulo: archivos
        for modulo, archivos in encontrados.items()
        if modulo not in sys.stdlib_module_names and modulo not in LOCALES
    }


def _normalizar(nombre: str) -> str:
    """PEP 503: los guiones, guiones bajos y puntos son equivalentes."""
    return nombre.strip().lower().replace("_", "-").replace(".", "-")


def _declarados(*archivos: str) -> set[str]:
    """Nombres de paquete declarados, PARSEADOS — no el texto crudo.

    Comparar por subcadena no sirve y ya dio un falso verde: 'requests'
    esta contenido dentro de 'requests-oauthlib', asi que quitar requests
    de requirements.txt seguia dando el test en verde. Hay que extraer el
    nombre real de cada linea.
    """
    nombres = set()
    for nombre_archivo in archivos:
        ruta = RAIZ / nombre_archivo
        if not ruta.exists():
            continue
        for linea in ruta.read_text(encoding="utf-8").splitlines():
            linea = linea.split("#")[0].strip()
            if not linea or linea.startswith("-"):
                continue
            # Cortar en el primer caracter de especificador de version o extra
            for sep in ("===", "==", ">=", "<=", "~=", "!=", ">", "<", "[", ";", " "):
                if sep in linea:
                    linea = linea.split(sep)[0]
            if linea:
                nombres.add(_normalizar(linea))
    return nombres


def test_requirements_existe():
    assert (RAIZ / "requirements.txt").is_file()


def test_el_parseo_no_confunde_nombres_con_prefijo_comun():
    """Guardia sobre el bug que tuvo este mismo archivo: 'requests' es
    subcadena de 'requests-oauthlib', y comparar por subcadena daba un
    falso verde al quitar requests de requirements.txt."""
    declarados = _declarados("requirements.txt")
    assert "requests" in declarados
    assert "requests-oauthlib" in declarados
    # Un paquete inexistente que SI es subcadena de otro declarado
    assert "async" not in declarados       # asyncpg esta, 'async' no
    assert "http" not in declarados        # httpx esta, 'http' no


def test_toda_dependencia_de_la_app_esta_en_requirements():
    """
    Si esto falla, el proximo `railway up` construira la imagen bien y
    revento al arrancar — exactamente el fallo que motivo este test.
    """
    declarados = _declarados("requirements.txt")
    faltantes = []

    for modulo, archivos in sorted(_terceros(_imports_de(CARPETAS_APP)).items()):
        paquete = NOMBRE_PIP.get(modulo, modulo)
        if _normalizar(paquete) not in declarados and _normalizar(modulo) not in declarados:
            faltantes.append(f"{paquete} (import '{modulo}', en {', '.join(sorted(archivos))})")

    assert not faltantes, (
        "Dependencias usadas por la aplicacion pero NO declaradas en "
        "requirements.txt:\n  " + "\n  ".join(faltantes)
    )


def test_las_dependencias_de_los_tests_estan_declaradas():
    """pytest y compania van en requirements-dev.txt, no en el de produccion:
    no tienen por que viajar dentro del contenedor."""
    declarados = _declarados("requirements.txt", "requirements-dev.txt")
    faltantes = []

    for modulo, archivos in sorted(_terceros(_imports_de([CARPETA_TESTS])).items()):
        paquete = NOMBRE_PIP.get(modulo, modulo)
        if _normalizar(paquete) not in declarados and _normalizar(modulo) not in declarados:
            faltantes.append(f"{paquete} (import '{modulo}', en {', '.join(sorted(archivos))})")

    assert not faltantes, (
        "Dependencias usadas por los tests pero no declaradas:\n  " + "\n  ".join(faltantes)
    )


def test_pytest_no_viaja_al_contenedor():
    """pytest en requirements.txt engordaria la imagen de produccion sin
    ninguna razon."""
    assert "pytest" not in _declarados("requirements.txt"), \
        "pytest debe ir en requirements-dev.txt, no en requirements.txt"


@pytest.mark.parametrize("paquete", ["requests", "requests-oauthlib", "asyncpg"])
def test_las_que_faltaron_siguen_declaradas(paquete):
    """Guardia explicita sobre las tres que se descubrieron tarde: requests
    y requests-oauthlib tumbaron el primer deploy; asyncpg habria tumbado
    la migracion a Postgres."""
    assert _normalizar(paquete) in _declarados("requirements.txt")
