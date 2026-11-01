/**
 * Menu photos. Uploads are decoded, auto-rotated, cropped square and re-encoded
 * as WebP at two sizes. Re-encoding strips all metadata, including GPS location
 * from phone photos (POPIA), and anything that is not a real image is rejected.
 *
 * Storage: Azure Blob Storage in production (a public-read container), or a
 * local folder served by the API at /media/* for development and tests.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { HttpError } from './errors';

export const IMAGE_SIZES = { full: 640, thumb: 320 } as const;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export interface ProcessedImage {
  hash: string;
  full: Buffer;
  thumb: Buffer;
}

export async function processMenuImage(input: Buffer): Promise<ProcessedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { failOn: 'error' }).metadata();
  } catch {
    throw new HttpError(400, 'not_an_image', 'That file is not a photo we can read. Use a JPEG, PNG or WebP.');
  }
  if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
    throw new HttpError(400, 'image_too_small', 'Use a photo at least 200 × 200 pixels.');
  }
  const render = (size: number) =>
    sharp(input, { failOn: 'error' })
      .rotate() // apply the camera's orientation before metadata is dropped
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
  const [full, thumb] = await Promise.all([render(IMAGE_SIZES.full), render(IMAGE_SIZES.thumb)]);
  return { hash: createHash('sha256').update(full).digest('hex').slice(0, 16), full, thumb };
}

export interface MediaStore {
  /** Stores a file and returns its public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
}

export const KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{16}-(320|640)\.webp$/;

export function menuImageKeys(orgId: string, itemId: string, hash: string) {
  return { full: `${orgId}/${itemId}/${hash}-640.webp`, thumb: `${orgId}/${itemId}/${hash}-320.webp` };
}

export class LocalMediaStore implements MediaStore {
  readonly root: string;
  constructor(root: string, private readonly publicBaseUrl: string) {
    this.root = resolve(root);
  }
  async put(key: string, body: Buffer, _contentType?: string): Promise<string> {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid media key: ${key}`);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  async get(key: string): Promise<Buffer | null> {
    if (!KEY_PATTERN.test(key)) return null;
    try {
      return await readFile(join(this.root, key));
    } catch {
      return null;
    }
  }
}

export class AzureBlobMediaStore implements MediaStore {
  private readonly container: ContainerClient;
  constructor(connectionString: string, containerName: string, private readonly publicBaseUrl?: string) {
    this.container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  }
  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    const blob = this.container.getBlockBlobClient(key);
    await blob.uploadData(body, {
      // Content-addressed keys never change, so browsers and CDNs can cache them for a year.
      blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'public, max-age=31536000, immutable' },
    });
    return this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${key}` : blob.url;
  }
}

export function createMediaStore(env: {
  MEDIA_STORE: 'local' | 'azure';
  MEDIA_DIR: string;
  MEDIA_PUBLIC_BASE_URL: string;
  AZURE_STORAGE_CONNECTION_STRING?: string | undefined;
  MEDIA_CONTAINER: string;
}): MediaStore {
  if (env.MEDIA_STORE === 'azure') {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING is required when MEDIA_STORE=azure');
    return new AzureBlobMediaStore(env.AZURE_STORAGE_CONNECTION_STRING, env.MEDIA_CONTAINER);
  }
  return new LocalMediaStore(env.MEDIA_DIR, env.MEDIA_PUBLIC_BASE_URL);
}
