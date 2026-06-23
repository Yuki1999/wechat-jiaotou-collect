package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed index.html static/*
var assets embed.FS

// ===================== 数据模型 =====================

type User struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group"`
	Role  string `json:"role"`
}

type Source struct {
	ID          int       `json:"id"`
	Unit        string    `json:"unit"`
	Category    string    `json:"category"`
	Type        string    `json:"type"` // website / wechat / rss / wechat2rss
	Kind        string    `json:"kind"` // html_list / rss  —— 决定采集器
	URL         string    `json:"url"`
	Frequency   string    `json:"frequency"`
	OwnerID     int       `json:"owner_id"`
	OwnerName   string    `json:"owner_name"`
	Group       string    `json:"group"`
	Active      bool      `json:"active"`
	Authorized  bool      `json:"authorized"`
	LastSuccess time.Time `json:"last_success"`
	FailCount   int       `json:"fail_count"`
	CreatedAt   time.Time `json:"created_at"`
}

type Article struct {
	ID            int       `json:"id"`
	SourceID      int       `json:"source_id"`
	Unit          string    `json:"unit"`
	SourceType    string    `json:"source_type"`
	Title         string    `json:"title"`
	Content       string    `json:"content"`
	URL           string    `json:"url"`
	PublishTime   time.Time `json:"publish_time"`
	FetchTime     time.Time `json:"fetch_time"`
	ContentHash   string    `json:"content_hash"`
	Status        string    `json:"status"`
	Importance    string    `json:"importance"`
	Category      string    `json:"category"`
	Summary       string    `json:"summary"`
	LeaderSummary string    `json:"leader_summary"`
	DetailSummary string    `json:"detail_summary"`
	Keywords      []string  `json:"keywords"`
	Topics        []string  `json:"topics"`
	Confidence    float64   `json:"confidence"`
	AIEngine      string    `json:"ai_engine"` // deepseek-v4-pro / rule / ""
	Evidence      string    `json:"evidence"`
	DuplicateOf   int       `json:"duplicate_of,omitempty"`
	OwnerID       int       `json:"owner_id"`
	OwnerName     string    `json:"owner_name"`
	Group         string    `json:"group"`
}

type ReviewLog struct {
	ID         int       `json:"id"`
	ArticleID  int       `json:"article_id"`
	Reviewer   string    `json:"reviewer"`
	Action     string    `json:"action"`
	Before     string    `json:"before"`
	After      string    `json:"after"`
	Note       string    `json:"note"`
	OccurredAt time.Time `json:"occurred_at"`
}

type Brief struct {
	ID          int       `json:"id"`
	Type        string    `json:"type"`
	Period      string    `json:"period"`
	Title       string    `json:"title"`
	Status      string    `json:"status"`
	ArticleIDs  []int     `json:"article_ids"`
	Editor      string    `json:"editor"`
	CreatedAt   time.Time `json:"created_at"`
	PublishedAt time.Time `json:"published_at,omitempty"`
}

type PushLog struct {
	ID         int       `json:"id"`
	Channel    string    `json:"channel"`
	Target     string    `json:"target"`
	Subject    string    `json:"subject"`
	BriefID    int       `json:"brief_id,omitempty"`
	ArticleID  int       `json:"article_id,omitempty"`
	Status     string    `json:"status"`
	ReturnCode string    `json:"return_code"`
	OccurredAt time.Time `json:"occurred_at"`
}

type TaskRun struct {
	ID         int       `json:"id"`
	SourceID   int       `json:"source_id"`
	Unit       string    `json:"unit"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Status     string    `json:"status"`
	Found      int       `json:"found"`
	NewItems   int       `json:"new_items"`
	Error      string    `json:"error,omitempty"`
}

// ===================== Store =====================

type Store struct {
	mu       sync.RWMutex
	Users    []User         `json:"users"`
	Sources  []Source       `json:"sources"`
	Articles []Article      `json:"articles"`
	Reviews  []ReviewLog    `json:"reviews"`
	Briefs   []Brief        `json:"briefs"`
	Pushes   []PushLog      `json:"pushes"`
	Tasks    []TaskRun      `json:"tasks"`
	NextIDs  map[string]int `json:"next_ids"`
}

func (s *Store) nextID(k string) int {
	if s.NextIDs == nil {
		s.NextIDs = map[string]int{}
	}
	s.NextIDs[k]++
	return s.NextIDs[k]
}

const dataFile = "data.json"

// save 必须在调用方已经持有锁（或不在锁内）的前提下调用：
// 它自身不再获取锁，避免与外层 Lock 形成死锁。调用顺序约定：
//   store.mu.Lock(); ...修改...; store.mu.Unlock(); store.save()
func (s *Store) save() {
	b, _ := json.MarshalIndent(s, "", "  ")
	_ = os.WriteFile(dataFile, b, 0644)
}

func loadStore() *Store {
	s := &Store{NextIDs: map[string]int{}}
	if b, err := os.ReadFile(dataFile); err == nil {
		_ = json.Unmarshal(b, s)
		if s.NextIDs == nil {
			s.NextIDs = map[string]int{}
		}
		return s
	}
	seed(s)
	s.save()
	return s
}

// ===================== 种子数据（真实信息源） =====================
// 接入苏州工业园区管理委员会官网 5 个真实栏目（HTML 抓取）。
// 同时预留两条 RSS / wechat2rss 占位条目（默认停用，部署 wechat2rss 后填入 URL 即可启用）。

func seed(s *Store) {
	users := []User{
		{Name: `张主任`, Group: `综合组`, Role: "leader"},
		{Name: `李审核`, Group: `综合组`, Role: "reviewer"},
		{Name: `王干事`, Group: `招商组`, Role: "staff"},
		{Name: `赵干事`, Group: `综合组`, Role: "staff"},
		{Name: `陈干事`, Group: `专题组`, Role: "staff"},
		{Name: `管理员`, Group: `运维组`, Role: "admin"},
	}
	for i := range users {
		users[i].ID = s.nextID("user")
	}
	s.Users = users

	sources := []Source{
		{
			Unit: `苏州工业园区管委会 · 园区要闻`, Category: `部门类`,
			Type: "website", Kind: "html_list",
			URL:       "https://www.sipac.gov.cn/szgyyq/zwyw/xwzx_list.shtml",
			Frequency: "daily", OwnerName: `赵干事`, Group: `综合组`,
			Active: true, Authorized: true,
		},
		{
			Unit: `苏州工业园区管委会 · 即时动态`, Category: `部门类`,
			Type: "website", Kind: "html_list",
			URL:       "https://www.sipac.gov.cn/szgyyq/jsdt/xwzx_list.shtml",
			Frequency: "4h", OwnerName: `赵干事`, Group: `综合组`,
			Active: true, Authorized: true,
		},
		{
			Unit: `苏州工业园区管委会 · 政声传递`, Category: `部门类`,
			Type: "website", Kind: "html_list",
			URL:       "https://www.sipac.gov.cn/szgyyq/zscd/zscd_list.shtml",
			Frequency: "daily", OwnerName: `陈干事`, Group: `专题组`,
			Active: false, // 该栏目列表为 JS 动态加载，静态抓取拿不到，先停用
		},
		{
			Unit: `苏州工业园区管委会 · 媒体聚焦`, Category: `专题类`,
			Type: "website", Kind: "html_list",
			URL:       "https://www.sipac.gov.cn/szgyyq/mtjj/xwzx_list.shtml",
			Frequency: "daily", OwnerName: `陈干事`, Group: `专题组`,
			Active: true, Authorized: true,
		},
		{
			Unit: `苏州工业园区 · 园区公告`, Category: `部门类`,
			Type: "website", Kind: "html_list",
			URL:       "https://www.sipac.gov.cn/szgyyq/ggxxs/common_list3.shtml",
			Frequency: "daily", OwnerName: `赵干事`, Group: `综合组`,
			Active: true, Authorized: true,
		},
		// 占位：wechat2rss（用户部署后改 URL 并启用）。kind=rss 直接走标准 RSS 解析器
		{
			Unit: `[占位] wechat2rss · 苏州工业园区发布（公众号）`, Category: `企业类`,
			Type: "wechat2rss", Kind: "rss",
			URL:       "http://127.0.0.1:8090/feed/REPLACE_WITH_FEED_SHA1.xml",
			Frequency: "daily", OwnerName: `王干事`, Group: `招商组`,
			Active: false, Authorized: false,
		},
		{
			Unit: `[占位] RSS · 通用订阅`, Category: `专题类`,
			Type: "rss", Kind: "rss",
			URL:       "https://example.com/feed.xml",
			Frequency: "daily", OwnerName: `陈干事`, Group: `专题组`,
			Active: false, Authorized: false,
		},
	}
	now := time.Now()
	for i := range sources {
		sources[i].ID = s.nextID("source")
		sources[i].OwnerID = (i % 3) + 3
		sources[i].CreatedAt = now.Add(-72 * time.Hour)
	}
	s.Sources = sources

	// 不再预置假文章——首次启动后用户在 UI 点"全量采集"即拉真实数据。
	// 预置一份周报作为模板示意（不含条目），以便 UI 展示。
	bid := s.nextID("brief")
	s.Briefs = append(s.Briefs, Brief{
		ID:         bid,
		Type:       "weekly",
		Period:     fmt.Sprintf("%s 第%d周", now.Format("2006"), weekOfYear(now.Add(-7*24*time.Hour))),
		Title:      `党政办信息周报（模板）`,
		Status:     "draft",
		ArticleIDs: []int{},
		Editor:     `李审核`,
		CreatedAt:  now.Add(-24 * time.Hour),
	})
}

func weekOfYear(t time.Time) int {
	_, w := t.ISOWeek()
	return w
}

// ===================== 真实采集器 =====================

var httpClient = &http.Client{
	Timeout: 15 * time.Second,
}

const userAgent = "Mozilla/5.0 (compatible; DZB-InfoTracker/1.0; +http://localhost)"

// httpGet 拉取页面，自动按响应头解码 UTF-8（默认假定 UTF-8；
// 苏州工业园区站点已确认为 UTF-8）。
func httpGet(ctx context.Context, target string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ----- HTML 列表 / 详情解析 -----

var (
	reLI         = regexp.MustCompile(`(?s)<li[^>]*>(.*?)</li>`)
	reLinkInLi   = regexp.MustCompile(`(?s)<a[^>]+href="([^"]+\.shtml)"[^>]*>(.*?)</a>`)
	reDate       = regexp.MustCompile(`(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)`)
	reTags       = regexp.MustCompile(`<[^>]+>`)
	reSpace      = regexp.MustCompile(`\s+`)
	reMetaTitle  = regexp.MustCompile(`(?i)<meta\s+name="ArticleTitle"\s+content="([^"]+)"`)
	reMetaPub    = regexp.MustCompile(`(?i)<meta\s+name="PubDate"\s+content="([^"]+)"`)
	reUCAPTITLE  = regexp.MustCompile(`(?s)<UCAPTITLE[^>]*>(.*?)</UCAPTITLE>`)
	reH1         = regexp.MustCompile(`(?s)<h1[^>]*>(.*?)</h1>`)
	reTitle      = regexp.MustCompile(`(?s)<title[^>]*>(.*?)</title>`)
	// 正文容器开始标签：苏州工业园区站点 id="zoomcon" / class="article-content"
	reZoomConStart    = regexp.MustCompile(`(?si)<div[^>]*id="zoomcon"[^>]*>`)
	reArticleConStart = regexp.MustCompile(`(?si)<div[^>]*class="[^"]*article-content[^"]*"[^>]*>`)
	reTRSEditorStart  = regexp.MustCompile(`(?si)<div[^>]*class="[^"]*TRS_Editor[^"]*"[^>]*>`)
	reDivTag          = regexp.MustCompile(`(?i)<(/?)div\b[^>]*>`)
	reScript          = regexp.MustCompile(`(?s)<script.*?</script>`)
	reStyle           = regexp.MustCompile(`(?s)<style.*?</style>`)
	reMetaJunk        = regexp.MustCompile(`时间[：:][\s\S]{0,40}?(?:浏览量|来源|字号)[\s\S]{0,40}?(?:大|中|小)`)
)

// extractDivBlock 从 html[startTagEnd:] 开始，按 <div>/</div> 配对计数，找到对应的关闭 div，
// 返回标签内的内容（不含起始与结束 div 自身）。
func extractDivBlock(html string, startTagEnd int) string {
	depth := 1
	i := startTagEnd
	for {
		loc := reDivTag.FindStringSubmatchIndex(html[i:])
		if loc == nil {
			return html[startTagEnd:]
		}
		mStart := i + loc[0]
		mEnd := i + loc[1]
		// loc[2..3] 对应 group 1（"/" 或 ""）
		if loc[2] >= 0 && html[i+loc[2]:i+loc[3]] == "/" {
			depth--
			if depth == 0 {
				return html[startTagEnd:mStart]
			}
		} else {
			depth++
		}
		i = mEnd
	}
}

type listItem struct {
	URL       string
	Title     string
	Published time.Time
}

// parseListPage 抽取通用列表项：从 <li> 节点找 a + 日期，对苏州工业园区站点已实测可用。
func parseListPage(base, html string) []listItem {
	out := []listItem{}
	for _, m := range reLI.FindAllStringSubmatch(html, -1) {
		li := m[1]
		am := reLinkInLi.FindStringSubmatch(li)
		if am == nil {
			continue
		}
		href := strings.TrimSpace(am[1])
		title := cleanText(am[2])
		if len(title) < 6 {
			continue
		}
		// 排除导航/语种/栏目首页
		if strings.HasSuffix(href, "/index.shtml") ||
			strings.Contains(href, "_list.shtml") ||
			strings.Contains(href, "/szgyyqenglish") ||
			strings.Contains(href, "/szgyyjapan") {
			continue
		}
		// 必须有日期
		dm := reDate.FindStringSubmatch(li)
		if dm == nil {
			continue
		}
		t := parseFlexibleTime(dm[1])
		if t.IsZero() {
			continue
		}
		full, _ := absoluteURL(base, href)
		out = append(out, listItem{URL: full, Title: title, Published: t})
	}
	return out
}

func absoluteURL(base, ref string) (string, error) {
	bu, err := url.Parse(base)
	if err != nil {
		return ref, err
	}
	ru, err := url.Parse(ref)
	if err != nil {
		return ref, err
	}
	return bu.ResolveReference(ru).String(), nil
}

// parseDetailPage 抽取标题/正文/发布时间。
func parseDetailPage(html string) (title, content string, published time.Time) {
	// 标题：优先 meta，再 UCAPTITLE / h1 / title
	if m := reMetaTitle.FindStringSubmatch(html); m != nil {
		title = cleanText(m[1])
	} else if m := reUCAPTITLE.FindStringSubmatch(html); m != nil {
		title = cleanText(m[1])
	} else if m := reH1.FindStringSubmatch(html); m != nil {
		title = cleanText(m[1])
	} else if m := reTitle.FindStringSubmatch(html); m != nil {
		title = cleanText(m[1])
	}
	// 正文容器：按"开始标签 + div 配对计数"切出
	body := ""
	for _, re := range []*regexp.Regexp{reZoomConStart, reArticleConStart, reTRSEditorStart} {
		if loc := re.FindStringIndex(html); loc != nil {
			body = extractDivBlock(html, loc[1])
			break
		}
	}
	if body == "" {
		body = html
	}
	body = reScript.ReplaceAllString(body, "")
	body = reStyle.ReplaceAllString(body, "")
	body = reTags.ReplaceAllString(body, " ")
	body = htmlEntityDecode(body)
	body = reMetaJunk.ReplaceAllString(body, " ") // 清掉"时间:.. 浏览量:.. 字号: 大中小"页眉
	content = cleanText(body)

	// 发布时间：优先 meta PubDate
	if m := reMetaPub.FindStringSubmatch(html); m != nil {
		if t := parseFlexibleTime(m[1]); !t.IsZero() {
			published = t
			return
		}
	}
	if dm := reDate.FindStringSubmatch(html); dm != nil {
		published = parseFlexibleTime(dm[1])
	}
	return
}

func cleanText(s string) string {
	s = htmlEntityDecode(s)
	s = reTags.ReplaceAllString(s, "")
	s = reSpace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func htmlEntityDecode(s string) string {
	r := strings.NewReplacer(
		"&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">",
		"&quot;", `"`, "&#39;", "'", "&apos;", "'", "&middot;", "·",
		"&hellip;", "…", "&ldquo;", `"`, "&rdquo;", `"`,
	)
	return r.Replace(s)
}

func parseFlexibleTime(s string) time.Time {
	s = strings.TrimSpace(s)
	s = strings.NewReplacer("/", "-", ".", "-").Replace(s)
	layouts := []string{
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
		"2006-1-2 15:04",
		"2006-1-2",
	}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	if loc == nil {
		loc = time.Local
	}
	for _, l := range layouts {
		if t, err := time.ParseInLocation(l, s, loc); err == nil {
			return t
		}
	}
	return time.Time{}
}

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:16]
}

// ----- RSS / Atom 解析（用于 wechat2rss 与通用 RSS） -----

type rssDoc struct {
	XMLName xml.Name `xml:"rss"`
	Channel struct {
		Title string    `xml:"title"`
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
}
type rssItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	Encoded     string `xml:"http://purl.org/rss/1.0/modules/content/ encoded"`
	PubDate     string `xml:"pubDate"`
	GUID        string `xml:"guid"`
}
type atomDoc struct {
	XMLName xml.Name    `xml:"feed"`
	Title   string      `xml:"title"`
	Entries []atomEntry `xml:"entry"`
}
type atomEntry struct {
	Title   string `xml:"title"`
	Updated string `xml:"updated"`
	ID      string `xml:"id"`
	Links   []struct {
		Href string `xml:"href,attr"`
		Rel  string `xml:"rel,attr"`
	} `xml:"link"`
	Summary string `xml:"summary"`
	Content string `xml:"content"`
}

type feedItem struct {
	Title     string
	URL       string
	Content   string
	Published time.Time
}

func parseFeed(body string) ([]feedItem, error) {
	bs := []byte(body)
	if strings.Contains(body, "<rss") || strings.Contains(body, "<channel") {
		var d rssDoc
		if err := xml.Unmarshal(bs, &d); err != nil {
			return nil, err
		}
		out := make([]feedItem, 0, len(d.Channel.Items))
		for _, it := range d.Channel.Items {
			body := it.Encoded
			if body == "" {
				body = it.Description
			}
			t := parseFeedTime(it.PubDate)
			out = append(out, feedItem{
				Title: cleanText(it.Title), URL: strings.TrimSpace(it.Link),
				Content: cleanText(body), Published: t,
			})
		}
		return out, nil
	}
	var d atomDoc
	if err := xml.Unmarshal(bs, &d); err != nil {
		return nil, err
	}
	out := make([]feedItem, 0, len(d.Entries))
	for _, e := range d.Entries {
		link := ""
		for _, l := range e.Links {
			if l.Rel == "alternate" || l.Rel == "" {
				link = l.Href
				break
			}
		}
		body := e.Content
		if body == "" {
			body = e.Summary
		}
		out = append(out, feedItem{
			Title: cleanText(e.Title), URL: link,
			Content: cleanText(body), Published: parseFeedTime(e.Updated),
		})
	}
	return out, nil
}

func parseFeedTime(s string) time.Time {
	s = strings.TrimSpace(s)
	for _, l := range []string{
		time.RFC1123Z, time.RFC1123, time.RFC3339, time.RFC822Z, time.RFC822,
		"2006-01-02T15:04:05Z07:00", "Mon, 2 Jan 2006 15:04:05 -0700",
	} {
		if t, err := time.Parse(l, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// ===================== 通用采集微服务 (crawl4ai) =====================
//
// 通过环境变量 CRAWLER_BASE 配置 Python 采集微服务地址，默认 http://127.0.0.1:8070
// 微服务不可达时，collectHTML 自动降级到原有正则解析，不影响业务。

var crawlerBase = "http://127.0.0.1:8070"

func init() {
	if v := os.Getenv("CRAWLER_BASE"); v != "" {
		crawlerBase = strings.TrimRight(v, "/")
	}
}

// crawlerHealth 探测微服务是否在线
func crawlerHealth() bool {
	resp, err := httpClient.Get(crawlerBase + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// crawlerDetail 调用 Python 微服务抓单页详情
type crawlerDetailResult struct {
	OK             bool   `json:"ok"`
	Error          string `json:"error"`
	Title          string `json:"title"`
	ContentText    string `json:"content_text"`
	ContentMarkdn  string `json:"content_markdown"`
	PublishTime    string `json:"publish_time"`
}

func crawlerDetail(ctx context.Context, target string) (*crawlerDetailResult, error) {
	body, _ := json.Marshal(map[string]string{"url": target})
	req, err := http.NewRequestWithContext(ctx, "POST", crawlerBase+"/crawl_detail", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("crawler HTTP %d", resp.StatusCode)
	}
	var r crawlerDetailResult
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

// crawlerListItem 列表页条目
type crawlerListItem struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	PublishTime string `json:"publish_time"`
}
type crawlerListResult struct {
	OK    bool              `json:"ok"`
	Error string            `json:"error"`
	Items []crawlerListItem `json:"items"`
}

func crawlerList(ctx context.Context, target string, max int) (*crawlerListResult, error) {
	body, _ := json.Marshal(map[string]interface{}{"url": target, "max": max})
	req, err := http.NewRequestWithContext(ctx, "POST", crawlerBase+"/crawl_list", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("crawler HTTP %d", resp.StatusCode)
	}
	var r crawlerListResult
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ----- 任务执行 -----

// 把 frequency 字段（"4h" / "daily" / "weekly" / "1h" 等）解析为时间间隔。
// 无法识别的值回退到 24 小时。
func frequencyInterval(freq string) time.Duration {
	switch strings.TrimSpace(strings.ToLower(freq)) {
	case "", "daily":
		return 24 * time.Hour
	case "weekly":
		return 7 * 24 * time.Hour
	case "hourly":
		return time.Hour
	case "4h":
		return 4 * time.Hour
	case "1h":
		return time.Hour
	case "30m":
		return 30 * time.Minute
	}
	// 兜底：尝试 Go 时长解析，如 "2h30m"
	if d, err := time.ParseDuration(freq); err == nil && d > 0 {
		return d
	}
	return 24 * time.Hour
}

// schedulerLoop 在后台 goroutine 中长驻，每分钟扫一次，
// 对所有 Active 且距离上次成功超过 frequency 的源串行触发采集。
// 失败的源采用指数退避：失败次数 N 次 → 至少等待 N × frequency 再重试，封顶 24h。
func schedulerLoop() {
	// 启动后稍等一下再开始，避免与冷启动其他初始化抢资源
	time.Sleep(30 * time.Second)
	log.Println("[scheduler] started, tick = 1m")
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for {
		runSchedulerTick()
		<-ticker.C
	}
}

func runSchedulerTick() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[scheduler] panic recovered: %v", r)
		}
	}()
	now := time.Now()
	// 复制一份 ID 列表，避免长时间持锁阻塞 API
	store.mu.RLock()
	type todo struct {
		idx     int
		id      int
		unit    string
		nextDue time.Time
	}
	candidates := make([]todo, 0, len(store.Sources))
	for i, s := range store.Sources {
		if !s.Active {
			continue
		}
		interval := frequencyInterval(s.Frequency)
		// 失败时退避：fail_count 越高，间隔越长（最多 24h）
		if s.FailCount > 0 {
			backoff := time.Duration(s.FailCount) * interval
			if backoff > 24*time.Hour {
				backoff = 24 * time.Hour
			}
			interval = backoff
		}
		var due time.Time
		if s.LastSuccess.IsZero() {
			// 从未成功过：立刻视为到期（但只在第一次 tick 时跑一次，避免连失败洗屏）
			due = now.Add(-time.Second)
		} else {
			due = s.LastSuccess.Add(interval)
		}
		if !due.After(now) {
			candidates = append(candidates, todo{i, s.ID, s.Unit, due})
		}
	}
	store.mu.RUnlock()

	if len(candidates) == 0 {
		return
	}
	log.Printf("[scheduler] %d source(s) due, running serially", len(candidates))
	for _, c := range candidates {
		store.mu.Lock()
		// 取索引可能因外部修改而无效，重新查找
		var src *Source
		for i := range store.Sources {
			if store.Sources[i].ID == c.id {
				src = &store.Sources[i]
				break
			}
		}
		if src == nil || !src.Active {
			store.mu.Unlock()
			continue
		}
		tr := runOneCollect(store, src)
		store.Tasks = append(store.Tasks, tr)
		store.mu.Unlock()
		store.save()
		log.Printf("[scheduler] %s → %s (found=%d new=%d)", c.unit, tr.Status, tr.Found, tr.NewItems)
		// 礼貌停顿，避免对同一目标站短时间内打太密
		time.Sleep(1 * time.Second)
	}
}

func runOneCollect(s *Store, src *Source) TaskRun {
	now := time.Now()
	tr := TaskRun{
		ID: s.nextID("task"), SourceID: src.ID, Unit: src.Unit, StartedAt: now, Status: "success",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	switch src.Kind {
	case "rss":
		return collectRSS(ctx, s, src, tr)
	case "html_list", "":
		return collectHTML(ctx, s, src, tr)
	default:
		tr.Status = "fail"
		tr.Error = "未知采集器类型: " + src.Kind
		tr.FinishedAt = time.Now()
		return tr
	}
}

func collectHTML(ctx context.Context, s *Store, src *Source, tr TaskRun) TaskRun {
	// 优先走 crawl4ai 通用采集微服务
	if crawlerHealth() {
		tr2 := collectHTMLViaCrawler(ctx, s, src, tr)
		if tr2.Status == "success" {
			return tr2
		}
		// 微服务跑失败 → 降级到原正则，并把微服务错误记到日志
		log.Printf("[collect] crawler service failed for %s: %s, falling back to regex", src.Unit, tr2.Error)
		if tr2.Error != "" {
			// 不直接返回，继续走下面原逻辑
		}
	}
	return collectHTMLRegex(ctx, s, src, tr)
}

// collectHTMLViaCrawler 走 Python crawl4ai 微服务的实现
func collectHTMLViaCrawler(ctx context.Context, s *Store, src *Source, tr TaskRun) TaskRun {
	listRes, err := crawlerList(ctx, src.URL, 15)
	if err != nil {
		return failTask(s, src, tr, "crawler /crawl_list 调用失败: "+err.Error())
	}
	if !listRes.OK {
		return failTask(s, src, tr, "crawler 列表页抓取失败: "+listRes.Error)
	}
	tr.Found = len(listRes.Items)
	if len(listRes.Items) == 0 {
		return failTask(s, src, tr, "列表页未解析到条目（页面结构可能变化）")
	}
	known := map[string]bool{}
	for _, a := range s.Articles {
		known[a.URL] = true
	}
	newCount := 0
	for _, it := range listRes.Items {
		if known[it.URL] {
			continue
		}
		detail, err := crawlerDetail(ctx, it.URL)
		if err != nil || !detail.OK {
			continue
		}
		title := detail.Title
		if title == "" {
			title = it.Title
		}
		content := detail.ContentText
		if len([]rune(content)) < 30 {
			continue
		}
		pub := parseFlexibleTime(detail.PublishTime)
		if pub.IsZero() {
			pub = parseFlexibleTime(it.PublishTime)
		}
		a := Article{
			ID: s.nextID("article"), SourceID: src.ID, Unit: src.Unit, SourceType: src.Type,
			Title: title, Content: content, URL: it.URL,
			PublishTime: pub, FetchTime: time.Now(),
			ContentHash: sha256hex(title + content),
			Status:      "collected", Category: src.Category,
			OwnerID: src.OwnerID, OwnerName: src.OwnerName, Group: src.Group,
		}
		runOneAI(&a)
		s.Articles = append(s.Articles, a)
		newCount++
	}
	tr.NewItems = newCount
	tr.FinishedAt = time.Now()
	src.LastSuccess = time.Now()
	src.FailCount = 0
	return tr
}

// collectHTMLRegex 原有正则解析实现（保留作为 fallback）
func collectHTMLRegex(ctx context.Context, s *Store, src *Source, tr TaskRun) TaskRun {
	listHTML, err := httpGet(ctx, src.URL)
	if err != nil {
		return failTask(s, src, tr, "列表页抓取失败: "+err.Error())
	}
	items := parseListPage(src.URL, listHTML)
	tr.Found = len(items)
	if len(items) == 0 {
		return failTask(s, src, tr, "列表页未解析到条目（页面结构可能变化）")
	}
	// 已知 URL 集合（去重）
	known := map[string]bool{}
	for _, a := range s.Articles {
		known[a.URL] = true
	}
	newCount := 0
	for i, it := range items {
		if i >= 8 { // 单次最多取前 8 条，避免一次抓太多
			break
		}
		if known[it.URL] {
			continue
		}
		detailHTML, err := httpGet(ctx, it.URL)
		if err != nil {
			continue
		}
		title, content, pub := parseDetailPage(detailHTML)
		if title == "" {
			title = it.Title
		}
		if pub.IsZero() {
			pub = it.Published
		}
		if len([]rune(content)) < 30 {
			continue
		}
		a := Article{
			ID: s.nextID("article"), SourceID: src.ID, Unit: src.Unit, SourceType: src.Type,
			Title: title, Content: content, URL: it.URL,
			PublishTime: pub, FetchTime: time.Now(),
			ContentHash: sha256hex(title + content),
			Status:      "collected", Category: src.Category,
			OwnerID: src.OwnerID, OwnerName: src.OwnerName, Group: src.Group,
		}
		runOneAI(&a)
		s.Articles = append(s.Articles, a)
		newCount++
	}
	tr.NewItems = newCount
	tr.FinishedAt = time.Now()
	src.LastSuccess = time.Now()
	src.FailCount = 0
	return tr
}

func collectRSS(ctx context.Context, s *Store, src *Source, tr TaskRun) TaskRun {
	body, err := httpGet(ctx, src.URL)
	if err != nil {
		return failTask(s, src, tr, "RSS 抓取失败: "+err.Error())
	}
	items, err := parseFeed(body)
	if err != nil {
		return failTask(s, src, tr, "RSS 解析失败: "+err.Error())
	}
	tr.Found = len(items)
	known := map[string]bool{}
	for _, a := range s.Articles {
		known[a.URL] = true
	}
	newCount := 0
	for _, it := range items {
		if known[it.URL] {
			continue
		}
		if len([]rune(it.Content)) < 30 {
			continue
		}
		pub := it.Published
		if pub.IsZero() {
			pub = time.Now()
		}
		a := Article{
			ID: s.nextID("article"), SourceID: src.ID, Unit: src.Unit, SourceType: src.Type,
			Title: it.Title, Content: it.Content, URL: it.URL,
			PublishTime: pub, FetchTime: time.Now(),
			ContentHash: sha256hex(it.Title + it.Content),
			Status:      "collected", Category: src.Category,
			OwnerID: src.OwnerID, OwnerName: src.OwnerName, Group: src.Group,
		}
		runOneAI(&a)
		s.Articles = append(s.Articles, a)
		newCount++
	}
	tr.NewItems = newCount
	tr.FinishedAt = time.Now()
	src.LastSuccess = time.Now()
	src.FailCount = 0
	return tr
}

func failTask(s *Store, src *Source, tr TaskRun, msg string) TaskRun {
	tr.Status = "fail"
	tr.Error = msg
	tr.FinishedAt = time.Now()
	src.FailCount++
	return tr
}

// ===================== AI 整理 =====================

// DeepSeek 配置（通过环境变量传入）：
//   DEEPSEEK_API_KEY  必填，签发于 platform.deepseek.com
//   DEEPSEEK_MODEL    可选，默认 deepseek-v4-pro
//   DEEPSEEK_BASE     可选，默认 https://api.deepseek.com
// 未配置 key 时所有调用自动降级到本地规则引擎。
var (
	deepseekKey   = ""
	deepseekModel = "deepseek-v4-pro"
	deepseekBase  = "https://api.deepseek.com"
)

func loadAIConfig() {
	deepseekKey = strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY"))
	if v := strings.TrimSpace(os.Getenv("DEEPSEEK_MODEL")); v != "" {
		deepseekModel = v
	}
	if v := strings.TrimSpace(os.Getenv("DEEPSEEK_BASE")); v != "" {
		deepseekBase = strings.TrimRight(v, "/")
	}
	if deepseekKey == "" {
		log.Printf("[ai] DEEPSEEK_API_KEY 未设置，AI 整理将使用本地规则引擎")
	} else {
		log.Printf("[ai] DeepSeek 已启用: model=%s base=%s", deepseekModel, deepseekBase)
	}
}

// deepseekAIResult 期望大模型返回的 JSON 结构
type deepseekAIResult struct {
	Summary       string   `json:"summary"`
	LeaderSummary string   `json:"leader_summary"`
	DetailSummary string   `json:"detail_summary"`
	Importance    string   `json:"importance"`
	Category      string   `json:"category"`
	Keywords      []string `json:"keywords"`
}

// runOneAI 主入口：优先调 DeepSeek（含 1 次重试），失败降级到本地规则。
// 单文章处理，调用方负责并发控制。
func runOneAI(a *Article) {
	if len([]rune(a.Content)) < 30 {
		a.Status = "failed"
		return
	}
	if deepseekKey != "" {
		var lastErr error
		for attempt := 0; attempt < 2; attempt++ {
			if err := runOneAIDeepSeek(a); err == nil {
				a.AIEngine = deepseekModel
				a.Status = "pending_review"
				return
			} else {
				lastErr = err
				// 第 1 次失败时短暂等待再重试（DeepSeek 偶发 empty content）
				if attempt == 0 {
					time.Sleep(1500 * time.Millisecond)
				}
			}
		}
		log.Printf("[ai] DeepSeek failed (after retry) for article id=%d: %v, falling back to rule", a.ID, lastErr)
	}
	runOneAIRule(a)
	a.AIEngine = "rule"
	a.Status = "pending_review"
}

// runOneAIDeepSeek 调 DeepSeek 一次拿全 6 个字段
func runOneAIDeepSeek(a *Article) error {
	// 截断超长正文，避免 token 爆炸
	content := a.Content
	if len([]rune(content)) > 3000 {
		r := []rune(content)
		content = string(r[:3000]) + "…"
	}
	prompt := fmt.Sprintf(`你是党政办的资深信息员，负责给主任简报整理内容。请阅读下面这篇文章，严格按 JSON 格式输出 6 个字段。

判定标准：
- 重要性=高：营商环境、重大项目、招商签约、专精特新、常委会决策、自贸区、生物医药、人工智能、领导调研部署
- 重要性=中：推进会、印发文件、调研走访、专题检查
- 重要性=低：常规活动、节日宣传、一般动态
- 分类只能选 1 个：营商环境、招商引资、重点企业、产业创新、经济运行、民生关注、涉外开放、其他

请只输出 JSON，字段：
{
  "summary": "一句话摘要，60 字内，给同事快速浏览",
  "leader_summary": "领导阅览摘要，110 字内，给主任看",
  "detail_summary": "详细摘要，200 字内，给上报材料用",
  "importance": "高/中/低",
  "category": "上述 8 类之一",
  "keywords": ["关键词1", "关键词2", "最多6个"]
}

文章标题：%s
单位：%s
正文：%s`, a.Title, a.Unit, content)

	body, _ := json.Marshal(map[string]interface{}{
		"model": deepseekModel,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0.3,
		"max_tokens":      2000,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", deepseekBase+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+deepseekKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 35 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, trunc(string(respBody), 200))
	}

	var apiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return fmt.Errorf("parse api response: %w", err)
	}
	if apiResp.Error.Message != "" {
		return fmt.Errorf("api error: %s", apiResp.Error.Message)
	}
	if len(apiResp.Choices) == 0 {
		return fmt.Errorf("empty choices")
	}
	raw := apiResp.Choices[0].Message.Content
	if raw == "" {
		return fmt.Errorf("empty content")
	}

	var r deepseekAIResult
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		// 部分模型会带 markdown 包裹，去掉 ```json ... ``` 再试
		raw2 := strings.TrimSpace(raw)
		raw2 = strings.TrimPrefix(raw2, "```json")
		raw2 = strings.TrimPrefix(raw2, "```")
		raw2 = strings.TrimSuffix(raw2, "```")
		raw2 = strings.TrimSpace(raw2)
		if err2 := json.Unmarshal([]byte(raw2), &r); err2 != nil {
			return fmt.Errorf("parse json: %w (raw=%s)", err, trunc(raw, 200))
		}
	}

	// 字段校验 + 装回文章
	imp := strings.TrimSpace(r.Importance)
	if imp != "高" && imp != "中" && imp != "低" {
		imp = "中"
	}
	a.Importance = imp
	a.Summary = trunc(strings.TrimSpace(r.Summary), 80)
	a.LeaderSummary = trunc(strings.TrimSpace(r.LeaderSummary), 150)
	a.DetailSummary = trunc(strings.TrimSpace(r.DetailSummary), 300)
	a.Category = a.Category // 保留原 source 设置的 category
	if r.Category != "" && r.Category != "其他" {
		// 把 DeepSeek 识别的主题放进 topics（主题列表），不覆盖 source.Category 那个大类
		a.Topics = []string{r.Category}
	}
	if len(r.Keywords) > 6 {
		r.Keywords = r.Keywords[:6]
	}
	a.Keywords = r.Keywords
	a.Evidence = fmt.Sprintf("由 %s 整理 · tokens=%d", deepseekModel, apiResp.Usage.TotalTokens)
	a.Confidence = 0.95
	return nil
}

// runOneAIRule 原本的本地规则引擎，作为兜底。
func runOneAIRule(a *Article) {
	keywords := extractKeywords(a.Title + " " + a.Content)
	a.Keywords = keywords
	imp := `低`
	highWords := []string{
		`营商环境`, `重大项目`, `签约`, `投资`, `投产`, `专精特新`, `小巨人`,
		`独角兽`, `常委会`, `常务会议`, `集中开工`, `自贸区`, `生物医药`,
		`纳米技术`, `人工智能`, `重点企业`, `招商`,
	}
	for _, kw := range append(append([]string{}, keywords...), strings.Split(a.Title, " ")...) {
		for _, h := range highWords {
			if kw == h || strings.Contains(a.Title+a.Content, h) && kw == h {
				imp = `高`
			}
		}
	}
	for _, h := range highWords {
		if strings.Contains(a.Title+a.Content, h) {
			imp = `高`
			break
		}
	}
	if imp == `低` && (strings.Contains(a.Content, `推进会`) || strings.Contains(a.Content, `印发`) ||
		strings.Contains(a.Content, `部署`) || strings.Contains(a.Content, `调研`)) {
		imp = `中`
	}
	a.Importance = imp
	first := firstSentence(a.Content)
	a.Summary = trunc(first, 60)
	a.LeaderSummary = trunc(a.Title+" — "+first, 110)
	a.DetailSummary = first
	a.Evidence = `原文：「` + trunc(first, 80) + `」`
	a.Confidence = 0.75 + rand.Float64()*0.2

	tx := a.Title + a.Content
	topicMap := map[string][]string{
		`营商环境`: {`营商环境`, `一网通办`, `政务服务`},
		`招商引资`: {`签约`, `投资`, `招商`, `项目落地`, `集中开工`},
		`重点企业`: {`专精特新`, `小巨人`, `独角兽`, `龙头企业`, `重点企业`, `投产`},
		`产业创新`: {`生物医药`, `纳米技术`, `人工智能`, `新能源`, `集成电路`, `产学研`},
		`经济运行`: {`增加值`, `工业产值`, `进出口`, `固投`, `财政收入`, `GDP`},
		`民生关注`: {`食品安全`, `教育`, `医疗`, `住房`, `就业`, `防汛`, `安全生产`},
		`涉外开放`: {`自贸区`, `外资`, `跨境`, `保税`, `开放`, `进出口`},
	}
	seen := map[string]bool{}
	for topic, words := range topicMap {
		for _, w := range words {
			if strings.Contains(tx, w) && !seen[topic] {
				a.Topics = append(a.Topics, topic)
				seen[topic] = true
				break
			}
		}
	}
	// status 由调用方 runOneAI 统一设置
}

func extractKeywords(text string) []string {
	candidates := []string{
		`营商环境`, `一网通办`, `专精特新`, `小巨人`, `独角兽`, `签约`, `投资`, `投产`,
		`工业增加值`, `固投`, `进出口`, `外资`, `自贸区`, `保税`, `常务会议`, `常委会`,
		`印发`, `推进会`, `集中开工`, `招商`, `重大项目`,
		`食品安全`, `专项检查`, `防汛`, `安全生产`, `招商引资`,
		`产学研`, `生物医药`, `纳米技术`, `人工智能`, `集成电路`, `新能源`,
		`管委会`, `经开区`, `园区`, `重点企业`, `创新`,
	}
	out := []string{}
	for _, c := range candidates {
		if strings.Contains(text, c) {
			out = append(out, c)
		}
		if len(out) >= 6 {
			break
		}
	}
	return out
}

func firstSentence(s string) string {
	for _, sep := range []string{`。`, `；`, "\n"} {
		if i := strings.Index(s, sep); i > 0 {
			return strings.TrimSpace(s[:i] + sep)
		}
	}
	return s
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + `…`
}

// ===================== HTTP =====================

var store *Store

// ===================== wechat2rss 集成 =====================

// W2RConfig 通过环境变量配置：
//   W2R_BASE  = wechat2rss 服务地址，如 http://127.0.0.1:8090
//   W2R_TOKEN = wechat2rss 的 RSS_TOKEN
// 缺失时相关接口返回 503。
type W2RConfig struct {
	Base  string
	Token string
}

var w2rConfig W2RConfig

func loadW2RConfig() {
	w2rConfig.Base = strings.TrimRight(os.Getenv("W2R_BASE"), "/")
	w2rConfig.Token = os.Getenv("W2R_TOKEN")
	if w2rConfig.Base == "" {
		log.Printf("[w2r] W2R_BASE 未设置，公众号订阅模块将以未配置态运行")
	} else {
		log.Printf("[w2r] wechat2rss 代理已启用: %s", w2rConfig.Base)
	}
}

func w2rReady() bool { return w2rConfig.Base != "" }

// w2rURL 把路径 + 额外 query 拼成完整 URL，token 自动加到 query 里
func w2rURL(path string, extra url.Values) string {
	if extra == nil {
		extra = url.Values{}
	}
	if w2rConfig.Token != "" {
		extra.Set("k", w2rConfig.Token)
	}
	q := extra.Encode()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return w2rConfig.Base + path + sep + q
}

// w2rRequest 透传调用 wechat2rss。method=GET/POST；body 为可选。
// 返回 wechat2rss 的原始响应 body 与 status code。
func w2rRequest(method, path string, extra url.Values, body io.Reader, cookies []*http.Cookie) ([]byte, int, []*http.Cookie, error) {
	req, err := http.NewRequest(method, w2rURL(path, extra), body)
	if err != nil {
		return nil, 0, nil, err
	}
	req.Header.Set("User-Agent", "DZB-InfoTracker/1.0 w2r-proxy")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	c := &http.Client{Timeout: 20 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	return b, resp.StatusCode, resp.Cookies(), err
}

// 把 cookie list 转成 "K=V; K=V" 形式回写到浏览器（仅扫码登录会用）
func cookiesToHeader(cs []*http.Cookie) string {
	parts := []string{}
	for _, c := range cs {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

// 把请求里的 Cookie header 解析出来透传给 wechat2rss
func reqCookies(r *http.Request) []*http.Cookie { return r.Cookies() }

// w2rNotReady 标准化的 503 响应
func w2rNotReady(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"err":"wechat2rss 未配置，请管理员设置 W2R_BASE / W2R_TOKEN 环境变量"}`))
}

// w2rProxy 通用代理：把 wechat2rss 的原始 JSON 透传回去（保留状态码与 cookie）
func w2rProxy(w http.ResponseWriter, r *http.Request, method, path string, extra url.Values, body io.Reader) {
	if !w2rReady() {
		w2rNotReady(w)
		return
	}
	respBody, code, cookies, err := w2rRequest(method, path, extra, body, reqCookies(r))
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"err":"wechat2rss 请求失败: %s"}`, escapeJSON(err.Error()))
		return
	}
	for _, c := range cookies {
		http.SetCookie(w, &http.Cookie{Name: c.Name, Value: c.Value, Path: c.Path, MaxAge: c.MaxAge})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write(respBody)
}

func escapeJSON(s string) string {
	b, _ := json.Marshal(s)
	if len(b) >= 2 {
		return string(b[1 : len(b)-1])
	}
	return s
}

// ----- 各 /api/w2r/* 接口 -----

func apiW2RHealth(w http.ResponseWriter, r *http.Request) {
	out := map[string]interface{}{
		"ready":     w2rReady(),
		"base":      w2rConfig.Base,
		"has_token": w2rConfig.Token != "",
	}
	if !w2rReady() {
		writeJSON(w, out)
		return
	}
	body, code, _, err := w2rRequest("GET", "/version", nil, nil, nil)
	if err != nil {
		out["online"] = false
		out["error"] = err.Error()
	} else {
		out["online"] = code >= 200 && code < 300
		out["version"] = strings.TrimSpace(string(body))
	}
	writeJSON(w, out)
}

func apiW2RAccounts(w http.ResponseWriter, r *http.Request) {
	w2rProxy(w, r, "GET", "/login/list", nil, nil)
}

func apiW2RAccountLogin(w http.ResponseWriter, r *http.Request) {
	w2rProxy(w, r, "GET", "/login/new", nil, nil)
}

func apiW2RAccountCode(w http.ResponseWriter, r *http.Request) {
	w2rProxy(w, r, "POST", "/login/code", nil, r.Body)
}

func apiW2RAccountRefresh(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", 400)
		return
	}
	w2rProxy(w, r, "GET", "/login/refresh/"+id, nil, nil)
}

func apiW2RAccountDel(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", 400)
		return
	}
	w2rProxy(w, r, "GET", "/login/del/"+id, nil, nil)
}

func apiW2RFeeds(w http.ResponseWriter, r *http.Request) {
	q := url.Values{}
	if v := r.URL.Query().Get("page"); v != "" {
		q.Set("page", v)
	}
	if v := r.URL.Query().Get("size"); v != "" {
		q.Set("size", v)
	} else {
		q.Set("size", "200")
	}
	if v := r.URL.Query().Get("name"); v != "" {
		q.Set("name", v)
	}
	w2rProxy(w, r, "GET", "/list", q, nil)
}

func apiW2RFeedAddURL(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL string `json:"url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.URL == "" {
		http.Error(w, "url required", 400)
		return
	}
	q := url.Values{}
	q.Set("url", in.URL)
	w2rProxy(w, r, "GET", "/addurl", q, nil)
}

func apiW2RFeedAddID(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.ID == "" {
		http.Error(w, "id required", 400)
		return
	}
	w2rProxy(w, r, "GET", "/add/"+in.ID, nil, nil)
}

func apiW2RFeedDel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.ID == "" {
		http.Error(w, "id required", 400)
		return
	}
	w2rProxy(w, r, "GET", "/del/"+in.ID, nil, nil)
}

func apiW2RFeedPause(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID     string `json:"id"`
		Status bool   `json:"status"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	if in.ID == "" {
		http.Error(w, "id required", 400)
		return
	}
	q := url.Values{}
	if in.Status {
		q.Set("status", "true")
	} else {
		q.Set("status", "false")
	}
	w2rProxy(w, r, "GET", "/pause/"+in.ID, q, nil)
}

// rewriteFeedLink 把 wechat2rss 返回的 feed link 改写为可被本机访问的 127.0.0.1
// 因为 .env 里 RSS_HOST 通常配的是局域网 IP，从 macOS 上反向连不通。
func rewriteFeedLink(link string) string {
	u, err := url.Parse(link)
	if err != nil || u.Host == "" {
		return link
	}
	// 只重写 host，端口保留
	host := u.Host
	if i := strings.Index(host, ":"); i >= 0 {
		u.Host = "127.0.0.1" + host[i:]
	} else {
		u.Host = "127.0.0.1"
	}
	return u.String()
}

// apiW2RFeedsSync 把 wechat2rss 的全部订阅同步成 本系统 Source
// 支持 ?dry=1 预览，POST body 可传 {ids:[...]} 限定要导入的 ids
func apiW2RFeedsSync(w http.ResponseWriter, r *http.Request) {
	if !w2rReady() {
		w2rNotReady(w)
		return
	}
	body, code, _, err := w2rRequest("GET", "/list", url.Values{"size": []string{"500"}}, nil, nil)
	if err != nil || code >= 400 {
		writeJSON(w, map[string]interface{}{"err": fmt.Sprintf("拉取 wechat2rss /list 失败: %v / HTTP %d", err, code)})
		return
	}
	var listResp struct {
		Data []struct {
			ID     json.Number `json:"id"`
			Name   string      `json:"name"`
			Link   string      `json:"link"`
			Paused bool        `json:"paused"`
		} `json:"data"`
		Err string `json:"err"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&listResp); err != nil {
		writeJSON(w, map[string]interface{}{"err": "解析 wechat2rss 响应失败: " + err.Error()})
		return
	}
	if listResp.Err != "" {
		writeJSON(w, map[string]interface{}{"err": listResp.Err})
		return
	}

	dry := r.URL.Query().Get("dry") == "1"
	// 可选：从 body 里读 ids 白名单
	wantIDs := map[string]bool{}
	if r.Method == "POST" {
		var in struct {
			IDs []string `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		for _, id := range in.IDs {
			wantIDs[id] = true
		}
	}

	// 已存在 url
	store.mu.RLock()
	existsURL := map[string]bool{}
	for _, s := range store.Sources {
		existsURL[s.URL] = true
	}
	store.mu.RUnlock()

	type item struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Link   string `json:"link"`
		Paused bool   `json:"paused"`
		Status string `json:"status"` // new / exists / skipped
	}
	items := []item{}
	for _, it := range listResp.Data {
		idStr := it.ID.String()
		if len(wantIDs) > 0 && !wantIDs[idStr] {
			continue
		}
		link := rewriteFeedLink(it.Link)
		it2 := item{ID: idStr, Name: it.Name, Link: link, Paused: it.Paused}
		if existsURL[link] {
			it2.Status = "exists"
		} else {
			it2.Status = "new"
		}
		items = append(items, it2)
	}

	if dry {
		writeJSON(w, map[string]interface{}{"items": items, "dry": true})
		return
	}

	// 真正写入
	store.mu.Lock()
	created, skipped := 0, 0
	now := time.Now()
	for _, it := range items {
		if it.Status == "exists" {
			skipped++
			continue
		}
		s := Source{
			Unit:       it.Name + " [公众号]",
			Type:       "wechat2rss",
			Kind:       "rss",
			Category:   `企业类`,
			URL:        it.Link,
			Frequency:  "daily",
			OwnerName:  `王干事`,
			Group:      `招商组`,
			Active:     !it.Paused,
			Authorized: true,
			ID:         store.nextID("source"),
			CreatedAt:  now,
		}
		store.Sources = append(store.Sources, s)
		created++
	}
	store.mu.Unlock()
	store.save()

	writeJSON(w, map[string]interface{}{
		"items":   items,
		"created": created,
		"skipped": skipped,
		"total":   len(items),
	})
}

func main() {
	rand.Seed(time.Now().UnixNano())
	store = loadStore()
	loadW2RConfig()
	loadAIConfig()

	// 报告采集微服务状态
	if crawlerHealth() {
		log.Printf("[crawler] 通用采集微服务在线: %s (crawl4ai)", crawlerBase)
	} else {
		log.Printf("[crawler] 通用采集微服务未启动 (%s)，将降级到正则解析", crawlerBase)
	}

	// 启动后台调度：每分钟扫一次，按 frequency 到期的源串行执行
	go schedulerLoop()

	sub, _ := fs.Sub(assets, "static")
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(sub))))

	http.HandleFunc("/api/stats", apiStats)
	http.HandleFunc("/api/users", apiUsers)
	http.HandleFunc("/api/sources", apiSources)
	http.HandleFunc("/api/sources/create", apiSourceCreate)
	http.HandleFunc("/api/sources/bulk_import", apiSourceBulkImport)
	http.HandleFunc("/api/sources/toggle", apiSourceToggle)
	http.HandleFunc("/api/sources/delete", apiSourceDelete)
	http.HandleFunc("/api/sources/test", apiSourceTest)
	http.HandleFunc("/api/articles", apiArticles)
	http.HandleFunc("/api/article", apiArticleDetail)
	http.HandleFunc("/api/article/update", apiArticleUpdate)
	http.HandleFunc("/api/article/approve", apiArticleApprove)
	http.HandleFunc("/api/article/reject", apiArticleReject)
	http.HandleFunc("/api/collect", apiCollect)
	http.HandleFunc("/api/ai", apiRunAI)
	http.HandleFunc("/api/search", apiSearch)
	http.HandleFunc("/api/briefs", apiBriefs)
	http.HandleFunc("/api/briefs/generate", apiBriefGenerate)
	http.HandleFunc("/api/briefs/publish", apiBriefPublish)
	http.HandleFunc("/api/briefs/export", apiBriefExport)
	http.HandleFunc("/api/pushes", apiPushes)
	http.HandleFunc("/api/tasks", apiTasks)
	http.HandleFunc("/api/demo/full", apiDemoFull)

	// ---- wechat2rss 集成 ----
	http.HandleFunc("/api/w2r/health", apiW2RHealth)
	http.HandleFunc("/api/w2r/accounts", apiW2RAccounts)
	http.HandleFunc("/api/w2r/accounts/login", apiW2RAccountLogin)
	http.HandleFunc("/api/w2r/accounts/code", apiW2RAccountCode)
	http.HandleFunc("/api/w2r/accounts/refresh", apiW2RAccountRefresh)
	http.HandleFunc("/api/w2r/accounts/del", apiW2RAccountDel)
	http.HandleFunc("/api/w2r/feeds", apiW2RFeeds)
	http.HandleFunc("/api/w2r/feeds/add_url", apiW2RFeedAddURL)
	http.HandleFunc("/api/w2r/feeds/add_id", apiW2RFeedAddID)
	http.HandleFunc("/api/w2r/feeds/del", apiW2RFeedDel)
	http.HandleFunc("/api/w2r/feeds/pause", apiW2RFeedPause)
	http.HandleFunc("/api/w2r/feeds/sync", apiW2RFeedsSync)

	indexHTML, err := assets.ReadFile("index.html")
	if err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(indexHTML)
	})

	log.Println("党政办信息跟踪与智能整理系统 Demo 启动: http://127.0.0.1:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func apiStats(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	stat := map[string]int{
		"sources_total": 0, "sources_active": 0,
		"articles_total": 0,
		"pending":        0, "approved": 0, "published": 0, "duplicate": 0,
		"high_imp": 0,
		"briefs":   0,
		"pushes":   0,
	}
	for _, s := range store.Sources {
		if group != "" && s.Group != group {
			continue
		}
		stat["sources_total"]++
		if s.Active {
			stat["sources_active"]++
		}
	}
	for _, a := range store.Articles {
		if group != "" && a.Group != group {
			continue
		}
		stat["articles_total"]++
		switch a.Status {
		case "pending_review":
			stat["pending"]++
		case "approved":
			stat["approved"]++
		case "published":
			stat["published"]++
		}
		if a.DuplicateOf > 0 {
			stat["duplicate"]++
		}
		if a.Importance == `高` {
			stat["high_imp"]++
		}
	}
	// 简报 / 推送：通过关联文章的 Group 判断（简报关联 article_ids，推送关联 brief_id）
	briefHits := map[int]bool{}
	for _, b := range store.Briefs {
		if group == "" {
			briefHits[b.ID] = true
			stat["briefs"]++
			continue
		}
		// 简报里至少 1 篇文章属于该组
		for _, aid := range b.ArticleIDs {
			for _, a := range store.Articles {
				if a.ID == aid && a.Group == group {
					briefHits[b.ID] = true
					break
				}
			}
			if briefHits[b.ID] {
				break
			}
		}
		if briefHits[b.ID] {
			stat["briefs"]++
		}
	}
	for _, p := range store.Pushes {
		if group != "" && !briefHits[p.BriefID] {
			continue
		}
		stat["pushes"]++
	}
	var ok, total int
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, t := range store.Tasks {
		if t.StartedAt.After(cutoff) {
			if group != "" {
				// 找该 source 当时的 Group
				srcGroup := ""
				for _, s := range store.Sources {
					if s.ID == t.SourceID {
						srcGroup = s.Group
						break
					}
				}
				if srcGroup != group {
					continue
				}
			}
			total++
			if t.Status == "success" {
				ok++
			}
		}
	}
	rate := 100
	if total > 0 {
		rate = ok * 100 / total
	}
	writeJSON(w, map[string]interface{}{
		"stat":         stat,
		"success_rate": rate,
		"task_total":   total,
	})
}

// apiUsers 返回种子用户列表，前端用于身份切换下拉
func apiUsers(w http.ResponseWriter, r *http.Request) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := make([]User, len(store.Users))
	copy(out, store.Users)
	writeJSON(w, out)
}

func apiSources(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := []Source{}
	for _, s := range store.Sources {
		if group != "" && s.Group != group {
			continue
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}

func apiSourceCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var s Source
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	store.mu.Lock()
	s.ID = store.nextID("source")
	s.Active = true
	s.CreatedAt = time.Now()
	if s.Group == "" {
		s.Group = `综合组`
	}
	store.Sources = append(store.Sources, s)
	store.mu.Unlock()
	store.save()
	writeJSON(w, s)
}

func apiSourceToggle(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	store.mu.Lock()
	for i := range store.Sources {
		if store.Sources[i].ID == id {
			store.Sources[i].Active = !store.Sources[i].Active
			break
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]string{"ok": "1"})
}

// apiSourceDelete 删除一个信息源。文章本身不删（保留历史记录）。
func apiSourceDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	store.mu.Lock()
	idx := -1
	for i := range store.Sources {
		if store.Sources[i].ID == id {
			idx = i
			break
		}
	}
	if idx >= 0 {
		store.Sources = append(store.Sources[:idx], store.Sources[idx+1:]...)
	}
	store.mu.Unlock()
	store.save()
	if idx < 0 {
		http.Error(w, "not found", 404)
		return
	}
	writeJSON(w, map[string]string{"ok": "1"})
}

// apiSourceTest 测试采集一个 URL，返回预览结果，不入库。
// POST /api/sources/test  {"url": "...", "type": "website|rss"}
func apiSourceTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var in struct {
		URL  string `json:"url"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if in.URL == "" {
		http.Error(w, "url required", 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	sourceType := in.Type
	if sourceType == "" {
		sourceType = "website"
	}

	// RSS 类型直接走 RSS 解析测试
	if sourceType == "rss" || sourceType == "wechat2rss" {
		body, err := httpGet(ctx, in.URL)
		if err != nil {
			writeJSON(w, map[string]interface{}{"ok": false, "error": "RSS 抓取失败: " + err.Error()})
			return
		}
		items, err := parseFeed(body)
		if err != nil {
			writeJSON(w, map[string]interface{}{"ok": false, "error": "RSS 解析失败: " + err.Error()})
			return
		}
		preview := []map[string]string{}
		for i, it := range items {
			if i >= 15 {
				break
			}
			preview = append(preview, map[string]string{
				"title": it.Title, "url": it.URL,
				"publish_time": func() string {
					if !it.Published.IsZero() {
						return it.Published.Format("2006-01-02 15:04")
					}
					return ""
				}(),
			})
		}
		writeJSON(w, map[string]interface{}{
			"ok": true, "mode": "rss", "found": len(items),
			"preview": preview, "engine": "go-rss",
		})
		return
	}

	// 网站类型：优先走 crawl4ai 微服务
	if crawlerHealth() {
		listRes, err := crawlerList(ctx, in.URL, 15)
		if err != nil || !listRes.OK {
			errMsg := "微服务调用失败"
			if err != nil {
				errMsg = err.Error()
			} else if listRes != nil {
				errMsg = listRes.Error
			}
			writeJSON(w, map[string]interface{}{"ok": false, "error": "crawler: " + errMsg, "engine": "crawl4ai"})
			return
		}
		preview := []map[string]string{}
		var firstDetail *crawlerDetailResult
		for i, it := range listRes.Items {
			if i >= 15 {
				break
			}
			preview = append(preview, map[string]string{
				"title": it.Title, "url": it.URL, "publish_time": it.PublishTime,
			})
		}
		// 对第 1 条试抓详情
		if len(listRes.Items) > 0 {
			d, err := crawlerDetail(ctx, listRes.Items[0].URL)
			if err == nil {
				firstDetail = d
			}
		}
		detailPreview := map[string]interface{}{}
		if firstDetail != nil {
			detailPreview = map[string]interface{}{
				"ok":          firstDetail.OK,
				"title":       firstDetail.Title,
				"content_len": len([]rune(firstDetail.ContentText)),
				"excerpt":     trunc(firstDetail.ContentText, 200),
				"publish_time": firstDetail.PublishTime,
			}
		}
		writeJSON(w, map[string]interface{}{
			"ok": true, "mode": "list", "found": len(listRes.Items),
			"preview": preview, "detail": detailPreview,
			"engine": "crawl4ai",
		})
		return
	}

	// 降级：原正则解析
	listHTML, err := httpGet(ctx, in.URL)
	if err != nil {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "抓取失败: " + err.Error(), "engine": "regex-fallback"})
		return
	}
	items := parseListPage(in.URL, listHTML)
	preview := []map[string]string{}
	for i, it := range items {
		if i >= 15 {
			break
		}
		preview = append(preview, map[string]string{
			"title": it.Title, "url": it.URL,
			"publish_time": func() string {
				if !it.Published.IsZero() {
					return it.Published.Format("2006-01-02 15:04")
				}
				return ""
			}(),
		})
	}
	writeJSON(w, map[string]interface{}{
		"ok": len(items) > 0, "mode": "list", "found": len(items),
		"preview": preview, "engine": "regex-fallback",
		"warning": "采集微服务未启动，使用降级正则解析（泛化能力有限）",
	})
}

// apiSourceBulkImport 批量导入信息源
// POST /api/sources/bulk_import
// body: { "items": [{unit,type,kind,category,url,owner_name,group,frequency}, ...] }
// 已存在的 URL 自动跳过（dedup by url）。返回 {created, skipped, total}。
func apiSourceBulkImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var in struct {
		Items []Source `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	store.mu.Lock()
	exists := map[string]bool{}
	for _, s := range store.Sources {
		exists[s.URL] = true
	}
	created, skipped := 0, 0
	now := time.Now()
	for _, s := range in.Items {
		if s.URL == "" || exists[s.URL] {
			skipped++
			continue
		}
		if s.Kind == "" {
			if s.Type == "rss" || s.Type == "wechat2rss" {
				s.Kind = "rss"
			} else {
				s.Kind = "html_list"
			}
		}
		if s.Group == "" {
			s.Group = `综合组`
		}
		if s.Frequency == "" {
			s.Frequency = "daily"
		}
		if s.Category == "" {
			s.Category = `专题类`
		}
		s.ID = store.nextID("source")
		s.Active = true
		s.CreatedAt = now
		store.Sources = append(store.Sources, s)
		exists[s.URL] = true
		created++
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]int{
		"created": created,
		"skipped": skipped,
		"total":   created + skipped,
	})
}

func apiArticles(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := []Article{}
	for _, a := range store.Articles {
		if status != "" && a.Status != status {
			continue
		}
		if group != "" && a.Group != group {
			continue
		}
		out = append(out, a)
	}
	// 排序：重要性（高→中→低）优先，同等重要性下按发布时间倒序
	impRank := func(s string) int {
		switch s {
		case "高":
			return 3
		case "中":
			return 2
		case "低":
			return 1
		}
		return 0
	}
	sort.Slice(out, func(i, j int) bool {
		ri, rj := impRank(out[i].Importance), impRank(out[j].Importance)
		if ri != rj {
			return ri > rj
		}
		// 同等重要性：按发布时间倒序；若无发布时间则按入库时间
		ti, tj := out[i].PublishTime, out[j].PublishTime
		if ti.IsZero() {
			ti = out[i].FetchTime
		}
		if tj.IsZero() {
			tj = out[j].FetchTime
		}
		return ti.After(tj)
	})
	writeJSON(w, out)
}

func apiArticleDetail(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	store.mu.RLock()
	defer store.mu.RUnlock()
	for _, a := range store.Articles {
		if a.ID == id {
			logs := []ReviewLog{}
			for _, l := range store.Reviews {
				if l.ArticleID == id {
					logs = append(logs, l)
				}
			}
			writeJSON(w, map[string]interface{}{"article": a, "logs": logs})
			return
		}
	}
	http.Error(w, "not found", 404)
}

func apiArticleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var in struct {
		ID            int    `json:"id"`
		Summary       string `json:"summary"`
		LeaderSummary string `json:"leader_summary"`
		DetailSummary string `json:"detail_summary"`
		Importance    string `json:"importance"`
		Note          string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	store.mu.Lock()
	for i := range store.Articles {
		if store.Articles[i].ID == in.ID {
			before, _ := json.Marshal(store.Articles[i])
			store.Articles[i].Summary = in.Summary
			store.Articles[i].LeaderSummary = in.LeaderSummary
			store.Articles[i].DetailSummary = in.DetailSummary
			store.Articles[i].Importance = in.Importance
			after, _ := json.Marshal(store.Articles[i])
			store.Reviews = append(store.Reviews, ReviewLog{
				ID: store.nextID("review"), ArticleID: in.ID,
				Reviewer: `李审核`, Action: "edit",
				Before: string(before), After: string(after),
				Note: in.Note, OccurredAt: time.Now(),
			})
			break
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]string{"ok": "1"})
}

func apiArticleApprove(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	store.mu.Lock()
	for i := range store.Articles {
		if store.Articles[i].ID == id {
			store.Articles[i].Status = "approved"
			store.Reviews = append(store.Reviews, ReviewLog{
				ID: store.nextID("review"), ArticleID: id, Reviewer: `李审核`,
				Action: "approve", Note: `审核通过`, OccurredAt: time.Now(),
			})
			break
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]string{"ok": "1"})
}

func apiArticleReject(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	note := r.URL.Query().Get("note")
	store.mu.Lock()
	for i := range store.Articles {
		if store.Articles[i].ID == id {
			store.Articles[i].Status = "archived"
			store.Reviews = append(store.Reviews, ReviewLog{
				ID: store.nextID("review"), ArticleID: id, Reviewer: `李审核`,
				Action: "reject", Note: note, OccurredAt: time.Now(),
			})
			break
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]string{"ok": "1"})
}

func apiCollect(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	store.mu.Lock()
	results := []TaskRun{}
	if idStr != "" {
		id, _ := strconv.Atoi(idStr)
		for i := range store.Sources {
			if store.Sources[i].ID == id {
				tr := runOneCollect(store, &store.Sources[i])
				store.Tasks = append(store.Tasks, tr)
				results = append(results, tr)
				break
			}
		}
	} else {
		for i := range store.Sources {
			if !store.Sources[i].Active {
				continue
			}
			tr := runOneCollect(store, &store.Sources[i])
			store.Tasks = append(store.Tasks, tr)
			results = append(results, tr)
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, results)
}

// runAIBatch 对所有 status 在 targetStatuses 中的文章并发跑 AI 整理。
// 并发上限默认 4（保护 DeepSeek 限流，也保护本地 CPU）。
// 返回处理总数和各引擎计数。
func runAIBatch(targetStatuses []string) (int, map[string]int) {
	// 取出符合条件的索引（持读锁短时间）
	store.mu.RLock()
	want := map[string]bool{}
	for _, s := range targetStatuses {
		want[s] = true
	}
	indices := []int{}
	for i := range store.Articles {
		if want[store.Articles[i].Status] {
			indices = append(indices, i)
		}
	}
	store.mu.RUnlock()
	if len(indices) == 0 {
		return 0, map[string]int{}
	}

	const maxConcurrent = 4
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	engineCounts := map[string]int{}
	var mu sync.Mutex

	for _, idx := range indices {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			// 拷贝文章避免长时间持锁；处理完写回
			store.mu.RLock()
			if i >= len(store.Articles) {
				store.mu.RUnlock()
				return
			}
			a := store.Articles[i]
			store.mu.RUnlock()

			runOneAI(&a)

			store.mu.Lock()
			if i < len(store.Articles) && store.Articles[i].ID == a.ID {
				store.Articles[i] = a
			}
			store.mu.Unlock()

			mu.Lock()
			engineCounts[a.AIEngine]++
			mu.Unlock()
		}(idx)
	}
	wg.Wait()
	store.save()
	return len(indices), engineCounts
}

func apiRunAI(w http.ResponseWriter, r *http.Request) {
	// 支持 ?all=1 重跑所有文章（不限状态），用于批量重跑演示数据
	all := r.URL.Query().Get("all") == "1"
	statuses := []string{"collected"}
	if all {
		statuses = []string{"collected", "pending_review", "ai_done"}
	}
	count, engines := runAIBatch(statuses)
	writeJSON(w, map[string]interface{}{
		"processed": count,
		"engines":   engines,
		"model":     deepseekModel,
	})
}

func apiSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	unit := r.URL.Query().Get("unit")
	topic := r.URL.Query().Get("topic")
	store.mu.RLock()
	defer store.mu.RUnlock()
	type hit struct {
		Article Article `json:"article"`
		Score   int     `json:"score"`
		Snippet string  `json:"snippet"`
	}
	hits := []hit{}
	for _, a := range store.Articles {
		if unit != "" && a.Unit != unit {
			continue
		}
		if topic != "" {
			ok := false
			for _, t := range a.Topics {
				if t == topic {
					ok = true
					break
				}
			}
			if !ok {
				continue
			}
		}
		score := 0
		snippet := a.Summary
		if q != "" {
			text := a.Title + " " + a.Content + " " + strings.Join(a.Keywords, " ")
			score = strings.Count(text, q)
			if score == 0 {
				continue
			}
			// 按 rune 切片，避免切到 UTF-8 多字节字符中间
			rs := []rune(a.Content)
			qs := []rune(q)
			for i := 0; i+len(qs) <= len(rs); i++ {
				if string(rs[i:i+len(qs)]) == q {
					lo := i - 20
					if lo < 0 {
						lo = 0
					}
					hi := i + len(qs) + 40
					if hi > len(rs) {
						hi = len(rs)
					}
					snippet = "…" + string(rs[lo:hi]) + "…"
					break
				}
			}
		}
		hits = append(hits, hit{Article: a, Score: score, Snippet: snippet})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Article.PublishTime.After(hits[j].Article.PublishTime)
	})
	if len(hits) > 50 {
		hits = hits[:50]
	}
	writeJSON(w, hits)
}

func apiBriefs(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	type bri struct {
		Brief
		Items []Article `json:"items"`
	}
	out := []bri{}
	for _, b := range store.Briefs {
		bb := bri{Brief: b}
		for _, id := range b.ArticleIDs {
			for _, a := range store.Articles {
				if a.ID == id {
					bb.Items = append(bb.Items, a)
				}
			}
		}
		// 组过滤：简报必须含至少 1 篇该组的文章
		if group != "" {
			match := false
			for _, it := range bb.Items {
				if it.Group == group {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		out = append(out, bb)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	writeJSON(w, out)
}

func apiBriefGenerate(w http.ResponseWriter, r *http.Request) {
	t := r.URL.Query().Get("type")
	if t == "" {
		t = "daily"
	}
	store.mu.Lock()
	now := time.Now()
	var cutoff time.Time
	var period string
	switch t {
	case "daily":
		cutoff = now.Add(-7 * 24 * time.Hour) // 一周内已审核未发布的进入日报
		period = now.Format("2006-01-02")
	case "weekly":
		cutoff = now.Add(-30 * 24 * time.Hour)
		period = fmt.Sprintf("%s 第%d周", now.Format("2006"), weekOfYear(now))
	case "monthly":
		cutoff = now.Add(-90 * 24 * time.Hour)
		period = now.Format("2006-01")
	}
	ids := []int{}
	for _, a := range store.Articles {
		if a.PublishTime.Before(cutoff) {
			continue
		}
		if a.Status != "approved" && a.Status != "published" {
			continue
		}
		if a.DuplicateOf > 0 {
			continue
		}
		ids = append(ids, a.ID)
	}
	b := Brief{
		ID: store.nextID("brief"), Type: t, Period: period,
		Title:      briefTitle(t, period),
		Status:     "draft",
		ArticleIDs: ids,
		Editor:     `李审核`,
		CreatedAt:  now,
	}
	store.Briefs = append(store.Briefs, b)
	store.mu.Unlock()
	store.save()
	writeJSON(w, b)
}

func briefTitle(t, period string) string {
	switch t {
	case "daily":
		return `党政办每日快报 ` + period
	case "weekly":
		return `党政办信息周报 ` + period
	case "monthly":
		return `党政办信息月度汇编 ` + period
	}
	return `党政办简报 ` + period
}

func apiBriefPublish(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "app"
	}
	target := r.URL.Query().Get("target")
	if target == "" {
		target = `张主任`
	}
	store.mu.Lock()
	for i := range store.Briefs {
		if store.Briefs[i].ID == id {
			store.Briefs[i].Status = "published"
			store.Briefs[i].PublishedAt = time.Now()
			for _, aid := range store.Briefs[i].ArticleIDs {
				for j := range store.Articles {
					if store.Articles[j].ID == aid && store.Articles[j].Status == "approved" {
						store.Articles[j].Status = "published"
					}
				}
			}
			pl := PushLog{
				ID: store.nextID("push"), Channel: channel, Target: target,
				Subject: store.Briefs[i].Title, BriefID: id,
				Status: "success", ReturnCode: "0", OccurredAt: time.Now(),
			}
			// Demo: 不模拟随机失败，保证演示链路稳定
			store.Pushes = append(store.Pushes, pl)
			store.mu.Unlock()
			store.save()
			writeJSON(w, pl)
			return
		}
	}
	store.mu.Unlock()
	http.Error(w, "not found", 404)
}

func apiPushes(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	// 算出"属于该组"的简报集合
	briefGroupOK := map[int]bool{}
	if group != "" {
		for _, b := range store.Briefs {
			for _, aid := range b.ArticleIDs {
				for _, a := range store.Articles {
					if a.ID == aid && a.Group == group {
						briefGroupOK[b.ID] = true
						break
					}
				}
				if briefGroupOK[b.ID] {
					break
				}
			}
		}
	}
	out := []PushLog{}
	for _, p := range store.Pushes {
		if group != "" && !briefGroupOK[p.BriefID] {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OccurredAt.After(out[j].OccurredAt) })
	writeJSON(w, out)
}

func apiTasks(w http.ResponseWriter, r *http.Request) {
	group := r.URL.Query().Get("group")
	store.mu.RLock()
	defer store.mu.RUnlock()
	// source_id -> group
	srcGroup := map[int]string{}
	for _, s := range store.Sources {
		srcGroup[s.ID] = s.Group
	}
	out := []TaskRun{}
	for _, t := range store.Tasks {
		if group != "" && srcGroup[t.SourceID] != group {
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	if len(out) > 100 {
		out = out[:100]
	}
	writeJSON(w, out)
}

// ===================== 演示用：一键完整闭环 =====================
// /api/demo/full —— 演示给客户：采集 → AI → 审核（自动通过 top 高重要性）→ 生成日报 → 推送
// 返回每一步的概要，便于前端按步骤显示。
type demoStep struct {
	Step    int    `json:"step"`
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Summary string `json:"summary"`
}
type demoResult struct {
	Steps []demoStep `json:"steps"`
}

func apiDemoFull(w http.ResponseWriter, r *http.Request) {
	out := demoResult{}
	add := func(step int, name string, ok bool, summary string) {
		out.Steps = append(out.Steps, demoStep{step, name, ok, summary})
	}

	// 1) 全量采集
	store.mu.Lock()
	collectResults := []TaskRun{}
	for i := range store.Sources {
		if !store.Sources[i].Active {
			continue
		}
		tr := runOneCollect(store, &store.Sources[i])
		store.Tasks = append(store.Tasks, tr)
		collectResults = append(collectResults, tr)
	}
	store.mu.Unlock()
	store.save()
	okCount, newTotal := 0, 0
	for _, t := range collectResults {
		if t.Status == "success" {
			okCount++
		}
		newTotal += t.NewItems
	}
	add(1, "全量采集", true, fmt.Sprintf("%d 个信息源，%d 成功，新增 %d 篇", len(collectResults), okCount, newTotal))

	// 2) AI 整理（对所有 collected 状态文章，并发批处理）
	aiCount, _ := runAIBatch([]string{"collected"})
	add(2, "AI 智能整理", true, fmt.Sprintf("摘要 / 关键词 / 主题 / 重要性识别，共处理 %d 篇", aiCount))

	// 3) 自动审核通过：取近 7 天「高/中重要性」最多 8 条
	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	store.mu.Lock()
	type cand struct {
		idx int
		t   time.Time
	}
	cands := []cand{}
	for i, a := range store.Articles {
		if a.Status != "pending_review" {
			continue
		}
		if a.Importance != "高" && a.Importance != "中" {
			continue
		}
		pt := a.PublishTime
		if pt.IsZero() {
			pt = a.FetchTime
		}
		if pt.Before(cutoff) {
			continue
		}
		cands = append(cands, cand{i, pt})
	}
	// 倒序时间挑前 8 条
	sort.Slice(cands, func(i, j int) bool { return cands[i].t.After(cands[j].t) })
	approved := 0
	for _, c := range cands {
		if approved >= 8 {
			break
		}
		store.Articles[c.idx].Status = "approved"
		store.Reviews = append(store.Reviews, ReviewLog{
			ID: store.nextID("review"), ArticleID: store.Articles[c.idx].ID,
			Reviewer: `李审核`, Action: "approve",
			Note: `[演示] 系统自动审核通过`, OccurredAt: time.Now(),
		})
		approved++
	}
	store.mu.Unlock()
	store.save()
	add(3, "人工审核", true, fmt.Sprintf("近 7 天高/中重要性条目，已通过 %d 条（演示自动）", approved))

	// 4) 生成日报
	now := time.Now()
	store.mu.Lock()
	ids := []int{}
	cutBrief := now.Add(-7 * 24 * time.Hour)
	for _, a := range store.Articles {
		if a.PublishTime.Before(cutBrief) {
			continue
		}
		if a.Status != "approved" && a.Status != "published" {
			continue
		}
		if a.DuplicateOf > 0 {
			continue
		}
		ids = append(ids, a.ID)
	}
	brief := Brief{
		ID: store.nextID("brief"), Type: "daily",
		Period:     now.Format("2006-01-02"),
		Title:      briefTitle("daily", now.Format("2006-01-02")),
		Status:     "draft",
		ArticleIDs: ids,
		Editor:     `李审核`,
		CreatedAt:  now,
	}
	store.Briefs = append(store.Briefs, brief)
	briefID := brief.ID
	store.mu.Unlock()
	store.save()
	add(4, "生成日报", len(ids) > 0, fmt.Sprintf("「%s」 共 %d 条入选", brief.Title, len(ids)))

	// 5) 推送（模拟企微）
	store.mu.Lock()
	for i := range store.Briefs {
		if store.Briefs[i].ID == briefID {
			store.Briefs[i].Status = "published"
			store.Briefs[i].PublishedAt = time.Now()
			for _, aid := range store.Briefs[i].ArticleIDs {
				for j := range store.Articles {
					if store.Articles[j].ID == aid && store.Articles[j].Status == "approved" {
						store.Articles[j].Status = "published"
					}
				}
			}
			pl := PushLog{
				ID: store.nextID("push"), Channel: "app", Target: `张主任`,
				Subject: store.Briefs[i].Title, BriefID: briefID,
				Status: "success", ReturnCode: "0", OccurredAt: time.Now(),
			}
			store.Pushes = append(store.Pushes, pl)
			break
		}
	}
	store.mu.Unlock()
	store.save()
	add(5, "企微推送", true, "（模拟）已通过「应用消息」推送给张主任，返回码 0")

	writeJSON(w, out)
}

// ===================== 简报导出 Word (.docx) =====================
// 极简 docx：纯 zip 容器 + 几个固定 XML。仅依赖标准库。
func apiBriefExport(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))
	store.mu.RLock()
	var brief *Brief
	for i := range store.Briefs {
		if store.Briefs[i].ID == id {
			brief = &store.Briefs[i]
			break
		}
	}
	if brief == nil {
		store.mu.RUnlock()
		http.Error(w, "not found", 404)
		return
	}
	// 收集条目
	type briefItem = struct {
		Importance, Unit, Title, LeaderSummary, URL string
	}
	items := []briefItem{}
	for _, aid := range brief.ArticleIDs {
		for _, a := range store.Articles {
			if a.ID == aid {
				items = append(items, briefItem{a.Importance, a.Unit, a.Title, a.LeaderSummary, a.URL})
				break
			}
		}
	}
	title := brief.Title
	period := brief.Period
	editor := brief.Editor
	store.mu.RUnlock()

	// 按重要性排序
	sort.SliceStable(items, func(i, j int) bool {
		rank := map[string]int{"高": 3, "中": 2, "低": 1}
		return rank[items[i].Importance] > rank[items[j].Importance]
	})

	// 生成 docx —— 简单结构：[Content_Types].xml / _rels/.rels / word/document.xml
	docXML := buildDocxBody(title, period, editor, items)
	docxBytes, err := zipDocx(docXML)
	if err != nil {
		http.Error(w, "export failed: "+err.Error(), 500)
		return
	}
	filename := fmt.Sprintf("%s.docx", strings.ReplaceAll(title, " ", "_"))
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", `attachment; filename="`+url.PathEscape(filename)+`"`)
	_, _ = w.Write(docxBytes)
}

func buildDocxBody(title, period, editor string, items []struct {
	Importance, Unit, Title, LeaderSummary, URL string
}) string {
	esc := func(s string) string {
		s = strings.ReplaceAll(s, "&", "&amp;")
		s = strings.ReplaceAll(s, "<", "&lt;")
		s = strings.ReplaceAll(s, ">", "&gt;")
		return s
	}
	p := func(text string, opts ...string) string {
		var pPr, rPr string
		for _, o := range opts {
			switch o {
			case "title":
				pPr = `<w:pPr><w:jc w:val="center"/></w:pPr>`
				rPr = `<w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="B32424"/></w:rPr>`
			case "h2":
				rPr = `<w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="8C1C1C"/></w:rPr>`
			case "meta":
				rPr = `<w:rPr><w:color w:val="6B7280"/><w:sz w:val="20"/></w:rPr>`
			case "bold":
				rPr = `<w:rPr><w:b/></w:rPr>`
			}
		}
		return "<w:p>" + pPr + "<w:r>" + rPr + "<w:t xml:space=\"preserve\">" + esc(text) + "</w:t></w:r></w:p>"
	}

	body := p(title, "title")
	body += p("期次："+period+"     编辑："+editor+"     生成时间："+time.Now().Format("2006-01-02 15:04"), "meta")
	body += p("", "")
	body += p("一、要点摘要", "h2")
	highCount, midCount := 0, 0
	for _, it := range items {
		if it.Importance == "高" {
			highCount++
		} else if it.Importance == "中" {
			midCount++
		}
	}
	body += p(fmt.Sprintf("本期共收录 %d 条信息，其中高重要性 %d 条，中重要性 %d 条。", len(items), highCount, midCount))
	body += p("", "")
	body += p("二、条目正文", "h2")
	for i, it := range items {
		body += p(fmt.Sprintf("%d.【%s】%s", i+1, it.Importance, it.Title), "bold")
		body += p("来源："+it.Unit, "meta")
		if it.LeaderSummary != "" {
			body += p("摘要：" + it.LeaderSummary)
		}
		if it.URL != "" {
			body += p("原文链接：" + it.URL, "meta")
		}
		body += p("", "")
	}

	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + body + `</w:body></w:document>`
}

func zipDocx(documentXML string) ([]byte, error) {
	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, content string) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = f.Write([]byte(content))
		return err
	}
	if err := add("[Content_Types].xml", contentTypes); err != nil {
		return nil, err
	}
	if err := add("_rels/.rels", rootRels); err != nil {
		return nil, err
	}
	if err := add("word/document.xml", documentXML); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
