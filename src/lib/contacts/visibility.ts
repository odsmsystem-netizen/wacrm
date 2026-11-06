import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountRole } from '@/lib/auth/roles';

/**
 * Visibilidad de contactos por rol — filtro de APLICACIÓN.
 *
 * owner y admin ven todos los contactos. agent y viewer solo los que
 * tienen una conversación asignada a ellos. Ojo: esto NO lo hace cumplir
 * la base de datos (no hay RLS sobre `contacts` por asignación): un
 * usuario con su JWT aún podría consultar la tabla directamente.
 */
export function restrictsContactsToAssigned(
  role: AccountRole | null,
): boolean {
  return role === 'agent' || role === 'viewer';
}

const PAGE = 1000;

/**
 * Ids de los contactos con una conversación asignada a `userId`.
 * (RLS de `conversations`, migración 051, ya limita a las del usuario;
 * el `.eq` es explícito por claridad.)
 */
export async function fetchAssignedContactIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('conversations')
      .select('contact_id')
      .eq('assigned_agent_id', userId)
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    for (const row of data as { contact_id: string | null }[]) {
      if (row.contact_id) ids.add(row.contact_id);
    }
    if (data.length < PAGE) break;
  }
  return ids;
}

/**
 * ¿Tiene `userId` una conversación asignada con este contacto?
 * Falla cerrado: un error de consulta cuenta como "no".
 */
export async function canViewContact(
  supabase: SupabaseClient,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('assigned_agent_id', userId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Rol restringido, o rol aún desconocido: ante la duda se restringe, para no
 * mostrar ni usar contactos ajenos mientras se resuelve el rol.
 */
export function isRestrictedOrUnknown(role: AccountRole | null): boolean {
  return role === null || restrictsContactsToAssigned(role);
}
