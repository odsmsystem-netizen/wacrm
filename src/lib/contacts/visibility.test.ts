import { describe, it, expect } from 'vitest';
import {
  restrictsContactsToAssigned,
  fetchAssignedContactIds,
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
