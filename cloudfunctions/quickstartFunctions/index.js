const { BIZ, TRUNCATE, TIMEOUT } = require("./config");
const cloud = require("wx-server-sdk");
const {
  truncateLink,
  logInfo,
  assertUnderJobLimit,
  grantAdPointsWithDailyCap,
  toDateKey,
  COLLECTION_JOBS,
  COLLECTION_USERS,
} = require("./guards/bizGuard");
const { extractVideoMeta, downloadAndUploadVideo } = require("./parsers/videoExtract");
const { submitTranscribeRecTask, pollTranscribeOnce } = require("./media/asrRecTask");
const tencentCi = require("./media/tencentCiTranscode");
const { submitCompressCiTask, pollCompressCiOnce } = require("./media/ciCompressTask");

/** 云函数内用 DYNAMIC_CURRENT_ENV；云托管容器内需在环境变量中设置 TCB_ENV_ID（与小程序云开发环境 ID 一致） */
cloud.init({
  env: process.env.TCB_ENV_ID || cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

/** 需粘贴分享链接，走解析接口 */
const LINK_EXTRACT_ACTIONS = new Set([
  "watermark_remove",
  "video_channel_extract",
]);

/** 需先上传文件到云存储，videoLink 传 cloud fileID */
const UPLOAD_BASED_ACTIONS = new Set([
  "local_video_watermark_remove",
  "transcribe",
  "compress_video",
  "md5_modify",
]);

const PROCESSING_TIMEOUT_MS = TIMEOUT.JOB_PROCESSING;
/** 录音文件识别异步任务：轮询腾讯云 + 公网拉取云存储临时链接，适当放宽 */
const TRANSCRIBE_PROCESSING_TIMEOUT_MS = TIMEOUT.TRANSCRIBE_POLL;
/** COS 数据万象转码：排队 + 转码 + 回传云存储，适当放宽 */
const COMPRESS_CI_PROCESSING_TIMEOUT_MS = TIMEOUT.COMPRESS_CI_POLL;

// -------------------------
// 数据库集合 & 索引
// -------------------------
// 部署后请在微信云开发控制台 → 数据库 → 索引管理，创建以下复合索引：
//   video_jobs:    openid (升序) + createdAt (降序)   — getRecentVideoJobs / 频控查询
//   users:         openid (升序)                       — getOrCreateUser / 积分操作
//   checkins:      openid (升序) + dateKey (升序)      — 签到去重
//   usage_records: openid (升序) + createdAt (降序)    — 使用记录分页
//   orders:        openid (升序) + createdAt (降序)    — 订单记录分页
const COLLECTION_ORDERS = "orders";
const COLLECTION_USAGE = "usage_records";
const COLLECTION_CHECKINS = "checkins";

/** 观看完整激励视频获得的积分 */
const REWARD_AD_POINTS = BIZ.REWARD_AD_POINTS;
/** 消耗积分跳过广告（每日最多用积分跳过 1 次，与签到配合运营） */
const SKIP_AD_POINTS_COST = BIZ.SKIP_AD_POINTS_COST;

const ensureCollection = async (name) => {
  try {
    await db.createCollection(name);
  } catch (e) {
    // 已存在时会抛错，这里静默忽略
  }
};

const ensureBizCollections = async () => {
  await ensureCollection(COLLECTION_USERS);
  await ensureCollection(COLLECTION_JOBS);
  await ensureCollection(COLLECTION_ORDERS);
  await ensureCollection(COLLECTION_USAGE);
  await ensureCollection(COLLECTION_CHECKINS);
};

const getWxContext = () => cloud.getWXContext();
const getPayload = (event) => {
  if (event && event.data && typeof event.data === "object") return event.data;
  return event || {};
};

/** 将技术错误转为用户可读文案，隐藏供应商名/环境变量名/JSON Path 等 */
const toUserError = (raw) => {
  const s = String(raw || "");
  const lower = s.toLowerCase();
  if (lower.includes("链接为空") || lower.includes("link is empty")) return "请输入要解析的视频链接";
  if (lower.includes("不支持的任务类型")) return "不支持此操作，请重试";
  if (lower.includes("超时")) return "解析超时，请重试或稍后再试";
  if (lower.includes("无法识别链接") || lower.includes("未知域名")) return "暂不支持此链接，请尝试其他平台的分享链接";
  if (lower.includes("视频号") && (lower.includes("不支持") || lower.includes("内置解析"))) return "视频号暂不支持直接解析，请在手机上先保存到相册，再用「本地视频」上传";
  if (lower.includes("鉴权失败") || lower.includes("密钥") || lower.includes("authentication")) return "解析服务配置异常，请联系客服";
  if (s.length > 120) return s.slice(0, TRUNCATE.USER_ERROR) + "…";
  return s;
};

const getOrCreateUser = async (nickname) => {
  await ensureCollection(COLLECTION_USERS);
  const wxContext = getWxContext();
  const { OPENID: openid, APPID: appid, UNIONID: unionid } = wxContext;

  const existing = await db.collection(COLLECTION_USERS).where({ openid }).get();
  if (existing.data && existing.data.length) {
    return existing.data[0];
  }

  const created = await db.collection(COLLECTION_USERS).add({
    data: {
      openid,
      appid,
      unionid,
      nickname: nickname || "",
      points: 0,
      createdAt: db.serverDate(),
    },
  });

  const fresh = await db.collection(COLLECTION_USERS).where({ openid }).get();
  return fresh.data && fresh.data.length ? fresh.data[0] : { _id: created._id, openid };
};

/** 解析成功时写入使用记录，供「我的 → 使用记录」展示 */
const recordUsageForJob = async (openid, job, extractResult) => {
  try {
    await ensureCollection(COLLECTION_USAGE);
    await db.collection(COLLECTION_USAGE).add({
      data: {
        openid,
        videoAction: job.videoAction || "",
        videoLink: job.videoLink || "",
        jobId: job._id,
        platform: (extractResult && extractResult.platform) || "",
        title: (extractResult && extractResult.title) || "",
        createdAt: db.serverDate(),
      },
    });
  } catch (e) {
    console.error("[recordUsageForJob]", e && e.message);
  }
};

/** 解析成功且开启 RECORD_ORDER_ON_SUCCESS 时写入 orders，便于对账/统计 */
const recordOrderIfEnabled = async (job, result) => {
  const on = process.env.RECORD_ORDER_ON_SUCCESS;
  if (on !== "1" && on !== "true") return;
  try {
    await ensureCollection(COLLECTION_ORDERS);
    await db.collection(COLLECTION_ORDERS).add({
      data: {
        openid: job.openid,
        videoAction: job.videoAction || "",
        jobId: job._id,
        videoLink: String(job.videoLink || "").slice(0, TRUNCATE.DB_LINK),
        title: (result && result.title) || "",
        platform: (result && result.platform) || "",
        createdAt: db.serverDate(),
      },
    });
  } catch (e) {
    console.error("[recordOrderIfEnabled]", e && e.message);
  }
};

// 创建视频处理任务：返回 jobId。此版本为“接口联通 + 状态模拟”，便于前端接入与联调。
const requestVideoJob = async (event) => {
  await ensureBizCollections();
  const payload = getPayload(event);
  const { videoAction, videoLink, clientPayload } = payload;
  if (!videoAction || typeof videoAction !== "string") {
    return { success: false, errMsg: "videoAction is required" };
  }
  if (!videoLink || typeof videoLink !== "string") {
    return { success: false, errMsg: "videoLink is required" };
  }

  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;

  const rl = await assertUnderJobLimit(db, _, openid);
  if (!rl.ok) {
    return { success: false, errMsg: rl.errMsg };
  }

  await getOrCreateUser(payload.nickname || "");

  const created = await db.collection(COLLECTION_JOBS).add({
    data: {
      openid,
      videoAction,
      videoLink,
      clientPayload: clientPayload || {},
      status: "queued",
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      result: null,
    },
  });

  logInfo("video_job_created", {
    jobId: created._id,
    action: videoAction,
    linkPreview: truncateLink(videoLink),
  });

  return {
    success: true,
    data: {
      jobId: created._id,
      status: "queued",
    },
  };
};

const withTimeout = (promise, ms, label) => {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label || "操作"}超时（${(ms / 1000).toFixed(0)}s），请重试`)), ms)
  );
  return Promise.race([promise, timer]);
};

const buildExtractResult = async (job) => {
  // 解析阶段整体超时：多供应商 fallback 累积耗时可能很长，加硬上限防止云函数耗尽
  const meta = await withTimeout(
    extractVideoMeta(job.videoLink),
    55000,
    "视频解析"
  );

  // 默认在云端拉取直链并写入云存储，小程序用 getTempFileURL 预览，避免 wx.downloadFile 配域名/大文件卡顿（B 站 CDN 尤甚）。
  // 若需省流量与耗时、仅返回直链由客户端下载，设置 EXTRACT_SERVER_UPLOAD=0
  const serverUploadOff =
    process.env.EXTRACT_SERVER_UPLOAD === "0" ||
    process.env.EXTRACT_SERVER_UPLOAD === "false" ||
    process.env.EXTRACT_SERVER_UPLOAD === "no";
  const tryServerUpload = !serverUploadOff;

  let fileID = "";
  let uploadSkipReason = "";
  let uploadError = "";
  let sizeBytes = 0;

  if (tryServerUpload) {
    const upload = await downloadAndUploadVideo(meta.videoUrl, job._id, meta.platform);
    fileID = upload.fileID || "";
    uploadSkipReason = upload.skipReason || "";
    uploadError = upload.error || "";
    sizeBytes = upload.sizeBytes || 0;
  }

  let message = "已解析无水印直链，正在加载预览…";
  if (fileID) {
    message = "提取成功，视频已上传至云存储，可在下方预览";
  } else if (tryServerUpload && uploadSkipReason === "short_video") {
    message = "短视频已解析，可直接预览与下载";
  } else if (tryServerUpload && uploadSkipReason === "file_too_large") {
    message = `视频过大（约${(sizeBytes / 1048576).toFixed(1)}MB超过云端上限），已保留直链。建议复制链接在浏览器下载`;
  } else if (tryServerUpload && uploadSkipReason === "upload_failed") {
    message = `云端上传失败：${uploadError || "未知错误"}。已保留直链，可复制链接在浏览器下载`;
  } else if (tryServerUpload && uploadSkipReason === "download_failed") {
    message = `云端下载失败：${uploadError || "网络错误"}。请稍后重试或复制链接在浏览器下载`;
  }

  return {
    message,
    videoAction: job.videoAction,
    videoLink: job.videoLink,
    platform: meta.platform,
    title: meta.title || "",
    cover: meta.cover || "",
    videoUrl: meta.videoUrl,
    fileID,
    subtitles: [],
    uploadSkipReason,
    sizeBytes,
    previewHint: tryServerUpload ? "cloud_or_client" : "client_download",
    clientPayload: job.clientPayload || {},
  };
};

const isCloudFileId = (s) =>
  typeof s === "string" && s.indexOf("cloud://") === 0;

const formatBytesShort = (n) => {
  if (n == null || typeof n !== "number" || Number.isNaN(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
};

/**
 * 在 MP4/MOV 末尾追加合法 `free` 原子（ISO BMFF），改变 MD5 且不破坏原有音视频轨。
 * 勿再对末字节异或，易损坏 mdat 导致无法解码。
 */
const appendMp4FreeAtom = (buf) => {
  const pad = Buffer.alloc(4);
  pad.writeUInt32BE((Date.now() & 0xffffffff) >>> 0, 0);
  const size = 8 + pad.length;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write("free", 4);
  return Buffer.concat([buf, head, pad]);
};

/**
 * 上传类任务：videoLink 为云存储 fileID
 */
const buildUploadJobResult = async (job) => {
  const fileID = job.videoLink;
  if (!isCloudFileId(fileID)) {
    throw new Error("请先上传文件（需为云存储 fileID）");
  }

  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const payload = job.clientPayload && typeof job.clientPayload === "object" ? job.clientPayload : {};
  const ext =
    (payload.originalExt && String(payload.originalExt)) ||
    (payload.ext && String(payload.ext)) ||
    ".mp4";

  const base = {
    videoAction: job.videoAction,
    videoLink: fileID,
    platform: "upload",
    title: "",
    cover: "",
    videoUrl: "",
    subtitles: [],
    previewHint: "cloud_file",
    clientPayload: payload,
  };

  switch (job.videoAction) {
    case "local_video_watermark_remove":
      return {
        ...base,
        message:
          "视频已上传，可在下方预览与保存。\n\n【说明】本功能不提供 AI 去水印：画面中的角标、字幕、台标等不会自动消失。\n\n要去平台水印：请回首页粘贴抖音/快手/视频号等分享链接，使用「一键提取视频」（解析直链一般为无平台水印）。\n\n本地文件若必须擦除水印：需自行用剪辑软件或第三方去水印服务。",
        fileID,
        platform: "local",
      };

    case "compress_video": {
      const preCompressed =
        payload.clientCompressed === true ||
        payload.clientCompressed === "true" ||
        payload.clientCompressed === 1;
      const ob = Number(payload.originalSizeBytes);
      const cb = Number(payload.compressedSizeBytes);
      const mode = String(payload.compressMode || "");
      const q = String(payload.compressQuality || "");
      const advLabel = String(payload.compressAdvancedLabel || "");
      const compressFailed =
        payload.compressFailed === true ||
        payload.compressFailed === "true" ||
        payload.compressFailed === 1;
      const compressLongVideo =
        payload.compressLongVideo === true ||
        payload.compressLongVideo === "true" ||
        payload.compressLongVideo === 1;
      const cloudCi =
        payload.cloudCiTranscode === true ||
        payload.cloudCiTranscode === "true" ||
        payload.cloudCiTranscode === 1;
      const qualityLabel =
        q === "low"
          ? "体积优先"
          : q === "high"
            ? "清晰优先"
            : q === "medium"
              ? "平衡"
              : "";

      let modeDesc = "";
      if (compressFailed) {
        modeDesc = "本机压缩未成功，已上传原片";
      } else if (mode === "advanced") {
        const br = payload.compressBitrate != null ? Number(payload.compressBitrate) : "";
        const fps = payload.compressFps != null ? Number(payload.compressFps) : "";
        const rs = payload.compressResolution != null ? Number(payload.compressResolution) : "";
        modeDesc = `高级参数：${advLabel || "自定义"}（码率 ${br}kbps，帧率 ${fps}fps，相对分辨率 ${rs}）`;
      } else if (mode === "none") {
        modeDesc = "当前环境不支持压缩，已上传原片";
      } else if (qualityLabel) {
        modeDesc = `质量档位：${qualityLabel}`;
      }

      let sizeDesc = "";
      let savedPct = null;
      if (ob > 0 && cb >= 0) {
        sizeDesc = `原始约 ${formatBytesShort(ob)} → 上传约 ${formatBytesShort(cb)}`;
        if (cb < ob) {
          savedPct = Math.round((1 - cb / ob) * 100);
          sizeDesc += `（约减少 ${savedPct}%）`;
        } else if (preCompressed) {
          sizeDesc += "（压缩后体积未明显减小，与素材码率/编码有关，仍上传当前文件）";
        }
      }

      const longNote =
        !cloudCi && compressLongVideo && !compressFailed
          ? "长视频场景下本机压缩对体积下降可能有限；若仍过大建议先剪辑分段或使用云端转码。"
          : "";

      const headLine = cloudCi
        ? "结果已通过腾讯云 COS 数据万象媒体转码生成。"
        : preCompressed
          ? "视频已在本机压缩后上传至云存储。"
          : "视频已上传（未走本机压缩或压缩失败已回退原片）。";

      const tailHint = cloudCi
        ? ""
        : preCompressed
          ? "若需更强压缩或统一规格，可后续接入云端转码（FFmpeg / COS 媒体处理）。"
          : "云端二次转码需自行接入 FFmpeg 或对象存储转码能力。";

      const message = [headLine, modeDesc, sizeDesc, longNote, tailHint].filter(Boolean).join("\n");

      const compressStats =
        ob > 0 || cb >= 0
          ? {
              originalBytes: ob > 0 ? ob : null,
              compressedBytes: cb >= 0 ? cb : null,
              savedPercent: savedPct,
              compressMode: mode || null,
              compressQuality: q || null,
              compressAdvancedLabel: advLabel || null,
              compressFailed: !!compressFailed,
              compressLongVideo: !!compressLongVideo,
            }
          : null;

      return {
        ...base,
        message,
        fileID,
        platform: "compress",
        title: "视频压缩",
        compressStats,
      };
    }

    case "md5_modify": {
      const dl = await cloud.downloadFile({ fileID });
      const buf = dl.fileContent;
      if (!buf || buf.length < 2) {
        throw new Error("文件过小或无法读取");
      }
      const maxBytes = BIZ.MD5_MAX_BYTES;
      if (buf.length > maxBytes) {
        throw new Error("文件过大，请选用 48MB 以内文件");
      }
      const out = appendMp4FreeAtom(buf);

      const safeExt = ext.match(/^\.[a-zA-Z0-9]{1,8}$/) ? ext : ".mp4";
      const cloudPath = `uploads/md5/${openid}/${String(job._id)}${safeExt}`;
      const up = await cloud.uploadFile({
        cloudPath,
        fileContent: out,
      });

      return {
        ...base,
        message:
          "已生成新文件：在末尾追加合法 MP4「free」空闲盒，MD5 与原始不同，一般可正常预览。",
        fileID: up.fileID,
        originalFileID: fileID,
        title: "MD5 已变更",
        platform: "md5",
      };
    }

    default:
      throw new Error("未知上传类任务");
  }
};

/** 是否走 COS 数据万象异步转码：已配置 CI，且客户端显式开启或「长视频」场景 */
const shouldCompressUseTencentCi = (job) => {
  if (job.videoAction !== "compress_video") return false;
  if (!tencentCi.isCiTranscodeConfigured()) return false;
  const p = job.clientPayload && typeof job.clientPayload === "object" ? job.clientPayload : {};
  if (p.cloudCiTranscode === true || p.cloudCiTranscode === "true" || p.cloudCiTranscode === 1) {
    return true;
  }
  if (p.compressLongVideo === true || p.compressLongVideo === "true" || p.compressLongVideo === 1) {
    return true;
  }
  return false;
};

const buildCompressCiCompletedResult = async (job, outFileID, outBytes) => {
  const prev = job.clientPayload && typeof job.clientPayload === "object" ? job.clientPayload : {};
  const merged = {
    ...job,
    videoLink: outFileID,
    clientPayload: {
      ...prev,
      compressedSizeBytes: outBytes,
      cloudCiTranscode: true,
    },
  };
  return buildUploadJobResult(merged);
};

const fetchJob = async (jobId, openid) => {
  const res = await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).get();
  if (!res.data || !res.data.length) return null;
  return res.data[0];
};

// 查询任务状态：queued 时抢锁解析；transcribe 走异步录音文件识别；processing 超时则失败。
const getVideoJobStatus = async (event) => {
  await ensureCollection(COLLECTION_JOBS);
  const payload = getPayload(event);
  const { jobId } = payload;
  if (!jobId) return { success: false, errMsg: "jobId is required" };

  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;

  let job = await fetchJob(jobId, openid);
  if (!job) {
    return { success: false, errMsg: "job not found" };
  }

  if (job.status === "processing") {
    const started = job.processingAt ? new Date(job.processingAt).getTime() : 0;
    const timeoutMs =
      job.videoAction === "transcribe"
        ? TRANSCRIBE_PROCESSING_TIMEOUT_MS
        : job.videoAction === "compress_video" && job.tencentCiJobId
          ? COMPRESS_CI_PROCESSING_TIMEOUT_MS
          : PROCESSING_TIMEOUT_MS;
    if (started && Date.now() - started > timeoutMs) {
      await db
        .collection(COLLECTION_JOBS)
        .where({ _id: jobId, openid, status: "processing" })
        .update({
          data: {
            status: "failed",
            result: _.set({ error: "处理超时，请重试" }),
            updatedAt: db.serverDate(),
          },
        });
      job = await fetchJob(jobId, openid);
      return { success: true, data: job };
    }

    if (job.videoAction === "compress_video" && job.tencentCiJobId) {
      try {
        const poll = await pollCompressCiOnce(cloud, job, buildCompressCiCompletedResult);
        if (poll.phase === "completed" && poll.completedResult) {
          await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
            data: {
              status: "completed",
              result: _.set(poll.completedResult),
              updatedAt: db.serverDate(),
            },
          });
          await recordUsageForJob(openid, job, poll.completedResult);
          await recordOrderIfEnabled(job, poll.completedResult);
          job = await fetchJob(jobId, openid);
        } else if (poll.phase === "failed") {
          await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
            data: {
              status: "failed",
              result: _.set({ error: toUserError(poll.errText || "云端压缩失败"), errorDetail: poll.errText || "" }),
              updatedAt: db.serverDate(),
            },
          });
          job = await fetchJob(jobId, openid);
        }
      } catch (e) {
        const rawErr = e && e.message ? String(e.message) : String(e);
        await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
          data: {
            status: "failed",
            result: _.set({ error: toUserError(rawErr), errorDetail: rawErr }),
            updatedAt: db.serverDate(),
          },
        });
        job = await fetchJob(jobId, openid);
      }
      return { success: true, data: job };
    }

    if (job.videoAction === "transcribe") {
      try {
        if (!job.tencentRecTaskId) {
          await submitTranscribeRecTask(cloud, db, _, job, openid, COLLECTION_JOBS);
          job = await fetchJob(jobId, openid);
        }
        const poll = await pollTranscribeOnce(job);
        if (poll.phase === "completed" && poll.completedResult) {
          await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
            data: {
              status: "completed",
              result: _.set(poll.completedResult),
              updatedAt: db.serverDate(),
            },
          });
          await recordUsageForJob(openid, job, poll.completedResult);
          await recordOrderIfEnabled(job, poll.completedResult);
          job = await fetchJob(jobId, openid);
        } else if (poll.phase === "failed") {
          await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
            data: {
              status: "failed",
              result: _.set({ error: toUserError(poll.errText || "识别失败"), errorDetail: poll.errText || "" }),
              updatedAt: db.serverDate(),
            },
          });
          job = await fetchJob(jobId, openid);
        }
      } catch (e) {
        const rawErr = e && e.message ? String(e.message) : String(e);
        await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
          data: {
            status: "failed",
            result: _.set({ error: toUserError(rawErr), errorDetail: rawErr }),
            updatedAt: db.serverDate(),
          },
        });
        job = await fetchJob(jobId, openid);
      }
      return { success: true, data: job };
    }

    return { success: true, data: job };
  }

  if (job.status === "queued") {
    const lock = await db
      .collection(COLLECTION_JOBS)
      .where({ _id: jobId, openid, status: "queued" })
      .update({
        data: {
          status: "processing",
          processingAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });

    if (!lock.stats || !lock.stats.updated) {
      job = await fetchJob(jobId, openid);
      return { success: true, data: job };
    }

    job = await fetchJob(jobId, openid);

    try {
      if (job.videoAction === "transcribe") {
        await submitTranscribeRecTask(cloud, db, _, job, openid, COLLECTION_JOBS);
      } else if (shouldCompressUseTencentCi(job)) {
        await submitCompressCiTask(cloud, db, _, job, openid, COLLECTION_JOBS);
      } else {
        const action = job.videoAction;
        const supported =
          LINK_EXTRACT_ACTIONS.has(action) || UPLOAD_BASED_ACTIONS.has(action);
        if (!supported) {
          throw new Error("不支持的任务类型");
        }

        let completedResult;
        if (UPLOAD_BASED_ACTIONS.has(action)) {
          completedResult = await buildUploadJobResult(job);
        } else {
          completedResult = await buildExtractResult(job);
        }
        await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
          data: {
            status: "completed",
            result: _.set(completedResult),
            updatedAt: db.serverDate(),
          },
        });
        await recordUsageForJob(openid, job, completedResult);
        await recordOrderIfEnabled(job, completedResult);
      }
    } catch (e) {
      const rawErr = e && e.message ? String(e.message) : String(e);
      logInfo("job_queued_process_fail", {
        jobId,
        action: job.videoAction,
        err: rawErr.slice(0, TRUNCATE.LINK_PREVIEW),
        linkPreview: truncateLink(job.videoLink),
      });
      // 用户可见文案：过滤技术细节（供应商名、环境变量名、JSON Path 等）
      const userErr = toUserError(rawErr);
      await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).update({
        data: {
          status: "failed",
          result: _.set({ error: userErr, errorDetail: rawErr }),
          updatedAt: db.serverDate(),
        },
      });
    }

    job = await fetchJob(jobId, openid);
  }

  return { success: true, data: job };
};

const getRecentVideoJobs = async (event) => {
  await ensureCollection(COLLECTION_JOBS);
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const payload = getPayload(event);
  const limit = Math.min(50, Math.max(1, Number(payload.limit) || 10));

  // 需要复合索引: openid(升序) + createdAt(降序)，否则微信云开发会报错
  const res = await db
    .collection(COLLECTION_JOBS)
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return { success: true, data: res.data || [] };
};

/** 我的页：积分、今日是否已签到 */
const getUserProfile = async () => {
  await ensureBizCollections();
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  await getOrCreateUser("");

  const userRes = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const user = userRes.data && userRes.data.length ? userRes.data[0] : null;
  const points = user ? Number(user.points || 0) : 0;

  const dateKey = toDateKey(new Date());
  const chk = await db
    .collection(COLLECTION_CHECKINS)
    .where({ openid, dateKey })
    .get();
  const checkedInToday = !!(chk.data && chk.data.length);
  const usedPointsSkipToday =
    user && String(user.adSkipByPointsDateKey || "") === dateKey;

  const oid = openid || "";
  const openidShort =
    oid.length > 12 ? `${oid.slice(0, 6)}…${oid.slice(-4)}` : oid;

  return {
    success: true,
    data: {
      points,
      checkedInToday,
      usedPointsSkipToday,
      skipAdPointsCost: SKIP_AD_POINTS_COST,
      rewardAdPoints: REWARD_AD_POINTS,
      openid,
      openidShort,
    },
  };
};

const checkIn = async (event) => {
  await ensureBizCollections();
  const payload = getPayload(event);
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const serverDk = toDateKey(new Date());
  const dateKey = payload.dateKey ? String(payload.dateKey) : serverDk;
  if (dateKey !== serverDk) {
    return { success: false, errMsg: "签到日期无效" };
  }

  // 确保用户记录存在，签到时能正确累加积分
  await getOrCreateUser(payload.nickname || "");

  const already = await db
    .collection(COLLECTION_CHECKINS)
    .where({ openid, dateKey })
    .get();

  if (already.data && already.data.length) {
    return { success: true, data: { already: true } };
  }

  // 签到积分：默认 100；不信任客户端大额 points，单次数值封顶 100
  let addPoints = payload.points != null ? Number(payload.points) : 100;
  if (!Number.isFinite(addPoints) || addPoints < 0) addPoints = 100;
  addPoints = Math.min(Math.round(addPoints), 100);

  await db.collection(COLLECTION_CHECKINS).add({
    data: {
      openid,
      dateKey,
      createdAt: db.serverDate(),
      points: addPoints,
    },
  });

  // 简单累加：如需严格并发一致性，可改用事务/原子更新（这里先保证可用）
  const userRes = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const user = userRes.data && userRes.data.length ? userRes.data[0] : null;
  if (user) {
    await db.collection(COLLECTION_USERS).where({ _id: user._id }).update({
      data: {
        points: Number(user.points || 0) + addPoints,
      },
    });
  }

  return { success: true, data: { already: false, points: addPoints } };
};

/** 完整观看激励视频后发放积分（客户端在 onClose isEnded 后调用） */
const grantRewardAdPoints = async () => {
  await ensureBizCollections();
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  await getOrCreateUser("");
  const add = REWARD_AD_POINTS;
  const r = await grantAdPointsWithDailyCap(db, _, openid, add);
  if (!r.ok) {
    logInfo("ad_reward_rejected", { openid: truncateLink(openid, 16), err: r.errMsg });
    return { success: false, errMsg: r.errMsg };
  }
  return { success: true, data: r.data };
};

/** 消耗积分跳过广告：需当日已签到、积分≥100，且每自然日仅 1 次 */
const spendPointsSkipAd = async () => {
  await ensureBizCollections();
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const dk = toDateKey(new Date());
  const cost = SKIP_AD_POINTS_COST;
  await getOrCreateUser("");

  const chk = await db
    .collection(COLLECTION_CHECKINS)
    .where({ openid, dateKey: dk })
    .get();
  if (!chk.data || !chk.data.length) {
    return {
      success: false,
      errMsg: "请先完成今日签到后，再使用积分跳过广告",
    };
  }

  const userRes = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const user = userRes.data && userRes.data[0];
  if (!user) {
    return { success: false, errMsg: "用户不存在" };
  }
  if (String(user.adSkipByPointsDateKey || "") === dk) {
    return {
      success: false,
      errMsg: "今日已使用过积分跳过广告，请观看广告或明日再试",
    };
  }
  const cur = Number(user.points || 0);
  if (cur < cost) {
    return {
      success: false,
      errMsg: `跳过广告需 ${cost} 积分，当前 ${cur}。观看广告可获得 ${REWARD_AD_POINTS} 积分`,
    };
  }

  await db.collection(COLLECTION_USERS).where({ _id: user._id }).update({
    data: {
      points: _.inc(-cost),
      adSkipByPointsDateKey: dk,
    },
  });
  const after = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const u2 = after.data && after.data[0];
  return {
    success: true,
    data: {
      spent: cost,
      total: u2 ? Number(u2.points || 0) : 0,
    },
  };
};

const getOrders = async () => {
  await ensureCollection(COLLECTION_ORDERS);
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const res = await db
    .collection(COLLECTION_ORDERS)
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return { success: true, data: res.data || [] };
};

const getUsageRecords = async () => {
  await ensureCollection(COLLECTION_USAGE);
  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;
  const res = await db
    .collection(COLLECTION_USAGE)
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return { success: true, data: res.data || [] };
};

const getFaqList = async () => {
  // FAQ 目前用静态数据返回，后续可放到数据库/配置化
  return {
    success: true,
    data: [
      { id: "1", title: "如何提取视频？", content: "在首页粘贴视频链接后点击「一键提取视频」，等待解析完成即可预览或复制直链。" },
      {
        id: "2",
        title: "积分有什么用？",
        content:
          "每日签到可获得积分。提交解析前若已配置激励视频，可选择观看广告，每完整观看一次可获得 50 积分。当日已签到且积分≥100 时，每日还可使用 100 积分跳过 1 次广告；也可一直通过看广告获得积分并解析。",
      },
      { id: "3", title: "解析记录在哪看？", content: "「我的 → 解析记录」可查看任务状态；成功提取后「使用记录」会多一条摘要。" },
      { id: "4", title: "多久出结果？", content: "与链接类型、视频大小和网络有关，一般几秒到几十秒；失败时请查看提示或联系客服。" },
      { id: "5", title: "为什么有的平台解析不了？", content: "不同平台依赖对应解析服务。抖音、快手等可在云端配置密钥或商用接口；多平台统一解析可后续接入 VIDEO_PARSE_URL 等，以你实际配置为准。" },
      {
        id: "6",
        title: "本地上传 / 压缩 / 文案怎么用？",
        content:
          "「本地视频」仅上传云端供预览与保存，不进行 AI 去水印；要去平台水印请用首页「一键提取」。「提取文案」支持常见音频与 mp4：上传后走腾讯云录音文件识别（异步），需配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY。压缩可先本机压缩再上传；MD5 会生成新文件。",
      },
    ],
  };
};

/** 删除指定任务（仅允许删除本人的任务） */
const deleteVideoJob = async (event) => {
  await ensureCollection(COLLECTION_JOBS);
  const payload = getPayload(event);
  const { jobId } = payload;
  if (!jobId) return { success: false, errMsg: "jobId is required" };

  const wxContext = getWxContext();
  const { OPENID: openid } = wxContext;

  // 仅允许删除本人的任务
  const job = await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).get();
  if (!job.data || !job.data.length) {
    return { success: false, errMsg: "任务不存在或无权操作" };
  }

  await db.collection(COLLECTION_JOBS).where({ _id: jobId, openid }).remove();
  return { success: true };
};

// -------------------------
// 云函数入口
// -------------------------
exports.main = async (event, context) => {
  switch (event.type) {
    // -------- 新增接口 --------
    case "requestVideoJob":
      return await requestVideoJob(event);
    case "getVideoJobStatus":
      return await getVideoJobStatus(event);
    case "getRecentVideoJobs":
      return await getRecentVideoJobs(event);
    case "deleteVideoJob":
      return await deleteVideoJob(event);
    case "getUserProfile":
      return await getUserProfile();
    case "checkIn":
      return await checkIn(event);
    case "grantRewardAdPoints":
      return await grantRewardAdPoints();
    case "spendPointsSkipAd":
      return await spendPointsSkipAd();
    case "getOrders":
      return await getOrders();
    case "getUsageRecords":
      return await getUsageRecords();
    case "getFaqList":
      return await getFaqList();

    default:
      return {
        success: false,
        errMsg: event && event.type ? `unknown type: ${event.type}` : "missing event.type",
      };
  }
};
