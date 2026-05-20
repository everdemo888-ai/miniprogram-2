/**
 * 上线防护：频控、广告奖励上限、安全日志（不打印完整用户链接）
 */

const { MSG, fmt } = require("../messages");

const COLLECTION_JOBS = "video_jobs";
const COLLECTION_USERS = "users";

const toDateKey = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const truncateLink = (s, max = 48) => {
  if (s == null || s === "") return "";
  const str = String(s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
};

const logInfo = (tag, extra = {}) => {
  try {
    const line = JSON.stringify({ tag, ts: Date.now(), ...extra });
    console.log(line);
  } catch (e) {
    console.log(tag, extra);
  }
};

/**
 * 单用户 24 小时内创建任务数上限（滚动窗口，防刷解析/上传）
 */
const assertUnderJobLimit = async (db, _, openid) => {
  const raw = process.env.MAX_VIDEO_JOBS_PER_USER_24H;
  const max = raw === undefined || raw === "" ? 120 : parseInt(String(raw), 10);
  if (!Number.isFinite(max) || max <= 0) return { ok: true };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cnt = await db
    .collection(COLLECTION_JOBS)
    .where({ openid, createdAt: _.gte(since) })
    .count();
  const total = (cnt && cnt.total) || 0;
  if (total >= max) {
    return {
      ok: false,
      errMsg: fmt(MSG.GUARD_RATE_LIMIT, max),
    };
  }
  return { ok: true };
};

/**
 * 激励视频积分：每日发放次数上限 + 与签到一致的日期维度
 */
const grantAdPointsWithDailyCap = async (db, _, openid, addPoints) => {
  const raw = process.env.MAX_AD_REWARD_GRANTS_PER_DAY;
  const max = raw === undefined || raw === "" ? 40 : parseInt(String(raw), 10);

  const userRes = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const user = userRes.data && userRes.data[0];
  if (!user) {
    return { ok: false, errMsg: MSG.GUARD_USER_NOT_FOUND };
  }

  const dk = toDateKey(new Date());
  const count = user.adRewardDateKey === dk ? Number(user.adRewardCount || 0) : 0;

  if (Number.isFinite(max) && max > 0 && count >= max) {
    return {
      ok: false,
      errMsg: fmt(MSG.GUARD_AD_DAILY_LIMIT, max),
    };
  }

  await db.collection(COLLECTION_USERS).where({ _id: user._id }).update({
    data: {
      points: _.inc(addPoints),
      adRewardDateKey: dk,
      adRewardCount: count + 1,
    },
  });

  const after = await db.collection(COLLECTION_USERS).where({ openid }).get();
  const u2 = after.data && after.data[0];
  const total = u2 ? Number(u2.points || 0) : 0;
  return { ok: true, data: { add: addPoints, total } };
};

module.exports = {
  COLLECTION_JOBS,
  COLLECTION_USERS,
  toDateKey,
  truncateLink,
  logInfo,
  assertUnderJobLimit,
  grantAdPointsWithDailyCap,
};
