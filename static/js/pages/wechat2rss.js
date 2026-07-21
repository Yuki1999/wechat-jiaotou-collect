// ============================================================
// 8. 公众号订阅 Wechat2RSS
// ============================================================
import {
  defineComponent, ref, computed, onMounted, onUnmounted,
  api, showToast, showConfirm, fmtTime,
} from '../shared.js';

export default defineComponent({
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
              <button class="btn sm warn btn-icon" @click="delFeed(f)" title="删除订阅" aria-label="删除订阅">🗑</button>
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
                <button class="btn sm ghost btn-icon" @click="refreshAccount(a)" title="标记解风控" aria-label="标记解风控">↻</button>
                <button class="btn sm warn btn-icon" @click="delAccount(a)" title="删除账号" aria-label="删除账号">🗑</button>
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
          <button class="modal-close" @click="showAddFeed=false" aria-label="关闭">✕</button>
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
          <button class="modal-close" @click="closeQrcode" aria-label="关闭">✕</button>
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
          <button class="modal-close" @click="showSync=false" aria-label="关闭">✕</button>
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
