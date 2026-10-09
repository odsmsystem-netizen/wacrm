// Dominio público de una petición. Detrás del proxy de Dokploy `request.url`
// trae el host interno del contenedor (0.0.0.0:3000), así que el dominio real
// se reconstruye desde los encabezados que el proxy reenvía.
export function requestOrigin(request: Request): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || undefined
  const url = new URL(request.url)
  const host = first(request.headers.get('x-forwarded-host')) ?? first(request.headers.get('host'))
  const proto =
    first(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(':', '')
  return host ? `${proto}://${host}` : url.origin
}
