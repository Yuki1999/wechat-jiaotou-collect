// ============================================================
// 入口：路由表 + 根组件 + 挂载
// 依赖全局构建的 Vue / VueRouter（window.Vue / window.VueRouter）
// ============================================================
import {
  ref, reactive, computed, watch, onMounted, onUnmounted,
  ui, api, authToken, currentUser, clearAuth,
  roleLabel, canManageW2R, showToast, showPrompt,
  closeToast, resolveModal, onGlobalKeydown,
  statsData, refreshStats,
} from './shared.js';
import Login from './pages/login.js';
import Dashboard from './pages/dashboard.js';
import Sources from './pages/sources.js';
import Wechat2RSS from './pages/wechat2rss.js';
import Tasks from './pages/tasks.js';
import Review from './pages/review.js';
import Briefs from './pages/briefs.js';
import Knowledge from './pages/knowledge.js';
import Wecom from './pages/wecom.js';

const { createApp } = Vue;
const { createRouter, createWebHashHistory, useRoute } = VueRouter;

const routes = [
  { path: '/login', component: Login, meta: { title: '登录', anonymous: true } },
  { path: '/', component: Dashboard, meta: { title: '工作台' } },
  { path: '/sources', component: Sources, meta: { title: '信息源管理' } },
  { path: '/wechat2rss', component: Wechat2RSS, meta: { title: '公众号订阅' } },
  { path: '/tasks', component: Tasks, meta: { title: '采集任务' } },
  { path: '/review', component: Review, meta: { title: '审核工作台' } },
  { path: '/briefs', component: Briefs, meta: { title: '简报管理' } },
  { path: '/knowledge', component: Knowledge, meta: { title: '知识库检索' } },
  { path: '/wecom', component: Wecom, meta: { title: '企微推送' } },
];
const router = createRouter({ history: createWebHashHistory(), routes });

// 路由守卫：未登录 → /login；已登录访问 /login → /
router.beforeEach((to, from, next) => {
  const anon = !!to.meta?.anonymous;
  if (!authToken.value && !anon) {
    next('/login');
  } else if (authToken.value && to.path === '/login') {
    next('/');
  } else {
    next();
  }
});

const App = {
  setup() {
    const route = useRoute();
    const pageTitle = computed(() => route.meta?.title || '工作台');
    const isAnon = computed(() => !!route.meta?.anonymous);
    const clock = ref('');
    // 与 Dashboard 共享同一份 /api/stats 数据（见 shared.js statsData）
    const globalStats = computed(() => statsData.stat || {});

    let clockTimer = null;
    let statsTimer = null;
    function updateClock() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      clock.value = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    async function refreshGlobalStats() {
      if (isAnon.value || !authToken.value) return;
      await refreshStats();
    }
    watch(() => route.path, refreshGlobalStats);
    onMounted(() => {
      updateClock();
      clockTimer = setInterval(updateClock, 1000);
      refreshGlobalStats();
      statsTimer = setInterval(refreshGlobalStats, 30000);
      document.addEventListener('keydown', onGlobalKeydown);
    });
    onUnmounted(() => {
      clearInterval(clockTimer);
      clearInterval(statsTimer);
      document.removeEventListener('keydown', onGlobalKeydown);
    });

    // ---- 用户菜单交互 ----
    const showUserMenu = ref(false);
    function toggleUserMenu() { showUserMenu.value = !showUserMenu.value; }
    document.addEventListener('click', e => {
      if (!e.target.closest('.user-menu-wrap')) showUserMenu.value = false;
    });

    async function logout() {
      try { await api.post('/api/auth/logout'); } catch (e) {}
      clearAuth();
      showToast('已退出登录', 'info');
      window.location.hash = '#/login';
    }

    async function openChangePassword() {
      showUserMenu.value = false;
      const res = await showPrompt('修改密码', [
        { label: '原密码', type: 'password', placeholder: '请输入当前密码', value: '' },
        { label: '新密码（至少 6 位）', type: 'password', placeholder: '6 位以上', value: '' },
        { label: '确认新密码', type: 'password', placeholder: '再次输入', value: '' },
      ]);
      if (!res) return;
      const [oldPw, newPw, confirm] = res;
      if (!oldPw || !newPw) { showToast('密码不能为空', 'warning'); return; }
      if (newPw !== confirm) { showToast('两次新密码输入不一致', 'error'); return; }
      if (newPw.length < 6) { showToast('新密码至少 6 位', 'warning'); return; }
      const r = await api.post('/api/auth/change_password', { old_password: oldPw, new_password: newPw });
      if (r && r.ok === '1') {
        showToast('密码已修改，请重新登录', 'success');
        setTimeout(logout, 800);
      }
    }

    // 暴露给模板
    return {
      pageTitle, isAnon, clock, globalStats, ui,
      currentUser, authToken, roleLabel, canManageW2R,
      showUserMenu, toggleUserMenu, logout, openChangePassword,
      closeToast, resolveModal,
    };
  },
};

const app = createApp(App);
app.use(router);
app.mount('#app');
