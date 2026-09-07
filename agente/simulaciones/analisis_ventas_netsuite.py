# Análisis ÚNICO (no recurrente) de ventas reales en NetSuite, para entender
# qué compran más los clientes de Ambar Cargo y aplicar ese aprendizaje al
# system_prompt de Claudia IA (mostrar antes las marcas/líneas más pedidas,
# priorizar mejor). Esto NO se vuelve un sync programado — se corre una vez,
# se analiza, y las conclusiones se redactan a mano en config/prompts.yaml.
import sys
import json
sys.path.insert(0, "scripts")
from sync_netsuite_catalogo import _cargar_config, ejecutar_suiteql

cfg = _cargar_config()
SUBSIDIARY = 2

print("=== 1) Ventas por GRUPO (marca) ===")
q_grupo = f"""
SELECT
    BUILTIN.DF(i.custitem_imr_grupo_articulos) AS grupo,
    COUNT(DISTINCT tl.transaction) AS num_transacciones,
    SUM(ABS(tl.quantity)) AS unidades
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type IN ('SalesOrd','CustInvc')
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
GROUP BY BUILTIN.DF(i.custitem_imr_grupo_articulos)
ORDER BY num_transacciones DESC
"""
r_grupo = ejecutar_suiteql(cfg, q_grupo)
for x in r_grupo[:30]:
    print(f"  {x.get('grupo') or '(sin grupo)':30s} | transacciones={x['num_transacciones']:>6} | unidades={x['unidades']}")

print("\n=== 2) Ventas por LÍNEA (categoría) ===")
q_linea = f"""
SELECT
    BUILTIN.DF(i.custitem_imr_linea_articulos) AS linea,
    COUNT(DISTINCT tl.transaction) AS num_transacciones,
    SUM(ABS(tl.quantity)) AS unidades
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type IN ('SalesOrd','CustInvc')
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
GROUP BY BUILTIN.DF(i.custitem_imr_linea_articulos)
ORDER BY num_transacciones DESC
"""
r_linea = ejecutar_suiteql(cfg, q_linea)
for x in r_linea[:30]:
    print(f"  {x.get('linea') or '(sin linea)':35s} | transacciones={x['num_transacciones']:>6} | unidades={x['unidades']}")

print("\n=== 3) TOP 30 artículos más vendidos (por número de transacciones distintas) ===")
q_top_items = f"""
SELECT
    i.itemid AS codigo,
    i.displayname AS nombre,
    BUILTIN.DF(i.custitem_imr_grupo_articulos) AS grupo,
    COUNT(DISTINCT tl.transaction) AS num_transacciones,
    SUM(ABS(tl.quantity)) AS unidades
FROM transactionline tl
JOIN transaction t ON t.id = tl.transaction
JOIN item i ON i.id = tl.item
WHERE t.type IN ('SalesOrd','CustInvc')
  AND t.subsidiary = {SUBSIDIARY}
  AND tl.mainline = 'F'
  AND tl.item IS NOT NULL
GROUP BY i.itemid, i.displayname, BUILTIN.DF(i.custitem_imr_grupo_articulos)
ORDER BY num_transacciones DESC
FETCH FIRST 30 ROWS ONLY
"""
r_top = ejecutar_suiteql(cfg, q_top_items)
for x in r_top:
    print(f"  {x['codigo']:16s} | {x['nombre'][:45]:45s} | {str(x.get('grupo') or '-'):15s} | transacciones={x['num_transacciones']:>5} | unidades={x['unidades']}")

# Guarda todo crudo por si se necesita revisar después
salida = {"por_grupo": r_grupo, "por_linea": r_linea, "top_items": r_top}
with open("simulaciones/_analisis_ventas_resultado.json", "w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=2)
print("\nResultado crudo guardado en simulaciones/_analisis_ventas_resultado.json")
