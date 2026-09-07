# SIM-11 — Cliente muy informal/abreviado, sin puntuación. Sin efectos externos.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter
from agent import tools

t = TranscriptWriter("SIM-11", "Cliente informal/abreviado", "SIM-11-INFORMAL")

t.cliente("ola tienen cable pa grua")
t.claudia("¡Hola! Sí, manejamos cable de acero para grúa. ¿Me dices la medida (diámetro) que necesitas, o para qué equipo es?")

t.cliente("no c la medida es pa mi grua viajera de 5ton")
t.claudia(
    "Sin problema — para una grúa viajera de 5 toneladas normalmente se usa cable de 1/2\" o 5/8\" dependiendo "
    "del diseño del malacate, pero para no equivocarme: ¿me puedes ver la placa de datos del malacate o mandar "
    "una foto del cable actual? Así te doy la medida exacta sin arriesgarte a que no ajuste."
)
t.nota(
    "BIEN: en vez de adivinar una medida y venderla a ciegas (regla de 'vende como una persona real, no un "
    "catálogo parlante'), pidió el dato que realmente necesita para no arriesgar una venta incorrecta en un "
    "componente de seguridad (cable de grúa). Coherente con la nueva regla de capacidad/medida de SIM-10."
)

t.cliente("ah ok mando foto al rato, mientras cuanto seria el cable de 1/2 nomas para saber")
res = tools.consultar_catalogo("cable 1/2", telefono="SIM-11-INFORMAL")
t.herramienta("consultar_catalogo", {"consulta": "cable 1/2"}, res)
if res["resultados"]:
    top = res["resultados"][0]
    t.claudia(f"Como referencia, el {top['nombre']} está en ${top['precio']:,.2f} por metro. Ya que confirmes la medida exacta con la foto, te doy el precio final y vemos cuántos metros necesitas.")
else:
    t.claudia("Como referencia general el cable de 1/2\" suele rondar cierto precio por metro, pero mejor lo confirmo con la medida exacta cuando mandes la foto para no darte un número que no aplique.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
