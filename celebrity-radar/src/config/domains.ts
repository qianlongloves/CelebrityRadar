/**
 * 领域码枚举与展示元数据（§1.6）。
 *
 * 【2026-10-08 由 6 个扩到 12 个】原先「互联网 / 财经 / 汽车 / 健康 / 教育 / 艺术」被分别塞进
 * tech / business / ent / other 四个筐里，三个后果：① 发现页只能按粗颗粒筛，「查一位财经人物」
 * 与「查一位企业家」走同一个筛选；② 消歧时 domainHint 越粗，同名跨行业干扰越多，LLM 越容易选错人；
 * ③ personKey 里的领域码过粗，「黄仁勋#tech」与「张小龙#tech」在缓存层看不出差别。
 *
 * ⚠ 新增 / 删除领域码时，除本文件外还有四处必须同步（**漏改大多不会报错，只在运行时露馅**）：
 *   1. `src/utils/share-card.ts` 的 DOMAIN_COLOR —— 完备映射，漏了会**编译报错**（这是好事）；
 *   2. `src/styles/variables.scss` 的 `$domain-*` + 各页面 SCSS 的 `--<领域码>` 变体类（共 14 处，
 *      头像 / 图标底色），漏了只是**没有颜色**、不报错，是最难发现的一类；
 *   3. `cloudfunctions/hotBoardRefresh/index.js` 的 DOMAINS 与提示词领域清单（决定榜单分域检索）；
 *   4. `src/utils/explore.ts` / `src/utils/disambiguate.ts` 提示词里的领域枚举（AI 选题 / 消歧）。
 * 另需同步 `test/cases/01-pure.js` 里写死的领域码数量断言。
 *
 * 【2026-10-12 领域自由化】领域码从「固定 12 值枚举」放宽为**自由短串**：消歧 / 选题时若
 * 12 个已知领域都不贴切，模型可自创一个短领域词。于是本文件新增两条**唯一出口**：
 *   · 标签一律走 `domainLabel()`（已知码给中文标签，自创词原样展示，空值回落「其他」）；
 *   · CSS 变体类一律走 `domainStyleCode()`（未知领域复用中性 `other`，14 处 SCSS 无需新增）。
 * 再有人直接写 `DOMAIN_META[x].label` / `chip--${domain}`，遇到自由领域就会得到 undefined 或
 * 无样式的类名 —— 这正是散落各处、漏改即白屏的一类。
 *
 * 顺序即发现页「行业」筛选 chips 的展示顺序（常见领域在前、长尾在后）。
 */
export type DomainCode =
  | 'tech'
  | 'internet'
  | 'business'
  | 'finance'
  | 'auto'
  | 'ent'
  | 'art'
  | 'sports'
  | 'health'
  | 'academia'
  | 'edu'
  | 'other'

export const DOMAIN_CODES: DomainCode[] = [
  'tech',
  'internet',
  'business',
  'finance',
  'auto',
  'ent',
  'art',
  'sports',
  'health',
  'academia',
  'edu',
  'other'
]

export const DOMAIN_META: Record<DomainCode, { label: string }> = {
  tech: { label: '科技' },
  internet: { label: '互联网' },
  business: { label: '商业' },
  finance: { label: '财经' },
  auto: { label: '汽车' },
  ent: { label: '文娱' },
  art: { label: '艺术' },
  sports: { label: '体育' },
  health: { label: '健康' },
  academia: { label: '学术' },
  edu: { label: '教育' },
  other: { label: '其他' }
}

/**
 * 「查询范围」文案（空态页 / 隐私协议页共用）。
 *
 * 从领域码派生而不是手写：此前三处手写的清单停在「科技、商业、财经、文娱、体育、学术」，
 * 新增六个领域后肉眼几乎看不出漏了谁。排除 `other` —— 它不是可检索的领域，
 * 列进「我们覆盖 XX 等领域」里等于承诺能查「其他」。
 */
export const DOMAIN_COVERAGE_TEXT = DOMAIN_CODES.filter((c) => c !== 'other')
  .map((c) => DOMAIN_META[c].label)
  .join('、')

export function isDomainCode(v: string): v is DomainCode {
  return (DOMAIN_CODES as string[]).includes(v)
}

/**
 * 自创领域串的长度上限（2026-10-12 领域自由化）。
 *
 * 12 是最长已知标签「互联网 / 学术」的两倍余量：够放下「脱口秀 / 建筑设计」这类短词，
 * 又不至于把一整句描述当成领域塞进 personKey（那会把缓存主键撑成一个短句）。
 */
export const DOMAIN_FREE_MAX = 12

/**
 * 净化领域串（2026-10-12 领域自由化后的**统一入口**）。
 *
 * 领域码放宽成「AI 现编的短词」后，它仍会进 personKey 与 URL 参数，所以必须先收口：
 * 去掉 `#` / `＃`（会让主键切错位）、去掉所有空白、截到 DOMAIN_FREE_MAX 字。
 * 净化后为空 = 非法，调用方据此回落 'other' / 「其他」。
 */
export function sanitizeDomain(raw: unknown): string {
  const s = raw == null ? '' : String(raw)
  return s.replace(/[#＃\s]/g, '').slice(0, DOMAIN_FREE_MAX)
}

/**
 * 是否为「已处于净化形态」的合法领域串：净化结果与自身一致且非空。
 * 已知的 12 个领域码也满足（它们本就是干净短串），故这里不区分已知 / 自创。
 */
export function isFreeDomain(v: string): boolean {
  return typeof v === 'string' && v !== '' && sanitizeDomain(v) === v
}

/**
 * 领域展示名（**所有标签查询的唯一出口**，不要再写 `DOMAIN_META[x].label`）。
 *
 * · 已知领域码 → 其中文标签（科技 / 财经…），与发现页筛选 chips 完全一致；
 * · AI 自创的自由领域 → **原样展示**（它本就是给人看的短词，翻译只会失真）；
 * · 空 / 非法 → 回落「其他」，保证任何脏数据都画得出一个标签、不阻断出图。
 */
export function domainLabel(code: string): string {
  return DOMAIN_META[code as DomainCode]?.label ?? (sanitizeDomain(code) || '其他')
}

/**
 * 领域对应的 SCSS 变体码（**只在拼 `--<code>` 类名时使用**，标签另走 domainLabel）。
 *
 * 自由领域没有自己的颜色 / 背景变体类，统一复用中性色 `other` —— 于是那 14 处 SCSS
 * 变体块永远不需要为新领域补一行，类名也永远不会拼出一个不存在的样式。
 */
export function domainStyleCode(code: string): DomainCode {
  return isDomainCode(code) ? code : 'other'
}

/**
 * 生成稳定 personKey：名字#领域（§1.6）。
 *
 * 名字里的 `#` 会让**所有**按 `#` 切分的地方错位（这是缓存主键，也进 URL 参数），
 * 故在此收口兜底：正常路径已在上游净化（utils/disambiguate.ts#sanitizeCandidates），
 * 但不能让任何一个漏网的 `#` 造出一个会分裂的 key —— 那意味着同一个人的报告存成两行。
 * 领域同样要净化（2026-10-12 自由化后可能是自创词）：一个漏网的 `#` 会把领域切成两半，
 * 净化后为空则回落 'other'，保证 key 永远只有一个分隔符、且领域段非空。
 */
export function buildPersonKey(name: string, domain: string): string {
  return `${name.replace(/[#＃]/g, '').trim()}#${sanitizeDomain(domain) || 'other'}`
}

/**
 * 解析 personKey（容错：名字或领域为空返回 null）。
 *
 * 领域自 2026-10-12 起是**自由短串**，故这里不再要求是 12 个已知码之一，
 * 只要求净化后非空。`lastIndexOf('#')` 与「容忍老 key 里残留的 #（`A#B#ent`）」不变。
 */
export function parsePersonKey(personKey: string): { name: string; domain: string } | null {
  const idx = personKey.lastIndexOf('#')
  if (idx <= 0) return null
  const name = personKey.slice(0, idx)
  const domain = sanitizeDomain(personKey.slice(idx + 1))
  return name && domain ? { name, domain } : null
}
