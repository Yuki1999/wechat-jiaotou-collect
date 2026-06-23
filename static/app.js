// ============================================================
// 党政办信息跟踪与智能整理系统 — Vue 3 SPA v2
// 全局：Toast / Modal / Drawer / Loading / 时钟 / 快捷键
// ============================================================
const { createApp, defineComponent, ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } = Vue;
const { createRouter, createWebHashHistory, useRoute } = VueRouter;

// ========== 全局 UI 状态 ==========
const ui = reactive({
  progress: { active: false, done: false },
  toasts: [],
  modal: {
    show: false, title: '', message: '',
    inputs: null, large: false, showFoot: false,
    okText: '确定', cancelText: '取消', resolve: null,
  },
  drawer: { show: false, title: '', content: '' },
});

// ========== 当前身份（用于按组过滤）==========
// 从 localStorage 读 + 默认综合组王审核。
// viewAll=true 时显示全部，否则按用户的 group 过滤。
function loadCurrentUser() {
  try {
    const raw = localStorage.getItem('dzb_user');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { id: 0, name: '王审核', group: '综合组', role: 'reviewer' };
}
const currentUser = reactive(loadCurrentUser());
const viewAll = ref(localStorage.getItem('dzb_view_all') === '1');
function saveCurrentUser() {
  localStorage.setItem('dzb_user', JSON.stringify({
    id: currentUser.id, name: currentUser.name, group: currentUser.group, role: currentUser.role,
  }));
  localStorage.setItem('dzb_view_all', viewAll.value ? '1' : '0');
}
function setUser(u) {
  Object.assign(currentUser, u);
  saveCurrentUser();
  showToast(`已切换身份：${u.name} · ${u.group}`, 'info');
}
function toggleViewAll() {
  viewAll.value = !viewAll.value;
  saveCurrentUser();
}
// 把 currentUser.group 作为 ?group= 拼到 URL（除非选了"全部"或用户没 group）
function withGroup(url) {
  if (viewAll.value || !currentUser.group) return url;
  const sep = url.includes('?') ? '&' : '?';
  // 接口 URL 本身已经带 group 参数则不重复添加
  if (url.includes('group=')) return url;
  return url + sep + 'group=' + encodeURIComponent(currentUser.group);
}

// 不需要按组过滤的接口（详情/外部代理/系统状态）
const NO_GROUP_PATTERNS = [
  '/api/article?',           // 单条文章详情
  '/api/users',              // 用户列表
  '/api/w2r/',               // wechat2rss 代理（与组无关）
  '/api/sources/test',       // 测试采集
  '/api/article/update',     // 更新单条
  '/api/article/approve',    // 审核动作
  '/api/article/reject',
  '/api/sources/create',
  '/api/sources/delete',
  '/api/sources/toggle',
  '/api/sources/bulk_import',
  '/api/briefs/publish',
  '/api/briefs/export',
  '/api/collect',            // 触发采集
  '/api/ai',                 // 触发 AI
  '/api/demo/full',          // 一键演示
];
function shouldAddGroup(url) {
  for (const p of NO_GROUP_PATTERNS) {
    if (url.startsWith(p) || url.indexOf(p) >= 0) return false;
  }
  return true;
}
function maybeWithGroup(url) {
  return shouldAddGroup(url) ? withGroup(url) : url;
}
let _toastId = 0;
let _loadingStack = 0;

function startLoading() {
  _loadingStack++;
  ui.progress.active = true;
  ui.progress.done = false;
}
function stopLoading() {
  if (_loadingStack > 0) _loadingStack--;
  if (_loadingStack === 0) {
    ui.progress.done = true;
    setTimeout(() => {
      if (_loadingStack === 0) {
        ui.progress.active = false;
        ui.progress.done = false;
      }
    }, 400);
  }
}

const api = {
  async get(url) {
    startLoading();
    try {
      const r = await fetch(url);
      return await r.json();
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
      return null;
    } finally { stopLoading(); }
  },
  async post(url, body) {
    startLoading();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return await r.json();
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
      return null;
    } finally { stopLoading(); }
  },
};

function showToast(message, type) {
  type = type || 'info';
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const id = ++_toastId;
  ui.toasts.push({ id, message, type, icon: icons[type] || icons.info, leaving: false });
  setTimeout(() => {
    const t = ui.toasts.find(x => x.id === id);
    if (t) t.leaving = true;
    setTimeout(() => {
      const idx = ui.toasts.findIndex(x => x.id === id);
      if (idx >= 0) ui.toasts.splice(idx, 1);
    }, 300);
  }, 3000);
}
function closeToast(id) {
  const idx = ui.toasts.findIndex(x => x.id === id);
  if (idx >= 0) ui.toasts.splice(idx, 1);
}

function showModal(title, message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    ui.modal.show = true;
    ui.modal.title = title;
    ui.modal.message = message || '';
    ui.modal.inputs = opts.inputs || null;
    ui.modal.large = !!opts.large;
    ui.modal.showFoot = opts.showFoot !== false;
    ui.modal.okText = opts.okText || '确定';
    ui.modal.cancelText = opts.cancelText || '取消';
    ui.modal.resolve = resolve;
  });
}
function resolveModal(value) {
  const r = ui.modal.resolve;
  const inputs = ui.modal.inputs;
  ui.modal.show = false;
  ui.modal.resolve = null;
  if (r) {
    if (value && inputs) r(inputs.map(it => it.value));
    else r(value);
  }
  setTimeout(() => { ui.modal.inputs = null; }, 250);
}
async function showConfirm(title, message) {
  return showModal(title, message, { showFoot: true });
}
async function showPrompt(title, inputs) {
  return showModal(title, '', { inputs, showFoot: true });
}

function showDrawer(title, content) {
  ui.drawer.show = true;
  ui.drawer.title = title;
  ui.drawer.content = content;
}

// ========== 工具函数 ==========
function fmtTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function durSec(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (isNaN(ms) || ms < 0) return '-';
  return (ms / 1000).toFixed(1) + 's';
}
function fmtRelative(s) {
  if (!s) return '';
  const t = new Date(s).getTime();
  if (isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff/60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff/3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.floor(diff/86400) + ' 天前';
  if (diff < 86400 * 365) return Math.floor(diff/(86400*30)) + ' 个月前';
  return Math.floor(diff/(86400*365)) + ' 年前';
}
function statusLabel(s) {
  return ({
    collected: '已采集', ai_done: 'AI已处理', pending_review: '待审核',
    approved: '已通过', published: '已发布', archived: '已归档',
    failed: '失败', duplicate: '重复',
  })[s] || s;
}
function statusTag(s) {
  if (s === 'pending_review') return 'imp-中';
  if (s === 'approved') return 'ok';
  if (s === 'published') return 'info';
  if (s === 'failed' || s === 'archived') return 'fail';
  return 'muted';
}
function channelLabel(c) {
  return ({ app: '应用消息', group: '群机器人', workbench: '工作台', file: '文件/链接' })[c] || c;
}

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    if (ui.modal.show) resolveModal(false);
    if (ui.drawer.show) ui.drawer.show = false;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    window.location.hash = '#/knowledge';
  }
}

// ============================================================
// 1. 工作台 Dashboard
// ============================================================
const Dashboard = defineComponent({
  setup() {
    const stats = reactive({ stat: {}, success_rate: 0, task_total: 0 });
    const tasks = ref([]);
    const pending = ref([]);
    const briefs = ref([]);
    const log = ref('');
    const step = ref(0);
    const todayOk = ref(0);
    const todayTotal = ref(0);
    const ringVal = computed(() =>
      todayTotal.value > 0 ? Math.round(todayOk.value * 100 / todayTotal.value) : 0
    );

    function appendLog(msg) { log.value += msg + '\n'; }

    async function loadAll() {
      const [s, t, p, b] = await Promise.all([
        api.get('/api/stats'),
        api.get('/api/tasks'),
        api.get('/api/articles?status=pending_review'),
        api.get('/api/briefs'),
      ]);
      if (s) Object.assign(stats, s);
      tasks.value = (t || []).slice(0, 8);
      pending.value = (p || []).slice(0, 6);
      briefs.value = (b || []).slice(0, 5);

      const now = new Date();
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const today = (t || []).filter(x => x.started_at >= cutoff);
      todayTotal.value = today.length;
      todayOk.value = today.filter(x => x.status === 'success').length;
    }

    async function oneClickFlow() {
      if (step.value > 0) return;
      log.value = '';
      step.value = 1;
      appendLog('▶ 开始完整闭环演示…\n');
      try {
        // 调用后端 /api/demo/full 一次跑完真实流程；前端保持第 1 步动画，等待后端返回
        const promise = api.post('/api/demo/full');
        appendLog('⏳ 第 1 步：全量采集（真实抓取外部站点，约需 30–60 秒）…');
        const result = await promise;
        log.value = '';
        appendLog('▶ 开始完整闭环演示…\n');
        for (const s of (result?.steps || [])) {
          appendLog(`${s.ok ? '✅' : '⚠️ '} 第 ${s.step} 步 · ${s.name}：${s.summary}`);
        }
        step.value = 0;
        showToast('演示流程已完成！闭环全部成功', 'success');
      } catch (e) {
        appendLog(`❌ 出错：${e}`);
        step.value = 0;
        showToast('演示流程出错：' + e, 'error');
      }
      await loadAll();
    }

    async function quickApprove(id) {
      await api.post('/api/article/approve?id=' + id);
      showToast('已审核通过', 'success');
      await loadAll();
    }
    async function quickReject(id) {
      const ok = await showConfirm('退回', '确认退回此条内容？');
      if (!ok) return;
      await api.post('/api/article/reject?id=' + id + '&note=退回');
      showToast('已退回', 'warning');
      await loadAll();
    }

    onMounted(loadAll);

    return {
      stats, tasks, pending, briefs, log, step,
      ringVal, todayOk, todayTotal,
      fmtTime, statusLabel,
      oneClickFlow, quickApprove, quickReject,
    };
  },
  template: `
  <div class="fade-in">
    <!-- 业务流程图 — 给客户讲解的主线 -->
    <div class="card tinted">
      <div class="card-head" style="border:none;padding-bottom:0;margin-bottom:6px;">
        <h3>业务流程</h3>
        <span class="hint">信息源 → 自动采集 → AI 整理 → 人工审核 → 简报生成 → 企微推送</span>
      </div>
      <div class="bizflow">
        <router-link to="/sources" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">📡</div>
            <div class="bizflow-name">信息源</div>
            <div class="bizflow-count">{{ stats.stat.sources_active || 0 }}<small>/{{ stats.stat.sources_total || 0 }}</small></div>
          </div>
        </router-link>
        <router-link to="/tasks" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">📥</div>
            <div class="bizflow-name">自动采集</div>
            <div class="bizflow-count">{{ stats.stat.articles_total || 0 }}<small>篇</small></div>
          </div>
        </router-link>
        <router-link to="/review" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">🤖</div>
            <div class="bizflow-name">AI 整理</div>
            <div class="bizflow-count">{{ stats.stat.high_imp || 0 }}<small>条要闻</small></div>
          </div>
        </router-link>
        <router-link to="/review" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">📝</div>
            <div class="bizflow-name">人工审核</div>
            <div class="bizflow-count">{{ stats.stat.pending || 0 }}<small>待审</small></div>
          </div>
        </router-link>
        <router-link to="/briefs" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">📰</div>
            <div class="bizflow-name">简报生成</div>
            <div class="bizflow-count">{{ stats.stat.briefs || 0 }}<small>份</small></div>
          </div>
        </router-link>
        <router-link to="/wecom" class="bizflow-node" custom v-slot="{ navigate }">
          <div class="bizflow-node" @click="navigate">
            <div class="bizflow-icon">💬</div>
            <div class="bizflow-name">企微推送</div>
            <div class="bizflow-count">{{ stats.stat.pushes || 0 }}<small>次</small></div>
          </div>
        </router-link>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card stat">
        <div class="stat-icon">📡</div>
        <div class="stat-label">信息源（启用 / 总数）</div>
        <div class="stat-value">{{ stats.stat.sources_active || 0 }} / {{ stats.stat.sources_total || 0 }}</div>
        <div class="stat-foot">网站 · 公众号 · RSS</div>
      </div>
      <div class="card stat">
        <div class="stat-icon">📝</div>
        <div class="stat-label">待审核内容</div>
        <div class="stat-value" :class="(stats.stat.pending||0) > 10 ? 'warn' : ''">{{ stats.stat.pending || 0 }}</div>
        <div class="stat-foot">已通过 <b>{{ stats.stat.approved || 0 }}</b> · 已发布 <b>{{ stats.stat.published || 0 }}</b></div>
      </div>
      <div class="card stat">
        <div class="stat-icon">📰</div>
        <div class="stat-label">简报总数</div>
        <div class="stat-value">{{ stats.stat.briefs || 0 }}</div>
        <div class="stat-foot">推送次数 <b>{{ stats.stat.pushes || 0 }}</b></div>
      </div>
      <div class="card stat">
        <div class="stat-icon" style="background:var(--ok-bg);">🟢</div>
        <div class="stat-label">24h 采集成功率</div>
        <div class="stat-value" :class="ringVal >= 90 ? 'ok' : (ringVal >= 60 ? 'warn' : 'danger')">{{ ringVal }}%</div>
        <div class="stat-foot">成功 <b>{{ todayOk }}</b> / 总数 <b>{{ todayTotal }}</b></div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <h3>今日采集概览</h3>
          <router-link to="/tasks" class="more">全部任务 ›</router-link>
        </div>
        <div class="ring-card">
          <div class="ring" :style="'--val:' + ringVal">
            <div class="ring-val" v-if="todayTotal">{{ ringVal }}<small>%</small></div>
            <div class="ring-val" v-else style="color:var(--text-muted);font-size:13px;">暂无</div>
          </div>
          <div class="ring-info">
            <div class="ring-label">今日采集任务</div>
            <div class="ring-detail">
              成功 <b class="text-ok">{{ todayOk }}</b> 次<br>
              失败 <b class="text-danger">{{ todayTotal - todayOk }}</b> 次<br>
              总计 <b>{{ todayTotal }}</b> 次
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>一键完整闭环演示</h3>
          <span class="hint">采集 → AI → 审核 → 简报 → 推送</span>
        </div>
        <div class="steps">
          <div class="step" :class="{ done: step > 1, active: step === 1, running: step === 1 }">
            <div class="step-num"><span class="step-num-text">1</span></div>
            <div class="step-text">采集</div>
          </div>
          <div class="step" :class="{ done: step > 2, active: step === 2, running: step === 2 }">
            <div class="step-num"><span class="step-num-text">2</span></div>
            <div class="step-text">AI 整理</div>
          </div>
          <div class="step" :class="{ done: step > 3, active: step === 3, running: step === 3 }">
            <div class="step-num"><span class="step-num-text">3</span></div>
            <div class="step-text">人工审核</div>
          </div>
          <div class="step" :class="{ done: step > 4, active: step === 4, running: step === 4 }">
            <div class="step-num"><span class="step-num-text">4</span></div>
            <div class="step-text">生成简报</div>
          </div>
          <div class="step" :class="{ done: step > 5, active: step === 5, running: step === 5 }">
            <div class="step-num"><span class="step-num-text">5</span></div>
            <div class="step-text">企微推送</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" @click="oneClickFlow" :disabled="step > 0">
            {{ step > 0 ? '⏳ 运行中…' : '▶ 开始演示' }}
          </button>
          <button class="btn ghost" @click="step=0;log=''" :disabled="step !== 0 || !log">🔄 重置</button>
        </div>
        <pre class="log" v-if="log">{{ log }}</pre>
        <div v-else class="hint" style="text-align:center;padding:12px 0;">点击「开始演示」自动运行完整工作流</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <h3>待审核内容</h3>
          <router-link to="/review" class="more">前往审核 ›</router-link>
        </div>
        <ul class="list">
          <li v-for="a in pending" :key="a.id">
            <div class="l-row">
              <div style="flex:1;min-width:0;">
                <div class="l-title">
                  <span class="tag" :class="'imp-'+a.importance" style="margin-right:6px;">{{ a.importance }}</span>
                  {{ a.title }}
                </div>
                <div class="l-meta">{{ a.unit || a.source_type }} · {{ fmtTime(a.publish_time) }}</div>
              </div>
              <div class="l-actions">
                <button class="btn sm ok" @click.stop="quickApprove(a.id)" title="通过">✓</button>
                <button class="btn sm warn" @click.stop="quickReject(a.id)" title="退回">✕</button>
              </div>
            </div>
          </li>
          <li v-if="!pending.length" style="border:none;text-align:center;padding:24px 0;color:var(--text-muted);">
            <div class="empty-icon" style="font-size:32px;">📋</div>
            暂无待审核内容
          </li>
        </ul>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>近期简报</h3>
          <router-link to="/briefs" class="more">简报管理 ›</router-link>
        </div>
        <ul class="list">
          <li v-for="b in briefs" :key="b.id">
            <div class="l-row">
              <div style="flex:1;min-width:0;">
                <div class="l-title">{{ b.type === 'daily' ? '📅' : (b.type === 'weekly' ? '📊' : '📆') }} {{ b.title }}</div>
                <div class="l-meta">
                  {{ b.period }} ·
                  {{ b.items?.length || b.article_ids?.length || 0 }} 条 ·
                  <span class="tag" :class="b.status === 'published' ? 'ok' : 'muted'">{{ b.status === 'published' ? '已发布' : '草稿' }}</span>
                </div>
              </div>
            </div>
          </li>
          <li v-if="!briefs.length" style="border:none;text-align:center;padding:24px 0;color:var(--text-muted);">
            <div class="empty-icon" style="font-size:32px;">📰</div>
            暂无简报
          </li>
        </ul>
      </div>
    </div>
  </div>`
});

// ============================================================
// 2. 信息源管理 Sources
// ============================================================
const Sources = defineComponent({
  setup() {
    const list = ref([]);
    const search = ref('');
    const filterType = ref('');
    const showAdd = ref(false);
    const form = reactive({
      unit: '', type: 'website', kind: 'html_list', category: '部门类',
      url: '', owner_name: '王干事', group: '综合组', frequency: 'daily',
    });

    const filtered = computed(() => {
      let arr = list.value;
      if (filterType.value) arr = arr.filter(s => s.type === filterType.value);
      if (search.value) {
        const q = search.value.toLowerCase();
        arr = arr.filter(s => s.unit.toLowerCase().includes(q) || (s.url || '').toLowerCase().includes(q));
      }
      return arr;
    });

    async function load() { list.value = (await api.get('/api/sources')) || []; }

    // 已订阅但未接入信息源的公众号（用于「类型=公众号」时的下拉选项）
    const w2rAvailable = ref([]);   // [{id, name, link}, ...]
    const w2rLoading = ref(false);
    async function loadW2RFeeds() {
      w2rLoading.value = true;
      try {
        const r = await api.get('/api/w2r/feeds');
        if (!r || !r.data) { w2rAvailable.value = []; return; }
        // 把已接入的 URL 集合算出来，过滤掉已接入的
        const existingUrls = new Set(list.value.map(s => s.url));
        const rewrite = u => (u || '').replace(/\/\/[^/:]+(:\d+)?/, '//127.0.0.1$1');
        w2rAvailable.value = r.data
          .map(f => ({ id: String(f.id), name: f.name, link: rewrite(f.link), paused: f.paused }))
          .filter(f => !existingUrls.has(f.link));
      } finally { w2rLoading.value = false; }
    }
    // 监听类型切换：选「公众号」时立刻拉一次可选列表
    watch(() => form.type, t => {
      if (t === 'wechat2rss') {
        loadW2RFeeds();
        // 切到公众号时清空 url，避免误带网站的 url
        form.url = '';
        form.kind = 'rss';
        form.category = '企业类';
      } else if (t === 'website') {
        form.kind = 'html_list';
      } else {
        form.kind = 'rss';
      }
    });

    // 用户从下拉选中一个公众号时，把它的 name / url 自动填入表单
    function pickW2RFeed(feedId) {
      const f = w2rAvailable.value.find(x => x.id === feedId);
      if (!f) return;
      form.unit = f.name + ' [公众号]';
      form.url = f.link;
    }

    async function addSource() {
      if (!form.unit || !form.url) {
        showToast('请填写单位名称与入口地址', 'warning');
        return;
      }
      if (form.type === 'wechat2rss' || form.type === 'rss') form.kind = 'rss';
      else form.kind = 'html_list';
      await api.post('/api/sources/create', { ...form });
      showToast('信息源已添加', 'success');
      Object.assign(form, {
        unit: '', type: 'website', kind: 'html_list', category: '部门类',
        url: '', owner_name: '王干事', group: '综合组', frequency: 'daily',
      });
      showAdd.value = false;
      await load();
    }

    async function toggle(id) {
      await api.post('/api/sources/toggle?id=' + id);
      await load();
    }
    async function collectOne(id) {
      const res = await api.post('/api/collect?id=' + id);
      const r = (res || [])[0];
      if (!r) return;
      if (r.status === 'success') showToast(`采集成功：发现 ${r.found}，新增 ${r.new_items}`, 'success');
      else showToast(`采集失败：${r.error}`, 'error');
      await load();
    }
    async function collectAll() {
      const res = await api.post('/api/collect');
      if (!res) return;
      const ok = res.filter(r => r.status === 'success').length;
      const fail = res.filter(r => r.status !== 'success').length;
      const newTotal = res.reduce((s, r) => s + (r.new_items || 0), 0);
      showToast(`全量采集完成：${ok} 成功 / 新增 ${newTotal} 条` + (fail ? `，${fail} 失败` : ''), fail ? 'warning' : 'success');
      await load();
    }

    function openHelp() {
      showDrawer('📡 接入微信公众号的方法', `
        <h4>推荐 wechat2rss 私有部署</h4>
        <p>本系统采集器支持 <b>HTML 列表页</b> 与 <b>RSS / Atom</b> 两种类型。微信公众号原文不能直接抓取，但可借助 <b>wechat2rss</b>（付费授权，走微信读书官方接口，风控风险低）把任意公众号转为标准 RSS。</p>
        <ol>
          <li>参考 <code>deploy/wechat2rss/README.md</code> 部署 wechat2rss 私有实例（Docker，约 5 分钟）</li>
          <li>登录 wechat2rss Web 控制台，扫码添加你想订阅的公众号，获得 feed 链接，例如 <code>http://192.168.0.130:8090/feed/abc123.xml</code></li>
          <li>在本系统点 <b>+ 新增信息源</b>，类型选 <b>wechat2rss</b>，URL 粘贴该 feed 地址，保存即可</li>
          <li>每次采集会自动拉取 feed → 解析每篇文章 → 走 AI 流水线 → 进入待审核</li>
        </ol>
        <h4>批量同步</h4>
        <p>也可直接运行脚本一键导入：</p>
        <p><code>cd deploy/wechat2rss && ./import-to-dzb.sh</code></p>
        <div class="evidence" style="margin-top:16px;">同样的 RSS 适配器兼容任意标准 RSS 2.0 / Atom 源（媒体、博客、政府公开数据接口等）。</div>
      `);
    }

    async function delSource(s) {
      const ok = await showConfirm('删除信息源', `确认删除「${s.unit}」？已采集的历史文章会保留。`);
      if (!ok) return;
      const r = await fetch('/api/sources/delete?id=' + s.id, { method: 'POST' });
      if (r.ok) { showToast('已删除', 'success'); await load(); }
      else showToast('删除失败', 'error');
    }

    // 测试采集：粘 URL 后立即试抓，不入库
    const testing = ref(false);
    const testResult = ref(null);
    async function testCollect() {
      if (!form.url) { showToast('请先填写入口地址', 'warning'); return; }
      testing.value = true;
      testResult.value = null;
      try {
        const r = await api.post('/api/sources/test', { url: form.url, type: form.type });
        testResult.value = r;
        if (r && r.ok) {
          showToast(`测试通过：发现 ${r.found} 条，引擎 ${r.engine}`, 'success');
        } else if (r) {
          showToast('测试失败：' + (r.error || '未知'), 'error');
        }
      } finally { testing.value = false; }
    }

    onMounted(load);

    return {
      list, search, filterType, filtered, showAdd, form,
      addSource, toggle, collectOne, collectAll, openHelp, delSource,
      testing, testResult, testCollect,
      w2rAvailable, w2rLoading, pickW2RFeed,
      fmtTime,
    };
  },
  template: `
  <div class="fade-in">
    <div class="card">
      <div class="card-head">
        <h3>信息源管理</h3>
        <div class="row-actions">
          <button class="btn ghost sm" @click="openHelp">📖 帮助</button>
          <button class="btn primary" @click="showAdd=!showAdd; if(showAdd) loadW2RFeeds();">+ 新增信息源</button>
          <button class="btn" @click="collectAll">▶ 全量采集</button>
        </div>
      </div>

      <div class="toolbar">
        <div class="search-input">
          <input v-model="search" placeholder="搜索信息源名称或 URL…">
        </div>
        <select v-model="filterType">
          <option value="">全部类型</option>
          <option value="website">🌐 网站</option>
          <option value="wechat2rss">📡 wechat2rss</option>
          <option value="rss">📰 RSS</option>
        </select>
        <span class="hint">共 {{ filtered.length }} / {{ list.length }} 个信息源</span>
      </div>

      <transition name="page">
        <div v-if="showAdd" class="card flat" style="background:var(--bg-soft);border:1px dashed var(--line-dark);margin-bottom:14px;">
          <div class="field-row">
            <div class="field" style="flex:2;"><label>单位 / 账号名称<span class="req">*</span></label><input v-model="form.unit" placeholder="如：苏州工业园区发布"></div>
            <div class="field"><label>类型</label>
              <select v-model="form.type">
                <option value="website">🌐 网站（HTML）</option>
                <option value="wechat2rss">📡 微信公众号</option>
                <option value="rss">📰 通用 RSS / Atom</option>
              </select>
              <div class="hint" v-if="form.type==='wechat2rss'" style="margin-top:4px;font-size:11px;line-height:1.5;">
                公众号订阅由 <router-link to="/wechat2rss" style="color:var(--primary);">「公众号订阅」</router-link> 页面管理；这里只是把已订阅的公众号接入采集流水线。
              </div>
            </div>
            <div class="field"><label>分类</label>
              <select v-model="form.category"><option>部门类</option><option>企业类</option><option>专题类</option></select>
            </div>
          </div>
          <div class="field-row mt-8">
            <div class="field" style="flex:3;">
              <!-- 公众号模式：从已订阅列表里选 -->
              <template v-if="form.type==='wechat2rss'">
                <label>公众号<span class="req">*</span>
                  <span class="hint" style="margin-left:8px;">从「公众号订阅」页面已订阅的公众号里选</span>
                </label>
                <div class="row" style="gap:8px;">
                  <select :value="''"
                          @change="e=>{ pickW2RFeed(e.target.value); e.target.value=''; }"
                          style="flex:1;padding:7px 12px;border:1px solid var(--line-dark);border-radius:var(--radius-sm);background:#fff;">
                    <option value="" disabled selected>
                      {{ w2rLoading ? '加载中…' : (w2rAvailable.length ? '— 选择一个公众号 —' : '没有可接入的公众号（请先去订阅）') }}
                    </option>
                    <option v-for="f in w2rAvailable" :key="f.id" :value="f.id">
                      {{ f.name }}{{ f.paused ? ' (已暂停)' : '' }}
                    </option>
                  </select>
                  <button class="btn ghost sm" @click="loadW2RFeeds" :disabled="w2rLoading" title="重新拉取已订阅公众号">🔄</button>
                </div>
                <div v-if="form.url" class="hint" style="margin-top:6px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">
                  已选：<b style="color:var(--text);">{{ form.unit }}</b> &nbsp;&nbsp; URL: {{ form.url }}
                </div>
                <div v-if="!w2rAvailable.length && !w2rLoading" class="add-feed-warn" style="margin-top:8px;">
                  <span>当前没有「未接入的已订阅公众号」。请到 <router-link to="/wechat2rss" style="color:var(--primary);">公众号订阅</router-link> 页面订阅，再回到这里接入。</span>
                </div>
              </template>
              <!-- 网站 / RSS 模式：粘 URL -->
              <template v-else>
                <label>入口地址<span class="req">*</span></label>
                <div class="row" style="gap:8px;">
                  <input v-model="form.url" placeholder="https://… 或 RSS feed URL" style="flex:1;">
                  <button class="btn ghost" @click="testCollect" :disabled="testing" :title="'试抓这个 URL 看看能不能解析，使用' + (form.type==='rss' ? 'RSS' : 'crawl4ai 通用') + '引擎'">
                    {{ testing ? '⏳ 测试中…' : '🔬 测试采集' }}
                  </button>
                </div>
              </template>
            </div>
            <div class="field"><label>责任人</label><input v-model="form.owner_name"></div>
            <div class="field"><label>组</label>
              <select v-model="form.group"><option>综合组</option><option>招商组</option><option>专题组</option></select>
            </div>
            <div class="field"><label>频率</label>
              <select v-model="form.frequency"><option value="daily">每日</option><option value="4h">每4小时</option><option value="weekly">每周</option></select>
            </div>
          </div>

          <!-- 测试采集结果 -->
          <div v-if="testResult" class="card flat" style="margin-top:12px;padding:12px 14px;background:var(--bg-soft);">
            <div v-if="testResult.ok" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span class="text-ok">✅</span>
              <b>测试通过</b>
              <span class="tag gold">{{ testResult.engine }}</span>
              <span class="hint">发现 {{ testResult.found }} 条</span>
            </div>
            <div v-if="testResult.warning" class="evidence" style="margin-bottom:8px;color:var(--warn);">⚠️ {{ testResult.warning }}</div>
            <div v-if="!testResult.ok" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span class="text-danger">❌</span>
              <b>测试失败</b>
              <span class="hint">{{ testResult.error }}</span>
            </div>
            <div v-if="testResult.preview && testResult.preview.length" style="margin-top:6px;">
              <div class="hint" style="margin-bottom:4px;">列表页预览（{{ testResult.preview.filter(p=>p.title && p.title.length>6).length }} 条真实新闻 / 共 {{ testResult.preview.length }} 条，正式采集时会过滤导航链接）：</div>
              <div v-for="(p,i) in testResult.preview" :key="i"
                   :style="{padding:'4px 0',fontSize:'12.5px',borderBottom:'1px dashed var(--line)',opacity:(p.title&&p.title.length>6)?1:0.4}">
                <b>{{ p.title }}</b>
                <span v-if="p.publish_time" class="text-muted" style="margin-left:8px;">{{ p.publish_time }}</span>
                <span v-if="!p.title || p.title.length<=6" class="hint" style="margin-left:6px;">（短文本/导航，将被过滤）</span>
              </div>
            </div>
            <div v-if="testResult.detail && testResult.detail.ok" style="margin-top:10px;padding:8px 10px;background:#fff;border-radius:var(--radius-sm);border-left:2px solid var(--ok);">
              <div class="hint">第 1 条详情页试抓：</div>
              <b style="font-size:13px;">{{ testResult.detail.title }}</b>
              <div class="text-muted" style="font-size:11.5px;margin-top:2px;">正文 {{ testResult.detail.content_len }} 字 · 发布 {{ testResult.detail.publish_time || '未知' }}</div>
              <div style="font-size:12px;margin-top:4px;color:var(--gray-700);">{{ testResult.detail.excerpt }}</div>
            </div>
          </div>

          <div class="actions mt-14">
            <button class="btn primary" @click="addSource">💾 保存</button>
            <button class="btn ghost" @click="showAdd=false;testResult=null">取消</button>
          </div>
        </div>
      </transition>

      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>单位</th><th>类别</th><th>采集器</th><th>入口</th>
            <th>责任人/组</th><th>频率</th><th>最近成功</th><th>失败</th>
            <th>状态</th><th style="width:110px;">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="s in filtered" :key="s.id">
              <td><b>{{ s.unit }}</b></td>
              <td><span class="tag line">{{ s.category }}</span></td>
              <td>
                <span class="tag" :class="s.kind==='rss'?'info':'muted'">
                  {{ s.kind==='rss' ? (s.type==='wechat2rss' ? '📡 wechat2rss' : '📰 RSS') : '🌐 HTML' }}
                </span>
              </td>
              <td class="cell-truncate"><a :href="s.url" target="_blank">{{ s.url }}</a></td>
              <td>{{ s.owner_name }} / {{ s.group }}</td>
              <td>{{ s.frequency }}</td>
              <td class="cell-mono">{{ fmtTime(s.last_success) }}</td>
              <td>
                <span class="tag" :class="s.fail_count>3?'fail':(s.fail_count>0?'imp-中':'muted')">{{ s.fail_count || 0 }}</span>
              </td>
              <td>
                <label class="switch">
                  <input type="checkbox" :checked="s.active" @change="toggle(s.id)">
                  <span class="slider"></span>
                </label>
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn sm" @click="collectOne(s.id)">采集</button>
                  <button class="btn sm warn" @click="delSource(s)" title="删除信息源">🗑</button>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="10" class="empty-table">
                <div class="empty-icon">📭</div>
                <div v-if="search">没有匹配 "<b>{{ search }}</b>" 的信息源</div>
                <div v-else>暂无信息源，<a href="javascript:;" @click="showAdd=true">添加第一个</a></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`
});

// ============================================================
// 3. 采集任务 Tasks
// ============================================================
const Tasks = defineComponent({
  setup() {
    const list = ref([]);
    const refreshSec = ref(0);   // 0 = 关闭，否则秒数
    let timer = null;

    async function load() { list.value = (await api.get('/api/tasks')) || []; }
    async function collectAll() {
      await api.post('/api/collect');
      showToast('全量采集已触发', 'info');
      await load();
    }

    function applyRefresh() {
      if (timer) { clearInterval(timer); timer = null; }
      if (refreshSec.value > 0) {
        timer = setInterval(load, refreshSec.value * 1000);
      }
    }
    watch(refreshSec, () => {
      applyRefresh();
      if (refreshSec.value > 0) {
        const label = refreshSec.value >= 60 ? (refreshSec.value/60) + ' 分钟' : refreshSec.value + ' 秒';
        showToast(`已开启自动刷新，每 ${label} 一次`, 'info');
      }
    });
    onMounted(load);
    onUnmounted(() => clearInterval(timer));

    return { list, refreshSec, load, collectAll, fmtTime, durSec };
  },
  template: `
  <div class="fade-in">
    <div class="card">
      <div class="card-head">
        <h3>采集任务历史</h3>
        <div class="row-actions">
          <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);">
            自动刷新
            <select v-model.number="refreshSec" style="padding:5px 8px;border:1px solid var(--line-dark);border-radius:6px;font-size:12px;background:#fff;">
              <option :value="0">关闭</option>
              <option :value="30">30 秒</option>
              <option :value="60">1 分钟</option>
              <option :value="300">5 分钟</option>
              <option :value="1800">30 分钟</option>
            </select>
          </label>
          <button class="btn ghost sm" @click="load">🔄 刷新</button>
          <button class="btn primary" @click="collectAll">▶ 全量采集</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:10px;">
        💡 后端已启用<b>定时自动采集</b>：每分钟扫一次，按各信息源的 <code>frequency</code>（daily / 4h / weekly）到期重跑。
        这里的"自动刷新"只是控制本页前端从后端拉最新结果的频率。
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>信息源</th><th>开始时间</th><th>完成时间</th><th>耗时</th>
            <th>发现</th><th>新增</th><th>状态</th><th>错误</th>
          </tr></thead>
          <tbody>
            <tr v-for="t in list" :key="t.id" :class="{ 'row-danger': t.status === 'fail' }">
              <td>{{ t.unit }}</td>
              <td class="cell-mono">{{ fmtTime(t.started_at) }}</td>
              <td class="cell-mono">{{ fmtTime(t.finished_at) }}</td>
              <td class="cell-mono">{{ durSec(t.started_at, t.finished_at) }}</td>
              <td>{{ t.found || 0 }}</td>
              <td><b>{{ t.new_items || 0 }}</b></td>
              <td>
                <span v-if="t.status === 'success'" class="text-ok">✅ 成功</span>
                <span v-else-if="t.status === 'fail'" class="text-danger">❌ 失败</span>
                <span v-else>⏳ {{ t.status }}</span>
              </td>
              <td class="cell-truncate" style="max-width:300px;color:var(--danger);font-size:12px;">{{ t.error || '-' }}</td>
            </tr>
            <tr v-if="!list.length">
              <td colspan="8" class="empty-table">
                <div class="empty-icon">⏱️</div>
                <div>暂无采集任务，前往 <router-link to="/sources">信息源管理</router-link> 触发采集</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`
});

// ============================================================
// 4. 审核工作台 Review
// ============================================================
const Review = defineComponent({
  setup() {
    const filter = ref('pending_review');
    const unitFilter = ref('');       // 按来源单位过滤
    const kw = ref('');                // 标题关键词过滤
    const sortMode = ref('importance'); // importance / newest / oldest
    const list = ref([]);
    const logs = ref([]);
    const sel = ref(0);
    const detail = ref(null);
    const note = ref('');

    // 当前 list 中出现过的所有 unit（去重）
    const units = computed(() => {
      const s = new Set();
      list.value.forEach(a => { if (a.unit) s.add(a.unit); });
      return [...s].sort();
    });
    // 在 status 已由后端过滤的基础上，再做 unit + 关键词的前端过滤
    const filtered = computed(() => {
      let arr = list.value.slice();
      if (unitFilter.value) arr = arr.filter(a => a.unit === unitFilter.value);
      if (kw.value) {
        const q = kw.value.toLowerCase();
        arr = arr.filter(a =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.summary || '').toLowerCase().includes(q)
        );
      }
      // 排序
      const ts = a => {
        const t = a.publish_time || a.fetch_time;
        return t ? new Date(t).getTime() : 0;
      };
      const impRank = a => ({ '高': 3, '中': 2, '低': 1 }[a.importance] || 0);
      if (sortMode.value === 'newest') {
        arr.sort((a, b) => ts(b) - ts(a));
      } else if (sortMode.value === 'oldest') {
        arr.sort((a, b) => ts(a) - ts(b));
      } else {
        // importance: 重要性优先，同重要性按时间倒序
        arr.sort((a, b) => {
          const r = impRank(b) - impRank(a);
          if (r !== 0) return r;
          return ts(b) - ts(a);
        });
      }
      return arr;
    });

    async function load() {
      list.value = (await api.get('/api/articles?status=' + filter.value)) || [];
      // 选中项不在过滤结果中时，自动切到过滤结果第一条
      if (!filtered.value.find(a => a.id === sel.value)) {
        if (filtered.value.length) {
          await pick(filtered.value[0].id);
        } else {
          sel.value = 0; detail.value = null;
        }
      }
    }
    // 单位 / 关键词变化时也要同步当前选中项
    watch([unitFilter, kw, sortMode], () => {
      if (!filtered.value.find(a => a.id === sel.value)) {
        if (filtered.value.length) pick(filtered.value[0].id);
        else { sel.value = 0; detail.value = null; }
      }
    });
    async function pick(id) {
      sel.value = id;
      const d = await api.get('/api/article?id=' + id);
      if (d) {
        detail.value = d.article;
        logs.value = d.logs || [];
      }
      note.value = '';
    }
    async function save() {
      if (!detail.value) return;
      await api.post('/api/article/update', {
        id: detail.value.id,
        summary: detail.value.summary,
        leader_summary: detail.value.leader_summary,
        detail_summary: detail.value.detail_summary,
        importance: detail.value.importance,
        note: note.value,
      });
      showToast('已保存修改', 'success');
      await pick(detail.value.id);
    }
    async function approve() {
      if (!detail.value) return;
      const ok = await showConfirm('审核通过', '确认将此条内容标记为"已通过"？');
      if (!ok) return;
      await api.post('/api/article/approve?id=' + detail.value.id);
      showToast('审核通过', 'success');
      await load();
    }
    async function reject() {
      if (!detail.value) return;
      const res = await showPrompt('退回', [
        { label: '退回原因', placeholder: '请填写退回原因', value: '', type: 'textarea' },
      ]);
      if (!res) return;
      const reason = (res[0] || '').trim() || '退回';
      await api.post('/api/article/reject?id=' + detail.value.id + '&note=' + encodeURIComponent(reason));
      showToast('已退回', 'warning');
      await load();
    }
    async function reAI() {
      const res = await api.post('/api/ai');
      showToast(`AI 重跑完成：${res?.processed || 0} 条`, 'info');
      await load();
    }
    function clearFilters() {
      unitFilter.value = '';
      kw.value = '';
    }

    function onKeydown(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (ui.modal.show || ui.drawer.show) return;
      const arr = filtered.value;
      if (!arr.length) return;

      const idx = arr.findIndex(a => a.id === sel.value);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = arr[Math.min(idx + 1, arr.length - 1)];
        if (next) pick(next.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = arr[Math.max(idx - 1, 0)];
        if (prev) pick(prev.id);
      } else if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
        if (detail.value && (detail.value.status === 'pending_review' || detail.value.status === 'ai_done')) approve();
      } else if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
        if (detail.value && (detail.value.status === 'pending_review' || detail.value.status === 'ai_done')) reject();
      }
    }

    watch(filter, load);
    onMounted(() => {
      load();
      document.addEventListener('keydown', onKeydown);
    });
    onUnmounted(() => document.removeEventListener('keydown', onKeydown));

    return {
      filter, unitFilter, kw, sortMode, units, filtered,
      list, logs, sel, detail, note,
      pick, save, approve, reject, reAI, clearFilters,
      fmtTime, fmtRelative, statusLabel, statusTag,
    };
  },
  template: `
  <div class="fade-in grid grid-2-1">
    <div class="card">
      <div class="card-head">
        <h3>审核队列</h3>
        <div class="row-actions">
          <select v-model="filter" style="padding:6px 10px;border:1px solid var(--line-dark);border-radius:6px;font-size:13px;background:#fff;">
            <option value="pending_review">待审核</option>
            <option value="approved">已通过</option>
            <option value="published">已发布</option>
            <option value="archived">已归档</option>
            <option value="">全部</option>
          </select>
          <button class="btn ghost sm" @click="reAI" title="对所有 collected 状态的文章重跑 AI 整理">⚙ 重跑 AI</button>
        </div>
      </div>

      <!-- 来源 + 关键词二级过滤 -->
      <div class="toolbar" style="margin-bottom:10px;">
        <div class="search-input">
          <input v-model="kw" placeholder="按标题 / 摘要关键词过滤…">
        </div>
        <select v-model="unitFilter" :title="'按来源单位过滤（'+units.length+' 个来源）'">
          <option value="">全部来源（{{ units.length }}）</option>
          <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
        </select>
        <select v-model="sortMode" title="排序方式">
          <option value="importance">🔥 重要性优先</option>
          <option value="newest">🕓 最新发布</option>
          <option value="oldest">📜 最早发布</option>
        </select>
        <button v-if="unitFilter || kw" class="btn ghost sm" @click="clearFilters" title="清空过滤">✕ 清空</button>
        <span class="hint">{{ filtered.length }} / {{ list.length }} 条</span>
      </div>

      <ul class="review-list">
        <li v-for="a in filtered" :key="a.id"
            :class="{ selected: sel === a.id }"
            @click="pick(a.id)">
          <div class="rl-title">
            <span class="tag" :class="'imp-'+a.importance" style="margin-right:5px;">{{ a.importance }}</span>
            {{ a.title }}
            <span v-if="a.ai_engine && a.ai_engine.startsWith('deepseek')"
                  class="ai-badge" style="margin-left:5px;background:linear-gradient(135deg,#fdf4d6 0%,#fbecaf 100%);color:var(--gold-600);border-color:var(--gold-300);"
                  :title="'引擎：'+a.ai_engine+' · 置信度 '+Math.round((a.confidence||0)*100)+'%'">✨ AI</span>
            <span v-else-if="a.confidence > 0" class="ai-badge" style="margin-left:5px;" :title="'本地规则引擎 · 置信度 '+Math.round(a.confidence*100)+'%'">AI</span>
          </div>
          <div class="rl-meta">
            <span>{{ a.unit || a.source_type }}</span>
            <span :title="fmtTime(a.publish_time)">{{ fmtRelative(a.publish_time) || fmtTime(a.publish_time) }}</span>
            <span class="tag" :class="a.duplicate_of>0?'dup':statusTag(a.status)">
              {{ a.duplicate_of>0 ? '重复' : statusLabel(a.status) }}
            </span>
          </div>
          <div class="rl-summary" v-if="a.summary">{{ a.summary }}</div>
        </li>
        <li v-if="!filtered.length" style="padding:30px;text-align:center;color:var(--text-muted);border:none;background:transparent;">
          <div class="empty-icon" style="font-size:36px;">📋</div>
          <div v-if="unitFilter || kw">没有符合当前筛选条件的条目</div>
          <div v-else>{{ filter === 'pending_review' ? '暂无待审核内容' : '暂无匹配条目' }}</div>
        </li>
      </ul>
    </div>

    <div class="card editor">
      <div v-if="!detail" class="empty">
        <div class="empty-icon" style="font-size:48px;">📝</div>
        <div class="empty-text">← 从左侧选择一条内容查看详情</div>
      </div>
      <div v-else>
        <h4>{{ detail.title }}</h4>
        <div class="meta">
          <span>{{ detail.unit || detail.source_type }}</span>
          <span>{{ fmtTime(detail.publish_time) }}</span>
          <a :href="detail.url" target="_blank">查看原文 →</a>
        </div>
        <div class="tag-row">
          <span class="tag line">{{ detail.category }}</span>
          <span v-for="t in (detail.topics||[])" :key="t" class="tag info">{{ t }}</span>
          <span v-for="k in (detail.keywords||[])" :key="k" class="tag muted">{{ k }}</span>
        </div>

        <details class="raw" style="margin-bottom:10px;">
          <summary>展开原文正文</summary>
          <div>{{ detail.content }}</div>
        </details>

        <div class="ai-block">
          <div class="ai-tag" style="display:flex;align-items:center;gap:8px;">
            <span>🤖 AI 整理结果（可编辑）</span>
            <span v-if="detail.ai_engine && detail.ai_engine.startsWith('deepseek')"
                  class="tag gold" style="font-size:10.5px;">
              ✨ {{ detail.ai_engine === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : detail.ai_engine }}
            </span>
            <span v-else-if="detail.ai_engine === 'rule'"
                  class="tag muted" style="font-size:10.5px;">本地规则引擎</span>
          </div>
          <label>一句话摘要</label>
          <textarea v-model="detail.summary" rows="2"></textarea>
          <label>领导阅览用摘要</label>
          <textarea v-model="detail.leader_summary" rows="2"></textarea>
          <label>详细摘要</label>
          <textarea v-model="detail.detail_summary" rows="3"></textarea>
          <div class="row">
            <div class="field">
              <label>重要性</label>
              <select v-model="detail.importance"><option>高</option><option>中</option><option>低</option></select>
            </div>
            <div class="field" style="flex:2;">
              <label>审核备注</label>
              <input v-model="note" placeholder="修改备注（可选）">
            </div>
          </div>
          <div class="evidence" v-if="detail.evidence">📌 {{ detail.evidence }}</div>
        </div>

        <details class="logs" v-if="logs.length">
          <summary>审核日志 ({{ logs.length }} 条)</summary>
          <ul class="timeline">
            <li v-for="l in logs" :key="l.id">
              <div class="t-time">{{ fmtTime(l.occurred_at) }}</div>
              <div class="t-content">
                <b>{{ l.reviewer }}</b>
                {{ l.action === 'approve' ? '✅ 审核通过' : (l.action === 'reject' ? '❌ 退回' : (l.action === 'edit' ? '✏️ 修改' : l.action)) }}
                <span v-if="l.note" class="text-muted"> — {{ l.note }}</span>
              </div>
            </li>
          </ul>
        </details>

        <div class="editor-footer">
          <span class="hint">
            <span class="key">j</span><span class="key">k</span> 导航
            <span class="key">a</span> 通过
            <span class="key">r</span> 退回
          </span>
          <button class="btn" @click="save">💾 保存</button>
          <button class="btn ok" v-if="detail.status==='pending_review'||detail.status==='ai_done'" @click="approve">✅ 审核通过</button>
          <button class="btn warn" v-if="detail.status==='pending_review'||detail.status==='ai_done'" @click="reject">↩ 退回</button>
        </div>
      </div>
    </div>
  </div>`
});

// ============================================================
// 5. 简报管理 Briefs
// ============================================================
const Briefs = defineComponent({
  setup() {
    const list = ref([]);
    const expanded = reactive(new Set());

    async function load() { list.value = (await api.get('/api/briefs')) || []; }

    async function gen(type) {
      const map = { daily: '日报', weekly: '周报', monthly: '月报' };
      const ok = await showConfirm('生成简报', `确认生成${map[type]}？将自动汇总近期已审核条目。`);
      if (!ok) return;
      const b = await api.post('/api/briefs/generate?type=' + type);
      if (!b) return;
      if (b.article_ids && b.article_ids.length) {
        showToast(`已生成：「${b.title}」（${b.article_ids.length} 条）`, 'success');
      } else {
        showToast('暂无符合条件的条目可纳入简报', 'warning');
      }
      await load();
    }

    async function publish(b) {
      const res = await showPrompt('发布简报', [
        {
          label: '推送渠道', type: 'select', value: 'app',
          options: [
            { value: 'app', label: '应用消息' },
            { value: 'group', label: '群机器人' },
            { value: 'workbench', label: '工作台' },
            { value: 'file', label: '文件 / 链接' },
          ],
        },
        { label: '推送对象', value: '张主任', placeholder: '如：张主任 / 综合组' },
      ]);
      if (!res) return;
      const ch = res[0] || 'app';
      const tg = res[1] || '张主任';
      const pl = await api.post('/api/briefs/publish?id=' + b.id + '&channel=' + ch + '&target=' + encodeURIComponent(tg));
      if (!pl) return;
      if (pl.status === 'success') showToast(`已通过「${channelLabel(ch)}」推送给「${tg}」`, 'success');
      else showToast(`推送失败（返回码 ${pl.return_code}）`, 'error');
      await load();
    }

    function toggle(id) {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    }

    onMounted(load);
    return { list, expanded, gen, publish, toggle, fmtTime, channelLabel };
  },
  template: `
  <div class="fade-in">
    <div class="card">
      <div class="card-head"><h3>简报生成</h3><span class="hint">点击下方卡片生成对应类型简报</span></div>
      <div class="brief-gen-cards">
        <div class="brief-gen" @click="gen('daily')">
          <div class="brief-gen-icon daily">📅</div>
          <div>
            <div class="brief-gen-title">日报</div>
            <div class="brief-gen-desc">每日快报 · 近 7 天已审核</div>
          </div>
        </div>
        <div class="brief-gen" @click="gen('weekly')">
          <div class="brief-gen-icon weekly">📊</div>
          <div>
            <div class="brief-gen-title">周报</div>
            <div class="brief-gen-desc">信息周报 · 近 30 天已审核</div>
          </div>
        </div>
        <div class="brief-gen" @click="gen('monthly')">
          <div class="brief-gen-icon monthly">📆</div>
          <div>
            <div class="brief-gen-title">月报</div>
            <div class="brief-gen-desc">月度汇编 · 近 90 天已审核</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>简报列表（{{ list.length }}）</h3></div>
      <div v-if="!list.length" class="empty">
        <div class="empty-icon">📰</div>
        <div class="empty-text">暂无简报，请使用上方卡片生成</div>
      </div>
      <div v-for="b in list" :key="b.id" class="brief-card" :class="'t-'+b.type">
        <div class="brief-head">
          <div style="flex:1;min-width:0;">
            <h4>{{ b.title }}</h4>
            <div class="brief-meta">
              <span>{{ b.period }}</span>
              <span class="tag" :class="b.status==='published'?'ok':'muted'">{{ b.status === 'published' ? '已发布' : '草稿' }}</span>
              <span>{{ b.items?.length || b.article_ids?.length || 0 }} 条</span>
              <span>编辑：{{ b.editor }}</span>
              <span v-if="b.published_at">{{ fmtTime(b.published_at) }}</span>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn sm ghost" @click="toggle(b.id)">{{ expanded.has(b.id) ? '收起' : '展开' }}</button>
            <a class="btn sm" :href="'/api/briefs/export?id='+b.id" download title="导出 Word">📄 Word</a>
            <button class="btn sm primary" v-if="b.status==='draft'" @click="publish(b)">📤 发布</button>
            <button class="btn sm" v-else @click="publish(b)">↺ 再次推送</button>
          </div>
        </div>
        <div v-if="expanded.has(b.id)">
          <ol class="brief-items" v-if="(b.items||[]).length">
            <li v-for="a in (b.items||[])" :key="a.id">
              <span class="tag b-imp" :class="'imp-'+a.importance">{{ a.importance }}</span>
              {{ a.title }}
              <a :href="a.url" target="_blank" class="more">原文 ›</a>
            </li>
          </ol>
          <div v-else class="hint" style="margin-top:10px;">该简报暂无条目</div>
        </div>
      </div>
    </div>
  </div>`
});

// ============================================================
// 6. 知识库检索 Knowledge
// ============================================================
const Knowledge = defineComponent({
  setup() {
    const q = ref('');
    const unit = ref('');
    const topic = ref('');
    const units = ref([]);
    const results = ref([]);
    const searched = ref(false);

    const hotTopics = ['营商环境', '招商引资', '专精特新', '重点项目', '安全生产', '自贸区', '生物医药', '人工智能'];

    async function init() {
      const sources = (await api.get('/api/sources')) || [];
      units.value = [...new Set(sources.map(s => s.unit))].filter(Boolean);
    }
    async function search() {
      const params = new URLSearchParams();
      if (q.value) params.set('q', q.value);
      if (unit.value) params.set('unit', unit.value);
      if (topic.value) params.set('topic', topic.value);
      results.value = (await api.get('/api/search?' + params.toString())) || [];
      searched.value = true;
    }
    function pickHot(t) {
      q.value = t;
      search();
    }
    function highlight(text, term) {
      if (!term || !text) return text;
      try {
        const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
        return text.replace(re, '<em>$1</em>');
      } catch (e) { return text; }
    }

    onMounted(init);
    return { q, unit, topic, units, results, searched, hotTopics, search, pickHot, highlight, fmtTime, fmtRelative };
  },
  template: `
  <div class="fade-in">
    <div class="kb-hero">
      <h2>🔎 知识库检索</h2>
      <div class="kb-search">
        <div class="search-input">
          <input v-model="q" placeholder="输入关键词，搜索所有已采集信息…" @keyup.enter="search">
        </div>
        <select v-model="unit">
          <option value="">全部单位</option>
          <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
        </select>
        <select v-model="topic">
          <option value="">全部专题</option>
          <option>营商环境</option><option>招商引资</option><option>重点企业</option><option>产业创新</option>
          <option>经济运行</option><option>民生关注</option><option>涉外开放</option>
        </select>
        <button class="btn primary" @click="search">🔍 搜索</button>
      </div>
      <div class="kb-hot">
        热门搜索：
        <span v-for="t in hotTopics" :key="t" class="tag" @click="pickHot(t)">{{ t }}</span>
      </div>
    </div>

    <div class="kb-results" v-if="searched">
      <div class="hint" v-if="results.length" style="margin-bottom:4px;">找到 {{ results.length }} 条结果</div>
      <div v-for="r in results" :key="r.article.id" class="kb-item">
        <div class="kb-title">
          <a :href="r.article.url" target="_blank">
            <span class="tag" :class="'imp-'+r.article.importance" style="margin-right:4px;">{{ r.article.importance }}</span>
            <span v-html="highlight(r.article.title, q)"></span>
          </a>
        </div>
        <div class="kb-meta">
          <span>{{ r.article.unit || r.article.source_type }}</span>
          <span :title="fmtTime(r.article.publish_time)">{{ fmtRelative(r.article.publish_time) || fmtTime(r.article.publish_time) }}</span>
          <span v-if="r.score" class="tag info">匹配 {{ r.score }} 次</span>
          <span v-for="t in (r.article.topics||[])" :key="t" class="tag muted">{{ t }}</span>
        </div>
        <div class="kb-snippet" v-if="r.snippet" v-html="highlight(r.snippet, q)"></div>
      </div>
      <div v-if="!results.length" class="empty">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">没有找到匹配的内容</div>
      </div>
    </div>

    <div v-if="!searched" class="empty" style="padding:30px 0;">
      <div class="empty-text">输入关键词按回车，或点击热门标签开始搜索</div>
    </div>
  </div>`
});

// ============================================================
// 7. 企微推送 Wecom
// ============================================================
const Wecom = defineComponent({
  setup() {
    const list = ref([]);
    const filter = ref('');

    const filtered = computed(() => {
      if (!filter.value) return list.value;
      return list.value.filter(p => p.status === filter.value);
    });
    const todayCount = computed(() => {
      const now = new Date();
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      return list.value.filter(p => p.occurred_at >= cutoff).length;
    });
    const todayOk = computed(() => {
      const now = new Date();
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      return list.value.filter(p => p.occurred_at >= cutoff && p.status === 'success').length;
    });

    async function load() { list.value = (await api.get('/api/pushes')) || []; }
    onMounted(load);

    return { list, filter, filtered, todayCount, todayOk, fmtTime, channelLabel };
  },
  template: `
  <div class="fade-in grid grid-2-1">
    <div class="card">
      <div class="card-head">
        <h3>推送日志</h3>
        <select v-model="filter" style="padding:6px 10px;border:1px solid var(--line-dark);border-radius:6px;font-size:13px;">
          <option value="">全部</option>
          <option value="success">成功</option>
          <option value="fail">失败</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>时间</th><th>渠道</th><th>对象</th><th>主题</th><th>结果</th><th>返回码</th>
          </tr></thead>
          <tbody>
            <tr v-for="p in filtered" :key="p.id">
              <td class="cell-mono">{{ fmtTime(p.occurred_at) }}</td>
              <td>{{ channelLabel(p.channel) }}</td>
              <td>{{ p.target }}</td>
              <td class="cell-truncate" style="max-width:200px;">{{ p.subject }}</td>
              <td>
                <span v-if="p.status==='success'" class="text-ok">✅ 成功</span>
                <span v-else class="text-danger">❌ 失败</span>
              </td>
              <td class="cell-mono">{{ p.return_code }}</td>
            </tr>
            <tr v-if="!filtered.length">
              <td colspan="6" class="empty-table">
                <div class="empty-icon">💬</div>
                <div>暂无推送记录</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="col" style="gap:14px;">
      <div class="card stat">
        <div class="stat-icon">📤</div>
        <div class="stat-label">今日推送</div>
        <div class="stat-value">{{ todayCount }}</div>
        <div class="stat-foot">成功 <b class="text-ok">{{ todayOk }}</b> · 失败 <b class="text-danger">{{ todayCount - todayOk }}</b></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>渠道与配置</h3></div>
        <ul class="channel-list">
          <li>
            <div class="channel-icon">📱</div>
            <div class="channel-info">
              <div class="channel-name">应用消息</div>
              <div class="channel-desc">企业微信应用消息推送</div>
            </div>
            <span class="dot ok"></span><span class="hint">已接入</span>
          </li>
          <li>
            <div class="channel-icon">🤖</div>
            <div class="channel-info">
              <div class="channel-name">群机器人</div>
              <div class="channel-desc">企业微信群 Webhook</div>
            </div>
            <span class="dot ok"></span><span class="hint">已接入</span>
          </li>
          <li>
            <div class="channel-icon">📋</div>
            <div class="channel-info">
              <div class="channel-name">工作台</div>
              <div class="channel-desc">企业微信工作台通知</div>
            </div>
            <span class="dot warn"></span><span class="hint">待配置</span>
          </li>
          <li>
            <div class="channel-icon">📁</div>
            <div class="channel-info">
              <div class="channel-name">文件 / 链接</div>
              <div class="channel-desc">文件分享或链接分发</div>
            </div>
            <span class="dot muted"></span><span class="hint">未启用</span>
          </li>
        </ul>
        <div class="hint" style="margin-top:12px;padding:8px 12px;background:var(--bg-soft);border-radius:var(--radius-sm);">
          本 Demo 企微推送为模拟实现，正式接入需企业管理员授权 corpId / agentId / secret。
        </div>
      </div>
    </div>
  </div>`
});

// ============================================================
// 路由 & 根组件
// ============================================================
// ============================================================
// 8. 公众号订阅 Wechat2RSS
// ============================================================
const Wechat2RSS = defineComponent({
  setup() {
    const health = ref({ ready: false, online: false, version: '', base: '' });
    const feeds = ref([]);
    const accounts = ref([]);
    const search = ref('');

    // 新增订阅 Modal
    const showAddFeed = ref(false);
    const addUrl = ref('');
    const addId = ref('');
    const addBusy = ref(false);

    // 扫码 Modal
    const showQrcode = ref(false);
    const qrcode = ref('');
    const qrcodeStatus = ref('loading'); // loading / waiting / success / fail
    let qrPollTimer = null;
    let preAccountIds = new Set();

    // 同步预览 Modal
    const showSync = ref(false);
    const syncItems = ref([]);
    const syncBusy = ref(false);

    const filteredFeeds = computed(() => {
      if (!search.value) return feeds.value;
      const q = search.value.toLowerCase();
      return feeds.value.filter(f => (f.name || '').toLowerCase().includes(q));
    });

    async function loadHealth() {
      const h = await api.get('/api/w2r/health');
      if (h) Object.assign(health.value, h);
    }
    async function loadFeeds() {
      const r = await api.get('/api/w2r/feeds');
      if (r && r.data) feeds.value = r.data;
    }
    async function loadAccounts() {
      const r = await api.get('/api/w2r/accounts');
      if (r && r.data) accounts.value = r.data;
    }
    async function loadAll() {
      await loadHealth();
      if (health.value.ready && health.value.online) {
        await loadFeeds();
        await loadAccounts();
      }
    }

    // ---- 订阅 ----
    async function doAddFeed() {
      if (!addUrl.value && !addId.value) {
        showToast('请填写文章链接或公众号 ID', 'warning'); return;
      }
      addBusy.value = true;
      try {
        let r;
        if (addUrl.value) r = await api.post('/api/w2r/feeds/add_url', { url: addUrl.value });
        else r = await api.post('/api/w2r/feeds/add_id', { id: addId.value });
        if (r && !r.err) {
          showToast('订阅成功', 'success');
          addUrl.value = ''; addId.value = '';
          showAddFeed.value = false;
          await loadFeeds();
        } else {
          showToast('订阅失败：' + ((r && r.err) || '未知错误'), 'error');
        }
      } finally { addBusy.value = false; }
    }
    async function delFeed(f) {
      const ok = await showConfirm('删除订阅', `确认删除「${f.name}」？此操作不可撤销。`);
      if (!ok) return;
      const r = await api.post('/api/w2r/feeds/del', { id: String(f.id) });
      if (r && !r.err) { showToast('已删除', 'success'); await loadFeeds(); }
      else showToast('删除失败：' + ((r && r.err) || ''), 'error');
    }
    async function togglePause(f) {
      const r = await api.post('/api/w2r/feeds/pause', { id: String(f.id), status: !f.paused });
      if (r && !r.err) {
        showToast(f.paused ? '已恢复' : '已暂停', 'info');
        await loadFeeds();
      } else showToast('操作失败：' + ((r && r.err) || ''), 'error');
    }

    // ---- 扫码 ----
    async function openQrcode() {
      showQrcode.value = true;
      qrcode.value = '';
      qrcodeStatus.value = 'loading';
      preAccountIds = new Set(accounts.value.map(a => a.id));
      const r = await api.post('/api/w2r/accounts/login', {});
      if (r && r.data && r.data.qrcode) {
        qrcode.value = r.data.qrcode.startsWith('data:') ? r.data.qrcode : ('data:image/png;base64,' + r.data.qrcode);
        qrcodeStatus.value = 'waiting';
        startQrPoll();
      } else if (r && r.data && r.data.isLogin) {
        // 已登录
        qrcodeStatus.value = 'success';
        await loadAccounts();
        setTimeout(closeQrcode, 800);
      } else {
        qrcodeStatus.value = 'fail';
        showToast('获取二维码失败：' + ((r && r.err) || '后端未返回二维码'), 'error');
      }
    }
    function startQrPoll() {
      stopQrPoll();
      qrPollTimer = setInterval(async () => {
        const r = await api.get('/api/w2r/accounts');
        if (r && r.data) {
          accounts.value = r.data;
          for (const a of r.data) {
            if (!preAccountIds.has(a.id)) {
              qrcodeStatus.value = 'success';
              showToast(`微信账号「${a.name}」添加成功`, 'success');
              stopQrPoll();
              setTimeout(closeQrcode, 800);
              return;
            }
          }
        }
      }, 2500);
    }
    function stopQrPoll() {
      if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
    }
    function closeQrcode() {
      stopQrPoll();
      showQrcode.value = false;
    }
    async function delAccount(a) {
      const ok = await showConfirm('删除微信账号', `确认删除「${a.name || a.id}」？此操作不可撤销，后续将无法用此账号抓取。`);
      if (!ok) return;
      const r = await api.get('/api/w2r/accounts/del?id=' + a.id);
      if (r && !r.err) { showToast('已删除', 'success'); await loadAccounts(); }
      else showToast('删除失败：' + ((r && r.err) || ''), 'error');
    }
    async function refreshAccount(a) {
      const r = await api.get('/api/w2r/accounts/refresh?id=' + a.id);
      if (r && !r.err) { showToast('已刷新状态', 'info'); await loadAccounts(); }
      else showToast('刷新失败：' + ((r && r.err) || ''), 'error');
    }

    // ---- 同步 ----
    async function openSync() {
      const r = await api.post('/api/w2r/feeds/sync?dry=1');
      if (r && r.items) {
        syncItems.value = r.items;
        showSync.value = true;
      } else showToast('同步预览失败：' + ((r && r.err) || ''), 'error');
    }
    async function confirmSync() {
      syncBusy.value = true;
      try {
        const r = await api.post('/api/w2r/feeds/sync', {});
        if (r && (r.created !== undefined)) {
          showToast(`同步完成：新增 ${r.created}，跳过 ${r.skipped}`, 'success');
          showSync.value = false;
        } else showToast('同步失败：' + ((r && r.err) || ''), 'error');
      } finally { syncBusy.value = false; }
    }
    const newCount = computed(() => syncItems.value.filter(x => x.status === 'new').length);

    onMounted(loadAll);
    onUnmounted(stopQrPoll);

    return {
      health, feeds, accounts, search, filteredFeeds,
      showAddFeed, addUrl, addId, addBusy, doAddFeed,
      showQrcode, qrcode, qrcodeStatus, openQrcode, closeQrcode,
      showSync, syncItems, syncBusy, newCount, openSync, confirmSync,
      loadAll, delFeed, togglePause, delAccount, refreshAccount,
      fmtTime,
    };
  },
  template: `
  <div class="fade-in">
    <!-- 未配置兜底 -->
    <div v-if="!health.ready" class="card w2r-setup-card">
      <div class="setup-icon">📡</div>
      <div class="setup-title">公众号订阅模块未启用</div>
      <div class="setup-desc">
        请管理员在党政办系统启动时设置以下环境变量后重启服务
      </div>
      <div class="w2r-setup-env">
<span class="k">W2R_BASE</span>=<span class="v">http://127.0.0.1:8090</span><br>
<span class="k">W2R_TOKEN</span>=<span class="v">&lt;wechat2rss 控制台的 RSS_TOKEN&gt;</span>
      </div>
    </div>

    <!-- 不可达兜底 -->
    <div v-else-if="!health.online" class="card w2r-setup-card">
      <div class="setup-icon">⚠️</div>
      <div class="setup-title">无法访问 wechat2rss 服务</div>
      <div class="setup-desc">
        <span class="cell-mono">{{ health.base }}</span><br>
        请检查容器是否启动：<code>cd deploy/wechat2rss &amp;&amp; ./deploy.sh status</code>
      </div>
      <button class="btn primary" @click="loadAll">🔄 重试</button>
    </div>

    <template v-else>
      <!-- 顶部信息条 -->
      <div class="card tinted" style="padding:0;">
        <div class="w2r-banner">
          <div class="w2r-banner-left">
            <span class="w2r-banner-status">
              <span class="dot ok"></span>
              <b>wechat2rss 运行中</b>
            </span>
            <span class="hint cell-mono">{{ health.base }}</span>
            <span class="tag gold">v{{ health.version }}</span>
          </div>
          <div class="w2r-banner-right">
            <button class="btn ghost sm" @click="loadAll">🔄 刷新</button>
            <router-link to="/sources" class="btn">→ 去信息源管理接入</router-link>
          </div>
        </div>
      </div>

      <!-- 与信息源的关系说明 -->
      <div class="hint" style="margin:-8px 4px 14px;padding:8px 12px;background:var(--bg-soft);border-left:3px solid var(--gold-500);border-radius:var(--radius-sm);font-size:12px;line-height:1.7;">
        📌 <b>这一页是 wechat2rss 服务的管理界面</b>：扫码登录抓取账号、订阅公众号、暂停/删除订阅。
        订阅后的公众号会出现在
        <router-link to="/sources" style="color:var(--primary);font-weight:500;">「信息源管理」</router-link>
        的<b>「+ 新增信息源 → 类型选 微信公众号」</b>下拉里，由那里决定是否接入采集流水线。
      </div>

      <div class="grid grid-2-1">
        <!-- 左：订阅列表 -->
        <div class="card">
          <div class="card-head">
            <h3>公众号订阅</h3>
            <div class="row-actions">
              <button class="btn primary" @click="showAddFeed=true">+ 新增订阅</button>
            </div>
          </div>
          <div class="toolbar">
            <div class="search-input">
              <input v-model="search" placeholder="按公众号名称过滤…">
            </div>
            <span class="hint">{{ filteredFeeds.length }} / {{ feeds.length }} 个公众号</span>
          </div>

          <div v-if="!filteredFeeds.length" class="empty">
            <div class="empty-icon">📭</div>
            <div class="empty-text" v-if="search">没有匹配 "<b>{{ search }}</b>" 的订阅</div>
            <div class="empty-text" v-else>暂无订阅，点击右上角「+ 新增订阅」开始</div>
          </div>

          <div v-for="f in filteredFeeds" :key="f.id" class="w2r-feed-row" :class="{paused: f.paused}">
            <div class="w2r-feed-avatar">{{ (f.name || '?').slice(0,1) }}</div>
            <div class="w2r-feed-info">
              <div class="w2r-feed-name">
                <span>{{ f.name }}</span>
                <span v-if="f.paused" class="tag muted">已暂停</span>
              </div>
              <div class="w2r-feed-meta">
                <span class="cell-mono">ID {{ f.id }}</span>
                <span v-if="f.next_update_time">下次更新 {{ fmtTime(f.next_update_time) }}</span>
                <a :href="f.link" target="_blank" class="more">查看 RSS ›</a>
              </div>
            </div>
            <div class="w2r-feed-actions">
              <button class="btn sm ghost" @click="togglePause(f)" :title="f.paused?'恢复抓取':'暂停抓取'">
                {{ f.paused ? '▶ 恢复' : '⏸ 暂停' }}
              </button>
              <button class="btn sm warn btn-icon" @click="delFeed(f)" title="删除订阅">🗑</button>
            </div>
          </div>
        </div>

        <!-- 右：微信账号 -->
        <div class="card">
          <div class="card-head">
            <h3>微信账号 <span style="color:var(--text-muted);font-weight:400;font-size:13px;">· {{ accounts.length }}</span></h3>
            <button class="btn primary sm" @click="openQrcode">+ 添加</button>
          </div>

          <ul class="w2r-account-list" v-if="accounts.length">
            <li v-for="a in accounts" :key="a.id">
              <div class="acct-icon">👤</div>
              <div class="acct-info">
                <div class="acct-name">{{ a.name || ('账号 ' + a.id) }}</div>
                <div class="acct-meta">
                  <span v-if="a.available"><span class="dot ok"></span>可用</span>
                  <span v-else-if="a.needCheck"><span class="dot warn"></span>需要解风控</span>
                  <span v-else><span class="dot fail"></span>不可用</span>
                  <span v-if="a.waitTime">{{ a.waitTime }}</span>
                </div>
              </div>
              <div class="acct-actions">
                <button class="btn sm ghost btn-icon" @click="refreshAccount(a)" title="标记解风控">↻</button>
                <button class="btn sm warn btn-icon" @click="delAccount(a)" title="删除账号">🗑</button>
              </div>
            </li>
          </ul>

          <div v-else class="w2r-account-empty">
            <div class="empty-icon">📱</div>
            <div>暂无微信账号</div>
            <small>点击右上角"+ 添加"扫码登录</small>
          </div>

          <div class="w2r-account-tip">
            务必使用 <b>专用小号</b>，不要用主号或办公号。<br>
            账号被风控时点 <b>↻</b> 标记解除即可继续抓取。
          </div>
        </div>
      </div>
    </template>

    <!-- 新增订阅 Modal -->
    <div v-if="showAddFeed" class="modal-mask" @click.self="showAddFeed=false">
      <div class="modal">
        <div class="modal-head">
          <h3>+ 新增公众号订阅</h3>
          <button class="modal-close" @click="showAddFeed=false">✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>方式一：粘贴公众号文章链接<span style="color:var(--gray-500);font-weight:400;">（推荐）</span></label>
            <input v-model="addUrl" placeholder="https://mp.weixin.qq.com/s/...">
          </div>

          <div class="add-feed-divider"><span>或</span></div>

          <div class="field">
            <label>方式二：公众号 ID<span style="color:var(--gray-500);font-weight:400;">（已知 ID 时使用）</span></label>
            <input v-model="addId" placeholder="如 3015724600">
          </div>

          <div v-if="!accounts.some(a=>a.available)" class="add-feed-warn">
            <span>当前没有<b>可用</b>的微信抓取账号，建议先到右侧「微信账号」面板添加一个，否则订阅可能无法工作。</span>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="showAddFeed=false">取消</button>
          <button class="btn primary" @click="doAddFeed" :disabled="addBusy">{{ addBusy ? '处理中…' : '订阅' }}</button>
        </div>
      </div>
    </div>

    <!-- 扫码 Modal -->
    <div v-if="showQrcode" class="modal-mask" @click.self="closeQrcode">
      <div class="modal">
        <div class="modal-head">
          <h3>📱 添加微信抓取账号</h3>
          <button class="modal-close" @click="closeQrcode">✕</button>
        </div>
        <div class="modal-body">
          <div class="qrcode-box">
            <div class="qrcode-img">
              <div v-if="qrcodeStatus==='loading'" class="qrcode-placeholder">⏳ 正在获取二维码…</div>
              <img v-else-if="qrcode" :src="qrcode" alt="二维码">
              <div v-else class="qrcode-placeholder fail">❌ 二维码获取失败</div>
            </div>
            <div class="qrcode-status">
              <template v-if="qrcodeStatus==='loading'">
                <span class="dot warn pulse"></span>正在准备…
              </template>
              <template v-else-if="qrcodeStatus==='waiting'">
                <span class="dot warn pulse"></span>请使用微信扫码登录
              </template>
              <template v-else-if="qrcodeStatus==='success'">
                <span class="dot ok"></span>登录成功
              </template>
              <template v-else>
                <span class="dot fail"></span>登录失败
              </template>
            </div>
            <div class="qrcode-tip">
              请使用 <b>专用小号</b> 扫码授权，不要用主号或办公号。<br>
              账号仅用于读取公众号文章，文章来源于微信读书官方接口。
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="closeQrcode">取消</button>
        </div>
      </div>
    </div>

    <!-- 同步预览 Modal -->
    <div v-if="showSync" class="modal-mask" @click.self="showSync=false">
      <div class="modal lg">
        <div class="modal-head">
          <h3>↻ 同步到信息源 — 预览</h3>
          <button class="modal-close" @click="showSync=false">✕</button>
        </div>
        <div class="modal-body">
          <p class="hint" style="margin:0;">
            将从 wechat2rss 同步以下 <b>{{ syncItems.length }}</b> 个公众号到本系统信息源；
            其中 <b class="text-ok">{{ newCount }}</b> 个新增，
            <b>{{ syncItems.length - newCount }}</b> 个已存在将跳过。
          </p>
          <div class="sync-preview" v-if="syncItems.length">
            <div v-for="it in syncItems" :key="it.id" class="item" :class="it.status">
              <span class="badge-st">{{ it.status === 'new' ? 'NEW' : 'SKIP' }}</span>
              <div class="info-line">
                <div class="name">
                  {{ it.name }}
                  <span v-if="it.paused" class="tag muted" style="margin-left:6px;">已暂停</span>
                </div>
                <div class="url">{{ it.link }}</div>
              </div>
            </div>
          </div>
          <div v-else class="empty" style="padding:20px;">wechat2rss 上暂无订阅</div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="showSync=false">取消</button>
          <button class="btn primary" @click="confirmSync" :disabled="syncBusy || newCount===0">
            {{ syncBusy ? '处理中…' : (newCount > 0 ? ('确认导入 ' + newCount + ' 条') : '没有可导入条目') }}
          </button>
        </div>
      </div>
    </div>
  </div>`
});


const routes = [
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

const App = {
  setup() {
    const route = useRoute();
    const pageTitle = computed(() => route.meta?.title || '工作台');
    const clock = ref('');
    const globalStats = reactive({ sources_active: 0, pending: 0, briefs: 0 });

    let clockTimer = null;
    let statsTimer = null;
    function updateClock() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      clock.value = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    async function refreshStats() {
      const s = await api.get('/api/stats');
      if (s && s.stat) Object.assign(globalStats, s.stat);
    }
    // 任意页面变化也立即刷新一次徽章
    watch(() => route.path, refreshStats);
    onMounted(() => {
      updateClock();
      clockTimer = setInterval(updateClock, 1000);
      refreshStats();
      statsTimer = setInterval(refreshStats, 30000);
      document.addEventListener('keydown', onGlobalKeydown);
    });
    onUnmounted(() => {
      clearInterval(clockTimer);
      clearInterval(statsTimer);
      document.removeEventListener('keydown', onGlobalKeydown);
    });

    return { pageTitle, clock, globalStats, ui, closeToast, resolveModal };
  },
};

const app = createApp(App);
app.use(router);
app.mount('#app');
