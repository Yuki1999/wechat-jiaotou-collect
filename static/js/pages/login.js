// ============================================================
// 0. 登录页 Login
// ============================================================
import {
  defineComponent, ref, computed, onMounted, onUnmounted, nextTick,
  authToken, currentUser, saveAuth, showToast,
} from '../shared.js';

export default defineComponent({
  setup() {
    const username = ref('');
    const password = ref('');
    const busy = ref(false);
    const errMsg = ref('');
    const showPwd = ref(false);
    const remember = ref(localStorage.getItem('dzb_remember') === '1');
    const capsLock = ref(false);
    const shake = ref(false);

    const today = ref(new Date());
    const todayTimer = setInterval(() => { today.value = new Date(); }, 1000 * 30);
    onUnmounted(() => clearInterval(todayTimer));

    const greeting = computed(() => {
      const h = today.value.getHours();
      if (h < 6) return '夜深了';
      if (h < 9) return '早上好';
      if (h < 12) return '上午好';
      if (h < 14) return '中午好';
      if (h < 18) return '下午好';
      if (h < 22) return '晚上好';
      return '夜深了';
    });

    const dateStr = computed(() => {
      const d = today.value;
      const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${week}`;
    });

    onMounted(() => {
      if (remember.value) {
        username.value = localStorage.getItem('dzb_remember_user') || '';
        nextTick(() => {
          if (username.value) {
            const pwdEl = document.querySelector('input[name="password"]');
            if (pwdEl) pwdEl.focus();
          } else {
            const userEl = document.querySelector('input[name="username"]');
            if (userEl) userEl.focus();
          }
        });
      } else {
        nextTick(() => {
          const userEl = document.querySelector('input[name="username"]');
          if (userEl) userEl.focus();
        });
      }
    });

    function checkCaps(e) {
      capsLock.value = !!(e.getModifierState && e.getModifierState('CapsLock'));
    }

    function triggerShake() {
      shake.value = true;
      setTimeout(() => { shake.value = false; }, 500);
    }

    async function doLogin() {
      errMsg.value = '';
      const u = username.value.trim();
      const p = password.value;
      if (!u || !p) {
        errMsg.value = '请输入用户名和密码';
        triggerShake();
        return;
      }
      busy.value = true;
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        const data = await r.json();
        if (!r.ok || !data.token) {
          errMsg.value = data.err || '登录失败，请稍后重试';
          triggerShake();
          return;
        }
        saveAuth(data.token, data.user);
        authToken.value = data.token;
        Object.assign(currentUser, data.user);

        if (remember.value) {
          localStorage.setItem('dzb_remember', '1');
          localStorage.setItem('dzb_remember_user', u);
        } else {
          localStorage.removeItem('dzb_remember');
          localStorage.removeItem('dzb_remember_user');
        }

        showToast(`欢迎回来，${data.user.name}`, 'success');
        window.location.hash = '#/';
      } catch (e) {
        errMsg.value = '网络异常，请检查服务连接';
        triggerShake();
      } finally { busy.value = false; }
    }

    return {
      username, password, busy, errMsg, showPwd, remember, capsLock, shake,
      greeting, dateStr, checkCaps, doLogin,
    };
  },
  template: `
  <div class="login-shell">
    <!-- 左侧品牌信息区 -->
    <aside class="login-brand">
      <div class="login-brand-deco">
        <div class="deco-circle deco-c1"></div>
        <div class="deco-circle deco-c2"></div>
        <div class="deco-circle deco-c3"></div>
        <div class="deco-grid"></div>
      </div>
      <div class="login-brand-content">
        <div class="login-brand-top">
          <div class="login-brand-logo">党</div>
          <div class="login-brand-name">
            <div class="login-brand-zh">党政办信息系统</div>
            <div class="login-brand-en">Government Office Information Hub</div>
          </div>
        </div>
        <div class="login-brand-headline">
          <div class="login-brand-greet">{{ greeting }}，欢迎使用</div>
          <h2>跟踪 · 整理 · 协同<br>让党政信息流转更高效</h2>
          <p>AI 自动整理 + 人工审核闭环，让信息收集与简报生成从 4 小时压缩到 15 分钟。</p>
        </div>
        <div class="login-brand-features">
          <div class="brand-feat"><span class="feat-icon">📡</span><div><b>多源采集</b><span>网站 · 公众号 · RSS 三类全覆盖</span></div></div>
          <div class="brand-feat"><span class="feat-icon">🤖</span><div><b>AI 整理</b><span>大模型摘要 + 重要性分级</span></div></div>
          <div class="brand-feat"><span class="feat-icon">📋</span><div><b>分组协同</b><span>按组隔离 · 全程留痕</span></div></div>
        </div>
        <div class="login-brand-foot">
          <span>{{ dateStr }}</span>
        </div>
      </div>
    </aside>

    <!-- 右侧登录卡片 -->
    <main class="login-main">
      <div class="login-main-inner">
      <form class="login-form-card" :class="{ shake }" @submit.prevent="doLogin" autocomplete="on">
        <div class="login-form-head">
          <h1>账号登录</h1>
          <p>请输入您的工作账号信息</p>
        </div>

        <div class="login-input" :class="{ 'has-value': username }">
          <label>用户名</label>
          <div class="login-input-row">
            <span class="login-input-icon">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </span>
            <input v-model="username" name="username" autocomplete="username"
                   placeholder="请输入用户名" @keyup.enter="doLogin"
                   @keydown="checkCaps" @keyup="checkCaps">
          </div>
        </div>

        <div class="login-input" :class="{ 'has-value': password }">
          <label>密码</label>
          <div class="login-input-row">
            <span class="login-input-icon">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>
            <input v-model="password" :type="showPwd ? 'text' : 'password'"
                   name="password" autocomplete="current-password"
                   placeholder="请输入密码" @keyup.enter="doLogin"
                   @keydown="checkCaps" @keyup="checkCaps">
            <button type="button" class="login-input-eye" @click="showPwd = !showPwd"
                    :title="showPwd ? '隐藏密码' : '显示密码'"
                    :aria-label="showPwd ? '隐藏密码' : '显示密码'">
              <svg v-if="!showPwd" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
          <transition name="page">
            <div v-if="capsLock" class="login-caps-tip">⚠ 当前已开启大写锁定 (Caps Lock)</div>
          </transition>
        </div>

        <div class="login-options">
          <label class="login-check">
            <input type="checkbox" v-model="remember">
            <span class="check-box"></span>
            <span>记住账号</span>
          </label>
          <span class="login-help-link" title="如忘记密码请联系运维管理员重置">忘记密码？</span>
        </div>

        <transition name="page">
          <div v-if="errMsg" class="login-err-banner">
            <span class="err-dot"></span>
            <span>{{ errMsg }}</span>
          </div>
        </transition>

        <button type="submit" class="login-submit-btn" :disabled="busy">
          <span v-if="!busy">登 录</span>
          <span v-else class="login-loading"><span class="login-spin-dot"></span> 正在验证…</span>
        </button>

        <div class="login-safety">
          <span class="safety-item" title="所有请求强制 HTTPS 加密传输">🛡 加密传输</span>
          <span class="safety-divider"></span>
          <span class="safety-item" title="操作日志全程留痕，可供审计">🔒 留痕审计</span>
          <span class="safety-divider"></span>
          <span class="safety-item" title="会话 12 小时自动过期">⏱ 会话保护</span>
        </div>
      </form>

      <div class="login-info-card">
        <div class="info-icon">📢</div>
        <div class="info-body">
          <b>系统已升级至 v2.1 版本</b>
          <small>新增分组隔离、操作留痕；如需开通账号或重置密码，请联系运维管理员。</small>
        </div>
        <div class="info-status">服务正常</div>
      </div>

      <div class="login-page-foot">
        © 党政办信息跟踪与智能整理系统 · v2.1 · 受访问审计与权限管控保护
      </div>
      </div>
    </main>
  </div>`
});
