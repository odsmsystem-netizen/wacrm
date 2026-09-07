# SIM-07 — Mensaje fuera de horario. Sin herramientas ni efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter

t = TranscriptWriter("SIM-07", "Cliente escribe fuera de horario (11:40pm sábado)", "SIM-07-FUERAHORARIO")

t.cliente("Hola disculpen la hora, necesito saber si tienen estrobos de 2 toneladas")
t.claudia(
    "Gracias por escribirnos. Nuestro horario de atención es Lunes a Viernes de 9:00am a 6:30pm y Sábados de "
    "9:00am a 2:00pm. Te responderemos en cuanto estemos disponibles."
)
t.nota(
    "Sigue el mensaje EXACTO configurado en prompts.yaml para fuera de horario, tal como pide la regla. "
    "PREGUNTA ABIERTA: ¿debería Claudia, aun fuera de horario, hacer una consulta rápida al catálogo y "
    "responder la disponibilidad igual (servicio 24/7 para info básica), o el negocio prefiere el corte tajante "
    "que hay hoy? Es una decisión de negocio, no la voy a cambiar por mi cuenta — la dejo anotada."
)

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
