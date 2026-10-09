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
  private orderCol: string | null = null
  private orderAsc = true
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

  constructor(private readonly name: string) {}

  select(_cols?: string): this { this.wantsReturn = true; return this }
  eq(col: string, val: unknown): this { this.conds.push({ col, op: 'eq', val }); return this }
  in(col: string, val: unknown[]): this { this.conds.push({ col, op: 'in', val }); return this }
  or(expr: string): this { this.orGroups.push(parseOrExpr(expr)); return this }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col
    this.orderAsc = opts?.ascending !== false
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
      if (this.orderCol) {
        q = q.orderBy(toDbField(this.orderCol), this.orderAsc ? 'asc' : 'desc')
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
        const res = await coll.where(where).update({ data: this.mapPayload(this.payload!, false) })
        const updated = res?.stats?.updated ?? 0
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
      for (let i = 0; i < 50; i++) {
        const res = await coll.where(where).remove()
        if ((res?.stats?.removed ?? 0) === 0) break
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
