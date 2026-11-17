// Настройки клиента (ТЗ §8 п. 9): пороги подсветок версии. Демо-набор хранит здесь же свою версию.

import type { Tx } from './db.js';
import { invalid } from './errors.js';
import { type Ctx, requirePermission } from './access.js';
import { type CommandResult, audit } from './commands.js';

export interface Thresholds {
  /** Рост инвестиций бренда к факту прошлого периода, выше которого нужна подсветка, %. */
  investment_growth_pct: number;
  /** Выполнение плана оборота прошлого периода ниже этого уровня подсвечивается, %. */
  execution_below_pct: number;
  /** Подсвечивать ROI ниже факта прошлого периода. */
  roi_below_prior: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = { investment_growth_pct: 15, execution_below_pct: 90, roi_below_prior: true };

type Q = Pick<Tx, 'query'>;

export async function readSettings(q: Q, clientId: string): Promise<Record<string, any>> {
  const { rows } = await q.query<{ settings: Record<string, any> }>('select settings from kam.client_setting where client_id=$1', [clientId]);
  return rows[0]?.settings ?? {};
}

export async function thresholds(q: Q, clientId: string): Promise<Thresholds> {
  return { ...DEFAULT_THRESHOLDS, ...((await readSettings(q, clientId)).thresholds ?? {}) };
}

export async function writeSetting(q: Q, clientId: string, key: string, value: unknown) {
  await q.query(
    `insert into kam.client_setting(client_id, settings) values ($1, jsonb_build_object($2::text, $3::jsonb))
     on conflict (client_id) do update set settings = kam.client_setting.settings || jsonb_build_object($2::text, $3::jsonb)`,
    [clientId, key, JSON.stringify(value)]);
}

export async function getSettings(ctx: Ctx) {
  requirePermission(ctx, 'ADMIN');
  return { thresholds: await thresholds(ctx.db, ctx.clientId) };
}

export async function saveThresholds(tx: Tx, ctx: Ctx, b: Record<string, unknown>): Promise<CommandResult> {
  requirePermission(ctx, 'ADMIN');
  const num = (k: keyof Thresholds, max: number) => {
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw invalid(k, `Укажите число от 0 до ${max}.`);
    return Math.round(v * 10) / 10;
  };
  const t: Thresholds = { investment_growth_pct: num('investment_growth_pct', 1000), execution_below_pct: num('execution_below_pct', 200), roi_below_prior: Boolean(b.roi_below_prior) };
  const before = await thresholds(tx, ctx.clientId);
  await writeSetting(tx, ctx.clientId, 'thresholds', t);
  await audit(tx, ctx, { entityType: 'settings', action: 'UPDATE', before, after: t });
  return { status: 200, body: { thresholds: t } };
}
