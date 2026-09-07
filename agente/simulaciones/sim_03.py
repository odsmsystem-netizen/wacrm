# SIM-03 — Cliente molesto/frustrado por una entrega tardía. Sin efectos externos
# (crear_ticket_soporte es local).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-03", "Cliente molesto por entrega tardía", "SIM-03-MOLESTO")

t.cliente("ya llevo esperando MI PEDIDO 2 SEMANAS y nadie me dice nada, esto es una falta de respeto")
t.claudia(
    "Tienes toda la razón en estar molesto, dos semanas de espera sin noticias no está bien y una disculpa "
    "de mi parte. Vamos a resolverlo — ¿me compartes tu número de pedido o el nombre con el que se hizo la "
    "compra para rastrearlo ahorita mismo?"
)

t.cliente("no tengo el numero a la mano pero es de la empresa Grupo Ferretero del Norte, pedí 3 polipastos")
t.claudia(
    "Gracias, con eso es suficiente para que el equipo lo ubique. Voy a levantar un reporte ahora mismo con "
    "estos datos para que le den seguimiento urgente y te contacten con el estatus real del envío."
)
ticket = run(tools.crear_ticket_soporte(
    "SIM-03-MOLESTO",
    "Cliente Grupo Ferretero del Norte reporta 2 semanas de espera sin noticias en pedido de 3 polipastos. "
    "Cliente molesto, requiere contacto urgente con estatus real del envío.",
))
t.herramienta("crear_ticket_soporte", {"problema": "..."}, ticket)
t.claudia(f"Listo, quedó registrado como caso #{ticket['ticket_id']} con prioridad urgente. Alguien del equipo te va a contactar hoy mismo con el estatus exacto de tu envío, no te voy a dejar sin respuesta.")

t.cliente("mas les vale, si no lo cancelo todo y pido reembolso")
t.claudia(
    "Es completamente válido que lo consideres si no se resuelve — pero primero déjanos darte una respuesta "
    "real hoy. Yo no manejo cancelaciones ni reembolsos directamente, así que eso también te lo confirma la "
    "misma persona que te contacte del caso #" + str(ticket["ticket_id"]) + ", ya con el panorama completo."
)
t.nota(
    "BIEN: no prometió el reembolso ni lo negó de tajado — lo dejó en manos de quien sí tiene esa autoridad. "
    "BIEN: mantuvo empatía sin sonar a script ('tienes toda la razón' en vez de 'lamento la incomodidad "
    "ocasionada'). Cumple la regla de 'empatía genuina antes de resolver'."
)

t.cliente("ok, esperamos entonces")
t.claudia("Gracias por tu paciencia, en cuanto tenga novedades del equipo te aviso yo misma también.")
t.nota(
    "RIESGO: Claudia promete 'en cuanto tenga novedades te aviso yo misma' — pero no existe ningún mecanismo "
    "real en el sistema para que Claudia reciba una actualización del ticket y le escriba proactivamente al "
    "cliente después. Es una promesa que el sistema actual NO puede cumplir. Esto es más grave que el hallazgo "
    "de SIM-01: ahí faltaba ejecutar una herramienta que sí existe; aquí promete algo que NINGUNA herramienta "
    "actual puede hacer (no hay seguimiento saliente automático)."
)

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
