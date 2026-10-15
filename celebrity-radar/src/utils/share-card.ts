import Taro from '@tarojs/taro'
import { domainLabel, domainStyleCode, DomainCode } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'
import { pageCodeTarget, reportCodeTarget, shareCodeUrl } from './share-code'
import type { ShareCodeTarget } from './share-code'
import type { ReportCardModel } from './report-card'
import { BRIEF_POINT_MAX } from './weekly-brief'
import type { WeeklyBrief } from './weekly-brief'

/**
 * 分享卡片（§2.1 M6-1 / §4.2 分享流，P1「验证性实现」）。
 *
 * 本文件只做两件事：把已有内容画成一张图、把图交给系统（保存相册 / 拉转发菜单）。
 * 内容从哪来由调用方决定（报告页 / 收藏页），这里只认入参。
 *
 * 三个刻意的取舍：
 *
 * 1. **不落云 Storage**。设计方案写的是「canvas → 云 Storage → 分享 / 保存」，但这一步在本
 *    功能里没有承接方：`saveImageToPhotosAlbum` 与 `showShareImageMenu` 都只吃**本地临时路径**，
 *    朋友圈分享传的是 query 不是图。上传只会给云存储留下一份用户私人收藏的副本（成本与隐私
 *    面积都变大），因此不做 —— 图片用完即弃，正是分享图应有的生命周期。
 *
 * 2. **固定尺寸，不做自适应高度**。真机 Canvas 2D 尺寸一经设定再改就是又一轮重绘，而卡片内容本就短；
 *    名言卡高度按 3:4 竖版取 520，长文本按行截断补省略号 —— 固定尺寸免掉「先量高再重画」的两次绘制。
 *
 * 3. **正文零网络依赖，只有页脚的小程序码要联网**（2026-10-15 获客改造）。头像全项目本就用
 *    「领域色渐变 + 姓名首字」占位，卡片把这个约定继承下来：正文不占合法域名、不等待下载、
 *    不会裂图。唯一的例外是页脚那个**小程序码**（图一旦被保存进相册 / 发进朋友圈，就脱离了
 *    微信转发链路，图上没有码等于这趟传播到此为止）—— 码走云函数生成 + 云存储临时链接，
 *    仍**不落端上任何密钥**，且**取不到就降级**成「微信搜索「名人雷达」」的文字引导，
 *    绝不因为一张码让用户存不出一张图（见 utils/share-code.ts）。
 */

/** 逻辑宽度（px）。canvas 只认 px，与 rpx 无关；375 = 一倍图设计稿宽度 */
export const POSTER_WIDTH = 375
/** 名言卡高度：方寸之间只放一句话，比例按 3:4 竖版取 */
export const QUOTE_POSTER_HEIGHT = 520

/**
 * 渲染倍率上限。
 * dpr=3 的机器上 750×2520 已占十几 MB 显存，而卡片是文字排版，2 倍足够清晰 —— 再高只是白烧内存，
 * 低端机上反而更容易撞到 canvas 内存上限。
 */
const MAX_SCALE = 2

/**
 * 画布**物理高度**上限（px）。
 *
 * 名言卡 / 周报卡都是固定高度，2 倍图从没出过问题；报告长图不一样（一张 ≈ 1000~1300 逻辑 px），
 * 在 dpr 2 下就是 2600 物理 px 起步，长报告会一路顶到 canvas 缓冲区上限（真机表现为导出白图或
 * canvasToTempFilePath 失败）。故倍率按目标高度反算：越高越降，最低 1 倍 —— 宁可略微不锐，
 * 不能导不出来。
 */
const MAX_PHYSICAL_H = 4000

/** 卡片内边距与页脚高度：所有绘制函数共用同一套栅格 */
const PAD = 28
/**
 * 页脚高度。
 *
 * 2026-10-15 由 66 抬到 96：页脚多了小程序码（64 + 上下留白），左侧也从「应用名 + 免责」
 * 两行变三行（多一行入口引导）。所有引用 FOOT_H 的排版（名言卡出处、周报说明）都按常量
 * 自适应，抬高度不会压到正文。
 */
const FOOT_H = 96

/** 页脚小程序码的边长（逻辑 px）。64 × 2 倍图 = 128 物理 px，缩在相册缩略图里也扫得动 */
const CODE_SIZE = 64

/**
 * 合规硬要求：任何一张分享出去的图上都必须带这行字（截图转发也带得走）。
 * 2026-10-15 从「AI 生成，仅供参考」改成点明来源属性 —— 图会脱离小程序到处流转，
 * 「公开信息」这四个字得跟着走。
 */
const DISCLAIMER = '基于公开信息 AI 整理，仅供参考'
const APP_NAME = '名人雷达'

/** 设计令牌（与 styles/variables.scss 同值，刻意不引 SCSS —— canvas 需要的是十六进制字面量） */
const COLOR = {
  brand: '#5F33E1',
  brandSoft: '#8764FF',
  ink2: '#6E6A7C'
} as const

/** 领域色（同 variables.scss 的 $domain-*，用于头像底色与领域胶囊） */
const DOMAIN_COLOR: Record<DomainCode, string> = {
  tech: '#0087FF',
  internet: '#06B6D4',
  business: '#FF7D53',
  finance: '#F59E0B',
  auto: '#6366F1',
  ent: '#EC4899',
  art: '#A855F7',
  sports: '#10B981',
  health: '#F43F5E',
  academia: '#5F33E1',
  edu: '#14B8A6',
  other: '#6E6A7C'
}

/* ===== 类型：小程序端没有 DOM 类型可用，这里只声明本文件真正用到的成员 ===== */

interface Gradient {
  addColorStop(offset: number, color: string): void
}

interface Ctx2D {
  fillStyle: string | Gradient
  strokeStyle: string
  lineWidth: number
  font: string
  textAlign: string
  textBaseline: string
  scale(x: number, y: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  closePath(): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient
  /** 页脚小程序码用：其余内容都是矢量绘制，不吃图片 */
  drawImage(image: CanvasImage, x: number, y: number, w: number, h: number): void
}

/**
 * Canvas 2D 的图片对象（`canvas.createImage()` 产出）。
 *
 * 只能用 canvas 节点自带的 createImage：小程序的 `<Image>` 与 `Taro.createImage()` 都拿不到
 * 能喂给 `drawImage` 的对象。`src` 必须是网络 URL 或本地路径，`cloud://` 要先换临时链接。
 */
interface CanvasImage {
  src: string
  width: number
  height: number
  onload: (() => void) | null
  onerror: (() => void) | null
}

interface CanvasNode {
  width: number
  height: number
  getContext(type: '2d'): Ctx2D
  /** 基础库 ≥ 2.7.0 才有；缺它就画不了码（降级为文字引导） */
  createImage?: () => CanvasImage
}

/* ===== 排版原语 ===== */

/** 圆角矩形路径。低版本基础库没有 ctx.roundRect，自己用 arcTo 拼 */
function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 需要独立成行的标点与汉字：中文逐字断行才不会把标点甩到行首 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef\u2018\u2019\u201c\u201d\u2026\u2014]/

/**
 * 折行。
 *
 * 按「token」而不是按字符推进：一个连续的英文 / 数字串算一个 token，
 * 于是 `AI`、`ChatGPT`、`2026` 不会被从中间劈开（劈开的中文行读得出来，劈开的单词不行）。
 * 单个 token 本身就超宽时（比如一长串网址）才退化成按字符硬切。
 */
function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const tokens: string[] = []
  let buf = ''
  for (const ch of text) {
    if (ch === '\n') {
      if (buf) tokens.push(buf)
      buf = ''
      tokens.push('\n')
    } else if (CJK.test(ch) || ch === ' ') {
      if (buf) tokens.push(buf)
      buf = ''
      if (ch !== ' ') tokens.push(ch)
    } else {
      buf += ch
    }
  }
  if (buf) tokens.push(buf)

  const lines: string[] = []
  let line = ''
  const push = (s: string) => {
    lines.push(s)
    line = ''
  }
  for (const tk of tokens) {
    if (tk === '\n') {
      push(line)
      continue
    }
    if (ctx.measureText(line + tk).width <= maxWidth) {
      line += tk
      continue
    }
    /* 换行前先把行尾空格吃掉，否则会在行首形成一小段空白 */
    if (line.trim() !== '') push(line.trimEnd())
    if (ctx.measureText(tk).width <= maxWidth) {
      line = tk
      continue
    }
    /* 单个 token 超宽：硬切 */
    for (const ch of tk) {
      if (ctx.measureText(line + ch).width > maxWidth && line !== '') push(line)
      line += ch
    }
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  return lines.length > 0 ? lines : ['']
}

interface TextOpts {
  x: number
  y: number
  size: number
  maxWidth: number
  color: string
  weight?: 'bold'
  lineHeight?: number
  /** 超出即截断并补省略号 —— 固定尺寸卡片里，宁少一行也不越界压住下一段 */
  maxLines?: number
}

/** 画一段折行文字，返回下一段的起始 y */
function drawText(ctx: Ctx2D, text: string, opts: TextOpts): number {
  const content = text.trim()
  if (content === '') return opts.y
  ctx.fillStyle = opts.color
  ctx.font = `${opts.weight ? 'bold ' : ''}${opts.size}px sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  const lh = opts.lineHeight ?? Math.round(opts.size * 1.55)
  const lines = wrapText(ctx, content, opts.maxWidth)
  const max = opts.maxLines ?? lines.length
  let shown = lines.slice(0, max)

  if (lines.length > max && shown.length > 0) {
    let last = shown[shown.length - 1]
    while (last.length > 1 && ctx.measureText(`${last}…`).width > opts.maxWidth) {
      last = last.slice(0, -1)
    }
    shown = [...shown.slice(0, -1), `${last}…`]
  }

  shown.forEach((line, i) => ctx.fillText(line, opts.x, opts.y + i * lh))
  return opts.y + shown.length * lh
}

/** 品牌渐变底：卡片截图流转出去后，也要一眼认得出是同一款产品 */
function paintBrandBg(ctx: Ctx2D, w: number, h: number): void {
  const bg = ctx.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, COLOR.brand)
  bg.addColorStop(1, COLOR.brandSoft)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  /* 右上角柔光：纯色大图在手机屏上偏闷，加一层径向高光提亮 */
  const glow = ctx.createRadialGradient(w * 1.02, -h * 0.1, 0, w * 1.02, -h * 0.1, w * 1.2)
  glow.addColorStop(0, 'rgba(255,255,255,0.30)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)
}

/** 头像：领域色底 + 姓名首字（与 person-card / 报告页同一套占位约定）。领域放宽为自由串，配色经 domainStyleCode 兜底 */
function paintAvatar(ctx: Ctx2D, x: number, y: number, size: number, name: string, domain: string): void {
  ctx.fillStyle = DOMAIN_COLOR[domainStyleCode(domain)] ?? COLOR.ink2
  ctx.beginPath()
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `bold ${Math.round(size * 0.46)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name.slice(0, 1), x + size / 2, y + size / 2 + 1)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
}

/**
 * 页脚：一条分隔线 + 应用名 + 免责角标 + **小程序码**。免责是合规硬要求，不在图上就等于没有。
 *
 * 左侧固定三行（应用名 / 免责 / 入口引导），右侧是码。码拿不到时第三行回落成
 * 「微信搜索「名人雷达」」—— 图照样存得出、照样转得走，只是入口从「扫」变成「搜」。
 */
function paintFooter(ctx: Ctx2D, w: number, h: number, code?: CanvasImage): void {
  const top = h - FOOT_H
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, top)
  ctx.lineTo(w - PAD, top)
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillText(APP_NAME, PAD, top + 20)

  ctx.fillStyle = 'rgba(255,255,255,0.72)'
  ctx.font = '12px sans-serif'
  ctx.fillText(DISCLAIMER, PAD, top + 44)

  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = '11px sans-serif'
  ctx.fillText(code ? '扫码看完整报告' : '微信搜索「名人雷达」', PAD, top + 68)

  if (!code) return

  /* 码底下垫一块白：紫底上直接贴码，边缘对比不足会扫不动 */
  const boxX = w - PAD - CODE_SIZE - 5
  const boxY = top + 16 - 5
  ctx.fillStyle = '#FFFFFF'
  roundRect(ctx, boxX, boxY, CODE_SIZE + 10, CODE_SIZE + 10, 8)
  ctx.fill()
  ctx.drawImage(code, boxX + 5, boxY + 5, CODE_SIZE, CODE_SIZE)
}

/**
 * 取并解码页脚小程序码图；**任何一步失败都返回 undefined**（调用方画文字引导）。
 *
 * 超时兜底是必需的：canvas 的 image 若既不触发 onload 也不触发 onerror（网络半死、
 * 域名未配置时真机上见过），出图会一直挂在「正在生成卡片…」上 —— 宁可没有码。
 */
async function loadCodeImage(canvas: CanvasNode, target: ShareCodeTarget): Promise<CanvasImage | undefined> {
  try {
    const url = await shareCodeUrl(target)
    if (!url || typeof canvas.createImage !== 'function') return undefined

    const img = canvas.createImage()
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      img.onload = () => done(true)
      img.onerror = () => done(false)
      /* src 必须在挂好回调之后再赋值，否则同步缓存命中时回调会被漏掉 */
      img.src = url
    })

    return loaded ? img : undefined
  } catch (err) {
    diagLog('warn', 'storage', `分享图小程序码解码失败：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/* ===== 名言卡 ===== */

export interface QuoteCardInput {
  name: string
  /** 领域（自由短串）：标签走 domainLabel、配色走 domainStyleCode */
  domain: string
  text: string
  /** 出处场合（如「2024 年度演讲」），空则回落「公开场合」，与报告页口径一致 */
  context?: string
  /** 人物键：有它页脚的码就指向这个人的报告页，扫码即落在具体一个人身上（缺则指向首页） */
  personKey?: string
}

/** 名言卡：紫底 + 巨型引号 + 一句名言 */
export function paintQuoteCard(ctx: Ctx2D, w: number, h: number, d: QuoteCardInput, code?: CanvasImage): void {
  paintBrandBg(ctx, w, h)

  /* 巨型引号用字符画，不引图片素材：省一张网络图与一次下载等待，也不会裂图 */
  ctx.fillStyle = 'rgba(255,255,255,0.20)'
  ctx.font = 'bold 130px serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText('“', PAD - 6, 30)

  /* 人物行：首字头像 + 名字 + 领域胶囊 */
  paintAvatar(ctx, PAD, 56, 46, d.name, d.domain)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 22px sans-serif'
  ctx.fillText(d.name, PAD + 58, 62)
  const nameW = ctx.measureText(d.name).width

  const label = domainLabel(d.domain)
  ctx.font = '12px sans-serif'
  const chipW = ctx.measureText(label).width + 20
  const chipX = Math.min(PAD + 58 + nameW + 10, w - PAD - chipW)
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  roundRect(ctx, chipX, 66, chipW, 24, 12)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillText(label, chipX + 10, 72)

  /* 正文：最多 6 行（21px × 36 行高 = 216），超出截断 —— 下方还要留出处与页脚 */
  const bodyEnd = drawText(ctx, d.text, {
    x: PAD,
    y: 152,
    size: 21,
    weight: 'bold',
    color: '#FFFFFF',
    lineHeight: 36,
    maxWidth: w - PAD * 2,
    maxLines: 6
  })

  drawText(ctx, d.context?.trim() || '公开场合', {
    x: PAD,
    y: Math.min(bodyEnd + 20, h - FOOT_H - 40),
    size: 13,
    color: 'rgba(255,255,255,0.78)',
    maxWidth: w - PAD * 2,
    maxLines: 1
  })

  paintFooter(ctx, w, h, code)
}

/* ===== 周报简报卡（P4-B） ===== */

/**
 * 周报简报卡的版式常量（逻辑 px）。
 *
 * 与名言卡同一取舍：**固定栅格、不做自适应高度** —— 但简报的要点条数是可变的（3~5 条），
 * 故高度按条数由 `weeklyBriefHeight` 算出（一次性给出画布尺寸，不做「先量高再重画」的两次绘制）。
 * 每块高度取的是**最坏情况**（要点正文最多 2 行 + 来源·时间 1 行），于是无论文本多长都不会越界。
 */
const WEEKLY_HEAD_H = 104
const WEEKLY_POINT_H = 70
const WEEKLY_NOTE_H = 60

/** 周报简报卡高度：随要点条数变化（无要点时按 1 条算，避免高度塌成一条线） */
export function weeklyBriefHeight(pointCount: number): number {
  const n = Math.max(1, Math.min(Math.floor(pointCount) || 0, BRIEF_POINT_MAX))
  return WEEKLY_HEAD_H + n * WEEKLY_POINT_H + WEEKLY_NOTE_H + FOOT_H
}

/**
 * 画一张周报简报卡：紫底 + 标题与窗口 + 逐条要点（带来源与时间）+ 底部说明 + 页脚。
 *
 * 合规（与 utils/weekly-brief.ts 的三条红线一致）：每条要点都带「来源 · 时间」；
 * 底部固定写出「公开报道 · 非平台定性 · 聚合≠认定」；页脚带产品名与「AI 生成，仅供参考」。
 * 这里**只负责画**，内容取舍（截断 / 过滤 / 去重）全部已在 buildWeeklyBrief 里完成。
 */
export function paintWeeklyBrief(ctx: Ctx2D, w: number, h: number, d: WeeklyBrief, code?: CanvasImage): void {
  paintBrandBg(ctx, w, h)

  /* 标题与统计窗口 */
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 26px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(d.title, PAD, 34)

  drawText(ctx, d.range, {
    x: PAD,
    y: 72,
    size: 14,
    color: 'rgba(255,255,255,0.82)',
    maxWidth: w - PAD * 2,
    maxLines: 1
  })

  /* 逐条要点：序号圆点 + 正文（最多 2 行）+「来源 · 时间」 */
  let y = WEEKLY_HEAD_H
  d.points.forEach((p, i) => {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.beginPath()
    ctx.arc(PAD + 10, y + 9, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), PAD + 10, y + 10)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const textEnd = drawText(ctx, p.text, {
      x: PAD + 30,
      y,
      size: 16,
      weight: 'bold',
      color: '#FFFFFF',
      lineHeight: 23,
      maxWidth: w - PAD * 2 - 30,
      maxLines: 2
    })

    drawText(ctx, `${p.source || '来源未标注'} · ${p.date || '近期'}`, {
      x: PAD + 30,
      y: textEnd + 3,
      size: 12,
      color: 'rgba(255,255,255,0.72)',
      maxWidth: w - PAD * 2 - 30,
      maxLines: 1
    })

    y += WEEKLY_POINT_H
  })

  /* 底部说明：合规硬要求，固定在页脚之上 */
  drawText(ctx, d.note, {
    x: PAD,
    y: h - FOOT_H - WEEKLY_NOTE_H + 6,
    size: 11,
    color: 'rgba(255,255,255,0.62)',
    lineHeight: 16,
    maxWidth: w - PAD * 2,
    maxLines: 3
  })

  paintFooter(ctx, w, h, code)
}

/* ===== 报告长图（获客 P0，2026-10-15） ===== */

/**
 * 报告长图的版式常量（逻辑 px）。
 *
 * 与前两张卡一样**固定栅格、不量高**：每块高度取最坏情况（判断 2 行、争议 3 行、动态 2 行），
 * 高度由内容条数算出（见 reportCardHeight），一次性给出画布尺寸。
 *
 * 与前两张卡不同的是**底色**：名言卡与周报卡是紫底白字（短，一屏读完）；报告图正文有
 * 六到十几段文字，紫底白字读三段眼睛就累了，故改成白底深字，只保留顶部与底部的品牌色块 ——
 * 一眼认得出是同一款产品，正文又是能读的。
 */
const RC_HEAD_H = 132
const RC_HEADLINE_H = 84
const RC_SECTION_TITLE_H = 30
const RC_POINT_H = 56
const RC_DISPUTE_H = 76
const RC_DYNAMIC_H = 46
const RC_NOTE_H = 58

const RC_INK = '#1F1B2E'
const RC_INK2 = '#4A4458'

/** 报告长图高度：随判断 / 争议 / 动态条数变化（空块不占位） */
export function reportCardHeight(card: ReportCardModel): number {
  let h = RC_HEAD_H
  if (card.headline) h += RC_HEADLINE_H
  if (card.points.length > 0) h += RC_SECTION_TITLE_H + card.points.length * RC_POINT_H
  if (card.disputes.length > 0) h += RC_SECTION_TITLE_H + card.disputes.length * RC_DISPUTE_H
  if (card.dynamics.length > 0) h += RC_SECTION_TITLE_H + card.dynamics.length * RC_DYNAMIC_H
  return h + RC_NOTE_H + FOOT_H
}

/** 小节标题：品牌色细字 + 下方一条浅色分隔线 */
function paintSectionTitle(ctx: Ctx2D, w: number, y: number, text: string): void {
  ctx.fillStyle = COLOR.brand
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(text, PAD, y + 8)
  ctx.strokeStyle = 'rgba(95,51,225,0.16)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, y + RC_SECTION_TITLE_H - 4)
  ctx.lineTo(w - PAD, y + RC_SECTION_TITLE_H - 4)
  ctx.stroke()
}

/**
 * 画一张报告长图：顶部品牌头（姓名 / 领域 / 计数 / 生成日）+ 一句话结论 + 判断与依据 +
 * 公开争议与回应 + 近期动态（带来源）+ 合规说明 + 商品页脚（含小程序码）。
 *
 * 这里**只负责画**：内容取舍（截断 / 过滤 / 敏感名单拦截 / 条数上限）全部已在
 * utils/report-card.ts#buildReportCard 里完成，故图上每一句都能回原报告核对。
 */
export function paintReportCard(ctx: Ctx2D, w: number, h: number, d: ReportCardModel, code?: CanvasImage): void {
  /* 白底 + 顶部品牌块 + 底部品牌页脚 */
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, w, h)

  const head = ctx.createLinearGradient(0, 0, w, RC_HEAD_H)
  head.addColorStop(0, COLOR.brand)
  head.addColorStop(1, COLOR.brandSoft)
  ctx.fillStyle = head
  ctx.fillRect(0, 0, w, RC_HEAD_H)

  /* 人物行：首字头像 + 名字 + 领域胶囊（与名言卡同一套占位约定） */
  paintAvatar(ctx, PAD, 28, 46, d.name, d.domain)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 22px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(d.name, PAD + 58, 34)
  const nameW = ctx.measureText(d.name).width

  const label = domainLabel(d.domain)
  ctx.font = '12px sans-serif'
  const chipW = ctx.measureText(label).width + 20
  const chipX = Math.min(PAD + 58 + nameW + 10, w - PAD - chipW)
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  roundRect(ctx, chipX, 38, chipW, 24, 12)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillText(label, chipX + 10, 44)

  /* 计数行 + 生成日：都是可核对的事实，放在最上面当「这份报告有什么」 */
  ctx.fillStyle = 'rgba(255,255,255,0.86)'
  ctx.font = '13px sans-serif'
  ctx.fillText(d.stats, PAD, 88)
  if (d.meta) {
    ctx.fillStyle = 'rgba(255,255,255,0.68)'
    ctx.font = '12px sans-serif'
    ctx.fillText(d.meta, PAD, 108)
  }

  let y = RC_HEAD_H

  /* 一句话结论 */
  if (d.headline) {
    drawText(ctx, d.headline, {
      x: PAD,
      y: y + 20,
      size: 16,
      weight: 'bold',
      color: RC_INK,
      lineHeight: 24,
      maxWidth: w - PAD * 2,
      maxLines: 3
    })
    y += RC_HEADLINE_H
  }

  /* 判断与依据：模型观点，每条都带自己的出处 */
  if (d.points.length > 0) {
    paintSectionTitle(ctx, w, y, '关注要点')
    let py = y + RC_SECTION_TITLE_H
    d.points.forEach((p) => {
      drawText(ctx, `· ${p}`, {
        x: PAD,
        y: py + 4,
        size: 14,
        color: RC_INK2,
        lineHeight: 21,
        maxWidth: w - PAD * 2,
        maxLines: 2
      })
      py += RC_POINT_H
    })
    y += RC_SECTION_TITLE_H + d.points.length * RC_POINT_H
  }

  /* 公开争议与回应：说法与回应并置，绝不只摆说法 */
  if (d.disputes.length > 0) {
    paintSectionTitle(ctx, w, y, '公开争议与回应')
    let dy = y + RC_SECTION_TITLE_H
    d.disputes.forEach((s) => {
      drawText(ctx, `· ${s}`, {
        x: PAD,
        y: dy + 4,
        size: 14,
        color: RC_INK2,
        lineHeight: 21,
        maxWidth: w - PAD * 2,
        maxLines: 3
      })
      dy += RC_DISPUTE_H
    })
    y += RC_SECTION_TITLE_H + d.disputes.length * RC_DISPUTE_H
  }

  /* 近期动态：每条带日期与来源（无来源的已在组装阶段丢掉） */
  if (d.dynamics.length > 0) {
    paintSectionTitle(ctx, w, y, '近期动态')
    let ny = y + RC_SECTION_TITLE_H
    d.dynamics.forEach((s) => {
      drawText(ctx, `· ${s}`, {
        x: PAD,
        y: ny + 4,
        size: 13,
        color: RC_INK2,
        lineHeight: 19,
        maxWidth: w - PAD * 2,
        maxLines: 2
      })
      ny += RC_DYNAMIC_H
    })
    y += RC_SECTION_TITLE_H + d.dynamics.length * RC_DYNAMIC_H
  }

  /* 合规说明：固定在页脚之上，与页脚的免责角标分工不同（这句讲「非定性」） */
  drawText(ctx, d.note, {
    x: PAD,
    y: h - FOOT_H - RC_NOTE_H + 10,
    size: 11,
    color: '#8A8496',
    lineHeight: 16,
    maxWidth: w - PAD * 2,
    maxLines: 3
  })

  /* 页脚坐在品牌色块上：白底长图的底部收口，也保证免责与码的对比度 */
  const footTop = h - FOOT_H
  const foot = ctx.createLinearGradient(0, footTop, w, h)
  foot.addColorStop(0, COLOR.brand)
  foot.addColorStop(1, COLOR.brandSoft)
  ctx.fillStyle = foot
  ctx.fillRect(0, footTop, w, FOOT_H)
  paintFooter(ctx, w, h, code)
}

/* ===== 画布与导出 ===== */

/** 画布 id：组件与绘制函数共用，改一处即可 */
export const POSTER_CANVAS_ID = 'share-poster-canvas'

/** 页面里离屏 canvas 的节点查询表达式 */
const CANVAS_SELECTOR = `#${POSTER_CANVAS_ID}`

/**
 * 取离屏 canvas 节点。
 *
 * canvas 节点必须**真实存在于节点树里**：`display: none` 会让查询拿不到 node，
 * 所以组件把它放在屏幕外（left: -9999px）而不是隐藏。
 */
function queryCanvasNode(): Promise<CanvasNode> {
  return new Promise((resolve, reject) => {
    Taro.createSelectorQuery()
      .select(CANVAS_SELECTOR)
      .fields({ node: true, size: true })
      .exec((res: Array<{ node?: CanvasNode } | null>) => {
        const node = res?.[0]?.node
        if (!node || typeof node.getContext !== 'function') {
          reject(
            new Error(
              '画布未就绪：需基础库 ≥ 2.9.0（Canvas 2D），且页面内存在 id 为 ' +
                `${POSTER_CANVAS_ID} 的 canvas 节点`
            )
          )
          return
        }
        resolve(node)
      })
  })
}

/** 导出画布为本地临时图片路径（2d 画布传 canvas 实例，不传 canvasId） */
function exportTempFile(canvas: CanvasNode): Promise<string> {
  const option = { canvas, fileType: 'png' } as unknown as Taro.canvasToTempFilePath.Option
  return Taro.canvasToTempFilePath(option).then((res) => res.tempFilePath)
}

/**
 * 在离屏画布上绘制并导出 PNG，返回本地临时路径。
 *
 * 像素密度按 dpr 放大后再把坐标系缩回逻辑 px：绘制代码里写的 375 / 28 都是设计稿尺寸，
 * 与屏幕无关；真机上拿到的是 2 倍图，不会发虚。长图（报告图）另按 MAX_PHYSICAL_H 压倍率。
 *
 * `codeTarget` 给了就在页脚画小程序码：**取码失败只是没有码**，不改变出图结果的成功与否。
 */
export async function renderPoster(
  height: number,
  paint: (ctx: Ctx2D, width: number, height: number, code?: CanvasImage) => void,
  codeTarget?: ShareCodeTarget
): Promise<string> {
  const canvas = await queryCanvasNode()
  let scale = MAX_SCALE
  try {
    scale = Math.min(Taro.getSystemInfoSync().pixelRatio || MAX_SCALE, MAX_SCALE)
  } catch {
    /* 取不到就按 2 倍，失败也是清晰度问题，不该阻断出图 */
  }
  /* 长图降倍率：canvas 后备缓冲区有上限，宁可略微不锐也不能导出失败（见 MAX_PHYSICAL_H） */
  scale = Math.max(1, Math.min(scale, MAX_PHYSICAL_H / Math.max(1, height)))

  /* 码在改画布尺寸**之前**加载：改 width/height 会重置上下文状态，图先备好更稳 */
  const code = codeTarget ? await loadCodeImage(canvas, codeTarget) : undefined

  /* 尺寸写在 canvas.width/height 上（后备缓冲区），元素的 CSS 尺寸由组件按同一份常量给定 */
  canvas.width = Math.round(POSTER_WIDTH * scale)
  canvas.height = Math.round(height * scale)

  const ctx = canvas.getContext('2d')
  /* 改过 width/height 之后上下文状态会被重置，缩放必须重新设置 */
  ctx.scale(scale, scale)
  paint(ctx, POSTER_WIDTH, height, code)

  return exportTempFile(canvas)
}

/** 生成名言卡，返回本地临时图片路径（有 personKey 时页脚的码指向这个人的报告） */
export function renderQuotePoster(data: QuoteCardInput): Promise<string> {
  return renderPoster(
    QUOTE_POSTER_HEIGHT,
    (ctx, w, h, code) => paintQuoteCard(ctx, w, h, data, code),
    reportCodeTarget(data.personKey ?? '')
  )
}

/**
 * 生成周报简报卡，返回本地临时图片路径。
 *
 * 与名言卡**共用同一条绘制管线**（`renderPoster` 的离屏 canvas 查询、dpr 像素比缩放、
 * canvasToTempFilePath 导出），故不同机型的清晰度处理完全一致；高度随要点条数算出。
 */
export function renderWeeklyBriefPoster(brief: WeeklyBrief): Promise<string> {
  return renderPoster(
    weeklyBriefHeight(brief.points.length),
    (ctx, w, h, code) => paintWeeklyBrief(ctx, w, h, brief, code),
    /* 简报是「一群人的本周」，没有具体某个人可落：码落在周报页本身 */
    pageCodeTarget('package/weekly/index')
  )
}

/**
 * 生成**报告长图**，返回本地临时图片路径。
 *
 * 内容模型由调用方先经 `utils/report-card.ts#buildReportCard` 组装（那里做敏感名单拦截与
 * 截断，返回 null 就说明这张卡不该出图）；这里只负责画与落码。
 */
export function renderReportPoster(card: ReportCardModel): Promise<string> {
  return renderPoster(
    reportCardHeight(card),
    (ctx, w, h, code) => paintReportCard(ctx, w, h, card, code),
    reportCodeTarget(card.personKey)
  )
}

/**
 * 保存到相册。
 *
 * 拒绝授权（`auth deny`）要引导去设置页，而不是丢一句「保存失败」—— 用户看不出是权限问题，
 * 只会反复点同一个按钮。其余失败（存储满、系统限制）才按普通错误提示。
 */
export async function saveImageToAlbum(filePath: string): Promise<boolean> {
  try {
    await Taro.saveImageToPhotosAlbum({ filePath })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'storage', `分享卡片保存相册失败：${msg}`)
    if (/auth|authorize|deny|scope/i.test(msg)) {
      const res = await Taro.showModal({
        title: '需要相册权限',
        content: '保存图片需要「保存到相册」权限，去设置里打开后重试',
        confirmText: '去设置'
      })
      if (res.confirm) {
        try {
          await Taro.openSetting()
        } catch {
          /* 打不开设置页也不是致命问题，提示已给出 */
        }
      }
      return false
    }
    Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    return false
  }
}
