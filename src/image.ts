import sharp, { type Metadata } from 'sharp';
import type { Api, ImageContent, Model, TextContent } from '@earendil-works/pi-ai';

export interface ResolvedImageLimits {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  jpegQuality: number;
}

const DEFAULT_MAX_WIDTH = 2000;
const DEFAULT_MAX_HEIGHT = 2000;
/** ~3.5 MB raw stays under ~4.67 MB base64, safely below Anthropic's 5 MB base64 image limit. */
const DEFAULT_MAX_BYTES = 3_500_000;
const DEFAULT_JPEG_QUALITY = 80;
const PASS_THROUGH_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function normalizeMime(mimeType: string): string {
  const clean = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  return clean === 'image/jpg' ? 'image/jpeg' : clean || 'image/jpeg';
}

export function resolveImageResizeOptions(model?: Pick<Model<Api>, 'inputLimits'>): ResolvedImageLimits {
  const resize = model?.inputLimits?.images?.resize;
  return {
    maxWidth: resize?.maxWidth && resize.maxWidth > 0 ? Math.min(resize.maxWidth, DEFAULT_MAX_WIDTH) : DEFAULT_MAX_WIDTH,
    maxHeight: resize?.maxHeight && resize.maxHeight > 0 ? Math.min(resize.maxHeight, DEFAULT_MAX_HEIGHT) : DEFAULT_MAX_HEIGHT,
    maxBytes: resize?.maxBytes && resize.maxBytes > 0 ? Math.min(resize.maxBytes, DEFAULT_MAX_BYTES) : DEFAULT_MAX_BYTES,
    jpegQuality: resize?.jpegQuality && resize.jpegQuality >= 20 && resize.jpegQuality <= 100 ? resize.jpegQuality : DEFAULT_JPEG_QUALITY,
  };
}

export interface PreparedImage {
  data: Buffer;
  mimeType: string;
  resized: boolean;
}

/**
 * Prepare an image for multimodal LLM input, respecting `model.inputLimits.images.resize`
 * and provider size/dimension caps deterministically.
 * - Already-compliant static PNG/JPEG/WebP images pass through untouched.
 * - Animated GIF/WebP or unsupported formats are flattened to frame 0.
 * - Oversized images are resized and compressed deterministically until within `maxBytes`.
 * - Undecodable inputs (e.g. synthetic test buffers) pass through without throwing.
 */
export async function prepareModelImage(
  input: Buffer | Uint8Array,
  mimeType: string,
  model?: Pick<Model<Api>, 'inputLimits'>,
): Promise<PreparedImage> {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const mime = normalizeMime(mimeType);
  const limits = resolveImageResizeOptions(model);

  let meta: Metadata;
  try {
    meta = await sharp(data, { animated: true, failOn: 'none' }).metadata();
  } catch {
    return { data, mimeType: mime, resized: false };
  }

  const width = meta.width ?? 0;
  const height = meta.pageHeight ?? meta.height ?? 0;
  const animated = (meta.pages ?? 1) > 1;
  const hasOrientation = (meta.orientation ?? 1) > 1;

  if (
    !animated &&
    !hasOrientation &&
    PASS_THROUGH_MIMES.has(mime) &&
    width > 0 &&
    height > 0 &&
    width <= limits.maxWidth &&
    height <= limits.maxHeight &&
    data.byteLength <= limits.maxBytes
  ) {
    return { data, mimeType: mime, resized: false };
  }

  const render = async (maxW: number, maxH: number, format: 'png' | 'jpeg', quality: number) => {
    let pipeline = sharp(data, { pages: 1, failOn: 'none' })
      .rotate()
      .resize({ width: Math.max(64, Math.round(maxW)), height: Math.max(64, Math.round(maxH)), fit: 'inside', withoutEnlargement: true });
    if (format === 'png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
    }
    return pipeline.toBuffer();
  };

  try {
    // Keep PNG when input is PNG with alpha and fits comfortably within maxBytes.
    if (mime === 'image/png' && meta.hasAlpha) {
      const png = await render(limits.maxWidth, limits.maxHeight, 'png', limits.jpegQuality);
      if (png.byteLength <= limits.maxBytes) return { data: png, mimeType: 'image/png', resized: true };
    }

    const qualities = [...new Set([limits.jpegQuality, 70, 55, 40])].filter(q => q <= limits.jpegQuality);
    const scales = [1, 0.75, 0.5, 0.35];
    let best: Buffer | undefined;
    for (const scale of scales) {
      const w = limits.maxWidth * scale;
      const h = limits.maxHeight * scale;
      for (const quality of qualities) {
        const candidate = await render(w, h, 'jpeg', quality);
        if (!best || candidate.byteLength < best.byteLength) best = candidate;
        if (candidate.byteLength <= limits.maxBytes) {
          return { data: candidate, mimeType: 'image/jpeg', resized: true };
        }
      }
    }
    return best ? { data: best, mimeType: 'image/jpeg', resized: true } : { data, mimeType: mime, resized: false };
  } catch {
    return { data, mimeType: mime, resized: false };
  }
}

/** Normalize any image content blocks returned by a tool call for the active model. */
export async function normalizeImageBlocks(
  content: (TextContent | ImageContent)[],
  model?: Pick<Model<Api>, 'inputLimits'>,
): Promise<{ content: (TextContent | ImageContent)[]; changed: boolean }> {
  if (!content.some(block => block.type === 'image')) return { content, changed: false };
  let changed = false;
  const next = await Promise.all(
    content.map(async block => {
      if (block.type !== 'image') return block;
      const raw = Buffer.from(block.data, 'base64');
      const prepared = await prepareModelImage(raw, block.mimeType, model);
      if (!prepared.resized && prepared.mimeType === block.mimeType) return block;
      changed = true;
      return { type: 'image' as const, data: prepared.data.toString('base64'), mimeType: prepared.mimeType };
    }),
  );
  return { content: next, changed };
}
