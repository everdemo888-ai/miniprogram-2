// pages/mine/mine.js
const { buildCloudErrorText } = require("../../utils/cloudErrorText");
const { ensureCloudEnv, callCloud } = require("../../utils/cloudUtils");

Page({
  data: {
    statusBarHeight: 20,
    nickname: "微信用户",
    userId: "—",
    points: 0,
    checkedInToday: false,
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
    });

    this.syncProfile();
  },

  onShow() {
    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.syncProfile();
  },

  onUnload() {},

  showCloudErrorModal(title, err, fallback) {
    wx.showModal({
      title,
      content: buildCloudErrorText(err, fallback),
      showCancel: false,
    });
  },

  syncProfile() {
    if (!ensureCloudEnv()) return;
    callCloud("getUserProfile")
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        if (!result.success || !result.data) {
          return;
        }
        const d = result.data;
        this.setData({
          userId: d.openidShort || d.openid || "—",
          points: Number(d.points) || 0,
          checkedInToday: !!d.checkedInToday,
        });
      })
      .catch(() => {});
  },

  onOrders() {
    if (!ensureCloudEnv()) return;
    wx.navigateTo({ url: "/pages/history/history?tab=jobs" });
  },

  onUsage() {
    if (!ensureCloudEnv()) return;
    wx.navigateTo({ url: "/pages/history/history?tab=usage" });
  },

  onCheckIn() {
    if (!ensureCloudEnv()) return;
    callCloud("checkIn", { points: 100 })
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        if (!result.success) {
          wx.showToast({
            title: buildCloudErrorText(
              { message: result.errMsg },
              "签到失败"
            ).slice(0, 40),
            icon: "none",
          });
          return;
        }
        const data = result.data || {};
        if (data.already) {
          wx.showToast({ title: "今天已签到", icon: "none" });
          this.syncProfile();
          return;
        }
        wx.showToast({
          title: `签到成功 +${data.points} 积分`,
          icon: "success",
        });
        this.syncProfile();
      })
      .catch((err) => this.showCloudErrorModal("签到失败", err, "签到失败"));
  },

  onFaq() {
    if (!ensureCloudEnv()) return;
    callCloud("getFaqList")
      .then((resp) => {
        const result = resp && resp.result ? resp.result : {};
        const list = (result && result.data) || [];
        const lines = [];
        for (let i = 0; i < list.length; i++) {
          const item = list[i] || {};
          lines.push(`${item.title}\n${item.content}`);
        }

        wx.showModal({
          title: "常见问题",
          content: lines.join("\n\n"),
          showCancel: false,
        });
      })
      .catch((err) => this.showCloudErrorModal("加载失败", err, "FAQ 获取失败"));
  },
});
