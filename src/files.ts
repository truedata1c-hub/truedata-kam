// Хранилище файлов документов: каталог вне веб-корня, файл по SHA-256 (одинаковое содержимое хранится один раз).

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function filesDir(): string {
  return process.env.FILES_DIR ?? path.resolve('data', 'files');
}

export const blobPath = (dir: string, clientId: string, sha: string) => path.join(dir, clientId, sha.slice(0, 2), sha);

export interface Stored { sha256: string; size: number; head: Buffer }

/** Сохраняет поток во временный файл, считая SHA-256 и размер; затем переносит под именем хеша. */
export async function storeStream(dir: string, clientId: string, input: Readable, limit = MAX_FILE_BYTES): Promise<Stored & { truncated: boolean }> {
  const tmpDir = path.join(dir, '.tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, randomUUID());
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  let truncated = false;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > limit) { truncated = true; cb(new Error('FILE_TOO_LARGE')); return; }
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, createWriteStream(tmp, { mode: 0o640 }));
  } catch (e) {
    await rm(tmp, { force: true });
    if (truncated || (e as Error).message === 'FILE_TOO_LARGE') return { sha256: '', size, head, truncated: true };
    throw e;
  }
  const sha256 = hash.digest('hex');
  const target = blobPath(dir, clientId, sha256);
  await mkdir(path.dirname(target), { recursive: true });
  try { await stat(target); await rm(tmp, { force: true }); } catch { await rename(tmp, target); }
  return { sha256, size, head, truncated: false };
}

export async function storeBuffer(dir: string, clientId: string, buf: Buffer): Promise<Stored> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const target = blobPath(dir, clientId, sha256);
  await mkdir(path.dirname(target), { recursive: true });
  try { await stat(target); } catch { await writeFile(target, buf, { mode: 0o640 }); }
  return { sha256, size: buf.length, head: buf.subarray(0, 16) };
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv', txt: 'text/plain', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  msg: 'application/vnd.ms-outlook', eml: 'message/rfc822', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};
/** Типы, которые браузер показывает сам: только их отдаём для просмотра; остальное — скачивание. */
export const PREVIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'jar', 'sh', 'app', 'dmg', 'pkg', 'apk', 'dll', 'lnk', 'html', 'htm', 'svg', 'xhtml']);

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Тип определяется по расширению, а не по заголовку браузера. */
export const mimeOf = (name: string) => MIME[extOf(name)] ?? 'application/octet-stream';

/** Исполняемые файлы и страницы со скриптами не принимаются: по расширению и по сигнатуре содержимого. */
export function blocked(name: string, head: Buffer): boolean {
  if (BLOCKED_EXT.has(extOf(name))) return true;
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return true; // Windows PE
  if (head.subarray(0, 2).toString('latin1') === '#!') return true; // скрипт
  const elf = head.subarray(0, 4);
  if (elf.length === 4 && elf[0] === 0x7f && elf.toString('latin1', 1, 4) === 'ELF') return true;
  const macho = head.readUInt32BE?.(0);
  return head.length >= 4 && (macho === 0xfeedface || macho === 0xfeedfacf || macho === 0xcefaedfe || macho === 0xcffaedfe);
}

/** Имя файла без путей и управляющих символов. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || 'file';
}
