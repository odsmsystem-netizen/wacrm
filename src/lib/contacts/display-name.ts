/**
 * Nombre para mostrar de un contacto. Un contacto de Messenger no tiene
 * teléfono, así que `contact.name || contact.phone` dejaría de ser un string;
 * esta función es la única que decide el orden de respaldo.
 */
export function contactDisplayName(
  contact:
    | { name?: string | null; phone?: string | null; external_id?: string | null }
    | null
    | undefined,
  fallback = '',
): string {
  return contact?.name || contact?.phone || contact?.external_id || fallback
}
