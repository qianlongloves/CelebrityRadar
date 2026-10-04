/// <reference types="@tarojs/taro" />
/// <reference types="react" />

/** weapp 运行时全局 wx（云 SDK / 诊断层使用；仅 Taro 抹平层未覆盖的场景） */
declare const wx: any

declare namespace NodeJS {
  interface ProcessEnv {
    /** 编译平台: weapp | h5 */
    TARO_ENV: 'weapp' | 'h5' | string
  }
}
