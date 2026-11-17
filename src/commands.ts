// Обёртка изменяющих команд: идемпотентность, ревизия кампании и журнал — в одной транзакции с изменением.

import { createHash, randomUUID } from 'node:crypto';
import type { Tx } from './db.js';
import { withTx } from './db.js';
import { ApiError, notFound } from './errors.js';
import type { Ctx } from './access.js';

export interface CommandResult {
  status: number;
  body: unknown;
  etag?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

export interface CommandRequest {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
  body: unknown;
}

/**
 * Команда с Idempotency-Key. Ключ связан с пользователем, клиентом, методом, путём и хешем тела.
 * Повтор принятой команды возвращает сохранённый результат; тот же ключ с иным запросом — 409.
 * Ошибка откатывает и запись ключа, поэтому отклонённую команду можно повторить с тем же ключом.
 */
export async function runCommand(
  ctx: Ctx,
  req: CommandRequest,
  fn: (tx: Tx) => Promise<CommandResult>,
): Promise<CommandResult & { replay: boolean }> {
  if (!req.idempotencyKey) throw new ApiError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'Передайте заголовок Idempotency-Key.');
  if (!isUuid(req.idempotencyKey)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key должен быть UUID.');
  const bodyHash = createHash('sha256').update(stableStringify(req.body)).digest('hex');
  const perms = [...ctx.access.permissions].sort();
  return withTx(ctx.db, async (tx) => {
    const ins = await tx.query(
      `insert into kam.idempotency_request(client_id, actor_id, key, method, path, body_hash, result_status, result_body, actor_roles)
       values ($1,$2,$3,$4,$5,$6,0,'null',$7) on conflict do nothing returning key`,
      [ctx.clientId, ctx.principal.userId, req.idempotencyKey, req.method, req.path, bodyHash, perms]);
    if (ins.rowCount === 0) {
      const { rows } = await tx.query<{ method: string; path: string; body_hash: string; result_status: number; result_body: unknown; result_etag: string | null; actor_roles: string[] | null }>(
        'select method, path, body_hash, result_status, result_body, result_etag, actor_roles from kam.idempotency_request where client_id=$1 and actor_id=$2 and key=$3',
        [ctx.clientId, ctx.principal.userId, req.idempotencyKey]);
      const prev = rows[0]!;
      if (prev.method !== req.method || prev.path !== req.path || prev.body_hash !== bodyHash) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другой команды.');
      }
      // Повтор не обходит текущую авторизацию: если полномочие отозвано, повтор отклоняется.
      if (prev.actor_roles && !prev.actor_roles.every((r) => (perms as string[]).includes(r))) {
        throw new ApiError(403, 'FORBIDDEN', 'В вашей роли это действие недоступно.');
      }
      return { status: prev.result_status, body: prev.result_body, etag: prev.result_etag ?? undefined, replay: true };
    }
    const result = await fn(tx);
    await tx.query(
      'update kam.idempotency_request set result_status=$4, result_body=$5, result_etag=$6 where client_id=$1 and actor_id=$2 and key=$3',
      [ctx.clientId, ctx.principal.userId, req.idempotencyKey, result.status, JSON.stringify(result.body ?? null), result.etag ?? null]);
    return { ...result, replay: false };
  });
}

export const campaignEtag = (id: string, revision: number) => `"campaign:${id}:${revision}"`;

export interface LockedCampaign {
  id: string;
  revision: number;
  stage: string;
  owner_id: string;
  network_id: string;
}

/** Блокирует строку кампании и проверяет If-Match: устаревшая форма не затирает чужую правку (412). */
export async function lockCampaign(tx: Tx, ctx: Ctx, id: string, ifMatch: string | undefined): Promise<LockedCampaign> {
  if (!isUuid(id)) throw notFound();
  if (!ifMatch) throw new ApiError(428, 'REVISION_REQUIRED', 'Передайте заголовок If-Match с ревизией кампании.');
  const { rows } = await tx.query<LockedCampaign>(
    'select id, revision, stage, owner_id, network_id from kam.campaign where client_id=$1 and id=$2 for update', [ctx.clientId, id]);
  const c = rows[0];
  if (!c) throw notFound();
  if (ifMatch.trim() !== campaignEtag(c.id, c.revision)) {
    throw new ApiError(412, 'STALE_REVISION', 'Кампанию уже изменили. Обновите данные и повторите.', { current_revision: c.revision });
  }
  return c;
}

export async function bumpCampaign(tx: Tx, ctx: Ctx, id: string): Promise<number> {
  const { rows } = await tx.query<{ revision: number }>(
    'update kam.campaign set revision = revision + 1, updated_at = now() where client_id=$1 and id=$2 returning revision', [ctx.clientId, id]);
  return rows[0]!.revision;
}

export interface AuditInput {
  entityType: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export async function audit(tx: Tx, ctx: Ctx, e: AuditInput): Promise<void> {
  await tx.query(
    `insert into kam.audit_event(client_id, id, entity_type, entity_id, action, before, after, reason, actor, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.clientId, randomUUID(), e.entityType, e.entityId ?? null, e.action,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null, ctx.principal.userId, ctx.requestId]);
}

export async function campaignEvent(tx: Tx, ctx: Ctx, campaignId: string, kind: string,
  o: { from?: string | null; to?: string | null; comment?: string | null; payload?: unknown } = {}): Promise<void> {
  await tx.query(
    `insert into kam.campaign_event(client_id, id, campaign_id, kind, from_stage, to_stage, comment, payload, actor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.clientId, randomUUID(), campaignId, kind, o.from ?? null, o.to ?? null, o.comment ?? null,
      o.payload === undefined ? null : JSON.stringify(o.payload), ctx.principal.userId]);
}
