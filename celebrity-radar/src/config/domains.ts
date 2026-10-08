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

/** 生成稳定 personKey：名字#领域码（§1.6） */
export function buildPersonKey(name: string, domain: DomainCode): string {
  return `${name}#${domain}`
}

/** 解析 personKey（容错：非法输入返回 null） */
export function parsePersonKey(personKey: string): { name: string; domain: DomainCode } | null {
  const idx = personKey.lastIndexOf('#')
  if (idx <= 0) return null
  const name = personKey.slice(0, idx)
  const domain = personKey.slice(idx + 1)
  return isDomainCode(domain) && name ? { name, domain } : null
}
