# SIM-12 — Cliente cambia de tema abruptamente varias veces en la misma
# conversación. Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-12", "Cliente cambia de tema abruptamente", "SIM-12-CAMBIOTEMA")

t.cliente("Oye tienen garantia los polipastos que venden?")
t.claudia("Sí, nuestros equipos cuentan con garantía del fabricante. Si me dices cuál polipasto te interesa te confirmo el periodo exacto de garantía de ese modelo en particular.")

t.cliente("no es para saber, oye de hecho necesito cotizar un polipasto de 2 toneladas")
res = tools.consultar_catalogo("polipasto 2 toneladas", telefono="SIM-12-CAMBIOTEMA")
t.herramienta("consultar_catalogo", {"consulta": "polipasto 2 toneladas"}, res)
top = res["resultados"][0] if res["resultados"] else None
if top:
    t.claudia(f"Claro, el {top['nombre']} está en ${top['precio']:,.2f}, con existencia disponible. ¿Te lo agrego al pedido?")

t.cliente("espera antes de eso, tienen sucursal en Monterrey?")
t.claudia(
    "Esa información específica de sucursales no la tengo a la mano ahorita — te la puede confirmar un asesor "
    "junto con tu cotización. Volviendo al polipasto, ¿te lo agrego al pedido o prefieres que primero te resuelvan "
    "lo de la sucursal?"
)
t.nota(
    "BIEN: no se perdió el hilo del polipasto al responder la pregunta nueva — regresó al tema pendiente en "
    "vez de abandonarlo. No inventó información de sucursales que no tiene."
)

t.cliente("no nada mas curiosidad, si va agregalo")
if top:
    pedido = run(tools.agregar_al_pedido("SIM-12-CAMBIOTEMA", top["codigo"], 1))
    t.herramienta("agregar_al_pedido", {"codigo": top["codigo"], "cantidad": 1}, pedido)
    t.claudia(f"Listo, {top['nombre']} agregado. ¿Algo más o lo dejamos así por ahora?")

t.cliente("ya con eso, gracias")
t.claudia("Con gusto, cualquier cosa aquí ando 🙌")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
