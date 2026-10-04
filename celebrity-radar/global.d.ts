/// <reference types="@tarojs/taro" />
/// <reference types="react" />

declare namespace NodeJS {
  interface ProcessEnv {
    /** 编译平台: weapp | h5 */
    TARO_ENV: 'weapp' | 'h5' | string
  }
}
