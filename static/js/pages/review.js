// ============================================================
// 4. 审核工作台 Review
// ============================================================
import {
  defineComponent, ref, computed, watch, onMounted, onUnmounted,
  ui, api, showToast, showConfirm, showPrompt,
  fmtTime, fmtRelative, statusLabel, statusTag,
} from '../shared.js';

export default defineComponent({
  setup() {
    const filter = ref('pending_review');
    const unitFilter = ref('');       // 按来源单位过滤
    const kw = ref('');                // 标题关键词过滤
    const sortMode = ref('importance'); // importance / newest / oldest
    const list = ref([]);
    const loaded = ref(false);
    const loadError = ref(false);
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
      const r = await api.get('/api/articles?status=' + filter.value);
      loadError.value = (r === null);
      if (r) list.value = r;
      loaded.value = true;
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
    // 请求序号守卫：连续 j/k 导航时只应用最后一次详情响应，避免乱序覆盖
    let pickSeq = 0;
    async function pick(id) {
      sel.value = id;
      const seq = ++pickSeq;
      const d = await api.get('/api/article?id=' + id);
      if (seq !== pickSeq) return;
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
      const n = res?.processed || 0;
      showToast(n ? `AI 重跑完成：${n} 条（含待整理/失败重试）` : '没有待整理或失败的文章', 'info');
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
      list, loaded, loadError, load, logs, sel, detail, note,
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
          <select v-model="filter" class="sel">
            <option value="pending_review">待审核</option>
            <option value="approved">已通过</option>
            <option value="published">已发布</option>
            <option value="failed">整理失败</option>
            <option value="duplicate">重复</option>
            <option value="archived">已归档</option>
            <option value="">全部</option>
          </select>
          <button class="btn ghost sm" @click="reAI" title="重跑待整理(collected)与整理失败(failed)的文章">⚙ 重跑 AI</button>
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
        <li v-if="!loaded" class="loading-row">⏳ 加载中…</li>
        <li v-else-if="loadError" style="padding:30px;text-align:center;color:var(--text-muted);border:none;background:transparent;">
          <div class="empty-icon" style="font-size:36px;">⚠️</div>
          <div>加载失败，<button type="button" class="btn-link" @click="load">点击重试</button></div>
        </li>
        <li v-else-if="!filtered.length" style="padding:30px;text-align:center;color:var(--text-muted);border:none;background:transparent;">
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
