import type { Report } from './report'

/**
 * 关键词云 + 高频观点（M4-5，V2）—— 端上聚合实现。
 *
 * 为什么不由模型再产出（例如给报告加一个 `keywords` 段）：
 * 1. 成本与稳定性：报告是「一次生成、长期缓存复用」的资产，多一段输出就多一处
 *    编造与非法 JSON 的机会，而词频统计并不需要语义推理。
 * 2. 存量缓存立即生效：纯端上聚合对 2026-10-06 之前落库的老报告一视同仁，
 *    不需要用户再消耗一次生成额度才看得到词云。
 * 3. 设计口径本就如此：§3.3 定的是「词云不做 canvas 方案，用 CSS 标签墙降级实现
 *    （flex 布局按词频映射字号）」，且明确要求走向上兼容的降级路径。
 *
 * 词源两层（互补）：
 * - 模型判定的话题（`report.stance[].topic`）：质量最高，直接进词表并优先展示；
 * - 报告正文（动态标题 / 摘要 + 语录原文）的汉字 n-gram 词频：补充模型没点名的说法。
 *
 * 中文没有词边界、端上也装不下词典，所以统计口径是「n-gram + 强过滤」而不是真分词，
 * 产出的是**高频说法**而非语言学意义上的词。因此 UI 只把命中 ≥2 条不同素材的候选
 * 摆出来，并逐条附佐证原文 —— 读的人可自行核对，不存在「AI 编出来的词」。
 */

/**
 * 候选词长度区间（1 字太碎，故下限 2）。
 *
 * 上限从 4 放宽到 5：4 字会卡掉「表演艺术家」「新能源汽车」这类真实的复合词，
 * 而它们恰恰是最能说明「这份报告在讲什么」的说法。放宽的代价由既有三条判据吸收 ——
 * BAD_HEAD / BAD_TAIL 挡虚词起收尾、`edge` 挡永远夹在汉字中间的碎片、`runs` 挡被标点
 * 截出来的搭配，再加「≥2 条素材命中」与重叠收敛，进墙的仍必须是可核对的反复说法。
 */
const MIN_LEN = 2
const MAX_LEN = 5

/**
 * 不能作词首的虚词：以这些字开头的 n-gram 几乎必然是跨词碎片（「的发布会」「在社交」）。
 */
const BAD_HEAD = new Set(
  '的了在和与及等为对是以之于其更最不无将被把从这那也就都又再很太各每某该此并却还'.split('')
)

/**
 * 不能作词尾的虚词。注意比 BAD_HEAD 窄得多：
 * 「会 / 能 / 有 / 要 / 中」这类字一旦放进尾表，就会误杀「发布会」「能力」「知名度」等真词。
 */
const BAD_TAIL = new Set('的了在和与及等为对是之以于上下后前时内个这那其并却还也就都又再'.split(''))

/**
 * 报道套话与泛词：单看没有信息量，却几乎必然登顶词频（每篇都写「公司」「表示」），
 * 必须在统计前剔除，否则词云会被这些词占满。
 */
const STOP_WORDS = new Set([
  '公司', '集团', '方面', '相关', '进行', '表示', '认为', '指出', '强调', '透露',
  '介绍', '回应', '报道', '消息', '新闻', '目前', '近日', '昨日', '今日', '本次',
  '此次', '以及', '同时', '此外', '然而', '不过', '旗下', '问题', '情况', '影响',
  '记者', '媒体', '网友', '用户', '市场', '时间', '数据', '内容', '观点'
])

/** 连续汉字串：标点、空白、URL、数字、英文一律不进词表 */
const HAN_RUN = /[\u4e00-\u9fa5]{2,}/g

/** 参与统计的一条素材：`text` 进词频，`label` / `source` 用于佐证展示 */
interface Unit {
  label: string
  source: string
  text: string
}

/** 佐证原文（高频观点列表里那一行小字） */
export interface KeywordRef {
  label: string
  source: string
}

export interface KeywordItem {
  word: string
  /** 命中的不同素材条数（同一素材重复说法不重复计数） */
  count: number
  /** topic = 模型判定的话题（质量最高）；text = 端上词频统计 */
  from: 'topic' | 'text'
  /** 字号档位：3 最大 / 1 最小（UI 映射字号用） */
  tier: 1 | 2 | 3
  /** 佐证原文，最多 2 条 */
  refs: KeywordRef[]
}

/**
 * 素材归一：动态与语录各成一条 unit。
 *
 * 只收「可佐证」的素材（动态有标题与媒体、语录有原文与场合），不收 `analysis` ——
 * 综合点评是模型写的二手表述，拿它统计词频等于让模型的话进词云，与「可核对」相悖。
 */
function collectUnits(report: Report): Unit[] {
  const units: Unit[] = []
  for (const d of report.dynamics) {
    units.push({
      label: d.title,
      source: d.source || '公开报道',
      text: `${d.title} ${d.summary}`
    })
  }
  for (const q of report.quotes) {
    const text = q.text || ''
    if (text.length < MIN_LEN) continue
    units.push({
      label: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      source: q.context || '公开语录',
      text
    })
  }
  return units
}

interface GramStat {
  /** 命中的素材下标（同一个 unit 内同词只记一次） */
  idxs: number[]
  /** 至少一次落在汉字片段的首 / 尾（即紧邻标点或文本边界） */
  edge: boolean
  /** 命中的不同汉字片段（run）数 —— 同一个片段内同词只计一次 */
  runs: number
}

/**
 * n-gram 词频统计。
 *
 * 同一个 unit 内同词只计一次：一条动态的摘要里把同一个说法重复三遍，不该比
 * 「三条不同动态都提到它」更有分量 —— 词云的「高频」要的是跨素材的共识。
 *
 * 同时记两个碎片判据：
 *
 * - `edge`：是否在某个汉字片段的首 / 尾出现过。中文没有词边界，纯 n-gram 必然切出
 *   跨词碎片（「小米发布新一代」会切出「发布新一」「布新一代」），而碎片有个稳定特征：
 *   **永远夹在汉字中间**；真词则常与标点相邻（「新品定价，」），所以「从未贴过片段边界」
 *   是一个廉价而有效的判据。
 * - `runs`：命中的不同片段数。`edge` 挡不住「恰好被标点截断在片段首尾」的搭配
 *   （「月交付量公布」被逗号断开后，「付量公布」正好位于片段末尾而冒充真词），
 *   但这类截断只会发生一次 —— **主题词会在多个不同片段里复现，碎片不会**。
 *   对比场景把 `minRuns` 提到 2，正是靠这一条把「付量公布」这类词筛下去。
 */
function countGrams(units: Unit[]): Map<string, GramStat> {
  const stats = new Map<string, GramStat>()
  units.forEach((u, idx) => {
    const runs = u.text.match(HAN_RUN) ?? []
    const seen = new Set<string>()
    const edge = new Set<string>()
    const runHits = new Map<string, number>()
    for (const run of runs) {
      /* 同一个片段内同词可能出现多次，片段数只记一次 */
      const inRun = new Set<string>()
      for (let len = MIN_LEN; len <= MAX_LEN; len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const word = run.slice(i, i + len)
          if (BAD_HEAD.has(word[0]) || BAD_TAIL.has(word[len - 1])) continue
          if (STOP_WORDS.has(word)) continue
          seen.add(word)
          inRun.add(word)
          if (i === 0 || i + len === run.length) edge.add(word)
        }
      }
      for (const word of inRun) runHits.set(word, (runHits.get(word) ?? 0) + 1)
    }
    for (const word of seen) {
      const st = stats.get(word)
      if (st) {
        st.idxs.push(idx)
        st.runs += runHits.get(word) ?? 0
        if (edge.has(word)) st.edge = true
      } else {
        stats.set(word, { idxs: [idx], edge: edge.has(word), runs: runHits.get(word) ?? 0 })
      }
    }
  })
  return stats
}

/**
 * 人物名与**人物名的碎片**。
 *
 * 只挡「包含完整人名」是不够的 —— 那正是「搜陈佩斯、词云出现『陈佩』」的成因：
 * 动态标题几乎条条以「陈佩斯……」开头，于是 2-gram「陈佩」「佩斯」命中数极高，
 * 又因为正好落在汉字片段开头而骗过边界判据，稳稳进入高频档；而真正的名字
 * 「陈佩斯」自己被 `word.includes(name)` 滤掉了，只剩两个半截名字留在墙上。
 * 反向包含（`name.includes(word)`）就把这类碎片一并挡住，且对 3 字以上的中文
 * 人名几乎不会误伤 —— 人名碎片本就很少恰好是常用词。
 *
 * 词云与语录主题共用这一条（两处若各写一份，总有一处会漏掉反向包含）。
 */
function isNamePart(word: string, name: string): boolean {
  return !!name && (word.includes(name) || name.includes(word))
}

/** 一个词的所有子串（长度 ≥ MIN_LEN）。重叠收敛时用来抑制同源的截断碎片 */
function substringsOf(w: string): string[] {
  const out: string[] = []
  for (let len = MIN_LEN; len < w.length; len++) {
    for (let i = 0; i + len <= w.length; i++) out.push(w.slice(i, i + len))
  }
  return out
}

/** 关键词抽取的可调口径（词云用默认值；对比场景放宽 minHits、收紧 minRuns） */
export interface KeywordOptions {
  /** 最多返回几个词（默认 16） */
  limit?: number
  /** 入选所需的不同素材命中条数（默认 2） */
  minHits?: number
  /** 入选所需的不同汉字片段数（默认 1） */
  minRuns?: number
}

/**
 * 抽取关键词云。
 *
 * 返回顺序即展示顺序（权重从高到低）。候选不足时返回空数组，由调用方决定整卡不渲染 ——
 * 与其摆出一片碎片词，不如不摆（素材本来就少的报告不该硬凑一张词云）。
 *
 * 两组调参对应两个场景，差别在「什么算高频」：
 * - **词云**（默认 `minHits: 2`）：同一份报告里至少两条素材提到，才算这家媒体真的在讲它；
 * - **两人对比**（`minHits: 1, minRuns: 2`）：跨人物求交集本就稀疏，且一份报告的动态往往
 *   只有 4~6 条，卡在 2 会让「共同关注点」几乎恒为空。放宽命中条数后，靠 `minRuns: 2`
 *   把「只在一个片段里被标点截出来」的搭配（如「付量公布」）挡在门外，噪声则由「两边都有」
 *   这个条件自然滤掉（随机搭配同时出现在两人报道里的概率很低）。
 */
export function extractKeywords(report: Report, options: KeywordOptions = {}): KeywordItem[] {
  const { limit = 16, minHits = 2, minRuns = 1 } = options
  const units = collectUnits(report)
  if (units.length === 0) return []

  const stats = countGrams(units)
  const name = (report.name || '').trim()
  const refsOf = (idxs: number[]): KeywordRef[] =>
    idxs.slice(0, 2).map((i) => ({ label: units[i].label, source: units[i].source }))

  const candidates: KeywordItem[] = []
  for (const [word, st] of stats) {
    /* 至少 minHits 条不同素材命中：只出现一次的多半是个例说法 */
    if (st.idxs.length < minHits) continue
    /* 从未贴过片段边界的候选是跨词碎片，不是可读的说法 */
    if (!st.edge) continue
    /* 只在单个片段里出现过的候选是标点截断的产物，不是主题词 */
    if (st.runs < minRuns) continue
    /* 人物名（及人名碎片）进词云没有意义（通篇都在讲 TA），还会挤掉真正的主题词 */
    if (isNamePart(word, name)) continue
    candidates.push({ word, count: st.idxs.length, from: 'text', tier: 1, refs: refsOf(st.idxs) })
  }

  /**
   * 话题态度里的话题名是模型判定的，质量高于任何端上统计口径：
   * 不受「≥2 条命中」约束（它可能只在一条素材里被点明），并额外计入权重。
   */
  for (const s of report.stance ?? []) {
    const topic = (s.topic || '').trim()
    if (topic.length < MIN_LEN || topic.length > 8) continue
    /* 话题恰好就是人名（或人名的半截）时同样不进：它不构成「在讲什么」的信息。
       注意这里只挡「是人名的一部分」，话题里**含有**人名仍保留（「马斯克收购推特」这类
       才是有内容的说法），与文本候选那边「包含人名即弃」的口径不同是有意为之。 */
    if (name && name.includes(topic)) continue
    const note = (s.note || '').trim()
    const existing = candidates.find((c) => c.word === topic)
    if (existing) {
      existing.from = 'topic'
      if (note) existing.refs = [{ label: note, source: '话题依据' }]
    } else {
      const hit = stats.get(topic)
      candidates.push({
        word: topic,
        count: hit ? hit.idxs.length : 1,
        from: 'topic',
        tier: 1,
        refs: note ? [{ label: note, source: '话题依据' }] : []
      })
    }
  }

  /* 话题 +1 作为权重：同频次时优先展示模型认定的主题，而不是统计出来的搭配 */
  const score = (k: KeywordItem) => k.count + (k.from === 'topic' ? 1 : 0)
  candidates.sort((a, b) => score(b) - score(a) || b.word.length - a.word.length)

  /* 重叠收敛：同一说法的长短两版只留一条（如「发布会」与「新品发布会」）。
     模型判定的话题豁免收敛：它可能恰好是某个文本词的局部（「新品定价」含「定价」），
     但那是报告的主题名，不该因为端上统计的粒度问题被丢掉。 */
  const picked: KeywordItem[] = []
  /**
   * 被收敛掉的候选，其内部片段也要一并抑制。
   *
   * 光靠「长短两版留一条」不够：「旗舰手机」并进「手机」之后，同源的截断碎片
   * 「旗舰手」（它在另一个片段里正好位于开头，所以骗过了边界判据）会浮上来，
   * 词云里就留下半个词。因此丢弃一个候选时，把它所有 ≥2 字的子串标记为不再采用。
   */
  const suppressed = new Set<string>()
  for (const c of candidates) {
    if (picked.length >= limit) break
    if (suppressed.has(c.word) && c.from !== 'topic') continue
    const covered = picked.some(
      (p) =>
        (p.word.includes(c.word) && p.count >= c.count) ||
        (c.word.includes(p.word) && c.count <= p.count)
    )
    if (covered && c.from !== 'topic') {
      for (const s of substringsOf(c.word)) suppressed.add(s)
      continue
    }
    picked.push(c)
  }

  /* 字号分档：靠前的三分之一最大，其次中档，其余最小；话题至少中档（它是明确主题） */
  const total = picked.length
  picked.forEach((k, i) => {
    const ratio = i / total
    k.tier = ratio < 0.3 ? 3 : ratio < 0.65 ? 2 : 1
    if (k.from === 'topic' && k.tier === 1) k.tier = 2
  })

  return picked
}

/**
 * 语录少于这么多条就不做主题聚类：两句本就能一眼看完，聚类只会把信息切碎。
 *
 * ⚠ 这个 4 不是保守取值，而是算法的**数学下界**：出卡要求归出 ≥2 组、每组命中
 * ≥MIN_THEME_HITS(2) 条不同语录，而互斥归类让一条语录只能进一组，故至少需要 2×2=4 条。
 * 于是结论是反直觉的：**这一卡恒为空态时，调低这个门槛没有用**（调到 3 仍出不了卡，
 * 因为第二组凑不出 2 条），真正的解法是让模型多给几条语录 —— 见 utils/report.ts
 * 提示词第 4 条的条数目标。写在这里，免得后人再试一次同样的调参。
 */
const MIN_QUOTES_FOR_THEMES = 4
/** 一个主题至少要有这么多条不同语录命中（同一条语录里重复三遍不算主题） */
const MIN_THEME_HITS = 2
/** 每个主题附带的语录原文条数上限（全文在「经典语录」卡里，这里只要代表例） */
const THEME_SAMPLE = 2
/** 主题里语录原文的截断长度 */
const THEME_QUOTE_CHARS = 40

/** 语录主题（「他常讲的话」分成了哪几类） */
export interface QuoteTheme {
  /** 主题词：来自语录原文的高频说法（n-gram），不是模型生成的分类名 */
  topic: string
  /** 归入该主题的语录条数 */
  count: number
  /** 代表语录（原文，最多 THEME_SAMPLE 条） */
  quotes: string[]
}

/**
 * 语录主题聚类 —— 把平铺的语录按「他常讲的话」归成 2~3 组。
 *
 * 复用词云的 n-gram 口径（同一份 countGrams、同一条人名判据），但**分组方式不同**：
 * 词云回答「哪些说法被反复提起」，这里回答「哪几条语录在讲同一件事」。做法是
 * **贪心互斥归类** —— 候选主题词按命中数排序，依次把尚未归属的语录收进自己名下，
 * 每条语录只归一个主题。互斥是刻意的：同一条语录出现在两个主题里，读者会以为
 * 语录总数对不上；而「一条语录讲了两件事」这种判断本就超出端上统计的能力范围。
 *
 * 返回顺序即展示顺序；主题不足 2 个时返回空数组，由调用方决定整卡不渲染
 * （只有一个「主题」等于没有分类，摆出来只会让人以为聚类坏了）。
 */
export function extractQuoteThemes(report: Report, options: { limit?: number } = {}): QuoteTheme[] {
  const { limit = 3 } = options
  const texts = (report.quotes ?? [])
    .map((q) => (q.text || '').trim())
    .filter((t) => t.length >= MIN_LEN)
  if (texts.length < MIN_QUOTES_FOR_THEMES) return []

  const units: Unit[] = texts.map((t) => ({
    label: t.length > THEME_QUOTE_CHARS ? `${t.slice(0, THEME_QUOTE_CHARS)}…` : t,
    source: '语录原文',
    text: t
  }))
  const stats = countGrams(units)
  const name = (report.name || '').trim()

  const candidates = Array.from(stats.entries())
    /* 至少被 2 条不同语录命中；且贴过片段边界（与词云同一条判据，见 countGrams 的说明） */
    .filter(([word, st]) => st.idxs.length >= MIN_THEME_HITS && st.edge && !isNamePart(word, name))
    .sort((a, b) => b[1].idxs.length - a[1].idxs.length || b[0].length - a[0].length)

  const themes: QuoteTheme[] = []
  const taken = new Set<number>()
  const suppressed = new Set<string>()
  for (const [word, st] of candidates) {
    if (themes.length >= limit) break
    if (suppressed.has(word)) continue
    const free = st.idxs.filter((i) => !taken.has(i))
    if (free.length < MIN_THEME_HITS) continue
    free.forEach((i) => taken.add(i))
    themes.push({
      topic: word,
      count: free.length,
      quotes: free.slice(0, THEME_SAMPLE).map((i) => units[i].label)
    })
    /* 主题词的长短两版只留一条（同词云的重叠收敛）：把子串一并抑制，免得
       「喜剧创作」之后又冒出「剧创作」这类截断碎片当第二个主题 */
    substringsOf(word).forEach((s) => suppressed.add(s))
  }

  return themes.length >= 2 ? themes : []
}
