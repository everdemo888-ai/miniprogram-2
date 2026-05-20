/**
 * 云开发公共工具：环境检查、云函数名称常量、callCloud 封装
 */
const { MISSING_CLOUD_ENV_TIP } = require("./cloudErrorText");

const CLOUD_FUNCTION_NAME = "quickstartFunctions";

const ensureCloudEnv = function () {
  const app = getApp();
  const env = app && app.globalData ? app.globalData.env : "";
  if (!env) {
    wx.showModal({
      title: "提示",
      content: MISSING_CLOUD_ENV_TIP,
      showCancel: false,
    });
    return false;
  }
  return true;
};

/** 统一的云函数调用封装，省去重复写 name 和 wx.cloud.callFunction */
const callCloud = function (type, payload = {}) {
  return wx.cloud.callFunction({
    name: CLOUD_FUNCTION_NAME,
    data: { type, ...payload },
  });
};

module.exports = {
  CLOUD_FUNCTION_NAME,
  ensureCloudEnv,
  callCloud,
};
