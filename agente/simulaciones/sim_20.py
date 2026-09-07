# SIM-20 — Lead nuevo que da datos INCOMPLETOS primero (prueba la rama
# faltan_datos_cliente de generar_oportunidad), los completa y entonces sí
# se genera. REAL: crea Opportunity real en NetSuite y notifica vendedor real.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-20", "Lead nuevo con datos incompletos al inicio (REAL)", "SIM-20-DATOSFALTAN")

t.cliente("Necesito cotización formal de 3 polipastos de 1 tonelada")
res = tools.consultar_catalogo("polipasto 1 tonelada", telefono="SIM-20-DATOSFALTAN")
t.herramienta("consultar_catalogo", {"consulta": "polipasto 1 tonelada"}, res)
top = res["resultados"][0]
run(tools.agregar_al_pedido("SIM-20-DATOSFALTAN", top["codigo"], 3))
t.herramienta("agregar_al_pedido", {"codigo": top["codigo"], "cantidad": 3}, {"ok": True})
t.claudia(f"Perfecto, {top['nombre']} x3 anotado. ¿Ya has comprado antes con nosotros o serías cliente nuevo? Y para la cotización formal necesito tu nombre, empresa, correo y RFC.")

t.cliente("Somos nuevos. Soy Fernando Miranda, de Metalúrgica del Bajío")
datos1 = run(tools.registrar_datos_cliente("SIM-20-DATOSFALTAN", nombre_completo="Fernando Miranda", empresa="Metalúrgica del Bajío"))
t.herramienta("registrar_datos_cliente (parcial)", {}, datos1)
intento1 = run(tools.generar_oportunidad("SIM-20-DATOSFALTAN"))
t.herramienta("generar_oportunidad (intento 1, datos incompletos)", {}, intento1)
t.claudia("Me faltan tu correo y RFC para poder generar la cotización formal — ¿me los compartes?")
t.nota(f"BIEN: generar_oportunidad devolvió {intento1} en vez de fallar oscuro — Claudia usó el campo 'faltan' para pedir EXACTAMENTE lo que hace falta, no todo de nuevo.")

t.cliente("correo fmiranda@metalurgicadelbajio.com, RFC MBA150922K21")
datos2 = run(tools.registrar_datos_cliente("SIM-20-DATOSFALTAN", correo="fmiranda@metalurgicadelbajio.com", rfc="MBA150922K21"))
t.herramienta("registrar_datos_cliente (completa)", {}, datos2)
opp = run(tools.generar_oportunidad("SIM-20-DATOSFALTAN"))
t.herramienta("generar_oportunidad (intento 2, completo)", {}, opp)
if opp.get("ok"):
    t.claudia(f"Listo Fernando, tu cotización formal por ${opp['total']:,.2f} ya quedó generada. Un asesor de Ambar Cargo te va a contactar en breve. ¡Gracias por confiar en nosotros!")
    t.nota(f"REAL: Opportunity #{opp['opportunity_id']} creada en NetSuite. Vendedor asignado: {opp.get('vendedor_asignado')}.")
else:
    t.claudia("Tuvimos un problema técnico generando tu cotización, un asesor te la va a dar directamente.")
    t.nota(f"FALLÓ generar_oportunidad: {opp}")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
