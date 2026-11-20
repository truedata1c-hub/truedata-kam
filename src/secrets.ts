// Шифрование секретов в настройках клиента (пароль SMTP). Ключ — SETTINGS_KEY: 32 байта в base64, хранится только
// в .env сервера, поэтому дамп базы и резервные копии не раскрывают пароль. Без ключа значение хранится как раньше —
// открытым текстом (для разработки и тестов); с ключом новые и изменённые секреты сохраняются зашифрованными.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const v = process.env.SETTINGS_KEY;
  if (!v) return null;
  const k = Buffer.from(v, 'base64');
  if (k.length !== 32) throw new Error('SETTINGS_KEY должен быть 32 байтами в base64 (openssl rand -base64 32)');
  return k;
}

export const isSealed = (v: string) => v.startsWith(PREFIX);

/** Шифрует секрет AES-256-GCM, если задан ключ; иначе возвращает как есть. */
export function sealSecret(plain: string): string {
  const k = key();
  if (!k || !plain) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

/** Расшифровывает секрет. null — значение зашифровано, а ключа нет или он другой. */
export function openSecret(stored: string): string | null {
  if (!isSealed(stored)) return stored;
  const k = key();
  if (!k) return null;
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
  try {
    const d = createDecipheriv('aes-256-gcm', k, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
