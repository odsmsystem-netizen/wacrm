# tests/test_config_remota.py — Configuración de Claudia que baja del CRM

"""
Cubre lo que puede tumbar a Claudia si se hace mal:

- Si el CRM falla, Claudia debe seguir con la última configuración buena
  (no quedarse sin prompt ni tumbar la conversación en curso).
- `sin_cambios: true` no debe tocar el texto del prompt — es lo que
  protege el caché de Anthropic (ver el docstring de _actualizar).
- Sin CRM configurado, el prompt debe quedar idéntico al de antes de que
  existiera este módulo.
- El reporte de consumo no puede romper la generación de la respuesta,
  ni siquiera cuando los contadores de caché vienen ausentes o en None.
"""

import pytest

from agent import config_remota, brain


def _reset_estado():
    """Cada prueba debe partir de un estado limpio: `_ESTADO` es un dict a
    nivel de módulo y las pruebas correrían en el mismo proceso."""
    config_remota._ESTADO["revision"] = 0
    config_remota._ESTADO["prompt_extra"] = ""
    config_remota._permiso_denegado = False


class ClienteFalso:
    """Mismo patrón que tests/test_health_tunel.py: un doble mínimo de
    httpx.AsyncClient que responde lo que la prueba necesite."""

    def __init__(self, respuesta=None, excepcion=None):
        self._respuesta = respuesta
        self._excepcion = excepcion
        self.llamadas = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kwargs):
        self.llamadas.append((url, kwargs))
        if self._excepcion:
            raise self._excepcion
        return self._respuesta

    async def post(self, url, **kwargs):
        self.llamadas.append((url, kwargs))
        if self._excepcion:
            raise self._excepcion
        return self._respuesta


class RespuestaFalsa:
    """Imita una respuesta del CRM.

    `datos` son los campos planos; el sobre {"data": ...} se pone aquí
    porque es lo que de verdad manda el CRM (ver src/lib/api/v1/respond.ts).
    Si el doble devolviera los campos en la raíz, las pruebas pasarían
    contra una forma que en producción nunca llega.
    """

    def __init__(self, status_code, datos=None, texto="", envolver=True):
        self.status_code = status_code
        cuerpo = datos or {}
        self._datos = {"data": cuerpo} if envolver else cuerpo
        self.text = texto

    def json(self):
        return self._datos


# ══════════════════════════════════════════════════════════════════
# 1. La configuración se conserva cuando el CRM falla
# ══════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_conserva_la_config_si_el_crm_no_responde(monkeypatch):
    """Un timeout o una caída de red no debe borrar lo que ya se tenía —
    Claudia no puede quedarse sin cerebro porque el CRM se reinicia."""
    _reset_estado()
    config_remota._aplicar({"revision": 5, "prompt_extra": "## Config previa\nTexto bueno."})

    cliente = ClienteFalso(excepcion=TimeoutError("el CRM no contestó"))
    seguir = await config_remota._actualizar(cliente, "https://crm.test", "clave")

    assert seguir is True, "un fallo de red no debe detener el ciclo de refresco"
    assert config_remota.obtener_prompt_extra() == "## Config previa\nTexto bueno."
    assert config_remota._ESTADO["revision"] == 5


@pytest.mark.asyncio
async def test_conserva_la_config_si_el_crm_responde_error(monkeypatch):
    """Un 500 tampoco debe tocar lo que ya había."""
    _reset_estado()
    config_remota._aplicar({"revision": 3, "prompt_extra": "bloque anterior"})

    cliente = ClienteFalso(respuesta=RespuestaFalsa(500, texto="boom"))
    seguir = await config_remota._actualizar(cliente, "https://crm.test", "clave")

    assert seguir is True
    assert config_remota.obtener_prompt_extra() == "bloque anterior"


# ══════════════════════════════════════════════════════════════════
# 2. sin_cambios NO altera el texto del prompt (protege el caché)
# ══════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_sin_cambios_no_toca_el_prompt(monkeypatch):
    """Regla dura para el caché de Anthropic: si la revisión no cambió, el
    texto que termina en el bloque cacheado del prompt debe ser
    exactamente el mismo objeto de antes, no una copia reconstruida."""
    _reset_estado()
    config_remota._aplicar({"revision": 7, "prompt_extra": "## Personalidad\nCercana."})
    texto_antes = brain.cargar_system_prompt_base()

    cliente = ClienteFalso(respuesta=RespuestaFalsa(200, {"revision": 7, "sin_cambios": True}))
    seguir = await config_remota._actualizar(cliente, "https://crm.test", "clave")

    texto_despues = brain.cargar_system_prompt_base()
    assert seguir is True
    assert texto_despues == texto_antes, "sin_cambios no debe alterar ni un carácter del prompt"
    assert config_remota._ESTADO["revision"] == 7


@pytest.mark.asyncio
async def test_manda_siempre_el_since_de_la_revision_actual(monkeypatch):
    """El CRM decide si hay novedades comparando `since`. Si Claudia no lo
    mandara (o mandara uno viejo), el CRM volvería a servir la misma
    configuración cada vez y el caché se caería sin motivo."""
    _reset_estado()
    config_remota._aplicar({"revision": 42, "prompt_extra": "x"})

    cliente = ClienteFalso(respuesta=RespuestaFalsa(200, {"revision": 42, "sin_cambios": True}))
    await config_remota._actualizar(cliente, "https://crm.test", "clave")

    _, kwargs = cliente.llamadas[0]
    assert kwargs["params"]["since"] == 42


@pytest.mark.asyncio
async def test_config_nueva_si_reemplaza_el_bloque(monkeypatch):
    """Cuando sin_cambios es False, el bloque SÍ debe reemplazarse — es la
    otra mitad de la regla: solo cambia cuando de verdad cambió."""
    _reset_estado()
    config_remota._aplicar({"revision": 1, "prompt_extra": "bloque viejo"})

    nuevo = {
        "revision": 2, "sin_cambios": False, "personalidad": 3,
        "prompt_extra": "bloque nuevo", "fuentes": 2, "comportamientos": 1,
    }
    cliente = ClienteFalso(respuesta=RespuestaFalsa(200, nuevo))
    await config_remota._actualizar(cliente, "https://crm.test", "clave")

    assert config_remota.obtener_prompt_extra() == "bloque nuevo"
    assert config_remota._ESTADO["revision"] == 2


# ══════════════════════════════════════════════════════════════════
# 3. Sin configuración, el prompt base queda idéntico al de hoy
# ══════════════════════════════════════════════════════════════════

def test_sin_config_remota_el_prompt_no_cambia(monkeypatch):
    """Con `prompt_extra` vacío (nunca hubo CRM configurado, o el CRM
    todavía no respondió), cargar_system_prompt_base() debe devolver
    exactamente el texto de config/prompts.yaml — ni un encabezado vacío
    ni un salto de línea de más."""
    _reset_estado()
    assert config_remota.obtener_prompt_extra() == ""

    esperado = brain.cargar_config_prompts().get("system_prompt")
    assert brain.cargar_system_prompt_base() == esperado


def test_con_config_remota_se_anexa_al_final(monkeypatch):
    """Con bloque presente, se pega DESPUÉS del prompt base, tal cual —
    Claudia no lo reinterpreta ni le agrega su propio encabezado."""
    _reset_estado()
    config_remota._aplicar({"revision": 1, "prompt_extra": "## Personalidad\nDirecta y breve."})

    base = brain.cargar_config_prompts().get("system_prompt")
    completo = brain.cargar_system_prompt_base()

    assert completo.startswith(base.rstrip())
    assert completo.endswith("## Personalidad\nDirecta y breve.")
    _reset_estado()


# ══════════════════════════════════════════════════════════════════
# 4 y 5. Reporte de consumo: no rompe la respuesta, ni con cache en None
# ══════════════════════════════════════════════════════════════════

class UsageFalso:
    """Doble de response.usage. Los campos de caché pueden faltar del
    todo (getattr con default) o venir en None (el SDK los manda así
    cuando ese turno no usó caché) — las pruebas cubren ambos casos."""
    def __init__(self, input_tokens=100, output_tokens=50,
                 cache_creation_input_tokens=None, cache_read_input_tokens=None):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens
        self.cache_read_input_tokens = cache_read_input_tokens


@pytest.mark.asyncio
async def test_reportar_uso_no_lanza_si_el_crm_falla(monkeypatch):
    """El requisito duro: el reporte de consumo NUNCA debe propagar un
    error, sin importar qué tan mal responda el CRM."""
    monkeypatch.setenv("WACRM_URL", "https://crm.test")
    monkeypatch.setenv("WACRM_API_KEY", "clave")

    def cliente_que_revienta(**kwargs):
        raise ConnectionError("el CRM está caído")

    monkeypatch.setattr(config_remota.httpx, "AsyncClient", cliente_que_revienta)

    # No debe lanzar. Si lanzara, la prueba fallaría con la excepción.
    await config_remota.reportar_uso("claude-sonnet-4-6", UsageFalso())


@pytest.mark.asyncio
async def test_reportar_uso_normaliza_cache_ausente_o_none(monkeypatch):
    """Los dos contadores de caché pueden venir en None (turno sin caché).
    Deben mandarse como 0, no como None — un CRM que los suma no debería
    tener que tratar None como cero por su cuenta."""
    monkeypatch.setenv("WACRM_URL", "https://crm.test")
    monkeypatch.setenv("WACRM_API_KEY", "clave")

    capturado = {}

    class ClientePost:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **kwargs):
            capturado["json"] = json
            return RespuestaFalsa(200)

    monkeypatch.setattr(config_remota.httpx, "AsyncClient", lambda **k: ClientePost())

    usage_sin_cache = UsageFalso(cache_creation_input_tokens=None, cache_read_input_tokens=None)
    await config_remota.reportar_uso("claude-sonnet-4-6", usage_sin_cache)

    assert capturado["json"]["tokens_cache_escritura"] == 0
    assert capturado["json"]["tokens_cache_lectura"] == 0
    assert capturado["json"]["tokens_entrada"] == 100
    assert capturado["json"]["tokens_salida"] == 50


@pytest.mark.asyncio
async def test_reportar_uso_maneja_atributos_de_cache_ausentes_del_todo(monkeypatch):
    """Un objeto usage sin los atributos de caché siquiera definidos (no
    solo en None) tampoco debe reventar — getattr con default cubre esto."""
    monkeypatch.setenv("WACRM_URL", "https://crm.test")
    monkeypatch.setenv("WACRM_API_KEY", "clave")

    class UsageSinCache:
        input_tokens = 10
        output_tokens = 5
        # Sin cache_creation_input_tokens ni cache_read_input_tokens.

    capturado = {}

    class ClientePost:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **kwargs):
            capturado["json"] = json
            return RespuestaFalsa(200)

    monkeypatch.setattr(config_remota.httpx, "AsyncClient", lambda **k: ClientePost())

    await config_remota.reportar_uso("claude-sonnet-4-6", UsageSinCache())

    assert capturado["json"]["tokens_cache_escritura"] == 0
    assert capturado["json"]["tokens_cache_lectura"] == 0


@pytest.mark.asyncio
async def test_reportar_uso_no_llama_al_crm_si_no_esta_configurado(monkeypatch):
    """Sin WACRM_URL/WACRM_API_KEY, ni siquiera debe intentar la llamada
    (Claudia corriendo con Twilio directo, sin CRM)."""
    monkeypatch.delenv("WACRM_URL", raising=False)
    monkeypatch.delenv("WACRM_API_KEY", raising=False)

    llamado = {"si": False}

    def cliente_que_no_deberia_usarse(**kwargs):
        llamado["si"] = True
        raise AssertionError("no debía llamarse: activo() debía ser False")

    monkeypatch.setattr(config_remota.httpx, "AsyncClient", cliente_que_no_deberia_usarse)

    await config_remota.reportar_uso("claude-sonnet-4-6", UsageFalso())
    assert llamado["si"] is False


@pytest.mark.asyncio
async def test_un_fallo_al_reportar_consumo_no_rompe_generar_respuesta(monkeypatch):
    """La prueba de punta a punta: aunque el reporte de consumo falle,
    generar_respuesta debe seguir devolviendo la respuesta del cliente
    con normalidad. El reporte se dispara en segundo plano (fire-and-
    forget), así que ni siquiera debería poder retrasarla."""
    monkeypatch.setenv("WACRM_URL", "https://crm.test")
    monkeypatch.setenv("WACRM_API_KEY", "clave")

    async def reportar_que_falla(modelo, usage):
        raise RuntimeError("el CRM rechazó el reporte de consumo")

    monkeypatch.setattr(config_remota, "reportar_uso", reportar_que_falla)

    class BloqueTexto:
        type = "text"
        text = "Hola, con gusto te ayudo."

    class RespuestaAnthropic:
        stop_reason = "end_turn"
        content = [BloqueTexto()]
        usage = UsageFalso()

    class MensajesFalsos:
        async def create(self, **kwargs):
            return RespuestaAnthropic()

    class ClienteAnthropicFalso:
        messages = MensajesFalsos()

    monkeypatch.setattr(brain, "client", ClienteAnthropicFalso())

    respuesta = await brain.generar_respuesta("hola", [], telefono="5210000000")

    assert respuesta == "Hola, con gusto te ayudo."


@pytest.mark.asyncio
async def test_respuesta_sin_el_sobre_data_no_borra_la_config(monkeypatch):
    """Toda ruta /api/v1/* del CRM envuelve en {"data": ...}.

    Si algún día una respuesta llega sin el sobre —un proxy que la
    reescriba, una versión vieja del CRM— lo que NO puede pasar es que
    Claudia se quede sin base de conocimiento y siga contestando como si
    nada. Se conserva lo último bueno y se avisa.
    """
    config_remota._ESTADO["revision"] = 5
    config_remota._ESTADO["prompt_extra"] = "conocimiento que ya tenía"

    cliente = ClienteFalso(RespuestaFalsa(200, {"revision": 9, "sin_cambios": False,
                                                "prompt_extra": "otra cosa"},
                                          envolver=False))
    seguir = await config_remota._actualizar(cliente, "http://crm", "k")

    assert seguir is True, "una respuesta rara se reintenta, no detiene el refresco"
    assert config_remota._ESTADO["prompt_extra"] == "conocimiento que ya tenía"
    assert config_remota._ESTADO["revision"] == 5
