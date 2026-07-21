// ============================================================
// 7. 企微推送 Wecom
// ============================================================
import {
  defineComponent, ref, computed, onMounted,
  api, fmtTime, channelLabel,
} from '../shared.js';

export default defineComponent({
  setup() {
    const list = ref([]);
    const loaded = ref(false);
    const loadError = ref(false);
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

    async function load() {
      const r = await api.get('/api/pushes');
      loadError.value = (r === null);
      if (r) list.value = r;
      loaded.value = true;
    }
    onMounted(load);

    return { list, loaded, loadError, load, filter, filtered, todayCount, todayOk, fmtTime, channelLabel };
  },
  template: `
  <div class="fade-in grid grid-2-1">
    <div class="card">
      <div class="card-head">
        <h3>推送日志</h3>
        <select v-model="filter" class="sel">
          <option value="">全部</option>
          <option value="success">成功</option>
          <option value="fail">失败</option>
        </select>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th scope="col">时间</th><th scope="col">渠道</th><th scope="col">对象</th><th scope="col">主题</th><th scope="col">结果</th><th scope="col">返回码</th>
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
            <tr v-if="!loaded">
              <td colspan="6" class="empty-table">⏳ 加载中…</td>
            </tr>
            <tr v-else-if="loadError">
              <td colspan="6" class="empty-table">
                <div class="empty-icon">⚠️</div>
                <div>加载失败，<button type="button" class="btn-link" @click="load">点击重试</button></div>
              </td>
            </tr>
            <tr v-else-if="!filtered.length">
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
