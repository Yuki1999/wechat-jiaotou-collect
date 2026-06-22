// 党政办信息跟踪与智能整理系统 — Vue 3 SPA
const { createApp, defineComponent, ref, reactive, computed, onMounted, watch } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

// ========== 工具函数 ==========
const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  },
};
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
function statusLabel(s) {
  return ({
    collected: '已采集', ai_done: 'AI已处理', pending_review: '待审核',
    approved: '已通过', published: '已发布', archived: '已归档', failed: '失败', duplicate: '重复'
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

// ========== 工作台 / Dashboard ==========
const Dashboard = defineComponent({
  setup() {
    const stats = reactive({ stat: {}, success_rate: 0, task_total: 0 });
    const tasks = ref([]);
    const pending = ref([]);
    const briefs = ref([]);
    const log = ref('');

    async function loadAll() {
      stats.value = Object.assign(stats, await api.get('/api/stats'));
      tasks.value = (await api.get('/api/tasks')).slice(0, 8);
      pending.value = (await api.get('/api/articles?status=pending_review')).slice(0, 5);
      briefs.value = (await api.get('/api/briefs')).slice(0, 5);
    }
    function appendLog(s) { log.value += s + '\n'; }
    async function oneClickCollect() {
      appendLog('[1/3] 触发全量采集…');
      const res = await api.post('/api/collect');
      const ok = res.filter(t => t.status === 'success').length;
      const news = res.reduce((s, t) => s + (t.new_items || 0), 0);
      appendLog(`    完成：${ok}/${res.length} 任务成功，新增 ${news} 条；进入 AI 流水线`);
      await loadAll();
    }
    async function oneClickAI() {
      appendLog('[2/3] 重跑 AI 整理（去重 → 分类 → 摘要 → 重要性）…');
      const r = await api.post('/api/ai');
      appendLog(`    AI 处理 ${r.processed} 条`);
      await loadAll();
    }
    async function oneClickBrief() {
      appendLog('[3/3] 基于已审核内容生成今日快报…');
      const b = await api.post('/api/briefs/generate?type=daily');
      appendLog(`    生成草稿《${b.title}》，含 ${(b.article_ids||[]).length} 条`);
      await loadAll();
    }

    onMounted(loadAll);
    return { stats, tasks, pending, briefs, log, fmtTime, statusLabel, statusTag,
             oneClickCollect, oneClickAI, oneClickBrief };
  },
  template: `
  <div>
    <div class="card" style="border-left:4px solid #b32424;background:#fff8f8;">
      <b>📡 真实数据接入：</b>本系统已接入 <a href="https://www.sipac.gov.cn/" target="_blank" style="color:#b32424;">苏州工业园区管委会官网</a> 4 个真实栏目（园区要闻 / 即时动态 / 媒体聚焦 / 园区公告），点击下方"触发一次全量采集"即可拉取真实新闻。微信公众号请先部署 <a href="https://github.com/cooderl/wewe-rss" target="_blank" style="color:#b32424;">WeWe RSS</a>，再到「信息源管理」中添加 RSS 源。
    </div>
    <div class="grid grid-4">
      <div class="card stat">
        <div class="stat-label">信息源（启用 / 总数）</div>
        <div class="stat-value">{{ stats.stat.sources_active || 0 }} / {{ stats.stat.sources_total || 0 }}</div>
        <div class="stat-foot">网站 · 公众号 · 链接导入</div>
      </div>
      <div class="card stat">
        <div class="stat-label">待审核内容</div>
        <div class="stat-value warn">{{ stats.stat.pending || 0 }}</div>
        <div class="stat-foot">高重要性：<b>{{ stats.stat.high_imp || 0 }}</b> 条</div>
      </div>
      <div class="card stat">
        <div class="stat-label">已发布 / 已审核</div>
        <div class="stat-value ok">{{ stats.stat.published || 0 }} / {{ stats.stat.approved || 0 }}</div>
        <div class="stat-foot">简报数：<b>{{ stats.stat.briefs || 0 }}</b></div>
      </div>
      <div class="card stat">
        <div class="stat-label">近24h 采集成功率</div>
        <div class="stat-value">{{ stats.success_rate || 0 }}%</div>
        <div class="stat-foot">任务数：<b>{{ stats.task_total || 0 }}</b></div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <h3>一键演示流程</h3>
          <span class="hint">采集 → AI 整理 → 审核 → 简报 → 企微推送</span>
        </div>
        <ol class="flow">
          <li>① 触发采集（信息源 → 任务调度 → 抓取/解析）</li>
          <li>② 自动 AI 整理（去重 → 分类 → 摘要 → 重要性）</li>
          <li>③ 进入待审核（人工编辑 → 通过 / 退回）</li>
          <li>④ 生成简报（日报 / 周报 / 月报）</li>
          <li>⑤ 企微推送（应用消息 / 群机器人）</li>
        </ol>
        <div class="actions">
          <button class="btn primary" @click="oneClickCollect">▶ 触发一次全量采集</button>
          <button class="btn" @click="oneClickAI">⚙ 重跑 AI 整理</button>
          <button class="btn" @click="oneClickBrief">📰 生成今日快报</button>
        </div>
        <pre class="log" v-if="log">{{ log }}</pre>
      </div>

      <div class="card">
        <div class="card-head"><h3>最近采集任务</h3><router-link class="more" to="/tasks">全部 ›</router-link></div>
        <table class="table">
          <thead><tr><th>时间</th><th>信息源</th><th>状态</th><th>新增/发现</th></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td>{{ fmtTime(t.started_at) }}</td>
              <td>{{ t.unit }}</td>
              <td><span class="tag" :class="t.status==='success'?'ok':'fail'">{{ t.status==='success'?'成功':'失败' }}</span></td>
              <td>{{ t.new_items }} / {{ t.found }}</td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="4" class="hint">暂无</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>待审核内容（前5条）</h3><router-link class="more" to="/review">前往审核 ›</router-link></div>
        <ul class="list">
          <li v-for="a in pending" :key="a.id">
            <div class="l-title">
              <span class="tag" :class="'imp-'+a.importance">{{ a.importance }}</span>
              {{ a.title }}
            </div>
            <div class="l-meta">{{ a.unit }} · {{ fmtTime(a.publish_time) }} · {{ a.summary }}</div>
          </li>
          <li v-if="!pending.length" class="hint">暂无待审核内容</li>
        </ul>
      </div>
      <div class="card">
        <div class="card-head"><h3>近期简报</h3><router-link class="more" to="/briefs">简报管理 ›</router-link></div>
        <ul class="list">
          <li v-for="b in briefs" :key="b.id">
            <div class="l-title">
              <span class="tag" :class="b.status==='published'?'ok':'muted'">{{ b.status==='published'?'已发布':'草稿' }}</span>
              {{ b.title }}
            </div>
            <div class="l-meta">{{ b.period }} · 含 {{ (b.article_ids||[]).length }} 条 · {{ fmtTime(b.created_at) }}</div>
          </li>
          <li v-if="!briefs.length" class="hint">暂无简报</li>
        </ul>
      </div>
    </div>
  </div>
  `,
});

// ========== 信息源 ==========
const Sources = defineComponent({
  setup() {
    const list = ref([]);
    const showAdd = ref(false);
    const showHelp = ref(false);
    const form = reactive({
      unit: '', type: 'website', kind: 'html_list', category: '部门类', url: '',
      owner_name: '王干事', group: '综合组', frequency: 'daily',
    });
    async function load() { list.value = await api.get('/api/sources'); }
    async function addSource() {
      if (!form.unit || !form.url) { alert('请填写单位与入口地址'); return; }
      // 类型 / kind 联动：选择 wewe-rss / rss 时强制 kind=rss
      if (form.type === 'wewe-rss' || form.type === 'rss') form.kind = 'rss';
      else form.kind = 'html_list';
      await api.post('/api/sources/create', form);
      Object.assign(form, { unit: '', url: '' });
      showAdd.value = false;
      await load();
    }
    async function toggle(id) { await api.post('/api/sources/toggle?id=' + id); await load(); }
    async function collectOne(id) {
      const res = await api.post('/api/collect?id=' + id);
      const r = res[0];
      alert(`采集完成：${r.status === 'success' ? '成功' : '失败'}\n发现 ${r.found || 0}，新增 ${r.new_items || 0}\n${r.error ? '错误：' + r.error : ''}`);
      await load();
    }
    async function collectAll() {
      const res = await api.post('/api/collect');
      const ok = res.filter(t => t.status === 'success').length;
      const news = res.reduce((s, t) => s + (t.new_items || 0), 0);
      const fails = res.filter(t => t.status === 'fail').map(t => `· ${t.unit}: ${t.error}`).join('\n');
      alert(`全量采集完成：${ok}/${res.length} 任务成功，新增 ${news} 条${fails ? '\n失败：\n' + fails : ''}`);
      await load();
    }
    onMounted(load);
    return { list, form, showAdd, showHelp, addSource, toggle, collectOne, collectAll, fmtTime };
  },
  template: `
  <div class="card">
    <div class="card-head">
      <h3>信息源目录 <span class="hint">真实抓取（苏州工业园区管委会官网 + RSS 适配器）</span></h3>
      <div class="row-actions">
        <button class="btn" @click="showHelp=!showHelp">📖 怎么接公众号？</button>
        <button class="btn primary" @click="showAdd=!showAdd">+ 新增信息源</button>
        <button class="btn" @click="collectAll">▶ 全量采集</button>
      </div>
    </div>

    <div class="ai-block" v-if="showHelp" style="margin-bottom:14px;">
      <div class="ai-tag">📡 接入微信公众号的方法（推荐 WeWe RSS）</div>
      <p style="margin:8px 0;">本系统采集器支持 <b>HTML 列表页</b> 与 <b>RSS / Atom</b> 两种类型。微信公众号原文不能直接抓取，但可借助 <b>WeWe RSS</b> 把任意公众号转为标准 RSS。</p>
      <ol style="margin:8px 0 8px 20px; line-height:1.9;">
        <li>用 Docker 部署 WeWe RSS：<code>docker run -d -p 4000:4000 -v ./data:/app/data ghcr.io/cooderl/wewe-rss-sqlite:latest</code></li>
        <li>登录 WeWe RSS Web 控制台，扫码添加你想订阅的公众号（如"苏州工业园区发布"），获得它的 feed 链接，例如：<code>http://127.0.0.1:4000/feeds/MP_WXS_xxx.rss</code></li>
        <li>在本系统点 <b>+ 新增信息源</b>，类型选 <b>WeWe RSS</b>，URL 粘贴该 feed 地址，保存即可。</li>
        <li>每次采集会自动拉取 feed → 解析每篇文章 → 走 AI 流水线 → 进入待审核。</li>
      </ol>
      <div class="evidence">同样的 RSS 适配器也兼容任意标准 RSS 2.0 / Atom 源（媒体、博客、政府公开数据接口等）。</div>
    </div>

    <div class="add-form" v-if="showAdd">
      <input v-model="form.unit" placeholder="单位/账号名称">
      <select v-model="form.type">
        <option value="website">网站（HTML）</option>
        <option value="wewe-rss">WeWe RSS（公众号→RSS）</option>
        <option value="rss">通用 RSS / Atom</option>
      </select>
      <select v-model="form.category"><option>部门类</option><option>企业类</option><option>专题类</option></select>
      <input v-model="form.url" placeholder="入口地址 (https://… 或 RSS feed URL)" style="flex:2;">
      <input v-model="form.owner_name" placeholder="责任人">
      <select v-model="form.group"><option>综合组</option><option>招商组</option><option>专题组</option></select>
      <select v-model="form.frequency"><option value="daily">每日</option><option value="4h">每4小时</option><option value="weekly">每周</option></select>
      <button class="btn primary" @click="addSource">保存</button>
    </div>

    <table class="table">
      <thead><tr>
        <th>单位</th><th>类别</th><th>采集器</th><th>入口</th><th>责任人/组</th>
        <th>频率</th><th>最近成功</th><th>失败</th><th>状态</th><th style="width:170px;">操作</th>
      </tr></thead>
      <tbody>
        <tr v-for="s in list" :key="s.id">
          <td><b>{{ s.unit }}</b></td>
          <td><span class="tag line">{{ s.category }}</span></td>
          <td>
            <span class="tag" :class="s.kind==='rss'?'imp-中':'info'">
              {{ s.kind==='rss' ? (s.type==='wewe-rss'?'WeWe RSS':'RSS/Atom') : 'HTML' }}
            </span>
          </td>
          <td style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            <a :href="s.url" target="_blank" style="color:#2563eb;">{{ s.url }}</a>
          </td>
          <td>{{ s.owner_name }} / {{ s.group }}</td>
          <td>{{ s.frequency }}</td>
          <td>{{ fmtTime(s.last_success) }}</td>
          <td>{{ s.fail_count }}</td>
          <td><span class="tag" :class="s.active?'ok':'muted'">{{ s.active?'启用':'停用' }}</span></td>
          <td>
            <button class="btn" @click="collectOne(s.id)">采集</button>
            <button class="btn" @click="toggle(s.id)">{{ s.active?'停用':'启用' }}</button>
          </td>
        </tr>
        <tr v-if="!list.length"><td colspan="10" class="hint">暂无信息源</td></tr>
      </tbody>
    </table>
  </div>
  `,
});

// ========== 采集任务 ==========
const Tasks = defineComponent({
  setup() {
    const list = ref([]);
    async function load() { list.value = await api.get('/api/tasks'); }
    async function collectAll() {
      await api.post('/api/collect');
      await load();
    }
    onMounted(load);
    return { list, collectAll, fmtTime, durSec };
  },
  template: `
  <div class="card">
    <div class="card-head"><h3>采集任务执行记录</h3>
      <div class="row-actions">
        <button class="btn primary" @click="collectAll">▶ 触发一次全量采集</button>
      </div>
    </div>
    <table class="table">
      <thead><tr><th>开始</th><th>耗时</th><th>信息源</th><th>状态</th><th>发现</th><th>新增</th><th>错误</th></tr></thead>
      <tbody>
        <tr v-for="t in list" :key="t.id">
          <td>{{ fmtTime(t.started_at) }}</td>
          <td>{{ durSec(t.started_at, t.finished_at) }}</td>
          <td>{{ t.unit }}</td>
          <td><span class="tag" :class="t.status==='success'?'ok':'fail'">{{ t.status==='success'?'成功':'失败' }}</span></td>
          <td>{{ t.found }}</td>
          <td>{{ t.new_items }}</td>
          <td style="color:#dc2626;">{{ t.error || '-' }}</td>
        </tr>
        <tr v-if="!list.length"><td colspan="7" class="hint">暂无任务</td></tr>
      </tbody>
    </table>
  </div>
  `,
});

// ========== 审核工作台 ==========
const Review = defineComponent({
  setup() {
    const filter = ref('pending_review');
    const list = ref([]);
    const sel = ref(null);
    const detail = ref(null);
    const logs = ref([]);
    const note = ref('');

    async function load() {
      list.value = await api.get('/api/articles?status=' + filter.value);
      if (list.value.length && !sel.value) await pick(list.value[0].id);
      else if (sel.value) {
        const found = list.value.find(a => a.id === sel.value);
        if (!found) { sel.value = null; detail.value = null; }
      }
    }
    async function pick(id) {
      sel.value = id;
      const r = await api.get('/api/article?id=' + id);
      detail.value = r.article;
      logs.value = r.logs || [];
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
      note.value = '';
      alert('已保存修改');
      await pick(detail.value.id);
    }
    async function approve() {
      if (!detail.value) return;
      if (!confirm('审核通过该条？通过后可纳入简报。')) return;
      await api.post('/api/article/approve?id=' + detail.value.id);
      await load();
    }
    async function reject() {
      if (!detail.value) return;
      const reason = prompt('请输入退回/归档原因：', '内容不需要纳入简报');
      if (!reason) return;
      await api.post('/api/article/reject?id=' + detail.value.id + '&note=' + encodeURIComponent(reason));
      await load();
    }
    async function reAI() {
      await api.post('/api/ai');
      await load();
    }
    watch(filter, load);
    onMounted(load);

    return { filter, list, sel, detail, logs, note, pick, save, approve, reject, reAI,
             fmtTime, statusLabel, statusTag };
  },
  template: `
  <div class="grid grid-2-1">
    <div class="card">
      <div class="card-head">
        <h3>审核队列</h3>
        <div class="row-actions">
          <select v-model="filter">
            <option value="pending_review">待审核</option>
            <option value="ai_done">AI 已处理</option>
            <option value="approved">已通过</option>
            <option value="published">已发布</option>
            <option value="archived">已归档</option>
          </select>
          <button class="btn" @click="reAI">⚙ 重跑 AI</button>
        </div>
      </div>
      <ul class="review-list">
        <li v-for="a in list" :key="a.id"
            :class="{ selected: sel === a.id }"
            @click="pick(a.id)">
          <div class="rl-title">
            <span class="tag" :class="'imp-'+a.importance">{{ a.importance }}</span>
            <span v-if="a.duplicate_of" class="tag dup">疑似重复</span>
            {{ a.title }}
          </div>
          <div class="rl-meta">{{ a.unit }} · {{ fmtTime(a.publish_time) }} · {{ a.source_type==='wechat'?'公众号':'网站' }} · 置信度 {{ (a.confidence||0).toFixed(2) }}</div>
          <div class="rl-summary">{{ a.summary }}</div>
        </li>
        <li v-if="!list.length" class="hint" style="padding:20px;text-align:center;cursor:default;border:none;">该状态下暂无内容</li>
      </ul>
    </div>

    <div class="card editor">
      <div class="card-head">
        <h3>详情 / 编辑</h3>
        <span class="hint" v-if="detail"><span class="tag" :class="statusTag(detail.status)">{{ statusLabel(detail.status) }}</span></span>
      </div>
      <div class="empty" v-if="!detail">← 从左侧选择一条内容</div>
      <div v-else>
        <h4>{{ detail.title }}</h4>
        <div class="meta">
          {{ detail.unit }} · 发布 {{ fmtTime(detail.publish_time) }} · 采集 {{ fmtTime(detail.fetch_time) }} ·
          <a :href="detail.url" target="_blank">原文链接</a> ·
          AI 置信度 <b>{{ (detail.confidence||0).toFixed(2) }}</b>
        </div>
        <div class="tag-row">
          <span class="tag line">{{ detail.category }}</span>
          <span class="tag" v-for="t in (detail.topics||[])" :key="t">#{{ t }}</span>
          <span class="tag muted" v-for="k in (detail.keywords||[])" :key="k">{{ k }}</span>
        </div>
        <details class="raw"><summary>展开原文正文</summary><div>{{ detail.content }}</div></details>

        <div class="ai-block">
          <div class="ai-tag">⚙ AI 辅助生成（可编辑，最终以人工审核为准）</div>
          <label>一句话摘要</label>
          <textarea v-model="detail.summary" rows="2"></textarea>
          <label>领导阅览摘要</label>
          <textarea v-model="detail.leader_summary" rows="3"></textarea>
          <label>详细摘要</label>
          <textarea v-model="detail.detail_summary" rows="4"></textarea>
          <div class="row">
            <label>重要性</label>
            <select v-model="detail.importance"><option>高</option><option>中</option><option>低</option></select>
            <label>审核备注</label>
            <input v-model="note" placeholder="(可选)">
          </div>
          <div class="evidence" v-if="detail.evidence">{{ detail.evidence }}</div>
        </div>
        <div class="actions">
          <button class="btn" @click="save">💾 保存修改</button>
          <button class="btn ok" @click="approve" v-if="detail.status==='pending_review' || detail.status==='ai_done'">✅ 审核通过</button>
          <button class="btn warn" @click="reject" v-if="detail.status==='pending_review' || detail.status==='ai_done'">↩ 退回 / 归档</button>
        </div>

        <details class="logs" v-if="logs.length"><summary>审核记录（{{ logs.length }} 条）</summary>
          <ul>
            <li v-for="l in logs" :key="l.id">
              [{{ fmtTime(l.occurred_at) }}] {{ l.reviewer }} {{ l.action }} <span v-if="l.note">— {{ l.note }}</span>
            </li>
          </ul>
        </details>
      </div>
    </div>
  </div>
  `,
});

// ========== 简报管理 ==========
const Briefs = defineComponent({
  setup() {
    const list = ref([]);
    async function load() { list.value = await api.get('/api/briefs'); }
    async function gen(t) {
      const b = await api.post('/api/briefs/generate?type=' + t);
      if (!(b.article_ids || []).length) {
        alert('暂无可纳入的已审核内容，请先在「审核工作台」审核通过若干条内容。');
      }
      await load();
    }
    async function publish(id) {
      const channel = prompt('推送渠道：app（应用消息） / group（群机器人） / file（文件链接）', 'app');
      if (!channel) return;
      const target = prompt('目标对象（如：张主任 / 党政办工作群）', '张主任');
      if (!target) return;
      const r = await api.post(`/api/briefs/publish?id=${id}&channel=${channel}&target=${encodeURIComponent(target)}`);
      alert(r.status === 'success' ? `已推送至 ${channelLabel(channel)}：${target}` : `推送失败 (code=${r.return_code})`);
      await load();
    }
    onMounted(load);
    return { list, gen, publish, fmtTime, fmtDate, channelLabel };
  },
  template: `
  <div class="card">
    <div class="card-head"><h3>简报管理</h3>
      <div class="row-actions">
        <button class="btn primary" @click="gen('daily')">+ 生成每日快报</button>
        <button class="btn primary" @click="gen('weekly')">+ 生成周度简报</button>
        <button class="btn" @click="gen('monthly')">+ 生成月度汇编</button>
      </div>
    </div>
    <div v-if="!list.length" class="hint" style="padding:30px;text-align:center;">暂无简报，点击上方按钮生成</div>
    <div class="brief-card" v-for="b in list" :key="b.id">
      <div class="brief-head">
        <div>
          <h4>
            <span class="tag" :class="b.status==='published'?'ok':'muted'">{{ b.status==='published'?'已发布':'草稿' }}</span>
            {{ b.title }}
          </h4>
          <div class="brief-meta">
            {{ b.period }} · 编辑：{{ b.editor }} · 创建 {{ fmtTime(b.created_at) }}
            <span v-if="b.published_at"> · 发布 {{ fmtTime(b.published_at) }}</span>
            · 含 {{ (b.items||[]).length }} 条
          </div>
        </div>
        <div class="row-actions">
          <button class="btn primary" v-if="b.status!=='published'" @click="publish(b.id)">📤 发布到企微</button>
          <button class="btn" v-else @click="publish(b.id)">📤 再次推送</button>
        </div>
      </div>
      <ol class="brief-items" v-if="b.items && b.items.length">
        <li v-for="a in b.items" :key="a.id">
          <span class="tag b-imp" :class="'imp-'+a.importance">{{ a.importance }}</span>
          <b>{{ a.unit }}</b>：{{ a.summary || a.title }}
          <a :href="a.url" target="_blank" class="more">原文 ›</a>
        </li>
      </ol>
      <div v-else class="hint" style="margin-top:8px;">（草稿暂无条目）</div>
    </div>
  </div>
  `,
});

// ========== 知识库 ==========
const Knowledge = defineComponent({
  setup() {
    const q = ref('');
    const unit = ref('');
    const topic = ref('');
    const units = ref([]);
    const results = ref([]);
    async function init() {
      const sources = await api.get('/api/sources');
      units.value = [...new Set(sources.map(s => s.unit))];
      await search();
    }
    async function search() {
      const params = new URLSearchParams({ q: q.value, unit: unit.value, topic: topic.value });
      results.value = await api.get('/api/search?' + params.toString());
    }
    function highlight(text, term) {
      if (!term) return text;
      try { return text.replace(new RegExp(term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g'), '<em>'+term+'</em>'); }
      catch (e) { return text; }
    }
    onMounted(init);
    return { q, unit, topic, units, results, search, highlight, fmtDate };
  },
  template: `
  <div class="card">
    <div class="card-head"><h3>知识库检索</h3>
      <span class="hint">关键词 + 单位 + 专题；命中片段高亮，溯源至原文</span>
    </div>
    <div class="search-bar">
      <input v-model="q" @keyup.enter="search" placeholder="输入关键词，如：营商环境 / 专精特新 / 经开区">
      <select v-model="unit">
        <option value="">全部单位</option>
        <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
      </select>
      <select v-model="topic">
        <option value="">全部专题</option>
        <option>营商环境</option><option>招商引资</option><option>重点企业</option>
        <option>经济运行</option><option>民生关注</option><option>创新驱动</option>
      </select>
      <button class="btn primary" @click="search">🔎 检索</button>
    </div>
    <div class="kb-results">
      <div v-if="!results.length" class="hint" style="padding:30px;text-align:center;">未命中任何内容</div>
      <div class="kb-item" v-for="h in results" :key="h.article.id">
        <div class="kb-title">
          <span class="tag" :class="'imp-'+h.article.importance">{{ h.article.importance }}</span>
          <a :href="h.article.url" target="_blank" v-html="highlight(h.article.title, q)"></a>
        </div>
        <div class="kb-meta">
          {{ h.article.unit }} · {{ h.article.source_type==='wechat'?'公众号':'网站' }} ·
          {{ fmtDate(h.article.publish_time) }} ·
          <span v-for="t in (h.article.topics||[])" :key="t">#{{ t }} </span>
          <span v-if="h.score">· 命中 {{ h.score }}</span>
        </div>
        <div class="kb-snippet" v-html="highlight(h.snippet, q)"></div>
      </div>
    </div>
  </div>
  `,
});

// ========== 企微推送 ==========
const Wecom = defineComponent({
  setup() {
    const list = ref([]);
    async function load() { list.value = await api.get('/api/pushes'); }
    onMounted(load);
    return { list, fmtTime, channelLabel };
  },
  template: `
  <div class="grid grid-2-1">
    <div class="card">
      <div class="card-head"><h3>企微推送日志</h3><span class="hint">应用消息 / 群机器人 / 工作台 — 含发送结果与重试码</span></div>
      <table class="table">
        <thead><tr><th>时间</th><th>渠道</th><th>对象</th><th>主题</th><th>结果</th><th>返回码</th></tr></thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td>{{ fmtTime(p.occurred_at) }}</td>
            <td><span class="tag info">{{ channelLabel(p.channel) }}</span></td>
            <td>{{ p.target }}</td>
            <td>{{ p.subject }}</td>
            <td><span class="tag" :class="p.status==='success'?'ok':'fail'">{{ p.status==='success'?'成功':'失败' }}</span></td>
            <td>{{ p.return_code }}</td>
          </tr>
          <tr v-if="!list.length"><td colspan="6" class="hint">暂无推送记录</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head"><h3>渠道与配置</h3></div>
      <ul class="channel-list">
        <li><span class="dot ok"></span><b>自建应用消息</b>已配置；可见范围：党政办综合组（5人）</li>
        <li><span class="dot ok"></span><b>群机器人</b>党政办工作群（Webhook 已加密保存）</li>
        <li><span class="dot ok"></span><b>工作台入口</b>可信域名已配置，移动端可一键打开</li>
        <li><span class="dot warn"></span><b>文件 / 安全链接</b>用于周期简报（短期有效）</li>
      </ul>
      <div class="hint" style="margin-top:14px;">
        说明：本 Demo 推送为模拟实现，方便联调与展示；接入正式企微需企业管理员授权。
      </div>
    </div>
  </div>
  `,
});

// ========== 路由 ==========
const routes = [
  { path: '/', component: Dashboard, meta: { title: '工作台' } },
  { path: '/sources', component: Sources, meta: { title: '信息源管理' } },
  { path: '/tasks', component: Tasks, meta: { title: '采集任务' } },
  { path: '/review', component: Review, meta: { title: '审核工作台' } },
  { path: '/briefs', component: Briefs, meta: { title: '简报管理' } },
  { path: '/knowledge', component: Knowledge, meta: { title: '知识库检索' } },
  { path: '/wecom', component: Wecom, meta: { title: '企微推送' } },
];
const router = createRouter({ history: createWebHashHistory(), routes });

const App = {
  setup() {
    const route = VueRouter.useRoute();
    const pageTitle = computed(() => route.meta?.title || '工作台');
    return { pageTitle };
  },
};

createApp(App).use(router).mount('#app');
