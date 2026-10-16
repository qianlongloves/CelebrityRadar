/**
 * dbInit/schema.js —— 云数据库的「单一事实源」。
 * 与 `../../../README.md` 的「云开发配置 → 集合与权限」一节一一对应：README 讲「为什么」，本文件讲「是什么」。
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
  publicReadOnly: { label: '自定义规则：所有人可读、客户端不可写（写仅限云函数）', rule: { read: true, write: false } },
  /*
   * 客户端完全不可读写（连读都读不到），只有云函数的管理员身份能动。
   * 给「服务端权威数据」用：这类数据的价值恰在于「端上碰不到」——
   * 端上若要展示，读的是别处那份可被它读到的镜像（如 users.membership）。
   */
  cloudOnly: { label: '自定义规则：客户端不可读写（仅云函数）', rule: { read: false, write: false } }
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
    purpose: '账号与设置（首登写入）；membership 是端上读口的**镜像**，权威在 memberships（下方）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('nickname', 'string?', { required: true }),
      f('avatar_url', 'string?', { required: true }),
      /* 用户个性化配置（模型供应商 / 档位）。**真源**：src/config/user-defaults.ts，
         由 npm run config:sync 生成 cloudfunctions/userInit/user-defaults.config.js；
         端上只读、不直写 —— 改配置一律走云函数 userInit 的 set（它是这一列的唯一写者）。
         ⚠ 只放「用户自己能决定的偏好」：本集合是「仅创建者可读写」，端上能改自己那一行，
         任何**影响权限 / 额度 / 计费**的开关都不许放进来（与下面 membership 只是镜像同理），
         云端（aiProxy / quotaGuard）不得读本列做判定。 */
      f('settings', 'object', { required: true }),
      /* 配置结构版本号（userInit 的 ensure 靠它决定「要不要补齐缺失的键」）。
         老用户的行没有这个字段 —— def 给 1 而不是 null：语义上「老行的空配置」就是版本 1，
         回填是无损的。靠它，加配置项不需要迁移脚本。 */
      f('settings_version', 'number', { def: 1 }),
      f('created_at', 'string', { required: true }),
      f('last_seen_at', 'string?', { def: null }),
      f('subscribe_ok', 'boolean', { def: false }),
      f('subscribe_at', 'string?', { def: null }),
      /* 关键词预警推送的授权位（2026-10-08）。与 subscribe_ok 分开是必须的：
         微信一次性订阅的授权**按模板**消耗，两个模板两枚授权，共用一个布尔位
         会让两个定时任务互相吃掉对方的授权（一个推成功、另一个必得 43101）。 */
      f('alert_ok', 'boolean', { def: false }),
      /* 风险提醒推送的授权位（2026-10-09，第 1 期 riskWatch）。与 alert_ok 分开同样是必须的：
         微信一次性订阅按**模板**消耗授权，两个定时任务共用一个布尔位就会出现
         「先跑的吃掉授权，后跑的必得 43101」。 */
      f('risk_ok', 'boolean', { def: false }),
      f('membership', 'object?', { def: null })
      /* ⚠ 上面这条是**镜像**：云端的会员判定（aiProxy 的档位闸门与配额闸门、quotaGuard 的
         免计费复核）一律读下面的 memberships。理由：users 的权限是「仅创建者可读写」，
         端上能改自己那一行 —— 以它为准等于把会员身份交给客户端自证
         （自授会员 = 白用最贵模型 + 生成不计费）。镜像存在的唯一理由是端上所有界面都读它，
         于是这次搬迁对端上零改动。两者由 payCallback 一次写入，一致性命中靠用例钉住。 */
    ],
    indexes: [
      ix('idx_subscribe_ok', [['subscribe_ok', 'asc']], { optional: true, supports: '云函数筛「已授权提醒」的用户' }),
      /* P2-11（2026-10-09）：另两个定时推送也按各自的授权位筛人。原先只有 subscribe_ok 一条，
         `keywordAlert` / `riskWatch` 筛 `alert_ok` / `risk_ok` 时是全表扫 —— 与「只取一批 100 行」
         叠加后更隐蔽：慢、而且拿到的还不是「前 100 个符合条件的人」。三个授权位各一条单字段索引。 */
      ix('idx_alert_ok', [['alert_ok', 'asc']], { optional: true, supports: 'keywordAlert 筛「已授权预警推送」的用户' }),
      ix('idx_risk_ok', [['risk_ok', 'asc']], { optional: true, supports: 'riskWatch 筛「已授权风险提醒」的用户' })
    ]
  },
  {
    name: 'memberships',
    purpose: '会员权益的**服务端权威**（_id = openid，_openid 冗余存一份便于人工排查）：只由云函数 payCallback 发货与退款撤销时写',
    acl: ACL.cloudOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      /* 用户最后一次购买的档位（只决定天数，判定只认 expires_at —— 与端上口径一致） */
      f('plan', 'string?', { required: true }),
      f('expires_at', 'string', { required: true }),
      /* 幂等标记：同一订单只发一次货（跨权威行与 users 镜像行判，见 payCallback/grantMembership） */
      f('last_order_id', 'string?', { required: true }),
      /* 幂等标记：已按哪些订单撤销过会员天数（2026-10-09 新增，P1-6）。
         名单与被扣后的 expires_at 写在**同一次 set**里，所以「扣了」与「记了」必然同时发生 ——
         这正是它比订单行上的 refund_revoked_at 更可靠的地方：后者要多一次写，中途失败就会再扣一遍。
         只保留最近若干条（见 payCallback/after-sales.js 的 REFUND_LOG_MAX）。 */
      f('refunded_orders', 'array?', { def: [] }),
      f('updated_at', 'string?', { def: null }),
      /* 镜像对账的轮转游标（P2-23，2026-10-09）：payReconcile 第 ② 步按它升序取一批校验，
         校验完写回当前时间 ⇒ 下一轮排到队尾，N 行数据最多 ⌈N/100⌉ 轮全部轮到。
         它不是会员数据，只是「上次校验时间」；payCallback 发货/退款用的整篇 set 会自然清掉它，
         于是那一行会重新排回队首再校验一次 —— 正是我们想要的。 */
      f('mirror_checked_at', 'string?', { def: null })
    ],
    /* 主键（_id = openid）满足所有单点取；这里只为对账轮转加一条升序索引，
       让 orderBy('mirror_checked_at').limit(100) 不必全表排序。 */
    indexes: [
      ix('idx_mirror_checked_at', [['mirror_checked_at', 'asc']], {
        optional: true,
        supports: 'payReconcile 镜像对账：按最久未校验升序轮转（缺失字段的行排最前，优先校验新发货的行）'
      })
    ]
  },
  {
    name: 'ai_calls',
    purpose: '防滥用限速计数（_id = openid#yyyy-MM-dd）：aiProxy 在放行上游调用前就地原子自增，端上不可读写',
    acl: ACL.cloudOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('count', 'number', { required: true }),
      f('date', 'string', { required: true })
    ],
    indexes: []
  },
  {
    name: 'report_cache',
    /* P0-2（2026-10-09）：客户端改为**只读**，抢锁 / 落库一律走云函数 `aiProxy`(`action:'report'`)。
     * 原先「登录可写」等于把全站共享缓存的写权交给任意登录用户：可覆盖任意 `personKey` 的
     * 报告正文（伪造结论 / 诽谤 / 删掉会员段）、可写 `state=building` 让全站对该人物的查询排队。
     *
     * ⚠ **收紧顺序不可颠倒**（同 quotaGuard 那条）：先部署带写口的 aiProxy 并发布端上
     *   （端上写口不可用时回退直写；直写失败降级为「不写缓存但照常出报告」，不抛错），
     *   待旧版本覆盖率达标后，才在控制台把本集合改成 `{"read": true, "write": false}`。
     *   先收紧 = 未更新的端上一进报告页就写锁失败，直接报错、拿不到报告。 */
    purpose: '报告缓存 + building 生成互斥锁（全局共享）：客户端只读，写入走云函数 aiProxy(action:report)',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('report', 'object?', { required: true }),
      f('generated_at', 'string', { required: true }),
      f('state', 'string', { required: true, enumHint: ['building', 'ready'] }),
      f('builder', 'string?', { required: true }),
      /*
       * 首建标记（2026-10-15）：**只在写口建新行那一条 insert 里**写（`!existing` 即
       * 「全站第一次建这个人物」），抢占 / 覆盖一概不写 —— 所以「同一人物只可能被免一次计费」
       * 是数据结构自带的，不靠额外记账。
       * 消费方只有 quotaGuard：复核 `waiveIf:'first_build'` 的免计费申请时，比对
       * `first_build_owner` 与调用者、用 `first_build_at` 划出「刚发生的那一次」的时间窗，
       * 发放豁免后就地回写 `first_build_waived_at` 防止重复领。
       * 客户端只读（伪造不了）；也不参与任何读取判定 —— 缺字段（老行 / 端上回退直写的行）
       * 一律按「不免」处理。
       */
      f('first_build_owner', 'string?', { def: null }),
      f('first_build_at', 'string?', { def: null }),
      f('first_build_waived_at', 'string?', { def: null }),
      f('search_meta', 'object?', { def: null }),
      /* 分批生成的中间结果（P0-B，2026-10-11；写口 `op:'saveParts'`）。
         元素 = `{ key: 'identity'|'facts'|'judgement'|'detail', data: {…该批字段} }`。
         只在「正在按批生成」的空窗里有值：acquire 清空、save/release 一并清掉，
         故 def 为 null；它不参与任何读取判定，纯粹用于排障与「不白费已花的 token」。 */
      f('parts', 'array?', { def: null }),
      /* 报告 Schema 版本（前置项，2026-10-09；取值见 src/utils/report.ts#REPORT_SCHEMA_VERSION）。
         **故意不给 def**：缺失 = 版本未知的老报告，读取方按 1 处理。若在这里 def 成当前版本，
         巡检回填会把第一批的老报告一并标成新版本，这个字段就失去意义了。 */
      f('schemaVersion', 'number?')
    ],
    indexes: [ix('idx_state', [['state', 'asc']], { optional: true, supports: '运维扫描 building 脏行' })]
  },
  {
    name: 'report_versions',
    /* 报告历史版本（S3-1 ③，2026-10-16）：`report_cache` 一人一份、`force` 重生即整篇替换，
     * 旧版就此永久消失。本表存**被覆盖掉的那一版**，让「这份报告以前是怎么写的」可回溯。
     *
     * ⚠ 写入**只发生在写口内部**（`aiProxy` 的 `action:'report'` + `op:'save'` 里、落库成功之后，
     *   见 report-store.js#recordVersion），客户端不可写 —— 与 report_cache 同一处境、同一收紧口径。
     *
     * ⚠ 与 report_cache 一样，**行内不含任何用户标识**（`_id` = `<personKey>#<旧版生成时间>`）：
     *   它是「全站共享事实的一段历史」，不是「我的那一行」—— 注销时无需按用户删。
     *   用例 18 的「注销删表清单与 schema 对齐」把它放进「行内无用户标识」白名单，改动前先看那里。
     *
     * ⚠ 保留策略在写口（`REPORT_VERSION_KEEP = 5`，每次覆盖顺手裁旧）：本表不会无限增长，
     *   所以它**不需要**任何定时清理任务。
     */
    purpose:
      '报告历史版本（被覆盖掉的旧版全文，全局共享）：客户端只读，写入走云函数 aiProxy(action:report, op:save) 的落库之后',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      /* 这一版是什么时候生成的（取自旧版 report.generatedAt，取不到则退回旧行的 generated_at） */
      f('generated_at', 'string', { required: true }),
      /* 它是什么时候被覆盖掉的：页面上「X 更新过，上一版是 Y」讲的是这两个时间的差 */
      f('replaced_at', 'string', { required: true }),
      f('report', 'object', { required: true }),
      /* 旧版对应的素材条数（该行当时的 search_meta.news_count）：列表用它比「这次素材多了还是少了」 */
      f('news_count', 'number', { required: true }),
      /* 报告 Schema 版本，**故意不给 def**（同 report_cache 的口径：缺失 = 版本未知的老报告） */
      f('schemaVersion', 'number?')
    ],
    /* 只为「按人物取历史」建一条索引。排序键刻意用 `_id` ——
       `_id` = `<personKey>#<生成时间>`，同人物下的字典序即时间序，且主键天生有索引，
       所以列表查询不依赖本索引也能排对（索引缺失/排序内存超限时的兜底，见 report-store#trimVersions）。 */
    indexes: [
      ix('idx_person_key', [['person_key', 'asc']], {
        optional: true,
        supports: '按人物取历史版本列表（端上 report-history 页；排序走 _id，故索引只用于过滤）'
      })
    ]
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
    /* 同 report_cache（P0-2）：客户端只读，写入走 aiProxy 的写口（`op:'saveFeed'`）。
     * 它比 report_cache 简单（无锁、无会员差异），但同为「全局共享 + 端上可写」——
     * 任意登录用户可覆盖任意人物的动态列表。收紧顺序同上，两张表一起切。 */
    purpose: '检索结果结构化映射（不存 LLM 产物），全局共享：客户端只读，写入走云函数 aiProxy(action:report, op:saveFeed)',
    acl: ACL.publicReadOnly,
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
    purpose:
      '报告每日生成配额（免费 3 / 会员 30，_id = openid#yyyy-MM-dd）+ 首建豁免名额（waive_count）',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('count', 'number', { required: true }),
      /*
       * 当日「首建免计费」用掉的名额（2026-10-15，上限 1 次/日，理由见 quotaGuard 的「首建」一节）。
       * 与 count 同处一行是刻意的：那一行本来就是「某人某天」的天然容器，豁免名额也就该按天算；
       * 单开一张集合反而要在控制台手建 + 收紧权限，漏一步就静默失效。
       * 只由 quotaGuard 原子自增 / 回滚；端上（selfRead）读得到也没用 —— 名额由服务端发放。
       */
      f('waive_count', 'number?', { def: 0 })
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
    purpose: '会员订单状态机（pending → granting → paid / failed / refunded）；paid = 已发货完成，回调据此发货；refunded 由运营写口置入，对账任务据此撤销会员；端上只读',
    acl: ACL.selfRead,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('_openid', 'string', { system: true, required: true }),
      f('plan', 'string', { required: true }),
      f('amount_fen', 'number', { required: true }),
      f('days', 'number', { required: true }),
      f('status', 'string', { required: true, enumHint: ['pending', 'granting', 'paid', 'failed', 'refunded'] }),
      f('created_at', 'string', { required: true }),
      /* 收到支付成功通知的时刻（抢到发货权时写） */
      f('paid_at', 'string?', { def: null }),
      /* 发货完成时刻（users.membership 已写入）。granting 残留 = paid_at 有值而 granted_at 为空，
         即「付了钱还没拿到会员」：微信重试会继续发货补救；重试耗尽（退避 24 小时）后由
         payCallback 的定时对账 `payReconcile` 扫出来补发，仍补不上才是人工介入 */
      f('granted_at', 'string?', { def: null }),
      f('transaction_id', 'string?', { def: null }),
      f('callback_fee', 'number?', { def: null }),
      /* ↓ 退款（2026-10-09 新增，P1-6）：退款发生在微信商户平台，业务侧唯一的信号是人工告知，
         由 payCallback 的运营写口 `adminOp:'refund'` 落成这次状态迁移 —— 端上永远写不了 refunded */
      f('refunded_at', 'string?', { def: null }),
      f('refund_reason', 'string?', { def: null }),
      /* 对账已按这一单撤销过会员的时刻。**幂等标记**：扣天数必须只扣一次，
         而「撤销」与「标记」之间没有事务，所以标记只在撤销成功（或确认无需撤销）之后才写 */
      f('refund_revoked_at', 'string?', { def: null }),
      /* 撤销结果说明：扣了几天，或为什么没扣（未发过货 / 权威行缺失） */
      f('refund_revoke_note', 'string?', { def: null }),
      /* 对账自动补救失败次数（P2-24，2026-10-09）。存在的唯一目的是**队列公平性**：
         对账每轮按它升序取单，坏单失败一次就往后沉一位，最多 MAX_RECONCILE_ATTEMPTS 轮
         就沉到队尾、不再占名额（否则一条永远补不成的单会把 20 个名额慢慢吃光，
         后面的单再也排不进来）。到上限后不再自动重试，只留日志等人工。 */
      f('reconcile_attempts', 'number?', { def: 0 })
    ],
    indexes: [
      ix('idx_openid_created_at', [['openid', 'asc'], ['created_at', 'desc']], { optional: true, supports: '客服按用户查单' }),
      /* 对账任务每小时按 status 扫两类残留（granting / refunded），P2-24 起还要按排序键取单。
         排序键必须进索引，否则 orderBy 会在内存里排全表（云函数侧有内存与耗时上限）。
         原先声明的 idx_status_paid_at 已被下面两条取代，控制台里若还留着可以手工删（留着只是白付写放大）。 */
      ix('idx_status_attempts_id', [['status', 'asc'], ['reconcile_attempts', 'asc'], ['_id', 'asc']], {
        optional: true,
        supports: 'payCallback 对账①③：两类残留（granting / 待撤销退款单）共用 —— 按「失败次数 + 下单时间」升序，坏单沉底'
      })
    ]
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
      /* 订阅类型：'keyword' 关键词（第 0 期 keywordAlert）/ 'person' 监控某人（第 1 期 riskWatch）。
         `def: 'keyword'` 正好把 2026-10-09 之前的老行标成关键词订阅；端上与云函数仍按
         「缺失 = keyword」读，因为回填只在跑过 dbInit 的环境才生效。 */
      f('type', 'string', { def: 'keyword', enumHint: ['keyword', 'person'] }),
      /* type='person' 时才有意义：人名存在 keyword 字段里（复用同一张表的显示与读取逻辑），
         真正的主键用 person_key（人名可能重名，person_key 带领域消歧）。 */
      f('person_key', 'string?', { def: null }),
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
  },
  /* ↓ 名人风险监控（2026-10-09，第 1 期）：三张表分工 = 「在监控谁」复用 keyword_watches
     （type='person'）、「上次扫到哪」= risk_scans、「扫到了什么」= risk_signals */
  {
    name: 'risk_scans',
    purpose: '名人风险扫描快照（_id = personKey，云函数写、端上只读）：判断「哪些条目是新的」',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      f('scanned_at', 'string', { required: true }),
      /* 首次扫描时刻：只把这一刻**之后**新出现的条目当信号。首轮只建档、不落信号也不推送 ——
         否则用户刚加监控，就会收到一串「历史报道里的旧表述」提醒（典型误报）。 */
      f('baseline_at', 'string', { required: true }),
      f('seen_urls', 'array', { required: true }),
      f('scanned', 'number', { def: 0 }),
      f('signals_total', 'number', { def: 0 })
    ],
    indexes: []
  },
  {
    name: 'risk_signals',
    purpose: '风险信号流水（_id = personKey#url 哈希，云函数写、端上只读）',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      /* 级别只由「命中的是哪一类词」决定，不是对事件的定性；端上仅用于排序与推送门槛 */
      f('level', 'string', { required: true, enumHint: ['high', 'mid', 'low'] }),
      f('category', 'string', { required: true, enumHint: ['judicial', 'tax', 'contract', 'rights', 'statement'] }),
      f('category_label', 'string', { required: true }),
      f('keyword', 'string', { required: true }),
      f('title', 'string', { required: true }),
      f('quote', 'string', { required: true }),
      f('source', 'string', { required: true }),
      f('url', 'string', { required: true }),
      /* 我们自己的时钟打的「第一次见到这条」：不用媒体发布时间判断新旧（同 keywordAlert 取舍 4） */
      f('first_seen_at', 'string', { required: true }),
      /* 媒体发布时间（上游 datePublished / dateLastCrawled，2026-10-16 补）。与 first_seen_at 分列两个字段：
         ①判新旧仍用 first_seen_at（上游的「发布时间」可能是 3 天前甚至是抓取时间，拿它判新旧会漏报）；
         ②但时间线上「谁在何时说的」必须是媒体发布时间 —— 拿首见时刻充数会把「我们何时发现」
         读成「事件何时发生」。故 opinionCluster#collectSources 优先取本字段、缺失才退回 first_seen_at。
         老行没有本字段（def null），自动退回旧口径，无需迁移。 */
      f('published_date', 'string?', { def: null })
    ],
    indexes: [
      ix('idx_person_key_first_seen_at', [['person_key', 'asc'], ['first_seen_at', 'desc']], {
        supports: 'listRiskSignals()：按人取信号、新的在前'
      })
    ]
  },
  {
    name: 'scan_logs',
    purpose: '监控执行日志（关键词 / 名人各一条流，云函数 keywordAlert / riskWatch 写、端上只读）',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      /* keyword = 关键词预警那一路；person = 名人风险监控那一路 */
      f('kind', 'string', { required: true, enumHint: ['keyword', 'person'] }),
      /* 被扫描的对象：关键词原文（keyword）或 personKey（person） */
      f('object_key', 'string', { required: true }),
      /* 显示名：关键词 = 词本身；名人 = 姓名 */
      f('object_name', 'string', { required: true }),
      /* 本轮执行时刻（我们自己的时钟，ISO） */
      f('ran_at', 'string', { required: true }),
      /* ok = 扫到结果；skipped = 缓存够新、本轮未打上游；error = 上游失败 */
      f('status', 'string', { required: true, enumHint: ['ok', 'skipped', 'error'] }),
      /* 命中数：关键词 = 本轮新报道条数；名人 = 本轮新信号条数 */
      f('hit', 'number', { def: 0 }),
      /* 结果总数：关键词 = 本轮检索返回条数；名人 = 本轮检索返回条数 */
      f('total', 'number', { def: 0 }),
      /* 简短说明：error 的失败原因 / skipped 的复用理由 / ok 的命中摘要 */
      f('note', 'string?', { def: '' })
    ],
    indexes: [
      ix('idx_kind_object_ran_at', [['kind', 'asc'], ['object_key', 'asc'], ['ran_at', 'desc']], {
        supports: '监控页按「类型 + 对象」取最近执行日志'
      })
    ]
  },
  /* ↓ 事件驱动深挖的单日预算计数（P4-A，2026-10-13）—— 见 benefits.ts#DEEP_DIVE */
  {
    name: 'deep_dive_quota',
    /*
     * 定时任务「命中即深挖」的**单日成本闸门**计数（_id = yyyy-MM-dd，+8 时区切天）。
     * 为什么单独一张表：单轮预算在云函数**一次调用内存**里递减即可（同轮不可能超发），
     * 但**单日**上限要跨轮累计，必须落库；而它和用户配额（generate_quota 等）是两回事
     * （这是**平台成本闸门**，不与任何用户/会员档挂钩），混进用户配额表会污染其语义。
     * 客户端完全不可读写：它是服务端成本边界，绝不能被端上看到 / 篡改。
     */
    purpose: '事件驱动深挖的单日预算计数（_id = yyyy-MM-dd）：云函数 keywordAlert/riskWatch 写、客户端不可读写',
    acl: ACL.cloudOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('date', 'string', { required: true }),
      f('count', 'number', { def: 0 }),
      f('updated_at', 'string?', { def: null })
    ],
    indexes: []
  },
  /* ↓ 舆情事件落库（P4，2026-10-13）：两张表分工 = 「事件本体（全站共享、只读）」与「个人状态（各人一份）」 */
  {
    name: 'opinion_events',
    purpose:
      '舆情事件（_id = event_key，云函数 opinionCluster 定时**读库**聚类后写、端上只读）：全站共享，字段与端上 OpinionEvent 同名同义（少 hitsKeyword/hitsFollow 这两项按用户现算的）',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      /* 稳定主题键（= _id）：由 objectKey(#themeToken) 哈希而来，同事件新增报道时保持不变（见 utils/opinion-events.ts） */
      f('event_key', 'string', { required: true }),
      f('object_key', 'string', { def: '' }),
      f('block', 'string', { required: true, enumHint: ['feed', 'weekly', 'alert'] }),
      f('title', 'string', { required: true }),
      f('members', 'array', { required: true }),
      f('memberCount', 'number', { def: 0 }),
      /* 去重后的**真实**来源条数（≥ memberCount）：事件卡的「N 条来源」报的是这个。
         memberCount 会被 MAX_MEMBERS=30 截断，拿它当来源数会把爆点事件说成「30 条来源」。
         ⚠ **刻意不给 def**（2026-10-16）：标了 `def` 的缺失字段会被 dbInit 的 fields(apply) 回填成该值，
         而老行回填成 0 会让事件卡显示「0 条来源」—— 端上只在**缺字段**（undefined）时才回落成员数，
         拿到 0 会当成真值。不给 def ⇒ 老行保持缺字段 ⇒ 端上回落成员数（比 0 诚实的近似）；
         库里的老行也会在下一次 opinionCluster 每日聚类重写时自然补上真值。 */
      f('memberTotal', 'number'),
      f('timeline', 'array', { def: [] }),
      f('sources', 'array', { def: [] }),
      f('labels', 'array', { def: [] }),
      f('impact', 'string', { required: true, enumHint: ['high', 'mid', 'low', 'unknown'] }),
      f('credibility', 'string', { required: true, enumHint: ['official', 'multi', 'single', 'unknown'] }),
      f('response', 'string', { required: true, enumHint: ['respond', 'watch', 'none', 'unknown'] }),
      f('first_at', 'string', { def: '' }),
      f('last_at', 'string', { def: '' }),
      f('updated_at', 'string', { required: true })
    ],
    indexes: [
      ix('idx_last_at', [['last_at', 'desc']], { optional: true, supports: '端上按最近活动时间取事件' }),
      /* 事件时间线页按 `event_key` 只取**这一条**（见 opinion-store#loadStoredEventByKey）；
         没有它，每次进详情页都得扫全表。`event_key` 唯一，单个升序键即可 */
      ix('idx_event_key', [['event_key', 'asc']], {
        optional: true,
        supports: '按 event_key 单条读取（事件时间线页）'
      }),
      /* 云函数每轮按 updated_at 降序取「最近更新的 N 条」来沿用旧键（见 opinionCluster#listRecent）；
         没有它，每轮比较都要对全表排序 */
      ix('idx_updated_at', [['updated_at', 'desc'], ['_id', 'asc']], {
        optional: true,
        supports: '云函数每轮按「最近更新」取事件比对旧键'
      })
    ]
  },
  {
    name: 'opinion_event_status',
    purpose:
      '用户对舆情事件的个人状态（_id = openid，端上读写自己那一行）：只放**已读标记**与**跟进状态（含时间）**两项，map 有条数上限与裁剪（见 utils/opinion-store.ts）',
    acl: ACL.creator,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      /* event_key → 已读时刻（ISO）。用对象而非数组：按 key 直接取，且天然去重 */
      f('reads', 'object', { def: {} }),
      /* event_key → 跟进时刻（ISO）。缺省 = 未跟进 */
      f('follows', 'object', { def: {} }),
      f('updated_at', 'string', { def: null })
    ],
    indexes: []
  },
  {
    name: 'person_assets',
    /*
     * 人物素材（目前只有头像/照片）：_id = personKey，云函数写、端上只读。
     *
     * 为什么不塞进 report_cache.report：报告是**按批生成、一次落库**的大对象，
     * 而头像要「生成之后再补、失败了也不影响报告」；两者生命周期不同（报告刷新会重写整篇，
     * 头像却该长期复用）。独立一张表也让端上多处的列表页能**单独读**这一个人物素材，
     * 不必为了一个头像去拉整份报告。
     */
    purpose: '人物素材（头像/照片，_id = personKey）：云函数 aiProxy(action:portrait) 写、端上只读',
    acl: ACL.publicReadOnly,
    fields: [
      f('_id', 'string', { system: true, required: true }),
      f('person_key', 'string', { required: true }),
      f('name', 'string', { required: true }),
      /* 云存储 fileID（cloud://…）：<Image src> 可直接用，且不受 downloadFile 合法域名限制 */
      f('avatar_file_id', 'string', { required: true }),
      /* 图片来源页（排障用：一眼看出这张图是从哪一站抓的） */
      f('source_url', 'string?', { def: null }),
      f('width', 'number', { def: 0 }),
      f('height', 'number', { def: 0 }),
      f('bytes', 'number', { def: 0 }),
      f('updated_at', 'string', { required: true })
    ],
    indexes: []
  }
]

/** 集合名单（建集合用） */
const collectionNames = collections.map((c) => c.name)

module.exports = { DIRECTION, ACL, collections, collectionNames }
