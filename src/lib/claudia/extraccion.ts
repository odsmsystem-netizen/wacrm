// ============================================================
// De un archivo, una imagen o una URL al texto que Claudia lee.
//
// La extracción ocurre UNA vez, al dar de alta la fuente, y lo que se
// guarda es el resultado. Si se dejara para la hora de responder, cada
// pregunta de un cliente pagaría el parseo — y en el caso de una imagen,
// una llamada de visión completa — multiplicado por cada conversación.
//
// Todo lo que sale de aquí termina DENTRO del prompt de Claudia en cada
// mensaje, así que el tamaño no es una preocupación de almacenamiento
// sino de costo por conversación: de ahí el tope de `MAX_CARACTERES`.
// ============================================================

import { convert as htmlATexto } from 'html-to-text';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

/**
 * Tope del texto de UNA fuente. Unos 40 000 caracteres son ~10 000
 * tokens: mucho para un solo documento, pero asumible dentro del bloque
 * cacheado del prompt. Se trunca con aviso en vez de rechazar el
 * archivo: media lista de precios sirve más que ninguna, siempre que
 * quede claro que está cortada.
 */
export const MAX_CARACTERES = 40_000;

/** Cuánto se espera a que responda una URL antes de rendirse. */
const TIMEOUT_URL_MS = 15_000;

/** Describir una imagen densa tarda más; es una operación de alta, no de respuesta. */
const TIMEOUT_VISION_MS = 60_000;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ResultadoExtraccion {
  texto: string;
  /** Mensaje en español para mostrarle al administrador. Vacío si salió bien. */
  error: string;
}

function truncar(texto: string): string {
  const limpio = texto.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (limpio.length <= MAX_CARACTERES) return limpio;
  return (
    limpio.slice(0, MAX_CARACTERES) +
    '\n\n[…] Este documento se cortó aquí porque excede el tamaño que Claudia ' +
    'puede llevar en cada conversación.'
  );
}

/** Extensión en minúsculas, sin punto. Cadena vacía si no tiene. */
export function extensionDe(nombre: string): string {
  const m = /\.([^.]+)$/.exec(nombre);
  return m ? m[1].toLowerCase() : '';
}

const EXT_TEXTO = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml']);
const EXT_IMAGEN = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function tipoPorExtension(nombre: string): 'documento' | 'imagen' {
  return EXT_IMAGEN.has(extensionDe(nombre)) ? 'imagen' : 'documento';
}

/**
 * Documentos: PDF, Word y texto plano.
 *
 * `pdf-parse` y `mammoth` se importan de forma perezosa a propósito.
 * Ambas son pesadas y arrastran binarios; cargarlas al importar este
 * módulo las metería en el arranque de cualquier ruta que solo quiera
 * `extensionDe`.
 */
export async function extraerDocumento(
  buffer: Buffer,
  nombre: string,
): Promise<ResultadoExtraccion> {
  const ext = extensionDe(nombre);

  try {
    if (ext === 'pdf') {
      // pdf-parse v2 expone una clase, no una función por omisión: la v1
      // se importaba con `default` y esa forma ya no existe.
      const { PDFParse } = await import('pdf-parse');
      const lector = new PDFParse({ data: new Uint8Array(buffer) });
      const datos = await lector.getText();
      const texto = (datos.text ?? '').trim();
      if (!texto) {
        // Caso real y frecuente: un PDF que es una foto de un documento.
        // El archivo se procesa sin error pero no contiene ni un
        // carácter, y sin este aviso el administrador vería una fuente
        // "lista" que no le enseñó nada a Claudia.
        return {
          texto: '',
          error:
            'El PDF no contiene texto seleccionable. Suele pasar con documentos ' +
            'escaneados: prueba a subirlo como imagen para que Claudia lo lea.',
        };
      }
      return { texto: truncar(texto), error: '' };
    }

    if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer });
      const texto = (value ?? '').trim();
      if (!texto) return { texto: '', error: 'El documento de Word está vacío.' };
      return { texto: truncar(texto), error: '' };
    }

    if (ext === 'doc') {
      // `mammoth` solo lee el formato nuevo. Decirlo explícitamente
      // ahorra el "no funcionó y no sé por qué".
      return {
        texto: '',
        error: 'El formato .doc antiguo no se puede leer. Guarda el archivo como .docx.',
      };
    }

    if (EXT_TEXTO.has(ext) || ext === '') {
      const texto = buffer.toString('utf8').trim();
      if (!texto) return { texto: '', error: 'El archivo está vacío.' };
      return { texto: truncar(texto), error: '' };
    }

    return {
      texto: '',
      error: `No sé leer archivos .${ext}. Formatos admitidos: PDF, DOCX, TXT, MD, CSV.`,
    };
  } catch (e) {
    return {
      texto: '',
      error: `No se pudo leer el archivo: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * URLs: descarga la página y la reduce a texto legible.
 *
 * La validación anti-SSRF NO es opcional. Sin ella, este endpoint es un
 * proxy con el que cualquiera con acceso al panel podría hacer que el
 * servidor consulte direcciones de la red interna —incluidos los
 * metadatos de la nube— y le devuelva el contenido en la pantalla. Se
 * reutiliza la misma guardia que protege la entrega de webhooks.
 */
export async function extraerUrl(url: string): Promise<ResultadoExtraccion> {
  let destino: URL;
  try {
    destino = new URL(url);
  } catch {
    return { texto: '', error: 'La dirección no es válida.' };
  }

  if (destino.protocol !== 'http:' && destino.protocol !== 'https:') {
    return { texto: '', error: 'Solo se pueden leer direcciones http y https.' };
  }

  if (!(await isDeliverableUrl(destino.toString()))) {
    return {
      texto: '',
      error: 'Esa dirección apunta a la red interna y no se puede consultar.',
    };
  }

  try {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_URL_MS);
    let r: Response;
    try {
      r = await fetch(destino, {
        signal: control.signal,
        // `manual` para que una redirección no sea un rodeo alrededor de
        // la validación de arriba: el destino final nunca se comprobó.
        redirect: 'manual',
        headers: { 'User-Agent': 'wacrm-claudia/1.0' },
      });
    } finally {
      clearTimeout(reloj);
    }

    if (r.status >= 300 && r.status < 400) {
      return {
        texto: '',
        error: 'La dirección redirige a otro sitio. Usa la dirección final.',
      };
    }
    if (!r.ok) {
      return { texto: '', error: `El sitio respondió ${r.status}.` };
    }

    const crudo = await r.text();
    const texto = htmlATexto(crudo, {
      wordwrap: false,
      selectors: [
        // Menús, pies de página y scripts no son conocimiento: meterlos
        // gastaría tokens en cada conversación para enseñarle a Claudia
        // cómo se navega un sitio web.
        { selector: 'nav', format: 'skip' },
        { selector: 'footer', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    }).trim();

    if (!texto) {
      return {
        texto: '',
        error:
          'La página no tiene texto legible. Suele pasar con sitios que se ' +
          'arman con JavaScript en el navegador.',
      };
    }
    return { texto: truncar(texto), error: '' };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError'
      ? 'El sitio tardó demasiado en responder.'
      : `No se pudo leer la página: ${e instanceof Error ? e.message : String(e)}`;
    return { texto: '', error: msg };
  }
}

/**
 * Imágenes: se describen UNA vez con Claude y se guarda la descripción.
 *
 * La alternativa —guardar la imagen y mandársela a Claude en cada
 * conversación— multiplicaría el costo por cada cliente que escriba, y
 * además rompería el caché del prompt. Describirla al subirla la
 * convierte en texto estable, que es exactamente lo que el resto del
 * módulo sabe manejar.
 */
export async function extraerImagen(
  buffer: Buffer,
  nombre: string,
  apiKey: string,
): Promise<ResultadoExtraccion> {
  if (!apiKey) {
    return {
      texto: '',
      error:
        'Para leer imágenes hace falta una clave de Anthropic configurada en ' +
        'Ajustes. Sin ella la imagen se guarda, pero Claudia no la puede usar.',
    };
  }

  const ext = extensionDe(nombre);
  const tipoMedia =
    ext === 'png' ? 'image/png'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg';

  // Se llama por `fetch` y no con el SDK oficial porque es lo que ya hace
  // src/lib/ai/providers/anthropic.ts. Traer el paquete entero por una
  // sola función de visión no se paga.
  try {
    const respuesta = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_VISION_MS),
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2_000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: tipoMedia,
                  data: buffer.toString('base64'),
                },
              },
              {
                // Se pide transcripción literal antes que interpretación:
                // estas imágenes suelen ser listas de precios, fichas
                // técnicas o catálogos, y un resumen elegante que pierda una
                // cifra convierte a Claudia en una fuente de datos
                // equivocados frente al cliente.
                type: 'text',
                text:
                  'Esta imagen es material de referencia de una empresa. ' +
                  'Transcribe TODO el texto que contenga de forma literal y ' +
                  'completa: cifras, códigos, medidas y precios exactos, sin ' +
                  'redondear ni resumir. Si hay una tabla, consérvala como ' +
                  'tabla. Después, en un párrafo aparte, describe brevemente ' +
                  'qué muestra la imagen. Responde en español y sin preámbulos.',
              },
            ],
          },
        ],
      }),
    });

    if (!respuesta.ok) {
      // Solo el código: el cuerpo del error de Anthropic puede incluir
      // detalles de la organización que no tienen por qué acabar en la
      // pantalla de un administrador.
      return {
        texto: '',
        error: `Anthropic respondió ${respuesta.status} al leer la imagen.`,
      };
    }

    const cuerpo = (await respuesta.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const texto = (cuerpo.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();

    if (!texto) return { texto: '', error: 'No se pudo describir la imagen.' };
    return { texto: truncar(texto), error: '' };
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'TimeoutError'
        ? 'La lectura de la imagen tardó demasiado.'
        : `No se pudo leer la imagen: ${e instanceof Error ? e.message : String(e)}`;
    return { texto: '', error: msg };
  }
}
