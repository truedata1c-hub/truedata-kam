<template>
  <div class="panel" style="padding: 16px; margin-top: 12px">
    <div class="toolbar"><div class="panelTitle">Почтовый канал</div><div class="spacer" />
      <span class="pill" :class="data?.smtp ? 'green' : 'amber'">{{ data?.smtp ? 'подключён' : 'не подключён' }}</span></div>
    <div class="note" style="margin: 4px 0 12px">Уведомления в системе работают всегда. Письма ставятся в очередь; пока сервер не подключён, они ждут со статусом «канал не настроен» и уйдут после подключения. При ошибке — повтор через 1, 2, 4, 8 и 16 минут.</div>
    <div class="formGrid">
      <div><label class="fieldLabel" for="ml-h">Сервер SMTP</label><q-input for="ml-h" v-model="form.host" outlined dense placeholder="smtp.company.ru" hide-bottom-space aria-label="Сервер SMTP" :error="err.field === 'host'" /></div>
      <div style="display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: end">
        <div><label class="fieldLabel" for="ml-p">Порт</label><q-input for="ml-p" v-model.number="form.port" type="number" outlined dense hide-bottom-space aria-label="Порт" :error="err.field === 'port'" /></div>
        <label class="inlineCheck"><input v-model="form.secure" type="checkbox" /> SSL/TLS сразу (порт 465)</label>
      </div>
      <div><label class="fieldLabel" for="ml-u">Пользователь</label><q-input for="ml-u" v-model="form.user" outlined dense hide-bottom-space autocomplete="off" aria-label="Пользователь SMTP" /></div>
      <div><label class="fieldLabel" for="ml-pw">Пароль</label><q-input for="ml-pw" v-model="form.password" type="password" outlined dense hide-bottom-space autocomplete="new-password"
        :placeholder="data?.smtp?.has_password ? 'сохранён — оставьте пустым' : ''" aria-label="Пароль SMTP" /></div>
      <div class="full"><label class="fieldLabel" for="ml-f">Отправитель</label><q-input for="ml-f" v-model="form.from" outlined dense hide-bottom-space placeholder="PharmaCheck <kam@company.ru>" aria-label="Отправитель" :error="err.field === 'from'" /></div>
    </div>
    <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
    <div class="toolbar" style="margin-top: 12px">
      <button class="tdBtn primary" :disabled="busy || !form.host" @click="save">Сохранить и подключить</button>
      <button class="tdBtn" :disabled="busy" @click="test">Отправить проверочное письмо себе</button>
      <button v-if="data?.smtp" class="tdBtn danger" :disabled="busy" @click="disable">Отключить</button>
    </div>

    <div class="toolbar" style="margin: 18px 0 8px"><b>Журнал писем</b><div class="spacer" />
      <span v-for="(n, s) in data?.stats ?? {}" :key="s" class="pill" :class="STATUS[s]?.tone ?? 'gray'">{{ STATUS[s]?.label ?? s }}: {{ n }}</span>
      <button class="iconBtn" aria-label="Обновить" @click="load"><Icon id="refresh-cw-01" :size="14" /></button></div>
    <div class="miniWrap" style="max-height: 360px; overflow-y: auto">
      <table class="miniTable">
        <thead><tr><th style="width: 130px">Создано</th><th>Кому</th><th>Тема</th><th style="width: 150px">Статус</th><th style="width: 80px"></th></tr></thead>
        <tbody>
          <tr v-for="m in data?.recent ?? []" :key="m.id">
            <td>{{ fmtTime(m.created_at) }}</td>
            <td>{{ m.to_email }}</td>
            <td><span class="cellSub" style="max-width: 380px">{{ m.subject }}</span></td>
            <td><span class="pill" :class="STATUS[m.status]?.tone">{{ STATUS[m.status]?.label }}</span>
              <div v-if="m.attempts" class="cellSub">попыток: {{ m.attempts }}</div><div v-if="m.last_error" class="cellSub" :title="m.last_error">{{ m.last_error }}</div></td>
            <td class="actionCell"><button v-if="['FAILED', 'RETRY'].includes(m.status)" class="linkBtn" @click="retry(m.id)">Повторить</button></td>
          </tr>
          <tr v-if="!(data?.recent ?? []).length"><td colspan="5" class="muted">Писем пока нет.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import { fmtTime } from '../format';
import Icon from './Icon.vue';

interface Mail { smtp: { host: string; port: number; secure: boolean; user: string; from: string; has_password: boolean } | null; stats: Record<string, number>; recent: { id: string; to_email: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: string }[] }
const STATUS: Record<string, { label: string; tone: string }> = {
  NO_CHANNEL: { label: 'канал не настроен', tone: 'gray' }, QUEUED: { label: 'в очереди', tone: 'amber' }, SENDING: { label: 'отправляется', tone: 'amber' },
  SENT: { label: 'отправлено', tone: 'green' }, RETRY: { label: 'повтор', tone: 'amber' }, FAILED: { label: 'не доставлено', tone: 'red' },
};
const $q = useQuasar();
const data = ref<Mail | null>(null);
const form = reactive({ host: '', port: 587, secure: false, user: '', password: '', from: '' });
const { err, busy, run } = useCommand();
async function load() {
  data.value = await api.get<Mail>(`${base()}/mail`);
  const s = data.value.smtp;
  if (s) Object.assign(form, { host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from, password: '' });
}
async function save() {
  const r = await run(() => api.put<{ released: number }>(`${base()}/mail`, form));
  if (r) { $q.notify({ type: 'positive', message: `Почта подключена${r.data.released ? `, в отправку ушло писем: ${r.data.released}` : ''}` }); await load(); }
}
async function disable() { if (await run(() => api.put(`${base()}/mail`, { disabled: true }))) { $q.notify({ type: 'positive', message: 'Почтовый канал отключён' }); await load(); } }
async function test() {
  const r = await run(() => api.post<{ queued: boolean }>(`${base()}/mail/test`, {}));
  if (r) { $q.notify({ type: 'info', message: r.data.queued ? 'Письмо в очереди, уйдёт в течение минуты' : 'Канал не подключён — письмо ждёт в очереди' }); await load(); }
}
async function retry(id: string) { if (await run(() => api.post(`${base()}/mail/${id}/retry`, {}))) await load(); }
onMounted(load);
</script>

<style scoped>
.inlineCheck { display: flex; gap: 6px; align-items: center; height: 30px; font-size: 12px; color: var(--text-2); }
.inlineCheck input { accent-color: var(--purple); }
</style>
