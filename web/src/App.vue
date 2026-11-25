<template>
  <div v-if="booting" class="fixed-center"><q-spinner size="32px" color="primary" /></div>

  <LoginPage v-else-if="!state.me" @logged-in="boot" />

  <!-- Встроенный режим: модуль внутри страницы платформы, меню и профиль — платформенные. -->
  <div v-else-if="embedded" class="embedShell">
    <div class="embedNav">
      <div class="tdTabs" role="tablist" aria-label="Разделы переговоров">
        <button v-for="t in embedTabs" :key="t.page" role="tab" :class="{ active: t.active }" :aria-selected="t.active" :disabled="t.disabled" @click="go(t.page)">
          {{ t.label }}<q-tooltip v-if="t.disabled">{{ t.hint }}</q-tooltip>
        </button>
      </div>
      <div class="spacer" />
      <TdSelect v-if="state.me.companies.length > 1" :model-value="state.companyId" :options="companyOptions" aria-label="Компания" @update:model-value="(v: unknown) => switchCompany(v as string)" />
      <NotificationBell v-if="company" />
    </div>
    <div v-if="adminPage" class="tdTabs" style="margin-bottom: 14px" role="tablist" aria-label="Настройки">
      <button v-for="a in adminNav" :key="a.page" role="tab" :class="{ active: state.page === a.page }" @click="go(a.page)">{{ a.label }}</button>
    </div>
    <PageBody />
  </div>

  <div v-else class="appShell" :class="{ collapsed }">
    <aside class="sidebar">
      <div class="sidebarTop">
        <img v-if="!collapsed" class="logoImg" src="/truedata-logo.png" alt="TrueData" />
        <img v-else class="logoMark" src="/favicon.png" alt="TrueData" />
        <button class="iconBtn collapseBtn" :aria-label="collapsed ? 'Развернуть меню' : 'Свернуть меню'" @click="toggleCollapsed">
          <Icon :id="collapsed ? 'chevron-right' : 'chevron-left'" :size="18" />
        </button>
      </div>
      <div class="productBlock">
        <div class="productName">PharmaCheck</div>
        <div class="productRule" />
        <Icon id="chevron-down" :size="15" />
      </div>

      <nav class="sideNav" aria-label="Разделы">
        <!-- Блок PharmaCheck основной системы: на демо-стенде активен только раздел «Переговоры». -->
        <div class="navItem disabled" aria-disabled="true"><Icon id="bar-chart-square-02" :size="15" /><span>Дашборды</span><q-tooltip anchor="center right" self="center left">Раздел основной системы PharmaCheck</q-tooltip></div>
        <button class="navItem" :class="{ active: state.page === 'portfolio' || state.page === 'campaign' }" @click="go('portfolio')">
          <Icon id="layers-three-01" :size="15" /><span>Переговоры</span>
          <q-tooltip v-if="collapsed" anchor="center right" self="center left">Переговоры</q-tooltip>
        </button>
        <button class="navItem sub" :class="{ active: state.page === 'decisions' }" :aria-current="state.page === 'decisions' ? 'page' : undefined" @click="go('decisions')">
          <Icon id="inbox-01" :size="15" /><span>Мои решения</span>
          <span v-if="state.pendingDecisions && !collapsed" class="navBadge">{{ state.pendingDecisions }}</span>
          <q-tooltip v-if="collapsed" anchor="center right" self="center left">Мои решения</q-tooltip>
        </button>
        <button v-if="can('ANALYTICS')" class="navItem sub" :class="{ active: state.page === 'analytics' }" :aria-current="state.page === 'analytics' ? 'page' : undefined" @click="go('analytics')">
          <Icon id="bar-chart-square-02" :size="15" /><span>Аналитика</span>
          <q-tooltip v-if="collapsed" anchor="center right" self="center left">Аналитика</q-tooltip>
        </button>
        <div v-for="n in platformNav" :key="n.label" class="navItem disabled" aria-disabled="true">
          <Icon :id="n.icon" :size="15" /><span>{{ n.label }}</span>
          <q-tooltip anchor="center right" self="center left">Раздел основной системы PharmaCheck</q-tooltip>
        </div>

        <template v-if="isAdmin">
          <div class="navSection">Настройки переговоров</div>
          <button v-for="a in adminNav" :key="a.page" class="navItem" :class="{ active: state.page === a.page }" :aria-current="state.page === a.page ? 'page' : undefined" @click="go(a.page)">
            <Icon :id="a.icon" :size="15" /><span>{{ a.label }}</span>
            <q-tooltip v-if="collapsed" anchor="center right" self="center left">{{ a.label }}</q-tooltip>
          </button>
        </template>
      </nav>
    </aside>

    <main class="content">
      <header class="topbar">
        <div class="crumb">
          <button aria-label="К портфелю" @click="go('portfolio')"><Icon id="home-02" :size="15" /></button>
          <span class="sep">›</span>
          <template v-if="adminPage"><span class="crumbMid">Настройки переговоров</span><span class="sep crumbMid">›</span><strong>{{ adminTitle }}</strong></template>
          <template v-else-if="state.page === 'campaign'">
            <button class="crumbMid" @click="go('portfolio')">Переговоры</button><span class="sep crumbMid">›</span><strong>{{ crumbTitle || 'Кампания' }}</strong>
          </template>
          <strong v-else>Переговоры</strong>
        </div>
        <div class="row items-center no-wrap" style="gap: 10px">
          <TdSelect v-if="state.me.companies.length > 1" :model-value="state.companyId" :options="companyOptions" aria-label="Компания" @update:model-value="(v: unknown) => switchCompany(v as string)" />
          <span v-else-if="company" class="note">{{ company.name }}</span>
          <NotificationBell v-if="company" />
          <button class="avatar" :aria-label="`Профиль: ${profileName}`">
            {{ initials(profileName) }}
            <q-menu anchor="bottom right" self="top right" :offset="[0, 6]">
              <div style="min-width: 240px; padding: 12px 14px">
                <div style="font-weight: 600">{{ profileName }}</div>
                <div class="muted">{{ state.me.email }}</div>
                <div class="note" style="margin-top: 8px">{{ company?.name }}</div>
                <div class="muted">{{ company?.roles.join(', ') || 'роли не назначены' }}</div>
              </div>
              <q-separator />
              <q-item v-if="state.me.via === 'PASSWORD'" v-close-popup clickable @click="pwdDlg = true">
                <q-item-section avatar style="min-width: 28px"><Icon id="lock-01" :size="16" /></q-item-section>
                <q-item-section>Сменить пароль</q-item-section>
              </q-item>
              <q-item v-close-popup clickable @click="logout">
                <q-item-section avatar style="min-width: 28px"><Icon id="log-out-01" :size="16" /></q-item-section>
                <q-item-section>Выйти</q-item-section>
              </q-item>
            </q-menu>
          </button>
        </div>
      </header>
      <div class="pageBody"><PageBody /></div>
    </main>
    <PasswordDialog v-if="pwdDlg || state.me.must_change_password" :forced="state.me.must_change_password" @close="pwdDlg = false" @changed="onPasswordChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, provide } from 'vue';
import { useQuasar } from 'quasar';
import { api, setUnauthorizedHandler } from './api';
import { state, company, embedded, isAdmin, can, loadMe, loadRef, selectCompany, go, readRoute, refreshPending, type Page } from './store';
import { initials } from './format';
import LoginPage from './pages/LoginPage.vue';
import PortfolioPage from './pages/PortfolioPage.vue';
import CampaignPage from './pages/CampaignPage.vue';
import UsersPage from './pages/UsersPage.vue';
import RolesPage from './pages/RolesPage.vue';
import NetworksPage from './pages/NetworksPage.vue';
import BrandsPage from './pages/BrandsPage.vue';
import TypesPage from './pages/TypesPage.vue';
import AuditPage from './pages/AuditPage.vue';
import PriorPage from './pages/PriorPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import MyDecisionsPage from './pages/MyDecisionsPage.vue';
import AnalyticsPage from './pages/AnalyticsPage.vue';
import RoutesPage from './pages/RoutesPage.vue';
import SubstitutionsPage from './pages/SubstitutionsPage.vue';
import PasswordDialog from './components/PasswordDialog.vue';
import Icon from './components/Icon.vue';
import TdSelect from './components/TdSelect.vue';
import NotificationBell from './components/NotificationBell.vue';

const $q = useQuasar();
const booting = ref(true);
const collapsed = ref(readCollapsed());
const crumbTitle = ref('');
provide('setCrumb', (t: string) => { crumbTitle.value = t; });

const platformNav = [
  { label: 'Договоры', icon: 'file-05' },
  { label: 'Базовые отчеты', icon: 'grid-01' },
  { label: 'Мои отчеты', icon: 'user-01' },
  { label: 'Общие отчеты', icon: 'users-01' },
];
const adminNav: { page: Page; label: string; icon: string }[] = [
  { page: 'users', label: 'Пользователи', icon: 'users-01' },
  { page: 'roles', label: 'Роли', icon: 'shield-tick' },
  { page: 'networks', label: 'Сети и юрлица', icon: 'building-07' },
  { page: 'brands', label: 'Бренды', icon: 'tag-01' },
  { page: 'types', label: 'Типы кампаний', icon: 'calendar' },
  { page: 'routes', label: 'Маршруты согласования', icon: 'git-merge' },
  { page: 'substitutions', label: 'Замещения', icon: 'users-01' },
  { page: 'prior', label: 'Прошлые периоды', icon: 'clock-rewind' },
  { page: 'settings', label: 'Настройки', icon: 'grid-01' },
  { page: 'audit', label: 'Журнал изменений', icon: 'file-05' },
];
const adminPage = computed(() => adminNav.some((a) => a.page === state.page));
const adminTitle = computed(() => adminNav.find((a) => a.page === state.page)?.label ?? '');
const embedTabs = computed(() => [
  { page: 'portfolio' as Page, label: 'Кампании', active: state.page === 'portfolio' || state.page === 'campaign', disabled: false, hint: '' },
  { page: 'decisions' as Page, label: state.pendingDecisions ? `Мои решения · ${state.pendingDecisions}` : 'Мои решения', active: state.page === 'decisions', disabled: false, hint: '' },
  ...(can('ANALYTICS') ? [{ page: 'analytics' as Page, label: 'Аналитика', active: state.page === 'analytics', disabled: false, hint: '' }] : []),
  ...(isAdmin.value ? [{ page: 'users' as Page, label: 'Настройки', active: adminPage.value, disabled: false, hint: '' }] : []),
]);
const companyOptions = computed(() => (state.me?.companies ?? []).map((c) => ({ label: c.name, value: c.id })));
const profileName = computed(() => company.value?.display_name ?? state.me?.display_name ?? '');

// Страница по маршруту; ключ по компании пересоздаёт её при смене клиента.
const PageBody = defineComponent({
  setup() {
    return () => {
      if (!company.value) return h('div', { class: 'panel emptyState' }, 'У вашей учётной записи нет доступа ни к одной компании. Обратитесь к администратору.');
      const key = `${state.companyId}:${state.page}:${state.campaignId ?? ''}`;
      const map: Partial<Record<Page, unknown>> = { portfolio: PortfolioPage, campaign: CampaignPage, users: UsersPage, roles: RolesPage, networks: NetworksPage, brands: BrandsPage, types: TypesPage, routes: RoutesPage, substitutions: SubstitutionsPage, decisions: MyDecisionsPage, analytics: AnalyticsPage, prior: PriorPage, settings: SettingsPage, audit: AuditPage };
      const comp = map[state.page] ?? PortfolioPage;
      if (adminPage.value && !isAdmin.value) return h('div', { class: 'panel emptyState' }, 'Раздел доступен администратору.');
      return h(comp as any, { key, ...(state.page === 'campaign' ? { id: state.campaignId } : {}) });
    };
  },
});

setUnauthorizedHandler(() => {
  if (state.me) $q.notify({ type: 'warning', message: embedded ? 'Сессия завершилась. Откройте раздел «Переговоры» заново.' : 'Сессия завершилась. Войдите снова.' });
  state.me = null;
});

async function boot() {
  booting.value = true;
  try {
    await loadMe();
    await loadRef();
    readRoute();
    void refreshPending();
  } catch {
    state.me = null;
  } finally {
    booting.value = false;
  }
}

async function switchCompany(id: string) {
  selectCompany(id);
  await loadRef();
  void refreshPending();
  go('portfolio');
}

const pwdDlg = ref(false);
async function onPasswordChanged() {
  pwdDlg.value = false;
  await loadMe();
}

async function logout() {
  await api.post('/auth/logout', {}).catch(() => undefined);
  state.me = null;
}

function readCollapsed() {
  try { return localStorage.getItem('kam.sidebar') === 'collapsed'; } catch { return false; }
}
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try { localStorage.setItem('kam.sidebar', collapsed.value ? 'collapsed' : 'open'); } catch { /* удобство */ }
}

const onHash = () => { readRoute(); void refreshPending(); };
onMounted(() => { window.addEventListener('hashchange', onHash); void boot(); });
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));
</script>

<style>
.navItem.sub { padding-left: 22px; grid-template-columns: 15px 1fr auto; }
.navItem.sub:disabled { color: var(--faint); cursor: default; background: transparent; }
.navItem.sub:disabled .tdIcon { color: #c4c9d2; }
.appShell.collapsed .navItem.sub { padding-left: 0; }
.crumb button.crumbMid { color: var(--muted); }
</style>
