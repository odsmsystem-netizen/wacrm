# agent/tools.py — Herramientas del agente
# Generado por AgentKit

"""
Herramientas específicas del negocio de Ambar Cargo. Cada función aquí puede
ser invocada por Claude durante la conversación (ver agent/brain.py, que
define los esquemas de estas herramientas para el tool-use de la API).
"""

import os
import re
import sys
import json
import yaml
import random
import secrets
import logging
from datetime import datetime

from agent import memory
from agent import netsuite_client as ns

logger = logging.getLogger("agentkit")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))
import db as ns_db  # motor SQLite con catálogo + clientes sincronizados de NetSuite

TRANSCRIPTS_DIR = "transcripts"
ESCALAS_PATH = os.path.join("config", "clientes_escala.yaml")
VENDEDORES_PATH = os.path.join("config", "vendedores_whatsapp.yaml")
ESCALA_DEFAULT = "Escala 1"

# Líneas de artículo con escala dinámica por cantidad (metros). El resto de
# los productos se queda en ESCALA_DEFAULT salvo excepción de cliente.
LINEAS_METRO = {"CABLE", "CADENA"}
# (tope_metros_inclusive, escala). El último tramo cubre "más de 2000".
RANGOS_METRO = [
    (500, "Escala 1"),
    (1000, "Escala 2"),
    (2000, "Escala 3"),
    (float("inf"), "Escala 4"),
]


def cargar_info_negocio() -> dict:
    """Carga la información del negocio desde business.yaml."""
    try:
        with open("config/business.yaml", "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        logger.error("config/business.yaml no encontrado")
        return {}


def obtener_horario() -> dict:
    """Retorna el horario de atención del negocio."""
    info = cargar_info_negocio()
    return {"horario": info.get("negocio", {}).get("horario", "No disponible")}


def buscar_en_knowledge(consulta: str) -> str:
    """Busca información relevante en los archivos de /knowledge (FAQ, políticas, etc.)."""
    resultados = []
    knowledge_dir = "knowledge"

    if not os.path.exists(knowledge_dir):
        return "No hay archivos de conocimiento disponibles."

    for archivo in os.listdir(knowledge_dir):
        ruta = os.path.join(knowledge_dir, archivo)
        if archivo.startswith(".") or not os.path.isfile(ruta):
            continue
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                contenido = f.read()
                if consulta.lower() in contenido.lower():
                    resultados.append(f"[{archivo}]: {contenido[:500]}")
        except (UnicodeDecodeError, IOError):
            continue

    if resultados:
        return "\n---\n".join(resultados)
    return "No encontré información específica sobre eso en mis archivos."


# ── Catálogo de artículos y precios (SQLite, sincronizado desde NetSuite) ──
#
# El catálogo NO se consulta a NetSuite en vivo durante la conversación: un
# job diario a las 7am (scripts/sync_netsuite_catalogo.py + Task Scheduler)
# lo descarga a netsuite_sync.db. Esto mantiene el bot rápido (consultas
# indexadas en SQLite en vez de recorrer un JSON completo) y no depende de
# que NetSuite esté disponible en el momento del chat.

def _cargar_excepciones_escala() -> dict:
    if not os.path.exists(ESCALAS_PATH):
        return {}
    try:
        with open(ESCALAS_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
            return data.get("clientes") or {}
    except (yaml.YAMLError, IOError) as exc:
        logger.error(f"No se pudo leer clientes_escala.yaml: {exc}")
        return {}


def escala_para_cliente(telefono: str) -> str:
    """Escala de precio que le corresponde a este cliente. Escala 1 por
    default; solo cambia si el número está en config/clientes_escala.yaml."""
    excepciones = _cargar_excepciones_escala()
    return excepciones.get(telefono, ESCALA_DEFAULT)


def _escala_por_cantidad(linea: str, cantidad) -> str | None:
    """Escala automática para CABLE/CADENA según metros pedidos. None si no
    aplica (otra línea, o no se dio cantidad)."""
    if (linea or "").upper() not in LINEAS_METRO or cantidad is None:
        return None
    try:
        c = float(cantidad)
    except (TypeError, ValueError):
        return None
    for tope, escala in RANGOS_METRO:
        if c <= tope:
            return escala
    return RANGOS_METRO[-1][1]


def _escala_efectiva(telefono: str, linea: str, cantidad) -> str:
    """
    Resuelve qué escala aplica: una excepción de cliente ya negociada SIEMPRE
    gana (es un acuerdo comercial explícito); si no hay excepción, cable y
    cadena usan la escala dinámica por cantidad; todo lo demás usa la escala
    default.
    """
    excepciones = _cargar_excepciones_escala()
    if telefono in excepciones:
        return excepciones[telefono]
    return _escala_por_cantidad(linea, cantidad) or ESCALA_DEFAULT


_COL_ESCALA = {
    "Escala 1": "precio_escala_1", "Escala 2": "precio_escala_2",
    "Escala 3": "precio_escala_3", "Escala 4": "precio_escala_4",
    "Escala 5": "precio_escala_5",
}


def _precio_en_escala(fila, escala: str) -> float | None:
    valor = fila[_COL_ESCALA.get(escala, "precio_escala_1")]
    return valor if valor is not None else fila["precio_escala_1"]


def _prioridad_disponibilidad(fila) -> tuple:
    """
    Orden de prioridad para elegir QUÉ variante mostrar cuando la búsqueda
    encuentra más de un artículo: primero importado con existencia, luego
    nacional con existencia, luego importado sin existencia, luego nacional
    sin existencia. Así "primero importación, si no hay disponibilidad el
    nacional" sale de la búsqueda misma — Claudia nunca decide ni menciona
    el tipo, solo recibe ya priorizado qué ofrecer.
    """
    sin_existencia = (fila["existencia"] or 0) <= 0
    no_importado = not fila["importado"]
    return (sin_existencia, no_importado)


def _numeros_enteros_busqueda(consulta: str) -> set[str]:
    """Tokens puramente numéricos que el cliente mencionó (ej. '1', '10') —
    NO fracciones tipo '3/4', esas ya son precisas por sí solas al buscar.
    Se usan para no confundir '1 tonelada' con un resultado de '10
    toneladas' solo porque '1' aparece como substring dentro de '10'."""
    return {p for p in consulta.split() if p.isdigit()}


def _tiene_numero_exacto(nombre: str, numeros: set[str]) -> bool:
    """True si `nombre` contiene alguno de `numeros` como número standalone
    (con límites que no sean otro dígito NI un punto decimal) — '1' debe
    matchear '1TON' pero NO '10TON' ni el '2' embebido en '3.2TON'. Si no
    se mencionó ningún número entero, no aplica (True)."""
    if not numeros:
        return True
    nombre = nombre or ""
    return any(re.search(rf"(?<![\d.]){re.escape(n)}(?![\d.])", nombre) for n in numeros)


def _prioridad_busqueda(fila, numeros_exactos: frozenset = frozenset(), termino_principal: str = "") -> tuple:
    """
    Para resultados de búsqueda de texto (no para un código exacto), en este
    orden: (1) disponibilidad, (2) si el número que pidió el cliente aparece
    EXACTO en el nombre — no embebido en uno más grande, evita ofrecer un
    producto de 10 toneladas cuando pidieron 1 solo porque "1" es substring
    de "10" —, (3) si el nombre EMPIEZA con la palabra principal buscada —
    evita que "INVERSOR PARA POLIPASTO DE 2 TON" (un accesorio) le gane a
    "POLIPASTO ... 2 TON" (el producto real) solo por ser más corto —, y por
    último (4) nombres más CORTOS como señal de relevancia. (Los 3 criterios
    numéricos/de accesorio se encontraron probando 20 conversaciones
    simuladas, ver simulaciones/.)
    """
    nombre = fila["nombre"] or ""
    coincide_numero = _tiene_numero_exacto(nombre, numeros_exactos)
    empieza_con_termino = not termino_principal or nombre.upper().startswith(termino_principal.upper())
    return _prioridad_disponibilidad(fila) + (not coincide_numero, not empieza_con_termino, len(nombre))


# Palabras naturales que el cliente dice pero que el catálogo NO usa igual
# (usa abreviaturas o símbolos): sin esto, "polipasto 1 tonelada" da CERO
# resultados aunque exista "POLIPASTO ... 1TON" (encontrado probando 20
# conversaciones simuladas — ver simulaciones/). Mapea a la forma que SÍ
# aparece en los nombres; None = quitar la palabra de la búsqueda (no
# exigir que aparezca) cuando no hay una forma única y confiable a la que
# mapear (ej. "pulgada" a veces es el símbolo " y a veces se escribe out).
_SINONIMOS_BUSQUEDA = {
    "tonelada": "ton", "toneladas": "ton", "tons": "ton",
    "pulgada": None, "pulgadas": None, "pulg": None,

    # ── Abreviaturas de NetSuite ──────────────────────────────────────
    # Los nombres del catálogo mezclan la forma larga y la abreviada para
    # el MISMO concepto, y la búsqueda exige que cada palabra aparezca
    # como subcadena. Resultado: '%electrico%' no coincide con 'ELECT.',
    # así que buscar "polipasto eléctrico" ocultaba marcas completas.
    #
    # Caso real: un cliente pidió polipasto eléctrico de 5 ton. Se le
    # mostró POLIMAX ($76,263.60) y quedó oculto POLICHAIN ($64,837.61),
    # mismo tipo y elevación, también en stock — $11,425.99 más barato.
    #
    #   POLIPASTO ELECTRICO DE CADENA POLIMAX 5 TON       "ELECTRICO"
    #   POLIPASTO ELECT. DE CADENA POLICHAIN FIJO 5 TON   "ELECT."
    #
    # La solución es buscar por el prefijo común, que casa con las dos
    # formas. Alcance medido en el catálogo real: CAP. 64 artículos,
    # MCA 15, ELECT. 12, ELEV 12.
    # Plurales y variantes que NO son abreviaturas del catálogo (esas se
    # detectan solas, ver extraer_raices_abreviadas).
    "metros": "mts", "metro": "mts",
}

# Sin relación de prefijo: hay que buscar cualquiera de las dos formas.
_ALTERNATIVAS_BUSQUEDA = {
    "marca": ("marca", "mca"),
    "mca": ("marca", "mca"),
}

# ── Abreviaturas: se APRENDEN del catálogo, no se mantienen a mano ──────
#
# El primer intento de resolver esto fue una lista escrita a mano
# (electrico -> elect, capacidad -> cap...). Falló por donde fallan
# siempre las listas: incompleta. Quedaban invisibles 52 artículos con
# "GALV." al buscar "galvanizado", 15 con "POLIP." al buscar "polipasto",
# 9 con "INOX." al buscar "inoxidable" — este último, justo el caso ya
# documentado como fallo real. Y el mapeo electrico -> "elect" ni siquiera
# casaba con "ELEC.", por una letra.
#
# Ahora se leen del propio catálogo: si existe "CABLE GALV. 3/8", entonces
# "galv" es una abreviatura real de este negocio y cualquier búsqueda que
# empiece con esas letras debe encontrarla. Se mantiene solo cuando
# NetSuite agrega productos con abreviaturas nuevas.

_LARGO_MINIMO_RAIZ = 3      # "NO." o "A." como prefijo casarían con todo
_LARGO_MINIMO_PALABRA = 4   # no expandir búsquedas de 1-3 letras

_RE_ABREVIATURA = re.compile(r"\b([A-ZÁÉÍÓÚÑ]{3,})\.")

_cache_raices: frozenset | None = None


def extraer_raices_abreviadas(nombres) -> set:
    """Raíces de las abreviaturas presentes en una lista de nombres.

    Una abreviatura es un token en mayúsculas seguido de punto: 'GALV.',
    'ELEC.', 'INOX.'. Se devuelve la raíz en minúsculas y sin el punto.
    """
    raices = set()
    for nombre in nombres or []:
        for token in _RE_ABREVIATURA.findall(_sin_acentos(nombre or "").upper()):
            if len(token) >= _LARGO_MINIMO_RAIZ:
                raices.add(token.lower())
    return raices


def nombres_del_catalogo() -> list[str]:
    """Todos los nombres de artículo. Se usa para aprender abreviaturas."""
    try:
        con = ns_db.conectar()
        try:
            return [f[0] for f in con.execute("SELECT nombre FROM articulos")]
        finally:
            con.close()
    except Exception as exc:
        logger.warning(f"no pude leer los nombres del catálogo: {exc}")
        return []


def raices_abreviadas_del_catalogo() -> frozenset:
    """Abreviaturas del catálogo, calculadas UNA vez y cacheadas.

    Escanear 3,156 nombres en cada búsqueda sería caro y el catálogo solo
    cambia con el sync diario. invalidar_cache_raices() lo refresca.
    """
    global _cache_raices
    if _cache_raices is None:
        _cache_raices = frozenset(extraer_raices_abreviadas(nombres_del_catalogo()))
        logger.info(f"Abreviaturas aprendidas del catálogo: {len(_cache_raices)}")
    return _cache_raices


def invalidar_cache_raices():
    """Se llama tras un sync: el catálogo nuevo puede traer abreviaturas
    que antes no existían."""
    global _cache_raices
    _cache_raices = None


def alternativas_con_raices(palabra: str, raices) -> tuple[str, ...]:
    """Formas con las que la palabra puede aparecer en el catálogo.

    'galvanizado' con la raíz 'galv' conocida devuelve ('galvanizado',
    'galv.') — CON el punto.

    El punto es lo que importa y no es un detalle: buscar '%galv%' casaría
    también con cualquier palabra que empiece igual, y eso rompe la
    precisión. Se vio en la práctica: 'POLI.' existe en el catálogo, así
    que buscar '%poli%' arrastraba POLIPASTO, POLIMAX, POLICHAIN y
    POLICRANE a la vez — una búsqueda de 'polipasto polimax 5 ton' pasó de
    devolver menos de 30 resultados a 137. Con '%poli.%' solo casa la
    abreviatura literal, que es exactamente lo que se busca.
    """
    palabra = (palabra or "").lower()
    if len(palabra) < _LARGO_MINIMO_PALABRA:
        return (palabra,)
    formas = [palabra]
    for raiz in raices or ():
        if raiz != palabra and palabra.startswith(raiz):
            formas.append(f"{raiz}.")
    return tuple(formas)


def _sin_acentos(texto: str) -> str:
    """Los nombres de NetSuite vienen sin acentos y los clientes escriben
    con ellos: 'eléctrico' debe encontrar 'ELECTRICO'."""
    import unicodedata
    return unicodedata.normalize("NFD", texto).encode("ascii", "ignore").decode("ascii")


def _normalizar_palabras_busqueda(palabras: list[str]) -> list[str]:
    resultado = []
    for p in palabras:
        clave = _sin_acentos(p).lower()
        if clave in _SINONIMOS_BUSQUEDA:
            reemplazo = _SINONIMOS_BUSQUEDA[clave]
            if reemplazo is not None:
                resultado.append(reemplazo)
            # si reemplazo es None, se omite la palabra (no se exige que matchee)
        else:
            resultado.append(clave)
    return resultado


# ── Reintento cuando la búsqueda exacta da cero ────────────────────────
#
# La búsqueda exige que TODAS las palabras aparezcan. Basta una que el
# catálogo no use para devolver cero — y cero, para el modelo, significa
# "no tenemos ese producto".
#
# La palabra que más daño hace es "acero". Medido en el catálogo real: de
# 432 artículos que son CABLE, solo 40 (9%) llevan "ACERO" en el nombre.
# Pero "cable de acero" es como se le llama en México al producto
# principal del negocio, así que el cliente lo escribe siempre. Consultas
# perfectamente naturales daban cero:
#
#     cable de acero inoxidable 3/4   -> 0   (el caso documentado como
#     grillete de acero 1/2           -> 0    fallo real con un cliente)
#     cadena de acero 3/8             -> 0
#
# Ante cero, se reintenta quitando las palabras MENOS selectivas: las que
# aparecen en más artículos discriminan menos, así que sacrificarlas
# cuesta poco. Nunca se quita una medida ni un material — eso llevaría a
# ofrecer un producto distinto al pedido, que es peor que no encontrarlo.

# Palabras vacías: no aportan a la búsqueda y se quitan sin costo.
_PALABRAS_VACIAS = {"de", "del", "la", "el", "los", "las", "un", "una",
                    "para", "con", "por", "y", "o", "en", "mi", "me", "al"}

# Nunca se sacrifican: definen QUÉ producto es. Quitar "inoxidable" haría
# que se ofreciera galvanizado — exactamente el error ya documentado.
_RE_MEDIDA = re.compile(r"^\d+([/.]\d+)?$|^\d+/\d+$|mm$|^\d+\"$")


def _es_sacrificable(palabra: str) -> bool:
    """¿Se puede quitar esta palabra sin cambiar QUÉ se está buscando?"""
    p = palabra.lower()
    if p in _PALABRAS_VACIAS:
        return True
    if _RE_MEDIDA.search(p) or any(c.isdigit() for c in p):
        return False  # medidas y capacidades: nunca
    return True


def _selectividad(palabra: str, con) -> int:
    """En cuántos artículos aparece. Más artículos = menos selectiva."""
    try:
        fila = con.execute(
            "SELECT COUNT(*) FROM articulos WHERE nombre LIKE ? COLLATE NOCASE",
            (f"%{palabra}%",),
        ).fetchone()
        return int(fila[0]) if fila else 0
    except Exception:
        return 0


def _alternativas_de(palabra: str) -> tuple[str, ...]:
    """Formas con las que se puede escribir la palabra en el catálogo.

    Combina las equivalencias explícitas (marca/mca, que no comparten
    prefijo) con las abreviaturas aprendidas del propio catálogo.
    """
    clave = (palabra or "").lower()
    if clave in _ALTERNATIVAS_BUSQUEDA:
        return _ALTERNATIVAS_BUSQUEDA[clave]
    return alternativas_con_raices(clave, raices_abreviadas_del_catalogo())


def consultar_catalogo(consulta: str, telefono: str = "", cantidad: float = None, limite: int = 5) -> dict:
    """
    Busca artículos por nombre o código en el catálogo sincronizado desde
    NetSuite (se actualiza diario a las 7am). Si hay varias variantes que
    hacen match, prioriza la que tiene existencia real (importado primero,
    luego nacional) — el resultado NUNCA indica si el artículo es importado
    o nacional, solo si hay disponibilidad y el precio. El precio ya viene
    resuelto a la escala correcta: la del cliente si tiene una negociada, o
    la automática por cantidad si es cable o cadena, o Escala 1 por default.
    """
    # Tope duro: el modelo puede pedir más resultados para comparar marcas,
    # pero no tanto como para inflar la respuesta (y el costo por token).
    try:
        limite = max(1, min(int(limite), 25))
    except (TypeError, ValueError):
        limite = 5

    con = ns_db.conectar()
    actualizado = ns_db.get_meta(con, "articulos_actualizado")

    # Por palabras sueltas, no como substring exacto: "cadena 3/8" debe
    # encontrar "CADENA GRADO 80 3/8"" aunque "GRADO 80" quede en medio. Cada
    # palabra debe aparecer (en nombre O código), en cualquier orden.
    palabras = [p for p in consulta.strip().split() if p]
    palabras = _normalizar_palabras_busqueda(palabras)
    if not palabras:
        con.close()
        return {"ok": True, "actualizado": actualizado, "resultados": [],
                "total_coincidencias": 0, "mostrados": 0, "hay_mas": False}

    # Cada palabra puede escribirse de varias formas en el catálogo
    # (ver _ALTERNATIVAS_BUSQUEDA): basta con que UNA de ellas aparezca.
    bloques, parametros = [], []
    for p in palabras:
        formas = _alternativas_de(p)
        piezas = []
        for forma in formas:
            piezas.append("nombre LIKE ? COLLATE NOCASE")
            piezas.append("codigo LIKE ? COLLATE NOCASE")
            parametros.extend([f"%{forma}%", f"%{forma}%"])
        bloques.append("(" + " OR ".join(piezas) + ")")
    condicion = " AND ".join(bloques)

    def _buscar(lista_palabras):
        bloques_, parametros_ = [], []
        for w in lista_palabras:
            piezas_ = []
            for forma in _alternativas_de(w):
                piezas_.append("nombre LIKE ? COLLATE NOCASE")
                piezas_.append("codigo LIKE ? COLLATE NOCASE")
                parametros_.extend([f"%{forma}%", f"%{forma}%"])
            bloques_.append("(" + " OR ".join(piezas_) + ")")
        sql = f"SELECT * FROM articulos WHERE {' AND '.join(bloques_)}"
        return con.execute(sql, parametros_).fetchall()

    filas = con.execute(f"SELECT * FROM articulos WHERE {condicion}", parametros).fetchall()

    # Si la búsqueda exacta da cero, relajar quitando las palabras menos
    # selectivas (ver el bloque de comentarios sobre "acero" más arriba).
    # La exacta SIEMPRE tiene prioridad: solo se relaja ante cero.
    palabras_ignoradas = []
    if not filas and len(palabras) > 1:
        vigentes = list(palabras)

        # El TIPO DE PRODUCTO es intocable. Se asume que es la primera
        # palabra con contenido: el cliente empieza diciendo qué quiere
        # ("cadena de acero 3/8", "grillete de acero 1/2").
        #
        # Sin esta regla la heurística se volvía en contra: "cadena"
        # aparece en muchos artículos, así que salía como poco selectiva y
        # era la PRIMERA en caer — la búsqueda "cadena de acero 3/8"
        # terminaba ofreciendo "CASQUILLO DE ACERO 3/8". Darle al cliente
        # un producto distinto al que pidió es peor que no encontrarlo.
        tipo_producto = next((w for w in vigentes if w.lower() not in _PALABRAS_VACIAS), None)

        # Candidatas ordenadas de menos a más selectiva: quitar primero la
        # que aparece en más artículos cuesta menos precisión.
        candidatas = sorted(
            (w for w in vigentes if _es_sacrificable(w) and w != tipo_producto),
            key=lambda w: -_selectividad(w, con),
        )
        for candidata in candidatas:
            if len(vigentes) <= 1:
                break
            vigentes.remove(candidata)
            palabras_ignoradas.append(candidata)
            filas = _buscar(vigentes)
            if filas:
                break
        if not filas:
            palabras_ignoradas = []

    con.close()

    # El TOTAL REAL, antes de truncar. Reportar el número truncado (que es
    # lo que hacía antes) le decía al modelo que había visto todo el
    # catálogo cuando había visto 5 de 49 — y con esa información, afirmar
    # "no tenemos otra marca" es una deducción correcta a partir de un dato
    # falso. Tres ventas reales se perdieron así.
    total_real = len(filas)

    if not filas:
        return {"ok": True, "actualizado": actualizado, "resultados": [],
                "total_coincidencias": 0, "mostrados": 0, "hay_mas": False}

    numeros_exactos = frozenset(_numeros_enteros_busqueda(consulta))
    termino_principal = palabras[0] if palabras else ""
    filas = sorted(filas, key=lambda f: _prioridad_busqueda(f, numeros_exactos, termino_principal))[:limite]

    resultados = []
    for f in filas:
        escala = _escala_efectiva(telefono, f["linea"] or "", cantidad)
        resultados.append({
            "codigo": f["codigo"],
            "nombre": f["nombre"],  # ya sin "IMPORTADO"/"NACIONAL"
            "disponible": (f["existencia"] or 0) > 0,
            "existencia": f["existencia"],
            "precio": _precio_en_escala(f, escala),
            "escala_aplicada": escala,
        })

    return {
        "ok": True,
        "actualizado": actualizado,
        "resultados": resultados,
        # El total REAL de coincidencias, no las que caben en la respuesta.
        "total_coincidencias": total_real,
        "mostrados": len(resultados),
        # Bandera explícita para que el modelo no tenga que deducirlo: si
        # es True, NO ha visto todo y no debe afirmar que esto es todo lo
        # que hay — debe afinar la búsqueda o preguntarle al cliente.
        "hay_mas": total_real > len(resultados),
        # Si viene con algo, la búsqueda exacta no encontró nada y hubo que
        # relajarla. El modelo DEBE decírselo al cliente en vez de
        # presentar un resultado aproximado como si fuera exacto.
        "palabras_ignoradas": palabras_ignoradas,
    }


# ── Citas / reservaciones ──────────────────────────────────────────────

async def agendar_cita(telefono: str, servicio: str, fecha: str, hora: str,
                        nombre_cliente: str = "", direccion: str = "") -> dict:
    """Agenda una cita o visita de servicio técnico. fecha en formato YYYY-MM-DD, hora en HH:MM.
    Si la visita es en las instalaciones del cliente (ej. servicio técnico a domicilio),
    pide y guarda también la dirección — sin eso el técnico no sabe a dónde presentarse."""
    cita_id = await memory.crear_cita(telefono, servicio, fecha, hora, nombre_cliente, direccion)
    return {"ok": True, "cita_id": cita_id, "servicio": servicio, "fecha": fecha, "hora": hora, "direccion": direccion}


async def ver_mis_citas(telefono: str) -> dict:
    """Lista las citas agendadas por este número de teléfono."""
    return {"ok": True, "citas": await memory.listar_citas(telefono)}


async def cancelar_cita(telefono: str, cita_id: int) -> dict:
    """Cancela una cita existente por su id."""
    ok = await memory.cancelar_cita(telefono, cita_id)
    return {"ok": ok}


# ── Leads / ventas ──────────────────────────────────────────────────────

async def registrar_interes_venta(telefono: str, interes: str, nombre: str = "", empresa: str = "") -> dict:
    """
    Registra un interés de compra o proyecto Y avisa de inmediato por WhatsApp
    a un vendedor sorteado al azar — para que de verdad "se pase con un
    ejecutivo de ventas" (antes solo quedaba guardado sin que nadie se
    enterara). Úsala cada vez que le prometas al cliente que alguien lo va
    a contactar por un tema de venta (no aplica a soporte post-venta, para
    eso usa crear_ticket_soporte).
    """
    lead_id = await memory.registrar_lead(telefono, interes, nombre, empresa)

    vendedor = _sortear_vendedor()
    notificado = False
    if vendedor:
        archivo = await _guardar_transcripcion(telefono)
        media_url = _media_url_transcripcion(archivo)
        datos_cliente = nombre or "(no especificado)"
        if empresa:
            datos_cliente += f" — {empresa}"
        resumen = (
            f"Qué tal {vendedor['nombre']},\n\n"
            f"Claudia IA fue contactada por alguien interesado en platicar con ventas. Te dejo los datos:\n\n"
            f"Cliente: {datos_cliente}\n"
            f"Teléfono: {telefono}\n\n"
            f"Interés: {interes}\n\n"
            f"Gracias {_primer_nombre(vendedor['nombre'])} por atender mi mensaje, {_saludo_hora()}."
        )
        notificado = await _notificar_vendedor(
            vendedor, resumen, media_url=media_url,
            datos_plantilla=_variables_plantilla(vendedor, datos_cliente, telefono),
        )

    await memory.registrar_notificacion_vendedor(
        telefono, "lead_nuevo", "", 0.0,
        vendedor.get("nombre", "") if vendedor else "", vendedor.get("whatsapp", "") if vendedor else "",
        notificado,
    )
    return {"ok": True, "lead_id": lead_id, "notificado": notificado,
            "vendedor_asignado": vendedor.get("nombre") if vendedor else None}


# ── ¿Ya es cliente? — roster sincronizado de NetSuite ───────────────────

def _vendedor_por_netsuite_id(netsuite_id: str) -> dict | None:
    for v in _cargar_vendedores():
        if str(v.get("netsuite_id") or "") == str(netsuite_id or ""):
            return v
    return None


def verificar_cliente_existente(nombre: str = "", rfc: str = "") -> dict:
    """
    Busca si quien escribe YA es cliente registrado de Ambar Cargo, contra
    el roster sincronizado de NetSuite (se actualiza diario a las 7am — no
    se consulta NetSuite en vivo). Primero por nombre exacto (normalizado:
    mayúsculas, sin acentos, espacios colapsados — NO es búsqueda parcial);
    si no hay exactamente un match, intenta por RFC. Si tampoco hay un match
    ÚNICO y seguro, NO adivina: regresa encontrado=False para que le pidas
    al cliente que confirme o corrija el nombre/RFC exacto.
    """
    con = ns_db.conectar()
    fila = None
    if nombre:
        candidatos = con.execute(
            "SELECT * FROM clientes WHERE nombre_normalizado = ?", (ns_db.normalizar(nombre),)
        ).fetchall()
        if len(candidatos) == 1:
            fila = candidatos[0]
    if fila is None and rfc:
        candidatos = con.execute(
            "SELECT * FROM clientes WHERE rfc_normalizado = ? AND rfc_normalizado != ''",
            (ns_db.normalizar(rfc),),
        ).fetchall()
        if len(candidatos) == 1:
            fila = candidatos[0]
    con.close()

    if fila is None:
        return {"ok": True, "encontrado": False}

    vendedor = _vendedor_por_netsuite_id(fila["salesrep_id"])
    return {
        "ok": True,
        "encontrado": True,
        "cliente": {"nombre": fila["nombre"], "netsuite_id": fila["netsuite_id"]},
        "salesrep_id": fila["salesrep_id"],
        "vendedor_nombre": vendedor["nombre"] if vendedor else (fila["salesrep_nombre"] or "sin asignar"),
        "vendedor_tiene_whatsapp": bool(vendedor and (vendedor.get("whatsapp") or "").strip()),
    }


# ── Datos del cliente (para cotización / oportunidad) ───────────────────

async def registrar_datos_cliente(telefono: str, nombre_completo: str = "", empresa: str = "",
                                   correo: str = "", rfc: str = "") -> dict:
    """Guarda los datos de contacto y fiscales del cliente (nombre completo, empresa,
    correo, RFC). Necesario antes de poder generar una oportunidad formal."""
    datos = await memory.guardar_cliente(telefono, nombre_completo, empresa, correo, rfc)
    return {"ok": True, "cliente": datos}


def _datos_cliente_completos(cliente: dict | None) -> bool:
    if not cliente:
        return False
    return all(cliente.get(k) for k in ("nombre_completo", "empresa", "correo", "rfc"))


# ── Pedidos ─────────────────────────────────────────────────────────────

async def agregar_al_pedido(telefono: str, codigo: str, cantidad: float) -> dict:
    """Agrega un artículo (por código de catálogo) al pedido en curso del cliente,
    al precio de la escala que le corresponde (por cliente o por cantidad)."""
    con = ns_db.conectar()
    candidatos = con.execute(
        "SELECT * FROM articulos WHERE codigo = ? COLLATE NOCASE", (codigo.strip(),)
    ).fetchall()
    con.close()
    if not candidatos:
        return {"ok": False, "error": f"No encontré el artículo con código '{codigo}' en el catálogo."}
    # Si el código coincide con más de un artículo (pasa con algunos códigos
    # compartidos entre un artículo y un grupo/kit), se usa el mismo criterio
    # de prioridad que la búsqueda.
    art = sorted(candidatos, key=_prioridad_disponibilidad)[0]

    escala = _escala_efectiva(telefono, art["linea"] or "", cantidad)
    precio = _precio_en_escala(art, escala) or 0
    await memory.agregar_al_carrito(
        telefono, art["codigo"], art["nombre"], cantidad, float(precio),
    )
    return {"ok": True, "articulo": art["nombre"], "cantidad": cantidad,
            "precio_unitario": precio, "escala_aplicada": escala}


async def ver_pedido_actual(telefono: str) -> dict:
    """Muestra los artículos en el pedido en curso del cliente, con subtotales."""
    items = await memory.ver_carrito(telefono)
    total = round(sum(i["subtotal"] for i in items), 2)
    return {"ok": True, "articulos": items, "total": total}


async def confirmar_pedido(telefono: str) -> dict:
    """Confirma el pedido en curso del cliente (cierra el carrito). Úsala solo
    para pedidos sencillos que NO requieren generar oportunidad formal en NetSuite;
    si el cliente pide cotización, usa generar_oportunidad en su lugar."""
    return await memory.confirmar_pedido(telefono)


# ── Vendedores: sorteo (lead nuevo) y canalización directa (cliente ya conocido) ──

# Caché en memoria de los vendedores. Existe porque los vendedores viven en
# la base de datos (lectura async) pero quienes los consultan —
# _vendedor_por_netsuite_id, _sortear_vendedor— son funciones SÍNCRONAS
# llamadas desde herramientas también síncronas (verificar_cliente_existente).
# Convertir toda esa cadena a async por una lista de 6 filas que casi nunca
# cambia sería peor negocio. La caché se llena al arrancar el servidor y se
# refresca cada vez que el panel /admin escribe.
_CACHE_VENDEDORES: list[dict] = []


def normalizar_vendedor(fila: dict) -> dict:
    """Deja una fila de vendedor con las 4 claves esperadas y sin espacios.

    netsuite_id se guarda SIEMPRE como texto: NetSuite lo devuelve unas veces
    como número y otras como cadena, y comparar '133' con 133 falla en
    silencio — el vendedor no se encuentra y el aviso nunca sale."""
    fila = fila or {}
    return {
        "nombre": str(fila.get("nombre") or "").strip(),
        "netsuite_id": str(fila.get("netsuite_id") or "").strip(),
        "email": str(fila.get("email") or "").strip(),
        "whatsapp": str(fila.get("whatsapp") or "").strip(),
    }


def poblar_cache_vendedores(filas: list[dict]):
    """Reemplaza el contenido de la caché (no acumula)."""
    _CACHE_VENDEDORES.clear()
    _CACHE_VENDEDORES.extend(normalizar_vendedor(f) for f in (filas or []))


async def refrescar_cache_vendedores():
    """Recarga la caché desde la base. Se llama al arrancar y tras cada
    escritura del panel."""
    try:
        from agent.memory import listar_vendedores
        poblar_cache_vendedores(await listar_vendedores())
        logger.info(f"Vendedores en caché: {len(_CACHE_VENDEDORES)}")
    except Exception as exc:
        logger.error(f"No se pudo refrescar la caché de vendedores: {exc}")


def leer_vendedores_yaml(ruta: str = VENDEDORES_PATH) -> list[dict]:
    """Lee el YAML — solo como semilla inicial de la base (ver
    memory.migrar_vendedores). Un archivo roto devuelve lista vacía en vez
    de propagar la excepción: no debe impedir que el servidor arranque."""
    if not os.path.exists(ruta):
        return []
    try:
        with open(ruta, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return [normalizar_vendedor(v) for v in (data.get("vendedores") or [])]
    except (yaml.YAMLError, IOError, AttributeError, TypeError) as exc:
        logger.error(f"No se pudo leer {ruta}: {exc}")
        return []


def leer_vendedores_semilla(ruta_yaml: str = VENDEDORES_PATH) -> list[dict]:
    """Semilla inicial de la tabla `vendedores`: archivo si existe, si no
    la variable de entorno VENDEDORES_SEED_JSON.

    POR QUE HACE FALTA LA VARIABLE
    ------------------------------
    config/vendedores_whatsapp.yaml tiene nombres, correos y WhatsApp de
    empleados reales, y esta en .gitignore porque el repo es publico.
    `railway up` respeta .gitignore, asi que ese archivo NUNCA llega al
    contenedor — se comprobo en el primer despliegue real: los logs decian
    "Vendedores en cache: 0" y Claudia no podia canalizar ningun lead.

    La variable de entorno es como ya viajan los demas secretos (el token
    de Twilio, la llave de Anthropic), asi que no introduce un mecanismo
    nuevo — al contrario, quita la inconsistencia.

    Formatos aceptados en la variable:
        [{"nombre": ..., "netsuite_id": ..., "email": ..., "whatsapp": ...}]
        {"vendedores": [ ... ]}      (la misma forma del YAML)
    """
    del_archivo = leer_vendedores_yaml(ruta_yaml)
    if del_archivo:
        return del_archivo

    crudo = (os.getenv("VENDEDORES_SEED_JSON") or "").strip()
    if not crudo:
        return []

    try:
        datos = json.loads(crudo)
    except (json.JSONDecodeError, TypeError) as exc:
        # Un JSON mal pegado en Railway no debe impedir el arranque: peor
        # que quedarse sin vendedores es quedarse sin agente.
        logger.error(f"VENDEDORES_SEED_JSON no es JSON valido, se ignora: {exc}")
        return []

    if isinstance(datos, dict):
        datos = datos.get("vendedores")
    if not isinstance(datos, list):
        logger.error("VENDEDORES_SEED_JSON debe ser una lista (o {'vendedores': [...]}), se ignora")
        return []

    return [normalizar_vendedor(v) for v in datos if isinstance(v, dict)]


def _cargar_vendedores() -> list[dict]:
    """Los vendedores vigentes, desde la caché en memoria."""
    return list(_CACHE_VENDEDORES)


def _sortear_vendedor() -> dict | None:
    """Sortea un vendedor al azar entre los que sí tienen WhatsApp capturado
    en config/vendedores_whatsapp.yaml (la cuenta genérica 'Ambar Cargo' no
    aparece en ese archivo, así que ya queda excluida). Solo para LEADS
    NUEVOS — si el cliente ya es conocido, se canaliza a SU vendedor real,
    no a uno al azar (ver notificar_vendedor_cliente_existente)."""
    candidatos = [v for v in _cargar_vendedores() if (v.get("whatsapp") or "").strip()]
    if not candidatos:
        return None
    return random.choice(candidatos)


async def _notificar_vendedor(vendedor: dict, resumen: str, media_url: str = None,
                               datos_plantilla: dict | None = None) -> bool:
    """Le manda a un vendedor un WhatsApp (con la transcripción adjunta, si
    hay media_url).

    Usa el proveedor de AVISOS, que no siempre es el de los clientes: si los
    clientes se atienden por el CRM, mandar los avisos por ahí metería a
    cada vendedor como contacto del CRM y cada aviso como una conversación
    en la bandeja del equipo. Ver obtener_proveedor_avisos().

    confirmar_entrega=True: aquí SÍ importa saber si de verdad llegó (a
    diferencia de las respuestas al cliente) — un HTTP 201 de Twilio no
    garantiza entrega, solo que aceptó el envío.

    Si el mensaje libre no se entrega y viene datos_plantilla, se reintenta
    con la plantilla aprobada: el mensaje libre solo pasa si el vendedor le
    escribió al bot en las últimas 24 horas, la plantilla pasa siempre. Es
    el único camino para alcanzar a un vendedor que lleva días sin escribir.
    """
    # Interruptor general de los avisos por WhatsApp a vendedores. Se apaga
    # cuando el canal de salida no es confiable — el sandbox de Twilio
    # rechaza a quien no hizo "join" (error 63015), y prometerle al cliente
    # un contacto que nadie recibió es peor que no prometerlo.
    #
    # Devolver False aquí no es una mentira piadosa: es literalmente lo que
    # significa "no se entregó", y el prompt ya sabe qué hacer con ese dato
    # (le dice al cliente que su solicitud quedó registrada, sin prometer
    # que lo van a llamar). La oportunidad en NetSuite y el registro local
    # se hacen igual, así que el seguimiento no se pierde: lo único que
    # cambia es que nadie recibe el WhatsApp.
    if os.getenv("AVISO_VENDEDOR_ENABLED", "true").lower() in ("false", "0", "no"):
        logger.info(
            "Aviso a %s NO enviado: los avisos por WhatsApp están apagados "
            "(AVISO_VENDEDOR_ENABLED). El registro sí queda hecho.",
            vendedor.get("nombre", "?"),
        )
        return False

    try:
        from agent.providers import obtener_proveedor_avisos
        proveedor = obtener_proveedor_avisos()
        entregado = await proveedor.enviar_mensaje(
            vendedor["whatsapp"], resumen, media_url=media_url, confirmar_entrega=True,
        )
        if not entregado and datos_plantilla:
            entregado = await proveedor.enviar_plantilla(vendedor["whatsapp"], datos_plantilla)
            if entregado:
                logger.warning(
                    "Aviso a %s entregado por PLANTILLA (el mensaje libre no pasó — "
                    "ventana de 24h cerrada). Va sin la transcripción adjunta.",
                    vendedor.get("nombre"),
                )
    except Exception:
        logger.exception("No se pudo notificar al vendedor")
        return False

    if not entregado:
        # A nivel de log esto es un ERROR, no un detalle: hay un cliente real
        # esperando a un vendedor que no se enteró. La causa más común es la
        # ventana de 24h de WhatsApp cerrada (Twilio 63016).
        logger.error(
            "AVISO NO ENTREGADO a %s (%s) — hay un cliente esperando a un vendedor "
            "que no fue notificado, y la plantilla de respaldo tampoco pasó.",
            vendedor.get("nombre"), vendedor.get("whatsapp"),
        )
    return entregado


def _primer_nombre(nombre_completo: str) -> str:
    return (nombre_completo or "").split()[0] if (nombre_completo or "").split() else nombre_completo or ""


def _saludo_hora() -> str:
    """'buenos días' antes de las 12:00, 'buenas tardes' después. Usa la hora
    real del servidor (misma fuente que _contexto_fecha en agent/brain.py)."""
    return "buenos días" if datetime.now().hour < 12 else "buenas tardes"


def _variables_plantilla(vendedor: dict, cliente: str, telefono: str) -> dict[str, str]:
    """Variables de la plantilla de aviso a vendedor, por posición.

    El orden tiene que coincidir con el texto dado de alta en Twilio
    ({{1}} vendedor, {{2}} cliente, {{3}} teléfono) — ver PLANTILLA_WHATSAPP.md.
    Una plantilla aprobada no lleva adjuntos ni texto libre, así que solo
    caben los datos mínimos para que el vendedor sepa a quién llamar; el
    detalle completo queda en el panel.
    """
    return {
        "1": _primer_nombre(vendedor.get("nombre", "")) or "compañero",
        "2": cliente or "un cliente",
        "3": telefono or "(sin teléfono)",
    }


def _cierre_para_cliente(vendedor: dict | None, notificado: bool) -> str:
    """
    Cómo se cierra la conversación con el cliente cuando se le canaliza a un
    vendedor.

    El texto CAMBIA según si el aviso de verdad salió. Prometer "en breve
    será atendido por su asesor" cuando el WhatsApp no se entregó (ventana de
    24h de Twilio cerrada, vendedor sin número dado de alta) deja al cliente
    esperando a alguien que nunca se enteró — y nadie lo sabe hasta que el
    cliente reclama o se pierde. Si el aviso no salió, se le dice la verdad:
    quedó registrado, el equipo le da seguimiento; y queda la fila con
    notificado=0 en el panel para que alguien lo levante a mano.
    """
    if vendedor and notificado:
        return (f"Muchas gracias, en breve será atendido por su asesor de ventas "
                f"{vendedor['nombre']}. Muchas gracias por confiar en nosotros, {_saludo_hora()}.")
    if vendedor:
        return (f"Muchas gracias, su solicitud ya quedó registrada para su asesor de ventas "
                f"{vendedor['nombre']} y el equipo de Ambar Cargo le dará seguimiento. "
                f"Muchas gracias por confiar en nosotros, {_saludo_hora()}.")
    return (f"Muchas gracias, su solicitud ya quedó registrada y el equipo de Ambar Cargo "
            f"le dará seguimiento. Muchas gracias por confiar en nosotros, {_saludo_hora()}.")


def _lineas_articulos(items: list[dict]) -> str:
    """items: lista con la forma de memory.ver_carrito() —
    {codigo, nombre_articulo, cantidad, precio_unitario, subtotal}."""
    return "\n".join(
        f"- {it['nombre_articulo']} x{it['cantidad']} — ${it['precio_unitario']:,.2f} c/u"
        for it in items
    )


def _url_estimate(estimate_id: str) -> str:
    account = os.getenv("NETSUITE_ACCOUNT_ID", "")
    host = account.lower().replace("_", "-")
    return f"https://{host}.app.netsuite.com/app/accounting/transactions/estimate.nl?id={estimate_id}"


def _url_opportunity(opportunity_id: str) -> str:
    account = os.getenv("NETSUITE_ACCOUNT_ID", "")
    host = account.lower().replace("_", "-")
    return f"https://{host}.app.netsuite.com/app/common/entity/opprtnty.nl?id={opportunity_id}"


async def _guardar_transcripcion(telefono: str) -> str | None:
    """
    Escribe la conversación completa con este cliente a un archivo de texto,
    para que el vendedor tenga todo el contexto sin tener que pedírselo de
    nuevo al cliente. El nombre del archivo es un token opaco (no el
    teléfono), porque se sirve por una URL pública (ver agent/main.py).

    Retorna el nombre del archivo, o None si no se pudo escribir.
    """
    try:
        os.makedirs(TRANSCRIPTS_DIR, exist_ok=True)
        historial = await memory.obtener_conversacion_completa(telefono, limite=200)
        lineas = [
            "Transcripción de conversación — Ambar Cargo / Claudia",
            f"Cliente (WhatsApp): {telefono}",
            f"Generado: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "=" * 60,
            "",
        ]
        for m in historial:
            quien = "Cliente" if m["role"] == "user" else "Claudia"
            lineas.append(f"[{quien}] {m['content']}")
        nombre_archivo = f"{secrets.token_urlsafe(16)}.txt"
        ruta = os.path.join(TRANSCRIPTS_DIR, nombre_archivo)
        with open(ruta, "w", encoding="utf-8") as f:
            f.write("\n\n".join(lineas))
        return nombre_archivo
    except Exception:
        logger.exception("No se pudo guardar la transcripción de la conversación")
        return None


def _media_url_transcripcion(archivo: str | None) -> str | None:
    base_publica = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
    if not (base_publica and archivo):
        if archivo:
            logger.warning(
                "PUBLIC_BASE_URL no configurado: no se puede adjuntar la "
                "transcripción por WhatsApp (Twilio necesita una URL pública)."
            )
        return None
    return f"{base_publica}/transcripts/{archivo}"


async def notificar_vendedor_cliente_existente(telefono: str, salesrep_id: str,
                                                cliente_netsuite_id: str = "",
                                                cliente_nombre: str = "") -> dict:
    """
    Cliente YA conocido (verificar_cliente_existente lo encontró): NO se
    genera ningún registro nuevo en NetSuite — se canaliza el aviso
    directamente al vendedor dueño de esa cuenta, con los datos del cliente
    tal como está dado de alta en NetSuite, su teléfono y los artículos que
    quiere cotizar (del pedido en curso), para que él le dé seguimiento con
    su propio proceso.

    Pasa cliente_netsuite_id y cliente_nombre con lo que devolvió
    verificar_cliente_existente (campo 'cliente').
    """
    vendedor = _vendedor_por_netsuite_id(salesrep_id)

    if not vendedor or not (vendedor.get("whatsapp") or "").strip():
        logger.warning(f"Vendedor salesrep_id={salesrep_id} sin WhatsApp registrado; no se pudo avisar automático.")
        await memory.registrar_notificacion_vendedor(
            telefono, "cliente_existente", "", 0.0,
            vendedor["nombre"] if vendedor else "", "", False,
        )
        return {"ok": True, "notificado": False, "vendedor_nombre": vendedor["nombre"] if vendedor else None,
                "mensaje_cliente": _cierre_para_cliente(vendedor, notificado=False)}

    items = await memory.ver_carrito(telefono)
    articulos_txt = _lineas_articulos(items) or "(sin artículos especificados en el pedido)"
    resumen = (
        f"Qué tal {vendedor['nombre']},\n\n"
        f"Claudia IA fue contactada por un cliente tuyo para una cotización. Te dejo los datos:\n\n"
        f"Cliente: {cliente_nombre or '(no especificado)'} "
        f"(ID NetSuite: {cliente_netsuite_id or 'N/D'})\n"
        f"Teléfono: {telefono}\n\n"
        f"Artículos a cotizar:\n{articulos_txt}\n\n"
        f"Gracias {_primer_nombre(vendedor['nombre'])} por atender mi mensaje, {_saludo_hora()}."
    )
    archivo = await _guardar_transcripcion(telefono)
    media_url = _media_url_transcripcion(archivo)
    notificado = await _notificar_vendedor(
        vendedor, resumen, media_url=media_url,
        datos_plantilla=_variables_plantilla(vendedor, cliente_nombre, telefono),
    )
    await memory.registrar_notificacion_vendedor(
        telefono, "cliente_existente", "", 0.0, vendedor["nombre"], vendedor.get("whatsapp", ""), notificado,
    )
    return {"ok": True, "notificado": notificado, "vendedor_nombre": vendedor["nombre"],
            "mensaje_cliente": _cierre_para_cliente(vendedor, notificado)}


async def generar_oportunidad(telefono: str) -> dict:
    """
    LEAD NUEVO (no encontrado en verificar_cliente_existente): genera una
    Opportunity FORMAL en NetSuite con los artículos del pedido en curso.
    Requiere que ya se hayan capturado los datos del cliente con
    registrar_datos_cliente (nombre completo, empresa, correo, RFC) — si
    faltan, pídelos antes de llamar esta herramienta. Al generarse, se
    sortea un vendedor de la empresa para darle seguimiento y se le avisa
    por WhatsApp (con la transcripción de la conversación, no todos los
    datos crudos).
    """
    cliente = await memory.obtener_cliente(telefono)
    if not _datos_cliente_completos(cliente):
        faltan = [k for k in ("nombre_completo", "empresa", "correo", "rfc")
                  if not (cliente or {}).get(k)]
        return {"ok": False, "error": "faltan_datos_cliente", "faltan": faltan}

    items_carrito = await memory.ver_carrito(telefono)
    if not items_carrito:
        return {"ok": False, "error": "El pedido está vacío, no hay nada que cotizar."}

    con = ns_db.conectar()
    lineas, sin_item_id = [], []
    for it in items_carrito:
        fila = con.execute("SELECT item_id FROM articulos WHERE codigo = ?", (it["codigo"],)).fetchone()
        item_id = fila["item_id"] if fila else None
        if not item_id:
            sin_item_id.append(it["codigo"])
            continue
        lineas.append({"item_id": item_id, "cantidad": it["cantidad"], "precio": it["precio_unitario"]})
    con.close()

    if not lineas:
        return {"ok": False, "error": "No se pudo resolver ningún artículo del pedido contra NetSuite."}

    vendedor = _sortear_vendedor()
    titulo = f"Lead WhatsApp — {cliente['nombre_completo']} ({cliente['empresa']})"
    memo = (
        f"Oportunidad generada por Claudia IA (agente WhatsApp).\n"
        f"Cliente: {cliente['nombre_completo']} | Empresa: {cliente['empresa']}\n"
        f"Teléfono: {telefono} | Correo: {cliente['correo']} | RFC: {cliente['rfc']}\n"
        f"Atendido por: {vendedor['nombre'] if vendedor else 'Sin asignar'} (representante)"
    )

    resultado = ns.crear_oportunidad(lineas, memo, titulo)
    if not resultado.get("ok"):
        return resultado

    total = round(sum(l["cantidad"] * l["precio"] for l in lineas), 2)
    notificado = False
    if vendedor:
        archivo = await _guardar_transcripcion(telefono)
        media_url = _media_url_transcripcion(archivo)
        articulos_txt = _lineas_articulos(items_carrito)
        resumen = (
            f"Qué tal {vendedor['nombre']},\n\n"
            f"Claudia IA ha sido contactada por un nuevo prospecto cliente. Ya fue atendido, "
            f"pero para darle una atención más personalizada se te asignó su seguimiento.\n\n"
            f"Cliente: {cliente['nombre_completo']} — {cliente['empresa']}\n"
            f"Teléfono: {telefono} | Correo: {cliente['correo']} | RFC: {cliente['rfc']}\n\n"
            f"Cotización:\n{articulos_txt}\nTotal: ${total:,.2f}\n\n"
            f"Se realizó la siguiente oportunidad en NetSuite: "
            f"#{resultado.get('folio') or resultado['opportunity_id']}\n"
            f"Liga: {_url_opportunity(resultado['opportunity_id'])}\n\n"
            f"Que tengas una buena {'mañana' if _saludo_hora() == 'buenos días' else 'tarde'}."
            + ("\n\nTe adjunto la conversación completa para que tengas el contexto." if media_url else "")
        )
        notificado = await _notificar_vendedor(
            vendedor, resumen, media_url=media_url,
            datos_plantilla=_variables_plantilla(
                vendedor, f"{cliente['nombre_completo']} — {cliente['empresa']}", telefono),
        )

    await memory.registrar_notificacion_vendedor(
        telefono, "lead_nuevo", resultado["opportunity_id"], total,
        vendedor.get("nombre", "") if vendedor else "", vendedor.get("whatsapp", "") if vendedor else "",
        notificado,
    )
    await memory.confirmar_pedido(telefono)

    # Reflejar la cotización en el CRM, si Claudia está operando por ahí.
    # Va DESPUÉS de todo lo que importa —NetSuite, el registro local— y su
    # resultado no se propaga: si el CRM no responde, el cliente ya tiene
    # su folio y el vendedor su oportunidad. Lo que se pierde es que
    # aparezca en el panel, y eso no justifica tumbar la respuesta.
    try:
        from agent import wacrm_crm
        if wacrm_crm.activo():
            titulo = (
                items_carrito[0]["nombre_articulo"]
                if items_carrito
                else f"Cotización {resultado.get('folio') or ''}".strip()
            )
            if len(items_carrito) > 1:
                titulo += f" (+{len(items_carrito) - 1})"
            await wacrm_crm.registrar_cotizacion(telefono, titulo, total)
            # "Cotizado" distingue en la bandeja a quien ya tiene número de
            # quien solo preguntó — es lo que un vendedor quiere filtrar.
            await wacrm_crm.etiquetar(telefono, ["Cotizado"])
    except Exception as e:
        logger.warning(f"No se pudo reflejar la cotización en el CRM: {e}")

    return {
        "ok": True,
        # El folio es el número de documento que el cliente puede citar y
        # que el vendedor busca en NetSuite. El id interno se conserva
        # porque es lo que arma la liga al registro, pero no se le dice a
        # nadie: a un cliente el 260067 no le sirve para nada.
        "folio": resultado.get("folio"),
        "opportunity_id": resultado["opportunity_id"],
        "total": total,
        "articulos_sin_resolver": sin_item_id,
        "vendedor_asignado": vendedor.get("nombre") if vendedor else None,
        # La oportunidad puede quedar bien en NetSuite y aun así NO haberle
        # llegado el WhatsApp al vendedor. Sin este dato, Claudia le prometía
        # al cliente un contacto que nadie sabía que debía hacer.
        "notificado": notificado,
    }


# ── Soporte post-venta ──────────────────────────────────────────────────

async def crear_ticket_soporte(telefono: str, problema: str) -> dict:
    """Crea un ticket de soporte post-venta para dar seguimiento a un problema reportado."""
    ticket_id = await memory.crear_ticket(telefono, problema)
    return {"ok": True, "ticket_id": ticket_id}


async def consultar_tickets_soporte(telefono: str) -> dict:
    """Lista los tickets de soporte abiertos por este cliente."""
    return {"ok": True, "tickets": await memory.consultar_tickets(telefono)}
