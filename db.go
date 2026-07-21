package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// dbPool 全局连接池；生产环境数据存 PostgreSQL，不再使用 data.json。
var dbPool *pgxpool.Pool

// 单次采集任务日志保留上限：调度器每分钟追加一条，需防止无限增长。
const taskRetention = 500

// dbCtx 统一的短超时上下文，供各写操作使用。
func dbCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

// nt 把 Go 零值时间转成 NULL，避免写入 0001-01-01 之类的哨兵值。
func nt(t time.Time) interface{} {
	if t.IsZero() {
		return nil
	}
	return t
}

// tv 从可空时间指针取值（NULL → 零值）。
func tv(p *time.Time) time.Time {
	if p == nil {
		return time.Time{}
	}
	return *p
}

// jb 把切片/map 序列化为 JSON 文本，供 jsonb 列使用。
func jb(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil || len(b) == 0 {
		return "null"
	}
	return string(b)
}

// initDB 连接 PostgreSQL 并执行建表（幂等）。DATABASE_URL 必填。
func initDB(ctx context.Context) error {
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL 未配置：生产环境必须使用 PostgreSQL，例如 postgres://user:pass@host:5432/dbname")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("DATABASE_URL 解析失败: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("PostgreSQL Ping 失败: %w", err)
	}
	if _, err := pool.Exec(ctx, schemaSQL); err != nil {
		return fmt.Errorf("建表失败: %w", err)
	}
	dbPool = pool
	log.Printf("[db] PostgreSQL 已连接，表结构就绪")
	return nil
}

// dbRowCount 返回某表行数（用于判断是否需要首次导入/播种）。
func dbRowCount(ctx context.Context, table string) (int, error) {
	var n int
	err := dbPool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n)
	return n, err
}

// ---------------- 写操作（定向 upsert / append） ----------------

func dbUpsertUser(u User) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO users (id,name,username,password_hash,"group",role,active,created_at,last_login_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (id) DO UPDATE SET
		  name=$2, username=$3, password_hash=$4, "group"=$5, role=$6, active=$7, created_at=$8, last_login_at=$9`,
		u.ID, u.Name, u.Username, u.PasswordHash, u.Group, u.Role, u.Active, nt(u.CreatedAt), nt(u.LastLoginAt))
	if err != nil {
		log.Printf("[db] upsert user %d: %v", u.ID, err)
	}
}

func dbUpsertSource(s Source) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO sources (id,unit,category,type,kind,url,frequency,owner_id,owner_name,"group",active,authorized,last_success,fail_count,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (id) DO UPDATE SET
		  unit=$2,category=$3,type=$4,kind=$5,url=$6,frequency=$7,owner_id=$8,owner_name=$9,"group"=$10,
		  active=$11,authorized=$12,last_success=$13,fail_count=$14,created_at=$15`,
		s.ID, s.Unit, s.Category, s.Type, s.Kind, s.URL, s.Frequency, s.OwnerID, s.OwnerName, s.Group,
		s.Active, s.Authorized, nt(s.LastSuccess), s.FailCount, nt(s.CreatedAt))
	if err != nil {
		log.Printf("[db] upsert source %d: %v", s.ID, err)
	}
}

func dbDeleteSource(id int) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	if _, err := dbPool.Exec(ctx, `DELETE FROM sources WHERE id=$1`, id); err != nil {
		log.Printf("[db] delete source %d: %v", id, err)
	}
}

func dbUpsertArticle(a Article) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO articles (id,source_id,unit,source_type,title,content,url,publish_time,fetch_time,content_hash,
		  status,importance,category,summary,leader_summary,detail_summary,keywords,topics,confidence,
		  ai_engine,ai_error,evidence,duplicate_of,owner_id,owner_name,"group")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26)
		ON CONFLICT (id) DO UPDATE SET
		  source_id=$2,unit=$3,source_type=$4,title=$5,content=$6,url=$7,publish_time=$8,fetch_time=$9,content_hash=$10,
		  status=$11,importance=$12,category=$13,summary=$14,leader_summary=$15,detail_summary=$16,keywords=$17::jsonb,
		  topics=$18::jsonb,confidence=$19,ai_engine=$20,ai_error=$21,evidence=$22,duplicate_of=$23,owner_id=$24,
		  owner_name=$25,"group"=$26`,
		a.ID, a.SourceID, a.Unit, a.SourceType, a.Title, a.Content, a.URL, nt(a.PublishTime), nt(a.FetchTime), a.ContentHash,
		a.Status, a.Importance, a.Category, a.Summary, a.LeaderSummary, a.DetailSummary, jb(a.Keywords), jb(a.Topics), a.Confidence,
		a.AIEngine, a.AIError, a.Evidence, a.DuplicateOf, a.OwnerID, a.OwnerName, a.Group)
	if err != nil {
		log.Printf("[db] upsert article %d: %v", a.ID, err)
	}
}

func dbInsertReview(rv ReviewLog) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO reviews (id,article_id,reviewer,action,before,after,note,occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
		rv.ID, rv.ArticleID, rv.Reviewer, rv.Action, rv.Before, rv.After, rv.Note, nt(rv.OccurredAt))
	if err != nil {
		log.Printf("[db] insert review %d: %v", rv.ID, err)
	}
}

func dbDeleteAllBriefs() {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	if _, err := dbPool.Exec(ctx, `DELETE FROM briefs`); err != nil {
		log.Printf("[db] delete all briefs: %v", err)
	}
}

func dbUpsertBrief(b Brief) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO briefs (id,type,period,title,status,article_ids,overview,editor,created_at,published_at)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
		ON CONFLICT (id) DO UPDATE SET
		  type=$2,period=$3,title=$4,status=$5,article_ids=$6::jsonb,overview=$7,editor=$8,created_at=$9,published_at=$10`,
		b.ID, b.Type, b.Period, b.Title, b.Status, jb(b.ArticleIDs), b.Overview, b.Editor, nt(b.CreatedAt), nt(b.PublishedAt))
	if err != nil {
		log.Printf("[db] upsert brief %d: %v", b.ID, err)
	}
}

func dbInsertPush(p PushLog) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO pushes (id,channel,target,subject,brief_id,article_id,status,return_code,occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
		p.ID, p.Channel, p.Target, p.Subject, p.BriefID, p.ArticleID, p.Status, p.ReturnCode, nt(p.OccurredAt))
	if err != nil {
		log.Printf("[db] insert push %d: %v", p.ID, err)
	}
}

// dbInsertTask 追加采集任务日志，并异步裁剪到最近 taskRetention 条。
func dbInsertTask(t TaskRun) {
	if dbPool == nil {
		return
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err := dbPool.Exec(ctx, `
		INSERT INTO tasks (id,source_id,unit,started_at,finished_at,status,found,new_items,error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
		t.ID, t.SourceID, t.Unit, nt(t.StartedAt), nt(t.FinishedAt), t.Status, t.Found, t.NewItems, t.Error)
	if err != nil {
		log.Printf("[db] insert task %d: %v", t.ID, err)
		return
	}
	// 保留最近 N 条，其余删除（按 id 递增即时间顺序）。
	_, _ = dbPool.Exec(ctx, `DELETE FROM tasks WHERE id <= (
		SELECT COALESCE(max(id),0) - $1 FROM tasks)`, taskRetention)
}

// ---------------- 首次导入 / 播种：批量落库 ----------------

// persistFullSnapshot 把整个内存 Store 一次性写入 PostgreSQL（仅用于首次导入或播种）。
func persistFullSnapshot(s *Store) error {
	if dbPool == nil {
		return fmt.Errorf("dbPool 未初始化")
	}
	// task 首次导入也做保留裁剪，避免把历史 16000+ 条噪声全部搬进来。
	tasks := s.Tasks
	if len(tasks) > taskRetention {
		tasks = tasks[len(tasks)-taskRetention:]
	}
	for _, u := range s.Users {
		dbUpsertUser(u)
	}
	for _, src := range s.Sources {
		dbUpsertSource(src)
	}
	for _, a := range s.Articles {
		dbUpsertArticle(a)
	}
	for _, rv := range s.Reviews {
		dbInsertReview(rv)
	}
	for _, b := range s.Briefs {
		dbUpsertBrief(b)
	}
	for _, p := range s.Pushes {
		dbInsertPush(p)
	}
	for _, t := range tasks {
		if dbPool != nil {
			ctx, cancel := dbCtx()
			_, err := dbPool.Exec(ctx, `
				INSERT INTO tasks (id,source_id,unit,started_at,finished_at,status,found,new_items,error)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
				t.ID, t.SourceID, t.Unit, nt(t.StartedAt), nt(t.FinishedAt), t.Status, t.Found, t.NewItems, t.Error)
			cancel()
			if err != nil {
				log.Printf("[db] import task %d: %v", t.ID, err)
			}
		}
	}
	log.Printf("[db] 首次数据落库完成：users=%d sources=%d articles=%d reviews=%d briefs=%d pushes=%d tasks=%d",
		len(s.Users), len(s.Sources), len(s.Articles), len(s.Reviews), len(s.Briefs), len(s.Pushes), len(tasks))
	return nil
}

// ---------------- 装载：从 PostgreSQL 读入内存快照 ----------------

func loadStoreFromDB(ctx context.Context) (*Store, error) {
	s := &Store{NextIDs: map[string]int{}}

	// 说明：应用自身写入从不产生 NULL（Go 零值 → ''/0/false），但为容忍手工改库 /
	// 数据迁移 / 表结构演进导致的 NULL，读取端一律 COALESCE，避免单条 NULL 让全表装载失败。

	// users
	rows, err := dbPool.Query(ctx, `SELECT id,COALESCE(name,''),COALESCE(username,''),COALESCE(password_hash,''),COALESCE("group",''),COALESCE(role,''),COALESCE(active,false),created_at,last_login_at FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var u User
		var created, lastLogin *time.Time
		if err := rows.Scan(&u.ID, &u.Name, &u.Username, &u.PasswordHash, &u.Group, &u.Role, &u.Active, &created, &lastLogin); err != nil {
			rows.Close()
			return nil, err
		}
		u.CreatedAt, u.LastLoginAt = tv(created), tv(lastLogin)
		s.Users = append(s.Users, u)
	}
	rows.Close()

	// sources
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(unit,''),COALESCE(category,''),COALESCE(type,''),COALESCE(kind,''),COALESCE(url,''),COALESCE(frequency,''),COALESCE(owner_id,0),COALESCE(owner_name,''),COALESCE("group",''),COALESCE(active,false),COALESCE(authorized,false),last_success,COALESCE(fail_count,0),created_at FROM sources ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var src Source
		var lastSuccess, created *time.Time
		if err := rows.Scan(&src.ID, &src.Unit, &src.Category, &src.Type, &src.Kind, &src.URL, &src.Frequency, &src.OwnerID, &src.OwnerName, &src.Group, &src.Active, &src.Authorized, &lastSuccess, &src.FailCount, &created); err != nil {
			rows.Close()
			return nil, err
		}
		src.LastSuccess, src.CreatedAt = tv(lastSuccess), tv(created)
		s.Sources = append(s.Sources, src)
	}
	rows.Close()

	// articles
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(source_id,0),COALESCE(unit,''),COALESCE(source_type,''),COALESCE(title,''),COALESCE(content,''),COALESCE(url,''),publish_time,fetch_time,COALESCE(content_hash,''),COALESCE(status,''),COALESCE(importance,''),COALESCE(category,''),COALESCE(summary,''),COALESCE(leader_summary,''),COALESCE(detail_summary,''),keywords,topics,COALESCE(confidence,0),COALESCE(ai_engine,''),COALESCE(ai_error,''),COALESCE(evidence,''),COALESCE(duplicate_of,0),COALESCE(owner_id,0),COALESCE(owner_name,''),COALESCE("group",'') FROM articles ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a Article
		var pub, fetch *time.Time
		var kw, tp []byte
		if err := rows.Scan(&a.ID, &a.SourceID, &a.Unit, &a.SourceType, &a.Title, &a.Content, &a.URL, &pub, &fetch, &a.ContentHash,
			&a.Status, &a.Importance, &a.Category, &a.Summary, &a.LeaderSummary, &a.DetailSummary, &kw, &tp, &a.Confidence,
			&a.AIEngine, &a.AIError, &a.Evidence, &a.DuplicateOf, &a.OwnerID, &a.OwnerName, &a.Group); err != nil {
			rows.Close()
			return nil, err
		}
		a.PublishTime, a.FetchTime = tv(pub), tv(fetch)
		_ = json.Unmarshal(kw, &a.Keywords)
		_ = json.Unmarshal(tp, &a.Topics)
		s.Articles = append(s.Articles, a)
	}
	rows.Close()

	// reviews
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(article_id,0),COALESCE(reviewer,''),COALESCE(action,''),COALESCE(before,''),COALESCE(after,''),COALESCE(note,''),occurred_at FROM reviews ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var rv ReviewLog
		var occ *time.Time
		if err := rows.Scan(&rv.ID, &rv.ArticleID, &rv.Reviewer, &rv.Action, &rv.Before, &rv.After, &rv.Note, &occ); err != nil {
			rows.Close()
			return nil, err
		}
		rv.OccurredAt = tv(occ)
		s.Reviews = append(s.Reviews, rv)
	}
	rows.Close()

	// briefs
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(type,''),COALESCE(period,''),COALESCE(title,''),COALESCE(status,''),article_ids,COALESCE(overview,''),COALESCE(editor,''),created_at,published_at FROM briefs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b Brief
		var created, published *time.Time
		var aids []byte
		if err := rows.Scan(&b.ID, &b.Type, &b.Period, &b.Title, &b.Status, &aids, &b.Overview, &b.Editor, &created, &published); err != nil {
			rows.Close()
			return nil, err
		}
		b.CreatedAt, b.PublishedAt = tv(created), tv(published)
		_ = json.Unmarshal(aids, &b.ArticleIDs)
		s.Briefs = append(s.Briefs, b)
	}
	rows.Close()

	// pushes
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(channel,''),COALESCE(target,''),COALESCE(subject,''),COALESCE(brief_id,0),COALESCE(article_id,0),COALESCE(status,''),COALESCE(return_code,''),occurred_at FROM pushes ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p PushLog
		var occ *time.Time
		if err := rows.Scan(&p.ID, &p.Channel, &p.Target, &p.Subject, &p.BriefID, &p.ArticleID, &p.Status, &p.ReturnCode, &occ); err != nil {
			rows.Close()
			return nil, err
		}
		p.OccurredAt = tv(occ)
		s.Pushes = append(s.Pushes, p)
	}
	rows.Close()

	// tasks（仅保留最近 taskRetention 条）
	rows, err = dbPool.Query(ctx, `SELECT id,COALESCE(source_id,0),COALESCE(unit,''),started_at,finished_at,COALESCE(status,''),COALESCE(found,0),COALESCE(new_items,0),COALESCE(error,'') FROM (
		SELECT * FROM tasks ORDER BY id DESC LIMIT $1) t ORDER BY id`, taskRetention)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t TaskRun
		var started, finished *time.Time
		if err := rows.Scan(&t.ID, &t.SourceID, &t.Unit, &started, &finished, &t.Status, &t.Found, &t.NewItems, &t.Error); err != nil {
			rows.Close()
			return nil, err
		}
		t.StartedAt, t.FinishedAt = tv(started), tv(finished)
		s.Tasks = append(s.Tasks, t)
	}
	rows.Close()

	// 从各表 MAX(id) 恢复 nextID 计数器
	for _, kv := range []struct {
		kind, table string
	}{
		{"user", "users"}, {"source", "sources"}, {"article", "articles"},
		{"review", "reviews"}, {"brief", "briefs"}, {"push", "pushes"}, {"task", "tasks"},
	} {
		var mx int
		if err := dbPool.QueryRow(ctx, "SELECT COALESCE(max(id),0) FROM "+kv.table).Scan(&mx); err != nil {
			return nil, err
		}
		s.NextIDs[kv.kind] = mx
	}
	return s, nil
}
