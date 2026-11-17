<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Аптечные сети и юрлица</div>
        <div class="note">Юрлица (ИНН) сети определяют, по каким организациям PharmaCheck отслеживает исполнение условий. Позже справочник будет приходить из MDM.</div>
      </div>
      <button class="tdBtn" @click="groupDlg = true"><Icon id="plus" :size="15" /><span>Группа сетей</span></button>
      <button class="tdBtn primary" @click="open(null)"><Icon id="plus" :size="15" /><span>Новая сеть</span></button>
    </div>
    <div class="tableTools">
      <q-input v-model="search" outlined dense clearable placeholder="Сеть, ИНН или регион" class="searchCtl" style="width: 260px" aria-label="Поиск" hide-bottom-space>
        <template #prepend><Icon id="search-sm" :size="15" class="muted" /></template>
      </q-input>
      <TdSelect v-model="groupFilter" clearable :options="groupOptions" placeholder="Все группы" aria-label="Группа" />
    </div>
    <q-table class="tdTable" flat row-key="id" :rows="filtered" :columns="columns" :loading="loading" :pagination="{ rowsPerPage: 0 }" hide-pagination no-data-label="Сетей нет" @row-click="(_: unknown, r: Network) => open(r)">
      <template #body-cell-name="p">
        <q-td :props="p">
          <div style="font-weight: 600">{{ p.row.name }}<span v-if="p.row.archived" class="pill red" style="margin-left: 6px">в архиве</span></div>
          <div class="cellSub">{{ p.row.regions.join(', ') || 'регионы не указаны' }}</div>
        </q-td>
      </template>
      <template #body-cell-entities="p">
        <q-td :props="p">
          <div v-for="e in p.row.legal_entities.slice(0, 3)" :key="e.id" :class="{ muted: !e.active }"><span class="mono">{{ e.inn }}</span> · {{ e.name }}</div>
          <div v-if="p.row.legal_entities.length > 3" class="cellSub">и ещё {{ p.row.legal_entities.length - 3 }}</div>
          <span v-if="!p.row.legal_entities.length" class="pill amber">нет ИНН</span>
        </q-td>
      </template>
      <template #body-cell-kams="p"><q-td :props="p">{{ (p.row as Network).kams.map((k) => k.name).join(', ') || '—' }}</q-td></template>
    </q-table>

    <!-- Сеть -->
    <q-dialog v-if="editing" :model-value="true" persistent @hide="editing = null">
      <div class="q-card tdDialog wide">
        <div class="dlgHead">
          <div><div class="dlgTitle">{{ editing.id ? editing.name : 'Новая сеть' }}</div><div class="dlgSub">Закрепление КАМ за сетью настраивается в карточке сотрудника.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
        </div>
        <div class="dlgBody">
          <div class="formGrid">
            <div><label class="fieldLabel" for="nw-name">Название<span class="req">*</span></label>
              <q-input for="nw-name" v-model="editing.name" outlined dense maxlength="200" aria-label="Название" hide-bottom-space :error="err.field === 'name'" /></div>
            <div><label class="fieldLabel">Группа</label>
              <TdSelect v-model="editing.group_id" clearable :options="groupOptions" placeholder="Без группы" style="width: 100%" aria-label="Группа" /></div>
            <div class="full"><label class="fieldLabel" for="nw-reg">Регионы</label>
              <q-input for="nw-reg" v-model="editing.regions" outlined dense aria-label="Регионы" hide-bottom-space placeholder="Через запятую: Москва, Московская область" /></div>
            <div v-if="editing.id" class="full">
              <label class="choice" :class="{ on: editing.archived }"><input v-model="editing.archived" type="checkbox" />
                <span><b>В архиве</b><small>Сеть не предлагается для новых кампаний; существующие кампании сохраняются.</small></span></label>
            </div>
          </div>
          <template v-if="editing.id">
            <div class="panelTitle" style="margin: 18px 0 8px">Юрлица сети</div>
            <div class="miniWrap">
              <table class="miniTable">
                <thead><tr><th style="width: 130px">ИНН</th><th>Наименование</th><th style="width: 130px"></th></tr></thead>
                <tbody>
                  <tr v-for="e in current?.legal_entities ?? []" :key="e.id" :class="{ inactive: !e.active }">
                    <td class="mono">{{ e.inn }}</td><td>{{ e.name }}</td>
                    <td class="actionCell"><button class="linkBtn" :disabled="busy" @click="toggleEntity(e)">{{ e.active ? 'Сделать неактивным' : 'Вернуть' }}</button></td>
                  </tr>
                  <tr v-if="!current?.legal_entities.length"><td colspan="3" class="muted">Юрлиц нет. Добавьте ИНН — без них кампанию по сети создать нельзя.</td></tr>
                </tbody>
              </table>
            </div>
            <div class="toolbar" style="margin-top: 10px">
              <q-input v-model="entity.inn" outlined dense maxlength="12" style="width: 140px" placeholder="ИНН" aria-label="ИНН" hide-bottom-space :error="err.field === 'inn'" />
              <q-input v-model="entity.name" outlined dense maxlength="250" style="flex: 1; min-width: 220px" placeholder="ООО «…»" aria-label="Наименование" hide-bottom-space />
              <button class="tdBtn accent" :disabled="busy || !entity.inn || !entity.name" @click="addEntity"><Icon id="plus" :size="15" /><span>Добавить</span></button>
            </div>
          </template>
          <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        </div>
        <div class="dlgFoot">
          <button v-close-popup class="tdBtn">Закрыть</button>
          <button class="tdBtn primary" :disabled="busy || !editing.name.trim()" @click="save">{{ editing.id ? 'Сохранить' : 'Создать и добавить ИНН' }}</button>
        </div>
      </div>
    </q-dialog>

    <q-dialog v-if="groupDlg" :model-value="true" @hide="groupDlg = false">
      <div class="q-card tdDialog narrow">
        <div class="dlgHead"><div><div class="dlgTitle">Новая группа сетей</div><div class="dlgSub">Группы используются в фильтрах и правилах выбора маршрута согласования.</div></div>
          <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button></div>
        <div class="dlgBody"><q-input v-model="groupName" outlined dense maxlength="120" aria-label="Название группы" hide-bottom-space autofocus placeholder="Например, Федеральные сети" />
          <div v-if="err.message" class="formError">{{ err.message }}</div></div>
        <div class="dlgFoot"><button v-close-popup class="tdBtn">Отмена</button><button class="tdBtn primary" :disabled="busy || !groupName.trim()" @click="addGroup">Создать</button></div>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, loadRef, announceTitle } from '../store';
import { useCommand } from '../command';
import type { Network } from '../types';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';

const $q = useQuasar();
const rows = ref<Network[]>([]);
const groups = ref<{ id: string; name: string }[]>([]);
const loading = ref(false);
const search = ref('');
const groupFilter = ref<string | null>(null);
const editing = ref<{ id: string | null; name: string; regions: string; group_id: string | null; archived: boolean } | null>(null);
const entity = reactive({ inn: '', name: '' });
const groupDlg = ref(false);
const groupName = ref('');
const { err, busy, run } = useCommand();

const columns = [
  { name: 'name', label: 'Сеть', field: 'name', align: 'left' as const, sortable: true },
  { name: 'group', label: 'Группа', field: (r: Network) => r.group_name ?? '—', align: 'left' as const, sortable: true },
  { name: 'entities', label: 'Юрлица (ИНН)', field: (r: Network) => r.legal_entities.length, align: 'left' as const },
  { name: 'kams', label: 'КАМ', field: (r: Network) => r.kams.map((k) => k.name).join(', '), align: 'left' as const, sortable: true },
  { name: 'campaigns', label: 'Кампаний', field: 'campaigns', align: 'right' as const, sortable: true },
];
const groupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: g.id })));
const current = computed(() => rows.value.find((r) => r.id === editing.value?.id));
const filtered = computed(() => {
  const q = search.value?.toLowerCase() ?? '';
  return rows.value.filter((n) => (!groupFilter.value || n.group_id === groupFilter.value)
    && (!q || n.name.toLowerCase().includes(q) || n.regions.some((r) => r.toLowerCase().includes(q)) || n.legal_entities.some((e) => e.inn.includes(q))));
});

function open(n: Network | null) {
  err.message = '';
  editing.value = n ? { id: n.id, name: n.name, regions: n.regions.join(', '), group_id: n.group_id, archived: n.archived } : { id: null, name: '', regions: '', group_id: null, archived: false };
}
async function load() {
  loading.value = true;
  try {
    const r = await api.get<{ items: Network[]; groups: { id: string; name: string }[] }>(`${base()}/networks`);
    rows.value = r.items;
    groups.value = r.groups;
  } finally { loading.value = false; }
}
async function save() {
  const e = editing.value!;
  const body = { name: e.name, regions: e.regions.split(',').map((s) => s.trim()).filter(Boolean), group_id: e.group_id, archived: e.archived };
  const r = await run(() => (e.id ? api.put(`${base()}/networks/${e.id}`, body) : api.post<{ id: string }>(`${base()}/networks`, body)));
  if (!r) return;
  await load();
  void loadRef();
  if (!e.id) { e.id = (r.data as { id: string }).id; $q.notify({ type: 'positive', message: 'Сеть создана — добавьте ИНН' }); }
  else { editing.value = null; $q.notify({ type: 'positive', message: 'Сохранено' }); }
}
async function addEntity() {
  const r = await run(() => api.post(`${base()}/networks/${editing.value!.id}/legal-entities`, { inn: entity.inn.trim(), name: entity.name }));
  if (r) { entity.inn = ''; entity.name = ''; await load(); void loadRef(); }
}
async function toggleEntity(e: { id: string; name: string; active: boolean }) {
  const r = await run(() => api.put(`${base()}/networks/${editing.value!.id}/legal-entities/${e.id}`, { name: e.name, active: !e.active }));
  if (r) await load();
}
async function addGroup() {
  const r = await run(() => api.post(`${base()}/network-groups`, { name: groupName.value }));
  if (r) { groupDlg.value = false; groupName.value = ''; await load(); }
}
onMounted(() => { announceTitle('Сети и юрлица'); void load(); });
</script>
