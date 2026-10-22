/**
 * benefits.config.js —— **自动生成，请勿手改**。
 *
 * 真源：src/config/benefits.ts
 * 生成：npm run config:sync（或 node scripts/sync-config.js）
 * 校验：npm run config:check（tests/cases 里的 sync 用例会跑它）
 *
 * 为什么是副本而不是引用：云函数各自独立打包上传（cloudbaserc.json 逐个声明），
 * 且云环境里 require 不到端上的 TS —— 只能把真源序列化成本地文件一起上传。
 * 手改本文件会在下次 config:sync 时被覆盖，且 config:check 会报红。
 */

module.exports = {
  "MEMBER_BENEFITS": {
    "generatePerDay": {
      "free": 3,
      "member": 30
    },
    "askPerDay": {
      "free": 5,
      "member": 30
    },
    "refreshPerDay": {
      "free": 10,
      "member": 20
    },
    "freeRefreshCooldownHours": 12
  },
  "ABUSE_LIMITS": {
    "free": 40,
    "member": 200
  },
  "SEARCH_MAX": {
    "free": 20,
    "member": 40
  },
  "MAX_CHAT_CHARS": 24000,
  "PLANS": [
    {
      "id": "monthly",
      "name": "月度会员",
      "days": 30,
      "priceFen": 990,
      "priceLabel": "¥9.9",
      "badge": "",
      "body": "名人雷达·月度会员"
    },
    {
      "id": "quarterly",
      "name": "季度会员",
      "days": 90,
      "priceFen": 2500,
      "priceLabel": "¥25",
      "badge": "省 16%",
      "body": "名人雷达·季度会员"
    },
    {
      "id": "annual",
      "name": "年度会员",
      "days": 365,
      "priceFen": 6800,
      "priceLabel": "¥68",
      "badge": "最划算",
      "body": "名人雷达·年度会员"
    }
  ],
  "PLAN_LIMITS": {
    "priceFenMin": 100,
    "priceFenMax": 100000,
    "daysMin": 1,
    "daysMax": 3650,
    "badgeMax": 8
  },
  "REPORT_SOURCE": {
    "fullItemCount": 10,
    "extractMinChars": 400,
    "relevantItemChars": 500,
    "briefItemChars": 160,
    "sameBodyRatio": 0.8,
    "sameEventRatio": 0.62,
    "titleMatchMinChars": 8,
    "shortfallMinFacts": 3,
    "coldItemsMax": 5
  },
  "REPORT_BUDGET": {
    "maxItemChars": 1000,
    "maxUserChars": 10000,
    "maxUserCharsMember": 16000
  },
  "REPORT_FIELD_LIMITS": {
    "analysisPointChars": 80,
    "analysisPointMax": 4,
    "stanceNoteChars": 60,
    "verdictChars": 60,
    "reputationChars": 60,
    "consistencyChars": 40,
    "memberNoteChars": 240,
    "quoteNoteChars": 120,
    "conflictTopicChars": 24,
    "conflictSideChars": 100,
    "conflictMax": 3,
    "peerMax": 3,
    "peerNameChars": 20,
    "peerGapChars": 120,
    "profileMax": 6,
    "profileLabelChars": 8,
    "profileValueChars": 40,
    "relationMax": 5,
    "relationNameChars": 20,
    "relationNoteChars": 40,
    "affiliationMax": 4,
    "affiliationNameChars": 20,
    "affiliationNoteChars": 40,
    "timelineMax": 8,
    "timelineDateChars": 10,
    "dynamicsDateChars": 20,
    "timelineEventChars": 60,
    "endorseMax": 3,
    "endorseBrandChars": 20,
    "endorseNoteChars": 40,
    "glossaryMax": 5,
    "glossaryTermChars": 10,
    "glossaryExplainChars": 50,
    "controversyMax": 3,
    "controversyTopicChars": 12,
    "controversyClaimChars": 60,
    "controversyResponseChars": 40
  },
  "REPORT_QUOTAS": {
    "dynamicsMin": 3,
    "dynamicsMax": 6,
    "dynamicsTarget": 5,
    "quotesMin": 2,
    "quotesMax": 5,
    "quotesTarget": 4,
    "analysisPointsMin": 3,
    "stanceMin": 2,
    "stanceMax": 4,
    "timelineMin": 3,
    "timelineMax": 8,
    "timelineTarget": 5,
    "profileMin": 3,
    "profileTarget": 5,
    "endorseTarget": 2
  },
  "REPORT_OUTPUT_BUDGET": {
    "chatMaxTokens": 8192,
    "reasoningReserve": 0.4,
    "charsPerToken": 1
  },
  "SEARCH_COUNTS": {
    "maxAttempts": 3,
    "maxResultsCap": 40,
    "mainCount": 10,
    "mainFreshnessLadderDays": [
      30,
      365
    ],
    "planWordsPerLane": 2,
    "socialCount": 8,
    "deepMainCount": 24,
    "deepSocialCount": 16,
    "bgCount": 8,
    "deepBgCount": 12,
    "askCount": 8,
    "askFreshnessDays": 7
  },
  "OPINION_LIMITS": {
    "watchCount": {
      "free": 3,
      "member": 10
    },
    "personWatchCount": {
      "free": 3,
      "member": 10
    },
    "detailRows": {
      "free": 5,
      "member": null
    }
  },
  "DEEP_DIVE": {
    "queriesPerHit": 1,
    "perRunMax": 6,
    "perDayMax": 60
  },
  "REPORT_PREVIEW": {
    "sectionRows": {
      "free": 3,
      "member": null
    }
  },
  "REPORT_BUILD": {
    "batchCount": 4,
    "batchConcurrency": 4,
    "batchAttempts": 3,
    "generateAttempts": 2,
    "chatDeadlineMs": 45000,
    "searchBudgetMs": 15000,
    "slackMs": 30000
  }
}
