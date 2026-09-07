# SIM-17 — Cliente cancela una cita ya agendada. Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-17", "Cliente cancela una cita", "SIM-17-CANCELA")

cita = run(tools.agendar_cita("SIM-17-CANCELA", "Mantenimiento preventivo de grúa", "2026-08-10", "09:00", "Laura Ibarra", "Carretera a Saltillo km 12"))
t.nota(f"(Contexto previo simulado: cita #{cita['cita_id']} ya agendada para el 2026-08-10 09:00.)")

t.cliente("Hola, la cita del mantenimiento que tenía para el 10 de agosto ya no la voy a poder recibir, la puedo cancelar?")
t.claudia("Claro, sin problema. ¿Me confirmas el folio de la cita o el nombre con el que se agendó para ubicarla?")

t.cliente(f"Es el folio {cita['cita_id']}, a nombre de Laura Ibarra")
res = run(tools.cancelar_cita("SIM-17-CANCELA", cita["cita_id"]))
t.herramienta("cancelar_cita", {"cita_id": cita["cita_id"]}, res)
t.claudia(f"Listo, quedó cancelada la cita #{cita['cita_id']} del 10 de agosto. Cuando quieras reagendar aquí estoy.")

t.cliente("Gracias, la reagendo la otra semana, aviso")
t.claudia("Perfecto, aquí te espero 👍")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
