import { describe, it, expect } from 'vitest';
import {
  restrictsContactsToAssigned,
  fetchAssignedContactIds,
  canViewContact,
  isRestrictedOrUnknown,
} from './visibility';

describe('restrictsContactsToAssigned', () => {
  it('solo restringe a agent y viewer', () => {
    expect(restrictsContactsToAssigned('agent')).toBe(true);
    expect(restrictsContactsToAssigned('viewer')).toBe(true);
    expect(restrictsContactsToAssigned('admin')).toBe(false);
    expect(restrictsContactsToAssigned('owner')).toBe(false);
    expect(restrictsContactsToAssigned(null)).toBe(false);
  });
});

describe('fetchAssignedContactIds', () => {
  it('junta los contact_id de todas las páginas, sin nulos ni repetidos', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ contact_id: `c${i}` })),
      [{ contact_id: 'c0' }, { contact_id: null }, { contact_id: 'x' }],
    ];
    let call = 0;
    const filtros: unknown[] = [];
    const supabase = {
      from: () => ({
        select: () => ({
          eq: (col: string, val: string) => {
            filtros.push([col, val]);
            return { range: async () => ({ data: pages[call++], error: null }) };
          },
        }),
      }),
    };
    const ids = await fetchAssignedContactIds(supabase as never, 'u1');
    expect(ids.size).toBe(1001);
    expect(ids.has('x')).toBe(true);
    expect(filtros[0]).toEqual(['assigned_agent_id', 'u1']);
  });
});

describe('isRestrictedOrUnknown', () => {
  it('restringe a agent, viewer y al rol aún desconocido (falla cerrado)', () => {
    expect(isRestrictedOrUnknown(null)).toBe(true)
    expect(isRestrictedOrUnknown('agent')).toBe(true)
    expect(isRestrictedOrUnknown('viewer')).toBe(true)
    expect(isRestrictedOrUnknown('admin')).toBe(false)
    expect(isRestrictedOrUnknown('owner')).toBe(false)
  })
})

describe('canViewContact', () => {
  const fake = (result: { count: number | null; error: unknown }) => {
    const filtros: [string, unknown][] = []
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filtros.push([col, val])
        return filtros.length === 2 ? Promise.resolve(result) : chain
      },
    }
    return { db: { from: () => chain } as never, filtros }
  }

  it('true si hay una conversación asignada a ese usuario con ese contacto', async () => {
    const { db, filtros } = fake({ count: 1, error: null })
    expect(await canViewContact(db, 'u1', 'c9')).toBe(true)
    expect(filtros).toEqual([['contact_id', 'c9'], ['assigned_agent_id', 'u1']])
  })

  it('false si no hay ninguna, y falla cerrado ante un error de consulta', async () => {
    expect(await canViewContact(fake({ count: 0, error: null }).db, 'u1', 'c9')).toBe(false)
    expect(await canViewContact(fake({ count: null, error: new Error('x') }).db, 'u1', 'c9')).toBe(false)
  })
})
