# SIM-14 — Proyecto industrial especial fuera de catálogo (fabricación de
# grúa a medida). Sin efectos externos (registrar_interes_venta es local).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-14", "Proyecto especial fuera de catálogo (grúa a medida)", "SIM-14-PROYECTO")

t.cliente("Buenas, necesitamos una grúa viajera para una nave industrial nueva, de unas 10 toneladas de capacidad")
t.claudia(
    "¡Qué gusto! Fabricamos grúas viajeras a medida, así que sí podemos ayudarte con esto. Este tipo de proyecto "
    "no es algo de catálogo con precio fijo — depende del claro de la nave, la altura de trabajo, si es "
    "monorriel o birriel, y varias cosas más de ingeniería. Para cotizarlo bien necesito que un ingeniero de "
    "proyectos revise contigo los detalles técnicos. ¿Me compartes el claro (ancho) de la nave y para qué la vas a usar?"
)

t.cliente("El claro es de 18 metros, es para mover moldes de una planta de plasticos")
lead = run(tools.registrar_interes_venta(
    "SIM-14-PROYECTO",
    "Proyecto: grúa viajera a medida, 10 toneladas de capacidad, claro de nave 18m, uso: mover moldes en planta "
    "de plásticos. Requiere ingeniero de proyectos para especificación técnica y cotización.",
))
t.herramienta("registrar_interes_venta", {"interes": "..."}, lead)
t.claudia(
    "Perfecto, ya quedó registrado tu proyecto con esos datos. Un ingeniero de proyectos de Ambar Cargo te va a "
    "contactar para levantar el resto de las especificaciones (altura, tipo de riel, controles) y armarte una "
    "propuesta formal. ¿En qué horario es mejor que te busquen?"
)
t.nota(
    "BIEN: siguió la regla de 'para proyectos industriales especiales, califica la necesidad y ofrece conectar "
    "con un asesor humano en vez de improvisar' — no intentó cotizar un precio de catálogo para algo que "
    "claramente requiere ingeniería a medida. Capturó datos técnicos suficientes ANTES de escalar (claro, "
    "capacidad, uso) en vez de solo decir 'te conecto' sin contexto útil para el ingeniero."
)

t.cliente("En la mañana, después de las 10")
t.claudia("Anotado, te buscan en la mañana después de las 10. Gracias por la info, en breve tienes noticias.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
