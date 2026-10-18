import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentRef, formatFileSize, readAttachment, validateAttachmentSelection } from './client';
import { MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES } from './policy';

test('UTF-8 source text, BOM, whitespace and names are preserved byte-for-byte without data in refs', async () => {
  const text = '\ufeff// Привет 🌍\r\nconst value = "<script>";\n';
  const record = await readAttachment(new File([text], 'example.ts', { type: 'application/octet-stream' }));
  assert.equal(record.data, text);
  assert.equal(record.size, new TextEncoder().encode(text).byteLength);
  assert.equal(record.kind, 'text');
  assert.equal('data' in attachmentRef(record), false);
  assert.equal(attachmentRef(record).name, 'example.ts');
});

test('unsupported containers, active image formats and renamed binary are rejected without truncation', async () => {
  for (const name of ['report.pdf', 'report.docx', 'tracker.svg', 'animated.gif', 'archive.zip']) {
    await assert.rejects(readAttachment(new File(['test'], name)), /Unsupported format/);
  }
  await assert.rejects(readAttachment(new File([new Uint8Array([0xff, 0xfe, 0])], 'binary.txt')), /UTF-8/);
  await assert.rejects(readAttachment(new File(['binary\0data'], 'binary.txt')), /binary\/control/);
  await assert.rejects(readAttachment(new File(['<svg/>'], 'fake.png', { type: 'image/png' })), /do not match/);
});

test('byte size, empty and filename limits are checked before reading', async () => {
  await assert.rejects(readAttachment(new File([], 'empty.txt')), /Empty files/);
  await assert.rejects(readAttachment(new File(['x'.repeat(MAX_TEXT_BYTES + 1)], 'large.txt')), /256 KiB/);
  await assert.rejects(readAttachment(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png')), /1 MiB/);
  await assert.rejects(readAttachment(new File(['text'], 'bad\nname.txt')), /filename/);
  await assert.rejects(readAttachment(new File(['text'], `${'a'.repeat(256)}.txt`)), /filename/);
});

test('local image decoder must accept the complete image and a bounded pixel count', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'createImageBitmap', descriptor); else Reflect.deleteProperty(globalThis, 'createImageBitmap'); });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = new File([png], 'image.png', { type: 'image/png' });
  let closed = false;
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 1, height: 1, close() { closed = true; } }) });
  const record = await readAttachment(file);
  assert.equal(record.data, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(closed, true);
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 8000, height: 8000, close() {} }) });
  await assert.rejects(readAttachment(file), /16 million pixels/);
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { throw new Error('private decoder message'); } });
  await assert.rejects(readAttachment(file), /could not be decoded locally/);
});

test('selection limits include all files and UTF-8 message bytes, never silently remove a file', () => {
  const ref = { id: 'one', name: 'file.png', kind: 'image' as const, mediaType: 'image/png', size: MAX_IMAGE_BYTES };
  assert.doesNotThrow(() => validateAttachmentSelection([ref, { ...ref, id: 'two' }]));
  assert.throws(() => validateAttachmentSelection([ref, { ...ref, id: 'two' }], 'я'), /2 MiB/);
  assert.throws(() => validateAttachmentSelection(Array.from({ length: 5 }, (_, i) => ({ ...ref, id: `${i}`, size: 1 }))), /at most 4/);
  assert.throws(() => validateAttachmentSelection([], 'x'.repeat(MAX_MESSAGE_BYTES + 1)), /2 MiB/);
  assert.equal(formatFileSize(42), '42 B');
  assert.equal(formatFileSize(1024), '1.0 KiB');
});
