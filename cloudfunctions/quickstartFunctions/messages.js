/**
 * 用户可见的提示/错误消息集中管理。
 * 所有 throw new Error() 中的中文字符串均引用于此，便于维护和潜在国际化。
 * 带 %s 占位符的为模板字符串，使用时自行替换。
 */
const MSG = {
  // ---------- ASR 录音识别 ----------
  ASR_TEMP_URL_EMPTY: "getTempFileURL 无返回",
  ASR_TEMP_URL_FAIL: "无法生成云文件临时链接（请确认 fileID 有效且云存储权限正常）",
  ASR_INVALID_FILEID: "无效的云存储 fileID",
  ASR_CREATE_TASK_NO_ID: "腾讯云 CreateRecTask 未返回 TaskId",
  ASR_DESCRIBE_NO_DATA: "DescribeTaskStatus 无 Data",
  ASR_RESULT_TITLE: "文案提取",
  ASR_RESULT_DESC:
    "以下为语音识别结果（录音文件识别异步任务）。支持 mp3、m4a、wav、mp4 等常见格式；单文件 URL 方式最长可达数小时，约 5 分钟内容一般可在数秒内至数分钟内完成。",
  ASR_NO_TEXT: "（未识别到文本）",
  ASR_RECOGNIZE_FAILED: "腾讯云识别失败",
  ASR_REQUEST_FAILED: "腾讯云 ASR 请求失败（HTTP %s）",
  ASR_RESPONSE_ERROR: "腾讯云 ASR 返回错误",

  // ---------- COS 数据万象压缩 ----------
  CI_NOT_CONFIGURED: "未配置腾讯云 COS 数据万象转码（环境变量）",
  CI_INVALID_FILEID: "无效的云存储 fileID",
  CI_CANNOT_READ: "无法读取待转码视频",
  CI_OVER_LIMIT: "视频超过云端转码上限（%sMB），请先剪辑或压缩后再试",
  CI_TRANSCODE_FAILED: "转码失败",
  CI_OUTPUT_READ_FAILED: "已转码成功但读取输出文件失败：%s（请核对输出路径 %s）",
  CI_SUBMIT_FAILED: "数据万象提交转码失败：%s",
  CI_NO_JOB_ID: "CreateMediaJobs 无 JobId",
  CI_GET_OBJECT_EMPTY: "COS getObject 未返回文件内容",

  // ---------- bizGuard ----------
  GUARD_RATE_LIMIT: "操作过于频繁，请稍后再试（每 24 小时最多提交 %s 个任务）",
  GUARD_USER_NOT_FOUND: "用户不存在",
  GUARD_AD_DAILY_LIMIT: "今日广告奖励已达上限（每日最多 %s 次），请明日再试",

  // ---------- 视频解析 ----------
  EXTRACT_LINK_EMPTY: "链接为空",
  EXTRACT_NO_VIDEO_URL: "无有效视频地址",
  EXTRACT_INVALID_RESPONSE: "无效响应体 HTTP %s",
  EXTRACT_DOUYIN_ALL_FAILED: "[抖音解析] POST/GET 均失败",
  EXTRACT_DOUYIN_BUILTIN_FAILED: "内置线路均失败",
  EXTRACT_FALLBACK_NO_URL: "fallback 无有效视频地址",
  EXTRACT_KUAISHOU_NO_KEY:
    "快手解析未返回视频地址。请配置 VIDEO_PARSE_KUAISHOU_KEY，或设置 VIDEO_PARSE_URL",
  EXTRACT_KUAISHOU_AUTH_FAILED: "鉴权失败",
  EXTRACT_XHS_FAILED: "小红书解析失败（已尝试 BugPK 各端点）。请检查分享链接是否有效，或配置 VIDEO_PARSE_URL。",
  EXTRACT_BILIBILI_FAILED: "B 站解析失败（已尝试 BugPK）。请检查是否为支持的短链/视频页，或配置 VIDEO_PARSE_URL。",
  EXTRACT_WECHAT_CHANNELS_FAILED:
    "微信视频号：内置解析不支持该域名。请在云函数环境变量配置 VIDEO_PARSE_URL（支持视频号的商用/聚合接口，见 ENV.example），或改用首页「本地视频」从相册上传已保存的文件。",
  EXTRACT_UNKNOWN_DOMAIN:
    "无法识别链接或未解析出视频（未知域名时已尝试 BugPK 默认入口）。请粘贴完整分享链接，或在云端配置 VIDEO_PARSE_URL。",
  EXTRACT_CONTINUOUS_FAILURE: "若持续失败请配置商用解析接口 VIDEO_PARSE_URL",
  EXTRACT_GUIGUIYA_EMPTY: "空响应",
  EXTRACT_GUIGUIYA_UNKNOWN_TYPE: "未知响应类型",
  EXTRACT_HELLOTIK_AUTH_REQUIRED: "Authentication required",
  EXTRACT_TJIT_KEY_HELP: "请在云函数环境变量配置 VIDEO_PARSE_KUAISHOU_KEY（见 api.tjit.net 用户控制台），或改用 VIDEO_PARSE_URL 商用解析",

  // ---------- HLS / 下载 ----------
  HLS_PLAYLIST_EMPTY: "m3u8 播放列表为空",
  HLS_NO_SEGMENTS: "m3u8 播放列表中无分片",
  HLS_TOO_MANY_SEGMENTS: "m3u8 分片过多（%s），可能为直播流",
  HLS_MERGED_OVER_LIMIT: "合并后视频超过上传上限（%sMB）",
  HLS_CONTENT_TYPE_MISMATCH:
    "URL 返回了 m3u8 播放列表而非视频文件（Content-Type: %s）。请尝试其他解析源或短链接。",
  DL_CONTENT_EMPTY: "下载内容异常（仅%s字节），疑似非视频资源",
  DL_DIRECT_FAILED: "直链下载失败",
  UL_CLOUD_FAILED: "云存储上传失败：%s",

  // ---------- 通用 ----------
  GENERIC_NETWORK: "网络异常，请稍后重试",
  GENERIC_NOT_SUPPORTED: "不支持此操作，请重试",
  GENERIC_TIMEOUT: "处理超时，请重试",
  GENERIC_UNSUPPORTED_LINK: "暂不支持此链接，请尝试其他平台的分享链接",
};

/**
 * 格式化带占位符的消息：fmt(MSG.ASR_REQUEST_FAILED, 403) → "腾讯云 ASR 请求失败（HTTP 403）"
 */
const fmt = (template, ...args) => {
  let s = template;
  for (const arg of args) {
    s = s.replace("%s", String(arg));
  }
  return s;
};

module.exports = { MSG, fmt };
