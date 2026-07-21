// ============================================================
// 2. 信息源管理 Sources
// ============================================================
import {
  defineComponent, ref, reactive, computed, watch, onMounted,
  api, showToast, showConfirm, showDrawer, fmtTime,
} from '../shared.js';

export default defineComponent({
  setup() {
    const list = ref([]);
    const loaded = ref(false);
    const loadError = ref(false);
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

    async function load() {
      const r = await api.get('/api/sources');
      loadError.value = (r === null);
      if (r) list.value = r;
      loaded.value = true;
    }

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

    function isValidUrl(u) {
      try { new URL(u); return true; } catch (e) { return false; }
    }

    async function addSource() {
      if (!form.unit || !form.url) {
        showToast('请填写单位名称与入口地址', 'warning');
        return;
      }
      if (!isValidUrl(form.url)) {
        showToast('入口地址格式不正确，请输入完整 URL（含 http:// 或 https://）', 'warning');
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
      const r = await api.post('/api/sources/delete?id=' + s.id);
      if (r !== null) { showToast('已删除', 'success'); await load(); }
    }

    // 测试采集：粘 URL 后立即试抓，不入库
    const testing = ref(false);
    const testResult = ref(null);
    async function testCollect() {
      if (!form.url) { showToast('请先填写入口地址', 'warning'); return; }
      if (!isValidUrl(form.url)) {
        showToast('入口地址格式不正确，请输入完整 URL（含 http:// 或 https://）', 'warning');
        return;
      }
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
      list, loaded, loadError, load, search, filterType, filtered, showAdd, form,
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
                  <select :value="''" class="sel flex-1"
                          @change="e=>{ pickW2RFeed(e.target.value); e.target.value=''; }">
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
            <th scope="col">单位</th><th scope="col">类别</th><th scope="col">采集器</th><th scope="col">入口</th>
            <th scope="col">责任人/组</th><th scope="col">频率</th><th scope="col">最近成功</th><th scope="col">失败</th>
            <th scope="col">状态</th><th scope="col" style="width:110px;">操作</th>
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
                  <button class="btn sm warn" @click="delSource(s)" title="删除信息源" aria-label="删除信息源">🗑</button>
                </div>
              </td>
            </tr>
            <tr v-if="!loaded">
              <td colspan="10" class="empty-table">⏳ 加载中…</td>
            </tr>
            <tr v-else-if="loadError">
              <td colspan="10" class="empty-table">
                <div class="empty-icon">⚠️</div>
                <div>加载失败，<button type="button" class="btn-link" @click="load">点击重试</button></div>
              </td>
            </tr>
            <tr v-else-if="!filtered.length">
              <td colspan="10" class="empty-table">
                <div class="empty-icon">📭</div>
                <div v-if="search">没有匹配 "<b>{{ search }}</b>" 的信息源</div>
                <div v-else>暂无信息源，<button type="button" class="btn-link" @click="showAdd=true">添加第一个</button></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`
});
