const path = require('path')

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
