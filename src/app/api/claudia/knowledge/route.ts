import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { tipoPorExtension } from '@/lib/claudia/extraccion';
import {
  BUCKET_CONOCIMIENTO,
  MAX_BYTES,
  extraerFuente,
  rutaConocimiento,
} from '@/lib/claudia/ingesta';

// `texto` se excluye a propósito del listado: una lista de precios puede
// pesar decenas de miles de caracteres y la pantalla solo enseña el
// título y el estado. Devolverlo multiplicaría por mil el peso de una
// petición que se hace cada vez que alguien abre la pestaña.
const CAMPOS = 'id, tipo, titulo, origen, estado, error, bytes, activo, creado';

/**
 * GET /api/claudia/knowledge — fuentes de la base de conocimiento.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('claudia_knowledge')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('creado', { ascending: false });
    if (error) {
      console.error('[claudia/knowledge GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudo cargar la base de conocimiento' },
        { status: 500 },
      );
    }
    return NextResponse.json({ documents: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/claudia/knowledge (admin+) — da de alta una fuente.
 *
 * Acepta `multipart/form-data` con el campo `file` (documento o imagen)
 * o JSON `{ tipo: 'url', url }`.
 *
 * La fila se guarda SIEMPRE, salga bien o mal la extracción. Una fuente
 * que falló y aparece en la lista con su motivo se puede reintentar; una
 * que nunca se guardó porque el PDF venía escaneado deja al
 * administrador sin saber qué pasó. Mismo criterio que la ruta de
 * knowledge del agente interno.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const contentType = request.headers.get('content-type') ?? '';

    let tipo: 'documento' | 'imagen' | 'url';
    let titulo: string;
    let origen: string;
    let bytes = 0;
    let buffer: Buffer | undefined;
    let storage_path = '';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const archivo = form.get('file');
      if (!(archivo instanceof File)) {
        return NextResponse.json({ error: 'Falta el archivo' }, { status: 400 });
      }
      if (archivo.size === 0) {
        return NextResponse.json({ error: 'El archivo está vacío' }, { status: 400 });
      }
      if (archivo.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `El archivo supera el límite de ${MAX_BYTES / 1024 / 1024} MB` },
          { status: 400 },
        );
      }

      buffer = Buffer.from(await archivo.arrayBuffer());
      bytes = archivo.size;
      origen = archivo.name;
      tipo = tipoPorExtension(archivo.name);
      const tituloForm = form.get('titulo');
      titulo =
        typeof tituloForm === 'string' && tituloForm.trim()
          ? tituloForm.trim()
          : archivo.name.replace(/\.[^.]+$/, '');

      // El original se guarda para que el administrador lo pueda volver a
      // ver. Si la subida falla NO se aborta el alta: lo que Claudia
      // consume es el texto, y perder el archivo de respaldo no vale
      // tirar una extracción que quizá salga bien.
      const ruta = rutaConocimiento(accountId, archivo.name);
      const { error: subidaErr } = await supabase.storage
        .from(BUCKET_CONOCIMIENTO)
        .upload(ruta, buffer, { contentType: archivo.type, upsert: false });
      if (subidaErr) {
        console.error('[claudia/knowledge POST] subida:', subidaErr);
      } else {
        storage_path = ruta;
      }
    } else {
      const body = await request.json().catch(() => null);
      const url = typeof body?.url === 'string' ? body.url.trim() : '';
      if (!url) {
        return NextResponse.json({ error: 'Falta la dirección' }, { status: 400 });
      }
      tipo = 'url';
      origen = url;
      titulo = typeof body?.titulo === 'string' && body.titulo.trim() ? body.titulo.trim() : url;
    }

    const resultado = await extraerFuente(supabase, accountId, { tipo, origen, buffer });

    const { data, error } = await supabase
      .from('claudia_knowledge')
      .insert({
        account_id: accountId,
        created_by: userId,
        tipo,
        titulo: titulo.slice(0, 200),
        origen: origen.slice(0, 500),
        storage_path,
        texto: resultado.texto,
        estado: resultado.error ? 'error' : 'listo',
        error: resultado.error.slice(0, 500),
        bytes,
      })
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/knowledge POST] insert:', error);
      return NextResponse.json(
        { error: 'No se pudo guardar la fuente' },
        { status: 500 },
      );
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
