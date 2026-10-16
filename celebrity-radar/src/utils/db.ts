import { getDatabase } from './cloud'
import { diagLog } from './cloud-diagnostics'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 统一表访问入口（CloudBase / 微信云开发适配层）。
 *
 * 调用点沿用原 PostgREST 口径（table('x').select().eq().maybeSingle() 等），
 * 由本文件翻译成 wx.cloud.database() 的语义，业务代码零改动。适配要点：
 *
 * 1. 主键：PostgREST 的 id ↔ CloudBase 的 _id（出入参双向映射）
 * 2. 分页：小程序端单次 get 硬上限 20 条，limit/range 超出时必须内部分页续取
 * 3. upsert：CloudBase 无 upsert，落到 doc(id).set()（存在即覆盖）
 * 4. or：只支持 '.or()' 里的 PostgREST 过滤串，翻译为 command.or([...])
 * 5. 写操作自动执行：原 SDK 未 await 不会执行，这里补微任务兜底，
 *    避免 `void table('events').insert(...)` 这类 fire-and-forget 埋点静默失效
 */

export interface DbError {
  message: string
  code?: string
  /**
   * 云开发的数值错误码（-502005 集合不存在 / -502003 无权限 / -502001 其他请求失败）。
   *
   * 与上面的 `code` 并存是历史原因：`code` 是 PostgREST 时代的字段（当时存 "23505" 这类
   * 约束冲突串），迁到 CloudBase 后一直没人写也没人读，留着只为不破坏既有类型引用。
   * 需要按错误类型分支时一律看 `errCode`。
   */
  errCode?: number
}

export interface DbResult<T = unknown> {
  data: T | null
  error: DbError | null
}

/**
 * 把云开发 reject 的东西归一化成 DbError。
 *
 * ⚠ 这里踩过一个坑，别再踩第二次：`wx.cloud` 失败时 reject 的是**普通对象**
 * `{ errCode, errMsg }`，不是 `Error` 实例。原先写的是
 * `err instanceof Error ? err.message : String(err)` —— 前者为假、后者把对象拍成
 * `"[object Object]"`，于是「集合不存在」「无写入权限」这些**唯一能指明修法**的信息
 * 全被丢掉，诊断日志里只剩一句无用的 `keyword_watches insert 失败：[object Object]`，
 * 上层只能对用户说「监控失败，请重试」—— 而这类错误重试一万次都一样。
 */
export function normalizeDbError(err: unknown): DbError {
  if (err && typeof err === 'object') {
    const e = err as { errCode?: unknown; errMsg?: unknown; message?: unknown }
    const errCode = typeof e.errCode === 'number' ? e.errCode : undefined
    const errMsg = typeof e.errMsg === 'string' ? e.errMsg : ''
    const message = errMsg || (typeof e.message === 'string' ? e.message : '')
    if (message) return { message, errCode, code: errCode != null ? String(errCode) : undefined }
  }
  if (err instanceof Error) return { message: err.message }
  return { message: String(err) }
}

/** -502005 集合不存在；-502003 无权限；-502001 请求失败（丢包，或撞主键/并发冲突） */
const ERR_COLLECTION_NOT_EXIST = -502005
const ERR_PERMISSION_DENIED = -502003

export interface DbFailure {
  /** true = **环境没配好**（集合没建 / 权限不对）：重试无用，要人去云开发控制台改 */
  fatal: boolean
  /** 给用户看的话，含「该做什么」 */
  message: string
}

/**
 * 把写库失败翻译成「该谁去处理」。
 *
 * 起因：报告页点「+ 监控风险」只得到一句「监控失败，请重试」，而真实原因是
 * `keyword_watches` 集合没建（或权限不是「仅创建者可读写」）—— 这类错误在文案上
 * 与「网络抖了一下」长得一模一样，用户只会反复点同一个按钮。
 *
 * 返回 `null` = 不是已知的环境问题（断网 / 超时 / 并发），调用方保留自己那句通用提示，
 * 因为对这类失败「重试」确实是正确的建议。
 *
 * @param table  出错的那张表：写进文案，用户才知道去哪建表 / 改权限
 * @param error  db.ts 归一化后的错误（`normalizeDbError`）
 * @param action 正在做的事（「监控」「订阅」），文案里拼成「…无法进行」
 */
export function explainDbFailure(table: string, error: DbError | null, action: string): DbFailure | null {
  const text = error?.message ?? ''
  const code = error?.errCode
  if (code === ERR_COLLECTION_NOT_EXIST || /collection not exist|集合不存在/i.test(text)) {
    return {
      fatal: true,
      message: `云数据库里还没有「${table}」集合，${action}无法进行。请部署者在云开发控制台跑一次 dbInit（action: init）建表后重试。`
    }
  }
  if (code === ERR_PERMISSION_DENIED || /permission denied|no permission|无权限/i.test(text)) {
    return {
      fatal: true,
      message: `「${table}」集合不允许端上写入，${action}无法进行。请部署者在云开发控制台把它的权限设为「仅创建者可读写」。`
    }
  }
  return null
}

/** 小程序端单次 get 上限（超出一律分页续取） */
const PAGE_SIZE = 20
/** 未显式 limit 时的取数上限 */
const DEFAULT_MAX = 100

type Cond = { col: string; op: string; val: unknown }

/** PostgREST 口径的 id ↔ CloudBase 的 _id */
const toDbField = (col: string): string => (col === 'id' ? '_id' : col)

/** 出参统一把 _id 映回 id，调用点保持 PostgREST 口径 */
function toRow(doc: any): any {
  if (!doc || typeof doc !== 'object') return doc
  const { _id, ...rest } = doc
  return { id: _id, ...rest }
}

function toCmd(cmd: any, op: string, val: unknown): any {
  switch (op) {
    case 'eq': return cmd.eq(val)
    case 'neq': return cmd.neq(val)
    case 'gt': return cmd.gt(val)
    case 'gte': return cmd.gte(val)
    case 'lt': return cmd.lt(val)
    case 'lte': return cmd.lte(val)
    case 'in': return cmd.in(val as unknown[])
    default: throw new Error(`不支持的查询操作符：${op}`)
  }
}

/** 解析 PostgREST 的 or 串：'state.eq.ready,generated_at.lt.2026-10-05T..Z' */
function parseOrExpr(expr: string): Cond[] {
  return expr.split(',').map((part) => {
    const i = part.indexOf('.')
    const j = part.indexOf('.', i + 1)
    if (i < 0 || j < 0) throw new Error(`非法 or 表达式：${part}`)
    return { col: part.slice(0, i), op: part.slice(i + 1, j), val: part.slice(j + 1) }
  })
}

class Builder implements PromiseLike<DbResult<any>> {
  private conds: Cond[] = []
  private orGroups: Cond[][] = []
  /** 排序键（可多列，先入先排）。末位的稳定次级键由 fetchAll 统一补，见那边的注释 */
  private orderCols: Array<{ col: string; asc: boolean }> = []
  private limitN: number | null = null
  private skipN = 0
  private rangeStart: number | null = null
  private rangeEnd: number | null = null
  private kind: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private payload: Record<string, unknown> | null = null
  private conflictKey = 'id'
  private wantsReturn = false
  private one = false
  private pending: Promise<DbResult<any>> | null = null
  /** 列投影（PostgREST 口径的 `select('a,b')`）；null = 全字段 */
  private fields: string[] | null = null

  constructor(private readonly name: string) {}

  select(cols?: string): this {
    this.wantsReturn = true
    /* 这个参数曾经**名不符实**：旧实现只设 wantsReturn、把 cols 整个丢掉，于是
       `select('id')` 与 `select('*')` 完全等价 —— 调用点以为在省流量，实际每次都在拉整行。
       现在真正落成云开发的 field()。投影里不必手动补 `_id`（云开发始终返回它），
       出参再由 toRow 把 `_id` 映回 `id`，所以 `select('id')` 照样拿得到主键。 */
    const list = typeof cols === 'string' ? cols.split(',').map((s) => s.trim()).filter(Boolean) : []
    this.fields = list.length === 0 || list.includes('*') ? null : list
    return this
  }
  eq(col: string, val: unknown): this { this.conds.push({ col, op: 'eq', val }); return this }
  in(col: string, val: unknown[]): this { this.conds.push({ col, op: 'in', val }); return this }
  or(expr: string): this { this.orGroups.push(parseOrExpr(expr)); return this }

  /**
   * 追加一个排序键（多次调用 = 多列，先入先排）。
   *
   * 这里从「覆盖」改成了「追加」：改前连调两次 `order()` 只有最后一次生效（静默丢掉前一个键），
   * 而调用方看起来像是在写多列排序 —— 那种写法一旦出现就是查错数据的 bug。
   * 现有 12 处调用点全是单次调用，所以这个改动对它们等价。
   */
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCols.push({ col, asc: opts?.ascending !== false })
    return this
  }

  limit(n: number): this { this.limitN = n; return this }
  range(from: number, to: number): this { this.rangeStart = from; this.rangeEnd = to; return this }

  insert(p: Record<string, unknown>): this {
    this.kind = 'insert'; this.payload = p; this.autoRun(); return this
  }
  update(p: Record<string, unknown>): this {
    this.kind = 'update'; this.payload = p; return this
  }
  upsert(p: Record<string, unknown>, opts?: { onConflict?: string }): this {
    this.kind = 'upsert'; this.payload = p; this.conflictKey = opts?.onConflict ?? 'id'
    this.autoRun(); return this
  }
  delete(): this { this.kind = 'delete'; return this }

  maybeSingle(): Promise<DbResult<any>> { this.one = true; return this.run() }

  then<T1 = DbResult<any>, T2 = never>(
    onfulfilled?: ((v: DbResult<any>) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return this.ensureRun().then(onfulfilled, onrejected)
  }

  /** 幂等执行（then 与 autoRun 可能同时触发） */
  private ensureRun(): Promise<DbResult<any>> {
    if (!this.pending) this.pending = this.run()
    return this.pending
  }

  /** fire-and-forget 兜底：同步链结束后若无人 await，也把写操作发出去 */
  private autoRun(): void {
    Promise.resolve().then(() => { void this.ensureRun() })
  }

  private buildWhere(cmd: any): any {
    const parts: any[] = []
    for (const c of this.conds) parts.push({ [toDbField(c.col)]: toCmd(cmd, c.op, c.val) })
    for (const g of this.orGroups) {
      parts.push(cmd.or(g.map((c) => ({ [toDbField(c.col)]: toCmd(cmd, c.op, c.val) }))))
    }
    if (parts.length === 0) return null
    return parts.length === 1 ? parts[0] : cmd.and(parts)
  }

  /** 主键字段 id 不落库（由 _id / doc(id) 承载），其余原样 */
  private mapPayload(p: Record<string, unknown>, asId: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p)) {
      if (k === 'id') { if (asId) out._id = v; continue }
      out[k] = v
    }
    return out
  }

  /** 内部分页：绕过小程序端 20 条上限 */
  private async fetchAll(coll: any, where: any): Promise<any[]> {
    const start = this.rangeStart ?? this.skipN
    const want = this.limitN ?? (this.rangeEnd != null ? this.rangeEnd - start + 1 : DEFAULT_MAX)
    const out: any[] = []
    let offset = start
    while (out.length < want) {
      const take = Math.min(PAGE_SIZE, want - out.length)
      let q = where ? coll.where(where) : coll
      if (this.orderCols.length > 0 || want > PAGE_SIZE) {
        /* 排序键 = 调用方声明的那些 + 末尾一个**稳定次级键** `_id`（升序）。
           为什么必须有它：下面是 `skip/limit` 深分页，而 skip 分页只对**排序确定**的结果集安全 ——
           主排序值相同的文档，它们在库里的先后是**没有承诺**的（事件表的 `last_at` 正是这种字段：
           一轮聚类的产物常常带同一分钟的时间戳）。顺序不定时，两次请求之间会重复或漏掉文档，
           表现就是「列表偶尔出现重复条目」或「某一条怎么刷新都不出来」，且极难复现。
           补上唯一的 `_id` 之后顺序整体确定，skip 分页才真的等于「按确定的顺序切片」。

           ⚠ **调用方没写 `.order()` 时同样要补**（2026-10-16 修）：只要 `want > PAGE_SIZE` 就得翻页，
           翻页就同样怕顺序不定。原先这个分支只看 `orderCols.length > 0`，于是「无排序 + 取 40 条」
           这类兜底扫描（热门榜 / 会员示例在索引未建时的回落路径）会真的以无 ORDER BY 的方式翻页 ——
           库返回顺序随数据变化而变，第二页切到不确定的位置，候选集里就会重复或漏掉文档。
           这类调用方本身不关心顺序（拿到行后会自己排），但**漏行**照样会把内容少给一半。
           只为需要翻页的查询补：`want <= PAGE_SIZE` 是单次 get，不翻页就不需要这个保证，
           也免得给「只取一条」这种最高频的查询平白加上一次排序。 */
        const plan = this.orderCols.slice()
        if (!plan.some((o) => o.col === 'id')) plan.push({ col: 'id', asc: true })
        for (const o of plan) {
          q = q.orderBy(toDbField(o.col), o.asc ? 'asc' : 'desc')
        }
      }
      if (this.fields) {
        /* 投影要**跟着每一页**下发：云开发的 field() 是查询级链式调用，
           只写在第一页上会让后续页白白拉回整行（省流量就白省了） */
        const projection: Record<string, true> = {}
        for (const f of this.fields) projection[toDbField(f)] = true
        q = q.field(projection)
      }
      const res = await q.skip(offset).limit(take).get()
      const batch: any[] = res?.data ?? []
      out.push(...batch)
      if (batch.length < take) break
      offset += batch.length
    }
    return out
  }

  private async run(): Promise<DbResult<any>> {
    try {
      const db = getDatabase()
      const coll = db.collection(this.name)
      const cmd = db.command

      if (this.kind === 'select') {
        const rows = await this.fetchAll(coll, this.buildWhere(cmd))
        const data = rows.map(toRow)
        return { data: this.one ? (data[0] ?? null) : data, error: null }
      }

      if (this.kind === 'insert') {
        const data = this.mapPayload(this.payload!, true)
        await coll.add({ data })
        return { data: this.wantsReturn ? [this.payload] : null, error: null }
      }

      if (this.kind === 'update') {
        const where = this.buildWhere(cmd)
        if (!where) throw new Error('update 必须带过滤条件，拒绝全表更新')
        /* ⚠ 小程序端单次 where().update() 最多命中 20 条，超出部分**静默不动**，
           而云开发不返回「是否被截断」的标记 —— 只有 stats.updated 一个数。
           这里没有做 _id 分块循环，因为当前唯一的批量 update 调用点是
           `keyword-alert#markAllSeen`，它更新的是关键词行，条数 = 会员档
           `OPINION_LIMITS.watchCount.member = 10` < 20，够不着这个上限。
           **若将来把该上限提到 20 以上（或新增别的批量 update 调用点），
           必须改成「先分页取 _id、再按 20 个一批 update」**，否则超出的行会
           悄悄保持旧值（表现：部分条目反复提醒「已看过」却还在）。 */
        const res = await coll.where(where).update({ data: this.mapPayload(this.payload!, false) })
        const updated = res?.stats?.updated ?? 0
        const UPDATE_PAGE_LIMIT = 20
        if (updated >= UPDATE_PAGE_LIMIT) {
          diagLog('warn', 'db', `${this.name} update 命中 ${updated} 条（达小程序端单次上限），如有更多条件命中则未被更新`)
        }
        return { data: this.wantsReturn ? (updated > 0 ? [this.payload] : []) : null, error: null }
      }

      if (this.kind === 'upsert') {
        const idVal = this.payload![this.conflictKey]
        if (idVal == null) throw new Error(`upsert 缺少冲突键 ${this.conflictKey}`)
        await coll.doc(String(idVal)).set({ data: this.mapPayload(this.payload!, false) })
        return { data: null, error: null }
      }

      const where = this.buildWhere(cmd)
      if (!where) throw new Error('delete 必须带过滤条件，拒绝全表删除')
      /* 每次 remove 最多删 20 条（小程序端上限），故要循环；循环 50 次 = 1000 条封顶。
         撞到封顶必须喊一声：原先它是**静默截断**的 —— 调用点以为删干净了，
         库里还剩一批，而「剩下的那批」在下次读取时又冒出来，现场极难对上。 */
      const DELETE_MAX_ROUNDS = 50
      let rounds = 0
      for (; rounds < DELETE_MAX_ROUNDS; rounds++) {
        const res = await coll.where(where).remove()
        if ((res?.stats?.removed ?? 0) === 0) break
      }
      if (rounds >= DELETE_MAX_ROUNDS) {
        diagLog('warn', 'db', `${this.name} delete 达到 ${DELETE_MAX_ROUNDS} 轮上限（约 ${DELETE_MAX_ROUNDS * PAGE_SIZE} 条），可能仍有未删除的文档`)
      }
      return { data: null, error: null }
    } catch (err) {
      /* 走 normalizeDbError 而不是 `err.message`：云开发 reject 的是 { errCode, errMsg }，
         直接取 message 会得到 "[object Object]"（详见该函数注释） */
      const error = normalizeDbError(err)
      diagLog('warn', 'db', `${this.name} ${this.kind} 失败：${error.message}`)
      return { data: null, error }
    }
  }
}

export function table(name: string): any {
  return new Builder(name)
}
