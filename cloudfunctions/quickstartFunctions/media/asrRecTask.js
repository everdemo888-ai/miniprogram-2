/**
 * 腾讯云「录音文件识别」异步任务：CreateRecTask + DescribeTaskStatus
 * 通过云存储临时链接提交，支持文档所述长音频（URL 方式时长可达数小时；约 5 分钟场景适用）
 */
const asrTencent = require("./asrTencent");
const { MSG, fmt } = require("../messages");

/** 清洗 Result 中带时间轴前缀的片段 */
function cleanRecResultText(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/\[\d+:\d+\.\d+,\d+:\d+\.\d+\]\s*/g, "")
    .replace(/\[\d+:\d+,\d+:\d+\]\s*/g, "")
    .trim();
}

/**
 * 获取云文件临时下载地址（供腾讯云拉取）
 */
async function getTempFileUrlForAsr(cloud, fileID) {
  const res = await cloud.getTempFileURL({
    fileList: [fileID],
  });
  const list = (res && res.fileList) || [];
  const item = list[0];
  if (!item) {
    throw new Error(MSG.ASR_TEMP_URL_EMPTY);
  }
  if (item.status !== 0 || !item.tempFileURL) {
    throw new Error(item.errMsg || MSG.ASR_TEMP_URL_FAIL);
  }
  return item.tempFileURL;
}

/**
 * 提交录音文件识别任务，并在库中写入 tencentRecTaskId
 */
async function submitTranscribeRecTask(cloud, db, _, job, openid, COLLECTION_JOBS) {
  const fileID = job.videoLink;
  if (!fileID || String(fileID).indexOf("cloud://") !== 0) {
    throw new Error(MSG.ASR_INVALID_FILEID);
  }
  const url = await getTempFileUrlForAsr(cloud, fileID);
  const body = {
    Url: url,
    ChannelNum: 1,
    EngineModelType: "16k_zh",
    ResTextFormat: 1,
    SourceType: 0,
  };
  const data = await asrTencent.callAsrApi("CreateRecTask", body);
  const taskId =
    data.Response &&
    data.Response.Data &&
    (data.Response.Data.TaskId !== undefined && data.Response.Data.TaskId !== null
      ? data.Response.Data.TaskId
      : null);
  if (taskId === null || taskId === undefined) {
    const err = data.Response && data.Response.Error;
    throw new Error(
      (err && err.Message) || MSG.ASR_CREATE_TASK_NO_ID
    );
  }
  await db
    .collection(COLLECTION_JOBS)
    .where({ _id: job._id, openid })
    .update({
      data: {
        tencentRecTaskId: taskId,
        updatedAt: db.serverDate(),
      },
    });
}

/**
 * 轮询一次 DescribeTaskStatus
 * @returns {Promise<{ phase: 'pending'|'completed'|'failed', completedResult?: object, errText?: string }>}
 */
async function pollTranscribeOnce(job) {
  const taskId = job.tencentRecTaskId;
  if (taskId === undefined || taskId === null) {
    return { phase: "pending" };
  }
  const data = await asrTencent.callAsrApi("DescribeTaskStatus", {
    TaskId: taskId,
  });
  const d = data.Response && data.Response.Data;
  if (!d) {
    throw new Error(MSG.ASR_DESCRIBE_NO_DATA);
  }
  const st = Number(d.Status);
  if (st === 2) {
    const text = cleanRecResultText(d.Result || "");
    const completedResult = {
      videoAction: job.videoAction,
      videoLink: job.videoLink,
      platform: "upload",
      title: MSG.ASR_RESULT_TITLE,
      cover: "",
      videoUrl: "",
      subtitles: [],
      previewHint: "cloud_file",
      clientPayload: job.clientPayload || {},
      message: MSG.ASR_RESULT_DESC,
      transcriptText: text || MSG.ASR_NO_TEXT,
    };
    return { phase: "completed", completedResult };
  }
  if (st === 3) {
    return {
      phase: "failed",
      errText: d.ErrorMsg || MSG.ASR_RECOGNIZE_FAILED,
    };
  }
  return { phase: "pending" };
}

module.exports = {
  submitTranscribeRecTask,
  pollTranscribeOnce,
  cleanRecResultText,
};
