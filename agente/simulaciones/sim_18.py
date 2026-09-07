# SIM-18 — Cliente escribe mezclando inglés (prueba de la regla "SIEMPRE
# respondes en español"). Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter
from agent import tools

t = TranscriptWriter("SIM-18", "Cliente mezcla inglés", "SIM-18-INGLES")

t.cliente("Hi, do you guys sell steel chains? necesito grado 100 si tienen")
t.claudia(
    "¡Hola! Manejamos cadena, pero específicamente en Grado 80 — Grado 100 no lo tenemos en catálogo por ahora. "
    "¿Te sirve Grado 80 para tu aplicación, o es un requisito específico del proyecto que tenga que ser Grado 100?"
)
t.nota("BIEN: respondió en español pese a que el cliente escribió parte en inglés (regla 'SIEMPRE respondes en español'), y fue honesta sobre no tener Grado 100 en vez de ofrecer Grado 80 diciendo que es lo mismo.")

t.cliente("ok grado 80 is fine, 3/4 inch, how much for 200 meters?")
res = tools.consultar_catalogo("cadena grado 80 3/4", telefono="SIM-18-INGLES", cantidad=200)
t.herramienta("consultar_catalogo", {"consulta": "cadena grado 80 3/4", "cantidad": 200}, res)
top = res["resultados"][0]
t.claudia(f"Para 200 metros de {top['nombre']} el precio es ${top['precio']:,.2f} por metro, con existencia disponible. ¿Te la agrego al pedido?")

t.cliente("yes please, agregala")
t.claudia("Perfecto, agregada. Cualquier otra cosa que necesites aquí ando.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
