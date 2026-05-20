/**
 * 解析 / 上传任务前的激励视频与积分策略
 *
 * - 配置 rewardVideoAdUnitId 后：可选「看广告 +50 积分」或「消耗 100 积分跳过」（需当日已签到、积分≥100、且当日尚未用过积分跳过）
 * - 完整观看广告后云函数 +50 积分；跳过扣 100 积分，每自然日仅 1 次积分跳过
 * - 未配置广告位：直接放行（开发联调）
 */

const { buildCloudErrorText } = require("./cloudErrorText");
const { CLOUD_FUNCTION_NAME } = require("./cloudUtils");

let cachedAd = null;
let cachedUnitId = "";

function getAdUnitId() {
  try {
    const app = getApp();
    const id = app && app.globalData && app.globalData.rewardVideoAdUnitId;
    return id ? String(id).trim() : "";
  } catch (e) {
    return "";
  }
}

function getOrCreateAd() {
  const unitId = getAdUnitId();
  if (!unitId || typeof wx.createRewardedVideoAd !== "function") {
    return null;
  }
  if (cachedAd && cachedUnitId === unitId) {
    return cachedAd;
  }
  cachedUnitId = unitId;
  cachedAd = wx.createRewardedVideoAd({ adUnitId: unitId });
  cachedAd.onError((err) => {
    console.error("[RewardedVideoAd] onError", err);
  });
  return cachedAd;
}

function fetchAdGateState() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({
        code: "GATE_TIMEOUT",
        message: "获取积分状态超时，请检查网络后重试",
      });
    }, 15000);

    wx.cloud.callFunction({
      name: CLOUD_FUNCTION_NAME,
      data: { type: "getUserProfile" },
      success(res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const r = (res && res.result) || {};
        if (!r.success) {
          reject(
            new Error(
              buildCloudErrorText({ message: r.errMsg }, "获取积分失败")
            )
          );
          return;
        }
        const d = r.data || {};
        resolve({
          points: Number(d.points) || 0,
          checkedInToday: !!d.checkedInToday,
          usedPointsSkipToday: !!d.usedPointsSkipToday,
          skipAdPointsCost: Number(d.skipAdPointsCost) || 100,
          rewardAdPoints: Number(d.rewardAdPoints) || 50,
        });
      },
      fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

function cloudGrantAdPoints() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_FUNCTION_NAME,
      data: { type: "grantRewardAdPoints" },
      success(res) {
        const r = (res && res.result) || {};
        if (r.success) {
          resolve(r.data || {});
        } else {
          wx.showToast({
            title: buildCloudErrorText(
              { message: r.errMsg },
              "积分未发放"
            ).slice(0, 40),
            icon: "none",
          });
          resolve({});
        }
      },
      fail: () => resolve({}),
    });
  });
}

function cloudSpendSkip() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_FUNCTION_NAME,
      data: { type: "spendPointsSkipAd" },
      success(res) {
        const r = (res && res.result) || {};
        if (r.success) {
          resolve(r.data || {});
        } else {
          reject(
            new Error(
              buildCloudErrorText({ message: r.errMsg }, "扣除积分失败")
            )
          );
        }
      },
      fail: reject,
    });
  });
}

/**
 * 播放激励视频，完整看完后发放积分并 resolve
 * @param {number} rewardPts
 */
function playRewardedVideoAndGrant(rewardPts) {
  return new Promise((resolve, reject) => {
    const ad = getOrCreateAd();
    if (!ad) {
      resolve({ mode: "none" });
      return;
    }

    const onClose = (res) => {
      try {
        ad.offClose(onClose);
      } catch (e) {}
      if (res && res.isEnded) {
        cloudGrantAdPoints().then((data) => {
          const add = (data && data.add) != null ? Number(data.add) : 0;
          if (add > 0) {
            wx.showToast({ title: `积分+${add}`, icon: "none" });
          }
          resolve({ mode: "ad" });
        });
      } else {
        reject({ code: "SKIPPED", message: "ad_not_finished" });
      }
    };

    ad.onClose(onClose);

    const cleanupAndReject = (err) => {
      try {
        ad.offClose(onClose);
      } catch (e) {}
      reject({
        code: "LOAD_FAIL",
        message: (err && err.errMsg) || "ad_load_failed",
      });
    };

    ad
      .show()
      .then(() => {})
      .catch(() => {
        ad.load()
          .then(() => ad.show().catch(cleanupAndReject))
          .catch(cleanupAndReject);
      });
  });
}

/**
 * @typedef {{ scene?: string }} RewardAdOptions
 * @param {RewardAdOptions} [options]
 * @returns {Promise<{ mode?: string, bypass?: boolean, scene?: string }>}
 */
function runAfterRewardedAd(options) {
  const scene = (options && options.scene) || "parse";
  return new Promise((resolve, reject) => {
    const ad = getOrCreateAd();
    if (!ad) {
      resolve({ bypass: true, scene });
      return;
    }

    fetchAdGateState()
      .then((state) => {
        const cost = state.skipAdPointsCost;
        const reward = state.rewardAdPoints;
        const pts = state.points;
        const canSkip =
          pts >= cost &&
          !state.usedPointsSkipToday &&
          state.checkedInToday;

        const itemWatch = state.checkedInToday
          ? `观看激励视频 +${reward}积分（当前${pts}）`
          : `观看激励视频 +${reward}积分（签到后可100积分跳过）`;

        const itemSkip = `消耗${cost}积分跳过广告（今日首次）`;

        const itemList = canSkip ? [itemWatch, itemSkip] : [itemWatch];

        wx.showActionSheet({
          itemList,
          success(sres) {
            if (sres.tapIndex === 0) {
              playRewardedVideoAndGrant(reward)
                .then((r) => resolve({ ...r, scene }))
                .catch(reject);
              return;
            }
            if (sres.tapIndex === 1 && canSkip) {
              cloudSpendSkip()
                .then(() => {
                  wx.showToast({
                    title: `已消耗${cost}积分`,
                    icon: "none",
                  });
                  resolve({ mode: "points", scene });
                })
                .catch((e) => {
                  const raw = e && e.message;
                  const tip = buildCloudErrorText(
                    { message: raw },
                    "积分操作未成功"
                  );
                  wx.showToast({
                    title: tip.slice(0, 40),
                    icon: "none",
                  });
                  reject({ code: "POINTS_FAIL", message: tip });
                });
              return;
            }
          },
          fail(err) {
            const msg = (err && err.errMsg) || "";
            if (msg.indexOf("cancel") >= 0) {
              reject({ code: "USER_CANCEL", scene });
              return;
            }
            reject({ code: "ACTION_SHEET_FAIL", scene, err });
          },
        });
      })
      .catch(reject);
  });
}

module.exports = {
  runAfterRewardedAd,
  getAdUnitId,
  fetchAdGateState,
};
