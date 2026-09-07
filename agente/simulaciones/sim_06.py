# SIM-06 — Agendar cita de mantenimiento (caso normal). Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-06", "Agendar cita de mantenimiento", "SIM-06-CITA")

t.cliente("Hola, necesito que me manden a alguien a revisar un polipasto que se atoró")
t.claudia("Con gusto agendamos la visita técnica. ¿Qué día y hora te acomoda, y me confirmas tu nombre para la cita?")

t.cliente("Sería el jueves que viene en la mañana, soy Marcos de Aceros del Pacifico")
cita = run(tools.agendar_cita("SIM-06-CITA", "Revisión de polipasto atorado", "2026-08-06", "10:00", "Marcos - Aceros del Pacifico"))
t.herramienta("agendar_cita", {"servicio": "Revisión de polipasto atorado", "fecha": "2026-08-06", "hora": "10:00"}, cita)
t.claudia(f"Listo Marcos, quedó agendada la visita para el jueves 6 de agosto a las 10:00am (folio #{cita['cita_id']}). El técnico se presenta en tu dirección — ¿me la confirmas para que quede en la orden de servicio?")

t.cliente("Av. Industrias 450, Parque Industrial Norte, Guadalajara")
t.claudia("Perfecto, ya quedó anotada. Cualquier cambio de horario avísame por aquí mismo. Nos vemos el jueves 👍")
t.nota(
    "OBSERVACIÓN: la dirección que dio el cliente NO se guardó en ningún lado — agendar_cita solo tiene "
    "campos telefono/servicio/fecha/hora/nombre_cliente, no dirección. Claudia dijo 'ya quedó anotada' pero "
    "en realidad no hay ninguna herramienta que la registre. Es el mismo patrón de 'promesa sin acción' de "
    "SIM-01/SIM-03, pero aquí ni siquiera hay una herramienta disponible para cumplirla (falta un parámetro "
    "en agendar_cita, no es un tema de que Claudia decida usar o no la herramienta)."
)

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
