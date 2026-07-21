// ============================================================
// 共享层：全局 UI 状态 / api 封装 / 权限 / 工具函数
// 依赖全局构建的 Vue（window.Vue，由普通 script 标签先加载）
// ============================================================
const { defineComponent, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;
export { defineComponent, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick };

// ========== 全局 UI 状态 ==========
export const ui = reactive({
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
// 登录后 token 和用户信息存 localStorage
function loadAuthToken() { return localStorage.getItem('dzb_token') || ''; }
function loadCurrentUser() {
  try {
    const raw = localStorage.getItem('dzb_user');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}
export function saveAuth(token, user) {
  if (token) localStorage.setItem('dzb_token', token);
  if (user) localStorage.setItem('dzb_user', JSON.stringify(user));
}
export function clearAuth() {
  localStorage.removeItem('dzb_token');
  localStorage.removeItem('dzb_user');
  authToken.value = '';
  Object.keys(currentUser).forEach(k => delete currentUser[k]);
}

export const authToken = ref(loadAuthToken());
export const currentUser = reactive(loadCurrentUser() || {});

// 角色 → 中文 + 颜色
const ROLE_LABEL = {
  admin: '管理员', leader: '主任', editor: '干事', reviewer: '审核员',
};
export function roleLabel(r) { return ROLE_LABEL[r] || r || '用户'; }
export function hasRole(roles) {
  if (!currentUser.role) return false;
  return roles.includes(currentUser.role);
}
export function canManageW2R() { return hasRole(['admin', 'editor']); }

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

export const api = {
  async _fetch(url, opts) {
    startLoading();
    try {
      // 自动带 Bearer token
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers || {});
      if (authToken.value) {
        opts.headers['Authorization'] = 'Bearer ' + authToken.value;
      }
      const r = await fetch(url, opts);
      // 401 自动跳登录
      if (r.status === 401) {
        clearAuth();
        if (window.location.hash !== '#/login') {
          showToast('会话已过期，请重新登录', 'warning');
          window.location.hash = '#/login';
        }
        return null;
      }
      if (r.status === 403) {
        let msg = '当前角色无权执行此操作';
        try { const j = await r.clone().json(); if (j.err) msg = j.err; } catch (e) {}
        showToast(msg, 'error');
        return null;
      }
      return await r.json();
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
      return null;
    } finally { stopLoading(); }
  },
  get(url) { return this._fetch(url); },
  post(url, body) {
    return this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  },
};

export function showToast(message, type) {
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
export function closeToast(id) {
  const idx = ui.toasts.findIndex(x => x.id === id);
  if (idx >= 0) ui.toasts.splice(idx, 1);
}

export function showModal(title, message, opts) {
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
export function resolveModal(value) {
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
export async function showConfirm(title, message) {
  return showModal(title, message, { showFoot: true });
}
export async function showPrompt(title, inputs) {
  return showModal(title, '', { inputs, showFoot: true });
}

export function showDrawer(title, content) {
  ui.drawer.show = true;
  ui.drawer.title = title;
  ui.drawer.content = content;
}

// ========== 全局统计（根组件顶栏与工作台共享，避免重复请求 /api/stats）==========
export const statsData = reactive({ stat: {}, success_rate: 0, task_total: 0 });
export async function refreshStats() {
  const s = await api.get('/api/stats');
  if (s) Object.assign(statsData, s);
}

// ========== 工具函数 ==========
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
export function fmtTime(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function durSec(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (isNaN(ms) || ms < 0) return '-';
  return (ms / 1000).toFixed(1) + 's';
}
export function fmtRelative(s) {
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
export function statusLabel(s) {
  return ({
    collected: '已采集', ai_done: 'AI已处理', pending_review: '待审核',
    approved: '已通过', published: '已发布', archived: '已归档',
    failed: '失败', duplicate: '重复', draft: '草稿',
  })[s] || s;
}
export function statusTag(s) {
  if (s === 'pending_review') return 'imp-中';
  if (s === 'approved') return 'ok';
  if (s === 'published') return 'info';
  if (s === 'failed' || s === 'archived') return 'fail';
  return 'muted';
}
export function channelLabel(c) {
  return ({ app: '应用消息', group: '群机器人', workbench: '工作台', file: '文件/链接' })[c] || c;
}

export function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    if (ui.modal.show) resolveModal(false);
    if (ui.drawer.show) ui.drawer.show = false;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    window.location.hash = '#/knowledge';
  }
}
