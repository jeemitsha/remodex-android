// Encodes image attachments for `turn/start` input items. Mirrors iOS
// CodexImageAttachment.payloadDataURL → "data:image/<mime>;base64,<...>" and
// the makeTurnInputPayload shape (`{ type: "image", url: dataURL }`). The bridge
// prefers `url` but older revisions accept `image_url`; we retry on a "failed
// to parse / image_url" error per CodexService+ThreadsTurns.swift:2118.

import type { ComposerAttachment } from '../composer-state';

export type TurnInputItem =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & Record<string, string>);

// Builds the input array for turn/start. Order matches iOS: images first,
// then the text item if present. `imageURLKey` toggles between "url" (default)
// and "image_url" (legacy bridges).
export function buildTurnInput(input: {
  text: string;
  attachments: { dataUrl: string }[];
  imageURLKey: 'url' | 'image_url';
}): TurnInputItem[] {
  const items: TurnInputItem[] = [];
  for (const a of input.attachments) {
    const trimmed = a.dataUrl.trim();
    if (!trimmed) continue;
    items.push({ type: 'image', [input.imageURLKey]: trimmed });
  }
  const trimmedText = input.text.trim();
  if (trimmedText) items.push({ type: 'text', text: trimmedText });
  return items;
}

// True when an RPC error message looks like the bridge complaining about the
// `url` key vs. `image_url` (mirrors iOS shouldRetryWithImageURLKeyFallback).
export function shouldRetryWithImageURLKey(message: string | undefined): boolean {
  if (!message) return false;
  return message.toLowerCase().includes('image_url');
}

// Resolves the mime-type the bridge should see in the data URL. We default to
// jpeg because that's what the iOS app sends and most picker-returned images
// reduce well to that. URIs whose extension says ".png" or ".gif" override.
export function mimeTypeForUri(uri: string): string {
  const lower = uri.toLowerCase().split('?')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}

// Reads a local file URI (from expo-image-picker) as base64 and wraps it in a
// data URL ready for `turn/start`. Pulled out as its own module so the test
// can stub the reader without dragging the whole expo-file-system module in.
export async function encodeAttachmentToDataURL(
  attachment: ComposerAttachment,
  readBase64: (uri: string) => Promise<string>,
): Promise<string> {
  const base64 = await readBase64(attachment.uri);
  const mime = mimeTypeForUri(attachment.uri);
  return `data:${mime};base64,${base64}`;
}
