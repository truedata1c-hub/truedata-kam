<template>
  <div>
    <div class="pageHead"><div style="flex: 1"><div class="pageTitle">Замещения</div>
      <div class="note">Кто кого замещает на время отсутствия. Сотрудник может назначить заместителя сам в разделе «Мои решения».</div></div></div>
    <SubstitutionsPanel admin />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { announceTitle } from '../store';
import SubstitutionsPanel from '../components/SubstitutionsPanel.vue';
onMounted(() => announceTitle('Замещения'));
</script>
