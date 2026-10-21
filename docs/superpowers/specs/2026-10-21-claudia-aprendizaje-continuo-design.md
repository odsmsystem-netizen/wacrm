# Claudia IA — aprendizaje continuo desde las conversaciones

Fecha: 2026-10-21 · Estado: borrador para aprobación

## Intención y por qué

Claudia (agente de WhatsApp/Messenger de Ambar Cargo) toma decisiones incorrectas
con algunos clientes. El caso que lo motivó, en una conversación real de 39
mensajes (cotización de eslingas, 2026-10-12):

- perdió el contexto («no veo un mensaje anterior con lo que necesitas»);
- preguntó tres veces si el cliente ya era cliente;
- dio de alta a alguien sin haberlo podido localizar;
- tomó un RFC por un código de producto y respondió con un saludo de bienvenida
  a mitad de la conversación;
- obligó al cliente a copiar y pegar el mensaje de ella para que lo retomara.

El dueño quiere que Claudia **aprenda sola de las conversaciones que llegan, aplique
lo aprendido y esté en evolución constante**, sin que una persona apruebe cada
lección. Esa decisión es suya y no se discute: la autonomía es el requisito, no un
riesgo a eliminar.

«Evolucionar su modelo» significa **cambiar lo que Claudia sabe y cómo decide**
(sus instrucciones). No se reentrena ningún modelo de Anthropic.

## Metas

1. Detectar automáticamente decisiones incorrectas en conversaciones terminadas.
2. Convertirlas en reglas cortas y generales y aplicarlas a Claudia sin intervención.
3. Que el conjunto de reglas se mantenga pequeño y coherente por sí solo (fusiona,
   descarta, no crece sin límite).
4. Que el dueño pueda **ver** qué aprendió y **apagar** una regla o todo el
   aprendizaje, sin que eso sea un paso obligatorio.

## No metas

- Aprobación humana previa de cada lección (descartado por el dueño).
- Reentrenar o ajustar modelos; RAG o búsqueda semántica (ya descartados para la base
  de conocimiento mientras el peso real no se acerque al umbral).
- Reescribir las instrucciones, la personalidad o la base de conocimiento que el dueño
  escribe a mano: el aprendizaje las **complementa**, nunca las edita.
- Aprender de conversaciones atendidas por una persona (solo los turnos de Claudia se
  juzgan).

## Anti-metas (sería un fracaso aunque «funcione»)

- Que una lección aprendida contradiga una instrucción escrita a mano y gane.
- Que Claudia aprenda a prometer precios, descuentos, plazos o condiciones, o a relajar
  el candado de datos (los descuentos los ve un representante, no Claudia).
- Que se guarden datos personales de clientes (nombres, teléfonos, correos, RFC) dentro
  de una lección.
- Que el prompt crezca hasta volverse lento y caro.
- Que el aprendizaje se rompa en silencio sin que nadie lo note.

## Decisiones ya tomadas por el dueño

- Las lecciones se aplican **solas**, sin aprobación previa.
- Quiere evolución constante.

## Diseño

### Dónde vive cada pieza

| Pieza | Dónde | Motivo |
|---|---|---|
| Tabla `claudia_lecciones` y su API | CRM (Supabase, migración 052) | El CRM ya es quien entrega la configuración de Claudia por `/api/v1/claudia/config`, y ahí se verá y apagará. |
| Revisor, consolidador y su programación | Agente (`whatsapp-agentkit`, junto a `programador.py`) | Tiene la clave de Anthropic, el historial propio de Claudia y ya corre tareas de fondo. |
| Pestaña «Aprendizaje» | CRM, módulo Claudia IA | Verlas, apagar una, apagar todo. |

Un push a `main` del repo del agente despliega a producción: **el agente se
despliega con el mismo cuidado que cualquier cambio de producción.**

### 1. Revisor (continuo)

- Tarea de fondo del agente, cada hora.
- Toma conversaciones **inactivas** (mi call: ≥ 6 h sin mensajes) que aún no se hayan
  revisado.
- Manda a un modelo revisor (mi call: Sonnet, por costo) la conversación con una
  rúbrica fija de errores: perdió contexto, repitió una pregunta ya respondida,
  malinterpretó un dato, dio información que no estaba en sus herramientas, tomó una
  acción irreversible sin confirmar, el cliente la corrigió o la abandonó, una persona
  tuvo que tomar el control.
- Devuelve, por cada error, una **lección candidata**: regla general en una frase
  (≤ 300 caracteres), categoría y un extracto de evidencia sin datos personales.
- Solo se revisan los turnos de Claudia. Los mensajes escritos por una persona desde
  el teléfono no cuentan como error de Claudia.

### 2. Filtros automáticos (no son aprobación humana)

Una lección candidata se descarta sola y queda registrada con el motivo si:

- contiene datos personales (nombres propios de clientes, teléfonos, correos, RFC);
- promete o fija precios, descuentos, plazos o condiciones;
- relaja una protección existente (candado de datos, derivar a un representante);
- contradice una instrucción escrita a mano (**las instrucciones del dueño siempre
  ganan**; el consolidador lo comprueba contra el texto de personalidad e
  instrucciones);
- es casi igual a una lección ya activa (en ese caso aumenta su contador de
  «confirmada» en vez de duplicarla).

### 3. Aplicación

- Las lecciones activas forman una sección **«Lecciones aprendidas»** al final del
  bloque estable del prompt (`prompt_extra`), con el encabezado «si algo de esto
  contradice las instrucciones anteriores, mandan las instrucciones anteriores».
- Se publican por lotes: como mucho **una vez por hora**, para no invalidar la caché
  de prompts a cada lección.
- Entran activas de inmediato al publicarse el lote.

### 4. Consolidación (mantiene el conjunto pequeño)

- Una vez al día (mi call: 3:00 a. m., hora de Ciudad de México), el consolidador
  fusiona lecciones parecidas, reescribe las confusas, descarta las que ya no se
  confirman y respeta un tope.
- **Tope (mi call):** 40 lecciones activas y 6 000 caracteres en total. Al llegar al
  tope se descartan primero las menos confirmadas y las más antiguas.

### 5. Visibilidad y control (sin ser un gate)

- Cada lección guarda: texto, categoría, estado (`activa`, `descartada`, `fusionada`),
  motivo de descarte, cuántas veces se confirmó, el lote en que se publicó y una
  referencia a la conversación de origen.
- Pestaña **«Aprendizaje»** en Claudia IA del CRM: lista de lecciones con su evidencia,
  botón para apagar una, y un **interruptor general** del aprendizaje.
- Con el interruptor apagado el revisor no corre y las lecciones activas dejan de ir
  en el prompt.

### 6. Que no falle en silencio

- Cada ciclo del revisor deja un registro: conversaciones revisadas, lecciones
  propuestas, aceptadas y descartadas, errores.
- La pestaña muestra la fecha del último ciclo exitoso; si pasan más de 24 h sin uno,
  lo marca en rojo.

### Fase 2 (no entra en la primera entrega — mi call)

- **Freno automático:** comparar la tasa de errores antes y después de cada lote y
  desactivar solo un lote que empeore los resultados. Se deja preparado guardando
  `lote_id` en cada lección y registrando la tasa de errores por semana.

## Restricciones técnicas conocidas

- En la base **no se distinguen** los mensajes de Claudia de los de una persona que
  escribe desde el teléfono (ambos son `sender_type = 'agent'` con `sender_id` vacío).
  **A verificar por quien construya:** si el historial propio del agente
  (`agentkit.db`) conserva todos los turnos de Claudia; si no, habrá que marcar el
  origen del mensaje al enviarlo.
- El bloque estable del prompt va en caché; cambiarlo tira la caché una vez. De ahí el
  lote horario.
- El peso total del prompt ya se vigila (umbral de aviso en 100 000 caracteres); las
  lecciones suman a ese total y deben mostrarse en el mismo indicador.
- Hay poca información hoy: 38 conversaciones en dos semanas. Las primeras semanas
  producirán pocas lecciones y se espera que el consolidador las filtre más que las
  amplíe.
- Debe haber una forma de **apagar todo desde el CRM sin desplegar el agente**.

## Resoluciones tras la revisión del diseño

Verificado en el código del agente:

- **Fuente de verdad de las conversaciones: la tabla `mensajes` de `agentkit.db`.**
  Guarda cada turno por teléfono con `role` = `user` o `assistant`, así que los turnos
  de Claudia ya están separados de los de una persona; no hace falta marcar el origen
  al enviar. (Mensajes de Messenger: se identifican por su identificador de contacto en
  esa misma tabla; el constructor debe confirmar cómo se guardan.) Se revisa el
  historial existente, no solo lo nuevo.
- **Qué es «ya revisada»:** el revisor guarda en `agentkit.db` hasta qué mensaje revisó
  de cada conversación. Si una conversación se reactiva, solo se revisan los turnos
  posteriores a esa marca.
- **Centro de Aprendizaje existente** (`propuestas_aprendizaje`, panel `/admin`): es
  otro mecanismo, con aprobación manual y orientado a estrategia y KPI. Se deja como
  está; las lecciones nuevas son una tabla distinta en el CRM.

Decisiones mías (el dueño puede cambiarlas):

- **Contrato con el agente.** El agente ya consulta la configuración del CRM
  periódicamente. El CRM entrega, junto con `prompt_extra`, un campo `lecciones` ya
  armado (texto de la sección) y un indicador `aprendizaje_activo`. El CRM decide qué
  lotes están publicados; el agente solo lo pega al final del bloque estable. Apagar el
  interruptor surte efecto en la siguiente consulta del agente, sin desplegar.
- **Filtros, dos capas.** Reglas deterministas para datos personales (RFC, teléfonos,
  correos, números de folio) y palabras que implican precio o descuento; después un
  modelo juez para contradicción con instrucciones manuales, promesas y relajación de
  protecciones. **Ante la duda se descarta.**
- **Duplicados:** los compara el consolidador con el modelo, en una sola llamada diaria
  con todas las lecciones, no una por lección.
- **Qué se revisa de una conversación tomada por una persona:** los turnos de Claudia
  hasta el traspaso; el traspaso mismo cuenta como señal de posible error.
- **Costo:** máximo 30 conversaciones por ciclo horario y un tope diario de gasto
  configurable; si se agota, el ciclo espera al siguiente día. Mi estimación: unos
  pocos dólares al mes con el volumen actual.
- **Permisos:** solo owner y admin ven y apagan lecciones y sus extractos.
- **Un solo agente en ejecución:** el ciclo es idempotente (marca de revisado por
  mensaje) y toma un candado antes de correr; si el agente se reinicia a mitad, retoma
  sin duplicar.

## Qué se deja a quien construya

Nombres de tablas y columnas, el texto exacto de la rúbrica y de los avisos, el diseño
visual de la pestaña, la forma de programar las tareas dentro del agente y el formato
del registro de ciclos.

## Cómo sabremos que funciona

- En una conversación de prueba que reproduzca el caso de las eslingas, la regla
  correspondiente aparece entre las lecciones y Claudia deja de repetir la pregunta.
- Una lección con un RFC o un teléfono dentro nunca llega al prompt.
- Una lección que contradiga una instrucción manual queda descartada con motivo.
- Apagar el interruptor general quita las lecciones del siguiente prompt.
- El prompt de Claudia no crece por encima del tope de lecciones.
