<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <div class="q-card tdDialog">
      <div class="dlgHead">
        <div>
          <div class="dlgTitle">Новая переговорная кампания</div>
          <div class="dlgSub">Переговоры с одной аптечной сетью об условиях на период. Версии предложения и согласование добавляются в карточке.</div>
        </div>
        <div class="spacer" />
        <button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
      </div>
      <form class="dlgBody" @submit.prevent="save">
        <div class="formGrid">
          <div>
            <label class="fieldLabel">Аптечная сеть<span class="req">*</span></label>
            <TdSelect v-model="form.network_id" :options="networkOptions" placeholder="Выберите сеть" style="width: 100%" aria-label="Сеть" :error="err.field === 'network_id'" />
            <div v-if="owner" class="fieldHint">Ответственный КАМ — {{ owner.name }}</div>
          </div>
          <div>
            <label class="fieldLabel">Тип кампании<span class="req">*</span></label>
            <TdSelect v-model="form.type_id" :options="typeOptions" placeholder="Выберите тип" style="width: 100%" aria-label="Тип" @update:model-value="onType" />
          </div>
          <div class="full">
            <label class="fieldLabel" for="nc-title">Название<span class="req">*</span></label>
            <q-input for="nc-title" v-model="form.title" outlined dense maxlength="200" aria-label="Название" hide-bottom-space :error="err.field === 'title'" placeholder="Например, Годовые условия 2027" />
          </div>
          <div>
            <label class="fieldLabel" for="nc-from">Начало периода условий<span class="req">*</span></label>
            <q-input for="nc-from" v-model="form.period_from" type="date" outlined dense aria-label="Начало периода" hide-bottom-space :error="err.field === 'period_from'" />
          </div>
          <div>
            <label class="fieldLabel" for="nc-to">Окончание<span class="req">*</span></label>
            <q-input for="nc-to" v-model="form.period_to" type="date" outlined dense aria-label="Окончание периода" hide-bottom-space :error="err.field === 'period_to'" />
          </div>
          <div>
            <label class="fieldLabel" for="nc-control">Контрольная дата</label>
            <q-input for="nc-control" v-model="form.control_date" type="date" outlined dense aria-label="Контрольная дата" hide-bottom-space :error="err.field === 'control_date'" />
            <div class="fieldHint">К этой дате условия должны быть согласованы. {{ controlHint }}</div>
          </div>
          <div class="full">
            <label class="fieldLabel">Юрлица сети (ИНН)<span class="req">*</span></label>
            <div v-if="!form.network_id" class="fieldHint">Выберите сеть — появится список её юрлиц.</div>
            <div v-else-if="entities.length" class="checkList">
              <label v-for="e in entities" :key="e.id">
                <input v-model="selected" type="checkbox" :value="e.id" />
                <span style="flex: 1">{{ e.name }}</span>
                <span class="mono sub">ИНН {{ e.inn }}</span>
              </label>
            </div>
            <div v-else class="banner error">У сети нет действующих юрлиц. Администратор добавляет ИНН в разделе «Сети и юрлица».</div>
            <div class="fieldHint">Исполнение условий в PharmaCheck отслеживается по выбранным ИНН.</div>
          </div>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        <button type="submit" hidden />
      </form>
      <div class="dlgFoot">
        <button v-close-popup class="tdBtn">Отмена</button>
        <button class="tdBtn primary" :disabled="busy || !ready" @click="save"><q-spinner v-if="busy" size="14px" /><span>Создать кампанию</span></button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api } from '../api';
import { base, state } from '../store';
import { useCommand } from '../command';
import { fmtDate } from '../format';
import Icon from './Icon.vue';
import TdSelect from './TdSelect.vue';

const emit = defineEmits<{ close: []; created: [r: { id: string; warnings: { message: string }[] }] }>();
const { err, busy, run } = useCommand();
const assignable = computed(() => state.ref?.assignable ?? []);
const form = reactive({
  network_id: null as string | null,
  type_id: null as string | null,
  title: '',
  period_from: '',
  period_to: '',
  control_date: '',
});
const entities = ref<{ id: string; inn: string; name: string }[]>([]);
const selected = ref<string[]>([]);

const owner = computed(() => assignable.value.find((a) => form.network_id && a.network_ids.includes(form.network_id)));
const networkOptions = computed(() => {
  const ids = new Set(assignable.value.flatMap((a) => a.network_ids));
  return (state.ref?.networks ?? []).filter((n) => ids.has(n.id)).map((n) => ({ label: n.name, value: n.id }));
});
const typeOptions = computed(() => (state.ref?.types ?? []).map((t) => ({ label: t.name, value: t.id })));
const type = computed(() => state.ref?.types.find((t) => t.id === form.type_id));
const controlHint = computed(() => {
  if (form.control_date || !type.value || !form.period_from) return '';
  const d = new Date(Date.parse(form.period_from + 'T00:00:00Z') - type.value.control_days * 86400_000).toISOString().slice(0, 10);
  return `Если не указать — ${fmtDate(d)} (за ${type.value.control_days} дн. до начала).`;
});
const ready = computed(() => owner.value && form.network_id && form.type_id && form.title.trim() && form.period_from && form.period_to && selected.value.length);

// Подсказка периода и названия по типу: годовые — следующий календарный год, акция — следующий месяц.
function onType() {
  const t = type.value;
  if (!t) return;
  const now = new Date();
  const y = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  if (!form.period_from) {
    if (t.period_split === 'MONTH') {
      const m = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
      const end = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
      form.period_from = m.toISOString().slice(0, 10);
      form.period_to = end.toISOString().slice(0, 10);
    } else {
      form.period_from = `${y}-01-01`;
      form.period_to = `${y}-12-31`;
    }
  }
  if (!form.title.trim()) form.title = t.period_split === 'MONTH' ? '' : `${t.name} ${form.period_from.slice(0, 4)}`;
}

watch(() => form.network_id, async (id) => {
  entities.value = [];
  selected.value = [];
  if (!id) return;
  const r = await api.get<{ items: { id: string; inn: string; name: string }[] }>(`${base()}/reference/networks/${id}/legal-entities`);
  if (form.network_id !== id) return;
  entities.value = r.items;
  selected.value = r.items.map((e) => e.id);
});

async function save() {
  if (!ready.value) return;
  const r = await run(() => api.post<{ id: string; warnings: { message: string }[] }>(`${base()}/campaigns`, {
    owner_id: owner.value?.id, network_id: form.network_id, type_id: form.type_id, title: form.title,
    period_from: form.period_from, period_to: form.period_to, control_date: form.control_date || null, legal_entity_ids: selected.value,
  }));
  if (r) emit('created', r.data);
}
</script>
