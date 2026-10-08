/**
 * 自定义 tabBar 的组件声明。
 *
 * app.config.ts 中 tabBar.custom 为 true 时，微信要求自定义 tabBar 目录下
 * 的 index.json 必须含 "component": true，否则开发者工具编译期会报
 * 「custom-tab-bar/index 不是自定义组件」。
 *
 * Taro 只在入口同目录存在 index.config.ts 时才会把这些字段写入产物 json，
 * 缺省时生成的是空对象 {}。
 */
export default {
  component: true
}
