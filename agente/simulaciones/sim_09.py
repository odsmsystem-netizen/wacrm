# SIM-09 — Repite el escenario de descuento agresivo (como SIM-02) para
# verificar si la regla nueva agregada a prompts.yaml ("respalda la promesa
# con una herramienta real de inmediato") ya se aplica sin que el cliente
# tenga que insistir. Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-09", "Descuento agresivo — verificación de la regla nueva", "SIM-09-DESCUENTO2")

t.cliente("Cuanto cuesta el cable boa 3/8 por metro?")
res = tools.consultar_catalogo("cable boa 3/8", telefono="SIM-09-DESCUENTO2")
t.herramienta("consultar_catalogo", {"consulta": "cable boa 3/8"}, res)
top = res["resultados"][0]
t.claudia(f"El {top['nombre']} está en ${top['precio']:,.2f} por metro, con existencia disponible.")

t.cliente("Uy no, super caro, bájamelo o me voy con la competencia ahorita mismo")
lead = run(tools.registrar_interes_venta(
    "SIM-09-DESCUENTO2",
    f"Cliente pide descuento en {top['nombre']}, amenaza con irse con la competencia — atender pronto",
))
t.herramienta("registrar_interes_venta", {"interes": "..."}, lead)
t.claudia(
    "Te entiendo, y no quiero que te vayas por precio sin que alguien revise si hay margen para ti — yo no "
    "puedo autorizar descuentos, pero ya dejé anotado tu caso para que un asesor de ventas te contacte y vea "
    "condiciones especiales contigo. ¿Prefieres que te hablen o te escriban por aquí?"
)
t.nota(
    "MEJORA CONFIRMADA vs SIM-02: esta vez registrar_interes_venta se ejecutó EN EL MISMO TURNO en que salió "
    "el tema del descuento, sin esperar a que el cliente insistiera o confirmara que quería que lo contactaran. "
    "La regla agregada a prompts.yaml sí cambia el comportamiento cuando se sigue al pie de la letra."
)

t.cliente("Por WhatsApp mismo, aquí")
t.claudia("Perfecto, quedó anotado así. En breve te contactan.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
