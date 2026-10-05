/**
 * 非敏感公共配置（§3.8）：可进包。
 * 用户级 key（搜索源 / LLM）一律只存本地 storage（src/utils/settings.ts），严禁写入本文件。
 *
 * 【填写指引】云后端已由 WorkBuddy 云服务迁移至腾讯云 CloudBase（微信云开发）：
 *
 * 1. cloudbaseEnvId
 *    - 微信开发者工具 → 工具栏「云开发」→ 环境 ID，形如 `celebrity-radar-1a2b3c4d`
 *    - 该环境须与 project.config.json 里的 appid 归属同一个小程序
 *    - 未配置时 isCloudConfigured 为 false，登录与全部 DB 调用不会发起
 *
 * 2. llm.baseURL / llm.model
 *    - CloudBase 不再托管大模型，需填一个 **OpenAI 兼容**端点（形如 https://api.deepseek.com/v1）
 *    - 密钥**严禁**写在这里。两条通道都已打通（见 utils/llm.ts）：
 *      ① 平台代付：云函数 aiProxy 的 'chat'，key 存在函数环境变量 DEEPSEEK_API_KEY —— 用户零配置；
 *      ② 本机直连：key 存本地 storage，开发与内测用。Console 执行一次即可：
 *        wx.setStorageSync('settings:llm_api_key', 'sk-xxxxxxxx')
 *      有本机 key 就走 ②，否则走 ①。
 *
 * 配套：云端需先建好 users 集合，权限设为「仅创建者可读写」
 *（这是客户端能取到自己 _openid 的唯一途径）。字段由首次登录自动写入，无需手工建。
 */
export const publicConfig = {
  /** CloudBase 环境 ID（微信云开发 → 环境 ID） */
  cloudbaseEnvId: '<your-env-id>',

  /** LLM 通道（OpenAI 兼容）。key 默认走用户本地设置，见 utils/settings.ts */
  llm: {
    /** 形如 https://api.deepseek.com/v1（不含 /chat/completions） */
    baseURL: 'https://api.deepseek.com/v1',
    /** 模型名，如 deepseek-chat */
    model: 'deepseek-v4-flash',
    /**
     * 恒为空。本文件会被打进小程序包（.wxapkg 可解包），填进这里的 key 等同于公开。
     * 这里只留 baseURL / model 作为端上「协议 + 模型名」的单一来源；
     * key 要么在云函数环境变量（平台代付），要么在本地 storage（本机直连）。
     */
    apiKey: ''
  },

  /**
   * 订阅消息模板 ID（关注更新提醒）。
   *
   * 获取方式：微信公众平台 → 功能 → 订阅消息 → 公共模板库选用一个模板。
   * 推荐模板字段：`thing1`（提醒内容）+ `date2`（更新时间），
   * 与 cloudfunctions/notifyFollowUpdates 里发送的 data 键名一致，换模板需同步改。
   *
   * 模板 ID 不是密钥（每个用户都能在小程序里看到），可以进包；
   * 但云函数发送时读的是同名环境变量 SUBSCRIBE_TEMPLATE_ID，两边必须指向同一个模板。
   * 保持空串 = 未配置：此时「我的」页的入口只给指引，不发一个必然失败的授权请求。
   */
  subscribeTemplateId: ''
} as const
