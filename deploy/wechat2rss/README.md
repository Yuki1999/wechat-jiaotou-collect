# wechat2rss 私有部署 + 党政办信息系统对接 — 运维操作手册

> 适用对象：拿到 wechat2rss 私有部署授权后，**仅在本机或单台服务器上**完成部署、订阅公众号、并把订阅同步到党政办信息跟踪与智能整理系统的运维同学。
>
> 全程约 **15–25 分钟**（含扫码登录微信号）。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Linux x86_64 / ARM64（推荐）；Apple Silicon 也可 |
| Docker | ≥ 20.10，含 `docker compose` 子命令（v2） |
| 内存 | ≥ 1 GB（容器实际占用 200–500 MB） |
| 磁盘 | ≥ 2 GB（数据卷 `./data` 会持续增长） |
| 微信号 | **专用小号 1 个**（不限 Mac/Windows/手机，任何能扫码的微信号即可） |
| wechat2rss 授权 | 已购买并收到 `LIC_EMAIL` + `LIC_CODE` 邮件 |
| 党政办信息系统 | 已 `go run .` 在 `http://127.0.0.1:8080` 跑起来 |

---

## 1. 部署 wechat2rss（一键启动）

```bash
cd /home/qqr/wechat_jiaotou_collect/deploy/wechat2rss

# 1) 准备 .env：填三项激活信息
cp .env.example .env
vim .env
# 重点改这几项：
#   LIC_EMAIL=<购买时备注的邮箱>
#   LIC_CODE=<购买后官方邮件里的激活码>
#   RSS_HOST=<服务器对外可访问的地址:端口>   例: 192.168.11.22:8080
#   RSS_TOKEN=<自己生成一段随机字符串>        建议: openssl rand -hex 16
#   HOST_PORT=8080                            如与党政办系统冲突可改 8090
#
# ⚠️ 注意端口冲突：党政办系统默认占用 8080，wechat2rss 也默认 8080。
#    建议把 HOST_PORT 改成 8090，同时把 RSS_HOST 改成 "你的地址:8090"

# 2) 启动
./deploy.sh up

# 3) 看日志，确认激活通过
./deploy.sh logs
# 出现 "Server is running at http://0.0.0.0:8080" 即成功

# 4) 健康检查
./deploy.sh status
```

正常输出：

```
== 容器 ==
NAME         IMAGE                        STATUS         PORTS
wechat2rss   ttttmr/wechat2rss:latest     Up 5 seconds   0.0.0.0:8090->8080/tcp
== 端口监听 ==
LISTEN 0  4096  *:8090
== 健康 ==
{"version":"...","build":"..."}
```

如果遇到 Docker Hub 拉镜像超时：

```bash
# 在 .env 改这个变量，使用官方备用镜像
WECHAT2RSS_IMAGE=docker.xlab.app/ttttmr/wechat2rss:latest

./deploy.sh up
```

---

## 2. 第一次进入 wechat2rss 控制台 & 扫码登录

1. 浏览器打开 `http://<RSS_HOST>` （上面 `.env` 里设的地址）
2. 登录密码就是 `.env` 里 `RSS_TOKEN` 的值
3. 进入控制台 → **账号管理 → 添加账号**
4. 用一个**专用小号**扫码登录（任何能登微信的设备都可；扫完即可关闭微信，账号会留在 wechat2rss 容器里）
5. 按提示完成"微信读书"授权（wechat2rss 通过微信读书拉公众号文章）

**风险提醒**：长期运行可能触发风控（账号被微信侧限制）。运维同学要做的：
- 千万**不要用员工的主号**或办公号
- 风控发生时账号自动解封（几小时—几天），期间 RSS 不更新但不影响系统稳定
- 若账号被永久封禁，重新扫码换一个小号即可，已订阅的公众号列表都保留

---

## 3. 添加要订阅的公众号

### 方式 A — Web 控制台（推荐给一般运维）

在浏览器控制台粘贴**任意一篇公众号文章链接**（形如 `https://mp.weixin.qq.com/s/xxxxx`），点订阅。例如想跟踪 **苏州工业园区发布**：

1. 在手机微信里关注"苏州工业园区发布"
2. 任意打开一篇文章 → 右上角 `…` → 复制链接
3. 粘贴到 wechat2rss 控制台 → 订阅

控制台会返回该公众号的 feed URL，形如：

```
http://<RSS_HOST>/feed/<sha1>.xml
```

### 方式 B — 命令行（适合一次添加多个）

```bash
./add-account.sh \
  "https://mp.weixin.qq.com/s/xxxxx-苏州工业园区发布的某文" \
  "https://mp.weixin.qq.com/s/yyyyy-园区科技的某文" \
  "https://mp.weixin.qq.com/s/zzzzz-园区招商的某文"
```

---

## 4. 把 wechat2rss 上的全部公众号一键导入党政办信息系统

这是这份脚本的**核心便利**。两条命令搞定：

```bash
# 4.1 看当前 wechat2rss 上有哪些公众号（人眼检查一下）
./fetch-feeds.sh

# 4.2 全量导入到党政办系统（默认所有 → "综合组"）
./import-to-dzb.sh
```

输出示例：

```
[1/3] 从 wechat2rss 拉取公众号清单…
[2/3] 转成党政办系统的 source 格式（filter=''）…
    → 待导入 12 条
    · 苏州工业园区发布 [公众号]              http://192.168.11.22:8090/feed/abc123…
    · 园区科技 [公众号]                       http://192.168.11.22:8090/feed/def456…
    ...
[3/3] 推送到党政办系统 http://127.0.0.1:8080/api/sources/bulk_import …
{"created": 12, "skipped": 0, "total": 12}
✓ 完成。打开党政办系统的「信息源管理」页面就能看到新增的源。
```

### 进阶用法

```bash
# 只导名字含"苏州"的，归到"招商组"由王干事负责，分类为企业类
./import-to-dzb.sh --filter 苏州 --group 招商组 --owner 王干事 --category 企业类

# 演练（不真正写入），先看看会导入什么
./import-to-dzb.sh --dry-run
```

**重复 URL 自动跳过**：脚本调用的 `/api/sources/bulk_import` 接口在党政办系统里按 URL 去重，反复执行不会产生重复条目。

---

## 5. 验证：让真实公众号文章流入党政办系统

1. 打开党政办系统 `http://127.0.0.1:8080/#/sources` — 应能看到新增的公众号信息源
2. 点 **▶ 全量采集**
3. 切到 `/#/review` — 真实公众号文章已在待审核队列

下面这条已经在演示环境跑通过（"差评"公众号）：

```
[success] 差评X.PIN（真实公众号 via wechat2rss）  found=20  new=20

样例：
[高] 山姆就食品安全问题致歉，世界杯创小红书直播在线人数记录…
[高] Dify 从被低估到成为明星项目，到底做对了什么｜42章经
```

---

## 6. 日常运维清单

| 任务 | 命令 |
|---|---|
| 启动 | `./deploy.sh up` |
| 看日志 | `./deploy.sh logs` |
| 看状态 | `./deploy.sh status` |
| 重启 | `./deploy.sh restart` |
| 停止 | `./deploy.sh down` |
| 升级镜像 | `./deploy.sh upgrade` |
| 备份数据 | `./deploy.sh backup` → `backups/yyyymmdd-HHMM.tgz` |
| 检查激活 | `./deploy.sh check` |
| 列出公众号 | `./fetch-feeds.sh` 或 `./fetch-feeds.sh --json` |
| 批量同步到党政办 | `./import-to-dzb.sh` |
| 添加新公众号 | `./add-account.sh <文章链接>` |

---

## 7. 故障排查

| 现象 | 原因 / 处置 |
|---|---|
| `docker compose pull` 卡住 | 切到 `WECHAT2RSS_IMAGE=docker.xlab.app/...`；或配置 Docker 镜像源 |
| 日志反复 `license invalid` | `.env` 里 `LIC_EMAIL` 大小写错或 `LIC_CODE` 复制有空格；改正后 `./deploy.sh restart` |
| 控制台登录提示密码错 | `.env` 里 `RSS_TOKEN` 和登录框输入不一致；或没改完 `RSS_TOKEN` 就启动了 |
| 添加公众号后一直没文章 | 账号风控中 → 控制台账号管理看状态；等几小时或换账号 |
| 党政办系统拉 feed 报错 | `curl -i "<feed_url>"` 直接测一下；常见原因是 `RSS_HOST` 填错导致 feed 内 link 指向不通 |
| `import-to-dzb.sh` 提示 `created: 0, skipped: N` | URL 已存在，正常；想强制重导先在党政办系统里手动删旧条目 |

---

## 8. 安全建议

- `.env` 文件含激活码 + Token，**不要提交到 git**、不要外泄
- 公网访问 wechat2rss 时务必加反向代理 + HTTPS（Nginx / Caddy），不要把 8080 直接暴露
- 党政办系统当前 demo 未启用鉴权，正式上线前在 reverse proxy 层加 basic auth 或对接企微 OAuth
- 定期 `./deploy.sh backup`，至少每周一次

---

## 9. 文件清单

```
deploy/wechat2rss/
├── docker-compose.yml      # Docker Compose 配置（已按本项目模板化）
├── .env.example            # 环境变量模板（复制为 .env 后填写）
├── deploy.sh               # 一键 up/down/logs/upgrade/backup/check
├── fetch-feeds.sh          # 列出 wechat2rss 上已订阅的全部公众号
├── add-account.sh          # 通过文章链接批量添加订阅
├── import-to-dzb.sh        # 把 wechat2rss feeds 同步到党政办系统
└── README.md               # 本文件
```

---

## 10. 一张图回顾整条数据链路

```
   微信公众号原文
        │
        ▼  (wechat2rss 用授权微信号 + 微信读书接口拉取)
  wechat2rss 服务 (Docker, 本地)
        │  /feed/<sha1>.xml  (标准 RSS 2.0)
        ▼
   import-to-dzb.sh  →  /api/sources/bulk_import
        │
        ▼
 党政办信息系统 [信息源管理]
        │  ▶ 全量采集
        ▼
 标准化 → AI 整理 → 待审核队列 → 简报 → 企微推送
```

整条链路与 **苏州工业园区管委会官网 HTML 抓取** 复用同一套审核 / 简报 / 推送流水线——对业务侧而言完全透明。
