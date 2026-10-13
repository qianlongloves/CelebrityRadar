'use strict'

/**
 * 测试运行环境：把编译产物（test/.build）跑在 Node 里。
 *
 * 小程序代码依赖两样东西才跑得起来：
 *   1. `@tarojs/taro` —— 在 Node 里替成基于 Map 的 storage 实现（其余 API 记为可断言的调用）
 *   2. 全局 `wx` —— 提供 wx.cloud（内存 DB + 可注册的云函数）、wx.request 等
 * 加上 `@/xxx` 路径别名解析，utils 层就可以原样执行 —— 测的是产品代码。
 */

const path = require('path')
const Module = require('module')
const { createDb } = require('./cloud-db')

const BUILD = path.join(__dirname, '..', '.build')

/* ------------------------------------------------------------------ storage */

const storage = new Map()

const storageApi = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, v === undefined ? '' : v) },
  removeStorageSync: (k) => { storage.delete(k) },
  clearStorageSync: () => { storage.clear() },
  getStorageInfoSync: () => ({
    keys: [...storage.keys()],
    currentSize: 0,
    limitSize: 10240
  })
}

/* --------------------------------------------------------------------- taro */

const taroCalls = []

/**
 * 用例可临时改写某个 Taro API 的返回值（如把 getSystemInfoSync 指成 iOS 环境）。
 *
 * 默认替身对任何非 storage 的 API 都返回同一个「记录调用并返回 undefined」的函数 ——
 * 这对绝大多数用例够用，但「跟着运行环境分叉」的逻辑（如 P2-20 的 iOS 虚拟支付门禁）
 * 就必须能让它返回指定值，否则真机分支永远测不到。覆盖是**临时**的：resetData 会清空，
 * 用例之间不会互相污染。
 */
const taroOverrides = new Map()

const taroMock = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return taroMock
    if (prop === Symbol.toStringTag) return 'TaroMock'
    if (typeof prop === 'string' && taroOverrides.has(prop)) return taroOverrides.get(prop)
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(storageApi, prop)) {
      return storageApi[prop]
    }
    return (...args) => {
      taroCalls.push({ prop: String(prop), args })
      return undefined
    }
  }
})

/* ----------------------------------------------------------------------- wx */

const db = createDb()
/** 已注册的云函数：name -> handler(data, ctx) */
const cloudFns = new Map()

/** 未注册的云函数按「未部署」抛错 —— 与真机行为一致，用于验证降级路径 */
function notDeployed(name) {
  const err = new Error(
    `cloud.callFunction:fail Error: errCode: -501000 | errMsg: cloud.callFunction:fail ` +
    `FunctionName parameter could not be found (${name})`
  )
  err.errCode = -501000
  return err
}

const wxMock = Object.assign({}, storageApi, {
  cloud: {
    init: (o) => { wxMock.__cloudInit = o },
    database: () => db.database(),
    callFunction: async ({ name, data }) => {
      const handler = cloudFns.get(name)
      if (!handler) throw notDeployed(name)
      const opts = (data && data.options) || {}
      const ctx = { name, options: opts }
      return { result: await handler(data || {}, ctx), errMsg: 'cloud.callFunction:ok' }
    },
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://mock-env/${cloudPath}` }),
    deleteFile: async ({ fileList }) => ({
      fileList: (fileList || []).map((f) => ({ fileID: f, status: 0 }))
    })
  },
  getSystemInfoSync: () => ({
    platform: 'devtools',
    SDKVersion: '3.5.0',
    windowWidth: 375,
    windowHeight: 667,
    pixelRatio: 2,
    statusBarHeight: 20,
    safeArea: { top: 20, bottom: 647, height: 627, width: 375 }
  }),
  getWindowInfo: () => ({
    windowWidth: 375,
    windowHeight: 667,
    statusBarHeight: 20
  }),
  request: async () => { throw new Error('mock: wx.request 未注册（端上已无直连上游通道）') }
})

global.wx = wxMock

/* ------------------------------------------------------------ module loader */

const originalLoad = Module._load

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@tarojs/taro' || request === '@tarojs/components' || request === '@tarojs/plugin-framework-react') {
    return taroMock
  }
  if (request.startsWith('@/')) {
    return originalLoad.call(this, path.join(BUILD, request.slice(2)), parent, isMain)
  }
  return originalLoad.call(this, request, parent, isMain)
}

/* ------------------------------------------------------------------ helpers */

/** 清掉编译产物的模块缓存，让每个用例从干净状态开始（含 auth store / 登录在途标记） */
function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(BUILD)) delete require.cache[key]
  }
}

/** 只清空数据与 storage，不清模块缓存（用于「同一份模块状态下的连续操作」） */
function resetData() {
  db.__reset()
  storage.clear()
  taroCalls.length = 0
  /* Taro 返回值覆盖是「本用例的环境设定」，同样不该泄漏到下一用例 */
  taroOverrides.clear()
  /* 已注册的云函数是测试脚手架，不属于被测状态：不清会让上一用例注入的替身泄漏到下一用例 */
  cloudFns.clear()
  /* 开关的「显式指定」状态同样不该泄漏到下一用例（见 load 里的强制回 false） */
  restrictedFlagPinned = false
}

/** 覆盖某个 Taro API 的返回值（**必须在 load 业务模块之后、调用它之前设置**，见 taroOverrides） */
function setTaroOverride(name, value) {
  taroOverrides.set(name, value)
}

function resetAll() {
  resetData()
  resetModules()
}

/** 「限制类检索」开关是否被某个用例**显式指定**过（显式指定后 load() 不再强制回 false） */
let restrictedFlagPinned = false

/** 加载编译后的 src 模块，如 load('utils/time') */
function load(rel) {
  const pub = require(path.join(BUILD, 'config/public'))
  /*
   * 「限制类检索」的放开开关在**加载任何模块之前**强制关回 false（2026-10-12 补）。
   *
   * 它和别的 debug 开关不是一类：disable* 只决定闸门拦不拦，而它会**改掉本地拦截与两处提示词**，
   * 而用例断言的正是那几层逻辑（sensitive 命中、消歧与报告提示词里的拒答规则）。
   * 之所以必须放在 load 里而不是只放 setDebugFlags：不少用例（如 01-pure）直接在 load 里
   * 读模块、根本不覆盖开关，于是本机 local.ts 为摸边界打开它就会让整套用例忽红忽绿。
   * 要测「放开后的行为」的用例，先 setDebugFlags({ allowRestrictedSearch: true }) 即可固定。
   */
  if (!restrictedFlagPinned) {
    pub.publicConfig.debug.allowRestrictedSearch = false
  }
  /*
   * 云环境 ID 的测试默认值（2026-10-13 补）。
   *
   * 环境 ID 自 2026-10-13 起改由构建期从仓库根 `.env` 注入（真源见 config/index.js），
   * 而单测是 tsc 直编、不经 Taro ⇒ 注入常量不存在、`publicConfig.cloudbaseEnvId` 退化为空串。
   * 空串 = isCloudConfigured false，会让「关注流刷新 / 检索写口 / 大模型通道」等用例在
   * 闸门处提前返回 —— 而它们此前依赖编译进产物的 local.ts 里那个非空环境 ID 才走得通。
   * 故这里等价地补一个非空的**假**值（与各用例里的 configureCloud() 同一手法）：
   * 显式 configureCloud() 过的用例值非空、不会被覆盖；要测「未配置」的用例可在 load 之后再清空。
   */
  if (!pub.publicConfig.cloudbaseEnvId) {
    pub.publicConfig.cloudbaseEnvId = 'test-env-id'
  }
  return require(path.join(BUILD, rel))
}

/**
 * 覆盖调试开关（**必须在 load 业务模块之前调用**，通常在 resetAll 之后）。
 *
 * 为什么需要：开关的取值只该影响「本地手工联调」，不该改变单测的判定依据 ——
 * 打开 disable* 是为了自己点着方便，而用例断言的是闸门本身的逻辑。不隔离的话，
 * 同一份代码会因为本机开关的取值忽红忽绿（改开关的人只图方便，不该顺带改掉测试语义）。
 *
 * 生效原理：utils/debug.ts 在**首次被 require 时**把 config/public.ts 的 debug 节读成常量，
 * 所以只要在它被加载之前改掉那份配置对象即可生效；resetModules() 会清掉缓存，
 * 下一个用例重新 require 到的又是文件里的原始值，因此不会互相污染。
 */
function setDebugFlags(patch) {
  const config = require(path.join(BUILD, 'config/public'))
  /*
   * 「限制类检索」的放开开关**一律先强制关回 false**（2026-10-12 补）。
   *
   * 它与其它 debug 开关不是一类：disable* 只影响闸门是否拦，而这个会**改掉本地拦截与两处提示词**
   * —— 而用例断言的恰恰是那几层拦截的逻辑（sensitive 命中、消歧/报告提示词里的拒答规则）。
   * 若跟随本机 local.ts，谁为了摸边界把它打开，整套用例就会莫名其妙变红（正是本函数要防的事，
   * 见上方注释）。要测「放开后的行为」时，在 patch 里显式传 `allowRestrictedSearch: true` 覆盖即可。
   */
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'allowRestrictedSearch')) {
    restrictedFlagPinned = true
  }
  Object.assign(config.publicConfig.debug, { allowRestrictedSearch: false }, patch)
  return config.publicConfig.debug
}

function registerCloudFn(name, handler) {
  cloudFns.set(name, handler)
}

function unregisterCloudFn(name) {
  cloudFns.delete(name)
}

function findTaroCall(prop) {
  return taroCalls.find((c) => c.prop === prop) || null
}

function taroCallsOf(prop) {
  return taroCalls.filter((c) => c.prop === prop)
}

module.exports = {
  BUILD,
  db,
  storage,
  storageApi,
  taroCalls,
  taroMock,
  wxMock,
  load,
  setDebugFlags,
  registerCloudFn,
  unregisterCloudFn,
  resetModules,
  resetData,
  resetAll,
  setTaroOverride,
  findTaroCall,
  taroCallsOf,
  notDeployed,
  /** 测试辅助：读/写 storage 原始值 */
  rawStorage: storage
}
