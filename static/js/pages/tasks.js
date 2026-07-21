// ============================================================
// 3. 采集任务 Tasks
// ============================================================
import {
  defineComponent, ref, watch, onMounted, onUnmounted,
  api, showToast, fmtTime, durSec,
} from '../shared.js';

export default defineComponent({
  setup() {
    const list = ref([]);
    const loaded = ref(false);
    const loadError = ref(false);
    const refreshSec = ref(0);   // 0 = 关闭，否则秒数
    let timer = null;

    async function load() {
      const r = await api.get('/api/tasks');
      loadError.value = (r === null);
      if (r) list.value = r;
      loaded.value = true;
    }
    async function collectAll() {
      await api.post('/api/collect');
      showToast('全量采集已触发', 'info');
      await load();
    }

    function applyRefresh() {
      if (timer) { clearInterval(timer); timer = null; }
      if (refreshSec.value > 0) {
        timer = setInterval(load, refreshSec.value * 1000);
      }
    }
    watch(refreshSec, () => {
      applyRefresh();
      if (refreshSec.value > 0) {
        const label = refreshSec.value >= 60 ? (refreshSec.value/60) + ' 分钟' : refreshSec.value + ' 秒';
        showToast(`已开启自动刷新，每 ${label} 一次`, 'info');
      }
    });
    onMounted(load);
    onUnmounted(() => clearInterval(timer));

    return { list, loaded, loadError, refreshSec, load, collectAll, fmtTime, durSec };
  },
  template: `
  <div class="fade-in">
    <div class="card">
      <div class="card-head">
        <h3>采集任务历史</h3>
        <div class="row-actions">
          <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);">
            自动刷新
            <select v-model.number="refreshSec" class="sel">
              <option :value="0">关闭</option>
              <option :value="30">30 秒</option>
              <option :value="60">1 分钟</option>
              <option :value="300">5 分钟</option>
              <option :value="1800">30 分钟</option>
            </select>
          </label>
          <button class="btn ghost sm" @click="load">🔄 刷新</button>
          <button class="btn primary" @click="collectAll">▶ 全量采集</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:10px;">
        💡 后端已启用<b>定时自动采集</b>：每分钟扫一次，按各信息源的 <code>frequency</code>（daily / 4h / weekly）到期重跑。
        这里的"自动刷新"只是控制本页前端从后端拉最新结果的频率。
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th scope="col">信息源</th><th scope="col">开始时间</th><th scope="col">完成时间</th><th scope="col">耗时</th>
            <th scope="col">发现</th><th scope="col">新增</th><th scope="col">状态</th><th scope="col">错误</th>
          </tr></thead>
          <tbody>
            <tr v-for="t in list" :key="t.id" :class="{ 'row-danger': t.status === 'fail' }">
              <td>{{ t.unit }}</td>
              <td class="cell-mono">{{ fmtTime(t.started_at) }}</td>
              <td class="cell-mono">{{ fmtTime(t.finished_at) }}</td>
              <td class="cell-mono">{{ durSec(t.started_at, t.finished_at) }}</td>
              <td>{{ t.found || 0 }}</td>
              <td><b>{{ t.new_items || 0 }}</b></td>
              <td>
                <span v-if="t.status === 'success'" class="text-ok">✅ 成功</span>
                <span v-else-if="t.status === 'fail'" class="text-danger">❌ 失败</span>
                <span v-else>⏳ {{ t.status }}</span>
              </td>
              <td class="cell-truncate" style="max-width:300px;color:var(--danger);font-size:12px;">{{ t.error || '-' }}</td>
            </tr>
            <tr v-if="!loaded">
              <td colspan="8" class="empty-table">⏳ 加载中…</td>
            </tr>
            <tr v-else-if="loadError">
              <td colspan="8" class="empty-table">
                <div class="empty-icon">⚠️</div>
                <div>加载失败，<button type="button" class="btn-link" @click="load">点击重试</button></div>
              </td>
            </tr>
            <tr v-else-if="!list.length">
              <td colspan="8" class="empty-table">
                <div class="empty-icon">⏱️</div>
                <div>暂无采集任务，前往 <router-link to="/sources">信息源管理</router-link> 触发采集</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`
});
