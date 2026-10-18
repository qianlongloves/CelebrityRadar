import Taro from '@tarojs/taro'
import { table } from './db'
import { buildPersonKey, domainIdentityKey, parsePersonKey } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'
import type { PersonAliasRow, ReportCacheRow } from '@/types/db'
import { identityHeadlineOf, identityTokensOf, matchIdentity } from './person-identity'
import type { Report } from './report'

/**
 * 人物索引：名字 + 领域 → personKey 的**读取侧归一**（2026-10-12 建，2026-10-18 两次收窄）。
 *
 * 背景：`report_cache` 的主键是「名字#领域」，而领域由各入口自己决定 —— 迁移到自由领域后，
 * 同一个人的同名报告很容易被不同入口写成两行（实测「雷军#tech」与「雷军#auto」并存）。
 * 本文件在**不改云端接口、不改缓存契约**的前提下做一次「按 key 回退」的索引。
 *
 * ## 判据演进（同一份代码里的三次取舍，按时间读）
 *
 * **v1（2026-10-12）：只按名字**，取 `generated_at` 最新的一条。
 *   后果：**同名不同人**被合并 —— 搜「雷军」有两个候选（科技 / 投资），点哪个都落到同一份报告，
 *   用户看到的第二个人其实是第一个人的报告。这不是「少生成一次」，而是**给了错的报告**。
 *
 * **v2（2026-10-18 上午）：名字 + 领域**，领域同义（`domainLabel` 相等）才复用。
 *   堵住了串人，但把「同一个人跨领域」也当成两个人 —— 一个人裂成多份分报告（用户实测的问题）。
 *
 * **v3（2026-10-18，本版）：名字 + 领域 + 身份指纹**，三层判据：
 *   ① 领域**同组**（`domainIdentityKey` 相等：tech ↔ 科技 ↔ AI ↔ 芯片）→ 同一人，立即复用；
 *   ② 领域不同 → 看**用户确认过的别名**（`person_alias` 表，见 confirmPersonMerge）；
 *   ③ 还没有别名、但调用方给了 `brief`（候选的一句话身份）→ 拿它与同名报告的**机构指纹**
 *      （关联企业 / 代言品牌 / 档案里的所属机构）比对：强命中直接用同一份，弱命中只提示一句。
 *   都不成立 → 返回调用方给的「名字#领域」，各留一份（保守，绝不猜）。
 *
 * 为什么领域不是身份：领域是**检索轴**，同一个人横跨科技 / 汽车 / 投资是常态（雷军就是），
 * 把它当身份轴，必然是「跨领域就裂、按名字就串」两难。真正能判定身份的是
 * 「本人与哪些机构有明确关联」—— 那是报告里已有的东西（见 utils/person-identity.ts）。
 *
 * 判定顺序（一旦命中就不再查库）：
 *   ① 内存索引（最快，热路径）；
 *   ② storage 索引（键前缀 `pidx:` + `名字#领域`，冷启免一次云查询，best-effort）；
 *   ③ 一次 `report_cache` 查询（只取主键，按 generated_at 倒序取前几条）；
 *   ④ 只在「同名但领域都对不上」时才追加查询：先查别名，再（有 brief 时）拉正文取机构指纹；
 *   ⑤ 都没有 → 返回调用方给的「名字#领域」（即原行为，回退零副作用）。
 *
 * 三条硬约束，与 utils/portrait.ts 同一套哲学：
 *   · **端上零阻塞**：任何失败都退回入参 key，绝不抛错、绝不让页面变慢（命中后不再查库）；
 *   · **并发去重**：同一「名字#领域」的并发查询共用一个 promise，避免一次列表渲染打出一串重复查询；
 *   · **只读兜底**：这是存量分叉的回退路径，不碰计费与会员剥离口径；唯一的新写入是
 *     「用户点了一下确认/否认」的那一条别名（`person_alias`，全局共享、跨设备生效）。
 */

/** storage 键前缀：与用户数据、真图缓存（portrait:）分开，便于清理与排查 */
const STORAGE_PREFIX = 'pidx:'

/** 别名表（`名字#领域` → 已存在的 personKey；personKey 为空串 = 用户确认「不是同一位」） */
const ALIAS_TABLE = 'person_alias'

/**
 * 一次查询最多看几条同名报告（按 generated_at 倒序）。
 *
 * 用途只是「在这几条里找领域同组的那一行」：同名的不同领域通常只有 2~3 个，6 足够且是单次查询。
 * 超出这条窗口的同组行会被漏掉 —— 后果只是多生成一份报告，不会串人（判据是逐行比领域）。
 */
const NAME_FALLBACK_SCAN = 6

/**
 * 拿机构指纹时最多拉几份正文。
 *
 * 与 NAME_FALLBACK_SCAN 分开：这一层要 `select('report')`（整份报告，几十 KB），
 * 只在「同名但领域都对不上、且有 brief」时才发生 —— 分叉场景本就稀少，3 份足够覆盖。
 */
const IDENTITY_SCAN = 3

/** 内存索引：`名字#领域` → personKey（本会话内最快的一层） */
const memo = new Map<string, string>()

/** 内存里的合并信息（只在「自动判同」时有；纯 UI 文案用，丢了不影响正确性） */
const memoMerge = new Map<string, PersonMerge>()

/** 在途查询：同一索引键的并发 resolve 共用一个 promise（见文件头约束②） */
const inflight = new Map<string, Promise<PersonResolution>>()

/** 一次解析的合并结论：命中了谁、凭什么命中的 */
export interface PersonMerge {
  /** 被复用的那份报告的 personKey */
  personKey: string
  /** domain = 领域本身就对得上；alias = 用户确认过；brief = 机构指纹命中 */
  from: 'domain' | 'alias' | 'brief'
  /** 那份报告的领域（原串，UI 用它说「已用『科技』那份报告」） */
  domain: string
  /** 那份报告的一句话身份（可能为空，为空时 UI 不提身份） */
  headline: string
  /**
   * auto = 判定够强，本次直接用同一份；
   * maybe = 只能说「可能是这位」，personKey 仍是入参 key，等用户点一下确认。
   */
  strength: 'auto' | 'maybe'
}

export interface PersonResolution {
  /** 本次应该用的 personKey（maybe 时等于入参 key） */
  personKey: string
  merge?: PersonMerge
}

/**
 * 两个领域是不是「同一件事」。
 *
 * 判据是 `domainIdentityKey`：12 个已知码各自成组，中文标签与常见自创写法按同义组收口
 * （`科技 / AI / 人工智能 / 芯片` → tech，`投资 / 创投 / 财经` → finance），未收录的自由词
 * 只与自己字面相等。`tech` 与 `internet`、`business` 与 `finance` **刻意不同组**。
 *
 * ⚠ 不要在这里加模糊匹配（前缀 / 包含 / 编辑距离）：「科技」与「科技投资」若被当成一个领域，
 * 两个同名者会重新混成一份报告，正是 v1 要修的那个错。同义组是白名单，只收可以互换的写法。
 */
export function sameDomain(a: string, b: string): boolean {
  if (!a || !b) return false
  return domainIdentityKey(a) === domainIdentityKey(b)
}

/** 读 storage 索引；storage 不可用（H5 / 受限环境）时静默返回空串 */
function readStored(indexKey: string): string {
  try {
    const v = Taro.getStorageSync(STORAGE_PREFIX + indexKey)
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 写三层索引（内存 → storage）。storage 失败只是丢掉一次冷启优化，故整段包 try */
function remember(indexKey: string, personKey: string, merge?: PersonMerge): void {
  if (memo.get(indexKey) !== personKey) {
    memo.set(indexKey, personKey)
    try {
      Taro.setStorageSync(STORAGE_PREFIX + indexKey, personKey)
    } catch {
      /* 忽略：内存索引已生效，storage 失败不影响本次会话 */
    }
  }
  if (merge) memoMerge.set(indexKey, merge)
  else memoMerge.delete(indexKey)
}

/**
 * 记住「这个名字 + 这个领域对应的 personKey」。
 *
 * 生成成功（报告落库那条路径）、以及回退查询命中时调用。
 *
 * ⚠ 索引键必须带上领域（2026-10-18）：只按名字记，会让「搜过的第一个人」把同名的第二个人
 * 也带过去 —— 而且这条错误路径**冷启后仍然有效**（storage 里存着），比查库那条更难发现。
 */
export function rememberPerson(name: string, domain: string, personKey: string): void {
  if (!name || !personKey) return
  remember(buildPersonKey(name, domain), personKey)
}

/** 读用户确认过的别名；表还没建 / 读失败一律当「没有」 */
async function loadAlias(aliasKey: string): Promise<PersonAliasRow | null> {
  try {
    const { data, error } = await table(ALIAS_TABLE)
      .select('id,alias,personKey,name,domain,headline,at')
      .eq('alias', aliasKey)
      .limit(2)
    if (error || !data || !data.length) return null
    return data[0] as PersonAliasRow
  } catch {
    return null
  }
}

/**
 * 拿 brief 与同名报告的机构指纹比对（只在「领域都对不上」时才走到这里）。
 *
 * 二次查询要 `select('report')` 拉正文 —— 在此之前的所有路径都只取主键，一个字的正文都不拉。
 */
async function matchByBrief(
  name: string,
  brief: string
): Promise<{ verdict: 'same' | 'maybe'; rowId: string; domain: string; headline: string } | null> {
  try {
    const { data, error } = await table('report_cache')
      .select('id,report')
      .eq('report.name', name)
      .eq('state', 'ready')
      .order('generated_at', { ascending: false })
      .limit(IDENTITY_SCAN)
    if (error || !data || !data.length) return null

    let maybe: { verdict: 'maybe'; rowId: string; domain: string; headline: string } | null = null
    for (const row of data as ReportCacheRow[]) {
      if (!row?.id) continue
      const report = row.report as Report | undefined
      if (!report) continue
      const match = matchIdentity(brief, identityTokensOf(report))
      if (match.verdict === 'unknown') continue
      const hit = {
        rowId: row.id,
        domain: parsePersonKey(row.id)?.domain ?? '',
        headline: identityHeadlineOf(report)
      }
      /* 强命中直接定案；弱命中先记下，继续看有没有更强的（同名多行时取最强的那条） */
      if (match.verdict === 'same') return { verdict: 'same', ...hit }
      if (!maybe) maybe = { verdict: 'maybe', ...hit }
    }
    return maybe
  } catch (err) {
    diagLog('warn', 'db', `person-index 身份比对失败：${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 解析「这个名字 + 这个领域当前应该用的 personKey」，并说明**凭什么**归到一起。
 *
 * @param name   人名（已净化，不含 #）
 * @param domain 各入口自己给出的领域（码或自由短串）
 * @param brief  候选的一句话身份（`PersonCandidate.brief`）—— 有它才能做第 ③ 层判定；
 *               热榜 / 今日名人没有 brief，只能靠领域与别名。
 */
export async function resolvePersonIdentity(
  name: string,
  domain: string,
  brief?: string
): Promise<PersonResolution> {
  const fallback = buildPersonKey(name, domain)
  if (!name) return { personKey: fallback }

  /* ① 内存索引 */
  const memoed = memo.get(fallback)
  if (memoed) return { personKey: memoed, merge: memoMerge.get(fallback) }

  /* ② storage 索引 */
  const stored = readStored(fallback)
  if (stored) {
    memo.set(fallback, stored)
    return { personKey: stored, merge: memoMerge.get(fallback) }
  }

  /* ③ 在途查询去重 */
  const pending = inflight.get(fallback)
  if (pending) return pending

  const task = (async (): Promise<PersonResolution> => {
    try {
      /*
       * 只取主键：这里做的是「名字 + 领域 → personKey」的解析，正文一个字都用不到。
       * `select('*')` 每次都会把整份报告（18 节，含会员段）拉下来再扔掉 —— 一次名字回退
       * 就要拖几十 KB，而这条路径恰恰是「用户刚输入一个新名字」时最常走的那条。
       */
      const { data, error } = await table('report_cache')
        .select('id')
        .eq('report.name', name)
        .eq('state', 'ready')
        .order('generated_at', { ascending: false })
        .limit(NAME_FALLBACK_SCAN)
      if (error) {
        diagLog('warn', 'db', `person-index 回退查询失败：${error.message ?? error}`)
        return { personKey: fallback }
      }
      const rows = (data as ReportCacheRow[] | null) ?? []

      /* ③-1 领域同组 → 同一人 */
      for (const row of rows) {
        if (!row?.id) continue
        const parsed = parsePersonKey(row.id)
        /* 领域对不上就继续看下一条 —— 这正是「同名不同人」不被合并的那一行 */
        if (!parsed || !sameDomain(parsed.domain, domain)) continue
        const merge: PersonMerge = {
          personKey: row.id,
          from: 'domain',
          domain: parsed.domain,
          headline: '',
          strength: 'auto'
        }
        remember(fallback, row.id, merge)
        return { personKey: row.id, merge }
      }

      /* 一个同名的都没有：别名与 brief 都没有比对的对手，直接走入参 key */
      if (!rows.length) {
        memo.set(fallback, fallback)
        return { personKey: fallback }
      }

      /* ③-2 用户确认过的别名（含「确认不是同一位」的否定记录） */
      const alias = await loadAlias(fallback)
      if (alias) {
        if (!alias.personKey) {
          /* 用户明确说过「不是这位」：这一对「名字+领域」不再自动合并，也不再问 */
          memo.set(fallback, fallback)
          return { personKey: fallback }
        }
        /* 目标行必须还在（同名同库）—— 不在就当别名失效，否则会把用户送到一份不存在的报告 */
        const target = rows.find((r) => r?.id === alias.personKey)
        if (target) {
          const merge: PersonMerge = {
            personKey: alias.personKey,
            from: 'alias',
            domain: alias.domain || parsePersonKey(alias.personKey)?.domain || '',
            headline: alias.headline || '',
            strength: 'auto'
          }
          remember(fallback, alias.personKey, merge)
          return { personKey: alias.personKey, merge }
        }
      }

      /* ③-3 brief × 同名报告的机构指纹 */
      if (brief) {
        const hit = await matchByBrief(name, brief)
        if (hit && hit.verdict === 'same') {
          const merge: PersonMerge = {
            personKey: hit.rowId,
            from: 'brief',
            domain: hit.domain,
            headline: hit.headline,
            strength: 'auto'
          }
          remember(fallback, hit.rowId, merge)
          return { personKey: hit.rowId, merge }
        }
        if (hit && hit.verdict === 'maybe') {
          /*
           * 弱命中**不合并**：personKey 仍是入参 key，只把候选带回去让页面问一句。
           * 用户点了「是同一人」才落别名（confirmPersonMerge），此后永久复用。
           */
          memo.set(fallback, fallback)
          return {
            personKey: fallback,
            merge: {
              personKey: hit.rowId,
              from: 'brief',
              domain: hit.domain,
              headline: hit.headline,
              strength: 'maybe'
            }
          }
        }
      }

      /* 都没有：这是另一位同名者，按入参 key 走（不会被指向别人） */
      memo.set(fallback, fallback)
      return { personKey: fallback }
    } catch (err) {
      /* ④ 任何异常都退回入参 key（端上零阻塞，见文件头） */
      diagLog('warn', 'db', `person-index 回退异常：${err instanceof Error ? err.message : String(err)}`)
      return { personKey: fallback }
    } finally {
      inflight.delete(fallback)
    }
  })()

  inflight.set(fallback, task)
  return task
}

/**
 * 解析 personKey（薄封装，17 个调用点用这一个）。
 *
 * 需要「为什么合并」的文案时用 resolvePersonIdentity；只要 key 的调用点保持原样。
 */
export async function resolvePersonKey(name: string, domain: string, brief?: string): Promise<string> {
  const res = await resolvePersonIdentity(name, domain, brief)
  return res.personKey
}

/**
 * 用户点了「是同一人」：把「名字#领域」永久指向已有的 personKey。
 *
 * 写进 `person_alias`（`acl: publicRead`：所有人可读、登录可写），于是**跨设备、跨用户**都生效 ——
 * 同一个名字的同一种写法不需要每个人各点一次。写失败只影响「下次还要再问一次」，不阻断本次跳转。
 *
 * 校验：两边必须是同一个名字。否则一次误写就能把「张三」送到李四的报告上，
 * 而这层没有服务端校验（端上直写），所以校验必须放在这里，且读侧还要再验一次目标行存在。
 */
export async function confirmPersonMerge(
  name: string,
  domain: string,
  targetKey: string,
  headline = ''
): Promise<boolean> {
  const aliasKey = buildPersonKey(name, domain)
  const parsed = parsePersonKey(targetKey)
  if (!name || !parsed || parsed.name !== name || targetKey === aliasKey) return false
  try {
    const { error } = await table(ALIAS_TABLE).upsert(
      {
        id: aliasKey,
        alias: aliasKey,
        personKey: targetKey,
        name,
        domain,
        headline,
        at: new Date().toISOString()
      },
      { onConflict: 'id' }
    )
    if (error) {
      diagLog('warn', 'db', `person_alias 写入失败：${error.message ?? error}`)
      return false
    }
    remember(aliasKey, targetKey, {
      personKey: targetKey,
      from: 'alias',
      domain: parsed.domain,
      headline,
      strength: 'auto'
    })
    return true
  } catch (err) {
    diagLog('warn', 'db', `person_alias 写入异常：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * 用户点了「不是同一位」：记下这个否定结论，此后不再自动合并、也不再问。
 *
 * 用同一条记录、`personKey` 空串表示否定（不另开表）：读侧看到空串就直接走入参 key。
 */
export async function rejectPersonMerge(name: string, domain: string): Promise<boolean> {
  const aliasKey = buildPersonKey(name, domain)
  if (!name) return false
  try {
    const { error } = await table(ALIAS_TABLE).upsert(
      {
        id: aliasKey,
        alias: aliasKey,
        personKey: '',
        name,
        domain,
        headline: '',
        at: new Date().toISOString()
      },
      { onConflict: 'id' }
    )
    if (error) {
      diagLog('warn', 'db', `person_alias 否定写入失败：${error.message ?? error}`)
      return false
    }
    memo.set(aliasKey, aliasKey)
    memoMerge.delete(aliasKey)
    try {
      Taro.setStorageSync(STORAGE_PREFIX + aliasKey, aliasKey)
    } catch {
      /* 忽略 */
    }
    return true
  } catch (err) {
    diagLog('warn', 'db', `person_alias 否定写入异常：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
