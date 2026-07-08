-- 党政办信息系统 PostgreSQL 表结构（幂等，可重复执行）。
-- ID 由应用侧分配（沿用 nextID 计数器，启动时从各表 MAX(id) 恢复），故用 bigint 而非 serial。

CREATE TABLE IF NOT EXISTS users (
  id            bigint PRIMARY KEY,
  name          text,
  username      text UNIQUE,
  password_hash text,
  "group"       text,
  role          text,
  active        boolean,
  created_at    timestamptz,
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS sources (
  id           bigint PRIMARY KEY,
  unit         text,
  category     text,
  type         text,
  kind         text,
  url          text,
  frequency    text,
  owner_id     bigint,
  owner_name   text,
  "group"      text,
  active       boolean,
  authorized   boolean,
  last_success timestamptz,
  fail_count   int,
  created_at   timestamptz
);

CREATE TABLE IF NOT EXISTS articles (
  id             bigint PRIMARY KEY,
  source_id      bigint,
  unit           text,
  source_type    text,
  title          text,
  content        text,
  url            text,
  publish_time   timestamptz,
  fetch_time     timestamptz,
  content_hash   text,
  status         text,
  importance     text,
  category       text,
  summary        text,
  leader_summary text,
  detail_summary text,
  keywords       jsonb,
  topics         jsonb,
  confidence     double precision,
  ai_engine      text,
  ai_error       text,
  evidence       text,
  duplicate_of   bigint,
  owner_id       bigint,
  owner_name     text,
  "group"        text
);
CREATE INDEX IF NOT EXISTS idx_articles_status  ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_group   ON articles("group");
CREATE INDEX IF NOT EXISTS idx_articles_hash    ON articles(content_hash);
CREATE INDEX IF NOT EXISTS idx_articles_publish ON articles(publish_time);

CREATE TABLE IF NOT EXISTS reviews (
  id          bigint PRIMARY KEY,
  article_id  bigint,
  reviewer    text,
  action      text,
  before      text,
  after       text,
  note        text,
  occurred_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reviews_article ON reviews(article_id);

CREATE TABLE IF NOT EXISTS briefs (
  id           bigint PRIMARY KEY,
  type         text,
  period       text,
  title        text,
  status       text,
  article_ids  jsonb,
  overview     text,
  editor       text,
  created_at   timestamptz,
  published_at timestamptz
);

CREATE TABLE IF NOT EXISTS pushes (
  id          bigint PRIMARY KEY,
  channel     text,
  target      text,
  subject     text,
  brief_id    bigint,
  article_id  bigint,
  status      text,
  return_code text,
  occurred_at timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
  id          bigint PRIMARY KEY,
  source_id   bigint,
  unit        text,
  started_at  timestamptz,
  finished_at timestamptz,
  status      text,
  found       int,
  new_items   int,
  error       text
);
CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at DESC);
