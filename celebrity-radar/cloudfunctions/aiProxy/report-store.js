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
 * `bumpAbuseCount` / `quotaGuardDisabled` / `todayKey` / `failDetail` —— 全部复用 index.js
 * 里已有的那一份，免得同一个函数里出现两套会员判定或两套计数口径。
 */

/*
 * 构建时限参数（2026-10-17）：从真源副本取，**不许再手抄数字**。
 *
 * 这里本来写的是 `const BUILDING_TIMEOUT_MS = 405 * 1000`，注释还写着「须与端上
 * src/utils/cache.ts#BUILDING_TIMEOUT_MS 同值」—— 而端上随「单批 3 次尝试 + 整份自动重跑」
 * 已涨到 1125s，云端没人改得动，于是任何真实耗时 > 405s 的构建都会被判失联、被抢锁，
 * 旧构建者落库又被 storeSave 的 builder 校验拒绝（成果作废，token 白烧）。
 * 现在两侧都从 `benefits.config.js#REPORT_BUILD` 现算（真源 src/config/benefits.ts）。
 */
const { REPORT_BUILD } = require('./benefits.config')

/* ═══════════════════════════════════════════════════════════════════════
 * 风险词典 —— 条目级分级字段（分级字段上游化，P4-B，2026-10-13）
 *
 * 「类别 / 级别」的**权威产出位置**是这里（`saveFeed` 写口）：写入 `feed_cache` 前给每条补
 * `category` / `category_label` / `level`，端上只透传 / 展示，不再自行判定（见 file 头「写口能
 * 保证与不能保证的」）。纯本地词典匹配，**零上游成本**（不新增任何检索 / 模型调用）。
 *
 * ⚠ 云函数不能跨函数 require（各自独立打包），故这里**复制**一份与
 * `src/utils/risk.ts` / `cloudfunctions/riskWatch` / `cloudfunctions/keywordAlert` **逐字同源**
 * 的词典与判定规则。改动必须几处同步 —— 一致性由 `test/cases/34-field-grading.js` 读源码字面量
 * 比对钉住（有人只改一端即红）；**不允许另造第二套词表**。
 *
 * 未命中**不落任何字段**（保持「未评级 / 未知」）：覆盖率天然有限 —— 只能识别词典里列举的表述，
 * 算不出就说算不出，绝不为界面好看去猜一个级别或给默认值（同 risk.ts 三条边界）。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 词表：全部是可核对的事实类表述，不含评价性词汇（同 risk.ts 口径）。命中取第一个词。 */
const RISK_TERMS = [
  { word: '偷税', category: 'tax' },
  { word: '逃税', category: 'tax' },
  { word: '漏税', category: 'tax' },
  { word: '补缴税款', category: 'tax' },
  { word: '税务稽查', category: 'tax' },
  { word: '起诉', category: 'judicial' },
  { word: '立案', category: 'judicial' },
  { word: '诉讼', category: 'judicial' },
  { word: '判决', category: 'judicial' },
  { word: '败诉', category: 'judicial' },
  { word: '庭审', category: 'judicial' },
  { word: '传唤', category: 'judicial' },
  { word: '拘留', category: 'judicial' },
  { word: '逮捕', category: 'judicial' },
  { word: '强制执行', category: 'judicial' },
  { word: '通报批评', category: 'judicial' },
  { word: '行政处罚', category: 'judicial' },
  { word: '罚款', category: 'judicial' },
  { word: '律师函', category: 'judicial' },
  { word: '调查', category: 'judicial' },
  { word: '查封', category: 'judicial' },
  { word: '冻结', category: 'judicial' },
  { word: '限制高消费', category: 'judicial' },
  { word: '失信被执行人', category: 'judicial' },
  { word: '解约', category: 'contract' },
  { word: '终止合作', category: 'contract' },
  { word: '停止合作', category: 'contract' },
  { word: '合作终止', category: 'contract' },
  { word: '代言取消', category: 'contract' },
  { word: '撤换', category: 'contract' },
  { word: '下架', category: 'contract' },
  { word: '索赔', category: 'contract' },
  { word: '违约', category: 'contract' },
  { word: '解聘', category: 'contract' },
  { word: '辞退', category: 'contract' },
  { word: '撤档', category: 'contract' },
  { word: '名誉权', category: 'rights' },
  { word: '肖像权', category: 'rights' },
  { word: '诽谤', category: 'rights' },
  { word: '造谣', category: 'rights' },
  { word: '侵权', category: 'rights' },
  { word: '维权', category: 'rights' },
  { word: '盗用', category: 'rights' },
  { word: '假冒', category: 'rights' },
  { word: '道歉', category: 'statement' },
  { word: '致歉', category: 'statement' },
  { word: '澄清', category: 'statement' },
  { word: '辟谣', category: 'statement' }
]

/* 双向词方向判定（与 src/utils/risk.ts / riskWatch / keywordAlert 同源）：「起诉 / 诉讼」
   原告被告都在用，命中后要看动词后面是否跟着维权对象 ——「起诉造谣者」是名誉维权、「被起诉」
   才是司法监管。 */
const BIDIRECTIONAL_TERMS = ['起诉', '诉讼']
const RIGHTS_OBJECTS = [
  '造谣', '诽谤', '侵权', '名誉', '肖像', '网暴', '黑粉', '抹黑', '诋毁', '抄袭', '盗用', '假冒', '维权'
]
const RIGHTS_AFTER_WINDOW = 8

/** 类别 → 级别：只表示「命中词属于哪一类」，不是对事件的定性（与 riskWatch / keywordAlert 同源） */
const LEVEL_OF = { judicial: 'high', tax: 'high', contract: 'mid', rights: 'mid', statement: 'low' }
const CATEGORY_LABEL = {
  judicial: '司法监管',
  tax: '税务合规',
  contract: '商业合作',
  rights: '名誉维权',
  statement: '回应表态'
}

/* 否定词：命中词前 NEG_WINDOW 个字符内出现即整条丢弃（「未被起诉」「否认解约」）。
   与 risk.ts / riskWatch 同源、同窗口 —— 这是启发式，窗口一大就会吃掉「团队否认，此前已被起诉」。 */
const NEG_WORDS = ['未', '没', '无', '否认', '不实', '谣言', '造谣', '辟谣']
const NEG_WINDOW = 6

/** 字面命中：返回第一个未被否定的命中词，没有则 null（与 risk.ts#matchTerm / riskWatch 同一套规则） */
function matchTerm(text) {
  for (const term of RISK_TERMS) {
    const at = text.indexOf(term.word)
    if (at < 0) continue
    const before = text.slice(Math.max(0, at - NEG_WINDOW), at)
    if (NEG_WORDS.some((n) => before.includes(n))) continue
    /* 双向词再看宾语方向：「起诉造谣者」是维权、「被起诉」才是司法监管 */
    if (BIDIRECTIONAL_TERMS.indexOf(term.word) >= 0) {
      const after = text.slice(at + term.word.length, at + term.word.length + RIGHTS_AFTER_WINDOW)
      if (RIGHTS_OBJECTS.some((o) => after.includes(o))) return { word: term.word, category: 'rights' }
    }
    return term
  }
  return null
}

/**
 * 条目级分级字段：命中词典才产出的三件套，**未命中返回空对象**（展开后不落任何字段）。
 * 未命中不产出 = 端上保持「未评级 / 未知」，这是刻意设计（覆盖率天然有限）。
 */
function riskFieldsOf(text) {
  const hit = matchTerm(String(text || ''))
  if (!hit) return {}
  return {
    category: hit.category,
    category_label: CATEGORY_LABEL[hit.category],
    level: LEVEL_OF[hit.category]
  }
}

/** 条目级分级字段的字段名（写口据「命中即覆盖、未命中即抹除」保持权威：客户端塞进来的假级别一并清掉） */
const GRADED_FIELDS = ['category', 'category_label', 'level']

/**
 * 给单条 feed 条目定级：在本条副本上**先清掉任何既有的分级字段**（写口是权威，不认客户端自报的级别），
 * 再按词典命中结果落三件套；未命中则三条字段都不存在（保持「未评级」）。
 */
function gradeFeedItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return it
  const out = Object.assign({}, it)
  for (const k of GRADED_FIELDS) delete out[k]
  return Object.assign(out, riskFieldsOf(`${it.title || ''} ${it.content || ''}`))
}

module.exports = function createReportStore(deps) {
  const { db, cloud, isActiveMember, bumpAbuseCount, quotaGuardDisabled, todayKey, failDetail } = deps
  const _ = db.command

  /**
   * 失联判定：与端上 `src/utils/cache.ts#BUILDING_TIMEOUT_MS` **同一个算式、同一组参数**。
   *
   * 2026-10-17 之前这里是手写的 `405 * 1000`（= 4 批 × 2 次 × 45s + 45s，单批 2 次尝试、
   * 无整份重跑时代的旧口径）。端上后来把「每批 3 次尝试」与「整份自动重跑一次」都加上了，
   * 上界涨到 1125s，而这里没人跟着改 —— 注释写着「须与端上同值」，但两侧各写一个数字时，
   * 这句话没有任何东西在保证。现在参数在 `benefits.config.js#REPORT_BUILD`（真源
   * `src/config/benefits.ts`），两侧各自现算，用例 77 钉住「批数 = REPORT_BATCHES.length」
   * 与「本文件不许再出现手写上界」。
   */
  const BUILDING_TIMEOUT_MS =
    REPORT_BUILD.batchCount *
      REPORT_BUILD.batchAttempts *
      REPORT_BUILD.generateAttempts *
      REPORT_BUILD.chatDeadlineMs +
    REPORT_BUILD.searchBudgetMs +
    REPORT_BUILD.slackMs
  /** 单份报告上限（字节）。callFunction 官方建议请求体 ≤ 100KB，贴着它取 */
  const REPORT_MAX_BYTES = 100 * 1024
  /** 中间结果上限（P0-B，saveParts）：一批几千字节，四批封顶，给到 80KB 足够且仍在 callFunction 建议值内 */
  const PARTS_MAX_BYTES = 80 * 1024
  /** 单个人物动态列表上限：feed 只存检索结果映射（10~20 条），实测 10~30KB */
  const FEED_MAX_BYTES = 60 * 1024
  /**
   * `fetched_at` 允许超前服务端时钟的容忍度（2026-10-18）。
   *
   * 上一版把端上传来的时间直接写进 `fetched_at`，于是任何一次时钟错乱 / 人工写库都能在这一行
   * 留下一个未来时间戳 —— 而 feed_cache 是**全站共享**的一行，「只有更晚的才允许覆盖」一旦配上
   * 未来值，这个人物就再也刷不动了。超前超过这个量的一律当脏值，按最旧处理并校正回服务端时间；
   * 5 分钟足够容下真实的多机时钟偏差，又远小于「未来值」造成的影响。
   */
  const FEED_FUTURE_TOLERANCE_MS = 5 * 60 * 1000
  /**
   * 写口限速（**不分会员档**）：它不产生上游成本，要防的只是「反复抢锁击穿全站缓存」这类 DoS。
   * 一次正常生成最多 7 次写口调用（acquire + 最多 4 次 saveParts + save + release），
   * 400 次 ≈ 57 次完整生成，远高于产品额度（免费 3 / 会员 30），对正常用户无感。
   * 计数走**独立键**（`openid#日期#store`），不挤占 chat / search 那条 ABUSE_LIMITS。
   */
  const STORE_ABUSE_LIMIT = 400
  /**
   * 会员段读口限速（`op:'member'`）。比写口宽得多，因为它是**读**：一份报告打开最多一次，
   * 而且内容本来就是这位会员有权看的 —— 要防的只是「拿它当免费接口反复刷」。
   * 2000 次/日 ≈ 正常重度用户（30 份报告 × 每天翻十几遍）的两个数量级以上。
   * 计数走独立键（`openid#日期#member`），不挤占写口那 400 次。
   */
  const MEMBER_READ_ABUSE_LIMIT = 2000
  /** 主键长度上限：超长先在门口挡住，别把库当网盘 */
  const MAX_KEY_LEN = 120
  /**
   * 报告历史版本保留条数（S3-1 ③「报告历史版本」，2026-10-16）。
   *
   * ⚠ 这是**运维保留策略**，不是会员权益数值 —— 所以写在这里而不是 `src/config/benefits.ts`
   *   （那一份每一条都是「卖什么」的真源，会被会员页与权益文案派生；「库里留几行」不是权益）。
   * 取 5：单份报告 ≤ 100KB，5 版 ≈ 500KB/人物；每次覆盖只多一次写 + 一次裁剪，成本可预计。
   */
  const REPORT_VERSION_KEEP = 5
  /** 历史版本表名（写口写、端上只读；行内不含用户标识，见 dbInit/schema.js 与用例 18） */
  const VERSION_COLLECTION = 'report_versions'
  /**
   * 会员段落的独立存放表（P2 方案 A，2026-10-17）。
   *
   * `report_cache` / `report_versions` 是「所有人可读」的，而报告正文里带着四段会员专属内容 ——
   * 端上的 `stripMemberSections` 只做到「UI 不画」，改包直接读库就能拿到全文。
   * 本表 `acl: cloudOnly`（客户端连读都读不到），写入在 `storeSave` 落库之后顺手做，
   * 读取只走 `op:'member'`（先判会员，再给四段）。
   *
   * ⚠ 阶段 1 是**双写**：主行照旧带会员段、这里也存一份 ⇒ 线上行为一个字都没变。
   *   等端上会用 `op:'member'` 补齐（阶段 2）并跑够覆盖率，才在写口把主行的四段剥掉（阶段 3）
   *   —— 顺序颠倒等于给还没更新的人「打开报告少四段」，那是白屏级别的事故。
   */
  const MEMBER_COLLECTION = 'report_member'
  /**
   * 「哪些字段算会员段」—— 与 `hasMemberPayload` / 端上 `stripMemberSections` **同一个口径**。
   * 四处（端上两处 + 云端两处）必须同源：多摘一段 = 会员看不到自己买的内容；
   * 少摘一段 = 免费读者拿到的对象里仍带着付费内容。
   */
  const MEMBER_FIELDS = ['memberNotes', 'conflicts', 'peers', 'affiliations']
  /**
   * 主行剥段（阶段 3）的**上线开关**（2026-10-18）。
   *
   * 阶段 3 的代码 2026-10-17 就写好了，当时靠「**暂时不部署 aiProxy**」维持线上仍是阶段 1 的双写 ——
   * 因为剥段之后四段要靠 `op:'member'` 取回，而那个读口在**端上**：还没发出去的旧包没有它，
   * 新生成的报告在旧包上会员就看不到四段（不报错、页面正常，只是付费内容静默消失）。
   *
   * 问题在于「靠不部署保证」是**部署纪律**，不是代码约束：任何人执行一次
   * `tcb fn code update aiProxy` 都会把它静默切上线 —— 2026-10-18 就发生了一次
   * （CHANGELOG 里那句「本批不会部署 aiProxy」对命令行没有任何约束力）。
   * 改成显式开关：**默认关闭 = 阶段 1 双写**（主行照旧带四段，副本照旧写），
   * 等端上读口确认已全量覆盖，再置 true 重新部署。
   *
   * 也认环境变量 `MEMBER_SPLIT=1`：灰度或临时排查时不必改代码。
   */
  const MEMBER_SPLIT_ENABLED = process.env.MEMBER_SPLIT === '1'
  /**
   * 旗标（主行 `report.memberSections`）里的取值 token（P2 阶段 3，2026-10-17）——
   * 与端上 `utils/member.ts#MEMBER_FLAGS` **逐字相同**（手抄副本，用例 81 比对）。
   *
   * 精确到**段**而不是字段：`memberNotes` 一个字段装两段独立文字（compare / risk），
   * 只写字段名的话端上分不出「只有对比视角」还是「两段都有」，促销条就会承诺一段
   * 这份报告里根本不存在的内容。
   */
  const MEMBER_FLAGS = ['memberNotes.compare', 'memberNotes.risk', 'conflicts', 'peers', 'affiliations']

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
   * 产物是否带会员专属内容。**口径须与端上 utils/member.ts#hasMemberContent 一致**：
   * 两者都取「真值」（空串 / undefined / 空数组算不存在），判定范围为
   * memberNotes 两段文字 / conflicts 非空数组 / peers（同领域坐标，2026-10-12）非空数组 /
   * **affiliations（企业关联，2026-10-12）非空数组**。
   *
   * ⚠ 这里曾经写成 `str(mn.compare)`（trim 后判空），与端上的真值判定**不等价**：
   * 一份 `compare: '   '`（纯空白）端上认为「有会员段」、云端认为「没有」，于是
   * 免费档产物被当成不含会员段而放行、会员免计费复核又多算一次。措辞统一为真值判定后，
   * 四个口径（端上 hasMemberContent / 本函数 / quotaGuard#hasMemberBlocks / stripMemberSections）
   * 完全一致 —— 改动任何一处都要同步其余几处（用例 08 钉住）。
   */
  function hasMemberPayload(report) {
    const mn = report && report.memberNotes
    if (mn && typeof mn === 'object' && (mn.compare || mn.risk)) return true
    const cf = report && report.conflicts
    if (Array.isArray(cf) && cf.length > 0) return true
    const pr = report && report.peers
    if (Array.isArray(pr) && pr.length > 0) return true
    const af = report && report.affiliations
    return Array.isArray(af) && af.length > 0
  }

  /** 从产物里摘出会员段（只取存在的键：写出 `undefined` 会被数据库拒绝） */
  function memberSectionsOf(report) {
    const out = {}
    if (!report || typeof report !== 'object') return out
    for (const k of MEMBER_FIELDS) if (report[k] !== undefined) out[k] = report[k]
    return out
  }

  /**
   * 这一版**有哪些**会员段（token 形式，写进主行旗标）。
   * 只认**实际存在**的段，与 `hasMemberPayload` 同一道真值判定 —— 一份
   * `memberNotes: { compare: '' }` 的报告不该在旗标里声称「有对比视角」。
   */
  function memberFlagsOf(report) {
    const out = []
    if (!report || typeof report !== 'object') return out
    const mn = report.memberNotes
    if (mn && typeof mn === 'object') {
      if (mn.compare) out.push('memberNotes.compare')
      if (mn.risk) out.push('memberNotes.risk')
    }
    if (Array.isArray(report.conflicts) && report.conflicts.length > 0) out.push('conflicts')
    if (Array.isArray(report.peers) && report.peers.length > 0) out.push('peers')
    if (Array.isArray(report.affiliations) && report.affiliations.length > 0) out.push('affiliations')
    return out
  }

  /**
   * 主行形态（P2 阶段 3）：抹掉四段，换成旗标。
   *
   * `report_member` 是客户端不可读的集合，而 `report_cache` 是所有人可读的 —— 阶段 1 的双写
   * 只做到「四段有两份」，阶段 3 这一步才真正把四段从公开表里拿出去。**返回新对象**：
   * 手上的 `report` 还要交给 `saveMemberRow` 写全量，绝不能就地删。
   */
  function stripForRow(report, flags) {
    const out = { ...report }
    for (const k of MEMBER_FIELDS) delete out[k]
    out.memberSections = flags
    return out
  }

  /**
   * 这一版是不是**会员版**：正文有四段，**或**旗标说四段在副本表里。
   *
   * 与 `hasMemberPayload`（只看正文）分工 —— 阶段 3 之后主行的正文恒为「没有四段」，
   * 拿它判「会员版」会得到全站都是免费版：只升不降失效（会员版能被免费产物覆盖）、
   * 免计费复核放行（同一个人能反复白拿）。与端上 `utils/member.ts#isMemberVersion` 同源。
   */
  function isMemberVersion(report) {
    if (hasMemberPayload(report)) return true
    return !!(report && Array.isArray(report.memberSections) && report.memberSections.length > 0)
  }

  /**
   * 把一份报告里的会员段写进 `report_member`（P2 方案 A，2026-10-17；阶段 3 起它成了
   * 「主行能不能剥段」的前置条件）。
   *
   * **返回是否写成功** —— 两个调用方对它的态度不同：
   *   · `storeSave`：**先写副本、成功了才剥主行的段**。返回值就是「能不能剥」的开关，
   *     失败时退回「不剥」（主行照旧带四段，会员照旧看得到）。反过来做（先剥再写副本）
   *     一旦副本失败，就得到一份「旗标说有、副本里没有」的主行 —— 会员永久少四段，
   *     而且不报错、页面看上去与「这份报告本来没有会员段」完全一样。
   *   · `recordVersion`：best-effort，失败只打日志（历史版本是辅助能力，不能因为它的写失败
   *     把一次**已经成功**的生成说成写库失败）。
   *
   * 写失败绝不把 `ok` 改成失败：主行已经落库成功、报告已经生成出来了，因为「副本没写上」
   * 报一个写库失败，端上会当成整份失败（甚至重试一次烧一遍 token），代价远大于收益。
   *
   * **没有会员段时删行而不是写空对象**：否则读者会拿到「上一版的会员段 + 这一版的时间戳」——
   * `generated_at` 相等守卫拦不住这种（时间戳是这一版的）。删掉才是「这份报告确实没有会员段」
   * 的正确表达（用例 80 钉住）。
   *
   * `_id` 约定：当前版 = `personKey`；历史版 = `<personKey>#<那一版的生成时间>` ——
   * 与 `report_versions` 的主键**逐字相同**，于是裁剪历史时两张表用的是同一个 id（见 trimVersions）。
   */
  async function saveMemberRow(personKey, report, generatedAt, kind, schemaVersion) {
    if (!personKey || !generatedAt) return false
    const id = kind === 'version' ? `${personKey}#${generatedAt}` : personKey
    const sections = memberSectionsOf(report)
    try {
      if (Object.keys(sections).length === 0) {
        /* 行不存在时 remove 是空操作（CloudBase 返回 removed:0，不抛错） */
        await db.collection(MEMBER_COLLECTION).doc(id).remove()
        return true
      }
      await db
        .collection(MEMBER_COLLECTION)
        .doc(id)
        .set({
          data: {
            person_key: personKey,
            kind,
            generated_at: generatedAt,
            sections,
            ...(typeof schemaVersion === 'number' ? { schemaVersion } : {})
          }
        })
      return true
    } catch (err) {
      console.warn('[report-store] 会员段副本写入失败:', failDetail(err))
      return false
    }
  }

  /**
   * 把**刚被覆盖掉的那一版**记入历史版本表（S3-1 ③，2026-10-16）。
   *
   * 为什么落在这里：`report_cache` 一人一份、`force` 重生即整篇替换，旧版就此永久消失。而
   * 「覆盖」这个动作在 P0-2 收权之后**只从本写口经过**（客户端不可写），所以版本记录落在写口
   * 等于：端上零改动就覆盖了全部覆盖路径，日后新增生成入口也不会漏记。
   *
   * ⚠ **调用顺序必须是「先落库、后记版本」**（见 storeSave 里的调用点）：
   *   · 反过来的话，落库失败时历史里会多出一条与当前版**逐字相同**的记录 —— 用户会以为这份
   *     报告真的更新过（假历史，而且是主动误导）；
   *   · 这个顺序的代价是「落库成功但记版本失败」时旧版彻底丢失（少一条历史）。
   *     两者都坏，但**缺失**比**假的**可接受：少一条只是信息不全，多一条相同版本是在骗人。
   *
   * **best-effort**：记版本失败只打日志，绝不把 `ok` 改成失败 —— 历史版本是辅助能力，不能因为
   * 它的写失败把一个**已经生成成功**的报告说成写库失败（同 storeRelease 里那条降级取舍）。
   *
   * `_id` 取 `<personKey>#<旧版生成时间>`（确定性，而不是随机 id）：同一旧版被覆盖两次
   * （端上重试 / 双端各自抢到锁后各写一次）只会算出同一个 `_id`，`set` 天然幂等，
   * 历史里不会出现两条一模一样的版本。
   *
   * **不写 openid 或任何用户标识**：版本行是「全站共享事实的一段历史」，与 `report_cache` 同定位
   * （记忆点：谁覆盖的这一行与读者无关）。写上用户标识会让它变成注销时要按用户清的行 ——
   * 见 dbInit/schema.js 的说明与用例 18 的「注销删表清单」对齐检查。
   */
  async function recordVersion(row, personKey, replacedAt) {
    const old = row && row.report
    if (!old || typeof old !== 'object') return /* 首次生成：没有「被覆盖掉的那一版」 */
    const generatedAt = str(old.generatedAt) || str(row.generated_at)
    if (!generatedAt) return /* 无时间戳就算不出确定性的 _id，宁可不记也不记成一条时间未知的行 */
    /* 旧版正文按与 report_cache 同一道体积闸门收口：真源行自己都不该有这个体积 */
    if (Buffer.byteLength(JSON.stringify(old), 'utf8') > REPORT_MAX_BYTES) return

    const meta = row.search_meta && typeof row.search_meta === 'object' ? row.search_meta : null
    const newsCount = meta && typeof meta.news_count === 'number' && meta.news_count >= 0 ? meta.news_count : 0
    try {
      await db
        .collection(VERSION_COLLECTION)
        .doc(`${personKey}#${generatedAt}`)
        .set({
          data: {
            person_key: personKey,
            name: str(old.name),
            generated_at: generatedAt,
            /* 「什么时候被换掉的」——与 generated_at（这一版什么时候生成的）是两件事，
               页面上要的是前者（「这份报告在 X 更新过，上一版是 Y」） */
            replaced_at: replacedAt,
            /* 旧版对应的素材条数（同一个 search_meta 还没被这次覆盖改写）：
               列表要能与当前版比「这次多了还是少了多少条素材」 */
            news_count: newsCount,
            report: old,
            ...(typeof row.schemaVersion === 'number' ? { schemaVersion: row.schemaVersion } : {})
          }
        })
      /*
       * 旧版的会员段也搬进副本表（主键与上面这一行逐字相同）：历史版本页要能按版本取回四段。
       *
       * ⚠ 只在**旧版正文里真有四段**时才搬。阶段 3 之后旧版自己就是剥段形态 —— 四段早在
       * 它落库时就写进副本了（同一个 `_id`）。这时候再调一次 `saveMemberRow`，会因为它摘不出
       * 四段而走「删行」分支，把上一版**唯一**的四段副本删掉，历史版本页从此少四段。
       */
      if (hasMemberPayload(old)) {
        await saveMemberRow(personKey, old, generatedAt, 'version', row.schemaVersion)
      }
      await trimVersions(personKey)
    } catch (err) {
      console.warn('[report-store] 记录历史版本失败（不影响本次落库）:', failDetail(err))
    }
  }

  /**
   * 保留策略：每个 personKey 只留最近 `REPORT_VERSION_KEEP` 条（超出即删）。
   *
   * 排序按 **`_id` 降序**而不是 `generated_at`：`_id` 就是 `<personKey>#<生成时间>`，同一人物下
   * 它的字典序**等价于**时间序（ISO 时间戳定长可比）。这样裁剪不依赖任何自建索引 ——
   * `orderBy` 非 `_id` 字段在索引未建 / 排序内存超限时会被云侧拒（`_id` 是主键，天生有索引），
   * 而裁剪失败意味着这张表会一直长下去，是那种「平时不疼、疼起来很贵」的故障。
   *
   * 做法是「按 _id 取回列表 → 逐条删超出的」而不是 `orderBy().skip().remove()`：后者依赖云端对
   * 「skip 之后 remove 哪些行」的语义，而按 `_id` 显式删除可核对、也能被用例断言。
   * 每次覆盖后都裁一次 ⇒ 最多只超出一条，故取 `KEEP + 20` 条足够（顺带兜住索引未建时期的积压）。
   */
  async function trimVersions(personKey) {
    try {
      const res = await db
        .collection(VERSION_COLLECTION)
        .where({ person_key: personKey })
        .orderBy('_id', 'desc')
        .limit(REPORT_VERSION_KEEP + 20)
        .get()
      const rows = (res && res.data) || []
      for (const r of rows.slice(REPORT_VERSION_KEEP)) {
        if (!r || !r._id) continue
        await db.collection(VERSION_COLLECTION).doc(r._id).remove()
        /*
         * 会员段副本跟着一起删（`_id` 与版本行逐字相同，见 saveMemberRow）。
         * 漏掉这一步的后果不是「多占一点空间」：本表是**客户端不可读**的，
         * 没人会读到一个孤儿行然后发现它脏 —— 它会静默长下去，且规律与版本表不同步
         * （版本表只留 5 条，副本表无限长）。运维看见的会是「一张查不出用途的表在变大」。
         */
        try {
          await db.collection(MEMBER_COLLECTION).doc(r._id).remove()
        } catch (err) {
          /* 副本删除失败不影响版本裁剪本身：下次覆盖会再裁一次，届时重试 */
        }
      }
    } catch (err) {
      console.warn('[report-store] 裁剪历史版本失败（下次覆盖会再试）:', failDetail(err))
    }
  }

  /**
   * 写口限速：独立计数键，不与 chat / search 的额度互相挤占。
   *
   * 与 quotaGate 同一枚调试开关（`AI_PROXY_QUOTA_GUARD=off`）：它虽比产品额度宽得多，
   * 但反复 force 调试时同样会撞上（每次生成 3 次写口 ≈ 50 次生成就到底），
   * 而写口被拦的表现是「缓存写不进 / 抢不到锁」，比额度用完更难归因，故一并放行判定。
   * 计数照旧自增（`... #store` 那条键），排查时能看到真实调用量。
   */
  async function storeGate(openid) {
    const count = await bumpAbuseCount(`${openid}#${todayKey()}#store`, openid)
    if (!quotaGuardDisabled() && count !== null && count > STORE_ABUSE_LIMIT) {
      return { ok: false, kind: 'abuse', error: `今日缓存写入调用次数已达上限（${STORE_ABUSE_LIMIT} 次），明日 0 点恢复` }
    }
    return null
  }

  /** 会员段读口的限速（与写口分开计数：读不该吃掉「今天还能写几次」的预算） */
  async function memberGate(openid) {
    const count = await bumpAbuseCount(`${openid}#${todayKey()}#member`, openid)
    if (!quotaGuardDisabled() && count !== null && count > MEMBER_READ_ABUSE_LIMIT) {
      return { ok: false, kind: 'abuse', error: `今日会员内容读取次数已达上限（${MEMBER_READ_ABUSE_LIMIT} 次），明日 0 点恢复` }
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
            /* 新行没有中间结果，但把键写出来（null = 无），行形状与 dbInit 的 def 一致 */
            parts: null,
            /*
             * 首建标记（2026-10-15）：这一条 insert 就是「全站第一次建这个人物」（`!existing`）。
             * quotaGuard 复核 `waiveIf: 'first_build'` 的免计费申请时读它 —— 端上那个标记不可信，
             * 服务端能自证的「首建」事实只在这里产生。
             *
             * **只在这一条 insert 里写**：抢占 / 覆盖（下面那段 update）一概不写，
             * 所以「同一人物只可能被免一次」是数据结构自带的，不靠额外记账。
             * report_cache 对客户端是 publicReadOnly（见 dbInit/schema.js），端上伪造不了这两个字段。
             */
            first_build_owner: openid,
            first_build_at: now,
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
            /* 清掉上一轮（被抢占 / 中断的那一次）留下的中间结果：它属于旧的那次生成 */
            parts: null,
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
          .update({
            data: {
              state: 'ready',
              builder: null,
              generated_at: str(row.report.generatedAt) || row.generated_at,
              /* 退回 ready 的这一次没生成完整报告，中间结果一并清掉（同端上 release） */
              parts: null
            }
          })
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
   * 落库并置 ready。四道校验缺一不可：
   *   · **持锁**：只有该行的 builder 能写 —— 这是「改不了别人那一行」的唯一依据；
   *   · **形状与体积**：report 必须是对象、personKey 与目标行一致、不带系统字段、≤ 100KB；
   *   · **会员一致性**：产物含会员段而调用者不是有效会员 ⇒ 拒绝（本写口最实的增量）；
   *   · **只升不降**：既有版本带会员段而新产物不带 ⇒ 拒绝（端上的守卫可被改包绕过，见下方 P1-9）。
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
    /*
     * 「只升不降」（P1-9）：抢锁**不动**上一版 report（见 storeAcquire），但落库是整篇替换 ——
     * 于是只要一行被非会员抢到锁，就能把全站共享的会员版覆盖成免费版：这条行是所有读者共用的，
     * 一个人改包 Force 一次，所有人（含已付费会员）看到的那份会员段落就没了。
     *
     * 端上 cache.ts#saveReady 的 shouldKeepMemberVersion 已判过一次，但端上判定可被改包绕过，
     * 写口才是权威。判据与端上一致：既有版本是会员版、而新产物不是 ⇒ 拒绝（kind='stale'）。
     * 「会员版 → 免费版」这种合法降级在端上本来就被守卫拦住，不会走到这里；改包者走到这里即被拒。
     *
     * ⚠ 阶段 3 起既有主行**不带四段**（只剩旗标），所以这里必须用 `isMemberVersion`
     * 而不是 `hasMemberPayload` —— 后者对剥过段的行恒为假，守卫会形同虚设。
     */
    if (isMemberVersion(row.report) && !hasMemberPayload(report)) {
      return { ok: false, kind: 'stale', error: '既有版本含会员专属段落，拒绝用不含会员段的版本覆盖' }
    }

    const newsCount = typeof event.newsCount === 'number' && event.newsCount >= 0 ? event.newsCount : 0
    /* 提前算好：主行与会员段副本必须写**同一个**时间戳，它是跨两行的唯一配对依据 */
    const generatedAt = str(report.generatedAt) || new Date().toISOString()
    /*
     * 会员段搬去副本表、主行剥段（P2 方案 A **阶段 3**，2026-10-17）。
     *
     * **顺序是硬约束：先写副本，成功了才剥。** 反过来的话副本写失败就得到一份
     * 「旗标说有、副本里没有」的主行 —— 会员永久少四段，而且不报错、页面看上去与
     * 「这份报告本来没有会员段」一模一样，只能靠端上埋点 `member_sections` 的 empty 占比发现。
     * 副本写失败时退回「不剥」：主行照旧带四段，就是阶段 3 之前的行为，会员照旧看得到。
     *
     * 这一步之后，`report_cache` / `report_versions`（所有人可读）里不再有付费内容，
     * 端上要靠 `op:'member'` 取 —— 语义上的变化全部在这一次剥段里，其余校验（会员一致性、
     * 只升不降、体积闸门）都还按**入参的完整报告**判，不受影响。
     */
    const memberFlags = memberFlagsOf(report)
    let stored = report
    /* 副本先写（免费版则在这里**删**掉上一版残留的副本）：它是「能不能剥段」的必要条件之一
       （另一个是 MEMBER_SPLIT_ENABLED）。免费版也走一次，是为了不留「旧四段 + 新时间戳」——
       那种组合在 storeMember 里只差一个时间戳巧合就能凑成一次错配。 */
    const copied = await saveMemberRow(personKey, report, generatedAt, 'current', event.schemaVersion)
    /* 三个条件：开关打开（见 MEMBER_SPLIT_ENABLED）、这一版真有四段、副本写成功 */
    if (MEMBER_SPLIT_ENABLED && memberFlags.length > 0 && copied) {
      stored = stripForRow(report, memberFlags)
    }
    try {
      /* doc(id).set = 整篇替换（与端上 upsert 同义）：对 report / search_meta 的初值没有要求，
         绕开「往 null 上写子字段被数据库拒绝」那类差异（见端上 cache.ts#saveReady） */
      await db
        .collection('report_cache')
        .doc(personKey)
        .set({
          data: {
            report: stored,
            state: 'ready',
            generated_at: generatedAt,
            builder: null,
            search_meta: { news_count: newsCount },
            /* 成品落库，中间结果随之作废（顺带兜住「set 若是合并语义」的极端情况） */
            parts: null,
            ...(typeof event.schemaVersion === 'number' ? { schemaVersion: event.schemaVersion } : {})
          }
        })
      /*
       * 落库成功之后才记历史版本（顺序不能反，理由见 recordVersion 的注释）。
       * 此刻 `row.report` 仍指向**旧版** —— 它是本函数开头读出来的那一份，不受上面的 set 影响。
       */
      await recordVersion(row, personKey, new Date().toISOString())
      return { ok: true, result: 'saved' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `报告落库失败：${failDetail(err)}` }
    }
  }

  /**
   * 中间结果落库（P0-B，`op:'saveParts'`）：报告按模板分组拆成多次生成，每批成功即把**累计的
   * 批次结果**写进 building 行的 `parts` 字段。三道校验：
   *   · **持锁**：只有该行的 builder 能写（与 storeSave 同一依据）；
   *   · **形状与体积**：parts 必须是数组、≤ PARTS_MAX_BYTES；
   *   · **会员一致性**：任一批含会员段而调用者不是有效会员 ⇒ 拒绝（同 storeSave，别让中间结果
   *     成为绕过写口写会员内容的侧门）。
   * **刻意不判「只升不降」**：那是成品之间的比较，中间结果还没成型。
   * 写 `parts` 用 where().update()（点路径只动这一个字段）：**不动 report / state**，
   * 所以半成品永远不会被读者看到（读者只看 state / report）。
   */
  async function storeSaveParts(event, openid) {
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')

    const row = await readRow('report_cache', personKey)
    if (!row || row.state !== 'building' || row.builder !== openid) {
      return { ok: false, kind: 'lock', error: '未持有该人物的生成锁（或已被接管），拒绝写入中间结果' }
    }

    const parts = event.parts
    if (!Array.isArray(parts)) return bad('parts 必须是数组')

    const bytes = Buffer.byteLength(JSON.stringify(parts), 'utf8')
    if (bytes > PARTS_MAX_BYTES) return bad(`中间结果体积超限（${bytes} > ${PARTS_MAX_BYTES} 字节）`)

    if (!(await isActiveMember(openid))) {
      const tricky = parts.some((part) => part && typeof part === 'object' && hasMemberPayload(part.data))
      if (tricky) {
        return { ok: false, kind: 'auth', error: '中间结果含会员专属段落，但当前账号不是有效会员，拒绝写入' }
      }
    }

    try {
      const res = await db
        .collection('report_cache')
        .where({ _id: personKey, builder: openid, state: 'building' })
        .update({ data: { parts } })
      const updated = res && res.stats ? res.stats.updated : 0
      /* 锁刚好被接管 ⇒ 按 lock 交回（端上把它当 best-effort，不再重试这一条） */
      if (updated === 0) return { ok: false, kind: 'lock', error: '中间结果写入时锁已被接管' }
      return { ok: true, result: 'saved' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `中间结果落库失败：${failDetail(err)}` }
    }
  }

  /**
   * 动态列表落库：无锁、无会员差异，只有形状与体积校验（feed 里没有 LLM 产物）。
   *
   * P4-B（2026-10-13）：落库前用本地风险词典给每条补条目级分级字段（`gradeFeedItem`）——
   * 这是 feed_cache 分级字段的**唯一权威产出位置**，端上只透传 / 展示。纯本地匹配、零上游成本；
   * 未命中的条目不落任何字段（保持「未评级 / 未知」）。
   *
   * 2026-10-18（P1，只让新的盖旧的）：
   *   ① 落库时间一律取**服务端**时间 —— `fetched_at` 既是「X 前更新」的展示依据，也是下面
   *      新旧比较的判据，不能采信端上传来的值（设备时钟随手可改；同账号多台设备更不可比）。
   *      `event.fetchedAt` 仍然接受（老版本端还会传），但**不再采用**。
   *   ② 原实现是无条件 `set`：两个人同时刷新同一个人物、或一个人手快连点两次，先发出的那次
   *      晚回来（检索慢的那次），会把已经落库的新内容整行盖回旧内容，`fetched_at` 一起倒退 ——
   *      关注流下次算「多久没刷」也跟着算错。现在改成「先比再写，写时带条件」：
   *      比对不通过直接回 `skipped-stale`，条件写落空（这中间有人抢先写了更新的）同样如此。
   *   ③ 没有 `fetched_at` 的存量行按「最旧」处理，照常覆盖 —— 否则那些行会永远写不进去。
   *   ④ 超前服务端时钟 5 分钟以上的 `fetched_at` 当**脏值**处理（同样按最旧覆盖）：否则一行被
   *      写进一个未来的时间戳之后，这个人物（全站共享的一行）就再也刷不动了。
   */
  async function storeSaveFeed(event) {
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')
    const items = event.items
    if (!Array.isArray(items)) return bad('items 必须是数组')

    /* 定级后再做体积校验：分级字段（三件套，每条最多几十字节）会让条目略增，
       按理存货的真实体积判，避免「校验通过、落库却超限」。 */
    const graded = items.map(gradeFeedItem)

    const bytes = Buffer.byteLength(JSON.stringify(graded), 'utf8')
    if (bytes > FEED_MAX_BYTES) return bad(`动态列表体积超限（${bytes} > ${FEED_MAX_BYTES} 字节）`)

    const nowMs = Date.now()
    const at = new Date(nowMs).toISOString()

    try {
      const probe = await db.collection('feed_cache').where({ _id: personKey }).limit(1).get()
      const existing = (probe && probe.data && probe.data[0]) || null
      const prevRaw = existing ? str(existing.fetched_at) : ''
      const prevMs = prevRaw ? Date.parse(prevRaw) : NaN
      /* ② 可比（有值且不超前太多）才参与比较；否则当最旧 */
      const comparable = Number.isFinite(prevMs) && prevMs <= nowMs + FEED_FUTURE_TOLERANCE_MS

      if (comparable && prevMs >= nowMs) {
        /* 库里已经是同等或更新的内容：不覆盖，但也不算失败（端上按「已是最新」处理） */
        return { ok: true, result: 'skipped-stale', fetchedAt: prevRaw }
      }

      if (existing && comparable) {
        /* 带条件再写一次：上面那次读与这次写之间若有人写入了更新的内容，这次自动落空 */
        const upd = await db
          .collection('feed_cache')
          .where({ _id: personKey, fetched_at: db.command.lt(at) })
          .update({ data: { items: graded, fetched_at: at } })
        if (!(upd && upd.stats && upd.stats.updated)) {
          return { ok: true, result: 'skipped-stale', fetchedAt: prevRaw || null }
        }
        return { ok: true, result: 'saved' }
      }

      await db.collection('feed_cache').doc(personKey).set({ data: { items: graded, fetched_at: at } })
      return { ok: true, result: 'saved' }
    } catch (err) {
      return { ok: false, kind: 'upstream', error: `动态列表落库失败：${failDetail(err)}` }
    }
  }

  /**
   * 会员段读口（`op:'member'`，P2 方案 A 阶段 1，2026-10-17）。
   *
   * 为什么读也要过云函数：`report_member` 是 `acl: cloudOnly`（客户端连读都读不到）——
   * 这正是本方案的全部意义。既然是云函数，**会员判定就必须在这里做**（读 `memberships` 权威表，
   * 不认端上报上来的身份）。
   *
   * **配对判据是时间戳相等**（两行不是原子写的）：
   *   · 当前版：端上把它手里主行的 `generated_at` 传上来（`generatedAt`），与副本行的比；
   *   · 历史版：端上传那一版的生成时间（`version`），副本行的 `_id` 就是 `personKey#version`。
   * 不相等时**返回 `mismatch` 而不是报错**：端上要能区分「这份报告没有会员段」（empty）、
   * 「时间戳对不上、宁可不给」（mismatch）与「你今天读太多了」（abuse）三种情况，
   * 前两种都该安静地退化成免费态，只有落到 `ok:false` 才会被当成故障记进诊断日志。
   *
   * 返回的 `sections` 只含**存在的**那几段：端上按需 `Object.assign(report, sections)` 即可，
   * 不需要先知道这份报告有没有会员段。
   */
  async function storeMember(event, openid) {
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')

    const gate = await memberGate(openid)
    if (gate) return gate

    if (!(await isActiveMember(openid))) {
      return { ok: false, kind: 'auth', error: '会员专属段落只对有效会员开放' }
    }

    const version = str(event.version)
    const id = version ? `${personKey}#${version}` : personKey
    const row = await readRow(MEMBER_COLLECTION, id)
    if (!row) return { ok: true, result: 'empty' }

    /* 当前版要拿端上主行的时间戳来配对；历史版以 version 为准（它本身就是配对键） */
    const expect = version || str(event.generatedAt)
    if (expect && str(row.generated_at) !== expect) {
      return { ok: true, result: 'mismatch', generated_at: str(row.generated_at) }
    }
    const sections = row.sections && typeof row.sections === 'object' ? row.sections : {}
    if (Object.keys(sections).length === 0) return { ok: true, result: 'empty' }
    return { ok: true, result: 'ok', generated_at: str(row.generated_at), sections }
  }

  /**
   * 写口 / 会员段读口分发。返回约定与 handleChat / handleSearch 一致（`{ ok, kind?, error?, result? }`）。
   *
   * ⚠ 与别处的**关键差别**：端上对 `ok:false` 必须区分两种情形 ——
   *   · 通道不可用（函数未部署 / 网络 / upstream）⇒ **回退端上直写**（老路径，功能不变）；
   *   · 明确拒绝（auth / badrequest / lock）⇒ **不回退**，否则等于绕过写口的校验去直写。
   *   （端上 quota-guard.ts 的「一律回退」在这里不成立：那边回退没有安全含义。）
   *
   * `op:'member'` 是这组里唯一的**读**（P2 方案 A，2026-10-17）：它在 `storeGate` 之前分流，
   * 走自己的 `memberGate`；且它的 `ok:false` 只有 auth / abuse 两种，端上一律静默退化成免费态。
   */
  return async function handleReportStore(event) {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) return { ok: false, kind: 'auth', error: '缓存写口需要登录身份（未取到 openid）' }

    const op = event.op
    if (
      op !== 'acquire' &&
      op !== 'release' &&
      op !== 'save' &&
      op !== 'saveParts' &&
      op !== 'saveFeed' &&
      op !== 'member'
    ) {
      return bad(`未知 op：${op}（支持 acquire / release / save / saveParts / saveFeed / member）`)
    }

    /*
     * personKey 在这里统一校验：acquire / release 也必须有它。
     * 这一步是实测补上的 —— 漏掉时空串会成为合法 `_id`，建出一行谁也认不出来的垃圾锁，
     * 而调用方还以为自己抢到了锁（save 那侧虽有校验，但锁已经脏了）。
     */
    const personKey = str(event.personKey)
    if (!personKey) return bad('缺少 personKey')
    if (personKey.length > MAX_KEY_LEN) return bad('personKey 过长')

    /* 读口在写口限速**之前**分流：它有自己的读限速（memberGate），不该吃掉写口那 400 次预算 */
    if (op === 'member') return storeMember(event, OPENID)

    const gate = await storeGate(OPENID)
    if (gate) return gate

    if (op === 'acquire') return storeAcquire(personKey, OPENID, event.schemaVersion)
    if (op === 'release') return storeRelease(personKey, OPENID)
    if (op === 'save') return storeSave(event, OPENID)
    if (op === 'saveParts') return storeSaveParts(event, OPENID)
    return storeSaveFeed(event)
  }
}
