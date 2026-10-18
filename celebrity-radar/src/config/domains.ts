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
 * 领域「同义组」表（2026-10-18）：**只用于身份判定，不改展示、不改存储**。
 *
 * 为什么需要它：领域是 2026-10-12 之后就自由化的短串，同一个行业会被写成许多种样子 ——
 * 「科技 / AI / 人工智能 / 大模型 / 芯片」都是 tech，「投资 / 创投 / 财经 / 私募」都是 finance。
 * 若判定「是不是同一个人」时按字面比领域，同一个人从四个入口进来就会裂成四份报告
 * （见 utils/person-index.ts 的判据演进）。这里把同义写法收口成**同一组的键**，
 * 组内视为同一领域，跨组（tech ↔ internet、business ↔ finance、auto ↔ tech）**绝不合并** ——
 * 那已经是「相邻但不同」的行业，合并等于把两个同名者重新混起来。
 *
 * 刻意只做「同义归一」，不做模糊匹配：别名表是白名单，写进来的每一对都是可以互换的；
 * 没有收录的自由词只与自己字面相等（保持自由领域的原样行为）。
 *
 * ⚠ 它**不参与** buildPersonKey：personKey 里的领域段仍是入口给的原串。归一放在判定这一侧，
 * 存量行（`雷军#科技`）与新入口（`雷军#tech`）因此不需要迁移就自动被认成同一个人。
 */
const DOMAIN_IDENTITY_ALIASES: Record<string, DomainCode> = {
  /* tech：硬件 / 软件 / 半导体 / 算法 都属于「科技」这一组 */
  科技: 'tech',
  硬科技: 'tech',
  AI: 'tech',
  ai: 'tech',
  人工智能: 'tech',
  大模型: 'tech',
  算法: 'tech',
  芯片: 'tech',
  半导体: 'tech',
  硬件: 'tech',
  软件: 'tech',
  云计算: 'tech',
  算力: 'tech',
  通信: 'tech',
  手机: 'tech',
  消费电子: 'tech',
  智能硬件: 'tech',
  机器人: 'tech',
  /* internet：与 tech 刻意分开 */
  互联网: 'internet',
  电商: 'internet',
  社交: 'internet',
  短视频: 'internet',
  本地生活: 'internet',
  平台经济: 'internet',
  内容平台: 'internet',
  /* business：与 finance 刻意分开 */
  商业: 'business',
  企业: 'business',
  企业家: 'business',
  商界: 'business',
  创业: 'business',
  /* finance */
  财经: 'finance',
  金融: 'finance',
  投资: 'finance',
  投资人: 'finance',
  创投: 'finance',
  风投: 'finance',
  私募: 'finance',
  基金: 'finance',
  证券: 'finance',
  银行: 'finance',
  保险: 'finance',
  资本市场: 'finance',
  /* 模型偶尔给拉丁缩写（「vc / pe / invest」），与中文同义，一并归组 */
  vc: 'finance',
  pe: 'finance',
  invest: 'finance',
  /* auto */
  汽车: 'auto',
  造车: 'auto',
  新能源: 'auto',
  新能源车: 'auto',
  新能源汽车: 'auto',
  智能汽车: 'auto',
  自动驾驶: 'auto',
  出行: 'auto',
  ev: 'auto',
  /* ent */
  文娱: 'ent',
  娱乐: 'ent',
  影视: 'ent',
  音乐: 'ent',
  综艺: 'ent',
  明星: 'ent',
  演艺: 'ent',
  偶像: 'ent',
  短剧: 'ent',
  相声: 'ent',
  /* art */
  艺术: 'art',
  美术: 'art',
  设计: 'art',
  建筑: 'art',
  时尚: 'art',
  摄影: 'art',
  /* sports */
  体育: 'sports',
  竞技: 'sports',
  电竞: 'sports',
  足球: 'sports',
  篮球: 'sports',
  赛事: 'sports',
  /* health */
  健康: 'health',
  医疗: 'health',
  医药: 'health',
  生物: 'health',
  医学: 'health',
  养生: 'health',
  /* academia */
  学术: 'academia',
  科研: 'academia',
  高校: 'academia',
  学者: 'academia',
  科学: 'academia',
  /* edu */
  教育: 'edu',
  教学: 'edu',
  培训: 'edu',
  教培: 'edu'
}

/**
 * 领域在**身份判定**里的归一键（同义组内相等，跨组不等）。
 *
 * · 12 个已知码 → 自身（`tech` 与 `internet` 仍是两个领域）；
 * · 中文标签与常见自创写法 → 查同义组表，落到该组的码；
 * · 未收录的自由词 → 净化后的原串（只与自己相等）。
 * 空 / 非法 → `'other'`，与 buildPersonKey 的回落一致（否则「空领域」会自成一类）。
 */
export function domainIdentityKey(domain: string): string {
  const s = sanitizeDomain(domain)
  if (!s) return 'other'
  if (isDomainCode(s)) return s
  /* 拉丁写法大小写不敏感（「AI」/「ai」），中文不受影响 */
  return DOMAIN_IDENTITY_ALIASES[s] ?? DOMAIN_IDENTITY_ALIASES[s.toLowerCase()] ?? s
}

/**
 * 一个领域串的**展示名**（给「已并入『科技』那份报告」这类提示用）。
 *
 * 与 domainLabel 的差别只在自由词：`AI` 直接展示是「AI」，但它属于 tech 组，
 * 提示里说「科技」比说「AI」更能让用户对上号 —— 故先归一再取标签，
 * 唯一例外是未收录的自由词（归一键就是原串，原样展示）。
 */
export function domainDisplayForKey(domain: string): string {
  const key = domainIdentityKey(domain)
  /* 未收录的自由词：原样展示（domainLabel 会原样返回它） */
  return isDomainCode(key) ? domainLabel(key) : domainLabel(domain)
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
