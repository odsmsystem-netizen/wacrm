# Aprendizaje de conocimiento — Claudia (Ambar Cargo)

Documento vivo con lo aprendido al simular conversaciones reales con Claudia
(20 escenarios, cubriendo casos normales, difíciles y límite). El objetivo:
detectar huecos de comportamiento y de infraestructura, corregirlos en
`config/prompts.yaml` / el código, y dejar registro de por qué se decidió
cada ajuste.

Metodología: en estas simulaciones "Claudia" la interpreta el asistente
(Claude Code) siguiendo al pie de la letra `config/prompts.yaml` — NO se usó
la API de Anthropic (para no gastar saldo). Las HERRAMIENTAS sí corren
reales contra la base local (`netsuite_sync.db`, `agentkit.db`), y cuando el
escenario llega a cotización formal, también corren reales contra NetSuite
y Twilio (por instrucción explícita del usuario). Transcripts completos en
`simulaciones/SIM-XX.txt`.

---

## Hallazgos — Ronda 1 (escenarios 1-5)

### 🔴 Crítico — Notificación a vendedor puede fallar en silencio (infraestructura, no prompt)
**Evidencia:** SIM-04. WhatsApp a la vendedora asignada falló con Twilio 63016
("fuera de la ventana de 24h de mensajes libres, requiere plantilla
aprobada"). Su número no es el compartido de pruebas y nunca le ha escrito
a Claudia primero, así que no hay sesión de WhatsApp abierta.
**Por qué importa:** en WhatsApp Business API, una empresa NO puede iniciar
una conversación libremente — necesita que el usuario le haya escrito en las
últimas 24h, o usar una plantilla pre-aprobada. Cualquier vendedor real que
no le escriba primero al número de Twilio se va a quedar sin notificaciones,
y el cliente nunca se entera porque `mensaje_cliente` es el mismo texto
("en breve será atendido") sin importar si `notificado` fue `true` o `false`.
**Acción recomendada (pendiente de decisión del usuario, no autoaplicada):**
1. Antes de producción, que cada vendedor real le mande un mensaje a Claudia
   (o "join <código>" si sigue en sandbox) para abrir la ventana de sesión.
2. Evaluar una plantilla de WhatsApp pre-aprobada para notificaciones a
   vendedor (no sujeta a la ventana de 24h) — es la solución robusta a largo
   plazo, sandbox no la soporta, requiere número de producción de Twilio/Meta.
3. Que el panel de administración marque visiblemente cuando un vendedor
   lleva notificaciones fallidas repetidas (ya existe `tasa_entrega_pct` por
   vendedor en Indicadores — falta una alerta proactiva, hoy hay que entrar
   a revisarlo manualmente).

### Promesas sin acción registrada
**Evidencia:** SIM-01. Ante "esa ficha técnica no la tengo, te conecto con
un asesor", Claudia no ejecutó ninguna herramienta (`registrar_interes_venta`
u otra) — la promesa solo se concretó porque el cliente volvió a escribir.
**Riesgo:** si el cliente no insiste, la promesa de "te conecto" no deja
ningún rastro y nadie le da seguimiento.
**Fix aplicado:** ver sección de cambios a `prompts.yaml` más abajo.

### Sin regla explícita sobre descuentos/rebajas
**Evidencia:** SIM-02. Comportamiento observado fue razonable (no autorizar
descuento por su cuenta, canalizar a ventas) pero es inferido, no
garantizado por una instrucción del prompt — con el modelo real podría
variar.
**Fix aplicado:** ver sección de cambios a `prompts.yaml`.

### Promesa de seguimiento proactivo que el sistema no puede cumplir
**Evidencia:** SIM-03. Claudia le dijo al cliente molesto "en cuanto tenga
novedades te aviso yo misma" — no existe ningún mecanismo en el sistema
actual para que Claudia reciba una actualización de un ticket y le escriba
proactivamente al cliente después (el bot solo responde a mensajes
entrantes, no envía mensajes salientes espontáneos).
**Fix aplicado:** ver sección de cambios a `prompts.yaml`.

### Validado correctamente
- Escala dinámica por metros: 1500m de cadena → Escala 3, correcto (SIM-05).
- Flujo cliente existente → NO genera registro en NetSuite, canaliza directo
  (SIM-04), tal como está diseñado.
- Flujo lead nuevo → Opportunity real creada sin problema: **#251171**
  (SIM-05), vendedor sorteado y notificado con éxito (número con sesión
  activa).
- Regla de "nunca inventar ficha técnica que no tengas" — se respetó (SIM-01).
- Empatía genuina con cliente molesto sin sonar a script (SIM-03).
- No prometer/negar reembolsos de tajado, delega a quien tiene autoridad (SIM-03).

---

### Cambios aplicados a `config/prompts.yaml` tras la Ronda 1
Se agregó la sección **"Promesas, descuentos y seguimiento"**: (1) toda
promesa de "te conecto con alguien" debe respaldarse de inmediato con
`registrar_interes_venta` o `crear_ticket_soporte`; (2) ante petición de
descuento, nunca autorizar/inventar precio — canalizar a ventas con
`registrar_interes_venta`; (3) nunca prometer que Claudia avisará
proactivamente después — el bot no tiene forma de escribir por iniciativa
propia.

---

## Hallazgos — Ronda 2 (escenarios 6-10)

### Hueco de esquema: `agendar_cita` no guardaba la dirección
**Evidencia:** SIM-06. El cliente dio la dirección de la visita, Claudia dijo
"ya quedó anotada" pero `agendar_cita` no tenía parámetro `direccion` — no
existía forma de guardarla, con o sin instrucción de prompt.
**Fix aplicado (código, no prompt):** se agregó `direccion` a `Cita`
(`agent/memory.py`), a `crear_cita`/`agendar_cita`
(`agent/memory.py`/`agent/tools.py`) y al `input_schema` de `agendar_cita`
en `agent/brain.py`, con migración para bases ya existentes. Reverificado:
la dirección ahora sí persiste (ver transcript de verificación).

### 🟠 Sustitución silenciosa de capacidad/medida — riesgo de seguridad
**Evidencia:** SIM-10. Pidieron "eslingas de 3 toneladas"; el catálogo solo
tenía de 4 toneladas y se ofreció sin avisar la diferencia.
**Por qué importa:** en equipo de izaje, la capacidad de carga es una
cuestión de seguridad — no avisar que se está ofreciendo algo de mayor/menor
capacidad de la pedida es un riesgo real, no solo un tema de servicio.
**Fix aplicado:** se agregó regla explícita en `prompts.yaml` (sección
"Precios y catálogo") para señalar siempre cualquier diferencia de
medida/capacidad entre lo pedido y lo ofrecido.

### Validado correctamente
- Horario fuera de servicio: usa el mensaje exacto configurado, sin
  improvisar (SIM-07).
- Ocultamiento de importado/nacional resiste presión directa e incluso una
  justificación razonable del cliente ("necesito que sea de buena calidad")
  sin mentir ni ceder (SIM-08).
- **Regla de "respaldar promesas con herramienta" verificada en vivo**:
  SIM-09 repite el escenario de descuento de SIM-02 y confirma que, con la
  regla nueva, `registrar_interes_venta` se ejecuta en el mismo turno sin
  esperar a que el cliente insista — el ciclo de aprendizaje funciona.
- Pedido con múltiples artículos distintos: cada uno se cotiza por separado
  a su propia escala/precio correctamente, total sumado bien (SIM-10).

### Pregunta abierta para el negocio (no autoaplicada)
¿Debería Claudia poder consultar disponibilidad básica aun fuera de
horario (aunque no pueda cerrar una venta), o el corte tajante actual es
la política deseada? Es una decisión de negocio, se deja pendiente.

---

## Hallazgos — Ronda 3 (escenarios 11-15)

### 🔴 Falla real de WhatsApp confirmada como recurrente (no aislada)
**Evidencia:** SIM-13 repite el envío real a la misma vendedora de SIM-04
(Wendy) — vuelve a fallar con Twilio 63016. Confirma que el problema es
estructural (número sin sesión abierta), no un evento aislado.

### Error real de fidelidad de datos (no de prompt)
**Evidencia:** SIM-12. Al ofrecer un polipasto, se dijo "con existencia
disponible" cuando el resultado de la propia herramienta marcaba
`disponible: False, existencia: 0.0` — y además se ofreció un equipo de
7.5 toneladas cuando pidieron 2, sin avisar la diferencia (la regla de
capacidad agregada tras la Ronda 2 no se aplicó en ese turno). Se documenta
tal cual ocurrió, sin corregir el transcript, porque es evidencia real de
que incluso con reglas explícitas puede haber deslices bajo complejidad.
**Fix aplicado:** se agregó una regla explícita para verificar el campo
`disponible` exacto antes de afirmar existencia (ver cambios a
`prompts.yaml`). No elimina el riesgo por completo — es un recordatorio de
que estos casos de alto impacto (disponibilidad, capacidad) conviene
revisarlos periódicamente con muestreo real, no solo confiar en el prompt.

### Validado correctamente
- Nombre de cliente que no matchea exacto → pide confirmar/corregir en vez
  de adivinar (regla "nunca adivinar" del flujo de cliente existente),
  funciona en la práctica (SIM-13).
- Cliente informal/sin puntuación: se entendió igual, y ante falta de un
  dato crítico (medida del cable) pidió evidencia (foto/placa) en vez de
  adivinar — coherente con la regla de capacidad/medida (SIM-11).
- Cambios de tema abruptos: no se perdió el hilo del pedido en curso ni se
  inventó información no disponible (sucursales) (SIM-12).
- Proyecto industrial especial (grúa a medida): capturó specs técnicas
  relevantes antes de escalar a un ingeniero, en vez de solo decir "te
  conecto" sin contexto útil (SIM-14).
- Continuidad de carrito entre "sesiones": el pedido persiste correctamente
  por teléfono en la base real, no solo en memoria de la conversación activa
  (SIM-15).

---

## Hallazgos — Ronda 4 (escenarios 16-20)

### 🔴 Hallazgo de más alto impacto de todo el ejercicio: coincidencia numérica ingenua en la búsqueda
**Evidencia:** SIM-20 (y ya se había visto en SIM-10/SIM-12). Al pedir "3
polipastos de 1 tonelada", la búsqueda regresó primero un polipasto de
**10 toneladas** ($168,458 en vez de $7,766 — una diferencia de más de 20x
en precio y de 10x en capacidad de carga). La causa: el algoritmo de
relevancia ordenaba por disponibilidad + longitud del nombre, sin verificar
que el número que pidió el cliente apareciera como número exacto (no como
substring de un número más grande — "1" es substring de "10").
**Por qué es el hallazgo más importante:** es el único de los 20 que
combina (a) alto impacto económico real, (b) riesgo de seguridad (capacidad
de equipo de izaje), y (c) es un bug determinista y reproducible del
código — no depende de que el modelo "se acuerde" de seguir una regla del
prompt en cada turno, como los demás hallazgos de tono/flujo.
**Fix aplicado (código, `agent/tools.py: consultar_catalogo`):**
1. `_numeros_enteros_busqueda` + `_tiene_numero_exacto`: ahora se exige que
   los números enteros mencionados por el cliente aparezcan en el nombre
   como número standalone (ni pegados a otro dígito ni a un punto decimal)
   antes de preferir ese resultado — "1" ya no hace match falso dentro de
   "10" ni de "3.2".
2. `termino_principal`: además, se prioriza que el nombre del artículo
   EMPIECE con la palabra principal buscada, para que accesorios como
   "INVERSOR PARA POLIPASTO DE 2 TON" no le ganen al polipasto real solo
   por tener un nombre más corto.
**Reverificado:** "polipasto 1 tonelada" y "polipasto 2 toneladas" ahora
traen primero el equipo de la capacidad exacta pedida.
**Limitación conocida, no resuelta:** un dígito de OTRA unidad dentro del
mismo nombre (ej. "3 MTS" de elevación) puede seguir generando falsos
positivos si coincide con el número de toneladas buscado y no existe un
producto de esa capacidad exacta (ej. "polipasto 3 toneladas" con un
catálogo que no tiene ningún "3 TON" real). Solucionarlo del todo requeriría
asociar cada número a su unidad específica dentro del nombre — se deja
pendiente por rendimientos decrecientes frente al esfuerzo, documentado
aquí para quien continúe este trabajo.

### Gap real de búsqueda: sinónimos naturales vs. abreviaturas del catálogo
**Evidencia:** SIM-20 (bloqueante hasta el fix) y confirmado por separado:
"tonelada(s)" y "pulgada(s)" — las formas MÁS naturales en que un cliente
mexicano describe capacidad y medida — daban CERO resultados, porque el
catálogo usa "TON" y el símbolo `"`.
**Fix aplicado (código):** `_SINONIMOS_BUSQUEDA` en `agent/tools.py` mapea
tonelada(s)/tons → ton, y quita pulgada(s)/pulg de las palabras exigidas
(el símbolo no se puede mapear de forma confiable vía texto). Reverificado:
las tres consultas que antes daban 0 resultados ahora traen resultados
correctos.

### Validado correctamente
- Soporte post-venta con seguimiento: no inventó un estatus de ticket que
  no existe en el modelo de datos — fue honesta sobre el límite real de
  información disponible (SIM-16).
- Cancelación de cita por folio: flujo completo sin fricción (SIM-17).
- Regla de idioma ("SIEMPRE en español") se sostiene aunque el cliente
  escriba en inglés o mezclado (SIM-18).
- Ante una capacidad que no existe en catálogo (Grado 100), no fingió
  tenerla ni ofreció Grado 80 diciendo que es equivalente — dejó la
  decisión al cliente (SIM-18).
- Petición de un PDF (capacidad que el sistema no tiene): no lo inventó,
  ofreció la alternativa real disponible (SIM-19).
- Flujo de datos incompletos en `generar_oportunidad`: usa el campo
  `faltan` para pedir exactamente lo que hace falta, sin reiniciar todo el
  interrogatorio (SIM-20). Segunda Opportunity real creada sin problema:
  **#251172**.

---

## Resumen ejecutivo — qué se corrigió y qué queda pendiente de decisión

### Corregido en código (`agent/tools.py`, `agent/memory.py`, `agent/brain.py`)
1. Búsqueda de catálogo: sinónimos tonelada/pulgada que antes daban 0 resultados.
2. Búsqueda de catálogo: coincidencia numérica exacta (ya no confunde 1 con 10, ni 2 con 3.2).
3. Búsqueda de catálogo: prioriza el producto real sobre accesorios que solo lo mencionan.
4. `agendar_cita` ahora guarda la dirección de la visita (antes no existía el campo).

### Corregido en comportamiento (`config/prompts.yaml`)
1. Toda promesa de "te conecto" se respalda con una herramienta real de inmediato.
2. Regla explícita para peticiones de descuento (no autorizar, canalizar a ventas).
3. Prohibido prometer seguimiento proactivo que el sistema no puede cumplir.
4. Nunca ofrecer una medida/capacidad distinta a la pedida sin avisarlo (seguridad).
5. Verificar el campo `disponible` exacto antes de afirmar existencia.

### 🔴 Pendiente de decisión del usuario — no autoaplicado (infraestructura, no código de la app)
**Falla de entrega de WhatsApp a vendedores fuera de la ventana de 24h de
sesión (Twilio 63016)**, confirmada dos veces en pruebas reales. Antes de
producción:
- Que cada vendedor real le escriba primero a Claudia (o "join" en sandbox)
  para abrir sesión, y/o
- Evaluar una plantilla de WhatsApp pre-aprobada para notificación a
  vendedor (no sujeta a la ventana de 24h — requiere número de producción).
- Considerar una alerta visible en el panel de administración cuando un
  vendedor acumula notificaciones fallidas (hoy solo se ve entrando a
  Indicadores manualmente).

### Otras preguntas abiertas de negocio (no autoaplicadas)
- ¿Debería Claudia dar disponibilidad básica aun fuera de horario?
- ¿Vale la pena registrar la dirección de una visita como campo estructurado
  en NetSuite también, no solo en la base local?

### Evidencia
Transcripts completos de las 20 simulaciones en `simulaciones/SIM-01.txt`
… `simulaciones/SIM-20.txt`. Dos Opportunities reales de prueba quedaron
creadas en NetSuite: **#251171** y **#251172** (revisar/cerrar si no se
quieren conservar).

---

## Prueba en vivo con la API real (post-simulaciones)

Después de las 20 simulaciones (donde "Claudia" la interpretaba el
asistente, sin tocar la API), se hizo una prueba real completa:
WhatsApp real → túnel público (Cloudflare) → webhook real → **Claude
real (`claude-sonnet-4-6`)** → NetSuite/Twilio reales. Conversación real
de varios turnos sobre cable de acero inoxidable 3/4", 2000 metros.

### 🔴 Hallazgo con el modelo real: sustitución silenciosa de un dato específico al buscar
**Evidencia:** el cliente pidió cable **inoxidable**; el modelo real buscó
`consultar_catalogo(consulta='cable de acero galvanizado 3/4')` —
sustituyó "inoxidable" por "galvanizado" (otro material) sin decirlo. Esa
búsqueda (mal planteada) dio 0 resultados, y con eso respondió "no
contamos con 3/4" en inoxidable actualmente" — **falso**: sí existe
(`CABLE 6 X 19 ACERO INOXIDABLE 3/4 PULG. T316`, verificado contra la base
real). Esto viola una regla que YA estaba explícita en el prompt ("usa las
palabras casi textuales del cliente, no las traduzcas a otra jerga antes
de buscar").
**Por qué es el hallazgo más importante de toda la sesión:** es la única
evidencia que viene del modelo real de producción, no de mi simulación —
y muestra que una regla explícita, ya escrita en el prompt, puede
romperse igual en un caso real. Ninguna de las 20 simulaciones (donde el
"redactor" era más disciplinado seleccionando búsquedas) expuso este
patrón exacto — confirma el valor de complementar las pruebas internas
con pruebas reales antes de producción, tal como se hizo aquí.
**Recuperación parcial:** en el reintento, el modelo buscó `'cable acero
3/4'` (quitó la palabra en vez de sustituirla) y esta vez respondió la
verdad (sí existe, sin existencia disponible) — se autocorrigió, pero el
daño ya estaba hecho en el primer mensaje que leyó el cliente.
**Efecto secundario real:** el error se propagó hasta el registro
permanente del lead — `registrar_interes_venta` guardó "cable de acero
**galvanizado** 3/4"" en la base real (revisar y corregir manualmente el
lead de "Oscar Sanchez" en el panel de administración — el vendedor que
le dé seguimiento necesita saber que en realidad pedía inoxidable).
**Fix aplicado (prompt):** se agregó una regla "CRÍTICO" explícita y más
enfática: nunca sustituir un dato específico (material/medida/capacidad)
por otro al construir la búsqueda; si la primera búsqueda no encuentra
nada, reintentar quitando palabras, no cambiándolas. No hay garantía de
que esto elimine el riesgo al 100% — es una razón más para hacer
verificaciones puntuales con la API real periódicamente, no solo confiar
en el prompt.

### Validado correctamente con el modelo real
- Presentación con el nombre nuevo ("Claudia IA") en el primer mensaje.
- Pide medida/construcción/metros antes de dar precio (venta consultiva).
- Ante "te comunico con un asesor", pidió el nombre y SÍ ejecutó
  `registrar_interes_venta` de verdad antes de confirmarlo al cliente —
  la regla de "respaldar promesas con herramienta" (agregada tras la
  Ronda 1) se sostuvo también con el modelo real, no solo en mi simulación.
- Corrigió un typo del nombre del cliente ("Oscsr sanchez" → "Oscar
  Sanchez") de forma natural al registrar el lead.

---

## Revisión profunda de conversaciones reales (post-prueba en vivo)

Después de las pruebas en vivo, se hizo una revisión línea por línea de las
dos conversaciones reales completas (logs de debug, incluyendo los
tool_use/tool_result exactos que mandó y recibió el modelo — no solo el
texto final). Se encontraron 2 hallazgos nuevos, uno de ellos grave.

### 🔴 Grave — notificación duplicada real a un vendedor distinto
**Evidencia:** el cliente pidió conectar con un asesor por un polipasto →
`registrar_interes_venta` se ejecutó correctamente (lead_id=5, notificó a
Pablo Franco Castellanos). El cliente cambió de tema ("¿me cotizas un cable
de acero?") y el modelo, en esa misma respuesta, **volvió a llamar
`registrar_interes_venta` con LOS MISMOS datos del polipasto** (lead_id=6) —
notificando por WhatsApp REAL a **otra vendedora distinta** (Wendy) sobre
algo que ya tenía Pablo. Esto es spam real a un vendedor sin relación con el
caso, y genera confusión de quién es el dueño del lead.
**Por qué importa:** cada llamada a esta herramienta manda un WhatsApp de
verdad — un duplicado no es un error inofensivo, es contactar a una persona
real sin necesidad.
**Fix aplicado:** regla CRÍTICA en `prompts.yaml` — nunca repetir la llamada
para un interés ya registrado en la misma conversación, revisar el
historial antes de llamarla de nuevo.

### 🔴 Confirmado con datos reales — anclaje en la primera opción, sin mostrar alternativas
**Evidencia:** al pedir un polipasto de 3 ton, la primera búsqueda YA traía
en el resultado alternativas disponibles (Polimax 1, 2 y 5 TON, con
existencia) — pero Claudia solo mencionó la opción exacta de 3 TON (sin
stock) y no reveló las demás hasta que el cliente insistió dos veces
("¿no tienes algo en stock?", "¿alguna otra marca?"). Detectado primero por
el usuario, confirmado línea por línea contra los tool_result reales.
**Fix aplicado:** regla CRÍTICA en `prompts.yaml` — mostrar un panorama de
2-4 opciones desde la primera respuesta cuando la búsqueda trae varias
relevantes, para CUALQUIER artículo, no solo polipastos.

---

## Análisis de comportamiento de compra real (NetSuite, consulta única)

Por instrucción explícita: se generó una consulta SuiteQL de TODO el
histórico de ventas reales (`transactionline` + `transaction` + `item`,
subsidiaria Ambar Cargo) — **una sola vez**, no un sync recurrente — para
entender qué compran más los clientes y aplicar ese conocimiento al system
prompt. Script: `simulaciones/analisis_ventas_netsuite.py`. Resultado crudo
completo: `simulaciones/_analisis_ventas_resultado.json`.

### Hallazgo clave: la marca que Claudia ofrecía por defecto casi no se vende
**POLIMAX** (la marca que Claudia mencionaba primero para polipastos) tiene
**81 transacciones históricas** en todo el registro de NetSuite. En
comparación: **POLICRANE tiene 13,912** y **POLICHAIN 1,968** — 172x y 24x
más ventas reales respectivamente. Esto confirma con datos duros la causa
raíz de lo que el usuario notó: el orden en que la búsqueda regresa
resultados no refleja qué es lo que realmente compran los clientes.

### Otros patrones reales encontrados
- Lo que más se vende por mucho: **cable de acero y cadena** (línea CABLE:
  38,318 transacciones; CADENA: 8,801) y **accesorios pequeños** (línea
  ACCESORIOS: 39,692 transacciones — perros, guardacabos, casquillos,
  grilletes). Los equipos grandes (polipastos, grúas) son una fracción
  mucho más chica del volumen total de ventas.
- Marca dominante en cable/cadena: **WARRIOR** (35,071 transacciones, muy
  por delante de cualquier otra).
- Patrón de compra conjunta real: quien compra cable de acero casi siempre
  también necesita accesorios para el terminal (guardacabo/casquillo/perro)
  — visible en que esos artículos están entre los más vendidos junto con
  el cable mismo.

### Fix aplicado
Nueva sección en `prompts.yaml`: "Qué compran más los clientes" — contexto
de negocio (no regla rígida) para que Claudia no ancle su primera respuesta
en la marca que le salió primero en la búsqueda, considere POLICRANE/
POLICHAIN como las marcas reales de polipastos, y sugiera de forma natural
accesorios de terminal cuando venda cable. Se documentó explícitamente que
este análisis es de una fecha específica y no se actualiza solo — es
intuición de negocio, no un dato que deba repetirse al cliente como
estadística ni una fuente que se vuelva a consultar en automático.

---

## Análisis de compras a proveedores y rotación de inventario (NetSuite, consulta única)

Complemento del análisis de ventas anterior, ahora del lado de **compras**
(qué re-abastece más Ambar Cargo) y **rotación** (qué tan rápido se mueve
cada artículo real contra su existencia actual). Consulta única, no
recurrente. Script: `simulaciones/analisis_compras_rotacion.py`. Resultado
crudo completo (incluye la rotación calculada para cada artículo con
existencia): `simulaciones/_analisis_compras_rotacion_resultado.json`.

**Metodología de rotación:** para cada artículo con existencia > 0, se cruzó
la existencia actual (netsuite_sync.db) contra las unidades vendidas en los
últimos 12 meses (SuiteQL, `trandate >= 2025-08-01`), y se calculó
`días_inventario = existencia / (venta_12m / 365)` — cuántos días duraría el
stock actual al ritmo de venta real. Sin ninguna venta en 12 meses = no
calculable, se clasifica aparte como "sin movimiento".

### Compras por marca — confirma que POLIMAX es marginal también del lado de compras
POLIMAX: solo **7 compras / 253 unidades** en todo el histórico — la marca
menos comprada de todas, coherente con que también es la menos vendida (ver
sección anterior). WARRIOR domina compras en volumen (3,758,453 unidades,
aunque en solo 73 órdenes — se compra en rollos grandes de cable).
GENERICOS/CROSBY/VIKING tienen muchas compras pequeñas y frecuentes
(cientos de órdenes) — reabastecimiento constante de accesorios variados.
CONDUCTIX aparece muchísimo en el top de artículos más comprados
individualmente — sistemas de electrificación con muchas piezas chicas que
se reponen seguido.

### 🔴 Hallazgo operativo importante: inventario muerto real, con cifras altas
Artículos con **existencia alta pero CERO ventas en los últimos 12 meses**
(1,332 artículos en esa situación en total; los de mayor existencia):
- **CABLE RETENIDA 1/4" WARRIOR — 220,523 unidades** sin vender en 12 meses.
- CABLE RETENIDA 5/16" (70,880) y 3/8" (47,748) — mismo patrón.
- CABLE BOA 5/8"/1/2"/3/8" WARRIOR — 19,000 a 27,000 unidades cada uno sin
  movimiento, a pesar de que WARRIOR es la marca más vendida en general —
  sugiere que la construcción "BOA" específica dejó de tener demanda aunque
  la marca sí se vende bien en otras construcciones.
- CASQUILLO DE ALUMINIO (varias medidas) y PERRO GALV. (varias medidas) —
  9,000 a 27,000 unidades cada uno sin vender.
**Recomendación para el equipo de Ambar Cargo (no aplicado a Claudia — es
una decisión de negocio):** vale la pena revisar si conviene una promoción
o descuento dirigido para mover este inventario, o si son candidatos a
depurar del catálogo activo.

### Artículos de rotación MÁS RÁPIDA (riesgo de quiebre de stock)
Varias medidas de **cable de acero inoxidable** (1/4", 5/16", 1/8") y
accesorios chicos (guardacabos, ganchos, tensores) tienen **menos de 1.5
días de inventario** al ritmo de venta actual — se venden casi tan rápido
como se reponen. Ejemplo extremo: `NXA7191-003` (cable inoxidable 1/4")
tenía 0.5 unidades de existencia contra 33,648 vendidas en 12 meses. Estos
artículos son candidatos reales a quedarse sin stock si no se re-abastecen
seguido — el equipo de compras podría priorizarlos.

### Artículos de rotación MÁS LENTA (con venta real, pero sobre-stockeados)
Sobre todo refacciones específicas de garruchas/polipastos POLICRANE
(`REPG1-*`, `REPG2-*`, `REPG3-*` — guías de cadena, nueces de carga,
resortes, placas) con miles de días de inventario a la mano — venden 2-6
unidades al año contra decenas o cientos en existencia. También cable
inoxidable 3/8" (2,733 unidades, solo 8 vendidas en 12 meses).

### Fix aplicado a Claudia IA (conservador, sin usar SKUs específicos)
Se agregó una regla de desempate en `prompts.yaml`: cuando varias opciones
cubren igual de bien lo que pide el cliente (mismo tipo, medida y marca
comparable) y no hay razón técnica para preferir una, priorizar la que
tenga MÁS existencia disponible — reduce el riesgo real de que Claudia
ofrezca algo casi agotado (visto arriba que existen artículos con menos de
1 día de inventario) y ayuda de forma natural a rotar el inventario con más
stock, sin nunca sacrificar lo que el cliente realmente necesita. No se
hardcodeó ningún SKU específico en el prompt (esos datos cambian con el
tiempo) — la recomendación de qué hacer con el inventario muerto se deja
como hallazgo para que el equipo de Ambar Cargo lo revise manualmente.

---

## Subagente de estrategia comercial (herramienta nueva, no cambia a Claudia)

El usuario pidió aplicarle a Claudia un prompt de rol "Chief Revenue
Officer / CCO" (estilo Fortune 500, con frameworks tipo MEDDIC, tablas de
KPIs, planes por trimestre). Se determinó que copiarlo literal habría roto
la experiencia real de WhatsApp que se validó en vivo esta sesión (Claudia
debe sonar corta y conversacional, no como un asesor ejecutivo). Se
recomendó y se creó en su lugar un **subagente de Claude Code separado**:
`estratega-comercial-ambar` (`C:\Users\odaniel\.claude\agents\estratega-comercial-ambar.md`)
— rescata los principios útiles del marco CRO/CCO (diagnóstico basado en
datos antes de proponer soluciones, KPIs compartidos, atención a los
traspasos Claudia→vendedor) pero adaptados a un distribuidor industrial
mediano, no a una empresa SaaS enterprise. Su trabajo es analizar y
diseñar KPIs/reportes; cualquier cambio que decida aplicarle a Claudia se
traduce a una regla breve y conversacional en `prompts.yaml` — nunca a su
tono o rol directamente. El prompt CRO/CCO original que trajo el usuario
NO se aplicó a Claudia IA.

---

## Tasa de re-contacto en 30 días (KPI / indicador)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Porcentaje de teléfonos que vuelven a escribirle a Claudia dentro de 30 días de su primer contacto. Se calcula con MIN(timestamp) y siguientes mensajes por telefono en la tabla mensajes.

**Evidencia:** Es una señal indirecta de qué tan bien está funcionando el seguimiento humano después de que Claudia canaliza un lead — si el cliente no vuelve a escribir, puede ser porque ya lo atendieron bien, o porque se perdió el seguimiento.

---

## Distribución de motivos de contacto (KPI / indicador)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Clasificar el primer mensaje de cada conversación nueva por palabras clave simples (cotización/precio, soporte/problema, cita/servicio, información general) para saber si Claudia se usa más para ventas o para soporte, y en qué proporción.

**Evidencia:** Ayuda a decidir en qué debe mejorar más el prompt/las herramientas de Claudia según el uso real, no una suposición.

---

## Notificaciones fallidas recientes por vendedor (alerta temprana, no solo % histórico) (KPI / indicador)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

A diferencia de la tasa de entrega histórica acumulada que ya existe en Indicadores, este KPI mostraría notificaciones fallidas SOLO de los últimos 7 días por vendedor — para detectar un vendedor con la ventana de WhatsApp cerrada AHORA, no diluido en el promedio histórico.

**Evidencia:** Se encontró en vivo esta sesión que una vendedora dejó de recibir notificaciones por tener la ventana de 24h de WhatsApp cerrada — un promedio histórico no habría alertado esto a tiempo.

---

## Tasa de abandono de carrito (KPI / indicador)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Porcentaje de carritos (tabla carrito) que se quedan con confirmado=0 sin actividad reciente, contra el total de teléfonos que llegaron a agregar al menos un artículo. Señala pedidos que se quedaron a medias.

**Evidencia:** Hoy mismo hay carritos abandonados visibles en la base de pruebas (7 de 10 registros sin confirmar) — vale la pena medirlo en producción real para saber si es un patrón recurrente.

---

## Tasa de conversión: conversación → interés accionable para ventas (KPI / indicador)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

De los teléfonos únicos que le escriben a Claudia, qué porcentaje termina en un lead registrado o una notificación a vendedor (categoría lead_nuevo o cliente_existente en notificaciones_vendedor). Se calcula cruzando COUNT(DISTINCT telefono) de mensajes contra COUNT(DISTINCT telefono) en notificaciones_vendedor.

**Evidencia:** Mide si las conversaciones realmente se están convirtiendo en algo accionable para ventas, no solo generando respuestas.

---

## Monitorear activamente la tasa de entrega a vendedor, no solo verla pasivamente en el panel (Estrategia de ventas)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Esta sesión se encontraron y corrigieron 2 bugs reales de notificación (WhatsApp fuera de la ventana de 24h, y una notificación duplicada a un vendedor equivocado). El negocio debería revisar la tasa de entrega por vendedor con regularidad (ya existe en Indicadores) y no asumir que un lead "se avisó" solo porque Claudia se lo dijo al cliente.

**Evidencia:** Notificación real fallida a un vendedor por ventana de 24h expirada (Twilio error 63016), y un caso real de notificación duplicada a un vendedor sin relación con el caso — ambos encontrados y corregidos en conversaciones reales de prueba de hoy.

---

## Campaña dirigida para mover el inventario estancado (no aplica a Claudia — es acción de negocio) (Estrategia de ventas)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Hay artículos con existencia muy alta y cero ventas en 12 meses. Vale la pena una promoción o contacto saliente a clientes de cartera para estos SKUs específicos, coordinado por el equipo de ventas (Claudia solo responde entrante, no puede iniciar esta campaña).

**Evidencia:** Cable Retenida 1/4" WARRIOR: 220,523 unidades sin vender en 12 meses. Cable Boa 1/2"/3/8"/5/8" WARRIOR: 19,000-27,000 unidades cada uno. Casquillo de Aluminio y Perro Galv. (varias medidas): 9,000-27,000 unidades cada uno. 1,332 artículos en total sin ninguna venta en 12 meses pese a tener existencia.

---

## Liderar con las marcas que de verdad rotan, no con las que salen primero en la búsqueda (Estrategia de ventas)

**Origen:** aprobado desde el panel de administración (análisis de IA), 2026-07-31.

Para polipastos/equipo de izaje, priorizar mostrar POLICRANE y POLICHAIN antes que otras marcas con historial de venta mucho menor. Ya se aplicó como regla de contexto en el prompt de Claudia; falta medir con datos reales de producción si mejora la tasa de conversión una vez haya volumen real de conversaciones.

**Evidencia:** POLICRANE: 13,912 transacciones históricas de venta. POLICHAIN: 1,968. POLIMAX (la marca que Claudia ofrecía por defecto antes de la corrección): solo 81.

---

## Las dependencias sin cota superior son una bomba de tiempo (Infraestructura, no prompt)

**Origen:** incidente del 2026-08-10/11 en los proyectos de NetSuite, aplicado
aquí de forma preventiva el 2026-08-11.

`requirements.txt` declaraba todo con `>=` abierto. Como el contenedor de
Railway instala limpio en cada build, un deploy **sin cambios de código** podía
jalar una versión MAYOR nueva de cualquier librería y romper producción sin que
nadie lo hubiera pedido. Se agregaron cotas superiores de versión mayor
(`>=x,<X+1`): el piso no cambia, sólo se impide el salto que rompe compatibilidad.

**Evidencia:** el 07/08/2026 pip actualizó pandas de 2.x a 3.0.5 en el equipo
local por exactamente esta razón. En pandas 3.0, `astype(str)` dejó de convertir
los faltantes a la cadena `"nan"`, lo que reventó el cálculo de ancho de columna
de los reportes de Inventario Ambar. Falló tres corridas seguidas y dejó el
archivo maestro del `.xlsm` cuatro días desactualizado, sin que ningún log lo
reportara. Otro proyecto tenía el mismo bug tapado por un `try/except` y degradó
el formato en silencio durante cuatro días.

**Lección transferible a Claudia:** un `try/except` que no registra convierte un
error en una degradación invisible. Aplica igual a las herramientas del agente:
si `consultar_catalogo` o la notificación al vendedor fallan y se traga la
excepción, Claudia responde como si todo hubiera salido bien. Ya está registrado
arriba el caso real de la notificación al vendedor que fallaba en silencio.

**Vigilancia:** este repositorio quedó dado de alta en el Centinela
(`C:\Users\odaniel\Centinela`), que audita a diario sus bitácoras y el resultado
de la tarea `AgentKit_Ambar_SyncDiario`.
