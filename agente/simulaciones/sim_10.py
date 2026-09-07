# SIM-10 — Pedido con múltiples artículos distintos, cierre simple
# (confirmar_pedido, NO cotización formal). Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-10", "Pedido con varios artículos, cierre simple", "SIM-10-MULTIPLE")

t.cliente("Necesito 10 grilletes de 1/2, 2 eslingas de 3 toneladas y una cadena grado 80 de 3/8 de 50 metros")
r1 = tools.consultar_catalogo("grillete 1/2", telefono="SIM-10-MULTIPLE")
t.herramienta("consultar_catalogo", {"consulta": "grillete 1/2"}, r1)
r2 = tools.consultar_catalogo("eslinga 3 toneladas", telefono="SIM-10-MULTIPLE")
t.herramienta("consultar_catalogo", {"consulta": "eslinga 3 toneladas"}, r2)
r3 = tools.consultar_catalogo("cadena grado 80 3/8", telefono="SIM-10-MULTIPLE", cantidad=50)
t.herramienta("consultar_catalogo", {"consulta": "cadena grado 80 3/8", "cantidad": 50}, r3)

items_texto = []
total = 0.0
for r, cant in ((r1, 10), (r2, 2), (r3, 50)):
    if r["resultados"]:
        it = r["resultados"][0]
        pedido = run(tools.agregar_al_pedido("SIM-10-MULTIPLE", it["codigo"], cant))
        t.herramienta("agregar_al_pedido", {"codigo": it["codigo"], "cantidad": cant}, pedido)
        items_texto.append(f"{it['nombre']} x{cant} — ${it['precio']*cant:,.2f}")
        total += it["precio"] * cant
    else:
        t.nota(f"Sin resultados para uno de los artículos pedidos — Claudia debería avisarlo, no omitirlo en silencio.")

resumen = "\n".join(f"- {x}" for x in items_texto)
t.claudia(f"Va tu pedido:\n{resumen}\nTotal: ${total:,.2f}\n¿Lo confirmo así?")

t.cliente("Sí va, confírmalo")
conf = run(tools.confirmar_pedido("SIM-10-MULTIPLE"))
t.herramienta("confirmar_pedido", {}, conf)
t.claudia(f"Quedó confirmado tu pedido por ${conf['total']:,.2f}, {conf['articulos']} artículos. En breve te contacta el equipo para coordinar entrega o recolección. ¡Gracias!")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
