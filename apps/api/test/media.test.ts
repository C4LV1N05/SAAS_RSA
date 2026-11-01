import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { LocalMediaStore, menuImageKeys, processMenuImage } from '../src/media';

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 90, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'Somebody', Software: 'PhoneCam' } })
    .toBuffer();

describe('menu photo processing', () => {
  it('makes square WebP images at 640 and 320 and drops all metadata', async () => {
    const out = await processMenuImage(await photo(1600, 1200));
    for (const [buf, size] of [[out.full, 640], [out.thumb, 320]] as const) {
      const meta = await sharp(buf).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: size, height: size });
      expect(meta.exif).toBeUndefined();
    }
    expect(out.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(out.thumb.length).toBeLessThan(40_000);
  });

  it('rejects files that are not images, and photos that are too small', async () => {
    await expect(processMenuImage(Buffer.from('not a photo'))).rejects.toMatchObject({ code: 'not_an_image', status: 400 });
    await expect(processMenuImage(await photo(120, 120))).rejects.toMatchObject({ code: 'image_too_small' });
  });

  it('stores files under safe keys only', async () => {
    const store = new LocalMediaStore(await mkdtemp(join(tmpdir(), 'media-')), 'http://api.test/media/');
    const keys = menuImageKeys('3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', '9b1d7c2a-1e4f-4a6b-8c3d-2f5e6a7b8c9d', 'a1b2c3d4e5f60718');
    expect(await store.put(keys.thumb, Buffer.from('x'), 'image/webp')).toBe(`http://api.test/media/${keys.thumb}`);
    expect((await store.get(keys.thumb))?.toString()).toBe('x');
    await expect(store.put('../../etc/passwd', Buffer.from('x'), 'image/webp')).rejects.toThrow(/Invalid media key/);
    expect(await store.get('../../etc/passwd')).toBeNull();
  });
});
