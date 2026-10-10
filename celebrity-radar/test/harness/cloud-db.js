'use strict'

/**
 * 内存版微信云开发数据库（仅测试用）。
 *
 * 目的：让 src/utils/db.ts 这个适配层跑在**真实代码路径**上 —— 断言的是产品代码，
 * 不是断言 mock。因此这里刻意复刻了几条平台行为，否则测不出 db.ts 的存在意义：
 *   1. 单次 get 硬上限 20 条 ⇒ db.ts 的 fetchAll 内部分页若失效，测试会立刻失败；
 *   2. add 自动注入 _openid（客户端身份由云端隐式携带）；
 *   3. add 主键冲突抛错；doc.set 是全量覆盖（CloudBase 无 upsert）；
 *   4. where().update() / where().remove() 必须带条件，空条件直接抛（与 db.ts 的守卫呼应）。
 */

const CMD = Symbol('cloudbase-command')

function makeCmd(op, val) {
  return { [CMD]: true, op, val }
}

const command = {
  eq: (v) => makeCmd('eq', v),
  neq: (v) => makeCmd('neq', v),
  gt: (v) => makeCmd('gt', v),
  gte: (v) => makeCmd('gte', v),
  lt: (v) => makeCmd('lt', v),
  lte: (v) => makeCmd('lte', v),
  in: (v) => makeCmd('in', v),
  nin: (v) => makeCmd('nin', v),
  exists: (v) => makeCmd('exists', v),
  and: (v) => makeCmd('and', v),
  or: (v) => makeCmd('or', v),
  inc: (v) => makeCmd('inc', v),
  set: (v) => makeCmd('set', v),
  remove: () => makeCmd('remove', undefined)
}

function isCmd(v) {
  return !!v && typeof v === 'object' && v[CMD] === true
}

function matchVal(val, c) {
  if (!isCmd(c)) return val === c
  switch (c.op) {
    case 'eq': return val === c.val
    case 'neq': return val !== c.val
    case 'gt': return val > c.val
    case 'gte': return val >= c.val
    case 'lt': return val < c.val
    case 'lte': return val <= c.val
    case 'in': return Array.isArray(c.val) && c.val.indexOf(val) >= 0
    case 'nin': return Array.isArray(c.val) && c.val.indexOf(val) < 0
    case 'exists': return c.val ? val !== undefined : val === undefined
    case 'and': return c.val.every((x) => matchVal(val, x))
    case 'or': return c.val.some((x) => matchVal(val, x))
    default: throw new Error(`mock 不支持的比较指令：${c.op}`)
  }
}

/** 条件对象或 and/or 组合（db.ts 的多条件会合成 cmd.and([...])） */
function matchDoc(doc, where) {
  if (where === null || where === undefined) return true
  if (isCmd(where)) {
    if (where.op === 'and') return where.val.every((w) => matchDoc(doc, w))
    if (where.op === 'or') return where.val.some((w) => matchDoc(doc, w))
    throw new Error(`mock 不支持的顶层指令：${where.op}`)
  }
  return Object.entries(where).every(([field, c]) => matchVal(doc[field], c))
}

/**
 * 按点路径读（`settings.llm_tier`）。
 *
 * 存在的理由：CloudBase 的 update 对形如 `a.b` 的键走**嵌套赋值**，而不是建一个
 * 名叫 "a.b" 的扁平字段 —— 产品代码（云函数 userInit 的 set）正是靠这条避免
 * 「读-改-写」整对象覆盖时丢掉并发改动，mock 必须同口径，否则那行代码测试里跑的是另一回事。
 */
function readPath(doc, path) {
  return path.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), doc)
}

function setPath(doc, path, v) {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = v
}

function deletePath(doc, path) {
  const parts = path.split('.')
  const parent = parts.length === 1 ? doc : readPath(doc, parts.slice(0, -1).join('.'))
  if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]]
}

function applyUpdate(doc, data) {
  for (const [k, v] of Object.entries(data)) {
    if (isCmd(v) && v.op === 'inc') {
      const cur = readPath(doc, k)
      setPath(doc, k, (typeof cur === 'number' ? cur : 0) + v.val)
    } else if (isCmd(v) && v.op === 'remove') {
      deletePath(doc, k)
    } else {
      setPath(doc, k, v)
    }
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v))

/** 平台单次 get 上限 */
const PLATFORM_PAGE_MAX = 20

function createDb(opts = {}) {
  const identity = { openid: opts.openid || 'mock-openid-0001' }
  const tables = new Map()
  const stats = { getCalls: 0, addCalls: 0, updateCalls: 0, removeCalls: 0, docSetCalls: 0 }
  /** 故障注入：集合名 -> true 时该集合所有读写抛错（模拟权限未开 / 表没建） */
  const failing = new Set()
  /**
   * 故障注入（P1-10）：集合名 -> true 时**只让读抛错**，写照常成功。
   *
   * 用来复刻「读库瞬时失败」这一种情形 —— 它必须与「行不存在」区分开：旧写法用
   * `doc().get()` + `catch → null` 把两者都吞成「没有行」，于是发货路径会拿镜像重算有效期、
   * 并把 `refunded_orders` 名单当作空来覆盖，等于把幂等凭据清掉。`__setFailing` 读写一起断，
   * 测不出这个差别（读失败时后面的写也失败，两种写法都返回非 0）。
   */
  const readFailing = new Set()
  /**
   * V-1（2026-10-09）：doc(id).update() 打到**不存在的行**，真实 wx-server-sdk 是返回
   * stats.updated===0 还是直接抛错，尚无真机结论。本 mock 默认复刻前者（返回 0），
   * 打开这个开关则复刻后者（抛错）—— 好让「抛错」这一支的代码路径也能被跑到。
   * 云端应把两种行为都当成「自增没落实」，故两条路径上的闸门结论必须一致。
   */
  let missingDocUpdateThrows = false
  let seq = 0

  const guard = (name) => {
    if (failing.has(name)) {
      throw Object.assign(new Error(`mock: 集合 ${name} 不可用（权限未开或集合不存在）`), {
        errCode: -502001
      })
    }
  }

  /** 只拦读（见 readFailing 说明）：写仍走 guard，故该集合可读失败而写成功 */
  const guardRead = (name) => {
    guard(name)
    if (readFailing.has(name)) {
      throw Object.assign(new Error(`mock: 集合 ${name} 读取失败（故障注入，写不受影响）`), {
        errCode: -502001
      })
    }
  }

  const coll = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }

  class Query {
    constructor(name, where = null) {
      this.name = name
      this._where = where
      this._orders = []
      this._skip = 0
      this._limit = PLATFORM_PAGE_MAX
    }

    _next(patch) {
      const q = new Query(this.name, this._where)
      q._orders = this._orders.slice()
      q._skip = this._skip
      q._limit = this._limit
      Object.assign(q, patch)
      return q
    }

    where(cond) { return this._next({ _where: cond }) }
    orderBy(field, dir) { return this._next({ _orders: this._orders.concat([[field, dir === 'desc' ? -1 : 1]]) }) }
    skip(n) { return this._next({ _skip: n }) }
    limit(n) { return this._next({ _limit: n }) }
    field() { return this }

    async get() {
      guardRead(this.name)
      stats.getCalls++
      let rows = [...coll(this.name).values()].filter((d) => matchDoc(d, this._where))
      for (const [f, dir] of this._orders.slice().reverse()) {
        rows = rows.slice().sort((a, b) => {
          const x = a[f]
          const y = b[f]
          if (x === y) return 0
          return (x > y ? 1 : -1) * dir
        })
      }
      const take = Math.min(this._limit, PLATFORM_PAGE_MAX)
      rows = rows.slice(this._skip, this._skip + take)
      return { data: rows.map(clone), errMsg: 'collection.get:ok' }
    }

    async count() {
      guardRead(this.name)
      const n = [...coll(this.name).values()].filter((d) => matchDoc(d, this._where)).length
      return { total: n, errMsg: 'collection.count:ok' }
    }

    async add({ data }) {
      guard(this.name)
      if (!data || typeof data !== 'object') throw new Error('mock: add 需要 data 对象')
      stats.addCalls++
      const m = coll(this.name)
      const explicit = data._id !== undefined && data._id !== null
      const _id = explicit ? String(data._id) : `auto_${++seq}`
      if (m.has(_id)) {
        throw Object.assign(new Error(`mock: document already exists (${_id})`), { errCode: -502001 })
      }
      const doc = Object.assign({}, data, { _id })
      if (doc._openid === undefined) doc._openid = identity.openid
      m.set(_id, doc)
      return { _id, errMsg: 'collection.add:ok' }
    }

    async update({ data }) {
      guard(this.name)
      if (!this._where) throw new Error('mock: 拒绝无条件 update')
      stats.updateCalls++
      let updated = 0
      for (const d of coll(this.name).values()) {
        if (matchDoc(d, this._where)) { applyUpdate(d, data); updated++ }
      }
      return { stats: { updated }, errMsg: 'collection.update:ok' }
    }

    async remove() {
      guard(this.name)
      if (!this._where) throw new Error('mock: 拒绝无条件 remove')
      stats.removeCalls++
      const m = coll(this.name)
      let removed = 0
      for (const [id, d] of [...m.entries()]) {
        if (matchDoc(d, this._where)) { m.delete(id); removed++ }
      }
      return { stats: { removed }, errMsg: 'collection.remove:ok' }
    }

    doc(id) { return new Doc(this.name, id) }
  }

  class Doc {
    constructor(name, id) {
      this.name = name
      this.id = String(id)
    }

    async get() {
      guardRead(this.name)
      const d = coll(this.name).get(this.id)
      if (!d) {
        throw Object.assign(new Error(`mock: document.get:fail not exists (${this.id})`), { errCode: -1 })
      }
      return { data: clone(d), errMsg: 'document.get:ok' }
    }

    async set({ data }) {
      guard(this.name)
      stats.docSetCalls++
      const m = coll(this.name)
      const existed = m.has(this.id)
      const doc = Object.assign({}, data, { _id: this.id })
      if (doc._openid === undefined) doc._openid = identity.openid
      m.set(this.id, doc)
      return { stats: { created: existed ? 0 : 1, updated: existed ? 1 : 0 }, _id: this.id, errMsg: 'document.set:ok' }
    }

    async update({ data }) {
      guard(this.name)
      stats.docUpdateCalls++
      const d = coll(this.name).get(this.id)
      if (!d) {
        /* 见文件顶部 V-1 说明：真实的「行不存在」行为未定，两种都复刻得出来 */
        if (missingDocUpdateThrows) {
          throw Object.assign(new Error(`mock: document.update:fail not exists (${this.id})`), { errCode: -1 })
        }
        return { stats: { updated: 0 }, errMsg: 'document.update:ok' }
      }
      applyUpdate(d, data)
      return { stats: { updated: 1 }, errMsg: 'document.update:ok' }
    }

    async remove() {
      guard(this.name)
      const ok = coll(this.name).delete(this.id)
      return { stats: { removed: ok ? 1 : 0 }, errMsg: 'document.remove:ok' }
    }
  }

  return {
    identity,
    stats,
    /** 测试辅助：直接读整表（绕过云 SDK） */
    __dump(name) { return [...coll(name).values()].map(clone) },
    __seed(name, docs) { for (const d of docs) coll(name).set(String(d._id), clone(d)) },
    /** 故障注入：该集合的读写全部抛错 */
    __setFailing(name, on) { if (on) failing.add(name); else failing.delete(name) },
    /** 故障注入（P1-10）：只让该集合的**读**抛错，写照常成功 —— 区分「读失败」与「行不存在」 */
    __setReadFailing(name, on) { if (on) readFailing.add(name); else readFailing.delete(name) },
    /** V-1：让 doc(id).update() 打到不存在的行时抛错（复刻另一种真机可能行为） */
    __setMissingDocUpdateThrows(on) { missingDocUpdateThrows = !!on },
    __reset() { tables.clear(); seq = 0; failing.clear(); readFailing.clear(); missingDocUpdateThrows = false },
    database() {
      return {
        collection: (name) => new Query(name, null),
        command,
        serverDate: () => new Date()
      }
    }
  }
}

module.exports = { createDb, command, PLATFORM_PAGE_MAX }
