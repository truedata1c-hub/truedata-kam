<template>
  <div>
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Маршруты согласования</div>
        <div class="note">Шаблон — цепочка шагов: руководитель автора по оргструктуре, бизнес-роль или конкретный пользователь, с условиями включения и сроком. При отправке маршрут фиксируется в кампании с исполнителями.</div>
      </div>
      <button class="tdBtn primary" @click="edit(null)"><Icon id="plus" :size="15" /><span>Новый шаблон</span></button>
    </div>

    <div class="tplCards">
      <div v-for="t in templates" :key="t.id" class="panel tplCard">
        <div class="panelHead">
          <div class="panelTitle" style="flex: 1; min-width: 0">{{ t.name }}</div>
          <button class="linkBtn" @click="edit(t)">Изменить</button>
          <button v-if="!t.is_default" class="linkBtn" style="margin-left: 12px" @click="archive(t)">Удалить</button>
        </div>
        <div class="panelBody">
          <div v-if="t.is_default || t.in_progress" class="chips" style="margin-bottom: 8px">
            <span v-if="t.is_default" class="pill purple">по умолчанию</span>
            <span v-if="t.in_progress" class="pill amber">идёт согласований: {{ t.in_progress }}</span>
          </div>
          <div v-if="t.description" class="note" style="margin-bottom: 8px">{{ t.description }}</div>
          <ol class="tplSteps">
            <li v-for="(s, i) in t.steps" :key="i">
              <span class="dot">{{ i + 1 }}</span>
              <div>
                <div style="font-weight: 600; color: var(--ink)">{{ s.title }}</div>
                <div class="cellSub">{{ s.assignee_text }} · {{ s.deadline_days }} {{ plural(s.deadline_days, 'раб. день', 'раб. дня', 'раб. дней') }}</div>
                <div v-if="s.conditions_text?.length" class="cellSub">если {{ s.conditions_text.join('; ') }}</div>
              </div>
            </li>
          </ol>
          <div class="cellSub" style="margin-top: 8px">Допуски новой версии: инвестиции +{{ t.tolerance_investment_pct }} %, оборот −{{ t.tolerance_turnover_pct }} %</div>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top: 12px">
      <div class="panelHead">
        <div class="panelTitle">Правила выбора шаблона</div>
        <div class="spacer" />
        <button class="tdBtn" @click="rules.push({ template_id: '', campaign_type_id: null, network_group_id: null })"><Icon id="plus" :size="15" /><span>Правило</span></button>
        <button class="tdBtn primary" :disabled="busy || !dirty" @click="saveRules">Сохранить правила</button>
      </div>
      <div class="panelBody">
        <div class="note" style="margin-bottom: 8px">Правила проверяются сверху вниз; срабатывает первое подходящее. Если ни одно не подошло — шаблон по умолчанию{{ defaultName ? ` «${defaultName}»` : '' }}.</div>
        <div class="miniWrap">
          <table class="miniTable">
            <thead><tr><th style="width: 40px">№</th><th>Тип кампании</th><th>Группа сетей</th><th>Шаблон</th><th style="width: 110px"></th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in rules" :key="i">
                <td>{{ i + 1 }}</td>
                <td><TdSelect v-model="r.campaign_type_id" :options="typeOptions" clearable placeholder="Любой" :aria-label="`Тип кампании, правило ${i + 1}`" /></td>
                <td><TdSelect v-model="r.network_group_id" :options="groupOptions" clearable placeholder="Любая" :aria-label="`Группа сетей, правило ${i + 1}`" /></td>
                <td><TdSelect v-model="r.template_id" :options="templateOptions" placeholder="Шаблон" :aria-label="`Шаблон, правило ${i + 1}`" /></td>
                <td class="actionCell">
                  <button class="iconBtn" :disabled="i === 0" aria-label="Выше" @click="move(i, -1)"><Icon id="arrow-up" :size="14" /></button>
                  <button class="iconBtn" aria-label="Удалить правило" @click="rules.splice(i, 1)"><Icon id="trash-01" :size="14" /></button>
                </td>
              </tr>
              <tr v-if="!rules.length"><td colspan="5" class="muted">Правил нет — все кампании идут по шаблону по умолчанию.</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      </div>
    </div>

    <TemplateDialog v-if="dlg" :template="current" :roles="roles" :users="users" @close="dlg = false" @saved="afterSave" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, state, announceTitle } from '../store';
import { useCommand } from '../command';
import { plural } from '../format';
import Icon from '../components/Icon.vue';
import TdSelect from '../components/TdSelect.vue';
import TemplateDialog from '../components/TemplateDialog.vue';
import type { RouteRule, RouteTemplate } from '../types';

const $q = useQuasar();
const templates = ref<RouteTemplate[]>([]);
const rules = ref<RouteRule[]>([]);
let savedRules = '';
const roles = ref<any[]>([]);
const users = ref<any[]>([]);
const dlg = ref(false);
const current = ref<RouteTemplate | null>(null);
const { err, busy, run } = useCommand();

const typeOptions = computed(() => (state.ref?.types ?? []).map((t) => ({ label: t.name, value: t.id })));
const groupOptions = computed(() => (state.ref?.groups ?? []).map((g) => ({ label: g.name, value: g.id })));
const templateOptions = computed(() => templates.value.map((t) => ({ label: t.name, value: t.id })));
const defaultName = computed(() => templates.value.find((t) => t.is_default)?.name);
const strip = (r: RouteRule[]) => JSON.stringify(r.map((x) => [x.template_id, x.campaign_type_id, x.network_group_id]));
const dirty = computed(() => strip(rules.value) !== savedRules);

async function load() {
  const r = await api.get<{ items: RouteTemplate[]; rules: RouteRule[] }>(`${base()}/route-templates`);
  templates.value = r.items;
  rules.value = r.rules.map((x) => ({ template_id: x.template_id, campaign_type_id: x.campaign_type_id, network_group_id: x.network_group_id }));
  savedRules = strip(rules.value);
}
function edit(t: RouteTemplate | null) { current.value = t; dlg.value = true; }
async function afterSave() { dlg.value = false; $q.notify({ type: 'positive', message: 'Шаблон сохранён' }); await load(); }
function move(i: number, d: number) { const [x] = rules.value.splice(i, 1); rules.value.splice(i + d, 0, x!); }
async function saveRules() {
  if (await run(() => api.put(`${base()}/route-rules`, { rules: rules.value }))) { $q.notify({ type: 'positive', message: 'Правила сохранены' }); await load(); }
}
async function archive(t: RouteTemplate) {
  const r = await run(() => api.post(`${base()}/route-templates/${t.id}/archive`, {}));
  if (r) { $q.notify({ type: 'positive', message: `Шаблон «${t.name}» удалён` }); await load(); } else if (err.message) $q.notify({ type: 'negative', message: err.message });
}
onMounted(async () => {
  announceTitle('Маршруты согласования');
  const [, r, u] = await Promise.all([load(), api.get<{ items: any[] }>(`${base()}/roles`), api.get<{ items: any[] }>(`${base()}/users`)]);
  roles.value = r.items;
  users.value = u.items;
});
</script>

<style scoped>
.tplCards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.tplSteps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.tplSteps li { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; }
.tplSteps .dot { width: 20px; height: 20px; border-radius: 50%; background: var(--purple-soft); color: var(--purple); display: grid; place-items: center; font-size: 11px; font-weight: 600; }
.miniTable :deep(.selectCtl) { width: 100%; }
.actionCell { white-space: nowrap; }
.pageHead { display: flex; gap: 12px; align-items: flex-start; }
</style>
