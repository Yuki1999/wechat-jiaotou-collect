# 党政办信息跟踪与智能整理系统 · Demo

> 面向党政办的"信息源 → 自动采集 → AI 整理 → 人工审核 → 简报 → 企微推送"闭环 Demo
> 已接入**真实数据源**：苏州工业园区管委会官网 + 通用 RSS / wechat2rss 适配

## 技术栈

- **后端**：Go 1.21（仅标准库；net/http、encoding/xml、regexp、io/embed）
- **前端**：Vue 3 + Vue Router 4（CDN，零构建）
- **存储**：内存 + JSON 落盘 (`data.json`)
- **采集器**：
  - `html_list` — 通用列表+详情页 HTML 抓取（已对苏州工业园区站点适配 `<meta ArticleTitle>` / `id="zoomcon"`）
  - `rss` — 标准 RSS 2.0 / Atom，**与 wechat2rss 直接兼容**
- **AI 整理**：规则引擎（关键词字典 + 主题映射 + 重要性判定 + 首句摘要 + 置信度）

## 快速开始

```bash
go run .
# 浏览器打开 http://127.0.0.1:8080
```

首次启动后，**点击 Dashboard 上的「触发一次全量采集」**——系统会真实抓取苏州工业园区管委会官网的园区要闻、即时动态、媒体聚焦、园区公告 4 个栏目，得到 25–30 篇真实新闻，并自动跑 AI 整理流水线进入待审核。

## 接入微信公众号（以"苏州工业园区发布"为例）

本系统通过 **wechat2rss**（付费私有部署）把任意微信公众号转为标准 RSS。本仓库 `deploy/wechat2rss/` 已经提供完整的部署脚本与运维文档。

### 1. 部署 wechat2rss

```bash
cd deploy/wechat2rss
cp .env.example .env
# 编辑 .env，填入 LIC_EMAIL / LIC_CODE / RSS_HOST / RSS_TOKEN
# 端口建议设为 8090，避开党政办系统占用的 8080
./deploy.sh up
```

> 完整的部署/订阅/排错手册见 [`deploy/wechat2rss/README.md`](deploy/wechat2rss/README.md)。

### 2. 在 wechat2rss 控制台添加公众号

浏览器打开 `http://<RSS_HOST>`（如 `http://192.168.0.130:8090`），密码为 `.env` 中的 `RSS_TOKEN`。

- 控制台 → 账号管理 → 用**专用小号**扫码登录（仅用于读取公众号文章，**不要用主号**）
- 任意复制一篇目标公众号的文章链接（形如 `https://mp.weixin.qq.com/s/xxxxx`），粘贴到控制台 → 订阅

控制台会返回该公众号的 feed URL，形如：

```
http://192.168.0.130:8090/feed/<sha1>.xml
```

### 3. 在本系统添加 RSS 信息源

**方式一**：在 Demo 的 **信息源管理 → 新增信息源** 中：

| 字段 | 填什么 |
|---|---|
| 单位名称 | `苏州工业园区发布`（或对应公众号名） |
| 类型 | `wechat2rss（公众号→RSS）` |
| 入口地址 | 上一步得到的 feed URL |
| 责任人 / 组 / 频率 | 按业务填 |

点保存 → 点"采集" → 真实公众号文章就进入系统了。

**方式二**（推荐，批量）：用 `deploy/wechat2rss/import-to-dzb.sh` 一键把 wechat2rss 上所有已订阅公众号全部同步进党政办系统。重复 URL 自动跳过。

## 项目结构

```
.
├── main.go            # Go 后端（API + 采集器 + AI 流水线）
├── go.mod
├── index.html         # SPA 入口
├── static/
│   ├── app.js         # Vue 组件 + 路由（7 个页面）
│   └── style.css
├── data.json          # 运行后生成
├── plan.docx          # 原方案文档
└── README.md
```

## 七大页面（与方案模块对齐）

| 路由 | 模块 | 关键交互 |
|---|---|---|
| `/` | 工作台 | 实时统计、一键演示流程、最近任务、待审核 |
| `/sources` | 信息源管理 | HTML / RSS / wechat2rss；启停、单源采集、全量采集 |
| `/tasks` | 采集任务 | 任务历史、耗时、错误码 |
| `/review` | 审核工作台 | 双栏列表+编辑器；AI 摘要可改、通过/退回 |
| `/briefs` | 简报管理 | 日报/周报/月报生成 + 一键发布企微 |
| `/knowledge` | 知识库检索 | 关键词×单位×专题，命中片段高亮 |
| `/wecom` | 企微推送 | 推送日志 + 渠道配置面板 |

## 采集器实现要点

- **HTML 列表页**：`<li>` 中提取 `<a href="*.shtml">标题</a>` + 日期；过滤导航、英文/日文站、栏目首页。
- **HTML 详情页**：标题取 `<meta name="ArticleTitle">`，正文用 div 配对计数从 `id="zoomcon"` 起切出（避免贪婪正则问题）。
- **RSS / Atom**：标准 `encoding/xml`；自动识别 `rss/channel/item` 与 `feed/entry`，提取 `title / link / description / content:encoded / pubDate`。
- **去重**：URL + content hash；同 URL 不重复入库。
- **AI 整理**：规则引擎，**完全本地、不外发数据**：
  - 关键词字典命中 → 返回 top 6 关键词
  - 主题映射（营商环境 / 招商引资 / 重点企业 / 产业创新 / 经济运行 / 民生关注 / 涉外开放）
  - 重要性按"高频敏感词 + 印发/推进会/部署/调研"两档判定
  - 首句摘要 + 三档摘要（一句话 / 领导阅览 / 详细）
  - 置信度 0.75 ~ 0.95 浮动

如要替换为大模型摘要，只需修改 `runOneAI()`，把规则引擎替换为 LLM 调用即可，业务流水线不变。

## 已知边界

- "政声传递"栏目列表为 JS 动态加载，静态抓取拿不到，已默认停用（如需可改用 headless browser）。
- 本 Demo 的"企微推送"为模拟实现，正式接入需企业管理员授权 corpId / agentId / secret。
- wechat2rss 通过授权微信号 + 微信读书官方接口拉取公众号文章；账号有被风控风险，请用专门小号且控制频率。
