// `html-to-text` v10 no publica tipos propios y no existe @types para él.
// Se declara solo lo que este repo usa —`convert` con sus opciones— en vez
// de un `any` global: así un error al pasar los selectores sigue saliendo
// en compilación, que es de lo poco que protege a un extractor de HTML.
declare module 'html-to-text' {
  interface Selector {
    selector: string;
    format?: string;
    options?: Record<string, unknown>;
  }

  interface ConvertOptions {
    wordwrap?: number | false;
    selectors?: Selector[];
    limits?: { maxInputLength?: number };
    [clave: string]: unknown;
  }

  export function convert(html: string, options?: ConvertOptions): string;
}
