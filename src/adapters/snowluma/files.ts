/**
 * What a QQ file message holds, told from its name: QQ's file hosts name no type. An image sent as a file is seen as
 * any image is, and audio, video, and a PDF are perceived as media (ADR-0029); any other file stays a name in a line.
 */
const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const mediaTypes: Record<string, { kind: 'audio' | 'video' | 'document'; mimeType: string }> = {
  pdf: { kind: 'document', mimeType: 'application/pdf' },
  mp4: { kind: 'video', mimeType: 'video/mp4' }, mov: { kind: 'video', mimeType: 'video/quicktime' }, webm: { kind: 'video', mimeType: 'video/webm' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' }, wav: { kind: 'audio', mimeType: 'audio/wav' }, flac: { kind: 'audio', mimeType: 'audio/flac' },
  ogg: { kind: 'audio', mimeType: 'audio/ogg' }, m4a: { kind: 'audio', mimeType: 'audio/mp4' }, aac: { kind: 'audio', mimeType: 'audio/aac' },
};
export type QqFileKind = { kind: 'image'; mimeType: string } | { kind: 'audio' | 'video' | 'document'; mimeType: string };
export function qqFileKind(name: unknown): QqFileKind | undefined {
  const extension = typeof name === 'string' ? /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() : undefined;
  if (!extension) return;
  return imageTypes[extension] ? { kind: 'image', mimeType: imageTypes[extension] } : mediaTypes[extension];
}
/** The name a file message shows, which SnowLuma gives as `name` and as `file`. */
export const qqFileName = (data: Record<string, unknown> | undefined) => String(data?.name ?? data?.file ?? '');
