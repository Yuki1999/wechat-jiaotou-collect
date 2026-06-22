package main

import (
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
	Type        string    `json:"type"` // website / wechat / rss / wewe-rss
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
// 同时预留两条 RSS / WeWe RSS 占位条目（默认停用，部署 WeWe RSS 后填入 URL 即可启用）。

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
		// 占位：WeWe RSS（用户部署后改 URL 并启用）。kind=rss 直接走标准 RSS 解析器
		{
			Unit: `[占位] WeWe RSS · 苏州工业园区发布（公众号）`, Category: `企业类`,
			Type: "wewe-rss", Kind: "rss",
			URL:       "http://127.0.0.1:4000/feeds/REPLACE_WITH_FEED_ID.rss",
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

// ----- RSS / Atom 解析（用于 WeWe RSS 与通用 RSS） -----

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

// ----- 任务执行 -----

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

func runOneAI(a *Article) {
	if len([]rune(a.Content)) < 30 {
		a.Status = "failed"
		return
	}
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
	a.Status = "pending_review"
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

func main() {
	rand.Seed(time.Now().UnixNano())
	store = loadStore()

	sub, _ := fs.Sub(assets, "static")
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(sub))))

	http.HandleFunc("/api/stats", apiStats)
	http.HandleFunc("/api/sources", apiSources)
	http.HandleFunc("/api/sources/create", apiSourceCreate)
	http.HandleFunc("/api/sources/bulk_import", apiSourceBulkImport)
	http.HandleFunc("/api/sources/toggle", apiSourceToggle)
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
	http.HandleFunc("/api/pushes", apiPushes)
	http.HandleFunc("/api/tasks", apiTasks)

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
	store.mu.RLock()
	defer store.mu.RUnlock()
	stat := map[string]int{
		"sources_total": len(store.Sources), "sources_active": 0,
		"articles_total": len(store.Articles),
		"pending":        0, "approved": 0, "published": 0, "duplicate": 0,
		"high_imp": 0,
		"briefs":   len(store.Briefs),
		"pushes":   len(store.Pushes),
	}
	for _, s := range store.Sources {
		if s.Active {
			stat["sources_active"]++
		}
	}
	for _, a := range store.Articles {
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
	var ok, total int
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, t := range store.Tasks {
		if t.StartedAt.After(cutoff) {
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

func apiSources(w http.ResponseWriter, r *http.Request) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := make([]Source, len(store.Sources))
	copy(out, store.Sources)
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
			if s.Type == "rss" || s.Type == "wewe-rss" || s.Type == "wechat2rss" {
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
	sort.Slice(out, func(i, j int) bool { return out[i].FetchTime.After(out[j].FetchTime) })
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

func apiRunAI(w http.ResponseWriter, r *http.Request) {
	store.mu.Lock()
	count := 0
	for i := range store.Articles {
		if store.Articles[i].Status == "collected" {
			runOneAI(&store.Articles[i])
			count++
		}
	}
	store.mu.Unlock()
	store.save()
	writeJSON(w, map[string]int{"processed": count})
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
			if rand.Intn(20) == 0 {
				pl.Status = "fail"
				pl.ReturnCode = "60001"
			}
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
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := make([]PushLog, len(store.Pushes))
	copy(out, store.Pushes)
	sort.Slice(out, func(i, j int) bool { return out[i].OccurredAt.After(out[j].OccurredAt) })
	writeJSON(w, out)
}

func apiTasks(w http.ResponseWriter, r *http.Request) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	out := make([]TaskRun, len(store.Tasks))
	copy(out, store.Tasks)
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	if len(out) > 100 {
		out = out[:100]
	}
	writeJSON(w, out)
}
