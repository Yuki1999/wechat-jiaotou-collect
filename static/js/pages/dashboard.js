// ============================================================
// 1. 工作台 Dashboard
// ============================================================
import {
  defineComponent, ref, computed, onMounted,
  api, showToast, showConfirm, fmtTime, statusLabel,
  statsData, refreshStats,
} from '../shared.js';

export default defineComponent({
  setup() {
    const stats = statsData; // 复用根组件共享的 /api/stats 数据，避免重复请求
    const tasks = ref([]);
    const pending = ref([]);
    const briefs = ref([]);
    const loaded = ref(false);
    const log = ref('');
    const step = ref(0);
    const todayOk = ref(0);
    const todayTotal = ref(0);
    const ringVal = computed(() =>
      todayTotal.value > 0 ? Math.round(todayOk.value * 100 / todayTotal.value) : 0
    );

    function appendLog(msg) { log.value += msg + '\n'; }

    async function loadAll() {
      const [, t, p, b] = await Promise.all([
        refreshStats(),
        api.get('/api/tasks'),
        api.get('/api/articles?status=pending_review'),
        api.get('/api/briefs'),
      ]);
      tasks.value = (t || []).slice(0, 8);
      pending.value = (p || []).slice(0, 6);
      briefs.value = (b || []).slice(0, 5);
      loaded.value = true;

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
      stats, tasks, pending, briefs, loaded, log, step,
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
              <div class="flex-1">
                <div class="l-title">
                  <span class="tag" :class="'imp-'+a.importance" style="margin-right:6px;">{{ a.importance }}</span>
                  {{ a.title }}
                </div>
                <div class="l-meta">{{ a.unit || a.source_type }} · {{ fmtTime(a.publish_time) }}</div>
              </div>
              <div class="l-actions">
                <button class="btn sm ok" @click.stop="quickApprove(a.id)" title="通过" aria-label="通过">✓</button>
                <button class="btn sm warn" @click.stop="quickReject(a.id)" title="退回" aria-label="退回">✕</button>
              </div>
            </div>
          </li>
          <li v-if="!loaded" class="loading-row">⏳ 加载中…</li>
          <li v-else-if="!pending.length" style="border:none;text-align:center;padding:24px 0;color:var(--text-muted);">
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
              <div class="flex-1">
                <div class="l-title">{{ b.type === 'daily' ? '📅' : (b.type === 'weekly' ? '📊' : '📆') }} {{ b.title }}</div>
                <div class="l-meta">
                  {{ b.period }} ·
                  {{ b.items?.length || b.article_ids?.length || 0 }} 条 ·
                  <span class="tag" :class="b.status === 'published' ? 'ok' : 'muted'">{{ statusLabel(b.status) }}</span>
                </div>
              </div>
            </div>
          </li>
          <li v-if="!loaded" class="loading-row">⏳ 加载中…</li>
          <li v-else-if="!briefs.length" style="border:none;text-align:center;padding:24px 0;color:var(--text-muted);">
            <div class="empty-icon" style="font-size:32px;">📰</div>
            暂无简报
          </li>
        </ul>
      </div>
    </div>
  </div>`
});
