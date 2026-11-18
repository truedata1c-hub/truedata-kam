// Эксплуатация: состояние резервных копий для администратора (каталог копий смонтирован только для чтения).

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type Ctx, requirePermission } from './access.js';

export async function backupStatus(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  const dir = process.env.BACKUP_DIR;
  if (!dir) return { configured: false, last: null, dumps: [] };
  let last: Record<string, unknown> | null = null;
  try { last = JSON.parse(await readFile(path.join(dir, 'status.json'), 'utf8')); } catch { last = null; }
  const dumps: { file: string; bytes: number; at: string }[] = [];
  try {
    for (const f of await readdir(path.join(dir, 'db'))) {
      if (!/^kam-\d{8}-\d{4,6}\.dump$/.test(f)) continue;
      const s = await stat(path.join(dir, 'db', f));
      dumps.push({ file: f, bytes: s.size, at: s.mtime.toISOString() });
    }
  } catch { /* каталог ещё не создан */ }
  dumps.sort((a, b) => b.at.localeCompare(a.at));
  const ageHours = dumps[0] ? Math.round((Date.now() - Date.parse(dumps[0].at)) / 360_000) / 10 : null;
  return { configured: true, last, dumps: dumps.slice(0, 30), count: dumps.length, age_hours: ageHours, stale: ageHours === null || ageHours > 26 };
}
