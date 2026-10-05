-- =============================================================================
-- 名人雷达 · 云 DB 建表脚本（8 张表）
-- =============================================================================
-- 依据：src/types/db.ts + src/utils/{auth,follows,favorites,history,cache,events}.ts
--      的实际读写字段逐列核对，非照抄设计文档。
-- 引擎口径：PostgreSQL + PostgREST（Supabase 风格）。
--      证据：client 使用 .maybeSingle() / .range() / .in() / .or('state.eq.ready,...')，
--            且抢锁代码显式判断主键冲突码 '23505'（PG unique_violation）——
--            故必须有主键/唯一约束，否则并发互斥逻辑失效。
--
-- 用法：在 WorkBuddy 云服务面板的 SQL 编辑器里整体执行（幂等，可重复跑）。
-- 注意：本脚本不含 CREATE DATABASE / CREATE SCHEMA，直接建在当前 public schema。
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. users —— 登录后幂等初始化（src/utils/auth.ts）
-- -----------------------------------------------------------------------------
-- ⚠ 关键：id 不是裸 openid，而是 `'wx:' + openid`（代码取 session.user.id）。
--   其余表的 openid 列存的也是同一个带前缀的值，保持一致才能对上。
-- ⚠ last_seen_at 是 upsert 必填列，漏建会导致登录初始化报「列不存在」。
create table if not exists users (
  id           text primary key,
  nickname     text,
  avatar_url   text,
  settings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);


-- -----------------------------------------------------------------------------
-- 2. report_cache —— 全局共享报告缓存 + 生成互斥锁（src/utils/cache.ts）
-- -----------------------------------------------------------------------------
-- 设计要点：
--   * id = personKey（如 `李娜#sports`），主键唯一 → 抢锁靠 insert 触发 23505 判冲突。
--   * state='building' 即分布式锁；generated_at 兼作 building 超时判据。
--   * builder 存 openid，仅用于「只删/改自己那把锁」，防止误覆盖他人报告。
--   * 并发抢占条件：state=ready（过期可重建）或 generated_at < 超时线。
create table if not exists report_cache (
  id           text primary key,
  report       jsonb,
  generated_at timestamptz not null default now(),
  state        text not null default 'building'
               check (state in ('building', 'ready')),
  builder      text,
  search_meta  jsonb
);
-- 轮询等待 / 清理任务按 state 扫描
create index if not exists report_cache_state_idx on report_cache (state, generated_at);


-- -----------------------------------------------------------------------------
-- 3. feed_cache —— 关注流素材缓存（src/utils/cache.ts）
-- -----------------------------------------------------------------------------
-- 只存搜索结果的结构化映射，不存 LLM 产物。
create table if not exists feed_cache (
  id         text primary key,          -- personKey
  items      jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 4. refresh_quota —— 每账号每日主动刷新 ≤10（src/utils/cache.ts）
-- -----------------------------------------------------------------------------
-- id = `${'wx:'+openid}#yyyy-mm-dd`，按天切主键 → 跨天自然重置，无需定时清理。
-- MVP 为读-改-写（代码注释已声明竞态可接受）；若要严格原子，
-- 后续可加一个 increment_quota() 的 rpc（SQL 函数）原子自增。
create table if not exists refresh_quota (
  id    text primary key,
  count int not null default 0 check (count >= 0)
);


-- -----------------------------------------------------------------------------
-- 5. follows —— 关注列表（src/utils/follows.ts）
-- -----------------------------------------------------------------------------
-- id = `${userId}#${personKey}`，主键天然防重。
-- ⚠ person_key 内含 `#` 分隔符（name#domain），可与 id 的 `#` 混淆，
--   因此禁止用 split 反解析，代码走 parsePersonKey()。
create table if not exists follows (
  id          text primary key,
  openid      text not null,
  person_key  text not null,
  name        text not null,
  domain      text not null,
  followed_at timestamptz not null default now()
);
create index if not exists follows_openid_idx on follows (openid, followed_at desc);


-- -----------------------------------------------------------------------------
-- 6. favorites —— 收藏（src/utils/favorites.ts）
-- -----------------------------------------------------------------------------
-- id = `${userId}#${type}#${fnv1a8}`，quote 按内容摘要、report 按 personKey 防重。
-- 代码使用 upsert(..., { onConflict: 'id' }) → onConflict 目标必须存在唯一约束，
-- 故 id 为主键（PostgREST 的 on_conflict 参数直接落到此处）。
create table if not exists favorites (
  id         text primary key,
  openid     text not null,
  type       text not null check (type in ('quote', 'report')),
  payload    jsonb not null default '{}'::jsonb,
  person_key text not null,
  name       text not null,
  created_at timestamptz not null default now()
);
create index if not exists favorites_openid_idx on favorites (openid, created_at desc);


-- -----------------------------------------------------------------------------
-- 7. history —— 查询历史，每账号仅保留最近 50 条（src/utils/history.ts）
-- -----------------------------------------------------------------------------
-- id = `${userId}#${Date.now()}_${rand4}`，永不冲突。
-- 裁剪由客户端 best-effort 执行（range(50, 149) 后按 id 批量删），无需触发器。
create table if not exists history (
  id         text primary key,
  openid     text not null,
  person_key text not null,
  name       text not null,
  ts         timestamptz not null default now()
);
-- 去重查询（取最新一条）+ 裁剪排序都走 openid + ts
create index if not exists history_openid_ts_idx on history (openid, ts desc);


-- -----------------------------------------------------------------------------
-- 8. events —— 埋点（src/utils/events.ts）
-- -----------------------------------------------------------------------------
-- id = `${Date.now()}#${rand6}`；openid 允许 null（未登录也能落事件）。
-- 事件枚举：search / disambiguate_selected / report_hit_cache / report_generate /
--           follow / unfollow / favorite / refresh_feed / share
create table if not exists events (
  id         text primary key,
  openid     text,
  event      text not null,
  person_key text,
  props      jsonb,
  created_at timestamptz not null default now()
);
-- 指标出数口径：按人按时间取首末次出现（留存）、按 event 聚合（命中率）
create index if not exists events_event_created_idx on events (event, created_at desc);
create index if not exists events_openid_created_idx on events (openid, created_at desc);


-- =============================================================================
-- 行级安全（RLS）
-- =============================================================================
-- ⚠ 先按「登录可读写」的 MVP 口径给出；若你的云控制台提供 auth.uid()
--   （Supabase 同款），再把「其余用户表」收紧为 openid = auth.uid()。
--   手册 §二 已把这些列为需实测项。
--
-- 角色名约定：PostgREST 下 `anon` = 未登录，`authenticated` = 已登录。

-- --- report_cache：读放开、写收紧（共享缓存的核心前提） ---------------------
-- 未登录 / 其他用户都要能读 ready 行，否则缓存共享失效。
alter table report_cache enable row level security;

drop policy if exists report_cache_select_public on report_cache;
create policy report_cache_select_public on report_cache
  for select using (true);

drop policy if exists report_cache_insert_auth on report_cache;
create policy report_cache_insert_auth on report_cache
  for insert to authenticated with check (true);

-- 抢锁是 update 带 .or() 条件；若这里写得太紧（例如限制 builder），
-- 会导致抢占失效、并发方一直轮询到超时。故 update 放开。
drop policy if exists report_cache_update_auth on report_cache;
create policy report_cache_update_auth on report_cache
  for update to authenticated using (true) with check (true);

drop policy if exists report_cache_delete_auth on report_cache;
create policy report_cache_delete_auth on report_cache
  for delete to authenticated using (true);


-- --- 其余 7 张表：MVP 口径为登录用户可读写 --------------------------------
-- 发版前建议收紧：using (openid = auth.uid())（users 表为 id = auth.uid()）。
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'feed_cache', 'refresh_quota', 'follows', 'favorites', 'history', 'events'
  ]
  loop
    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists %I on %I', t || '_select_auth', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_select_auth', t
    );

    execute format('drop policy if exists %I on %I', t || '_insert_auth', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (true)',
      t || '_insert_auth', t
    );

    execute format('drop policy if exists %I on %I', t || '_update_auth', t);
    execute format(
      'create policy %I on %I for update to authenticated using (true) with check (true)',
      t || '_update_auth', t
    );

    execute format('drop policy if exists %I on %I', t || '_delete_auth', t);
    execute format(
      'create policy %I on %I for delete to authenticated using (true)',
      t || '_delete_auth', t
    );
  end loop;
end $$;


-- =============================================================================
-- 建表后自检（可选，逐条跑）
-- =============================================================================
-- 1) 八张表都在？
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('users','report_cache','feed_cache','refresh_quota',
--                       'follows','favorites','history','events')
--  order by table_name;            -- 期望 8 行

-- 2) RLS 是否全部开启？
-- select relname, relrowsecurity from pg_class
--  where relname in ('users','report_cache','feed_cache','refresh_quota',
--                    'follows','favorites','history','events');   -- relrowsecurity 应全为 t

-- 3) users 的关键列（漏了 last_seen_at 会导致登录初始化报错）
-- select column_name, data_type from information_schema.columns
--  where table_name = 'users' order by ordinal_position;
