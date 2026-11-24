<template>
  <q-dialog :model-value="true" persistent @hide="emit('close')">
    <div class="q-card tdDialog">
      <div class="dlgHead">
        <div><div class="dlgTitle">Реквизиты кампании</div><div class="dlgSub">{{ campaign.network.name }} · {{ campaign.type.name }}. Сеть и тип не меняются — при ошибке отмените кампанию и создайте новую.</div></div>
        <div class="spacer" /><button v-close-popup class="iconBtn" aria-label="Закрыть"><Icon id="x-close" :size="18" /></button>
      </div>
      <form class="dlgBody" @submit.prevent="save">
        <div class="formGrid">
          <div class="full">
            <label class="fieldLabel" for="ec-title">Название<span class="req">*</span></label>
            <q-input for="ec-title" v-model="form.title" outlined dense maxlength="200" aria-label="Название" hide-bottom-space :error="err.field === 'title'" />
          </div>
          <div>
            <label class="fieldLabel" for="ec-from">Начало периода<span class="req">*</span></label>
            <q-input for="ec-from" v-model="form.period_from" type="date" outlined dense aria-label="Начало периода" hide-bottom-space :error="err.field === 'period_from'" />
          </div>
          <div>
            <label class="fieldLabel" for="ec-to">Окончание<span class="req">*</span></label>
            <q-input for="ec-to" v-model="form.period_to" type="date" outlined dense aria-label="Окончание периода" hide-bottom-space :error="err.field === 'period_to'" />
          </div>
          <div>
            <label class="fieldLabel" for="ec-control">Контрольная дата<span class="req">*</span></label>
            <q-input for="ec-control" v-model="form.control_date" type="date" outlined dense aria-label="Контрольная дата" hide-bottom-space :error="err.field === 'control_date'" />
          </div>
          <div class="full">
            <label class="fieldLabel">Юрлица сети (ИНН)<span class="req">*</span></label>
            <div class="checkList">
              <label v-for="e in activeEntities" :key="e.id">
                <input v-model="selected" type="checkbox" :value="e.id" />
                <span style="flex: 1">{{ e.name }}</span>
                <span class="mono sub">ИНН {{ e.inn }}</span>
              </label>
            </div>
          </div>
        </div>
        <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
        <button type="submit" hidden />
      </form>
      <div class="dlgFoot">
        <button v-close-popup class="tdBtn">Отмена</button>
        <button class="tdBtn primary" :disabled="busy || !selected.length" @click="save"><q-spinner v-if="busy" size="14px" /><span>Сохранить</span></button>
      </div>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '../api';
import { base } from '../store';
import { useCommand } from '../command';
import type { Campaign } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{ campaign: Campaign; etag: string }>();
const emit = defineEmits<{ close: []; saved: [warnings: { message: string }[]] }>();
const { err, busy, run } = useCommand();
const c = props.campaign;
const form = reactive({ title: c.title, period_from: c.period_from, period_to: c.period_to, control_date: c.control_date });
const activeEntities = computed(() => c.legal_entities.filter((e) => e.active));
const selected = ref(c.legal_entities.filter((e) => e.selected && e.active).map((e) => e.id));

async function save() {
  const r = await run(() => api.patch<{ warnings: { message: string }[] }>(`${base()}/campaigns/${c.id}`, { ...form, legal_entity_ids: selected.value }, props.etag));
  if (r) emit('saved', r.data.warnings ?? []);
}
</script>
