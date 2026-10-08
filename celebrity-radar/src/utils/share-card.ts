import Taro from '@tarojs/taro'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'

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
 * 3. **不下载任何网络图片**。头像全项目本就用「领域色渐变 + 姓名首字」占位，
 *    卡片把这个约定继承下来，于是整张图零网络依赖：不占 request 合法域名、不等待下载、不会裂图。
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

/** 卡片内边距与页脚高度：所有绘制函数共用同一套栅格 */
const PAD = 28
const FOOT_H = 66

/** 合规硬要求：任何一张分享出去的图上都必须带这行字（截图转发也带得走） */
const DISCLAIMER = 'AI 生成，仅供参考'
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
  business: '#FF7D53',
  ent: '#EC4899',
  sports: '#10B981',
  academia: '#5F33E1',
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
}

interface CanvasNode {
  width: number
  height: number
  getContext(type: '2d'): Ctx2D
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

/** 头像：领域色底 + 姓名首字（与 person-card / 报告页同一套占位约定） */
function paintAvatar(ctx: Ctx2D, x: number, y: number, size: number, name: string, domain: DomainCode): void {
  ctx.fillStyle = DOMAIN_COLOR[domain] ?? COLOR.ink2
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

/** 页脚：一条分隔线 + 应用名 + 免责角标。免责是合规硬要求，不在图上就等于没有 */
function paintFooter(ctx: Ctx2D, w: number, h: number): void {
  const top = h - FOOT_H
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, top)
  ctx.lineTo(w - PAD, top)
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = 'bold 15px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(APP_NAME, PAD, top + 18)

  ctx.fillStyle = 'rgba(255,255,255,0.72)'
  ctx.font = '12px sans-serif'
  ctx.fillText(DISCLAIMER, PAD, top + 40)
}

/* ===== 名言卡 ===== */

export interface QuoteCardInput {
  name: string
  domain: DomainCode
  text: string
  /** 出处场合（如「2024 年度演讲」），空则回落「公开场合」，与报告页口径一致 */
  context?: string
}

/** 名言卡：紫底 + 巨型引号 + 一句名言 */
export function paintQuoteCard(ctx: Ctx2D, w: number, h: number, d: QuoteCardInput): void {
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

  const label = DOMAIN_META[d.domain]?.label ?? '其他'
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

  paintFooter(ctx, w, h)
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
 * 与屏幕无关；真机上拿到的是 2 倍图，不会发虚。
 */
export async function renderPoster(
  height: number,
  paint: (ctx: Ctx2D, width: number, height: number) => void
): Promise<string> {
  const canvas = await queryCanvasNode()
  let scale = MAX_SCALE
  try {
    scale = Math.min(Taro.getSystemInfoSync().pixelRatio || MAX_SCALE, MAX_SCALE)
  } catch {
    /* 取不到就按 2 倍，失败也是清晰度问题，不该阻断出图 */
  }

  /* 尺寸写在 canvas.width/height 上（后备缓冲区），元素的 CSS 尺寸由组件按同一份常量给定 */
  canvas.width = Math.round(POSTER_WIDTH * scale)
  canvas.height = Math.round(height * scale)

  const ctx = canvas.getContext('2d')
  /* 改过 width/height 之后上下文状态会被重置，缩放必须重新设置 */
  ctx.scale(scale, scale)
  paint(ctx, POSTER_WIDTH, height)

  return exportTempFile(canvas)
}

/** 生成名言卡，返回本地临时图片路径 */
export function renderQuotePoster(data: QuoteCardInput): Promise<string> {
  return renderPoster(QUOTE_POSTER_HEIGHT, (ctx, w, h) => paintQuoteCard(ctx, w, h, data))
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
