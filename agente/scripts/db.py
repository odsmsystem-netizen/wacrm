# scripts/db.py — Motor de base de datos local con los datos sincronizados
# de NetSuite (catálogo de artículos y roster de clientes).
#
# Por qué SQLite y no JSON: con miles de artículos y clientes, indexar por
# nombre/RFC y hacer búsquedas rápidas es mucho más eficiente que cargar y
# recorrer un archivo JSON completo en cada mensaje de WhatsApp — menos
# tiempo de respuesta y menos trabajo por mensaje.
#
# Este archivo lo usan tanto los scripts de sincronización (escritura) como
# agent/tools.py en vivo (solo lectura) — nunca se consulta NetSuite
# directamente durante la conversación, todo sale de aquí.

import os
import sqlite3

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Dónde vive el archivo. Configurable porque en Railway el filesystem del
# contenedor es EFÍMERO: se borra en cada redeploy, y con él los 3,156
# artículos y 8,772 clientes sincronizados — el agente quedaría sin catálogo
# hasta el siguiente sync. Apuntando NETSUITE_DB_PATH a un volumen montado
# (ej. /data/netsuite_sync.db) los datos sobreviven.
# En local no hace falta tocar nada: el default es la raíz del proyecto.
DB_PATH = os.getenv("NETSUITE_DB_PATH") or os.path.join(ROOT_DIR, "netsuite_sync.db")


def asegurar_directorio():
    """Crea la carpeta contenedora si no existe (el punto de montaje de un
    volumen puede venir vacío en el primer arranque)."""
    carpeta = os.path.dirname(os.path.abspath(DB_PATH))
    if carpeta:
        os.makedirs(carpeta, exist_ok=True)

ESQUEMA = """
CREATE TABLE IF NOT EXISTS articulos (
    -- item_id (no codigo) es la llave primaria: un mismo "codigo" visible
    -- puede pertenecer a DOS artículos distintos y reales en NetSuite (visto
    -- en la práctica: EPD5/8X1.30-1B y S1230, cada uno un Artículo de
    -- Inventario Y un Grupo de Artículos con el mismo código). agent/tools.py
    -- ya maneja varios resultados por código (ordena por disponibilidad).
    item_id TEXT PRIMARY KEY,
    codigo TEXT NOT NULL,
    nombre TEXT NOT NULL,
    nombre_interno TEXT,
    tipo TEXT,
    grupo TEXT,
    linea TEXT,
    importado INTEGER NOT NULL DEFAULT 0,
    existencia REAL NOT NULL DEFAULT 0,
    precio_escala_1 REAL,
    precio_escala_2 REAL,
    precio_escala_3 REAL,
    precio_escala_4 REAL,
    precio_escala_5 REAL
);
CREATE INDEX IF NOT EXISTS idx_articulos_nombre ON articulos(nombre);
CREATE INDEX IF NOT EXISTS idx_articulos_codigo ON articulos(codigo);

CREATE TABLE IF NOT EXISTS clientes (
    netsuite_id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    nombre_normalizado TEXT NOT NULL,
    rfc TEXT,
    rfc_normalizado TEXT,
    salesrep_id TEXT,
    salesrep_nombre TEXT
);
CREATE INDEX IF NOT EXISTS idx_clientes_nombre_norm ON clientes(nombre_normalizado);
CREATE INDEX IF NOT EXISTS idx_clientes_rfc_norm ON clientes(rfc_normalizado);

CREATE TABLE IF NOT EXISTS meta (
    clave TEXT PRIMARY KEY,
    valor TEXT
);
"""


def _migrar(con: sqlite3.Connection):
    """Agrega columnas nuevas a bases de datos creadas antes de que existieran
    (CREATE TABLE IF NOT EXISTS no las agrega solo). Idempotente."""
    columnas = {fila["name"] for fila in con.execute("PRAGMA table_info(articulos)")}
    if "grupo" not in columnas:
        con.execute("ALTER TABLE articulos ADD COLUMN grupo TEXT")


def conectar() -> sqlite3.Connection:
    asegurar_directorio()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(ESQUEMA)
    _migrar(con)
    return con


def normalizar(texto: str) -> str:
    """Nombre/RFC normalizado para comparar sin errores de captura triviales:
    mayúsculas, sin acentos, espacios colapsados. NO hace fuzzy matching —
    solo limpia diferencias de formato, la igualdad sigue siendo exacta."""
    import unicodedata
    if not texto:
        return ""
    t = unicodedata.normalize("NFD", texto).encode("ascii", "ignore").decode("ascii")
    t = " ".join(t.upper().split())
    return t


def set_meta(con: sqlite3.Connection, clave: str, valor: str):
    con.execute(
        "INSERT INTO meta (clave, valor) VALUES (?, ?) "
        "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        (clave, valor),
    )


def get_meta(con: sqlite3.Connection, clave: str) -> str | None:
    row = con.execute("SELECT valor FROM meta WHERE clave = ?", (clave,)).fetchone()
    return row["valor"] if row else None
