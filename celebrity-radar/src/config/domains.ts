/** 领域码枚举与展示元数据（§1.6） */
export type DomainCode = 'tech' | 'business' | 'ent' | 'sports' | 'academia' | 'other'

export const DOMAIN_CODES: DomainCode[] = ['tech', 'business', 'ent', 'sports', 'academia', 'other']

export const DOMAIN_META: Record<DomainCode, { label: string }> = {
  tech: { label: '科技' },
  business: { label: '商业' },
  ent: { label: '文娱' },
  sports: { label: '体育' },
  academia: { label: '学术' },
  other: { label: '其他' }
}

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
