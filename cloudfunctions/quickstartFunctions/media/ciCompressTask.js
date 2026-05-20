/**
 * 视频压缩：经 COS 数据万象异步转码（与 asrRecTask 类似的 submit + poll）
 */
const tencentCi = require("./tencentCiTranscode");
const { CI } = require("../config");
const { MSG, fmt } = require("../messages");

const MAX_INPUT_BYTES = CI.MAX_INPUT_BYTES;

function keysForJob(job) {
  const id = String(job._id);
  const inputKey = `ci/wx_compress/${id}_in.mp4`;
  const outputKey = `ci/wx_compress/${id}_out.mp4`;
  return { inputKey, outputKey };
}

async function submitCompressCiTask(cloud, db, _, job, openid, COLLECTION_JOBS) {
  if (!tencentCi.isCiTranscodeConfigured()) {
    throw new Error(MSG.CI_NOT_CONFIGURED);
  }
  if (job.tencentCiJobId) {
    return;
  }
  const fileID = job.videoLink;
  if (!fileID || String(fileID).indexOf("cloud://") !== 0) {
    throw new Error(MSG.CI_INVALID_FILEID);
  }

  const dl = await cloud.downloadFile({ fileID });
  const buf = dl.fileContent;
  if (!buf || buf.length < 16) {
    throw new Error(MSG.CI_CANNOT_READ);
  }
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(fmt(MSG.CI_OVER_LIMIT, Math.floor(MAX_INPUT_BYTES / 1048576)));
  }

  const { inputKey, outputKey } = keysForJob(job);
  await tencentCi.putObjectBuffer(inputKey, buf);

  const { jobId } = await tencentCi.createTranscodeJob({
    inputKey,
    outputKey,
  });

  await db
    .collection(COLLECTION_JOBS)
    .where({ _id: job._id, openid })
    .update({
      data: {
        tencentCiJobId: jobId,
        ciInputKey: inputKey,
        ciOutputKey: outputKey,
        updatedAt: db.serverDate(),
      },
    });
}

/**
 * @param {Function} buildCompressCiCompletedResult async (job, outFileID, outBytes) => result
 */
async function pollCompressCiOnce(cloud, job, buildCompressCiCompletedResult) {
  const ciJobId = job.tencentCiJobId;
  if (!ciJobId) {
    return { phase: "pending" };
  }

  const detail = await tencentCi.describeMediaJob(ciJobId);
  const st = String(detail.state || "");

  if (st === "Failed" || st === "Cancel" || st === "Paused") {
    const msg = detail.message || detail.code || st || MSG.CI_TRANSCODE_FAILED;
    return { phase: "failed", errText: `数据万象：${msg}` };
  }

  if (st !== "Success") {
    return { phase: "pending" };
  }

  let outKey = detail.outputObject || job.ciOutputKey || keysForJob(job).outputKey;
  if (outKey.indexOf("${") >= 0) {
    outKey = outKey.replace(/\$\{ext\}/gi, "mp4").replace(/\$\{jobid\}/gi, String(ciJobId));
  }

  let outBuf;
  try {
    outBuf = await tencentCi.getObjectBuffer(outKey);
  } catch (e) {
    const errText = e && e.message ? String(e.message) : String(e);
    return {
      phase: "failed",
      errText: fmt(MSG.CI_OUTPUT_READ_FAILED, errText, outKey),
    };
  }

  const cloudPath = `uploads/compress_ci/${String(job._id)}.mp4`;
  const up = await cloud.uploadFile({
    cloudPath,
    fileContent: outBuf,
  });

  const completedResult = await buildCompressCiCompletedResult(job, up.fileID, outBuf.length);

  try {
    if (job.ciInputKey) await tencentCi.deleteObjectKey(job.ciInputKey);
    if (job.ciOutputKey || outKey) await tencentCi.deleteObjectKey(outKey);
  } catch (e) {
    // 清理失败不影响任务结果
  }

  return { phase: "completed", completedResult };
}

module.exports = {
  submitCompressCiTask,
  pollCompressCiOnce,
  keysForJob,
};
