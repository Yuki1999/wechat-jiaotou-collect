// ============================================================
// 6. 知识库检索 Knowledge
// ============================================================
import {
  defineComponent, ref, onMounted,
  api, fmtTime, fmtRelative, escapeHtml,
} from '../shared.js';

export default defineComponent({
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
    // 先对原文做 HTML 转义，再对转义后的文本做关键词高亮，防止 v-html 注入
    function highlight(text, term) {
      if (!text) return '';
      const esc = escapeHtml(text);
      if (!term) return esc;
      try {
        const t = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return esc.replace(new RegExp('(' + t + ')', 'ig'), '<em>$1</em>');
      } catch (e) { return esc; }
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
