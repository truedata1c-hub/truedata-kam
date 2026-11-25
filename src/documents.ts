// Документы кампании (ТЗ §6.1): любой формат до 50 МБ, тип выбирает пользователь, хранение неизменяемо,
// удаление — архив с причиной. Документы не разбираются в условия.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Tx } from './db.js';
import { withTx } from './db.js';
import { ApiError, forbidden, invalid, notFound, required } from './errors.js';
import { type Ctx, campaignVisibility, canEditFor } from './access.js';
import { type CommandResult, audit, campaignEvent, isUuid, lockCampaignRecord } from './commands.js';
import { MAX_FILE_BYTES, PREVIEWABLE, blobPath, blocked, filesDir, mimeOf, safeName, storeStream } from './files.js';

export const DOC_KINDS = ['OUR_OFFER', 'NETWORK_OFFER', 'MEETING_MINUTES', 'CALCULATION', 'NETWORK_CONFIRMATION', 'SIGNED_CONTRACT', 'FINAL_TERMS', 'OTHER'] as const;
const CLOSED = ['CANCELLED', 'CLOSED'];

async function visibleCampaign(ctx: Ctx, campaignId: string, q: Pick<Tx, 'query'> = ctx.db) {
  if (!isUuid(campaignId)) throw notFound();
  const vis = campaignVisibility(ctx, 3);
  const { rows } = await q.query<{ id: string; owner_id: string | null; last_owner_id: string | null; stage: string }>(
    `select c.id, c.owner_id, c.last_owner_id, c.stage from kam.campaign_with_owner c where c.client_id=$1 and c.id=$2 and ${vis.sql}`, [ctx.clientId, campaignId, ...vis.params]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function listDocuments(ctx: Ctx, campaignId: string) {
  const { rows } = await ctx.db.query(
    `select d.id, d.kind, d.file_name, d.mime, d.size_bytes::int size, d.stage, d.comment, d.uploaded_at, u.display_name uploaded_by_name,
            d.archived_at, d.archive_reason, au.display_name archived_by_name,
            coalesce((select array_agg(v.number order by v.number) from kam.offer_version_document vd join kam.offer_version v on v.client_id = vd.client_id and v.id = vd.version_id
                       where vd.client_id = d.client_id and vd.document_id = d.id), '{}') versions
       from kam.document d join kam.employee_profile u on u.client_id = d.client_id and u.id = d.uploaded_by left join kam.employee_profile au on au.client_id = d.client_id and au.id = d.archived_by
      where d.client_id=$1 and d.campaign_id=$2 order by d.archived_at nulls first, d.uploaded_at desc`, [ctx.clientId, campaignId]);
  return rows.map((r) => ({ ...r, previewable: PREVIEWABLE.has(r.mime) }));
}

/**
 * Загрузка: поля формы kind и comment передаются до файла. Повторная загрузка того же содержимого в ту же кампанию
 * возвращает уже сохранённый документ — повтор запроса не создаёт дубль.
 */
export async function upload(ctx: Ctx, campaignId: string, req: FastifyRequest): Promise<CommandResult> {
  const c = await visibleCampaign(ctx, campaignId);
  if (!canEditFor(ctx, c.owner_id, c.last_owner_id)) throw forbidden();
  if (CLOSED.includes(c.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Кампания отменена или закрыта — документы не добавляются.');
  if (!req.isMultipart()) throw new ApiError(415, 'MULTIPART_REQUIRED', 'Передайте файл формой multipart/form-data.');
  const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, fieldSize: 4000 } });
  if (!part) throw required('file', 'Выберите файл.');
  const field = (k: string) => {
    const f = part.fields[k] as { value?: unknown } | undefined;
    return typeof f?.value === 'string' ? f.value : '';
  };
  const kind = field('kind') || 'OTHER';
  if (!(DOC_KINDS as readonly string[]).includes(kind)) throw invalid('kind', 'Выберите тип документа.');
  const comment = field('comment').trim();
  if (comment.length > 1000) throw invalid('comment', 'Не длиннее 1000 символов.');
  const name = safeName(part.filename || 'file');
  // Пустой и запрещённый файл отклоняется до переноса в хранилище — на диске не остаётся неучтённых файлов.
  const stored = await storeStream(filesDir(), ctx.clientId, part.file, MAX_FILE_BYTES, (f) => !part.file.truncated && f.size > 0 && !blocked(name, f.head));
  if (stored.truncated || part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', 'Файл больше 50 МБ.', {}, 'file');
  if (!stored.size) throw invalid('file', 'Файл пустой.');
  if (stored.rejected) throw invalid('file', 'Исполняемые файлы и веб-страницы не принимаются.', 'FILE_TYPE_BLOCKED');

  return withTx(ctx.db, async (tx) => {
    const locked = await lockCampaignRecord(tx, ctx.clientId, campaignId);
    if (!canEditFor(ctx, locked.owner_id, locked.last_owner_id)) throw forbidden();
    if (CLOSED.includes(locked.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Кампания отменена или закрыта — документы не добавляются.');
    const dup = (await tx.query<{ id: string }>('select id from kam.document where client_id=$1 and campaign_id=$2 and sha256=$3 and archived_at is null limit 1',
      [ctx.clientId, campaignId, stored.sha256])).rows[0];
    if (dup) return { status: 200, body: { id: dup.id, duplicate: true } };
    const id = randomUUID();
    await tx.query(
      `insert into kam.document(client_id, id, campaign_id, kind, file_name, mime, size_bytes, sha256, stage, comment, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.clientId, id, campaignId, kind, name, mimeOf(name), stored.size, stored.sha256, locked.stage, comment, ctx.principal.userId]);
    await campaignEvent(tx, ctx, campaignId, 'DOCUMENT_UPLOADED', { payload: { document_id: id, file_name: name, kind } });
    await audit(tx, ctx, { entityType: 'document', entityId: id, action: 'UPLOAD', after: { campaign_id: campaignId, file_name: name, kind, size: stored.size, sha256: stored.sha256 } });
    return { status: 201, body: { id, duplicate: false } };
  });
}

export async function archive(tx: Tx, ctx: Ctx, campaignId: string, docId: string, b: Record<string, unknown>): Promise<CommandResult> {
  const c = await lockCampaignRecord(tx, ctx.clientId, campaignId);
  await visibleCampaign(ctx, campaignId, tx);
  if (!canEditFor(ctx, c.owner_id, c.last_owner_id)) throw forbidden();
  if (CLOSED.includes(c.stage)) throw new ApiError(409, 'STAGE_LOCKED', 'Кампания отменена или закрыта.');
  if (!isUuid(docId)) throw notFound();
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) throw required('reason', 'Укажите причину.');
  if (reason.length > 1000) throw invalid('reason', 'Не длиннее 1000 символов.');
  const d = (await tx.query<{ file_name: string; archived_at: string | null }>('select file_name, archived_at from kam.document where client_id=$1 and campaign_id=$2 and id=$3 for update',
    [ctx.clientId, campaignId, docId])).rows[0];
  if (!d) throw notFound();
  if (d.archived_at) throw new ApiError(409, 'ALREADY_ARCHIVED', 'Документ уже в архиве.');
  await tx.query('update kam.document set archived_at=now(), archived_by=$3, archive_reason=$4 where client_id=$1 and id=$2', [ctx.clientId, docId, ctx.principal.userId, reason]);
  await campaignEvent(tx, ctx, campaignId, 'DOCUMENT_ARCHIVED', { comment: reason, payload: { document_id: docId, file_name: d.file_name } });
  await audit(tx, ctx, { entityType: 'document', entityId: docId, action: 'ARCHIVE', reason });
  return { status: 200, body: { id: docId } };
}

/** Скачивание или просмотр. Просмотр в браузере — только для PDF и изображений; остальное всегда скачивается. */
export async function sendFile(ctx: Ctx, campaignId: string, docId: string, inline: boolean, reply: FastifyReply, frameAncestors: string) {
  await visibleCampaign(ctx, campaignId);
  if (!isUuid(docId)) throw notFound();
  const d = (await ctx.db.query<{ file_name: string; mime: string; sha256: string; size_bytes: string }>(
    'select file_name, mime, sha256, size_bytes from kam.document where client_id=$1 and campaign_id=$2 and id=$3', [ctx.clientId, campaignId, docId])).rows[0];
  if (!d) throw notFound();
  const show = inline && PREVIEWABLE.has(d.mime);
  const ascii = d.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  reply.header('content-type', show ? d.mime : 'application/octet-stream');
  reply.header('content-length', d.size_bytes);
  reply.header('content-disposition', `${show ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.file_name)}`);
  reply.header('cache-control', 'private, max-age=3600');
  // Файл показывается только внутри модуля; скрипты в нём не выполняются.
  reply.header('content-security-policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors ${frameAncestors}`);
  reply.header('x-kam-file', '1');
  return reply.send(createReadStream(blobPath(filesDir(), ctx.clientId, d.sha256)));
}
