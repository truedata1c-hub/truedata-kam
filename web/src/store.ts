// Состояние приложения: пользователь, выбранный клиент, маршрут (по hash), справочники, встроенный режим.

import { computed, reactive } from 'vue';
import { api } from './api';

export interface Company { id: string; code: string; name: string; display_name: string; roles: string[]; permissions: string[]; scopes: string[] }
export interface Me { user_id: string; email: string; display_name: string; must_change_password: boolean; via: 'PASSWORD' | 'SSO'; companies: Company[] }
export interface RefNetwork { id: string; name: string; regions: string[]; group_id: string | null; legal_entities: number }
export interface Reference {
  time_zone: string;
  networks: RefNetwork[]; groups: { id: string; name: string }[];
  types: { id: string; name: string; period_split: string; control_days: number }[];
  brands: { id: string; name: string }[]; owners: { id: string; name: string }[];
  assignable: { id: string; name: string; network_ids: string[] }[];
}

export type Page = 'portfolio' | 'campaign' | 'decisions' | 'analytics' | 'users' | 'roles' | 'networks' | 'brands' | 'types' | 'routes' | 'substitutions' | 'prior' | 'settings' | 'audit';
const ADMIN_PAGES = ['users', 'roles', 'networks', 'brands', 'types', 'routes', 'substitutions', 'prior', 'settings', 'audit'];

const params = new URLSearchParams(location.search);
export const embedded = params.get('embed') === '1';

export const state = reactive({
  me: null as Me | null,
  companyId: null as string | null,
  page: 'portfolio' as Page,
  campaignId: null as string | null,
  ref: null as Reference | null,
  pendingDecisions: 0,
});

export const company = computed(() => state.me?.companies.find((c) => c.id === state.companyId) ?? null);
export const can = (p: string) => Boolean(company.value?.permissions.includes(p));
export const isAdmin = computed(() => can('ADMIN'));
export const base = () => `/clients/${state.companyId}`;

export async function loadMe(preferredCompany?: string | null) {
  state.me = await api.get<Me>('/me');
  const wanted = preferredCompany ?? params.get('client') ?? readStored();
  state.companyId = state.me.companies.find((c) => c.id === wanted)?.id ?? state.me.companies[0]?.id ?? null;
}
export async function loadRef() {
  if (state.companyId) state.ref = await api.get<Reference>(`${base()}/reference`);
}
export function selectCompany(id: string) {
  state.companyId = id;
  try { localStorage.setItem('kam.company', id); } catch { /* удобство */ }
}
function readStored() { try { return localStorage.getItem('kam.company'); } catch { return null; } }

// Маршрут в hash: #/portfolio, #/campaign/<id>, #/admin/users …
export function readRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'campaign' && b) { state.page = 'campaign'; state.campaignId = b; return; }
  if (a === 'admin' && b && ADMIN_PAGES.includes(b)) { state.page = b as Page; return; }
  if (a === 'decisions' || a === 'analytics') { state.page = a; return; }
  state.page = 'portfolio';
}
export function go(page: Page, id?: string) {
  const hash = page === 'campaign' ? `#/campaign/${id}` : ADMIN_PAGES.includes(page) ? `#/admin/${page}` : `#/${page}`;
  if (location.hash !== hash) location.hash = hash;
  else readRoute();
}

/** Во встроенном режиме сообщаем платформе заголовок страницы для хлебных крошек. */
export function announceTitle(title: string) {
  document.title = title ? `${title} · Переговоры` : 'PharmaCheck · Переговоры';
  if (embedded && window.parent !== window) window.parent.postMessage({ type: 'kam:title', title }, '*');
}

/** Число шагов, ждущих решения пользователя (значок у «Мои решения»). */
export async function refreshPending() {
  if (!state.companyId) return;
  try { state.pendingDecisions = (await api.get<{ pending: number }>(`${base()}/my-decisions/count`)).pending; } catch { /* значок не критичен */ }
}
