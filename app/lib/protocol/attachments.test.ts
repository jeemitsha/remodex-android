import { describe, expect, it } from 'vitest';

import {
  buildTurnInput,
  encodeAttachmentToDataURL,
  mimeTypeForUri,
  shouldRetryWithImageURLKey,
} from './attachments';

describe('buildTurnInput', () => {
  it('orders images before the text item, like iOS makeTurnInputPayload', () => {
    const out = buildTurnInput({
      text: 'hello',
      attachments: [{ dataUrl: 'data:image/jpeg;base64,AAA' }],
      imageURLKey: 'url',
    });
    expect(out).toEqual([
      { type: 'image', url: 'data:image/jpeg;base64,AAA' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('switches the image key to image_url when the legacy bridge expects it', () => {
    const out = buildTurnInput({
      text: '',
      attachments: [{ dataUrl: 'data:image/png;base64,BBB' }],
      imageURLKey: 'image_url',
    });
    expect(out).toEqual([{ type: 'image', image_url: 'data:image/png;base64,BBB' }]);
  });

  it('drops empty / whitespace-only attachments and text', () => {
    const out = buildTurnInput({
      text: '   ',
      attachments: [{ dataUrl: '   ' }, { dataUrl: 'data:x;base64,Z' }],
      imageURLKey: 'url',
    });
    expect(out).toEqual([{ type: 'image', url: 'data:x;base64,Z' }]);
  });

  it('emits empty array when both text and attachments are empty', () => {
    expect(
      buildTurnInput({ text: '', attachments: [], imageURLKey: 'url' }),
    ).toEqual([]);
  });
});

describe('shouldRetryWithImageURLKey', () => {
  it('matches messages that mention image_url', () => {
    expect(shouldRetryWithImageURLKey('Failed to parse image_url field')).toBe(true);
    expect(shouldRetryWithImageURLKey('Unknown property `image_url`')).toBe(true);
  });

  it('false on unrelated errors', () => {
    expect(shouldRetryWithImageURLKey('thread not found')).toBe(false);
    expect(shouldRetryWithImageURLKey(undefined)).toBe(false);
  });
});

describe('mimeTypeForUri', () => {
  it('detects png / gif / webp / heic via extension', () => {
    expect(mimeTypeForUri('file:///foo/bar.png')).toBe('image/png');
    expect(mimeTypeForUri('file:///foo.gif')).toBe('image/gif');
    expect(mimeTypeForUri('file:///pic.webp')).toBe('image/webp');
    expect(mimeTypeForUri('file:///photo.HEIC')).toBe('image/heic');
  });

  it('defaults to image/jpeg for unknown / no extension', () => {
    expect(mimeTypeForUri('file:///foo')).toBe('image/jpeg');
    expect(mimeTypeForUri('content://media/external/images/12345')).toBe('image/jpeg');
  });

  it('ignores query strings when sniffing', () => {
    expect(mimeTypeForUri('file:///foo.png?ts=12345')).toBe('image/png');
  });
});

describe('encodeAttachmentToDataURL', () => {
  it('reads via the injected base64 reader and wraps with the right mime', async () => {
    const reader = async () => 'AAAA';
    const out = await encodeAttachmentToDataURL(
      { id: '1', uri: 'file:///photo.png' },
      reader,
    );
    expect(out).toBe('data:image/png;base64,AAAA');
  });

  it('defaults to jpeg for URIs with no extension', async () => {
    const reader = async () => 'BBB';
    const out = await encodeAttachmentToDataURL(
      { id: '2', uri: 'content://media/external/images/12' },
      reader,
    );
    expect(out).toBe('data:image/jpeg;base64,BBB');
  });
});
