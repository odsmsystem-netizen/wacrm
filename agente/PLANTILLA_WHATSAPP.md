# Plantilla de WhatsApp — aviso a vendedor fuera de la ventana de 24h

## Por qué hace falta

WhatsApp solo deja mandar un mensaje libre a alguien que te escribió en las
**últimas 24 horas**. Pasado ese tiempo la ventana se cierra y el mensaje
rebota (Twilio, error `63016`).

Eso ya pasó en producción: una vendedora dejó de recibir los avisos de
Claudia durante días y nadie se enteró, porque el cliente sí recibía un
"en breve será atendido por su asesor" y se iba tranquilo.

La única forma de atravesar esa ventana es una **plantilla aprobada** por
Meta. El código ya está listo para usarla; falta darla de alta.

## BLOQUEADO HOY — estamos en el sandbox de Twilio

`TWILIO_PHONE_NUMBER` es `+14155238886`, el número compartido de pruebas.
**En el sandbox NO se pueden dar de alta plantillas propias**: la aprobación
va ligada a una cuenta de WhatsApp Business (WABA) con remitente registrado,
y el sandbox no tiene ninguna.

Por eso el `63016` que se vio en producción no tenía salida: la ventana de
24h aplica igual, pero sin plantilla no hay alternativa — el aviso al
vendedor simplemente se pierde.

Los pasos de este documento **solo sirven después** de salir del sandbox:

1. Cuenta de Twilio de pago (upgrade desde trial).
2. Meta Business Manager con el negocio verificado. Este es el cuello de
   botella real: Meta pide documentos del negocio y tarda de días a semanas.
3. Un número dedicado, LIBRE de WhatsApp (si ya tiene WhatsApp normal o
   Business, hay que borrar esa cuenta y se pierde su historial).
4. Registrarlo en Twilio Console → Messaging → Senders → WhatsApp senders.

Mientras tanto, lo que protege al negocio es lo que ya está desplegado:
Claudia no promete atención cuando el aviso rebota, y el panel
(Indicadores → alertas de notificación) lista qué clientes quedaron
esperando y de qué vendedor, para levantarlos a mano.

Alternativa evaluada y pospuesta: avisar por correo cuando el WhatsApp
rebota. Es el único canal que funciona sin salir del sandbox — los correos
de los vendedores ya están en la tabla `vendedores`.

## Cómo funciona en el código

1. Claudia canaliza a un cliente → se intenta el aviso normal (con la
   transcripción adjunta).
2. Si ese aviso **no se entrega**, se reintenta automáticamente con la
   plantilla (`agent/providers/twilio.py: enviar_plantilla`).
3. Si la plantilla tampoco pasa, queda `notificado=0`, un `logger.error` y
   la fila aparece en el panel → Indicadores → *Alertas de notificación*,
   con el teléfono del cliente que quedó esperando.

Mientras `TWILIO_CONTENT_SID_AVISO_VENDEDOR` no esté configurado, el paso 2
simplemente no ocurre. Nada se rompe, solo no hay respaldo.

## Pasos para darla de alta (esto se hace en Twilio, no en el código)

### 1. Crear la plantilla

Twilio Console → **Messaging → Content Template Builder → Create new**

- **Nombre:** `aviso_vendedor_cliente`
- **Tipo:** `Text`
- **Idioma:** Español (`es_MX`)
- **Categoría:** `UTILITY` — importante. Si se manda como `MARKETING`, Meta
  la rechaza o la penaliza, porque no es publicidad sino un aviso operativo.

**Cuerpo del mensaje** (las variables van por posición y el orden importa,
`agent/tools.py: _variables_plantilla` las manda en este orden):

```
Hola {{1}}, Claudia IA te canalizó a un cliente: {{2}} — Tel: {{3}}. Entra al panel de Ambar Cargo para ver la conversación completa.
```

| Variable | Contenido            | Ejemplo                      |
|----------|----------------------|------------------------------|
| `{{1}}`  | Nombre del vendedor  | `Wendy`                      |
| `{{2}}`  | Cliente              | `TUBOS PIRAMIDE S.A. DE C.V.`|
| `{{3}}`  | Teléfono del cliente | `+5213330019019`             |

Al guardar, Twilio pide valores de muestra para las variables — pon los del
ejemplo de arriba.

### 2. Enviarla a aprobación

En la misma pantalla: **Submit for WhatsApp Approval**.

Meta suele responder en minutos, a veces hasta 24 horas. Si la rechaza,
casi siempre es por la categoría (debe ser `UTILITY`) o por texto que suene
promocional — este texto es puramente informativo, no debería tener
problema.

### 3. Copiar el Content SID

Una vez aprobada, la plantilla tiene un SID que empieza con `HX...`.
Cópialo y agrégalo al `.env`:

```env
TWILIO_CONTENT_SID_AVISO_VENDEDOR=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

En Railway va como variable de entorno del proyecto, igual que las demás.

### 4. Probar

Con el servidor arriba, pídele a un vendedor que **no** haya escrito al bot
en las últimas 24 horas (esa es justo la condición que se quiere probar) y
canaliza un cliente de prueba hacia él. En los logs debe aparecer:

```
Aviso a <vendedor> entregado por PLANTILLA (el mensaje libre no pasó — ventana de 24h cerrada).
```

## Limitación que hay que tener presente

Una plantilla aprobada **no admite adjuntos ni texto libre**: el vendedor
recibe solo los tres datos de arriba, no la transcripción de la
conversación. Eso es a propósito — sirve para que sepa a quién marcarle de
inmediato. El detalle completo sigue en el panel de administración.
