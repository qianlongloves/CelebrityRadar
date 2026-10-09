/**
 * aiProxy/report-store.js —— 共享缓存写口（P0-2，2026-10-09）。
 *
 * 为什么写口落在 aiProxy 而不是另开云函数：这里已经具备写口恰好需要的四件东西 ——
 * 「取调用者身份 + 会员权威判定 + 防滥用限速 + 统一错误约定」。再开一个函数等于把它们
 * 重写一遍，还要多养一次部署。
 *
 * 它要解决的是 P0-2：`report_cache` / `feed_cache` 原先对客户端是「所有人可读、登录可写」，
 * 而这两张表是全局共享的事实源（报告那张还兼作生成互斥锁）—— 任意登录用户可覆盖任意
 * personKey 的报告正文、抹掉会员段、或写 store=building 让全站对该人物排队。
 * 权限收紧成 `{"read": true, "write": false}` 之后，端上唯一还能写进来的路就是这里。
 *
 * ⚠ 写口能保证与**不能**保证的（别高估）：
 *   · 能：只能写自己持锁的那一行；非会员写不进会员段；形状 / 体积受检；调用留痕可审计。
 *   · 不能：内容**质量**。报告是端上生成的，而「生成」本是产品允许的行为 —— 要根治
 *     「端上构造共享内容」这个更大的信任缺口，得把生成整体搬上云（路线图里的事）。
 *
 * 权限收紧顺序（与 quotaGuard 同理，颠倒会打掉在用的端上）：
 *   先部署本函数并发布端上（端上写口不可用时回退直写，直写失败降级为「不写缓存但照常出报告」）
 *   → 待旧版本覆盖率达标 → 才在控制台把两张表改成客户端不可写。
 *
 * 依赖由 index.js 注入（不自行 require wx-server-sdk）：`db` / `cloud` / `isActiveMember` /
 * `bumpAbuseCount` / `todayKey` / `failDetail` —— 全部复用 index.js 里已有的那一份，
 * 免得同一个函数里出现两套会员判定或两套计数口径。
 */

module.exports = function createReportStore(deps) {
  const { db, cloud, isActiveMember, bumpAbuseCount, todayKey, failDetail } = deps
  const _ = db.command

  /** 失联判定，**须与端上 src/utils/cache.ts#BUILDING_TIMEOUT_MS 同值** */
  const BUILDING_TIMEOUT_MS = 90 * 1000
  /** 单份报告上限（字节）。callFunction 官方建议请求体 ≤ 100KB，贴着它取 */
  const REPORT_MAX_BYTES = 100 * 1024
  /** 单个人物动态列表上限：feed 只存检索结果映射（10~20 条），实测 10~30KB */
  const FEED_MAX_BYTES = 60 * 1024
  /**
   * 写口限速（**不分会员档**）：它不产生上游成本，要防的只是「反复抢锁击穿全站缓存」这类 DoS。
   * 一次正常生成最多 3 次写口调用（acquire / save / release），150 次 ≈ 50 次完整生成，
   * 远高于产品额度（免费 3 / 会员 30），对正常用户无感。
   * 计数走**独立键**（`openid#日期#store`），不挤占 chat / search 那条 ABUSE_LIMITS。
   */
  const STORE_ABUSE_LIMIT = 150
  /** 主键长度上限：超长先在门口挡住，别把库当网盘 */
  const MAX_KEY_LEN = 120

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const bad = (error) => ({ ok: false, kind: 'badrequest', error })

  /** 读一行（不存在 / 读失败都算 null：`doc().get()` 在行不存在时直接抛错，同 readQuotaCount） */
  async function readRow(collection, id) {
    if (!id) return null
    try {
      const res = await db.collection(collection).doc(id).get()
      return (res && res.data) || null
    } catch (err) {
      return null
    }
  }

  /**
   * 产物是否带会员专属段落。**口径须与端上 utils/member.ts#presentSections 一致**：
   * 空串与空数组都按「不存在」处理。端上落库前已判过一次，这里是权威侧的兜底 ——
   * 它挡的是「绕过端上直接调写口」。
   */
  function hasMemberPayload(report) {
    const mn = report && report.memberNotes
    if (mn && typeof mn === 'object' && (str(mn.compare) || str(mn.risk))) return true
    const cf = report && report.conflicts
    return Array.isArray(cf) && cf.length > 0
  }

  /** 写口限速：独立计数键，不与 chat / search 的额度互相挤占 */
  async function storeGate(openid) {
    const count = await bumpAbuseCount(`${openid}#${todayKey()}#store`, openid)
    if (count !== null && count > STORE_ABUSE_LIMIT) {
      return { ok: false, kind: 'abuse', error: `今日缓存写入调用次数已达上限（${STORE_ABUSE_LIMIT} 次），明日 0 点恢复` }
    }
    return null
  }

  /**
   * 抢锁：无行则条件插入；有行则条件更新（ready / building 超时可抢占）。
   * 与端上 cache.ts#acquire 同一套语义，差别在于 `builder` 由服务端写死成 openid ——
   * 端上伪造不了持锁人，也就无法把别人的 building 行据为己有（端上直写时是能的）。
   */
  async function storeAcquire(personKey, openid, schemaVersion) {
    const now = new Date().toISOString()
    const existing = await readRow('report_cache', personKey)

    if (!existing) {
      try {
        await db.collection('report_cache').add({
          data: {
            _id: personKey,
            report: null,
            generated_at: now,
            state: 'building',
            builder: openid,
            search_meta: null,
            ...(typeof schemaVersion === 'number' ? { schemaVersion } : {})
          }
        })
        return { ok: true, result: 'acquired' }
      } catch (err) {
        /* 并发：他人刚建好这一行 ⇒ 正常地「没抢到」；仍然读不到才是真实失败 */
        const again = await readRow('report_cache', personKey)
        if (again) return { ok: true, result: 'lost' }
        return { ok: false, kind: 'upstream', error: `建锁失败：${failDetail(err)}` }
      }
    }

    /* 抢占时**不动 `report`**：那一行上躺着「即将被覆盖的那一版」，端上的「只升不降」
       守卫（shouldKeepMemberVersion）还指着它 —— 与端上 acquire 的 P0 修复同一条理由。 */
    const expireIso = new Date(Date.now() - BUILDING_TIMEOUT_MS).toISOString()
    try {
      const res = await db
        .collection('report_cache')
        .where(_.and([{ _id: personKey }, _.or([{ state: 'ready' }, { generated_at: _.lt(expireIso) }])]))
        .update({
          data: {
            state: 'building',
            builder: openid,
            generated_at: now,
            ...(typeof schemaVersion === 'number' ? { schemaVersion } : {})
          }
        })
      const updated = res && res.stats ? res.stats.updated : 0
      return { ok: true, result: updated > 0 ? 'acquired' : 'lost' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `抢锁失败：${failDetail(err)}` }
    }
  }

  /**
   * 放锁：只动本人的 building 行。有旧内容则退回 ready 交还出去，确实没内容才删行 ——
   * 与端上 release 同一套语义（那条 P0 修复的理由见 cache.ts）。
   */
  async function storeRelease(personKey, openid) {
    const row = await readRow('report_cache', personKey)
    if (!row || row.state !== 'building' || row.builder !== openid) return { ok: true, result: 'skipped' }

    const where = { _id: personKey, builder: openid, state: 'building' }
    if (row.report) {
      try {
        const res = await db
          .collection('report_cache')
          .where(where)
          .update({ data: { state: 'ready', builder: null, generated_at: str(row.report.generatedAt) || row.generated_at } })
        if (res && res.stats && res.stats.updated > 0) return { ok: true, result: 'restored' }
      } catch (err) {
        /* 退回失败不致命：下面的删行同样只动自己的锁；再失败还有 BUILDING_TIMEOUT_MS 兜底 */
      }
    }
    try {
      await db.collection('report_cache').where(where).remove()
      return { ok: true, result: 'deleted' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `放锁失败：${failDetail(err)}` }
    }
  }

  /**
   * 落库并置 ready。三道校验缺一不可：
   *   · **持锁**：只有该行的 builder 能写 —— 这是「改不了别人那一行」的唯一依据；
   *   · **形状与体积**：report 必须是对象、personKey 与目标行一致、不带系统字段、≤ 100KB；
   *   · **会员一致性**：产物含会员段而调用者不是有效会员 ⇒ 拒绝（本写口最实的增量）。
   */
  async function storeSave(event, openid) {
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')

    const row = await readRow('report_cache', personKey)
    if (!row || row.state !== 'building' || row.builder !== openid) {
      return { ok: false, kind: 'lock', error: '未持有该人物的生成锁（或已被接管），拒绝写入' }
    }

    const report = event.report
    if (!report || typeof report !== 'object' || Array.isArray(report)) return bad('report 必须是对象')
    if (str(report.personKey) !== personKey) return bad('report.personKey 与目标行不一致')
    if (!str(report.name)) return bad('report.name 缺失')
    if ('_id' in report || '_openid' in report) return bad('report 不得携带系统字段')

    const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8')
    if (bytes > REPORT_MAX_BYTES) return bad(`报告体积超限（${bytes} > ${REPORT_MAX_BYTES} 字节）`)
    if (hasMemberPayload(report) && !(await isActiveMember(openid))) {
      return { ok: false, kind: 'auth', error: '产物含会员专属段落，但当前账号不是有效会员，拒绝写入' }
    }

    const newsCount = typeof event.newsCount === 'number' && event.newsCount >= 0 ? event.newsCount : 0
    try {
      /* doc(id).set = 整篇替换（与端上 upsert 同义）：对 report / search_meta 的初值没有要求，
         绕开「往 null 上写子字段被数据库拒绝」那类差异（见端上 cache.ts#saveReady） */
      await db
        .collection('report_cache')
        .doc(personKey)
        .set({
          data: {
            report,
            state: 'ready',
            generated_at: str(report.generatedAt) || new Date().toISOString(),
            builder: null,
            search_meta: { news_count: newsCount },
            ...(typeof event.schemaVersion === 'number' ? { schemaVersion: event.schemaVersion } : {})
          }
        })
      return { ok: true, result: 'saved' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `报告落库失败：${failDetail(err)}` }
    }
  }

  /** 动态列表落库：无锁、无会员差异，只有形状与体积校验（feed 里没有 LLM 产物） */
  async function storeSaveFeed(event) {
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')
    const items = event.items
    if (!Array.isArray(items)) return bad('items 必须是数组')

    const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
    if (bytes > FEED_MAX_BYTES) return bad(`动态列表体积超限（${bytes} > ${FEED_MAX_BYTES} 字节）`)

    try {
      await db
        .collection('feed_cache')
        .doc(personKey)
        .set({ data: { items, fetched_at: str(event.fetchedAt) || new Date().toISOString() } })
      return { ok: true, result: 'saved' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `动态列表落库失败：${failDetail(err)}` }
    }
  }

  /**
   * 写口分发。返回约定与 handleChat / handleSearch 一致（`{ ok, kind?, error?, result? }`）。
   *
   * ⚠ 与别处的**关键差别**：端上对 `ok:false` 必须区分两种情形 ——
   *   · 通道不可用（函数未部署 / 网络 / upstream）⇒ **回退端上直写**（老路径，功能不变）；
   *   · 明确拒绝（auth / badrequest / lock）⇒ **不回退**，否则等于绕过写口的校验去直写。
   *   （端上 quota-guard.ts 的「一律回退」在这里不成立：那边回退没有安全含义。）
   */
  return async function handleReportStore(event) {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) return { ok: false, kind: 'auth', error: '缓存写口需要登录身份（未取到 openid）' }

    const op = event.op
    if (op !== 'acquire' && op !== 'release' && op !== 'save' && op !== 'saveFeed') {
      return bad(`未知 op：${op}（支持 acquire / release / save / saveFeed）`)
    }

    /*
     * personKey 在这里统一校验：acquire / release 也必须有它。
     * 这一步是实测补上的 —— 漏掉时空串会成为合法 `_id`，建出一行谁也认不出来的垃圾锁，
     * 而调用方还以为自己抢到了锁（save 那侧虽有校验，但锁已经脏了）。
     */
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')

    const gate = await storeGate(OPENID)
    if (gate) return gate

    if (op === 'acquire') return storeAcquire(personKey, OPENID, event.schemaVersion)
    if (op === 'release') return storeRelease(personKey, OPENID)
    if (op === 'save') return storeSave(event, OPENID)
    return storeSaveFeed(event)
  }
}
