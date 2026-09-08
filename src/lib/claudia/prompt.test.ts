import { describe, expect, it } from 'vitest';
import { construirBloquePrompt, type ConfiguracionClaudia } from './prompt';
import { costOf, pricingFor } from './pricing';

function cfg(over: Partial<ConfiguracionClaudia> = {}): ConfiguracionClaudia {
  return {
    personalidad: 3,
    instruccionesExtra: '',
    conocimiento: [],
    comportamientos: [],
    ...over,
  };
}

describe('construirBloquePrompt', () => {
  it('no anexa nada cuando no hay configuración', () => {
    // Una cuenta sin configurar debe comportarse igual que antes de que
    // este módulo existiera, sin encabezados huérfanos en el prompt.
    expect(construirBloquePrompt(cfg())).toBe('');
  });

  it('omite la personalidad por omisión', () => {
    // El prompt base ya define el tono equilibrado; repetirlo gastaría
    // tokens diciendo lo mismo dos veces.
    expect(construirBloquePrompt(cfg({ personalidad: 3 }))).toBe('');
  });

  it('anexa la personalidad cuando se sale de la de por omisión', () => {
    const salida = construirBloquePrompt(cfg({ personalidad: 1 }));
    expect(salida).toContain('## Tono de tus respuestas');
    expect(salida).toContain('Trata de usted');
  });

  it('es estable byte por byte para la misma configuración', () => {
    // La prueba que protege el caché de Anthropic: si dos llamadas con
    // los mismos datos dieran textos distintos, el caché se caería en
    // cada turno y cada conversación costaría varias veces más.
    const datos = cfg({
      personalidad: 4,
      conocimiento: [
        { id: 'b', titulo: 'Políticas', tipo: 'documento', origen: 'p.pdf', texto: 'Uno' },
        { id: 'a', titulo: 'Catálogo', tipo: 'url', origen: 'https://x.mx', texto: 'Dos' },
      ],
      comportamientos: [
        { id: 'z', titulo: 'B', instruccion: 'Haz B', orden: 1 },
        { id: 'y', titulo: 'A', instruccion: 'Haz A', orden: 0 },
      ],
    });
    expect(construirBloquePrompt(datos)).toBe(construirBloquePrompt(datos));
  });

  it('no depende del orden en que vengan las filas de la base', () => {
    // Postgres no garantiza orden sin ORDER BY. Si el bloque cambiara
    // con el orden de llegada, el caché se caería de forma aleatoria.
    const a = construirBloquePrompt(
      cfg({
        conocimiento: [
          { id: '1', titulo: 'Alfa', tipo: 'documento', origen: '', texto: 'A' },
          { id: '2', titulo: 'Beta', tipo: 'documento', origen: '', texto: 'B' },
        ],
      }),
    );
    const b = construirBloquePrompt(
      cfg({
        conocimiento: [
          { id: '2', titulo: 'Beta', tipo: 'documento', origen: '', texto: 'B' },
          { id: '1', titulo: 'Alfa', tipo: 'documento', origen: '', texto: 'A' },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it('respeta el orden configurado de los comportamientos', () => {
    // La posición es información: cuando dos instrucciones se
    // contradicen, el modelo tiende a seguir la que va después.
    const salida = construirBloquePrompt(
      cfg({
        comportamientos: [
          { id: '1', titulo: 'Segundo', instruccion: 'B', orden: 2 },
          { id: '2', titulo: 'Primero', instruccion: 'A', orden: 1 },
        ],
      }),
    );
    expect(salida.indexOf('Primero')).toBeLessThan(salida.indexOf('Segundo'));
  });

  it('descarta fuentes cuyo texto no se pudo extraer', () => {
    // Un PDF escaneado sin texto queda con `texto` vacío. Anexarlo
    // metería un encabezado sin contenido debajo.
    const salida = construirBloquePrompt(
      cfg({
        conocimiento: [
          { id: '1', titulo: 'Vacío', tipo: 'documento', origen: 'x.pdf', texto: '   ' },
        ],
      }),
    );
    expect(salida).toBe('');
  });

  it('subordina los comportamientos a las reglas de seguridad', () => {
    // Un comportamiento lo escribe un administrador en texto libre.
    // Sin esta subordinación explícita, "sé flexible con los precios"
    // competiría de tú a tú con "nunca inventes datos".
    const salida = construirBloquePrompt(
      cfg({ comportamientos: [{ id: '1', titulo: 'T', instruccion: 'I', orden: 0 }] }),
    );
    expect(salida).toContain('NUNCA sobre las reglas de seguridad');
  });
});

describe('costOf', () => {
  it('cobra cada tipo de token a su propio precio', () => {
    // 1M de entrada a $3 + 1M de salida a $15 = $18.
    const usd = costOf('claude-sonnet-4-6', {
      tokensEntrada: 1_000_000,
      tokensSalida: 1_000_000,
      tokensCacheEscritura: 0,
      tokensCacheLectura: 0,
    });
    expect(usd).toBe(18);
  });

  it('cobra la lectura de caché mucho más barata que la entrada normal', () => {
    // Es el ahorro que justifica todo el diseño del prompt en bloques.
    const normal = costOf('claude-sonnet-4-6', {
      tokensEntrada: 1_000_000,
      tokensSalida: 0,
      tokensCacheEscritura: 0,
      tokensCacheLectura: 0,
    })!;
    const cacheado = costOf('claude-sonnet-4-6', {
      tokensEntrada: 0,
      tokensSalida: 0,
      tokensCacheEscritura: 0,
      tokensCacheLectura: 1_000_000,
    })!;
    expect(cacheado).toBeLessThan(normal / 5);
  });

  it('no inventa precio para un modelo desconocido', () => {
    // Un costo inventado se ve igual que uno real en pantalla, y el
    // administrador recargaría crédito con un número falso.
    expect(costOf('gpt-9', { tokensEntrada: 100, tokensSalida: 100, tokensCacheEscritura: 0, tokensCacheLectura: 0 })).toBeNull();
  });

  it('reconoce el modelo aunque traiga fecha pegada', () => {
    expect(pricingFor('claude-sonnet-4-6-20250514')).not.toBeNull();
  });

  it('prefiere el prefijo más largo cuando dos casan', () => {
    // `claude-3-5-haiku` no debe resolverse con una entrada más corta.
    expect(pricingFor('claude-3-5-haiku-20241022')?.input).toBe(0.8);
  });

  it('no redondea a cero un turno barato', () => {
    // Con caché, un turno puede costar menos de una milésima de dólar.
    // Redondear a centavos volvería invisible todo el consumo real.
    const usd = costOf('claude-sonnet-4-6', {
      tokensEntrada: 90,
      tokensSalida: 40,
      tokensCacheEscritura: 0,
      tokensCacheLectura: 10_000,
    })!;
    expect(usd).toBeGreaterThan(0);
  });
});
