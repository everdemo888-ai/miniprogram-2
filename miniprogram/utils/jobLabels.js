/**
 * 任务类型 & 状态 → 展示文案的映射
 */

const ACTION_NAME_MAP = {
  watermark_remove: "一键提取视频",
  local_video_watermark_remove: "本地上传预览",
  video_channel_extract: "视频号提取",
  transcribe: "提取文案",
  compress_video: "视频压缩",
  md5_modify: "MD5 修改",
};

const getActionName = (videoAction) => ACTION_NAME_MAP[videoAction] || "视频处理";

const JOB_STATUS_LABEL_MAP = {
  completed: "已完成",
  failed: "失败",
  processing: "解析中",
  queued: "排队中",
};

const getJobStatusLabel = (status) => JOB_STATUS_LABEL_MAP[status] || "处理中";

module.exports = {
  ACTION_NAME_MAP,
  getActionName,
  JOB_STATUS_LABEL_MAP,
  getJobStatusLabel,
};
