const fs = require('fs')
const path = require('path')

/**
 * 读取仓库根的 `.env`（部署云函数用的那一份），取出三个订阅消息模板 ID。
 *
 * 为什么要在这里读：三个模板 ID 原先要**两处各填一次** —— 端上 `src/config/local.ts` 一次、
 * 云函数环境变量（由 cloudbaserc.json 的 `{{env.X}}` 从 `.env` 取值）一次，两边必须指向同一模板，
 * 否则推送必然失败且极难排查。现改为**单一份来源 = `.env`**：
 *   · 云端部署时 cloudbaserc.json 用 `{{env.X}}` 从 `.env` 读出注入云函数；
 *   · 端上由这里在**构建期**读同一份 `.env`，经下方 `defineConstants` 注入编译常量。
 * 于是「同源」是构造上的保证，而不是靠人记得两处填一样。
 *
 * 缺 `.env` / 缺键 / 键为空 ⇒ 一律空串：「未配置」行为与改造前完全一致
 * （端上授权按钮不渲染、云函数记录并跳过推送，站内功能不受影响）。
 * 陌生人 clone 后什么都不配也能编译通过。
 *
 * 注意：模板 ID 不是密钥（每个用户都能在小程序里看到），可以进包；这里放行。
 * 其它任何 Key / 口令**不要**走这条通道（它们只该留在 `.env` → 云函数环境变量里，绝不进端上包）。
 */
function readDotEnv() {
  const out = {}
  try {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      /* 去掉可选的外层引号（.env 常见写法 KEY="value" / KEY='value'） */
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
  } catch {
    /* 没有 .env：全部按未配置（空串）处理 */
  }
  return out
}

const envFile = readDotEnv()
/** 三个订阅模板 ID 的编译期取值：与云端从 .env 读到的**同名同源** */
const subscribeTemplateId = envFile.SUBSCRIBE_TEMPLATE_ID || ''
const alertTemplateId = envFile.ALERT_TEMPLATE_ID || ''
const riskTemplateId = envFile.RISK_TEMPLATE_ID || ''

const config = {
  projectName: 'celebrity-radar',
  date: '2026-10-4',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    375: 2,
    828: 1.81 / 2
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  framework: 'react',
  compiler: 'webpack5',
  /*
   * 编译期常量：把 .env 里的三个订阅模板 ID 注入端上（Taro 会在打包时做全局标识符替换）。
   * 端上代码见 src/config/public.ts 的三个 subscribeTemplateId / alertTemplateId / riskTemplateId
   * —— 用 `typeof X === 'undefined' ? '' : X` 守卫，使「没有注入」（如单测经 tsc 直编）也安全退化为空串。
   * 这三个值都不是密钥（每个用户都能在小程序里看到），可以进包。
   */
  defineConstants: {
    __SUBSCRIBE_TEMPLATE_ID__: JSON.stringify(subscribeTemplateId),
    __ALERT_TEMPLATE_ID__: JSON.stringify(alertTemplateId),
    __RISK_TEMPLATE_ID__: JSON.stringify(riskTemplateId)
  },
  // 注意：不要在 scss 的值里写非 ASCII 字符（如 content: '→'）。
  // dart-sass 会因此给产物头部插入 @charset "UTF-8";，而微信 WXSS 不支持该规则，
  // 开发者工具会报 WXSS 编译错误；Taro 3.6 + webpack5 不转发 sassLoaderOption，
  // charset: false 无法生效，这类符号请放到 JSX 文本节点里渲染。
  alias: {
    '@': path.resolve(__dirname, '..', 'src')
  },
  mini: {
    compile: {
      // 这些依赖默认不经过 babel（Taro 默认不编译 node_modules），
      // 但它们含 ES2019 可选 catch 绑定 `catch {}`，真机老 JS 引擎会报
      // SyntaxError: Unexpected token {，故纳入编译降级
      include: [
        (modulePath) => /node_modules[\\/]zod[\\/]/.test(modulePath)
      ]
    },
    postcss: {
      pxtransform: {
        enable: true,
        config: {}
      },
      cssModules: {
        enable: false
      }
    },
    miniCssExtractPluginOption: {
      ignoreOrder: true
    }
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      autoprefixer: {
        enable: true,
        config: {}
      },
      cssModules: {
        enable: false
      }
    }
  }
}

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'))
  }
  return merge({}, config, require('./prod'))
}
