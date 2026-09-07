# SIM-13 — Cliente dice ser cliente existente pero da el nombre mal/no
# coincide; se corrige y en el segundo intento sí se encuentra. Prueba la
# regla de "nunca adivinar, pedir confirmar o corregir". Termina en
# notificación REAL al vendedor (mismo patrón que SIM-04).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from simulaciones._harness import TranscriptWriter, run
from agent import tools

t = TranscriptWriter("SIM-13", "Cliente existente con nombre mal dado (REAL al final)", "SIM-13-NOMBREMAL")

t.cliente("Hola quiero cotizacion formal de unos grilletes, ya somos clientes")
t.claudia("Claro, para conectarte con tu asesor dime el nombre o razón social exacta con la que están registrados")

t.cliente("Somos Tubos Piramide, creo que asi esta")
verif1 = tools.verificar_cliente_existente(nombre="Tubos Piramide")
t.herramienta("verificar_cliente_existente", {"nombre": "Tubos Piramide"}, verif1)
t.nota(
    f"'Tubos Piramide' (sin razón social) NO hizo match exacto contra 'TUBOS PIRAMIDE S.A. DE C.V.' — "
    f"encontrado={verif1['encontrado']}. Esto es justo el comportamiento esperado: normalizar mayúsculas/acentos "
    f"SÍ, pero no es búsqueda parcial, así que 'Tubos Piramide' solo (sin razón social) no coincide."
)
t.claudia(
    "No te encuentro exactamente con ese nombre en el sistema — ¿me das la razón social completa tal como "
    "aparece en tus facturas (con el S.A. de C.V. o similar), o si prefieres me pasas el RFC y busco con eso?"
)

t.cliente("Ah ok, es Tubos Piramide S.A. de C.V.")
verif2 = tools.verificar_cliente_existente(nombre="Tubos Piramide S.A. de C.V.")
t.herramienta("verificar_cliente_existente", {"nombre": "Tubos Piramide S.A. de C.V."}, verif2)
t.claudia("Perfecto, ahora sí te ubiqué. ¿Qué grilletes necesitas y cuántos, para dejárselo anotado a tu asesora?")

t.cliente("10 grilletes crosby de 1/2 pulgada")
res = tools.consultar_catalogo("grillete crosby 1/2", telefono="SIM-13-NOMBREMAL")
t.herramienta("consultar_catalogo", {"consulta": "grillete crosby 1/2"}, res)
if res["resultados"]:
    art = res["resultados"][0]
    run(tools.agregar_al_pedido("SIM-13-NOMBREMAL", art["codigo"], 10))
    t.herramienta("agregar_al_pedido", {"codigo": art["codigo"], "cantidad": 10}, {"ok": True})

notif = run(tools.notificar_vendedor_cliente_existente(
    "SIM-13-NOMBREMAL", salesrep_id=verif2["salesrep_id"],
    cliente_netsuite_id=verif2["cliente"]["netsuite_id"], cliente_nombre=verif2["cliente"]["nombre"],
))
t.herramienta("notificar_vendedor_cliente_existente", {}, notif)
t.claudia(notif["mensaje_cliente"])
t.nota(f"REAL: notificado={notif.get('notificado')} a {notif.get('vendedor_nombre')} (misma vendedora de SIM-04, mismo número sin sesión abierta — se espera que vuelva a fallar con 63016, confirmando que NO fue un evento aislado).")

ruta = t.guardar()
t.imprimir()
print("\n---\nGUARDADO EN:", ruta)
