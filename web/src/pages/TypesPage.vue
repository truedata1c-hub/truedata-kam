<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Типы кампаний</div>
        <div class="note">Тип задаёт деление периода (столбцы разбивки версий) и контрольную дату по умолчанию. Тип используется в правилах выбора маршрута согласования.</div>
      </div>
      <button class="tdBtn primary" @click="open(null)"><Icon id="plus" :size="15" /><span>Новый тип</span></button>
    </div>
    <q-table class="tdTable" flat row-key="id" :rows="rows" :columns="columns" :pagination="{ rowsPerPage: 0 }" hide-pagination no-data-label="Типов нет" @row-click="(_: unknown, r: CType) => open(r)">
      <template #body-cell-name="p"><q-td :props="p"><span style="font-weight: 500">{{ p.row.name }}</span><span v-if="p.row.archived" class="pill red" style="margin-left: 6px">в архиве</span></q-td></template>
      <template #body-cell-split="p"><q-td :props="p">{{ SPLIT_LABEL[p.row.period_split] }}</q-td></template>
      <template #body-cell-days="p"><q-td :props="p">за {{ p.row.control_days }} {{ plural(p.row.control_days, 'день', 'дня', 'дней') }} до начала</q-td></template>
    </q-table>

    <q-dialog v-if="editing" :model-value="true" persistent @hide="editing = null">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">{{ editing.id ? 'Тип кампании' : 'Новый тип кампании' }}</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <form class="dlgBody" @submit.prevent="save">
          <div class="formGrid">
            <div class="full"><label class="fieldLabel" for="tp-name">Название<span class="req">*</span></label>
              <q-input for="tp-name" v-model="editing.name" outlined dense maxlength="120" aria-label="Название" hide-bottom-space autofocus /></div>
            <div class="full"><label class="fieldLabel">Деление периода в разбивке<span class="req">*</span></label>
              <TdSelect v-model="editing.period_split" :options="splitOptions" style="width: 100%" aria-label="Деление периода" :error="err.field === 'period_split'" />
              <div class="fieldHint">Нельзя менять у типа, который уже используется в кампаниях.</div></div>
            <div><label class="fieldLabel" for="tp-days">Контрольная дата, дней до начала</label>
              <q-input for="tp-days" v-model.number="editing.control_days" type="number" min="0" max="365" outlined dense aria-label="Дней до начала" hide-bottom-space /></div>
            <div><label class="fieldLabel" for="tp-sort">Порядок в списках</label>
              <q-input for="tp-sort" v-model.number="editing.sort_order" type="number" outlined dense aria-label="Порядок" hide-bottom-space /></div>
            <div v-if="editing.id" class="full"><label class="choice" :class="{ on: editing.archived }"><input v-model="editing.archived" type="checkbox" /><span><b>В архиве</b><small>Не предлагается для новых кампаний.</small></span></label></div>
          </div>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
          <button type="submit" hidden />
        </form>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy || !editing.name.trim()" @click="save">Сохранить</button></div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, loadRef, announceTitle } from '../store';
import { useCommand } from '../command';
import { SPLIT_LABEL, plural } from '../format';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';

interface CType { id: string; name: string; period_split: string; control_days: number; archived: boolean; sort_order: number }
const $q = useQuasar();
const rows = ref<CType[]>([]);
const editing = ref<(Omit<CType, 'id'> & { id: string | null }) | null>(null);
const { err, busy, run } = useCommand();
const splitOptions = Object.entries(SPLIT_LABEL).map(([value, label]) => ({ value, label }));
const columns = [
  { name: 'name', label: 'Тип', field: 'name', align: 'left' as const },
  { name: 'split', label: 'Разбивка версий', field: 'period_split', align: 'left' as const },
  { name: 'days', label: 'Контрольная дата по умолчанию', field: 'control_days', align: 'left' as const },
];
function open(t: CType | null) {
  err.message = '';
  editing.value = t ? { ...t } : { id: null, name: '', period_split: 'QUARTER', control_days: 14, archived: false, sort_order: rows.value.length };
}
async function load() { rows.value = (await api.get<{ items: CType[] }>(`${base()}/campaign-types`)).items; }
async function save() {
  const e = editing.value!;
  const body = { name: e.name, period_split: e.period_split, control_days: e.control_days, sort_order: e.sort_order, archived: e.archived };
  if (await run(() => (e.id ? api.put(`${base()}/campaign-types/${e.id}`, body) : api.post(`${base()}/campaign-types`, body)))) {
    editing.value = null;
    $q.notify({ type: 'positive', message: 'Сохранено' });
    await load();
    void loadRef();
  }
}
onMounted(() => { announceTitle('Типы кампаний'); void load(); });
</script>
