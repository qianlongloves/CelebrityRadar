/**
 * 自定义 tabBar 的**入口壳**（保留本目录是硬性要求，不是历史包袱）。
 *
 * Taro 3 把自定义 tabBar 的源目录写死在 `<sourceRoot>/custom-tab-bar`：
 * `@tarojs/webpack5-runner/dist/plugins/MiniPlugin.js` 只在
 * `appConfig.tabBar.custom === true` 时取 `path.join(sourceDir, 'custom-tab-bar')`，
 * 并把产物名固定成 `custom-tab-bar/index`（无配置项可改）。
 * 微信侧同样只认小程序根目录下的 `custom-tab-bar/index` 这个目录名。
 *
 * 因此真正的实现搬去 `src/components/custom-tab-bar/`，本文件只做转出。
 * 同目录的 `index.config.ts`（`{ component: true }`）也必须留在这里 ——
 * Taro 从入口同目录读 config，缺了就生成空 json，开发者工具会报
 * 「custom-tab-bar/index 不是自定义组件」。
 */
export { default } from '../components/custom-tab-bar'
