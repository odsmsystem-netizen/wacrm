import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  BUCKET_PROMOS,
  MAX_BYTES_IMAGEN,
  MAX_IMAGENES,
  extensionPorBytes,
} from '@/lib/claudia/promos-imagenes';

const CAMPOS = 'id, nombre, tamano, orden';

/** Agrega la URL pública (el bucket es público: Meta la baja sin autenticar). */
function conUrl<T extends object>(supabase: SupabaseClient, ruta: string, fila: T) {
  const { data } = supabase.storage.from(BUCKET_PROMOS).getPublicUrl(ruta);
  return { ...fila, url: data.publicUrl };
}

/**
 * GET /api/claudia/promociones/imagenes — imágenes de la cuenta, en orden.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('claudia_promociones_imagenes')
      .select(`${CAMPOS}, ruta`)
      .eq('account_id', accountId)
      .order('orden', { ascending: true });
    if (error) {
      console.error('[claudia/promociones/imagenes GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudieron cargar las imágenes' },
        { status: 500 },
      );
    }
    const imagenes = (data ?? []).map(({ ruta, ...resto }) =>
      conUrl(supabase, ruta, resto),
    );
    return NextResponse.json({ imagenes });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/claudia/promociones/imagenes (admin+) — sube UNA imagen.
 *
 * `multipart/form-data` con el campo `archivo`. Una por petición a
 * propósito: la pantalla las sube en serie y puede decir cuál falló.
 * Sube con el cliente del usuario: la RLS de Storage garantiza que solo
 * escriba dentro de la carpeta de su cuenta.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-promos:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const form = await request.formData().catch(() => null);
    const archivo = form?.get('archivo');
    if (!(archivo instanceof File)) {
      return NextResponse.json({ error: 'Falta el archivo' }, { status: 400 });
    }
    if (archivo.size === 0) {
      return NextResponse.json({ error: 'El archivo está vacío' }, { status: 400 });
    }
    if (archivo.size > MAX_BYTES_IMAGEN) {
      return NextResponse.json(
        { error: `La imagen supera el límite de ${MAX_BYTES_IMAGEN / 1024 / 1024} MB` },
        { status: 400 },
      );
    }

    // Tipo por los primeros bytes: el nombre y el Content-Type los
    // controla quien sube, y un .jpg que en realidad es otra cosa haría
    // fallar el envío por WhatsApp mucho después, sin que nadie sepa por qué.
    const buffer = Buffer.from(await archivo.arrayBuffer());
    const extension = extensionPorBytes(buffer);
    if (!extension) {
      return NextResponse.json(
        { error: 'Solo se admiten imágenes JPEG o PNG' },
        { status: 400 },
      );
    }

    // Como mucho 10 filas por cuenta: traerlas es más barato que dos consultas.
    const { data: existentes, error: errLista } = await supabase
      .from('claudia_promociones_imagenes')
      .select('orden')
      .eq('account_id', accountId);
    if (errLista) {
      console.error('[claudia/promociones/imagenes POST] conteo:', errLista);
      return NextResponse.json({ error: 'No se pudo guardar la imagen' }, { status: 500 });
    }
    const filas = existentes ?? [];
    if (filas.length >= MAX_IMAGENES) {
      return NextResponse.json(
        { error: `Ya hay ${MAX_IMAGENES} imágenes, que es el máximo. Borra alguna para subir otra.` },
        { status: 409 },
      );
    }
    const orden = filas.reduce((m, f) => Math.max(m, Number(f.orden) || 0), -1) + 1;

    const ruta = `${accountId}/${randomUUID()}.${extension}`;
    const { error: errSubida } = await supabase.storage
      .from(BUCKET_PROMOS)
      .upload(ruta, buffer, {
        contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
        upsert: false,
      });
    if (errSubida) {
      console.error('[claudia/promociones/imagenes POST] subida:', errSubida);
      return NextResponse.json({ error: 'No se pudo subir la imagen' }, { status: 500 });
    }

    const { data, error } = await supabase
      .from('claudia_promociones_imagenes')
      .insert({
        account_id: accountId,
        ruta,
        nombre: archivo.name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Promoción',
        tamano: archivo.size,
        orden,
      })
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/promociones/imagenes POST] insert:', error);
      // Sin huérfanos: el archivo ya está en el bucket y ninguna fila lo apunta.
      const { error: errBorrado } = await supabase.storage.from(BUCKET_PROMOS).remove([ruta]);
      if (errBorrado) {
        console.warn('[claudia/promociones/imagenes POST] objeto huérfano:', errBorrado);
      }
      return NextResponse.json({ error: 'No se pudo guardar la imagen' }, { status: 500 });
    }

    return NextResponse.json(conUrl(supabase, ruta, data), { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
