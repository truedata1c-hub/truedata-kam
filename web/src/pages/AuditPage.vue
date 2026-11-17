<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Журнал изменений</div>
        <div class="note">Все изменения кампаний и настроек: кто, когда и что сделал. Журнал нельзя изменить или удалить.</div>
      </div>
      <TdSelect v-model="type" clearable :options="typeOptions" placeholder="Все объекты" aria-label="Объект" />
    </div>
    <div class="miniWrap">
      <table class="miniTable">
        <thead><tr><th style="width: 150px">Когда</th><th style="width: 170px">Кто</th><th style="width: 170px">Объект</th><th>Действие</th></tr></thead>
        <tbody>
          <tr v-for="a in rows" :key="a.id">
            <td>{{ fmtTime(a.recorded_at) }}</td>
            <td>{{ a.actor_name }}</td>
            <td>{{ ENTITY[a.entity_type] ?? a.entity_type }}</td>
            <td>{{ ACTION[a.action] ?? a.action }}<span v-if="summary(a)" class="muted"> · {{ summary(a) }}</span><div v-if="a.reason" class="cellSub">{{ a.reason }}</div></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="4" class="muted">Записей нет.</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="rows.length >= 200" style="margin-top: 12px"><button class="tdBtn" @click="more">Показать раньше</button></div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { base, announceTitle } from '../store';
import { STAGE_LABEL, fmtTime } from '../format';
import TdSelect from '../components/TdSelect.vue';

interface Entry { id: string; entity_type: string; action: string; before: any; after: any; reason: string | null; recorded_at: string; actor_name: string }
const ENTITY: Record<string, string> = { campaign: 'Кампания', role: 'Роль', user: 'Сотрудник', assignment: 'Закрепление за сетью', network: 'Сеть', network_group: 'Группа сетей', legal_entity: 'Юрлицо', brand: 'Бренд', campaign_type: 'Тип кампании' };
const ACTION: Record<string, string> = { CREATE: 'создание', UPDATE: 'изменение', INVITE: 'добавление', RESET_PASSWORD: 'временный пароль', SET_MANAGER: 'назначен руководитель', END: 'открепление', START_NEGOTIATION: 'начало переговоров', CANCEL: 'отмена', CLOSE: 'закрытие' };
const typeOptions = Object.entries(ENTITY).map(([value, label]) => ({ value, label }));
const rows = ref<Entry[]>([]);
const type = ref<string | null>(null);

function summary(a: Entry): string {
  const x = a.after ?? {};
  if (x.title) return x.title;
  if (x.name) return x.name;
  if (x.inn) return `ИНН ${x.inn}`;
  if (x.email) return x.email;
  if (x.stage) return STAGE_LABEL[x.stage] ?? x.stage;
  return '';
}
async function load(before?: string) {
  const r = await api.get<{ items: Entry[] }>(`${base()}/audit`, { entity_type: type.value, before });
  rows.value = before ? [...rows.value, ...r.items] : r.items;
}
const more = () => load(rows.value[rows.value.length - 1]?.recorded_at);
watch(type, () => load());
onMounted(() => { announceTitle('Журнал изменений'); void load(); });
</script>
