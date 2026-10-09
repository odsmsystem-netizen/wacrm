// Base en memoria con la parte mínima de la API de Supabase que usa el código
// de Messenger. Modela las dos restricciones únicas que importan (contactos por
// PSID y mensajes por `mid`) para poder probar reintentos y carreras.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>

const UNIQUE_KEYS: Record<string, string[]> = {
  contacts: ['account_id', 'channel', 'external_id'],
  messages: ['conversation_id', 'message_id'],
  messenger_config: ['account_id'],
}

export function makeFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  const rpcCalls: Array<{ name: string; args: Row }> = []
  let idSeq = 0

  function from(table: string) {
    const rows = (tables[table] ??= [])
    const filters: Array<[string, unknown]> = []
    let limitN = Infinity
    let orderBy: { column: string; ascending: boolean } | null = null
    let op: { kind: 'select' | 'insert' | 'upsert' | 'update' | 'delete'; payload?: Row; ignore?: boolean } = {
      kind: 'select',
    }

    const matching = () => {
      const hit = rows.filter((r) => filters.every(([c, v]) => r[c] === v))
      if (orderBy) {
        const { column, ascending } = orderBy
        // Array.prototype.sort es estable: los empates conservan el orden de inserción.
        hit.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
      }
      return hit.slice(0, limitN)
    }
    const duplicateOf = (row: Row) => {
      const keys = UNIQUE_KEYS[table]
      return keys ? rows.find((r) => keys.every((k) => r[k] === row[k])) : undefined
    }

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      if (op.kind === 'insert' || op.kind === 'upsert') {
        const row = { id: `${table}-${++idSeq}`, created_at: new Date().toISOString(), ...op.payload }
        const dup = duplicateOf(row)
        if (dup) {
          if (op.kind === 'upsert' && op.ignore) return { data: [], error: null }
          if (op.kind === 'upsert') {
            Object.assign(dup, op.payload)
            return { data: [dup], error: null }
          }
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
        rows.push(row)
        return { data: [row], error: null }
      }
      if (op.kind === 'delete') {
        const hit = matching()
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1))
        return { data: hit, error: null }
      }
      if (op.kind === 'update') {
        const hit = matching()
        hit.forEach((r) => Object.assign(r, op.payload))
        return { data: hit, error: null }
      }
      return { data: matching(), error: null }
    }

    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
      order: (column: string, o?: { ascending?: boolean }) => (
        (orderBy = { column, ascending: o?.ascending ?? true }), builder
      ),
      limit: (n: number) => ((limitN = n), builder),
      insert: (p: Row) => ((op = { kind: 'insert', payload: p }), builder),
      upsert: (p: Row, o?: { ignoreDuplicates?: boolean }) => (
        (op = { kind: 'upsert', payload: p, ignore: o?.ignoreDuplicates }), builder
      ),
      delete: () => ((op = { kind: 'delete' }), builder),
      update: (p: Row) => ((op = { kind: 'update', payload: p }), builder),
      maybeSingle: async () => {
        const r = run()
        return { data: r.data?.[0] ?? null, error: r.error }
      },
      single: async () => {
        const r = run()
        return { data: r.data?.[0] ?? null, error: r.error }
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return builder
  }

  return {
    from,
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args })
      return { error: null }
    },
    tables,
    rpcCalls,
  }
}
