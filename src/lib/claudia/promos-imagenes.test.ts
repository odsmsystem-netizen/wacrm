import { describe, expect, it } from 'vitest';
import { extensionPorBytes } from './promos-imagenes';

describe('extensionPorBytes', () => {
  it('reconoce JPEG por FF D8 FF', () => {
    expect(extensionPorBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpg');
  });

  it('reconoce PNG por 89 50 4E 47', () => {
    expect(extensionPorBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('png');
  });

  it('rechaza lo demás, aunque el nombre diga .jpg', () => {
    expect(extensionPorBytes(new TextEncoder().encode('<html>no soy imagen</html>'))).toBeNull();
    expect(extensionPorBytes(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(extensionPorBytes(new Uint8Array([]))).toBeNull();
    expect(extensionPorBytes(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});
