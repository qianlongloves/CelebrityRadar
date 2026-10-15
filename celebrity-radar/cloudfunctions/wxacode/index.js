const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 小程序码生成（获客用，2026-10-15）。
 *
 * 场景：分享图（报告长图 / 名言卡 / 周报简报卡）底部要印一个**能扫的码**，
 * 否则图一旦保存到相册或发进朋友圈，就脱离了微信转发链路，看图的人没有任何入口。
 *
 * 为什么必须走云函数：小程序码只能由服务端接口（wxacode.getUnlimited / wxacode.get）
 * 用 access_token 生成，而 access_token 要 appsecret —— 放进小程序包等于公开。
 * 云开发提供了**云调用**：函数内 `cloud.openapi.*` 免密钥、免自己管理 token，
 * 密钥链路一步都不进端上（与 aiProxy「厂商 key 只留云端」同一条纪律）。
 *
 * 依赖：`config.json` 声明的 openapi 权限（wxacode.getUnlimited / wxacode.get）。
 * 云调用失败常见两类，原文只进云函数日志：
 *   · 未声明权限 / 未开通 → errCode -601xxx（permission denied）；
 *   · page 指向未发布的页面 → 40097 之类（开发期用 WXACODE_ENV_VERSION=trial 绕开）。
 *
 * 环境变量（可选）：WXACODE_ENV_VERSION = release（默认）/ trial / develop。
 */

/**
 * 允许生成码的页面白名单。
 *
 * 不设白名单的话这就是一个「任意页面码生成器」：别人拿到 appid 就能借我们的云函数
 * 给任意页面发码（配额算在我们头上）。三个页面 = 三处分享图的落地页。
 */
const ALLOWED_PAGES = ['package/report/index', 'package/weekly/index', 'pages/index/index']

/** scene 的微信侧硬限制 */
const SCENE_MAX = 32

/** 码的边长（px）：430 是官方推荐的「印刷/分享图」档位，缩到 64 逻辑 px 仍然扫得动 */
const CODE_WIDTH = 430

function fail(error) {
  return { ok: false, kind: 'badrequest', error }
}

/** 简易散列（djb2）：scene 里可能有 % / 括号等文件系统不友好的字符，落路径前先收敛成短码 */
function shortHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function envVersion() {
  const v = process.env.WXACODE_ENV_VERSION
  return v === 'trial' || v === 'develop' ? v : 'release'
}

exports.main = async (event) => {
  const page = String((event && event.page) || '').replace(/^\//, '')
  if (ALLOWED_PAGES.indexOf(page) < 0) {
    return fail(`不支持的目标页：${page || '(空)'}`)
  }

  const scene = String((event && event.scene) || '')
  if (scene.length > SCENE_MAX) {
    /* 端上（utils/share-code.ts#reportCodeTarget）已先截断过，走到这里说明调用方不对 */
    return fail(`scene 超长：${scene.length} > ${SCENE_MAX}`)
  }

  try {
    /*
     * scene 为空时必须走 wxacode.get：getUnlimited 的 scene 是必填项，传空串会被上游拒掉。
     * 两者都返回 buffer（云调用会把二进制放进 buffer 字段）。
     */
    const res = scene
      ? await cloud.openapi.wxacode.getUnlimited({
          scene,
          page,
          checkPath: false,
          envVersion: envVersion(),
          width: CODE_WIDTH
        })
      : await cloud.openapi.wxacode.get({
          path: page,
          envVersion: envVersion(),
          width: CODE_WIDTH
        })

    const buffer = res && res.buffer
    if (!buffer || !buffer.length) {
      console.error('wxacode 未返回图片数据：', JSON.stringify(res && { errCode: res.errCode, errMsg: res.errMsg }))
      return { ok: false, kind: 'upstream', error: '小程序码暂时不可用，请稍后重试。' }
    }

    /*
     * 同一目标固定落到同一个 cloudPath：重复生成即覆盖写，fileID 不变 ——
     * 端上因此可以把 fileID 长期缓存（见 utils/share-code.ts 的三级缓存），
     * 不必为同一张码反复调用本函数（getUnlimited 有每日调用上限）。
     */
    const cloudPath = `wxacode/${page.replace(/\//g, '_')}${scene ? `_${shortHash(scene)}` : ''}.png`
    const up = await cloud.uploadFile({ cloudPath, fileContent: buffer })
    if (!up || !up.fileID) {
      return { ok: false, kind: 'upstream', error: '小程序码暂时不可用，请稍后重试。' }
    }

    return { ok: true, fileID: up.fileID }
  } catch (err) {
    /* 原文（含 errCode / permission denied / 上游描述）只进云函数日志，回端上的是一句人话 */
    console.error('wxacode 生成失败：', (err && err.errCode) || '', (err && err.errMsg) || err)
    return { ok: false, kind: 'upstream', error: '小程序码暂时不可用，请稍后重试。' }
  }
}
