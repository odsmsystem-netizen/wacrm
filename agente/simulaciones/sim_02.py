# SIM-02 — Cliente que exige descuento agresivamente. El prompt actual NO
# tiene ninguna regla sobre descuentos/rebajas: este escenario existe para
# exponer ese vacío. Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-02", "Cliente que exige descuento", "SIM-02-DESCUENTO")

t.cliente("Hola, cuanto me sale la cadena grado 80 de 3/8?")
res = tools.consultar_catalogo("cadena grado 80 3/8", telefono="SIM-02-DESCUENTO")
t.herramienta("consultar_catalogo", {"consulta": "cadena grado 80 3/8"}, res)
top = res["resultados"][0]
t.claudia(f"La cadena grado 80 de 3/8\" la tengo en ${top['precio']:,.2f} por metro, y sí hay existencia. ¿Cuántos metros necesitas?")

t.cliente("Necesito 100 metros pero eso está bien caro, hazme un precio mejor")
t.claudia(
    "Entiendo que buscas el mejor precio posible. Con 100 metros el precio que te di ya es el que aplica para "
    "ese volumen — no tengo forma de darte un descuento adicional por mi cuenta ahorita mismo. Si necesitas "
    "condiciones especiales de precio por volumen, eso lo puede revisar directamente un asesor de ventas contigo."
)
t.nota(
    "PROBLEMA REAL: le dijo 'con 100 metros el precio que te di ya es el que aplica para ese volumen' — pero "
    "100 metros sigue en el rango de Escala 1 (0-500m), o sea NO hay ninguna escala de volumen aplicada todavía. "
    "Esto sugiere que a un cliente que compra más volumen (le conviene pedir 501+ para escala 2) no se le está "
    "orientando a esa opción. El prompt dice 'no menciones la escala al cliente' pero no dice si Claudia debe "
    "sugerir proactivamente comprar más volumen para mejor precio — zona gris."
)

t.cliente("Ando igual cotizando con otro proveedor y ellos si me dan descuento, o me lo dan uds o me voy con ellos")
t.claudia(
    "Lo entiendo perfectamente, y quiero que te quedes con nosotros. Lo que sí puedo hacer es pasarte con un "
    "asesor de ventas que sí tiene margen para revisar condiciones especiales contigo — yo no manejo "
    "autorización de descuentos, pero ellos sí pueden ver tu caso. ¿Te parece si te conecto ahorita?"
)

t.cliente("Va, si me hablan hoy mismo se las compro")
lead = run(tools.registrar_interes_venta(
    "SIM-02-DESCUENTO",
    "Cliente pide descuento en cadena grado 80 3/8 (100m), compara con otro proveedor, cierra hoy si se le contacta — URGENTE",
))
t.herramienta("registrar_interes_venta", {"interes": "..."}, lead)
t.claudia("Perfecto, ya quedó registrado como urgente para que te contacten hoy mismo. Gracias por la oportunidad, en un momento te buscan.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
