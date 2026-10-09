import { describe, expect, it } from 'vitest';
import { decidirEstado, puedeAplicarGet } from './toggle-estado';

describe('decidirEstado', () => {
  it('pinta activa o inactiva solo con un booleano real', () => {
    expect(decidirEstado({ activa: true }, 'cargando')).toBe('activa');
    expect(decidirEstado({ activa: false }, 'cargando')).toBe('inactiva');
    expect(decidirEstado({ activa: false }, 'activa')).toBe('inactiva');
    expect(decidirEstado({ activa: true }, 'inactiva')).toBe('activa');
  });

  it('nunca pinta verde por omisión: una respuesta rara conserva el estado anterior', () => {
    for (const rara of [null, undefined, {}, [], 'x', 0, { activa: 'false' }, { activa: null }, { activa: 1 }]) {
      expect(decidirEstado(rara, 'inactiva')).toBe('inactiva');
      expect(decidirEstado(rara, 'activa')).toBe('activa');
    }
  });

  it('en la primera carga una respuesta rara deja el botón oculto, no verde', () => {
    expect(decidirEstado({}, 'cargando')).toBe('oculto');
    expect(decidirEstado(null, 'cargando')).toBe('oculto');
  });

  it('una respuesta rara no resucita un botón oculto', () => {
    expect(decidirEstado({}, 'oculto')).toBe('oculto');
  });
});

describe('puedeAplicarGet', () => {
  it('se aplica si no hubo clic desde que salió y no hay PATCH pendiente', () => {
    expect(puedeAplicarGet({ versionAlSalir: 3, versionActual: 3, patchPendiente: false })).toBe(true);
  });

  it('se descarta si hubo un clic después de que salió', () => {
    expect(puedeAplicarGet({ versionAlSalir: 3, versionActual: 4, patchPendiente: false })).toBe(false);
  });

  it('se descarta mientras haya un PATCH pendiente', () => {
    expect(puedeAplicarGet({ versionAlSalir: 3, versionActual: 3, patchPendiente: true })).toBe(false);
  });
});
