const rewardAdGate = require("../../utils/rewardAdGate");
const { buildCloudErrorText } = require("../../utils/cloudErrorText");
const { ensureCloudEnv, CLOUD_FUNCTION_NAME } = require("../../utils/cloudUtils");
const { getActionName, getJobStatusLabel } = require("../../utils/jobLabels");

const UPLOAD_TOOL_ACTIONS = [
  "local_video_watermark_remove",
  "transcribe",
  "compress_video",
  "md5_modify",
];

/** wx.chooseMedia 的 maxDuration 仅允许 3～60（秒），超出会报 chooseMedia:fail error maxDuration */
const CHOOSE_MEDIA_MAX_DURATION = 60;

/** 从临时路径推断视频扩展名，避免 iOS .mov 被误标成 .mp4 导致云存储类型与预览异常 */
const inferVideoExtFromTempPath = (tempFilePath) => {
  const path = tempFilePath && String(tempFilePath);
  const m = path && path.match(/(\.[a-zA-Z0-9]+)$/);
  let ext = m ? m[1].toLowerCase() : ".mp4";
  const ok = new Set([
    ".mp4",
    ".mov",
    ".m4v",
    ".3gp",
    ".avi",
    ".mkv",
    ".webm",
  ]);
  if (!ok.has(ext)) ext = ".mp4";
  return ext;
};

/**
 * 高级压缩：不传 quality，使用 bitrate(kbps) / fps / resolution(0~1]
 * 预设略偏「体积」：长视频更明显省流量、减轻上传压力
 */
const COMPRESS_PRESETS_ADVANCED = [
  { key: "save", label: "省流（约680kbps）", bitrate: 680, fps: 24, resolution: 0.48 },
  { key: "mid", label: "均衡（约1280kbps）", bitrate: 1280, fps: 24, resolution: 0.72 },
  { key: "hq", label: "高码（约2200kbps）", bitrate: 2200, fps: 30, resolution: 0.95 },
];

/** 长视频一键省流：时长/体积超阈值时推荐，优先减小上传体积 */
const COMPRESS_LONG_VIDEO_PRESET = {
  label: "长视频省流（约560kbps）",
  bitrate: 560,
  fps: 24,
  resolution: 0.42,
};

/** 超过则视为长视频：提示 + 可选一键省流 */
const COMPRESS_LONG_DURATION_SEC = 120;
const COMPRESS_LONG_SIZE_BYTES = 32 * 1024 * 1024;

/** 解析类错误/失败时附在弹窗末尾，引导用户多次重试 */
const PARSE_RETRY_TIP =
  "\n\n提示：若一次未成功，可多点击几次「一键提取视频」，或稍后再试；任务面板里也可点「重试当前任务」。";

Page({
  data: {
    statusBarHeight: 20,
    videoLink: "",
    jobId: "",
    jobIdShort: "",
    jobStatusText: "",
    jobResultMessage: "",
    jobActionName: "",
    isPolling: false,
    pollCount: 0,
    lastVideoAction: "",
    recentJobs: [],
    recentLoading: false,
    recentError: "",
    jobVideoUrl: "",
    /** 为 false 时显示自定义玫瑰色播放层（关闭系统绿色中心播放钮） */
    jobVideoPlaying: false,
    jobAudioUrl: "",
    jobVideoTitle: "",
    jobRawVideoUrl: "",
    /** 复制按钮文案：解析类为「无水印直链」，本地上传/压缩等为「预览链接」 */
    copyUrlButtonLabel: "复制无水印直链",
    jobCloudFileId: "",
    jobTranscript: "",
    showPrivacyGate: false,
    privacyContractName: "",
    /** 解析进度（0–100，由轮询次数与状态估算，非服务端精确百分比） */
    jobProgressPercent: 0,
    /** 视频下载进度 0–100 */
    jobDownloadPercent: 0,
    /** 是否正在下载视频 */
    jobDownloading: false,
  },
  pollTimer: null,
  pollRunId: 0,
  pendingMediaAction: null,
  /** 录音文件识别可能较慢，约 15 分钟内保持轮询（间隔 1s） */
  maxPollCount: 1000,

  onLoad() {
    const sys = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
    });
    this.loadRecentJobs();
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.loadRecentJobs();
  },

  showCloudErrorModal(title, err, fallback, extraNote = "") {
    const base = buildCloudErrorText(err, fallback);
    wx.showModal({
      title,
      content: extraNote ? `${base}${extraNote}` : base,
      showCancel: false,
    });
  },

  /**
   * 调用相册/相机前检查隐私协议（基础库 ≥2.32.3）
   * 未同意时弹出带「同意」按钮的遮罩，避免直接 chooseMedia 失败
   */
  runWithPrivacy(fn) {
    if (typeof wx.getPrivacySetting !== "function") {
      fn();
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        if (res.needAuthorization) {
          this.pendingMediaAction = fn;
          this.setData({
            showPrivacyGate: true,
            privacyContractName: res.privacyContractName || "《用户隐私保护指引》",
          });
          return;
        }
        fn();
      },
      fail: () => fn(),
    });
  },

  onOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract === "function") {
      wx.openPrivacyContract({});
    }
  },

  onPrivacyAgreeContinue() {
    this.setData({ showPrivacyGate: false });
    const run = this.pendingMediaAction;
    this.pendingMediaAction = null;
    if (typeof run === "function") run();
  },

  onPrivacyGateCancel() {
    this.setData({ showPrivacyGate: false });
    this.pendingMediaAction = null;
  },

  noopPrivacyBox() {},

  /** 真机选视频：区分隐私未声明(112)、未同意(103/104)、系统权限等 */
  onChooseMediaFail(err) {
    const msg = (err && err.errMsg) || "";
    const errno = err && err.errno;
    if (/cancel/i.test(msg)) return;

    if (
      errno === 112 ||
      /scope is not declared|privacy agreement|未在.*隐私/i.test(msg)
    ) {
      wx.showModal({
        title: "暂无法使用相册",
        content: "请稍后再试。若多次出现，请联系小程序客服。",
        showCancel: false,
      });
      return;
    }
    if (
      errno === 103 ||
      errno === 104 ||
      /privacy|未同意|不同意|拒绝.*隐私/i.test(msg)
    ) {
      wx.showModal({
        title: "需同意隐私协议",
        content:
          "请按微信弹窗同意隐私协议后再使用相册或相机。若刚点过拒绝，可稍等 10 秒后重试，或删除小程序后重新进入。",
        showCancel: false,
      });
      return;
    }
    if (/auth deny|authorize|permission|系统.*拒绝|denied/i.test(msg)) {
      wx.showModal({
        title: "需要系统权限",
        content:
          "请在手机系统设置中允许「微信」使用相册、相机或存储权限后重试。",
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: "无法打开相册或相机",
      content: "请稍后再试，或检查系统是否已授权微信使用相册与相机。",
      showCancel: false,
    });
  },

  loadRecentJobs() {
    if (!ensureCloudEnv()) return;
    this.setData({
      recentLoading: true,
      recentError: "",
    });
    wx.cloud
      .callFunction({
        name: CLOUD_FUNCTION_NAME,
        data: { type: "getRecentVideoJobs" },
      })
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        if (!result.success) {
          this.setData({
            recentJobs: [],
            recentLoading: false,
            recentError: buildCloudErrorText(
              { message: result.errMsg },
              "加载失败"
            ),
          });
          return;
        }
        const rows = (result && result.data) || [];
        const recentJobs = rows.map((item) => ({
          id: item._id,
          actionName: getActionName(item.videoAction),
          statusText: getJobStatusLabel(item.status),
          linkPreview: String(item.videoLink || "").slice(0, 28),
        }));
        this.setData({
          recentJobs,
          recentLoading: false,
          recentError: "",
        });
      })
      .catch((err) => {
        this.setData({
          recentJobs: [],
          recentLoading: false,
          recentError: buildCloudErrorText(err, "加载失败"),
        });
      });
  },

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollRunId = (this.pollRunId || 0) + 1;
    this.setData(this.mergeJobProgress({ isPolling: false }));
  },

  /** 无服务端真实进度时，用轮询次数 + 文案状态估算 0–100 */
  calcJobProgressPercent(statusText, polling, count) {
    const c = Math.max(0, Number(count) || 0);
    const s = String(statusText || "");
    if (s === "失败") return 0;
    if (s === "已完成") return 100;
    if (s === "提交中...") return 12;
    if (polling) {
      if (s.indexOf("解析") !== -1) {
        return Math.min(93, Math.round(34 + c * 2.2));
      }
      if (s.indexOf("排队") !== -1) {
        return Math.min(46, Math.round(18 + c * 2.6));
      }
      if (s === "处理中") {
        return Math.min(34, Math.round(12 + c * 3.5));
      }
      return Math.min(88, Math.round(22 + c * 2));
    }
    if (
      s.indexOf("解析") !== -1 ||
      s.indexOf("排队") !== -1 ||
      s === "处理中"
    ) {
      return Math.min(90, Math.round(28 + c * 2));
    }
    return s ? 100 : 0;
  },

  mergeJobProgress(patch) {
    const jobStatusText =
      patch.jobStatusText !== undefined
        ? patch.jobStatusText
        : this.data.jobStatusText;
    const isPolling =
      patch.isPolling !== undefined ? patch.isPolling : this.data.isPolling;
    const pollCount =
      patch.pollCount !== undefined ? patch.pollCount : this.data.pollCount;
    return {
      ...patch,
      jobProgressPercent: this.calcJobProgressPercent(
        jobStatusText,
        isPolling,
        pollCount
      ),
    };
  },

  applyJobVideoResult(r) {
    const fileID = (r && r.fileID) || "";
    const rawUrl = (r && r.videoUrl) || "";
    const videoAction = (r && r.videoAction) || "";
    const platform = (r && r.platform) || "";
    const uploadSkipReason = (r && r.uploadSkipReason) || "";
    const sizeBytes = (r && r.sizeBytes) || 0;
    const clientPayload = (r && r.clientPayload) || {};
    const ext = clientPayload.originalExt || clientPayload.ext || "";
    const copyUrlButtonLabel =
      videoAction === "watermark_remove" ||
      videoAction === "video_channel_extract"
        ? "复制无水印直链"
        : "复制预览链接";

    const isAudio = /\.(mp3|m4a|aac|wav)$/i.test(String(ext));

    this.setData({
      jobVideoUrl: "",
      jobVideoPlaying: false,
      jobAudioUrl: "",
      jobRawVideoUrl: rawUrl,
      jobCloudFileId: fileID,
      copyUrlButtonLabel,
    });

    if (isAudio) {
      if (fileID) {
        wx.cloud.getTempFileURL({
          fileList: [fileID],
          success: (res) => {
            const u = (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) || "";
            if (u) this.setData({ jobVideoUrl: "", jobAudioUrl: u });
          },
        });
      }
      return;
    }

    // B站/视频号等平台：原始直链有防盗链，前端无法直接播放/下载，必须走云存储转存。
    // 若云存储转存失败，不要回退到原始直链（注定失败），给用户明确引导。
    const platformRequiresCloudUpload = platform === "bilibili" || platform === "weixin_channels";
    if (!fileID && platformRequiresCloudUpload) {
      const msgs = {
        bilibili: "B站视频需经云存储转存后才能保存，当前转存失败。请点击「复制无水印直链」，在手机浏览器中打开下载。",
        weixin_channels: "视频号暂不支持直接下载，请用「本地视频」从相册上传已保存的文件。",
      };
      const title = platform === "bilibili" ? "B站视频转存未成功" : "暂不支持";
      wx.showModal({
        title,
        content: msgs[platform] || "该平台需云存储转存，当前不可用。请复制直链在浏览器中打开。",
        showCancel: false,
      });
      return;
    }

    // 后台下载到本地并持久化，供「保存到相册」复用，避免二次下载
    const downloadInBackground = (url, label) => {
      if (!url || typeof url !== "string") return;
      const pending = { done: false, path: null, error: null, cbs: [] };
      this._bgSavePending = pending;
      this.setData({ jobDownloadPercent: 0, jobDownloading: true });
      const task = wx.downloadFile({
        url,
        timeout: 180000,
        success: (res) => {
          if (res.statusCode === 200 && res.tempFilePath) {
            wx.getFileSystemManager().saveFile({
              tempFilePath: res.tempFilePath,
              success: (saveRes) => {
                this.setData({ jobVideoUrl: saveRes.savedFilePath, jobDownloading: false });
                pending.done = true;
                pending.path = saveRes.savedFilePath;
                pending.cbs.forEach((fn) => fn(saveRes.savedFilePath));
                pending.cbs = [];
              },
              fail: () => {
                this.setData({ jobVideoUrl: res.tempFilePath, jobDownloading: false });
                pending.done = true;
                pending.path = res.tempFilePath;
                pending.cbs.forEach((fn) => fn(res.tempFilePath));
                pending.cbs = [];
              },
            });
          } else {
            this.setData({ jobDownloading: false });
            pending.done = true;
            pending.cbs.forEach((fn) => fn(null));
            pending.cbs = [];
          }
        },
        fail: (err) => {
          const errMsg = (err && err.errMsg) || "";
          this.setData({ jobDownloading: false });
          pending.done = true;
          pending.error = err;
          pending.cbs.forEach((fn) => fn(null));
          pending.cbs = [];
          if (errMsg.includes("url not in domain list") || errMsg.includes("not in")) {
            console.warn("[preview] download domain blocked:", label);
          }
        },
      });
      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((res) => {
          if (res && typeof res.progress === "number") {
            this.setData({ jobDownloadPercent: res.progress });
          }
        });
      }
    };

    // 立即用远程链接播放，同时后台下载到本地
    const showAndDownload = (url, label) => {
      if (!url || typeof url !== "string") return;
      this.setData({ jobVideoUrl: url, jobVideoPlaying: false });
      downloadInBackground(url, label);
    };

    if (fileID) {
      wx.cloud.getTempFileURL({
        fileList: [fileID],
        success: (res) => {
          const tempUrl = (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) || "";
          if (tempUrl) {
            showAndDownload(tempUrl, "cloud");
          } else if (rawUrl && !platformRequiresCloudUpload) {
            showAndDownload(rawUrl, "raw");
          }
        },
        fail: () => {
          if (rawUrl && !platformRequiresCloudUpload) showAndDownload(rawUrl, "raw");
        },
      });
      return;
    }

    if (rawUrl && !platformRequiresCloudUpload) {
      showAndDownload(rawUrl, "raw");
    }
  },

  onCopyVideoUrl() {
    const u = this.data.jobRawVideoUrl;
    if (!u) {
      wx.showToast({ title: "暂无直链", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: u,
      success: () => wx.showToast({ title: "直链已复制", icon: "success" }),
    });
  },

  /** 解析完成后的「保存到相册」：优先用已缓存的本地路径，否则从预览 URL / 直链下载后再存 */
  isLikelyLocalTempPath(p) {
    if (!p || typeof p !== "string") return false;
    return (
      p.indexOf("wxfile://") === 0 ||
      p.indexOf("http://tmp") === 0 ||
      p.indexOf("http://usr/") === 0 ||
      p.indexOf("file://") === 0
    );
  },

  onSaveVideoToAlbum() {
    if (this.data.jobAudioUrl && !this.data.jobRawVideoUrl) {
      wx.showToast({ title: "当前为音频，请用系统录屏或复制链接", icon: "none" });
      return;
    }

    const local = this.data.jobVideoUrl;
    const raw = this.data.jobRawVideoUrl;

    const savePath = (filePath) => {
      wx.saveVideoToPhotosAlbum({
        filePath,
        success: () =>
          wx.showToast({ title: "已保存到相册", icon: "success" }),
        fail: (err) => {
          const msg = (err && err.errMsg) || "";
          if (
            msg.indexOf("auth deny") >= 0 ||
            msg.indexOf("authorize") >= 0 ||
            msg.indexOf("permission") >= 0
          ) {
            wx.showModal({
              title: "需要相册权限",
              content: "保存视频需要授权访问相册，请在设置中开启。",
              confirmText: "去设置",
              success: (r) => {
                if (r.confirm) wx.openSetting();
              },
            });
          } else {
            wx.showToast({
              title: buildCloudErrorText(err, "保存失败").slice(0, 40),
              icon: "none",
            });
          }
        },
      });
    };

    const downloadThenSave = (url) => {
      if (!url || typeof url !== "string") {
        wx.showToast({ title: "暂无可下载地址", icon: "none" });
        return;
      }
      this.setData({ jobDownloadPercent: 0, jobDownloading: true });
      const task = wx.downloadFile({
        url,
        timeout: 120000,
        success: (res) => {
          if (res.statusCode === 200 && res.tempFilePath) {
            wx.getFileSystemManager().saveFile({
              tempFilePath: res.tempFilePath,
              success: (saveRes) => {
                this.setData({ jobDownloading: false });
                savePath(saveRes.savedFilePath);
              },
              fail: () => {
                this.setData({ jobDownloading: false });
                savePath(res.tempFilePath);
              },
            });
          } else {
            this.setData({ jobDownloading: false });
            wx.showToast({ title: "下载失败", icon: "none" });
          }
        },
        fail: () => {
          this.setData({ jobDownloading: false });
          wx.showToast({ title: "下载失败，可试复制直链", icon: "none" });
        },
      });
      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((res) => {
          if (res && typeof res.progress === "number") {
            this.setData({ jobDownloadPercent: res.progress });
          }
        });
      }
    };

    // 已有本地持久化路径 → 直接保存
    if (local && this.isLikelyLocalTempPath(local)) {
      savePath(local);
      return;
    }

    // 后台下载正在进行中 → 等待完成，避免重复下载抢带宽（进度条已由后台下载显示）
    const pending = this._bgSavePending;
    if (pending && !pending.done) {
      wx.showToast({ title: "下载完成后自动保存", icon: "none" });
      pending.cbs.push((savedPath) => {
        if (savedPath) {
          savePath(savedPath);
        } else if (raw) {
          downloadThenSave(raw);
        } else {
          wx.showToast({ title: "下载失败，可试复制直链", icon: "none" });
        }
      });
      return;
    }

    // 后台下载已完成但 jobVideoUrl 还是远程链接（downloadInBackground 失败且静默了）
    if (local && /^https?:\/\//i.test(local)) {
      downloadThenSave(local);
      return;
    }
    if (raw) {
      downloadThenSave(raw);
      return;
    }
    wx.showToast({ title: "请先完成解析并出现预览", icon: "none" });
  },

  startPolling(jobId) {
    this.stopPolling();
    let count = 0;
    this.setData(this.mergeJobProgress({ isPolling: true, pollCount: 0 }));
    const runId = (this.pollRunId || 0) + 1;
    this.pollRunId = runId;

    const scheduleNext = (delayMs) => {
      if (this.pollRunId !== runId) return;
      this.pollTimer = setTimeout(() => pollOnce(), delayMs);
    };

    const pollOnce = () => {
      if (this.pollRunId !== runId) return;
      count += 1;
      this.setData(this.mergeJobProgress({ pollCount: count }));

      const doCall = (retryAttempt) => {
        wx.cloud
          .callFunction({
            name: CLOUD_FUNCTION_NAME,
            data: {
              type: "getVideoJobStatus",
              jobId,
            },
            timeout: 120000,
          })
          .then((resp) => {
            if (this.pollRunId !== runId) return;
            const result = resp && resp.result ? resp.result : {};
            if (!result.success) {
              if (retryAttempt < 2) {
                setTimeout(() => doCall(retryAttempt + 1), 900 * (retryAttempt + 1));
                return;
              }
              this.showCloudErrorModal(
                "查询失败",
                { message: String(result.errMsg != null ? result.errMsg : "") },
                "查询失败",
                PARSE_RETRY_TIP
              );
              this.stopPolling();
              return;
            }
            const job = result.data || {};
            const status = job.status || "";
            const r = job.result || {};

            if (status === "failed") {
              const rawErr =
                (r && (r.error || r.errMsg || r.message)) || "";
              const errText = buildCloudErrorText(
                { message: String(rawErr) },
                "解析未成功，请稍后再试"
              );
              this.setData(
                this.mergeJobProgress({
                  jobStatusText: "失败",
                  jobResultMessage: errText,
                  jobVideoUrl: "",
                  jobVideoPlaying: false,
                  jobAudioUrl: "",
                  jobVideoTitle: "",
                  jobRawVideoUrl: "",
                  copyUrlButtonLabel: "复制无水印直链",
                  jobCloudFileId: "",
                  jobTranscript: "",
                })
              );
              this.stopPolling();
              wx.showModal({
                title: "任务失败",
                content: `${errText}${PARSE_RETRY_TIP}`,
                showCancel: false,
              });
              this.loadRecentJobs();
              return;
            }

            if (status === "completed") {
              const message = r.message || "提取成功";
              this.setData(
                this.mergeJobProgress({
                  jobStatusText: "已完成",
                  jobResultMessage: message,
                  jobVideoTitle: r.title || "",
                  jobTranscript: r.transcriptText
                    ? String(r.transcriptText)
                    : "",
                })
              );
              this.applyJobVideoResult({ ...r, clientPayload: r.clientPayload || {} });
              this.stopPolling();
              wx.showToast({ title: "任务完成", icon: "success" });
              this.loadRecentJobs();
              return;
            }

            if (status === "processing") {
              this.setData(
                this.mergeJobProgress({
                  jobStatusText: "解析中（请稍候）",
                })
              );
            } else {
              this.setData(
                this.mergeJobProgress({
                  jobStatusText: "排队中",
                })
              );
            }

            if (count >= this.maxPollCount) {
              this.stopPolling();
              wx.showToast({
                title: "等待较久：可点「刷新状态」，或多试几次一键提取",
                icon: "none",
              });
              return;
            }
            // 递增轮询间隔：前3次 1s，4-10次 2s，11-20次 3s，之后 5s
            // 短任务快速响应，长任务减少无谓云函数调用
            const nextDelay =
              count <= 3 ? 1000 : count <= 10 ? 2000 : count <= 20 ? 3000 : 5000;
            scheduleNext(nextDelay);
          })
          .catch((err) => {
            if (this.pollRunId !== runId) return;
            if (retryAttempt < 2) {
              setTimeout(() => doCall(retryAttempt + 1), 900 * (retryAttempt + 1));
              return;
            }
            this.stopPolling();
            this.showCloudErrorModal(
              "轮询失败",
              err,
              "轮询失败",
              PARSE_RETRY_TIP
            );
          });
      };

      doCall(0);
    };

    pollOnce();
  },

  startVideoJob(videoAction, options) {
    options = options || {};
    const fromUpload = !!options.videoLink;
    const videoLink = fromUpload
      ? options.videoLink
      : this.data.videoLink;
    if (!videoLink || !String(videoLink).trim()) {
      wx.showToast({
        title: fromUpload ? "缺少云文件" : "请先粘贴视频链接",
        icon: "none",
      });
      return;
    }
    if (!ensureCloudEnv()) return;

    const clientPayload =
      options.clientPayload && typeof options.clientPayload === "object"
        ? options.clientPayload
        : {};

    const submitAfterAd = () => {
      this.stopPolling();
      this._bgSavePending = null;
      this.setData(
        this.mergeJobProgress({
          jobId: "",
          jobIdShort: "",
          jobStatusText: "提交中...",
          jobResultMessage: "",
          jobActionName: getActionName(videoAction),
          lastVideoAction: videoAction,
          pollCount: 0,
          jobVideoUrl: "",
          jobVideoPlaying: false,
          jobAudioUrl: "",
          jobVideoTitle: "",
          jobRawVideoUrl: "",
          copyUrlButtonLabel: "复制无水印直链",
          jobCloudFileId: "",
          jobTranscript: "",
          jobDownloadPercent: 0,
          jobDownloading: false,
        })
      );

      wx.showLoading({ title: fromUpload ? "提交任务" : "提交中" });
      wx.cloud
        .callFunction({
          name: CLOUD_FUNCTION_NAME,
          data: {
            type: "requestVideoJob",
            videoAction,
            videoLink,
            clientPayload,
          },
          timeout: 60000,
        })
        .then((resp) => {
          const result = resp && resp.result ? resp.result : {};
          if (!result.success) {
            wx.hideLoading();
            wx.showModal({
              title: "失败",
              content: `${buildCloudErrorText(
                { message: result.errMsg },
                "任务提交失败"
              )}${PARSE_RETRY_TIP}`,
            });
            return;
          }
          const data = result.data || {};
          const jobId = data.jobId || "";
          const jobIdShort =
            typeof jobId === "string" && jobId.length > 10
              ? `${jobId.slice(0, 8)}...`
              : jobId;

          this.setData(
            this.mergeJobProgress({
              jobId,
              jobIdShort,
              jobStatusText: "处理中",
              jobActionName: getActionName(videoAction),
            })
          );
          wx.hideLoading();
          wx.showToast({
            title: fromUpload ? "已开始处理" : "已开始解析",
            icon: "none",
          });
          this.startPolling(jobId);
          this.loadRecentJobs();
        })
        .catch((err) => {
          wx.hideLoading();
          this.showCloudErrorModal(
            "失败",
            err,
            "任务提交失败",
            PARSE_RETRY_TIP
          );
        });
    };

    rewardAdGate
      .runAfterRewardedAd({ scene: videoAction })
      .then(() => submitAfterAd())
      .catch((err) => {
        const code = err && err.code;
        if (code === "SKIPPED") {
          wx.showToast({ title: "请完整观看广告后继续", icon: "none" });
          return;
        }
        if (code === "USER_CANCEL") {
          wx.showToast({ title: "已取消", icon: "none" });
          return;
        }
        if (code === "POINTS_FAIL") {
          return;
        }
        if (code === "GATE_TIMEOUT") {
          wx.showToast({
            title: (err && err.message) || "网络超时，请稍后重试",
            icon: "none",
          });
          return;
        }
        wx.showToast({
          title: "广告暂时无法播放，请稍后重试",
          icon: "none",
        });
      });
  },


  onRefreshJobStatus() {
    const { jobId } = this.data;
    if (!jobId) {
      wx.showToast({ title: "暂无任务", icon: "none" });
      return;
    }
    this.startPolling(jobId);
  },

  onRetryLastAction() {
    const { lastVideoAction } = this.data;
    if (!lastVideoAction) {
      wx.showToast({ title: "暂无可重试任务", icon: "none" });
      return;
    }
    if (UPLOAD_TOOL_ACTIONS.indexOf(lastVideoAction) !== -1) {
      wx.showToast({
        title: "请从下方工具重新选择文件",
        icon: "none",
      });
      return;
    }
    this.startVideoJob(lastVideoAction);
  },

  onCopyCloudFileId() {
    const id = this.data.jobCloudFileId;
    if (!id) {
      wx.showToast({ title: "暂无云文件", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: id,
      success: () => wx.showToast({ title: "已复制", icon: "success" }),
    });
  },

  uploadAndRequestJob(
    videoAction,
    tempFilePath,
    originalExt,
    fileSize,
    extraClientPayload
  ) {
    if (!ensureCloudEnv()) return;
    const ext =
      originalExt && String(originalExt).startsWith(".")
        ? String(originalExt)
        : ".mp4";
    const extra =
      extraClientPayload && typeof extraClientPayload === "object"
        ? extraClientPayload
        : {};
    const maxBytes = 50 * 1024 * 1024;
    if (typeof fileSize === "number" && fileSize > maxBytes) {
      wx.showModal({
        title: "文件过大",
        content: "请选择 50MB 以内的文件",
        showCancel: false,
      });
      return;
    }
    wx.showLoading({ title: "上传中" });
    const cloudPath = `uploads/${videoAction}/${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}${ext}`;
    wx.cloud
      .uploadFile({
        cloudPath,
        filePath: tempFilePath,
      })
      .then((up) => {
        wx.hideLoading();
        this.startVideoJob(videoAction, {
          videoLink: up.fileID,
          clientPayload: { originalExt: ext, ...extra },
        });
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: "上传失败", icon: "none" });
      });
  },

  onCopyJobId() {
    const { jobId } = this.data;
    if (!jobId) {
      wx.showToast({ title: "暂无任务ID", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: jobId,
      success: () => wx.showToast({ title: "任务ID已复制", icon: "success" }),
    });
  },

  onPickHistoryJob(e) {
    const jobId = e.currentTarget.dataset.id;
    if (!jobId) {
      wx.showToast({ title: "任务不存在", icon: "none" });
      return;
    }
    const jobIdShort =
      typeof jobId === "string" && jobId.length > 10
        ? `${jobId.slice(0, 8)}...`
        : jobId;
    this._bgSavePending = null;
    this.setData(
      this.mergeJobProgress({
        jobId,
        jobIdShort,
        jobStatusText: "处理中",
        jobResultMessage: "",
        pollCount: 0,
        jobVideoUrl: "",
        jobVideoPlaying: false,
        jobAudioUrl: "",
        jobVideoTitle: "",
        jobRawVideoUrl: "",
        copyUrlButtonLabel: "复制无水印直链",
        jobCloudFileId: "",
        jobTranscript: "",
        jobDownloadPercent: 0,
        jobDownloading: false,
      })
    );
    this.startPolling(jobId);
  },

  onJobVideoPlay() {
    this.setData({ jobVideoPlaying: true });
  },

  onJobVideoPause() {
    this.setData({ jobVideoPlaying: false });
  },

  onJobVideoEnded() {
    this.setData({ jobVideoPlaying: false });
  },

  onJobVideoPlayTap() {
    const ctx = wx.createVideoContext("jobPreviewVideo", this);
    if (ctx && typeof ctx.play === "function") {
      ctx.play();
    }
  },

  onCopyTranscript() {
    const t = this.data.jobTranscript;
    if (!t || !String(t).trim()) {
      wx.showToast({ title: "暂无可复制文案", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: String(t),
      success: () => wx.showToast({ title: "已复制全文", icon: "success" }),
    });
  },

  onRefreshRecentJobs() {
    this.loadRecentJobs();
  },

  onGoHistory() {
    if (!ensureCloudEnv()) return;
    wx.navigateTo({ url: "/pages/history/history?tab=jobs" });
  },

  onLinkInput(e) {
    this.setData({ videoLink: e.detail.value });
  },

  onClearLink() {
    this.setData({ videoLink: "" });
  },

  onDeleteHistoryJob(e) {
    const jobId = e.currentTarget.dataset.id;
    if (!jobId) return;
    if (!ensureCloudEnv()) return;
    wx.showModal({
      title: "删除记录",
      content: "确定删除这条任务记录吗？",
      confirmColor: "#c45c5c",
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中" });
        wx.cloud
          .callFunction({
            name: CLOUD_FUNCTION_NAME,
            data: { type: "deleteVideoJob", jobId },
          })
          .then((resp) => {
            wx.hideLoading();
            const result = resp && resp.result ? resp.result : {};
            if (result.success) {
              wx.showToast({ title: "已删除", icon: "success" });
              this.loadRecentJobs();
            } else {
              wx.showToast({ title: result.errMsg || "删除失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },

  onPasteLink() {
    wx.getClipboardData({
      success: (res) => {
        if (res.data) {
          this.setData({ videoLink: res.data });
          wx.showToast({ title: "已粘贴", icon: "success" });
        }
      },
    });
  },

  onExtract() {
    this.startVideoJob("watermark_remove");
  },

  onVideoChannelHelp() {
    wx.navigateTo({ url: "/pages/guide/guide" });
  },

  onToolLocal() {
    wx.showModal({
      title: "本地上传说明",
      content:
        "本入口只会把视频上传到云端供预览与保存，不会在画面里自动擦掉水印、字幕或角标。\n\n若要去掉抖音、快手、视频号等「平台水印」，请回首页粘贴分享链接，使用「一键提取视频」。",
      confirmText: "继续选视频",
      cancelText: "取消",
      success: (r) => {
        if (!r.confirm) return;
        this.runWithPrivacy(() => {
          wx.chooseMedia({
            count: 1,
            mediaType: ["video"],
            sourceType: ["album", "camera"],
            maxDuration: CHOOSE_MEDIA_MAX_DURATION,
            success: (res) => {
              const f = res.tempFiles && res.tempFiles[0];
              if (!f) return;
              const ext = inferVideoExtFromTempPath(f.tempFilePath);
              this.uploadAndRequestJob(
                "local_video_watermark_remove",
                f.tempFilePath,
                ext,
                f.size
              );
            },
            fail: (err) => this.onChooseMediaFail(err),
          });
        });
      },
    });
  },

  onToolChannel() {
    this.startVideoJob("video_channel_extract");
  },

  /** 聊天记录里「视频消息」须用 chooseMessageFile type: video；type: file 只能选文件/音频，选不到视频消息 */
  onToolTranscribe() {
    wx.showActionSheet({
      itemList: ["从聊天记录选视频", "从聊天记录选文件或音频", "从相册或拍摄"],
      success: (sheet) => {
        const i = sheet.tapIndex;
        if (i === 0) {
          wx.chooseMessageFile({
            count: 1,
            type: "video",
            success: (res) => this.applyTranscribeFromChat(res),
            fail: (err) => this.onTranscribeChatPickerFail(err),
          });
        } else if (i === 1) {
          wx.chooseMessageFile({
            count: 1,
            type: "file",
            success: (res) => this.applyTranscribeFromChat(res),
            fail: (err) => this.onTranscribeChatPickerFail(err),
          });
        } else {
          this.runWithPrivacy(() => {
            wx.chooseMedia({
              count: 1,
              mediaType: ["video"],
              sourceType: ["album", "camera"],
              maxDuration: CHOOSE_MEDIA_MAX_DURATION,
              success: (res) => {
                const f = res.tempFiles && res.tempFiles[0];
                if (!f) return;
                this.uploadAndRequestJob("transcribe", f.tempFilePath, ".mp4", f.size);
              },
              fail: (err) => this.onChooseMediaFail(err),
            });
          });
        }
      },
      fail: (err) => {
        const m = (err && err.errMsg) || "";
        if (/cancel/i.test(m)) return;
      },
    });
  },

  applyTranscribeFromChat(res) {
    const f = res.tempFiles && res.tempFiles[0];
    if (!f) return;
    const name = f.name || "";
    const m = name.match(/(\.[a-zA-Z0-9]+)$/);
    const ext = m ? m[1] : ".mp4";
    this.uploadAndRequestJob("transcribe", f.path, ext, f.size);
  },

  onTranscribeChatPickerFail(err) {
    const msg = (err && err.errMsg) || "";
    if (msg.indexOf("cancel") >= 0) return;
    this.runWithPrivacy(() => {
      wx.chooseMedia({
        count: 1,
        mediaType: ["video"],
        sourceType: ["album", "camera"],
        maxDuration: CHOOSE_MEDIA_MAX_DURATION,
        success: (res) => {
          const f = res.tempFiles && res.tempFiles[0];
          if (!f) return;
          this.uploadAndRequestJob("transcribe", f.tempFilePath, ".mp4", f.size);
        },
        fail: (e) => this.onChooseMediaFail(e),
      });
    });
  },

  formatCompressDuration(sec) {
    const n = Number(sec);
    if (!n || n <= 0) return "未知时长";
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  },

  formatCompressSize(bytes) {
    const b = Number(bytes);
    if (b == null || Number.isNaN(b) || b < 0) return "—";
    if (b < 1024) return `${b}B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / 1048576).toFixed(2)}MB`;
  },

  /** 选视频后：读时长/体积，长视频先提示再选档位 */
  prepareCompressAfterPick(f) {
    wx.getVideoInfo({
      src: f.tempFilePath,
      success: (vi) => {
        const dur = typeof vi.duration === "number" ? vi.duration : 0;
        const isLong =
          dur > COMPRESS_LONG_DURATION_SEC || f.size > COMPRESS_LONG_SIZE_BYTES;
        if (isLong) {
          wx.showModal({
            title: "长视频提示",
            content: `约 ${this.formatCompressDuration(
              dur
            )}，约 ${this.formatCompressSize(
              f.size
            )}。\n\n长视频本机压缩耗时长、上传慢，微信压缩对超长素材体积下降也可能有限。建议优先「长视频省流」或「省流」档位；仍过大可先用系统相册剪辑再压缩。`,
            confirmText: "选择档位",
            cancelText: "一键省流",
            success: (m) => {
              if (m.confirm) {
                this.runCompressFlow(f, { longVideo: true });
              } else {
                this.runCompressVideo({
                  mode: "advanced",
                  bitrate: COMPRESS_LONG_VIDEO_PRESET.bitrate,
                  fps: COMPRESS_LONG_VIDEO_PRESET.fps,
                  resolution: COMPRESS_LONG_VIDEO_PRESET.resolution,
                  compressAdvancedLabel: COMPRESS_LONG_VIDEO_PRESET.label,
                  compressLongVideo: true,
                  f,
                });
              }
            },
          });
          return;
        }
        this.runCompressFlow(f, { longVideo: false });
      },
      fail: () => {
        if (f.size > COMPRESS_LONG_SIZE_BYTES) {
          wx.showModal({
            title: "文件较大",
            content: `约 ${this.formatCompressSize(
              f.size
            )}，上传耗时较长。建议优先「省流」或「长视频省流」。`,
            confirmText: "选择档位",
            cancelText: "一键省流",
            success: (m) => {
              if (m.confirm) {
                this.runCompressFlow(f, { longVideo: true });
              } else {
                this.runCompressVideo({
                  mode: "advanced",
                  bitrate: COMPRESS_LONG_VIDEO_PRESET.bitrate,
                  fps: COMPRESS_LONG_VIDEO_PRESET.fps,
                  resolution: COMPRESS_LONG_VIDEO_PRESET.resolution,
                  compressAdvancedLabel: COMPRESS_LONG_VIDEO_PRESET.label,
                  compressLongVideo: true,
                  f,
                });
              }
            },
          });
          return;
        }
        this.runCompressFlow(f, { longVideo: false });
      },
    });
  },

  openAdvancedCompressSheet(f) {
    wx.showActionSheet({
      itemList: COMPRESS_PRESETS_ADVANCED.map((p) => p.label),
      success: (s2) => {
        const preset = COMPRESS_PRESETS_ADVANCED[s2.tapIndex];
        if (!preset) return;
        this.runCompressVideo({
          mode: "advanced",
          bitrate: preset.bitrate,
          fps: preset.fps,
          resolution: preset.resolution,
          compressAdvancedLabel: preset.label,
          f,
        });
      },
      fail: () => {},
    });
  },

  /** 质量档位或高级预设；longVideo 时首项为「长视频省流」 */
  runCompressFlow(f, options) {
    const longVideo = options && options.longVideo;
    const itemList = longVideo
      ? [
          "长视频省流（推荐）",
          "体积优先",
          "平衡",
          "清晰优先",
          "高级（码率/分辨率）",
        ]
      : ["体积优先", "平衡（推荐）", "清晰优先", "高级（码率/分辨率）"];
    wx.showActionSheet({
      itemList,
      success: (s) => {
        const idx = s.tapIndex;
        if (longVideo) {
          if (idx === 0) {
            this.runCompressVideo({
              mode: "advanced",
              bitrate: COMPRESS_LONG_VIDEO_PRESET.bitrate,
              fps: COMPRESS_LONG_VIDEO_PRESET.fps,
              resolution: COMPRESS_LONG_VIDEO_PRESET.resolution,
              compressAdvancedLabel: COMPRESS_LONG_VIDEO_PRESET.label,
              compressLongVideo: true,
              f,
            });
            return;
          }
          if (idx === 4) {
            this.openAdvancedCompressSheet(f);
            return;
          }
          const q = ["low", "medium", "high"][idx - 1];
          if (q) this.runCompressVideo({ mode: "quality", quality: q, f });
          return;
        }
        if (idx === 3) {
          this.openAdvancedCompressSheet(f);
          return;
        }
        const q = ["low", "medium", "high"][idx];
        if (q) this.runCompressVideo({ mode: "quality", quality: q, f });
      },
      fail: () => {},
    });
  },

  runCompressVideo(opts) {
    const f = opts.f;
    const originalSize = typeof f.size === "number" ? f.size : 0;
    if (typeof wx.compressVideo !== "function") {
      wx.showToast({ title: "当前环境不支持压缩，将上传原片", icon: "none" });
      this.uploadAndRequestJob("compress_video", f.tempFilePath, ".mp4", originalSize, {
        clientCompressed: false,
        compressMode: "none",
        originalSizeBytes: originalSize,
        compressedSizeBytes: originalSize,
      });
      return;
    }
    const loadingTitle =
      opts.compressLongVideo || f.size > COMPRESS_LONG_SIZE_BYTES
        ? "压缩中，长视频可能较久…"
        : "压缩中";
    wx.showLoading({ title: loadingTitle });
    const params = { src: f.tempFilePath };
    if (opts.mode === "quality") {
      params.quality = opts.quality;
    } else {
      params.bitrate = opts.bitrate;
      params.fps = opts.fps;
      params.resolution = opts.resolution;
    }
    wx.compressVideo({
      ...params,
      success: (cr) => {
        const outPath = (cr && cr.tempFilePath) || f.tempFilePath;
        let fromApi = null;
        if (cr && cr.size != null && String(cr.size) !== "") {
          const kb = parseFloat(String(cr.size));
          if (!Number.isNaN(kb)) fromApi = Math.round(kb * 1024);
        }
        wx.getFileSystemManager().getFileInfo({
          filePath: outPath,
          success: (fi) => {
            wx.hideLoading();
            const cBytes = fromApi != null ? fromApi : fi.size;
            this.finishCompressUpload(outPath, cBytes, originalSize, opts);
          },
          fail: () => {
            wx.hideLoading();
            const cBytes = fromApi != null ? fromApi : originalSize;
            this.finishCompressUpload(outPath, cBytes, originalSize, opts);
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({
          title: "本机压缩未完成，将上传原片",
          icon: "none",
        });
        this.uploadAndRequestJob("compress_video", f.tempFilePath, ".mp4", originalSize, {
          clientCompressed: false,
          compressMode: opts.mode || "",
          compressQuality: opts.quality || "",
          compressBitrate: opts.bitrate,
          compressFps: opts.fps,
          compressResolution: opts.resolution,
          compressAdvancedLabel: opts.compressAdvancedLabel || "",
          originalSizeBytes: originalSize,
          compressedSizeBytes: originalSize,
          compressFailed: true,
        });
      },
    });
  },

  finishCompressUpload(outPath, compressedBytes, originalSize, opts) {
    const payload = {
      clientCompressed: true,
      originalSizeBytes: originalSize,
      compressedSizeBytes: compressedBytes,
      compressMode: opts.mode,
    };
    if (opts.mode === "quality") {
      payload.compressQuality = opts.quality;
    } else {
      payload.compressBitrate = opts.bitrate;
      payload.compressFps = opts.fps;
      payload.compressResolution = opts.resolution;
      payload.compressAdvancedLabel = opts.compressAdvancedLabel || "";
    }
    if (opts.compressLongVideo) {
      payload.compressLongVideo = true;
    }
    if (originalSize > 0 && compressedBytes >= originalSize) {
      wx.showToast({
        title: "压缩后体积未明显减小，仍上传当前文件",
        icon: "none",
      });
    }
    this.uploadAndRequestJob("compress_video", outPath, ".mp4", compressedBytes, payload);
  },

  onToolCompress() {
    this.runWithPrivacy(() => {
      wx.chooseMedia({
        count: 1,
        mediaType: ["video"],
        sourceType: ["album", "camera"],
        maxDuration: CHOOSE_MEDIA_MAX_DURATION,
        success: (res) => {
          const f = res.tempFiles && res.tempFiles[0];
          if (!f) return;
          this.prepareCompressAfterPick(f);
        },
        fail: (err) => this.onChooseMediaFail(err),
      });
    });
  },

  onToolMd5() {
    this.runWithPrivacy(() => {
      wx.chooseMedia({
        count: 1,
        mediaType: ["video"],
        sourceType: ["album", "camera"],
        maxDuration: CHOOSE_MEDIA_MAX_DURATION,
        success: (res) => {
          const f = res.tempFiles && res.tempFiles[0];
          if (!f) return;
          this.uploadAndRequestJob("md5_modify", f.tempFilePath, ".mp4", f.size);
        },
        fail: (err) => this.onChooseMediaFail(err),
      });
    });
  },

  onUnload() {
    this.stopPolling();
  },
});
