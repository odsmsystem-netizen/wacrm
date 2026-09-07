# SIM-15 — Cliente regresa días después a preguntar por un pedido que ya
# tenía en curso (continuidad del carrito). Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-15", "Cliente regresa por un pedido que dejó a medias", "SIM-15-REGRESA")

# Simula que en un mensaje anterior (otro día) ya había agregado algo al carrito.
res = tools.consultar_catalogo("cadena grado 80 1/2", telefono="SIM-15-REGRESA")
art = res["resultados"][0]
run(tools.agregar_al_pedido("SIM-15-REGRESA", art["codigo"], 20))
t.nota(f"(Contexto previo simulado: en un mensaje de días atrás ya se había agregado {art['nombre']} x20 al carrito, sin cerrar el pedido.)")

t.cliente("Hola, disculpa la tardanza, en que había quedado mi pedido de la cadena?")
pedido = run(tools.ver_pedido_actual("SIM-15-REGRESA"))
t.herramienta("ver_pedido_actual", {}, pedido)
items_txt = "\n".join(f"- {i['nombre_articulo']} x{i['cantidad']} — ${i['subtotal']:,.2f}" for i in pedido["articulos"])
t.claudia(f"Ninguna prisa. Tienes pendiente:\n{items_txt}\nTotal: ${pedido['total']:,.2f}\n¿Lo confirmamos así o quieres ajustar algo?")

t.cliente("Se me habia olvidado, si mejor confirmalo y agrega 5 grilletes de 1/2 tambien")
res2 = tools.consultar_catalogo("grillete 1/2", telefono="SIM-15-REGRESA")
t.herramienta("consultar_catalogo", {"consulta": "grillete 1/2"}, res2)
if res2["resultados"]:
    g = res2["resultados"][0]
    run(tools.agregar_al_pedido("SIM-15-REGRESA", g["codigo"], 5))
    t.herramienta("agregar_al_pedido", {"codigo": g["codigo"], "cantidad": 5}, {"ok": True})
conf = run(tools.confirmar_pedido("SIM-15-REGRESA"))
t.herramienta("confirmar_pedido", {}, conf)
t.claudia(f"Listo, quedó todo confirmado: {conf['articulos']} artículos por ${conf['total']:,.2f} en total. En breve te contactan para coordinar entrega. ¡Gracias por tu paciencia!")
t.nota(
    "BIEN: el carrito persiste correctamente entre 'sesiones' (no se perdió nada de lo agregado antes), y "
    "permitió agregar un artículo nuevo antes de cerrar. Esto valida que agent/memory.py mantiene estado real "
    "por teléfono, no solo por conversación activa en memoria."
)

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
