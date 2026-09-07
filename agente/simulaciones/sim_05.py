# SIM-05 — Lead NUEVO, flujo completo hasta generar_oportunidad. REAL: crea
# una Opportunity de verdad en NetSuite y manda WhatsApp real a un vendedor
# sorteado al azar. Prueba también la escala dinámica por metros (cadena).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-05", "Lead nuevo, cotización formal completa (REAL)", "SIM-05-LEADNUEVO")

t.cliente("Buenas, necesito cadena grado 80 de 1/2 pulgada, como 1500 metros para un proyecto nuevo")
res = tools.consultar_catalogo("cadena grado 80 1/2", telefono="SIM-05-LEADNUEVO", cantidad=1500)
t.herramienta("consultar_catalogo", {"consulta": "cadena grado 80 1/2", "cantidad": 1500}, res)
top = res["resultados"][0]
t.claudia(f"Para 1500 metros de {top['nombre']} el precio que te queda es ${top['precio']:,.2f} por metro, con existencia disponible. ¿Te la agrego al pedido?")
t.nota(
    f"Verificar escala: 1500m cae en el rango 1001-2000 = Escala 3 (ver RANGOS_METRO en tools.py). "
    f"escala_aplicada devuelta = {res['resultados'][0]['escala_aplicada']} — "
    + ("CORRECTO" if res['resultados'][0]['escala_aplicada'] == 'Escala 3' else "*** INCONSISTENCIA ***")
)

t.cliente("Sí, agrégala. Quiero cotización formal por escrito porque es para licitación")
pedido = run(tools.agregar_al_pedido("SIM-05-LEADNUEVO", top["codigo"], 1500))
t.herramienta("agregar_al_pedido", {"codigo": top["codigo"], "cantidad": 1500}, pedido)
t.claudia("Perfecto, para generarte la cotización formal necesito confirmar: ¿ya has comprado con nosotros antes o serías cliente nuevo?")

t.cliente("Somos nuevos, nunca hemos comprado ahí")
verif = tools.verificar_cliente_existente(nombre="Constructora Altiva del Bajio")
t.herramienta("verificar_cliente_existente (confirmación, no encontrado esperado)", {}, verif)
t.claudia("Entendido, con gusto te doy de alta como cliente nuevo. Para generar la cotización formal necesito: tu nombre completo, el de tu empresa, correo y RFC.")

t.cliente("Ing. Roberto Salcido Peña, empresa Constructora Altiva del Bajío, correo r.salcido@altivadelbajio.com.mx, RFC CAB120517XY3")
datos = run(tools.registrar_datos_cliente(
    "SIM-05-LEADNUEVO", nombre_completo="Roberto Salcido Peña",
    empresa="Constructora Altiva del Bajío", correo="r.salcido@altivadelbajio.com.mx", rfc="CAB120517XY3",
))
t.herramienta("registrar_datos_cliente", {}, datos)
t.claudia("Gracias Roberto, ya quedaron tus datos. Dame un momento y te genero la cotización formal.")

opp = run(tools.generar_oportunidad("SIM-05-LEADNUEVO"))
t.herramienta("generar_oportunidad", {}, opp)
if opp.get("ok"):
    t.claudia(
        f"Listo Roberto, ya quedó generada tu cotización formal por ${opp['total']:,.2f} — un asesor de "
        f"Ambar Cargo se va a poner en contacto contigo en breve para darle seguimiento. ¡Gracias por confiar en nosotros!"
    )
else:
    t.claudia("Tuvimos un problema técnico al generar tu cotización. No te preocupes, un asesor se va a poner en contacto directamente para dártela sin que tengas que esperar más.")
t.nota(f"REAL: {'Opportunity creada en NetSuite: #' + str(opp.get('opportunity_id')) if opp.get('ok') else 'FALLÓ: ' + str(opp.get('error'))}. Vendedor asignado: {opp.get('vendedor_asignado')}.")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
