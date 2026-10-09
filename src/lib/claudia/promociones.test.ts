import { describe, expect, it } from 'vitest';
import {
  estadoPromociones,
  promocionesVigentes,
  validarHorario,
  valoresPorOmision,
  type PromocionesConfig,
} from './promociones';

/** Configuración encendida con el horario por omisión (lun-vie 09:00-18:00). */
const base: PromocionesConfig = { ...valoresPorOmision, activas: true };

/**
 * México no tiene horario de verano desde 2022: America/Mexico_City es
 * UTC-6 todo el año. Por eso las fechas de prueba se escriben en UTC
 * sumando 6 horas a la hora local que se quiere simular.
 */
const mx = (iso: string) => new Date(`${iso}-06:00`);

describe('valoresPorOmision', () => {
  it('coincide con el contrato', () => {
    expect(valoresPorOmision).toEqual({
      activas: false,
      siempre: false,
      texto: '',
      dias: [1, 2, 3, 4, 5],
      inicio: '09:00',
      fin: '18:00',
      zona: 'America/Mexico_City',
    });
  });
});

describe('promocionesVigentes', () => {
  it('es falsa por omisión (apagadas)', () => {
    expect(promocionesVigentes(valoresPorOmision, mx('2026-10-07T12:00:00'))).toBe(false);
  });

  it('dentro del horario en día hábil es verdadera', () => {
    // 2026-10-07 es miércoles.
    expect(promocionesVigentes(base, mx('2026-10-07T12:00:00'))).toBe(true);
  });

  it('fuera del horario (antes y después) es falsa', () => {
    expect(promocionesVigentes(base, mx('2026-10-07T08:59:00'))).toBe(false);
    expect(promocionesVigentes(base, mx('2026-10-07T20:00:00'))).toBe(false);
  });

  it('el inicio se incluye y el fin se excluye', () => {
    expect(promocionesVigentes(base, mx('2026-10-07T09:00:00'))).toBe(true);
    expect(promocionesVigentes(base, mx('2026-10-07T17:59:59'))).toBe(true);
    expect(promocionesVigentes(base, mx('2026-10-07T18:00:00'))).toBe(false);
  });

  it('respeta cada día de la semana (1 = lunes … 7 = domingo)', () => {
    // Semana del lunes 2026-10-05 al domingo 2026-10-11, mediodía.
    for (let dia = 1; dia <= 7; dia++) {
      const fecha = mx(`2026-10-${String(4 + dia).padStart(2, '0')}T12:00:00`);
      for (let otro = 1; otro <= 7; otro++) {
        expect(promocionesVigentes({ ...base, dias: [otro] }, fecha)).toBe(otro === dia);
      }
    }
  });

  it('el sábado y el domingo quedan fuera con el horario por omisión', () => {
    expect(promocionesVigentes(base, mx('2026-10-10T12:00:00'))).toBe(false);
    expect(promocionesVigentes(base, mx('2026-10-11T12:00:00'))).toBe(false);
  });

  it('"siempre" ignora el horario y los días', () => {
    const cfg = { ...base, siempre: true };
    expect(promocionesVigentes(cfg, mx('2026-10-10T03:00:00'))).toBe(true);
    expect(promocionesVigentes(cfg, mx('2026-10-07T23:59:00'))).toBe(true);
  });

  it('activas=false apaga todo aunque "siempre" esté encendido', () => {
    const cfg = { ...base, activas: false, siempre: true };
    expect(promocionesVigentes(cfg, mx('2026-10-07T12:00:00'))).toBe(false);
  });

  it('el cambio de día ocurre a la medianoche de México, no a la de UTC', () => {
    const cfg = { ...base, dias: [1], inicio: '00:00', fin: '23:59' };
    // Lunes 2026-10-05 23:30 en México = martes 05:30 UTC: sigue siendo lunes.
    expect(promocionesVigentes(cfg, new Date('2026-10-06T05:30:00Z'))).toBe(true);
    // Martes 00:00 en México = 06:00 UTC: ya no es lunes.
    expect(promocionesVigentes(cfg, new Date('2026-10-06T06:00:00Z'))).toBe(false);
    // Domingo 2026-10-04 23:59 en México = lunes 05:59 UTC: todavía es domingo.
    expect(promocionesVigentes(cfg, new Date('2026-10-05T05:59:00Z'))).toBe(false);
    expect(promocionesVigentes(cfg, new Date('2026-10-05T06:00:00Z'))).toBe(true);
  });

  it('una fecha en UTC que ya es otro día en México usa el día de México', () => {
    // 2026-10-10 02:00 UTC (sábado) = viernes 20:00 en México: fuera de hora
    // pero, con un horario nocturno, dentro del viernes.
    const cfg = { ...base, dias: [5], inicio: '18:00', fin: '23:00' };
    expect(promocionesVigentes(cfg, new Date('2026-10-10T02:00:00Z'))).toBe(true);
    expect(promocionesVigentes({ ...cfg, dias: [6] }, new Date('2026-10-10T02:00:00Z'))).toBe(false);
  });

  it('usa la hora de México, no la del servidor', () => {
    // 15:00 UTC = 09:00 en México.
    expect(promocionesVigentes(base, new Date('2026-10-07T15:00:00Z'))).toBe(true);
    expect(promocionesVigentes(base, new Date('2026-10-07T14:59:00Z'))).toBe(false);
  });
});

describe('estadoPromociones', () => {
  it('explica la razón', () => {
    const ahora = mx('2026-10-07T12:00:00');
    expect(estadoPromociones({ ...base, activas: false }, ahora)).toBe('apagadas');
    expect(estadoPromociones({ ...base, siempre: true }, ahora)).toBe('siempre');
    expect(estadoPromociones(base, ahora)).toBe('dentro');
    expect(estadoPromociones(base, mx('2026-10-07T20:00:00'))).toBe('fuera');
  });
});

describe('validarHorario', () => {
  it('acepta un horario válido', () => {
    expect(validarHorario({ dias: [1, 3, 5], inicio: '09:00', fin: '18:00' })).toEqual({ ok: true });
  });

  it('rechaza días vacíos, repetidos o fuera de 1..7', () => {
    expect(validarHorario({ dias: [], inicio: '09:00', fin: '18:00' })).toEqual({ ok: false, error: 'dias' });
    expect(validarHorario({ dias: [1, 1], inicio: '09:00', fin: '18:00' })).toEqual({ ok: false, error: 'dias' });
    expect(validarHorario({ dias: [0], inicio: '09:00', fin: '18:00' })).toEqual({ ok: false, error: 'dias' });
    expect(validarHorario({ dias: [8], inicio: '09:00', fin: '18:00' })).toEqual({ ok: false, error: 'dias' });
    expect(validarHorario({ dias: [1.5], inicio: '09:00', fin: '18:00' })).toEqual({ ok: false, error: 'dias' });
  });

  it('rechaza horas mal formadas', () => {
    for (const mala of ['9:00', '25:00', '12:60', '', 'abc', '09:00:00']) {
      expect(validarHorario({ dias: [1], inicio: mala, fin: '18:00' })).toEqual({ ok: false, error: 'formato' });
    }
  });

  it('exige inicio menor que fin', () => {
    expect(validarHorario({ dias: [1], inicio: '18:00', fin: '09:00' })).toEqual({ ok: false, error: 'orden' });
    expect(validarHorario({ dias: [1], inicio: '10:00', fin: '10:00' })).toEqual({ ok: false, error: 'orden' });
  });
});
