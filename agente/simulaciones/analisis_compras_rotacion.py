# Análisis ÚNICO (no recurrente) de COMPRAS a proveedores y ROTACIÓN de
# inventario en NetSuite — complementa simulaciones/analisis_ventas_netsuite.py
# (que fue del lado de ventas a clientes). Se corre una vez, se analiza, y
# las conclusiones se redactan a mano en APRENDIZAJE_CONOCIMIENTO.md.
import sys
import json
import sqlite3
sys.path.insert(0, "scripts")
from sync_netsuite_catalogo import _cargar_config, ejecutar_suiteql

cfg = _cargar_config()
SUBSIDIARY = 2

print("=== 1) COMPRAS a proveedores por GRUPO (marca) — todo el histórico ===")
q_compras_grupo = f"""
SELECT
    BUILTIN.DF(i.custitem_imr_grupo_articulos) AS grupo,
    COUNT(DISTINCT tl.transaction) AS num_compras,
    SUM(ABS(tl.quantity)) AS unidades_compradas
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type = 'PurchOrd'
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
GROUP BY BUILTIN.DF(i.custitem_imr_grupo_articulos)
ORDER BY num_compras DESC
"""
r_compras_grupo = ejecutar_suiteql(cfg, q_compras_grupo)
for x in r_compras_grupo[:30]:
    print(f"  {x.get('grupo') or '(sin grupo)':30s} | compras={x['num_compras']:>6} | unidades={x['unidades_compradas']}")

print("\n=== 2) TOP 30 artículos MÁS comprados a proveedores (por número de compras) ===")
q_compras_top = f"""
SELECT
    i.itemid AS codigo,
    i.displayname AS nombre,
    BUILTIN.DF(i.custitem_imr_grupo_articulos) AS grupo,
    COUNT(DISTINCT tl.transaction) AS num_compras,
    SUM(ABS(tl.quantity)) AS unidades_compradas
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type = 'PurchOrd'
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
GROUP BY i.itemid, i.displayname, BUILTIN.DF(i.custitem_imr_grupo_articulos)
ORDER BY num_compras DESC
FETCH FIRST 30 ROWS ONLY
"""
r_compras_top = ejecutar_suiteql(cfg, q_compras_top)
for x in r_compras_top:
    print(f"  {x['codigo']:16s} | {x['nombre'][:45]:45s} | {str(x.get('grupo') or '-'):15s} | compras={x['num_compras']:>5} | unidades={x['unidades_compradas']}")

print("\n=== 3) Ventas por artículo, ÚLTIMOS 12 MESES (para rotación) ===")
q_ventas_12m = f"""
SELECT
    i.itemid AS codigo,
    SUM(ABS(tl.quantity)) AS unidades_vendidas_12m
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type IN ('SalesOrd','CustInvc')
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
  AND t.trandate >= TO_DATE('2025-08-01','YYYY-MM-DD')
GROUP BY i.itemid
"""
r_ventas_12m = ejecutar_suiteql(cfg, q_ventas_12m)
print(f"  {len(r_ventas_12m)} artículos distintos con venta en los últimos 12 meses")

# Guarda todo crudo
salida = {
    "compras_por_grupo": r_compras_grupo,
    "compras_top_items": r_compras_top,
    "ventas_12m_por_item": r_ventas_12m,
}
with open("simulaciones/_analisis_compras_rotacion_resultado.json", "w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=2)
print("\nResultado crudo (compras + ventas 12m) guardado en simulaciones/_analisis_compras_rotacion_resultado.json")

print("\n=== 4) ROTACIÓN: cruzando ventas 12m contra existencia ACTUAL (netsuite_sync.db) ===")
ventas_por_codigo = {x["codigo"]: float(x["unidades_vendidas_12m"] or 0) for x in r_ventas_12m}

con = sqlite3.connect("netsuite_sync.db")
con.row_factory = sqlite3.Row
filas = con.execute("SELECT codigo, nombre, existencia FROM articulos WHERE existencia > 0").fetchall()
con.close()

rotacion = []
for f in filas:
    venta_12m = ventas_por_codigo.get(f["codigo"], 0.0)
    existencia = f["existencia"] or 0.0
    if venta_12m > 0:
        dias_inventario = round(existencia / (venta_12m / 365), 1)
    else:
        dias_inventario = None  # sin ninguna venta en 12 meses = no calculable, va a "sin rotacion"
    rotacion.append({
        "codigo": f["codigo"], "nombre": f["nombre"], "existencia": existencia,
        "venta_12m": venta_12m, "dias_inventario": dias_inventario,
    })

con_movimiento = [r for r in rotacion if r["dias_inventario"] is not None]
sin_movimiento = [r for r in rotacion if r["dias_inventario"] is None]

con_movimiento.sort(key=lambda r: r["dias_inventario"])
print(f"\n  TOP 20 ROTACIÓN MÁS RÁPIDA (menos días de inventario a la mano, con venta real en 12m):")
for r in con_movimiento[:20]:
    print(f"    {r['codigo']:16s} | {r['nombre'][:40]:40s} | existencia={r['existencia']:>8.1f} | venta_12m={r['venta_12m']:>10.1f} | dias_inv={r['dias_inventario']:>7.1f}")

con_movimiento.sort(key=lambda r: -r["dias_inventario"])
print(f"\n  TOP 20 ROTACIÓN MÁS LENTA (con venta real en 12m, pero mucho inventario relativo):")
for r in con_movimiento[:20]:
    print(f"    {r['codigo']:16s} | {r['nombre'][:40]:40s} | existencia={r['existencia']:>8.1f} | venta_12m={r['venta_12m']:>10.1f} | dias_inv={r['dias_inventario']:>7.1f}")

sin_movimiento.sort(key=lambda r: -r["existencia"])
print(f"\n  TOP 20 SIN NINGUNA VENTA EN 12 MESES pero CON existencia (candidatos a inventario muerto), de {len(sin_movimiento)} totales:")
for r in sin_movimiento[:20]:
    print(f"    {r['codigo']:16s} | {r['nombre'][:45]:45s} | existencia={r['existencia']:>8.1f}")

salida["rotacion_completa"] = rotacion
with open("simulaciones/_analisis_compras_rotacion_resultado.json", "w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=2)
print("\nResultado completo (incluye rotación) actualizado en simulaciones/_analisis_compras_rotacion_resultado.json")
