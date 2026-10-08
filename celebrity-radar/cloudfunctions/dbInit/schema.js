/**
 * dbInit/schema.js —— 云数据库的「单一事实源」。
 * 与 `doc/云开发配置手册.md` 一一对应：文档讲「为什么」，本文件讲「是什么」。
 * 字段依据：`src/types/db.ts` + `src/utils/{auth,follows,favorites,history,cache,quota,events}.ts`。
 *
 * 字段标记（决定 dbInit 的写行为）：
 *   system: true  系统字段（`_id` / `_openid`），**永不回填**（`_id` 不可改，`_openid` 补错等于把行判给别的用户）
 *   required: true 缺失 = 数据有问题 ⇒ 只报告、不回填（用默认值盖住异常会让问题永远查不出来）
 *   def: <值>      缺失 = 版本演进 ⇒ `apply` 时按此值补齐（幂等的 ADD COLUMN ... DEFAULT）
 *   enumHint       **只告警不失败**（如埋点事件会随版本新增）
 *
 * 为什么索引名钉死在本文件：微信 HTTP API「更新索引」只能按**索引名**新增 / 删除，
 * 且没有「列出索引」的能力 ⇒ 名字一旦手改，rebuild 删不掉旧名、库里会留一条孤儿索引。
 */

const DIRECTION = { asc: '1', desc: '-1', geo: '2dsphere' }

const ACL = {
  creator: { label: '仅创建者可读写', rule: null },
  publicRead: { label: '自定义规则：所有人可读、登录可写', rule: { read: true, write: 'auth.openid != null' } },
  selfRead: { label: '自定义规则：本人可读、不可写（写仅限云函数）', rule: { read: 'doc._openid == auth.openid', write: false } },
  publicReadOnly: { label: '自定义规则：所有人可读、客户端不可写（写仅限云函数）', rule: { read: true, write: false } }
}

/** 字段简写：type 带 `?` 表示 nullable（允许显式写入 null） */
const f = (name, type, o = {}) => ({
  name,
  type: type.replace('?', ''),
  nullable: type.endsWith('?'),
  ...o
})

/** 索引简写：keys = [[字段, 'asc'|'desc'|'geo'], ...]，顺序敏感（须与查询顺序一致） */
const ix = (name, keys, o = {}) => ({
  name,
  unique: false,
  keys: keys.map(([field, dir]) => ({ field, dir })),
  ...o
})

const collections = [
  {
    name: 'users',
    purpose: '账号与设置（首登写入；membership 由支付回调写，端上只读）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('nickname', 'string?', { required: true }),
      f('avatar_url', 'string?', { required: true }),
      f('settings', 'object', { required: true }),
      f('created_at', 'string', { required: true }),
      f('last_seen_at', 'string?', { def: null }),
      f('subscribe_ok', 'boolean', { def: false }),
      f('subscribe_at', 'string?', { def: null }),
      /* 关键词预警推送的授权位（2026-10-08）。与 subscribe_ok 分开是必须的：
         微信一次性订阅的授权**按模板**消耗，两个模板两枚授权，共用一个布尔位
         会让两个定时任务互相吃掉对方的授权（一个推成功、另一个必得 43101）。 */
      f('alert_ok', 'boolean', { def: false }),
      f('membership', 'object?', { def: null })
    ],
    indexes: [ix('idx_subscribe_ok', [['subscribe_ok', 'asc']], { optional: true, supports: '云函数筛「已授权提醒」的用户' })]
  },
  {
    name: 'report_cache',
    purpose: '报告缓存 + building 生成互斥锁（全局共享）',
    acl: ACL.publicRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('report', 'object?', { required: true }),
      f('generated_at', 'string', { required: true }),
      f('state', 'string', { required: true, enumHint: ['building', 'ready'] }),
      f('builder', 'string?', { required: true }),
      f('search_meta', 'object?', { def: null })
    ],
    indexes: [ix('idx_state', [['state', 'asc']], { optional: true, supports: '运维扫描 building 脏行' })]
  },
  {
    name: 'hot_board',
    purpose: '热门名人榜（AI 每日生产，_id 固定 latest 覆盖写；端上只读）',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('items', 'array', { required: true }),
      f('generated_at', 'string', { required: true }),
      f('date', 'string', { required: true }),
      f('model', 'string?', { def: null })
    ],
    indexes: []
  },
  {
    name: 'feed_cache',
    purpose: '检索结果结构化映射（不存 LLM 产物），全局共享',
    acl: ACL.publicRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('items', 'array', { required: true }),
      f('fetched_at', 'string', { required: true })
    ],
    indexes: []
  },
  {
    name: 'refresh_quota',
    purpose: '关注流每日主动刷新 ≤10 次（_id = openid#yyyy-MM-dd）',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('count', 'number', { required: true })
    ],
    indexes: []
  },
  {
    name: 'generate_quota',
    purpose: '报告每日生成配额（免费 3 / 会员 30，_id = openid#yyyy-MM-dd）',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('count', 'number', { required: true })
    ],
    indexes: []
  },
  {
    name: 'ask_quota',
    purpose: 'AI 提问每日配额（免费 5 / 会员 30，_id = openid#yyyy-MM-dd；成功才计数）',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('count', 'number', { required: true })
    ],
    indexes: []
  },
  {
    name: 'follows',
    purpose: '关注列表（_id = openid#personKey）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('openid', 'string', { required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      f('domain', 'string', { required: true }),
      f('followed_at', 'string', { required: true })
    ],
    indexes: [
      ix('idx_openid_followed_at', [['openid', 'asc'], ['followed_at', 'desc']], { supports: 'listFollows()：openid 过滤 + 关注时间倒序' })
    ]
  },
  {
    name: 'favorites',
    purpose: '收藏（四类，_id = openid#type#hash 主键防重）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('openid', 'string', { required: true }),
      f('type', 'string', { required: true, enumHint: ['quote', 'report', 'dynamic', 'timeline'] }),
      f('payload', 'object', { required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      f('created_at', 'string', { required: true })
    ],
    deprecated: [{ name: 'note', since: '2026-10-06', note: '备注功能下线，端上不再读写；历史残留无需清理（purgeDeprecated 才删）' }],
    indexes: [
      ix('idx_openid_created_at', [['openid', 'asc'], ['created_at', 'desc']], { supports: 'listFavorites()：openid 过滤 + 时间倒序' }),
      ix('idx_openid_type_created_at', [['openid', 'asc'], ['type', 'asc'], ['created_at', 'desc']], { optional: true, supports: '收藏页按类型筛选' })
    ]
  },
  {
    name: 'history',
    purpose: '浏览历史（保留最近 50 条）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('openid', 'string', { required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      f('ts', 'string', { required: true })
    ],
    indexes: [ix('idx_openid_ts', [['openid', 'asc'], ['ts', 'desc']], { supports: 'listHistory() / pruneHistory()（含 range(50,149) 裁剪）' })]
  },
  {
    name: 'events',
    purpose: '埋点（9 类 + 周报 weekly_generate + 消息中心 messages_open）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('openid', 'string?', { required: true }),
      f('event', 'string', { required: true, enumHint: ['search', 'disambiguate_selected', 'report_hit_cache', 'report_generate', 'follow', 'unfollow', 'favorite', 'refresh_feed', 'share', 'weekly_generate', 'messages_open'] }),
      f('person_key', 'string?', { required: true }),
      f('props', 'object?', { required: true }),
      f('created_at', 'string', { required: true })
    ],
    indexes: [
      ix('idx_openid_created_at', [['openid', 'asc'], ['created_at', 'desc']], { optional: true, supports: '留存口径' }),
      ix('idx_event_created_at', [['event', 'asc'], ['created_at', 'desc']], { optional: true, supports: '缓存命中率口径' })
    ]
  },
  {
    name: 'orders',
    purpose: '会员订单状态机（pending → paid / failed），回调据此发货；端上只读',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('plan', 'string', { required: true }),
      f('amount_fen', 'number', { required: true }),
      f('days', 'number', { required: true }),
      f('status', 'string', { required: true, enumHint: ['pending', 'paid', 'failed', 'refunded'] }),
      f('created_at', 'string', { required: true }),
      f('paid_at', 'string?', { def: null }),
      f('transaction_id', 'string?', { def: null }),
      f('callback_fee', 'number?', { def: null })
    ],
    indexes: [ix('idx_openid_created_at', [['openid', 'asc'], ['created_at', 'desc']], { optional: true, supports: '客服按用户查单' })]
  },
  /* ↓ 关键词舆情预警（2026-10-08）：两张表分工 = 「谁在听什么」与「听到了什么」 */
  {
    name: 'keyword_watches',
    purpose: '关键词订阅（_id = openid#关键词哈希，与 follows 同构；端上读写）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('openid', 'string', { required: true }),
      f('keyword', 'string', { required: true }),
      f('created_at', 'string', { required: true }),
      /* 我在预警页最后一次看这个词的时间；端上据此判断「哪些条目是新的」。
         放端上写（而不是云函数）是因为「看过没有」只有端上知道。 */
      f('seen_at', 'string?', { def: null })
    ],
    indexes: [
      ix('idx_openid_created_at', [['openid', 'asc'], ['created_at', 'desc']], { supports: 'listWatches()：openid 过滤 + 订阅时间倒序' })
    ]
  },
  {
    name: 'keywords',
    purpose: '关键词检索缓存（_id = 关键词哈希，全局共享，定时任务写、端上只读）',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('keyword', 'string', { required: true }),
      f('items', 'array', { required: true }),
      f('fetched_at', 'string', { required: true }),
      /* 订阅人数：只用于「这个词有没有人在听」的运维观察，不参与排序（排序按 fetched_at 轮转，见云函数） */
      f('watchers', 'number', { def: 0 })
    ],
    indexes: []
  }
]

/** 集合名单（建集合用） */
const collectionNames = collections.map((c) => c.name)

module.exports = { DIRECTION, ACL, collections, collectionNames }
