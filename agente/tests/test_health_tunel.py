# tests/test_health_tunel.py — Tests del vigilante del túnel
# Generado por AgentKit

"""
Tests de agent/health_tunel.py.

Todo lo que toca la red o lanza procesos está mockeado: la suite corre
offline, sin cloudflared y sin Twilio. Lo que se prueba de verdad es la
LÓGICA que decide (¿está caído?, ¿aviso o no?, ¿reintento o me rindo?),
porque ahí es donde un error se paga caro: un falso positivo relanza el
túnel sin necesidad y cambia la URL — rompiendo el webhook que estaba
perfectamente bien.

Correr con:  python -m pytest tests/test_health_tunel.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import health_tunel as ht


# ══════════════════════════════════════════════════════════════════
# 1. Leer la URL del log de cloudflared
# ══════════════════════════════════════════════════════════════════

LOG_CON_URL = """
2026-07-30T23:42:09Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-07-30T23:42:11Z INF +--------------------------------------------------+
2026-07-30T23:42:11Z INF |  Your quick Tunnel has been created! Visit it at: |
2026-07-30T23:42:11Z INF |  https://rochester-planet-mill-appeared.trycloudflare.com |
2026-07-30T23:42:11Z INF +--------------------------------------------------+
"""

LOG_DOS_URLS = LOG_CON_URL + """
2026-07-31T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-07-31T10:00:02Z INF |  https://nueva-url-de-prueba.trycloudflare.com |
"""


def test_extrae_la_url_del_log():
    assert ht.extraer_url(LOG_CON_URL) == "https://rochester-planet-mill-appeared.trycloudflare.com"


def test_con_varias_urls_toma_la_ultima():
    """cloudflared reusa el mismo log entre reinicios: la vigente es la última."""
    assert ht.extraer_url(LOG_DOS_URLS) == "https://nueva-url-de-prueba.trycloudflare.com"


def test_log_sin_url_devuelve_none():
    assert ht.extraer_url("2026-07-30T23:42:09Z INF arrancando...\n") is None


def test_log_vacio_devuelve_none():
    assert ht.extraer_url("") is None


# ══════════════════════════════════════════════════════════════════
# 2. Interpretar la respuesta del chequeo
# ══════════════════════════════════════════════════════════════════

def test_200_con_el_json_correcto_es_sano():
    sano, _ = ht.interpretar_respuesta(200, '{"status":"ok","service":"agentkit"}')
    assert sano is True


def test_200_de_otra_app_no_es_sano():
    """El túnel puede estar vivo pero apuntando a otra cosa: no basta el 200."""
    sano, motivo = ht.interpretar_respuesta(200, '{"hello":"world"}')
    assert sano is False
    assert "agentkit" in motivo.lower()


def test_502_no_es_sano():
    """502 = el túnel vive pero el servidor local detrás está muerto."""
    sano, motivo = ht.interpretar_respuesta(502, "Bad Gateway")
    assert sano is False
    assert "502" in motivo


def test_530_no_es_sano():
    """530 de Cloudflare = el túnel ya no existe. El caso que nos importa."""
    sano, _ = ht.interpretar_respuesta(530, "")
    assert sano is False


def test_sin_respuesta_no_es_sano():
    """status None = timeout o DNS caído."""
    sano, motivo = ht.interpretar_respuesta(None, "")
    assert sano is False
    assert motivo


# ══════════════════════════════════════════════════════════════════
# 3. Anti-spam: avisar solo en CAMBIO de estado
# ══════════════════════════════════════════════════════════════════

def test_primera_caida_avisa():
    assert ht.debe_alertar(estado_previo="sano", estado_nuevo="caido") is True


def test_caida_sostenida_no_vuelve_a_avisar():
    """Cinco chequeos fallidos seguidos = un solo WhatsApp, no cinco."""
    assert ht.debe_alertar(estado_previo="caido", estado_nuevo="caido") is False


def test_recuperacion_avisa():
    assert ht.debe_alertar(estado_previo="caido", estado_nuevo="sano") is True


def test_sigue_sano_no_avisa():
    assert ht.debe_alertar(estado_previo="sano", estado_nuevo="sano") is False


def test_arranque_en_sano_no_avisa():
    """Al arrancar el servidor con todo bien, no hay que despertar a nadie."""
    assert ht.debe_alertar(estado_previo=None, estado_nuevo="sano") is False


def test_arranque_encontrando_todo_caido_si_avisa():
    assert ht.debe_alertar(estado_previo=None, estado_nuevo="caido") is True


def test_degradado_avisa_una_vez():
    assert ht.debe_alertar(estado_previo="caido", estado_nuevo="degradado") is True
    assert ht.debe_alertar(estado_previo="degradado", estado_nuevo="degradado") is False


# ══════════════════════════════════════════════════════════════════
# 4. Backoff: no relanzar cloudflared en bucle infinito
# ══════════════════════════════════════════════════════════════════

def test_reintenta_las_primeras_tres_veces():
    assert ht.debe_reintentar(0) is True
    assert ht.debe_reintentar(1) is True
    assert ht.debe_reintentar(2) is True


def test_al_cuarto_intento_se_rinde():
    """Si tres relanzamientos no levantaron el túnel, el problema es otro."""
    assert ht.debe_reintentar(3) is False
    assert ht.debe_reintentar(10) is False


def test_la_espera_crece_con_cada_intento():
    esperas = [ht.espera_backoff(i) for i in range(3)]
    assert esperas == sorted(esperas)
    assert esperas[0] < esperas[-1]


# ══════════════════════════════════════════════════════════════════
# 5. Reescribir PUBLIC_BASE_URL en .env sin romper el resto
# ══════════════════════════════════════════════════════════════════

ENV_EJEMPLO = """# AgentKit — Variables de entorno
ANTHROPIC_API_KEY=sk-ant-secreto
WHATSAPP_PROVIDER=twilio

# Túnel
PUBLIC_BASE_URL=https://vieja-url.trycloudflare.com
PORT=8000
"""


def test_reemplaza_la_url_conservando_todo_lo_demas():
    nuevo = ht.reescribir_env(ENV_EJEMPLO, "PUBLIC_BASE_URL", "https://nueva.trycloudflare.com")

    assert "PUBLIC_BASE_URL=https://nueva.trycloudflare.com" in nuevo
    assert "vieja-url" not in nuevo
    # Las demás variables siguen intactas
    assert "ANTHROPIC_API_KEY=sk-ant-secreto" in nuevo
    assert "WHATSAPP_PROVIDER=twilio" in nuevo
    assert "PORT=8000" in nuevo
    # Y los comentarios también
    assert "# Túnel" in nuevo
    assert "# AgentKit — Variables de entorno" in nuevo


def test_no_duplica_lineas():
    nuevo = ht.reescribir_env(ENV_EJEMPLO, "PUBLIC_BASE_URL", "https://nueva.trycloudflare.com")
    assert nuevo.count("PUBLIC_BASE_URL=") == 1


def test_agrega_la_clave_si_no_existia():
    sin_clave = "ANTHROPIC_API_KEY=sk-ant-secreto\nPORT=8000\n"
    nuevo = ht.reescribir_env(sin_clave, "PUBLIC_BASE_URL", "https://nueva.trycloudflare.com")
    assert "PUBLIC_BASE_URL=https://nueva.trycloudflare.com" in nuevo
    assert "ANTHROPIC_API_KEY=sk-ant-secreto" in nuevo


def test_no_confunde_claves_con_prefijo_comun():
    """PUBLIC_BASE_URL_ANTERIOR no debe ser tocada al escribir PUBLIC_BASE_URL."""
    env = "PUBLIC_BASE_URL_ANTERIOR=https://a.com\nPUBLIC_BASE_URL=https://b.com\n"
    nuevo = ht.reescribir_env(env, "PUBLIC_BASE_URL", "https://c.com")
    assert "PUBLIC_BASE_URL_ANTERIOR=https://a.com" in nuevo
    assert "PUBLIC_BASE_URL=https://c.com" in nuevo


def test_el_valor_termina_con_salto_de_linea():
    nuevo = ht.reescribir_env(ENV_EJEMPLO, "PUBLIC_BASE_URL", "https://nueva.trycloudflare.com")
    assert nuevo.endswith("\n")


# ══════════════════════════════════════════════════════════════════
# 6. El mensaje de alerta debe ser accionable
# ══════════════════════════════════════════════════════════════════

def test_la_alerta_de_url_nueva_incluye_el_webhook_a_pegar():
    """
    Lo único que el sistema NO puede arreglar solo es el webhook de Twilio.
    Si la alerta no trae la URL exacta con /webhook, el aviso no sirve.
    """
    msg = ht.componer_alerta(
        evento="url_cambiada",
        url_anterior="https://vieja.trycloudflare.com",
        url_nueva="https://nueva.trycloudflare.com",
        detalle="502 Bad Gateway",
    )
    assert "https://nueva.trycloudflare.com/webhook" in msg
    assert "Twilio" in msg


def test_la_alerta_de_recuperacion_no_pide_accion_si_la_url_no_cambio():
    """Si cloudflared revivió con la MISMA URL, no hay nada que pegar."""
    msg = ht.componer_alerta(
        evento="recuperado",
        url_anterior="https://misma.trycloudflare.com",
        url_nueva="https://misma.trycloudflare.com",
        detalle="",
    )
    assert "/webhook" not in msg


def test_la_alerta_no_filtra_secretos():
    """Regla dura: ninguna alerta debe llevar tokens."""
    msg = ht.componer_alerta(
        evento="url_cambiada",
        url_anterior="https://vieja.trycloudflare.com",
        url_nueva="https://nueva.trycloudflare.com",
        detalle="error",
    )
    for secreto in ("sk-ant", "TWILIO_AUTH_TOKEN", os.getenv("TWILIO_AUTH_TOKEN") or "@@nada@@"):
        assert secreto not in msg


# ══════════════════════════════════════════════════════════════════
# 7. Chequeo real contra HTTP (mockeado)
# ══════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_chequear_url_reporta_sano(monkeypatch):
    class RespuestaFalsa:
        status_code = 200
        text = '{"status":"ok","service":"agentkit"}'

    class ClienteFalso:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k): return RespuestaFalsa()

    monkeypatch.setattr(ht.httpx, "AsyncClient", lambda **k: ClienteFalso())
    sano, _ = await ht.chequear_url("https://loquesea.trycloudflare.com")
    assert sano is True


@pytest.mark.asyncio
async def test_chequear_url_maneja_timeout_sin_reventar(monkeypatch):
    """Un timeout es el síntoma típico del túnel muerto: no debe propagar excepción."""
    class ClienteFalso:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k): raise ht.httpx.ConnectTimeout("timeout")

    monkeypatch.setattr(ht.httpx, "AsyncClient", lambda **k: ClienteFalso())
    sano, motivo = await ht.chequear_url("https://loquesea.trycloudflare.com")
    assert sano is False
    assert motivo


@pytest.mark.asyncio
async def test_chequear_sin_url_no_es_sano():
    sano, motivo = await ht.chequear_url(None)
    assert sano is False
    assert motivo


@pytest.mark.asyncio
async def test_arrancar_con_todo_sano_no_registra_un_evento_falso(monkeypatch):
    """
    Al arrancar el servidor con el túnel funcionando no se recuperó nada.
    Sin este guardo, CADA reinicio dejaba un evento "recuperado" fantasma
    en el historial del panel.
    """
    eventos = []

    async def _falso_transicion(*a, **k):
        eventos.append(a)

    monkeypatch.setattr(ht, "_transicion", _falso_transicion)
    monkeypatch.setattr(ht, "leer_url_actual", lambda: "https://x.trycloudflare.com")

    async def _sano(url):
        return True, "ok"

    monkeypatch.setattr(ht, "chequear_url", _sano)
    ht.estado_actual["estado"] = None

    await ht._un_ciclo()

    assert eventos == [], "no debió registrarse ninguna transición"
    assert ht.estado_actual["estado"] == "sano"


# ══════════════════════════════════════════════════════════════════
# 8. Interruptor de apagado
# ══════════════════════════════════════════════════════════════════

def test_el_vigilante_se_puede_apagar(monkeypatch):
    monkeypatch.setenv("HEALTH_TUNEL_ENABLED", "false")
    assert ht.vigilancia_activa() is False


def test_activo_por_defecto(monkeypatch):
    monkeypatch.delenv("HEALTH_TUNEL_ENABLED", raising=False)
    assert ht.vigilancia_activa() is True
