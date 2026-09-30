# Identificación del cliente y derivación a su representante

Diseño acordado el 2026-09-29. Toca **dos repositorios**:
`odsmsystem-netizen/wacrm` (migración y API) y
`odsmsystem-netizen/whatsapp-agentkit` (el agente Claudia).

## Qué problema resuelve

Hoy Claudia atiende a todos igual: no sabe con quién habla ni si esa
empresa ya tiene un asesor asignado en NetSuite. Un cliente de años
recibe el mismo trato que alguien que escribe por primera vez, y no hay
forma de que llegue a la persona que lo conoce.

El objetivo es doble: que cada conversación quede identificada con una
razón social desde el primer minuto, y que un cliente con representante
asignado pueda hablar con él si quiere.

## El flujo

Tras el saludo, Claudia pregunta si es cliente nuevo o habitual.

**Habitual** → pide la razón social → la busca en el catálogo local:

| Caso | Qué pasa |
| --- | --- |
| Tiene representante **persona** | Claudia le confirma quién es su asesor y le ofrece seguir con ella o pasar con él |
| Su representante es **AMBAR CARGO** | No se le menciona representante. Se le ofrece seguir con Claudia o pasar con alguien del equipo, asignado por reparto |
| **No se encuentra** | Se le trata como cliente nuevo, sin señalar la contradicción |

**Nuevo** → pide la razón social y ofrece lo mismo: seguir con Claudia o
pasar con alguien del equipo.

En los dos casos, si sigue con Claudia, ella le avisa que puede escribir
`/agente` cuando quiera para pasar con una persona.

### Por qué AMBAR CARGO no se menciona

De los 8985 clientes sincronizados, **7981 (89 %) tienen `AMBAR CARGO`
como representante** — que es la empresa, no una persona. Decirle a
alguien "tu representante de ventas es Ambar Cargo" no le aporta nada y
delata que el dato está vacío. Para ellos el camino es el mismo que para
un cliente nuevo: reparto entre el equipo.

Los 12 representantes reales cubren unos 1000 clientes:

| salesrep_id | Representante | Clientes |
| --- | --- | --- |
| 147 | ALEJANDRA CASTELLANOS FRANCO | 220 |
| 122 | VALERIA SARAHI SILVA RUIZ | 160 |
| 115 | WENDY ARIADNA PENELOPE LOPEZ REYES | 145 |
| 133 | JOSE ULISES EUGENIO VELEZ | 125 |
| 125 | JESUS A HERNANDEZ HERRERA | 87 |
| 112 | JERONIMO GUERRA MARTINEZ | 78 |
| 119 | PABLO FRANCO CASTELLANOS | 69 |
| 131 | EVA  A GOMEZ GARCIA | 57 |
| 123 | MARIA GUADALUPE LARES LUNA | 52 |
| 6750 | MARIA F POSADA CEBALLOS | 5 |
| 7030 | CAROLINA D ORTIZ FLORES | 5 |
| 145 | LORENA BAYARDO VIZCAINO | 1 |

(`5200` = AMBAR CARGO, la empresa.)

## Enfoque: el código garantiza, el modelo conversa

Se descartaron dos alternativas. Dejar **todo en el prompt** es barato y
natural, pero no garantiza que los pasos ocurran: un prompt de 21 000
caracteres a veces olvida preguntar la razón social. Una **máquina de
estados** garantiza el orden, pero responde "¿eres nuevo o habitual?" a
quien acaba de preguntar por un gato hidráulico de 3 toneladas — que es
justo lo que el prompt actual se esfuerza en evitar.

El reparto queda así:

**En código, porque debe ser infalible:**
- La intercepción de `/agente`.
- La asignación de la conversación.
- El estado de identificación del cliente.

**En el prompt, porque debe sonar humano:**
- Cuándo y cómo preguntar.
- Qué decir según lo que devuelva la búsqueda.
- Atender primero si el cliente ya pidió algo concreto.

## Parte 1 — wacrm: datos y API

### Migración `046_salesrep_netsuite.sql`

```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS netsuite_salesrep_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_netsuite_salesrep_id_key
  ON profiles (account_id, netsuite_salesrep_id)
  WHERE netsuite_salesrep_id IS NOT NULL;
```

El índice es único **por cuenta y parcial**: impide que dos personas
reclamen el mismo representante —lo que haría impredecible a quién llega
el cliente— sin obligar a que todos los usuarios tengan uno. Quien no
venda se queda con la columna en `NULL`.

### `PATCH /api/v1/conversations/{id}` acepta un campo más

Hoy admite `assigned_agent_id` con un id, `"auto"` o `null`. Se añade:

```jsonc
{
  "assigned_salesrep_id": "147",      // el salesrep_id de NetSuite
  "ai_autoreply_disabled": true       // deja el mismo estado que «Tomar control»
}
```

wacrm lo traduce al perfil cuyo `netsuite_salesrep_id` coincide, dentro
de la misma cuenta, y asigna. Que la traducción viva aquí y no en el
agente ahorra un viaje y mantiene el mapeo donde vive el dato.

Reglas:

- `assigned_salesrep_id` y `assigned_agent_id` son **mutuamente
  excluyentes**. Mandar ambos devuelve `400`: adivinar cuál gana sería
  peor que rechazarlo.
- Si ningún perfil tiene ese id, responde `409` con
  `reason: "salesrep_not_mapped"`. No reparte por su cuenta: el CRM no
  decide a quién mandar un cliente cuando el destino pedido no existe.
- `ai_autoreply_disabled` se acepta como campo propio, opcional. Es lo
  que mantiene la bandeja diciendo la verdad sobre quién atiende ese
  chat (ver «Convive con el botón Tomar control»).

Archivos: `supabase/migrations/046_*.sql`,
`src/app/api/v1/conversations/[id]/route.ts`, y una función
`resolveBySalesrep` junto a `resolveAssignee` en
`src/lib/conversations/assign.ts`.

### Alta de los representantes

La funcionalidad no hace nada visible hasta que los vendedores existan
como usuarios de wacrm **con su `netsuite_salesrep_id` puesto**. Con la
columna vacía, todo cliente con representante real cae en
`salesrep_not_mapped` y termina en reparto: el flujo funciona, pero la
parte que motivó el trabajo queda inerte.

Son 12 altas contra Supabase Auth, cada una con correo real. Requiere
que el usuario proporcione esos correos.

## Parte 2 — El agente: flujo de Claudia

### `/agente` se intercepta antes del modelo

En `conversacion.py`, antes de llamar a Claude. Es un comando: gastar una
llamada al modelo para interpretarlo sería caro y menos fiable.

Se aceptan también variantes naturales ("quiero hablar con una persona",
"pásame con un asesor"). El comando con barra es jerga de sistemas y un
cliente no lo intuye; cerrarlo solo a `/agente` haría que casi nadie lo
encontrara.

El destino depende de lo que se sepa del cliente: si tiene representante
mapeado, va con él; si no, `"auto"`.

### Dos herramientas nuevas en `tools.py`

**`identificar_cliente(razon_social)`** — busca en `netsuite_sync.db` con
la búsqueda flexible que el repo ya tiene. Devuelve si encontró, la razón
social oficial, y si el representante es persona o AMBAR CARGO. Con
varios candidatos, los devuelve todos para que Claudia pregunte cuál.

**`pasar_con_representante()`** — hace el `PATCH` y se retira.

### El estado vive en el contacto de wacrm

No en la memoria del agente. Sobrevive a un reinicio, y el equipo ve la
razón social en la ficha del cliente en lugar de tener que buscarla en la
conversación. Una vez identificado, **no se le vuelve a preguntar** — ni
en esa conversación ni en las siguientes.

### Claudia se calla sola

No hay que construir nada: `sondeo_wacrm.py:349` ya descarta las
conversaciones que tienen `assigned_agent_id` **o**
`ai_autoreply_disabled`. Asignar a una persona basta para que Claudia
deje de responder en ese chat.

### Convive con el botón «Tomar control» que ya existe

La bandeja ya tiene una palanca para esto, y la derivación tiene que
dejar el mismo estado que ella o el equipo verá información falsa.

`POST /api/ai/autoreply/{conversationId}` con `{paused: true,
assign_to_me: true}` es el botón **Tomar control**: pausa el bot
(`ai_autoreply_disabled = true`) **y** asigna la conversación a quien
pulsa. Con `{paused: false}` hace el camino inverso —«Devolver a la
IA»—: limpia la pausa, reinicia el contador de respuestas, borra la nota
de handoff y desasigna a quien la tuviera, sea quien sea y no solo si era
el llamante.

Ese «sea quien sea» es deliberado y este rasgo depende de él. Una
conversación derivada queda asignada al representante, no a quien pulse
después el botón. Si «Devolver a la IA» solo soltara la asignación propia
del llamante, la del representante se quedaría puesta; y como la
elegibilidad del autorespondedor se cae en cuanto hay un humano asignado,
el bot seguiría callado y el botón no haría nada visible. El comentario en
`src/app/api/ai/autoreply/[conversationId]/route.ts` lo dice igual. Quien
lea esto y sienta la tentación de acotarlo al llamante: eso convierte
«Devolver a la IA» en un botón que no hace nada.

El comentario de `src/lib/ai/external-agent.ts` explica por qué el
banner se muestra aunque el bot nativo esté apagado: con un agente
externo como Claudia, sin ese banner el equipo perdería «la única
palanca que detiene a un bot a mitad de conversación».

Dos consecuencias para este diseño:

**La derivación debe pausar, no solo asignar.** El banner se pinta
mirando `ai_autoreply_disabled`. Si Claudia solo asignara, la bandeja
seguiría anunciando «Claudia IA está respondiendo» en un chat que ella
ya abandonó — y el vendedor podría no contestar creyendo que está
cubierto. Por eso el `PATCH` acepta también `ai_autoreply_disabled`, y
Claudia manda ambos campos en la misma llamada. Se prefiere mandarlo
explícito antes que hacer que asignar implique pausar: eso cambiaría en
silencio el significado del `assigned_agent_id` que ya usan las
automatizaciones.

**La vuelta atrás ya existe y no hay que construirla.** Cuando el
vendedor termina, «Devolver a la IA» limpia la pausa y desasigna, y
Claudia retoma el hilo en el siguiente sondeo. El cliente derivado no se
queda fuera de su alcance para siempre.

## Privacidad: qué se le dice a quien pregunta

Claudia responde a cualquiera que escriba una razón social. **Nadie
demuestra ser de esa empresa**, y basta un competidor curioso escribiendo
al WhatsApp del negocio.

Por eso Claudia **confirma la razón social pero no recita el RFC**:

> "¡Claro! Te tengo registrado como Ferretería El Tornillo, y tu asesora
> es Alejandra."

El cliente legítimo se reconoce igual; quien pesca no se lleva nada que
no supiera ya. Si se decide mostrar el RFC, se puede — pero que sea una
decisión tomada, no un descuido.

## Errores y casos límite

| Situación | Comportamiento |
| --- | --- |
| `salesrep_not_mapped` | No se le dice al cliente que su asesor no existe en el sistema. Cae a reparto, en silencio. Queda en el log |
| `no_agent_available` | "Ahora mismo no tengo a nadie disponible, pero me quedo contigo y les paso tu caso" — y sigue atendiendo |
| La API falla al asignar | Un reintento; si falla, como el caso anterior. **Nunca confirma una derivación que no se completó** |
| Catálogo vacío o desfasado | Trata a todos como nuevos. Degrada, no revienta |
| Varias empresas parecidas | Pregunta cuál. Con más de tres candidatos, pide el RFC |
| No encuentra nada | Lo trata como nuevo, sin hacerlo sentir mal |
| Conversación ya asignada + `/agente` | No se reasigna. Quitarle el cliente a quien ya lo atiende es peor que no hacer nada |
| Un vendedor ya pulsó «Tomar control» | El sondeo ya descarta ese chat, así que Claudia ni se entera del `/agente`. Correcto: la persona manda |
| El cliente ignora la pregunta y pide un precio | Se le responde el precio. La identificación se retoma después, o se abandona |
| Ya identificado antes | Saluda y sigue. Sin repetir el interrogatorio |
| Dice ser habitual y no está | Pasa al flujo de nuevo, sin señalar la contradicción |

## Pruebas

**wacrm** — `assign.test.ts` ya cubre `resolveAssignee`. Se añaden casos
para `resolveBySalesrep`: representante mapeado, no mapeado, mapeado en
otra cuenta (no debe cruzarse), y el conflicto de mandar los dos campos.

**El agente** — siguiendo el estilo de `test_busqueda_flexible.py` y
`test_aviso_vendedor.py`: el interceptor de `/agente` y sus variantes;
`identificar_cliente` con representante persona, con AMBAR CARGO, sin
coincidencia y con varias; y que un cliente ya identificado no vuelva a
ser interrogado.

## Fuera de alcance

- Panel para administrar el mapeo representante↔usuario. Se edita en el
  perfil; si con el tiempo estorba, se añade.
- Avisar al representante de que le llegó un cliente. Lo ve en su
  bandeja.
- Mostrar historial de compras o saldos en la identificación.

## Decisiones tomadas

| Punto | Decisión |
| --- | --- |
| Representantes en el CRM | Cada uno tendrá su usuario |
| Enlace NetSuite ↔ CRM | Campo `netsuite_salesrep_id` en el perfil |
| Representante AMBAR CARGO | No se menciona; reparto entre el equipo |
| `/agente` | Lo escribe el cliente por WhatsApp |
| Razón social que no calza | Buscar parecidos y confirmar con el cliente |
| Control del flujo | Híbrido: código para lo infalible, prompt para lo conversacional |
| Traducción salesrep → agente | En wacrm, dentro del `PATCH` |
| Estado al derivar | Asignar **y** pausar, igual que «Tomar control» |
| Volver a Claudia | Con «Devolver a la IA», que ya existe |
| RFC en la respuesta | No se recita; solo se confirma la razón social |

## Pendiente del usuario

1. Los **correos** de los 12 representantes, para darlos de alta.
2. Confirmar la decisión sobre el RFC (propuesta: no mostrarlo).
