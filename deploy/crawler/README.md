# 党政办通用采集微服务

基于 [crawl4ai](https://github.com/unclecode/crawl4ai) 的网页采集微服务，给党政办主系统提供泛化抓取能力。

## 它做什么

把任意 URL → 结构化数据（标题 / 正文 / 发布日期），**不针对单个网站写正则**，靠 headless Chromium + 启发式提取实现泛化。

## 安装（一次性）

```bash
cd deploy/crawler
python3 -m venv venv
source venv/bin/activate
pip install crawl4ai fastapi uvicorn pydantic
crawl4ai-setup        # 安装 Playwright Chromium（约 150-300MB）
crawl4ai-doctor       # 可选：验证安装
```

## 启动

```bash
source venv/bin/activate
python service.py
# 监听 http://127.0.0.1:8070
```

## 接口

### `GET /health`
健康检查。

### `POST /crawl_detail`
抓单篇文章详情页。
```json
// 请求
{"url": "https://www.sipac.gov.cn/szgyyq/zwyw/202606/xxxx.shtml"}

// 响应
{
  "ok": true,
  "title": "文章标题",
  "content_text": "纯文本正文…",
  "content_markdown": "## 标题\n正文…",
  "publish_time": "2026-06-22 15:30",
  "error": ""
}
```

### `POST /crawl_list`
抓列表页，返回文章链接列表。
```json
// 请求
{"url": "https://www.sipac.gov.cn/szgyyq/zwyw/xwzx_list.shtml", "max": 8}

// 响应
{
  "ok": true,
  "items": [
    {"url": "https://.../article1.shtml", "title": "标题1", "publish_time": "2026-06-22"},
    ...
  ],
  "error": ""
}
```

## 不需要 LLM API Key

基础抓取（HTML → markdown → 启发式提取标题/正文/日期）**完全本地**，不调用任何云端 LLM。

如需更精准的结构化提取（如抽"会议纪要"特定字段），可后续在 `service.py` 里加 `LLMExtractionStrategy`，届时需要配 `LLMConfig(provider=..., api_token=...)`。

## 与主系统关系

```
党政办系统 (Go, :8080)
    │ collectHTML() / /api/sources/test
    ↓ HTTP
采集微服务 (Python, :8070)  ← 本服务
    ↓
crawl4ai + headless Chromium
    ↓
目标网站
```

主系统 Go 代码里**保留了原有的正则解析作为 fallback**——本微服务挂掉时自动降级，不影响演示。
