# SIM-04 — Cliente EXISTENTE (TUBOS PIRAMIDE S.A. DE C.V., cliente real en
# NetSuite) pide cotización formal. Flujo completo REAL: verificar_cliente_existente
# + notificar_vendedor_cliente_existente -> ESTO MANDA UN WHATSAPP REAL a la
# vendedora asignada (Wendy Ariadna Penelope Lopez Reyes). Sin crear nada en
# NetSuite (por diseño: cliente existente nunca genera registro nuevo).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-04", "Cliente existente pide cotización formal (REAL)", "SIM-04-EXISTENTE")

t.cliente("Hola, necesito una cotización formal de un cable de acero, ya somos clientes de ustedes")
t.claudia("¡Claro que sí! Para conectarte directo con tu asesor, ¿me confirmas el nombre exacto con el que están registrados (la razón social)?")

t.cliente("Tubos Piramide S.A. de C.V.")
res = tools.verificar_cliente_existente(nombre="Tubos Piramide S.A. de C.V.")
t.herramienta("verificar_cliente_existente", {"nombre": "Tubos Piramide S.A. de C.V."}, res)
t.claudia(f"Perfecto, ya te ubiqué en el sistema. Antes de conectarte, cuéntame qué cable necesitas y cuántos metros para dejárselo apuntado a tu asesor.")

t.cliente("Cable boa 3/8, necesitan 300 metros para una obra")
res_cat = tools.consultar_catalogo("cable boa 3/8", telefono="SIM-04-EXISTENTE", cantidad=300)
t.herramienta("consultar_catalogo", {"consulta": "cable boa 3/8", "cantidad": 300}, res_cat)
if res_cat["resultados"]:
    art = res_cat["resultados"][0]
    pedido = run(tools.agregar_al_pedido("SIM-04-EXISTENTE", art["codigo"], 300))
    t.herramienta("agregar_al_pedido", {"codigo": art["codigo"], "cantidad": 300}, pedido)
    t.claudia(f"Anotado: {art['nombre']} x300m. Dame un segundo y te conecto con tu asesora.")
else:
    t.nota("BUSQUEDA SIN RESULTADOS para 'cable boa 3/8' — ver si el catálogo usa otro nombre comercial para cable de acero.")
    t.claudia("Dame un segundo y te conecto con tu asesora para afinar el artículo exacto.")

notif = run(tools.notificar_vendedor_cliente_existente(
    "SIM-04-EXISTENTE",
    salesrep_id=res["salesrep_id"],
    cliente_netsuite_id=res["cliente"]["netsuite_id"],
    cliente_nombre=res["cliente"]["nombre"],
))
t.herramienta("notificar_vendedor_cliente_existente", {"salesrep_id": res["salesrep_id"]}, notif)
t.claudia(notif["mensaje_cliente"])
t.nota(
    f"REAL: se envió (o se intentó enviar) un WhatsApp real a {notif.get('vendedor_nombre')}. "
    f"notificado={notif.get('notificado')}. La instrucción del prompt de usar el 'mensaje_cliente' TAL CUAL "
    f"se siguió al pie de la letra — ese es justo el diseño: Claudia no reinventa ese cierre."
)

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
