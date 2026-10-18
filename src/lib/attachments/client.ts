import type { AttachmentRecord, AttachmentRef } from '../types';
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, sniffImageType } from './policy';

const textExtensions = new Set('txt md markdown csv tsv json jsonl ndjson log yaml yml toml xml html htm css scss sass less js jsx ts tsx mjs cjs py go rs java c h cpp cc hpp cs sh bash zsh sql ini conf config env gitignore dockerignore editorconfig rb php vue svelte swift kt kts r tex'.split(' '));
const textNames = new Set(['dockerfile', 'makefile', 'license', 'licence', 'readme']);
const imageExtensions: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const ATTACHMENT_ACCEPT = [...textExtensions].map(extension => `.${extension}`).concat(['.png', '.jpg', '.jpeg', '.webp', 'text/plain', 'text/markdown', 'application/json', 'text/csv']).join(',');

export function attachmentRef({ id, name, kind, mediaType, size }: AttachmentRef): AttachmentRef {
  return { id, name, kind, mediaType, size };
}

export function formatFileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** No uploads, transcoding or silent truncation. Preserve the exact UTF-8 bytes. */
export async function readAttachment(file: File): Promise<AttachmentRecord> {
  const name = file.name;
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Use a filename of at most 255 characters without control characters.');
  const extension = name.toLowerCase().split('.').at(-1) || '';
  const imageType = Object.hasOwn(imageExtensions, extension) ? imageExtensions[extension] : undefined;
  if (!file.size) throw new Error('Empty files cannot be attached.');
  if (!imageType && !textExtensions.has(extension) && !textNames.has(name.toLowerCase())) {
    throw new Error('Unsupported format. Choose a UTF-8 text/source file or a PNG, JPEG or WebP image. PDF, DOCX, SVG and GIF are not supported in this version.');
  }
  if (file.size > (imageType ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) {
    throw new Error(imageType ? 'Images must be 1 MiB or smaller.' : 'Text files must be 256 KiB or smaller.');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error('The file could not be read locally. Select it again.'); }
  if (bytes.length !== file.size) throw new Error('The file could not be read completely. Select it again.');
  if (imageType) {
    if (sniffImageType(bytes) !== imageType || (file.type.startsWith('image/') && file.type !== imageType)) {
      throw new Error('The image contents do not match its format. Choose a valid PNG, JPEG or WebP image.');
    }
    // Decode locally before previewing/sending, and reject excessive pixel counts.
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(new Blob([bytes], { type: imageType })); }
    catch { throw new Error('This image could not be decoded locally. Choose another PNG, JPEG or WebP image.'); }
    const pixels = bitmap.width * bitmap.height;
    bitmap.close();
    if (!pixels || pixels > 16_000_000) throw new Error('Images must contain at most 16 million pixels. Resize this image before attaching it.');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { id: crypto.randomUUID(), name, kind: 'image', mediaType: imageType, size: bytes.length, data: `data:${imageType};base64,${btoa(binary)}` };
  }
  let data: string;
  try { data = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Text files must use UTF-8 encoding. Convert the file to UTF-8 and select it again.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data)) throw new Error('This file contains binary/control data rather than supported UTF-8 text.');
  return { id: crypto.randomUUID(), name, kind: 'text', mediaType: 'text/plain', size: bytes.length, data };
}

export function validateAttachmentSelection(attachments: AttachmentRef[], content = '') {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('Attach at most 4 files per message.');
  if (new TextEncoder().encode(content).byteLength + attachments.reduce((sum, file) => sum + file.size, 0) > MAX_MESSAGE_BYTES) {
    throw new Error('The message and its files must total 2 MiB or less. Remove a file or shorten the message.');
  }
}
