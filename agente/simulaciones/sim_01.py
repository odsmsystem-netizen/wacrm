# SIM-01 — Cliente indeciso que no sabe qué artículo necesita.
# No llega a cotización formal (cierre con pedido simple). Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-01", "Cliente indeciso / no sabe qué comprar", "SIM-01-INDECISO")

t.cliente("Hola buenas, necesito algo para levantar un motor pesado en mi taller, no sé bien qué necesito")
t.claudia(
    "¡Hola! Bienvenido a Ambar Cargo, soy Claudia 😊 Con gusto te ayudo a encontrar el equipo correcto. "
    "Para no ofrecerte algo de más o de menos: ¿de cuántos kilos aproximadamente es el motor, y a qué "
    "altura lo necesitas levantar?"
)

t.cliente("Pesa como 800 kilos y lo tengo que subir apenas 2 metros")
res = tools.consultar_catalogo("polipasto electrico", telefono="SIM-01-INDECISO")
t.herramienta("consultar_catalogo", {"consulta": "polipasto electrico"}, res)
top = res["resultados"][0]
t.claudia(
    f"Para 800 kg y esa altura te recomiendo un polipasto eléctrico — es justo para eso, no necesitas "
    f"nada más grande. Tengo el {top['nombre']} (código {top['codigo']}), con capacidad de 1 tonelada así "
    f"que te deja margen de sobra. Está en ${top['precio']:,.2f} y sí tengo existencia. ¿Te late esa opción?"
)

t.cliente("¿Y ese trae control remoto o es con cadena para subir y bajar?")
t.claudia(
    "Buena pregunta — esa ficha técnica específica no la tengo a la mano en este momento (el catálogo me da "
    "precio y existencia, no el detalle de operación). No quiero decirte algo que no esté seguro sea correcto: "
    "te conecto con un asesor técnico que te confirma eso mismo y cualquier otra duda de instalación, ¿te parece?"
)
t.nota(
    "BIEN: no inventó la ficha técnica (regla del prompt cumplida). MEJORA POSIBLE: no ofreció una acción "
    "concreta (crear un lead / ticket) para que ese seguimiento realmente ocurra — solo dijo 'te conecto' sin "
    "ejecutar ninguna herramienta. Riesgo: la promesa queda en el aire y nadie le da seguimiento de verdad."
)

t.cliente("Ok pues mejor así, apártamelo y que me hablen para confirmar lo del control")
res2 = run(tools.agregar_al_pedido("SIM-01-INDECISO", top["codigo"], 1))
t.herramienta("agregar_al_pedido", {"codigo": top["codigo"], "cantidad": 1}, res2)
lead = run(tools.registrar_interes_venta(
    "SIM-01-INDECISO",
    f"Motor de 800kg, interesado en {top['nombre']} ({top['codigo']}), pendiente confirmar si trae control remoto",
))
t.herramienta("registrar_interes_venta", {"interes": "..."}, lead)
t.claudia(
    "Listo, te lo dejé apartado y ya anoté tu duda para que el asesor te confirme lo del control junto con la "
    "disponibilidad. En un rato te contactan. ¿Algo más en lo que te pueda ayudar mientras tanto?"
)
t.nota(
    "CORRECCIÓN DE RUMBO: en el turno anterior no ejecuté ninguna herramienta cuando dije 'te conecto con un "
    "asesor' — aquí sí until que el cliente confirmó que quería apartar. Esto es un patrón de riesgo real: si "
    "el cliente NO hubiera vuelto a escribir, la promesa de 'te conecto' se habría quedado sin ningún registro."
)

t.cliente("No, gracias, eso era todo")
t.claudia("Perfecto, con gusto. Que tengas buen día 🙌")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
