// pages/history/history.js
const { buildCloudErrorText } = require("../../utils/cloudErrorText");
const { ensureCloudEnv, CLOUD_FUNCTION_NAME } = require("../../utils/cloudUtils");
const { getActionName, getJobStatusLabel } = require("../../utils/jobLabels");

Page({
  data: {
    statusBarHeight: 20,
    activeTab: "jobs",
    jobsLoading: true,
    usageLoading: true,
    jobsList: [],
    usageList: [],
  },

  onLoad(options) {
    const sys = wx.getSystemInfoSync();
    const tab = options && options.tab === "usage" ? "usage" : "jobs";
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
      activeTab: tab,
    });
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: "/pages/mine/mine" });
    }
  },

  onTabChange(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
  },

  formatTime(val) {
    if (!val) return "";
    if (typeof val === "string") return val.slice(0, 16).replace("T", " ");
    if (typeof val === "object" && val !== null) {
      const sec = val._seconds != null ? val._seconds : val.seconds;
      if (typeof sec === "number") {
        val = new Date(sec * 1000);
      }
    }
    try {
      const d = val instanceof Date ? val : new Date(val);
      if (Number.isNaN(d.getTime())) return "";
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return `${y}-${m}-${day} ${h}:${min}`;
    } catch (err) {
      return "";
    }
  },

  loadAll() {
    if (!ensureCloudEnv()) {
      this.setData({ jobsLoading: false, usageLoading: false });
      return Promise.resolve();
    }
    return Promise.all([this.loadJobs(), this.loadUsage()]);
  },

  loadJobs() {
    this.setData({ jobsLoading: true });
    return wx.cloud
      .callFunction({
        name: CLOUD_FUNCTION_NAME,
        data: { type: "getRecentVideoJobs", limit: 50 },
      })
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        const rows = (result && result.data) || [];
        const jobsList = rows.map((item) => ({
          id: item._id,
          raw: item,
          actionName: getActionName(item.videoAction),
          status: item.status || "",
          statusText: getJobStatusLabel(item.status),
          linkPreview: String(item.videoLink || "").slice(0, 120),
          timeText: this.formatTime(item.createdAt),
        }));
        this.setData({ jobsList, jobsLoading: false });
      })
      .catch(() => {
        this.setData({ jobsList: [], jobsLoading: false });
        wx.showToast({ title: "任务列表加载失败", icon: "none" });
      });
  },

  loadUsage() {
    this.setData({ usageLoading: true });
    return wx.cloud
      .callFunction({
        name: CLOUD_FUNCTION_NAME,
        data: { type: "getUsageRecords" },
      })
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        const rows = (result && result.data) || [];
        const usageList = rows.map((item) => ({
          id: item._id,
          raw: item,
          actionName: getActionName(item.videoAction),
          platform: item.platform || "",
          title: item.title || "",
          linkPreview: String(item.videoLink || "").slice(0, 120),
          timeText: this.formatTime(item.createdAt),
        }));
        this.setData({ usageList, usageLoading: false });
      })
      .catch(() => {
        this.setData({ usageList: [], usageLoading: false });
        wx.showToast({ title: "使用记录加载失败", icon: "none" });
      });
  },

  onJobTap(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.jobsList[idx];
    if (!item || !item.raw) return;
    const job = item.raw;
    const link = job.videoLink || "";
    const r = job.result || {};
    const videoUrl = r.videoUrl || "";
    const transcriptText = r.transcriptText ? String(r.transcriptText) : "";
    const err = r.error || "";

    if (job.status === "completed" && job.videoAction === "transcribe" && transcriptText) {
      const items = ["复制识别文案"];
      if (link) items.push("复制云存储 fileID");
      wx.showActionSheet({
        itemList: items,
        success: (res) => {
          if (res.tapIndex === 0) {
            wx.setClipboardData({
              data: transcriptText,
              success: () =>
                wx.showToast({ title: "文案已复制", icon: "success" }),
            });
          } else if (res.tapIndex === 1 && link) {
            wx.setClipboardData({
              data: link,
              success: () =>
                wx.showToast({ title: "已复制", icon: "success" }),
            });
          }
        },
      });
      return;
    }

    if (job.status === "completed" && videoUrl) {
      wx.showActionSheet({
        itemList: ["复制无水印直链", "复制原始链接"],
        success: (res) => {
          if (res.tapIndex === 0) {
            wx.setClipboardData({
              data: videoUrl,
              success: () =>
                wx.showToast({ title: "直链已复制", icon: "success" }),
            });
          } else if (res.tapIndex === 1 && link) {
            wx.setClipboardData({
              data: link,
              success: () =>
                wx.showToast({ title: "链接已复制", icon: "success" }),
            });
          }
        },
      });
      return;
    }

    if (job.status === "failed" && err) {
      wx.showModal({
        title: "任务未成功",
        content: buildCloudErrorText(
          { message: String(err) },
          "请稍后再试，或返回首页重新提取"
        ),
        showCancel: false,
      });
      return;
    }

    if (link) {
      wx.setClipboardData({
        data: link,
        success: () => wx.showToast({ title: "原始链接已复制", icon: "success" }),
      });
    }
  },

  onUsageTap(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.usageList[idx];
    if (!item || !item.raw) return;
    const u = item.raw;
    const link = u.videoLink || "";
    if (!link) {
      wx.showToast({ title: "无链接", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: link,
      success: () => wx.showToast({ title: "链接已复制", icon: "success" }),
    });
  },
});
