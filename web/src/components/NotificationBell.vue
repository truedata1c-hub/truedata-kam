<template>
  <button class="iconBtn bell" :aria-label="unread ? `Уведомления: ${unread} новых` : 'Уведомления'">
    <Icon id="inbox-01" :size="18" />
    <span v-if="unread" class="bellBadge">{{ unread > 99 ? '99+' : unread }}</span>
    <q-menu anchor="bottom right" self="top right" :offset="[0, 6]" max-height="560px" @show="load">
      <div class="bellMenu">
        <div class="bellHead">
          <b>Уведомления</b><div class="spacer" />
          <button v-if="unread" class="linkBtn accent" @click="readAll">Прочитать все</button>
        </div>
        <div class="bellList">
          <button v-for="n in items" :key="n.id" v-close-popup class="bellItem" :class="{ unread: !n.read_at }" @click="open(n)">
            <span class="dot" />
            <span class="txt"><span class="t">{{ n.title }}</span><span v-if="n.body" class="b">{{ n.body }}</span><time>{{ KIND_LABEL[n.kind] ?? '' }} · {{ fmtTime(n.created_at) }}</time></span>
          </button>
          <div v-if="!items.length" class="muted" style="padding: 16px">Уведомлений нет.</div>
        </div>
        <div class="bellFoot"><button v-close-popup class="linkBtn" @click="prefsOpen = true">Настроить письма</button></div>
      </div>
    </q-menu>
  </button>

  <q-dialog v-if="prefsOpen" :model-value="true" @hide="prefsOpen = false">
    <div class="q-card tdDialog narrow">
      <div class="dlgHead"><div><div class="dlgTitle">Письма о событиях</div>
        <div class="dlgSub">В системе уведомления приходят всегда. Письмом — только отмеченные события{{ prefs?.email ? `, на ${prefs.email}` : '' }}.</div></div>
        <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
      <div class="dlgBody">
        <div v-if="prefs && !prefs.channel_configured" class="banner info" style="margin-bottom: 10px"><Icon id="info-circle" :size="15" /><span>Почтовый сервер ещё не подключён: письма копятся и уйдут после подключения.</span></div>
        <div class="prefList">
          <label v-for="p in prefs?.items ?? []" :key="p.kind" class="choice" :class="{ on: p.email }"><input v-model="p.email" type="checkbox" /><span>{{ p.label }}</span></label>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>
      <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy" @click="savePrefs">Сохранить</button></div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, go, state, refreshPending } from '../store';
import { useCommand } from '../command';
import { fmtTime } from '../format';
import Icon from './Icon.vue';

interface N { id: string; kind: string; title: string; body: string; campaign_id: string | null; created_at: string; read_at: string | null }
const KIND_LABEL: Record<string, string> = {
  STEP_ASSIGNED: 'Согласование', STEP_REMINDER: 'Напоминание', STEP_OVERDUE: 'Просрочка', DECISION: 'Решение', APPROVED: 'Согласовано', RETURNED: 'Возврат',
  VERSION_CHANGED: 'Новая версия', CONTROL_OVERDUE: 'Контрольная дата', MENTION: 'Переписка', CONFIRMED: 'Подтверждение сети',
};
const $q = useQuasar();
const items = ref<N[]>([]);
const unread = ref(0);
const prefsOpen = ref(false);
const prefs = ref<{ channel_configured: boolean; email: string; items: { kind: string; label: string; email: boolean }[] } | null>(null);
const { err, busy, run } = useCommand();

async function load() {
  if (!state.companyId) return;
  try {
    const r = await api.get<{ items: N[]; unread: number }>(`${base()}/notifications`);
    items.value = r.items;
    unread.value = r.unread;
  } catch { /* значок не критичен */ }
}
async function open(n: N) {
  if (!n.read_at) {
    await api.post(`${base()}/notifications/read`, { ids: [n.id] });
    n.read_at = new Date().toISOString();
    unread.value = Math.max(0, unread.value - 1);
  }
  if (n.campaign_id) go('campaign', n.campaign_id);
}
async function readAll() {
  await api.post(`${base()}/notifications/read`, { all: true });
  await load();
}
async function savePrefs() {
  const email = Object.fromEntries((prefs.value?.items ?? []).map((p) => [p.kind, p.email]));
  if (await run(() => api.put(`${base()}/notification-prefs`, { email }))) { prefsOpen.value = false; $q.notify({ type: 'positive', message: 'Настройки писем сохранены' }); }
}
watch(prefsOpen, async (v) => { if (v) prefs.value = await api.get(`${base()}/notification-prefs`); });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { void load(); timer = setInterval(() => { void load(); void refreshPending(); }, 60_000); });
onBeforeUnmount(() => clearInterval(timer));
watch(() => [state.companyId, state.page, state.campaignId], () => { void load(); });
</script>

<style scoped>
.bell { position: relative; }
.bellBadge { position: absolute; top: -3px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--red); color: #fff; font-size: 10px; font-weight: 600; display: grid; place-items: center; line-height: 1; }
.bellMenu { width: 380px; max-width: 92vw; }
.bellHead { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.bellMenu { display: flex; flex-direction: column; max-height: 540px; }
.bellList { flex: 1 1 auto; min-height: 0; max-height: 440px; overflow-y: auto; }
.bellItem { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 8px 1fr; gap: 10px; width: 100%; padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--line); }
.bellItem:hover { background: var(--hover); }
.bellItem:focus-visible { outline: 2px solid var(--purple-line); outline-offset: -2px; }
.bellItem .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: transparent; }
.bellItem.unread .dot { background: var(--purple); }
.bellItem .txt { display: grid; gap: 2px; min-width: 0; }
.bellItem .t { color: var(--ink); font-size: 12.5px; line-height: 17px; }
.bellItem.unread .t { font-weight: 600; }
.bellItem .b { color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.bellItem time { color: var(--muted); font-size: 11px; }
.bellFoot { flex: none; padding: 8px 14px; border-top: 1px solid var(--line); background: #fff; }
.prefList { display: grid; gap: 6px; }
</style>
