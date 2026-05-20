/**
 * 集中管理的常量配置，避免硬编码散落各处。
 * 所有值均可通过同名环境变量覆盖（仅影响启动时读取）。
 */

// ---------- 超时 ----------

/** 云函数内各阶段超时（毫秒） */
const TIMEOUT = {
  /** 解析阶段超时 */
  EXTRACT: 55000,
  /** 单次 API 请求超时（通用） */
  API_REQUEST: 28000,
  /** 聚合 API 请求超时（BugPK / 龟龟呀等） */
  API_AGGREGATE: 35000,
  /** 直链下载超时 */
  DIRECT_DOWNLOAD: 120000,
  /** HLS 播放列表下载超时 */
  HLS_PLAYLIST_DL: 30000,
  /** HLS 单分片下载超时 */
  HLS_SEGMENT_DL: 20000,
  /** 视频任务处理超时 */
  JOB_PROCESSING: 180000,
  /** 语音识别异步轮询超时 */
  TRANSCRIBE_POLL: 15 * 60 * 1000,
  /** COS 数据万象转码超时 */
  COMPRESS_CI_POLL: 20 * 60 * 1000,
};

// ---------- 平台 Referer ----------

const PLATFORM_REFERER = {
  douyin: "https://www.douyin.com/",
  xiaohongshu: "https://www.xiaohongshu.com/",
  bilibili: "https://www.bilibili.com/",
  kuaishou: "https://www.kuaishou.com/",
};

// ---------- 字符串截断 ----------

const TRUNCATE = {
  /** 用户可见错误消息 */
  USER_ERROR: 120,
  /** 日志中的链接预览 */
  LINK_PREVIEW: 400,
  /** 存入数据库的链接 */
  DB_LINK: 500,
  /** 错误详情 */
  ERROR_DETAIL: 400,
  /** 云存储错误消息 */
  UPLOAD_ERROR: 300,
  /** 抖音错误汇总 */
  DOUYIN_ERRS: 900,
  /** 龟龟呀错误消息 */
  GUIGUIYA_ERR: 240,
  /** 日志中的直链 */
  LOG_URL: 200,
};

// ---------- 上传限制 ----------

const UPLOAD_LIMIT = {
  /** 云存储单文件默认上限（MB），通过 EXTRACT_MAX_UPLOAD_MB 环境变量覆盖 */
  DEFAULT_MB: 20,
  MIN_MB: 5,
  MAX_MB: 50,
};

// ---------- 腾讯云 ASR ----------

const ASR = {
  HOST: process.env.TENCENT_ASR_HOST || "asr.tencentcloudapi.com",
  REGION: process.env.TENCENT_ASR_REGION || "ap-guangzhou",
};

// ---------- COS 数据万象 ----------

const CI = {
  /** 压缩任务输入上限 */
  MAX_INPUT_BYTES: 500 * 1024 * 1024,
};

// ---------- 业务常量 ----------

const BIZ = {
  /** 激励视频奖励积分 */
  REWARD_AD_POINTS: 50,
  /** 积分跳过广告消耗 */
  SKIP_AD_POINTS_COST: 100,
  /** MD5 修改文件上限 */
  MD5_MAX_BYTES: 48 * 1024 * 1024,
};

// ---------- 短视频直下策略 ----------

const SHORT_VIDEO = {
  /** 短视频文件大小阈值（字节），低于此值不走云端转存，前端直接下载 */
  MAX_BYTES: 25 * 1024 * 1024,
};

module.exports = {
  TIMEOUT,
  PLATFORM_REFERER,
  TRUNCATE,
  UPLOAD_LIMIT,
  ASR,
  CI,
  BIZ,
  SHORT_VIDEO,
};
