<template>
  <div style="max-width: 980px">
    <div class="pageHead">
      <div style="flex: 1">
        <div class="pageTitle">Настройки</div>
        <div class="note">Пороги подсветок при сравнении версии с прошлым периодом. Подсветки не запрещают отправку на согласование — они видны КАМ и согласующим.</div>
      </div>
    </div>
    <div v-if="form" class="panel" style="padding: 16px">
      <div class="formGrid">
        <div>
          <label class="fieldLabel" for="st-growth">Рост инвестиций бренда к факту прошлого периода, %</label>
          <q-input for="st-growth" v-model.number="form.investment_growth_pct" type="number" min="0" max="1000" outlined dense hide-bottom-space aria-label="Порог роста инвестиций" :error="err.field === 'investment_growth_pct'" />
          <div class="fieldHint">Выше порога — подсветка «Рост инвестиций».</div>
        </div>
        <div>
          <label class="fieldLabel" for="st-exec">Выполнение плана оборота прошлого периода ниже, %</label>
          <q-input for="st-exec" v-model.number="form.execution_below_pct" type="number" min="0" max="200" outlined dense hide-bottom-space aria-label="Порог выполнения плана" :error="err.field === 'execution_below_pct'" />
          <div class="fieldHint">Ниже порога — подсветка «План прошлого не выполнен».</div>
        </div>
        <div class="full">
          <label class="choice" :class="{ on: form.roi_below_prior }"><input v-model="form.roi_below_prior" type="checkbox" />
            <span><b>Подсвечивать ROI ниже факта прошлого периода</b><small>Ожидаемый оборот на 1 ₽ инвестиций меньше фактического прошлого года.</small></span></label>
        </div>
      </div>
      <div v-if="err.message" class="formError" role="alert">{{ err.message }}</div>
      <div class="toolbar" style="margin-top: 14px"><button class="tdBtn primary" :disabled="busy" @click="save">Сохранить</button></div>
    </div>
    <MailSettings />
    <BackupStatus />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '../api';
import { base, announceTitle } from '../store';
import { useCommand } from '../command';
import MailSettings from '../components/MailSettings.vue';
import BackupStatus from '../components/BackupStatus.vue';

interface T { investment_growth_pct: number; execution_below_pct: number; roi_below_prior: boolean }
const $q = useQuasar();
const form = ref<T | null>(null);
const { err, busy, run } = useCommand();
async function save() {
  if (await run(() => api.put(`${base()}/settings/thresholds`, form.value))) $q.notify({ type: 'positive', message: 'Сохранено' });
}
onMounted(async () => { announceTitle('Настройки'); form.value = (await api.get<{ thresholds: T }>(`${base()}/settings`)).thresholds; });
</script>
