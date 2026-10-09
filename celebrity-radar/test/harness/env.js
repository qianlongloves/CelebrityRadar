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
}

/** 覆盖某个 Taro API 的返回值（**必须在 load 业务模块之后、调用它之前设置**，见 taroOverrides） */
function setTaroOverride(name, value) {
  taroOverrides.set(name, value)
}

function resetAll() {
  resetData()
  resetModules()
}

/** 加载编译后的 src 模块，如 load('utils/time') */
function load(rel) {
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
  Object.assign(config.publicConfig.debug, patch)
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
