// Constantes y utilidades de las imágenes de promociones de Claudia
// (migración 050). Las comparten las rutas y la pantalla «Anuncios».

export const BUCKET_PROMOS = 'claudia-promos';

/** Máximo de imágenes por cuenta. */
export const MAX_IMAGENES = 10;

/** 5 MB, el mismo tope que declara el bucket en la migración 050. */
export const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;

/**
 * Extensión según los PRIMEROS BYTES del archivo, no según su nombre ni
 * el tipo que declare el navegador: ambos los controla quien sube.
 * WhatsApp solo acepta JPEG y PNG como imagen. Devuelve null para
 * cualquier otra cosa.
 */
export function extensionPorBytes(bytes: Uint8Array): 'jpg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  return null;
}
