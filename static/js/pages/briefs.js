// ============================================================
// 5. 简报管理 Briefs
// ============================================================
import {
  defineComponent, ref, reactive, onMounted,
  api, authToken, showToast, showConfirm, showPrompt,
  fmtTime, channelLabel, statusLabel,
} from '../shared.js';

export default defineComponent({
  setup() {
    const list = ref([]);
    const loaded = ref(false);
    const loadError = ref(false);
    const expanded = reactive(new Set());

    async function load() {
      const r = await api.get('/api/briefs');
      loadError.value = (r === null);
      if (r) list.value = r;
      loaded.value = true;
    }

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

    // Word 导出：用 fetch + blob 下载，自动带 Bearer token，避免被当成 export.json 保存
    async function exportWord(b) {
      try {
        const r = await fetch('/api/briefs/export?id=' + b.id, {
          headers: authToken.value ? { 'Authorization': 'Bearer ' + authToken.value } : {},
        });
        if (r.status === 401) { showToast('会话已过期，请重新登录', 'warning'); return; }
        if (!r.ok) { showToast('导出失败：HTTP ' + r.status, 'error'); return; }
        const blob = await r.blob();
        // 兜底：若服务端返回 JSON（非 docx），提示错误，不要把 json 当 docx 存盘
        if (blob.type && blob.type.includes('json')) {
          showToast('导出失败：服务端未返回 Word 文件', 'error');
          return;
        }
        // 文件名从 Content-Disposition 解析；失败则用标题
        let filename = (b.title || 'brief') + '.docx';
        const cd = r.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename\*?=(?:UTF-8'')?["]?([^";]+)["]?/i);
        if (m && m[1]) {
          try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        showToast('导出失败：' + e.message, 'error');
      }
    }

    onMounted(load);
    return { list, loaded, loadError, load, expanded, gen, publish, toggle, fmtTime, channelLabel, statusLabel, authToken, exportWord };
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
      <div v-if="!loaded" class="empty">⏳ 加载中…</div>
      <div v-else-if="loadError" class="empty">
        <div class="empty-icon">⚠️</div>
        <div class="empty-text">加载失败，<button type="button" class="btn-link" @click="load">点击重试</button></div>
      </div>
      <div v-else-if="!list.length" class="empty">
        <div class="empty-icon">📰</div>
        <div class="empty-text">暂无简报，请使用上方卡片生成</div>
      </div>
      <div v-for="b in list" :key="b.id" class="brief-card" :class="'t-'+b.type">
        <div class="brief-head">
          <div class="flex-1">
            <h4>{{ b.title }}</h4>
            <div class="brief-meta">
              <span>{{ b.period }}</span>
              <span class="tag" :class="b.status==='published'?'ok':'muted'">{{ statusLabel(b.status) }}</span>
              <span>{{ b.items?.length || b.article_ids?.length || 0 }} 条</span>
              <span>编辑：{{ b.editor }}</span>
              <span v-if="b.published_at">{{ fmtTime(b.published_at) }}</span>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn sm ghost" @click="toggle(b.id)">{{ expanded.has(b.id) ? '收起' : '展开' }}</button>
            <button type="button" class="btn sm" @click="exportWord(b)" title="导出 Word">📄 Word</button>
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
