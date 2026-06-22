"""
党政办信息跟踪系统 — 通用网页采集微服务
基于 crawl4ai，把任意 URL 抓成结构化数据（标题/正文/日期）。

启动：
    python service.py
    # 默认监听 :8070

接口：
    POST /crawl_detail   {"url": "..."}   → {"title","content_text","content_markdown","publish_time","ok","error"}
    POST /crawl_list     {"url": "...", "max": 8} → {"items":[{"url","title","publish_time"}], "ok","error"}
    GET  /health                           → {"ok": true, "version": "..."}
"""

import asyncio
import re
import os
import sys
import logging
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# crawl4ai
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, BrowserConfig
from crawl4ai.async_crawler_strategy import AsyncPlaywrightCrawlerStrategy
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from crawl4ai.content_filter_strategy import PruningContentFilter

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("crawler")

# ---------------------------------------------------------------------------
# 全局 crawler 单例（避免每次请求都启动一次 Chromium）
# ---------------------------------------------------------------------------
_crawler: AsyncWebCrawler | None = None


async def get_crawler() -> AsyncWebCrawler:
    global _crawler
    if _crawler is None:
        log.info("initializing AsyncWebCrawler (first request)…")
        import os
        chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

        if os.path.exists(chrome_path):
            log.info("using system Google Chrome @ %s", chrome_path)
            # crawl4ai 0.9.0 的 AsyncPlaywrightCrawlerStrategy 内部用 playwright launch，
            # 不认 channel=chrome，只认自带的 Chrome for Testing。
            # 我们 monkey-patch playwright 的 BrowserType.launch / launch_persistent_context，
            # 强制注入 executable_path 指向系统 Chrome。
            from playwright.async_api import BrowserType
            _orig_launch = BrowserType.launch
            _orig_launch_persistent = BrowserType.launch_persistent_context

            async def _patched_launch(self, *args, **kwargs):
                kwargs["executable_path"] = chrome_path
                kwargs.pop("channel", None)
                return await _orig_launch(self, *args, **kwargs)

            async def _patched_launch_persistent(self, *args, **kwargs):
                kwargs["executable_path"] = chrome_path
                kwargs.pop("channel", None)
                return await _orig_launch_persistent(self, *args, **kwargs)

            BrowserType.launch = _patched_launch
            BrowserType.launch_persistent_context = _patched_launch_persistent
            log.info("playwright BrowserType.launch monkey-patched → system Chrome")

            cfg = BrowserConfig(headless=True)
        else:
            log.info("system Chrome not found, using bundled chromium")
            cfg = BrowserConfig(headless=True)

        _crawler = AsyncWebCrawler(crawler_strategy=AsyncPlaywrightCrawlerStrategy(browser_config=cfg))
        await _crawler.__aenter__()
        log.info("crawler ready")
    return _crawler


# ---------------------------------------------------------------------------
# 启发式解析（不依赖 LLM）
# ---------------------------------------------------------------------------
DATE_RE = re.compile(
    r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?"
)
TIME_RE = re.compile(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})")


def extract_title(markdown: str, html: str = "") -> str:
    """从 markdown / html 里启发式抽标题。"""
    # 1) markdown 第一个 # 标题
    for line in (markdown or "").splitlines():
        line = line.strip()
        if line.startswith("# "):
            t = line[2:].strip()
            if 4 <= len(t) <= 120:
                return t
    # 2) <title>
    m = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.S | re.I)
    if m:
        t = re.sub(r"\s+", " ", m.group(1)).strip()
        # 去掉常见的站点后缀 "- 苏州工业园区" "_政务公开" 等
        t = re.split(r"[-_|－丨]", t)[0].strip()
        if t:
            return t
    # 3) markdown 第一段非空文本
    for line in (markdown or "").splitlines():
        line = line.strip()
        if line and not line.startswith(("!", "[", "|", "-", "#", ">")):
            return line[:120]
    return ""


def extract_date(text: str) -> str:
    """从任意文本里抽一个日期，返回 YYYY-MM-DD HH:MM 或 YYYY-MM-DD。"""
    if not text:
        return ""
    # 优先匹配完整日期时间
    m = TIME_RE.search(text)
    if m:
        return m.group(1)
    m = DATE_RE.search(text)
    if m:
        y, mo, d = m.group(1), m.group(2), m.group(3)
        hh, mm = m.group(4), m.group(5)
        s = f"{y}-{int(mo):02d}-{int(d):02d}"
        if hh and mm:
            s += f" {hh}:{mm}"
        return s
    return ""


def clean_text(s: str) -> str:
    """压平空白。"""
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="党政办通用采集微服务", version="1.0.0")


class CrawlDetailReq(BaseModel):
    url: str


class CrawlListReq(BaseModel):
    url: str
    max: int = 8


@app.get("/health")
async def health():
    return {"ok": True, "service": "crawler", "version": "1.0.0"}


@app.post("/crawl_detail")
async def crawl_detail(req: CrawlDetailReq):
    url = (req.url or "").strip()
    if not url:
        return JSONResponse({"ok": False, "error": "url required"}, status_code=400)
    log.info(f"[detail] {url}")
    try:
        crawler = await get_crawler()
        cfg = CrawlerRunConfig(
            markdown_generator=DefaultMarkdownGenerator(
                content_filter=PruningContentFilter(threshold=0.48, threshold_type="fixed"),
                options={"ignore_links": True, "body_width": 0},
            ),
            word_count_threshold=20,
            page_timeout=20000,
            verbose=False,
        )
        result = await crawler.arun(url=url, config=cfg)
        if not result.success:
            return {"ok": False, "error": result.error_message or "crawl failed", "title": "", "content_text": "", "content_markdown": "", "publish_time": ""}

        md_raw = result.markdown
        # crawl4ai 不同版本里 markdown 可能是 str 或对象
        if hasattr(md_raw, "fit_markdown") and md_raw.fit_markdown:
            md = md_raw.fit_markdown
        elif hasattr(md_raw, "raw_markdown") and md_raw.raw_markdown:
            md = md_raw.raw_markdown
        else:
            md = str(md_raw or "")

        html = getattr(result, "html", "") or ""
        title = extract_title(md, html)
        # 日期：从 markdown 前 2000 字符里找（通常在页眉）
        pub = extract_date(md[:2000]) or extract_date(html[:5000])

        # 纯文本正文（去 markdown 符号）
        content_text = re.sub(r"[#*`>\-|!\[\]]", "", md)
        content_text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", content_text)
        content_text = clean_text(content_text)

        # 过滤过短内容
        if len(content_text) < 30:
            return {"ok": False, "error": "正文过短（可能不是文章详情页）", "title": title, "content_text": content_text, "content_markdown": md, "publish_time": pub}

        log.info(f"[detail] ok title={title[:40]!r} len={len(content_text)} date={pub}")
        return {
            "ok": True,
            "title": title,
            "content_text": content_text,
            "content_markdown": md[:8000],  # 截断，避免太大
            "publish_time": pub,
            "error": "",
        }
    except Exception as e:
        log.exception("[detail] error")
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "title": "", "content_text": "", "content_markdown": "", "publish_time": ""}


@app.post("/crawl_list")
async def crawl_list(req: CrawlListReq):
    """抓列表页，返回条目列表。策略：
    1) 用 crawl4ai 抓整页 markdown + 原始 HTML
    2) 从 HTML 里正则抽所有 <a href> 链接 + 同行日期
    3) 过滤掉导航/首页/外部链接，保留看起来像文章的链接
    """
    url = (req.url or "").strip()
    max_items = max(1, min(req.max or 15, 30))
    if not url:
        return JSONResponse({"ok": False, "error": "url required", "items": []}, status_code=400)
    log.info(f"[list] {url} max={max_items}")
    try:
        crawler = await get_crawler()
        cfg = CrawlerRunConfig(
            markdown_generator=DefaultMarkdownGenerator(
                options={"ignore_links": False, "body_width": 0},
            ),
            page_timeout=20000,
            verbose=False,
        )
        result = await crawler.arun(url=url, config=cfg)
        if not result.success:
            return {"ok": False, "error": result.error_message or "crawl failed", "items": []}

        html = getattr(result, "html", "") or ""
        from urllib.parse import urljoin, urlparse
        base = url

        # 抽 <a href="...">text</a>
        links = re.findall(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.S | re.I)
        seen = set()
        items = []
        for href, anchor in links:
            href = href.strip()
            if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            full = urljoin(base, href)
            # 只保留 http(s)
            if not full.startswith(("http://", "https://")):
                continue
            # 过滤明显导航/首页
            path = urlparse(full).path.lower()
            if path in ("", "/", "/index.html", "/index.shtml", "/index.htm"):
                continue
            if any(x in path for x in ["_list", "/english", "/japan", "/login", "/search", ".pdf", ".zip", ".doc", ".jpg", ".png"]):
                continue
            # 去重
            if full in seen:
                continue
            seen.add(full)
            # anchor 文本
            anchor_text = re.sub(r"<[^>]+>", "", anchor)
            anchor_text = re.sub(r"\s+", " ", anchor_text).strip()
            if len(anchor_text) < 6:
                continue
            # 找同行/邻近日期
            # 在 anchor 周围 200 字符找日期
            idx = html.find(href)
            nearby = html[max(0, idx-200):idx+400] if idx >= 0 else ""
            pub = extract_date(nearby)
            items.append({"url": full, "title": anchor_text, "publish_time": pub})
            if len(items) >= max_items:
                break

        log.info(f"[list] ok items={len(items)}")
        return {"ok": True, "items": items, "error": ""}
    except Exception as e:
        log.exception("[list] error")
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "items": []}


@app.on_event("shutdown")
async def shutdown():
    global _crawler
    if _crawler is not None:
        await _crawler.__aexit__(None, None, None)
        _crawler = None
        log.info("crawler closed")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("CRAWLER_PORT", "8070"))
    host = os.environ.get("CRAWLER_HOST", "127.0.0.1")
    log.info(f"starting crawler service on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
