import { describe, expect, it, vi } from 'vitest';

// La guardia anti-SSRF se simula porque hace resolución DNS real. Lo que
// estas pruebas verifican es que `extraerUrl` la CONSULTE y respete su
// veredicto — no cómo resuelve ella los nombres, que ya tiene sus propias
// pruebas en src/lib/webhooks/.
const mockDeliverable = vi.fn();
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: (u: string) => mockDeliverable(u),
}));

import {
  MAX_CARACTERES,
  extensionDe,
  extraerDocumento,
  extraerUrl,
  tipoPorExtension,
} from './extraccion';
import { rutaConocimiento } from './ingesta';

describe('extensionDe', () => {
  it('normaliza a minúsculas', () => {
    expect(extensionDe('Lista.PDF')).toBe('pdf');
  });

  it('devuelve vacío cuando no hay extensión', () => {
    expect(extensionDe('README')).toBe('');
  });

  it('toma solo la última extensión', () => {
    expect(extensionDe('respaldo.tar.gz')).toBe('gz');
  });
});

describe('tipoPorExtension', () => {
  it('reconoce las imágenes', () => {
    expect(tipoPorExtension('catalogo.jpg')).toBe('imagen');
    expect(tipoPorExtension('logo.PNG')).toBe('imagen');
  });

  it('todo lo demás es documento', () => {
    // Incluye lo desconocido: `extraerDocumento` es quien da el mensaje
    // de "no sé leer .xyz", y lo hace nombrando la extensión. Clasificar
    // un .xyz como imagen lo mandaría a la ruta de visión, que gastaría
    // una llamada a Anthropic para fallar peor.
    expect(tipoPorExtension('precios.pdf')).toBe('documento');
    expect(tipoPorExtension('cosa.xyz')).toBe('documento');
  });
});

describe('extraerDocumento', () => {
  it('lee texto plano', async () => {
    const r = await extraerDocumento(Buffer.from('Cable de acero 3/8"'), 'notas.txt');
    expect(r.error).toBe('');
    expect(r.texto).toContain('Cable de acero');
  });

  it('trata un archivo sin extensión como texto', async () => {
    const r = await extraerDocumento(Buffer.from('hola'), 'LEEME');
    expect(r.error).toBe('');
    expect(r.texto).toBe('hola');
  });

  it('avisa cuando el archivo está vacío', async () => {
    // Sin este aviso la fuente quedaría "lista" sin haberle enseñado
    // nada a Claudia, y nadie se enteraría hasta que un cliente pregunte.
    const r = await extraerDocumento(Buffer.from('   '), 'vacio.txt');
    expect(r.texto).toBe('');
    expect(r.error).toContain('vacío');
  });

  it('explica que el .doc antiguo no se puede leer', async () => {
    const r = await extraerDocumento(Buffer.from('x'), 'viejo.doc');
    expect(r.error).toContain('.docx');
  });

  it('nombra la extensión que no sabe leer', async () => {
    const r = await extraerDocumento(Buffer.from('x'), 'hoja.xlsx');
    expect(r.error).toContain('xlsx');
  });

  it('trunca lo que excede el tope y lo dice', async () => {
    // El texto viaja dentro del prompt en CADA conversación: sin tope, un
    // solo archivo encarecería todos los mensajes de la cuenta.
    const enorme = 'a'.repeat(MAX_CARACTERES + 5_000);
    const r = await extraerDocumento(Buffer.from(enorme), 'grande.txt');
    expect(r.error).toBe('');
    expect(r.texto.length).toBeLessThan(enorme.length);
    expect(r.texto).toContain('se cortó aquí');
  });
});

describe('extraerUrl', () => {
  it('rechaza lo que no es una dirección', async () => {
    const r = await extraerUrl('no es una url');
    expect(r.texto).toBe('');
    expect(r.error).toContain('no es válida');
  });

  it('rechaza esquemas que no son http', async () => {
    // `file://` leería archivos del propio servidor.
    const r = await extraerUrl('file:///etc/passwd');
    expect(r.texto).toBe('');
    expect(r.error).toContain('http');
  });

  it('respeta el veto de la guardia anti-SSRF', async () => {
    // La prueba que importa de seguridad: sin esto, el panel sería un
    // proxy para leer la red interna —incluidos los metadatos de la
    // nube— y mostrar el resultado en pantalla.
    mockDeliverable.mockResolvedValueOnce(false);
    const r = await extraerUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.texto).toBe('');
    expect(r.error).toContain('red interna');
  });
});

describe('rutaConocimiento', () => {
  it('aísla por cuenta con el prefijo del proyecto', () => {
    // Las políticas de Storage de la migración 042 casan contra
    // 'account-<uuid>' como primer segmento. Otro prefijo haría que la
    // subida fuera rechazada por RLS, no que se guardara mal.
    const ruta = rutaConocimiento('abc-123', 'lista.pdf');
    expect(ruta.startsWith('account-abc-123/')).toBe(true);
  });

  it('sanea nombres con espacios y acentos', () => {
    const ruta = rutaConocimiento('c1', 'Lista de precios ñ.pdf');
    expect(ruta).toMatch(/^account-c1\/\d+-[A-Za-z0-9_-]+\.pdf$/);
  });

  it('conserva la extensión para que la extracción sepa qué es', () => {
    // `extraerDocumento` decide el parser por la extensión: perderla
    // mandaría un PDF por la rama de texto plano y saldría basura.
    expect(rutaConocimiento('c1', 'x.docx').endsWith('.docx')).toBe(true);
  });

  it('no deja un archivo sin nombre', () => {
    expect(rutaConocimiento('c1', '.gitignore')).toContain('archivo');
  });
});
