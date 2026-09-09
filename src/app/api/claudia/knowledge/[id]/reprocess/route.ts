import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { BUCKET_CONOCIMIENTO, extraerFuente } from '@/lib/claudia/ingesta';

type Params = { params: Promise<{ id: string }> };

const CAMPOS = 'id, tipo, titulo, origen, estado, error, bytes, activo, creado';

/**
 * POST /api/claudia/knowledge/[id]/reprocess (admin+)
 *
 * Vuelve a extraer el texto de una fuente ya dada de alta. Sirve para
 * los dos casos que dejan una fila en `error` de forma recuperable: una
 * imagen que no se pudo describir porque faltaba la clave de Anthropic, y
 * una URL que estaba caída en ese momento. También refresca una URL cuyo
 * contenido cambió, que es la única fuente que puede quedar obsoleta sola.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { data: fila, error: errLectura } = await supabase
      .from('claudia_knowledge')
      .select('id, tipo, origen, storage_path')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (errLectura) {
      console.error('[claudia/knowledge reprocess] lectura:', errLectura);
      return NextResponse.json({ error: 'No se pudo leer la fuente' }, { status: 500 });
    }
    if (!fila) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });

    let buffer: Buffer | undefined;
    if (fila.tipo !== 'url') {
      if (!fila.storage_path) {
        // Pasa cuando la subida a Storage falló en el alta pero la
        // extracción sí funcionó: la fila quedó útil, pero sin original
        // que releer. Decirlo es más honesto que reprocesar a vacío y
        // dejar la fuente peor de como estaba.
        return NextResponse.json(
          {
            error:
              'No se conservó el archivo original de esta fuente. Bórrala y vuelve a subirla.',
          },
          { status: 400 },
        );
      }
      const { data: descarga, error: errDescarga } = await supabase.storage
        .from(BUCKET_CONOCIMIENTO)
        .download(fila.storage_path);
      if (errDescarga || !descarga) {
        console.error('[claudia/knowledge reprocess] descarga:', errDescarga);
        return NextResponse.json(
          { error: 'No se pudo recuperar el archivo original' },
          { status: 500 },
        );
      }
      buffer = Buffer.from(await descarga.arrayBuffer());
    }

    const resultado = await extraerFuente(supabase, accountId, {
      tipo: fila.tipo as 'documento' | 'imagen' | 'url',
      origen: fila.origen,
      buffer,
    });

    const { data, error } = await supabase
      .from('claudia_knowledge')
      // `actualizado` no va aquí: lo pone Postgres con el trigger de la
      // migración 045. Escribirlo desde Node mezclaba el reloj de la
      // aplicación con el de la base, que no van sincronizados.
      .update({
        texto: resultado.texto,
        estado: resultado.error ? 'error' : 'listo',
        error: resultado.error.slice(0, 500),
      })
      .eq('account_id', accountId)
      .eq('id', id)
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/knowledge reprocess] update:', error);
      return NextResponse.json({ error: 'No se pudo guardar el resultado' }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}
