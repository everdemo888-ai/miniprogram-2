/**
 * 云调用异常 → 用户可读文案（不展示路径、部署步骤、原始英文 errMsg）
 */
const MISSING_CLOUD_ENV_TIP =
  "当前无法连接服务，请稍后重试。若持续如此请联系客服。";

const buildCloudErrorText = (err, fallback = "请求失败") => {
  let raw = "";
  if (err && typeof err === "object") {
    const a = err.errMsg != null ? String(err.errMsg).trim() : "";
    const b = err.message != null ? String(err.message).trim() : "";
    raw = a || b;
  } else if (err != null && err !== "") {
    raw = String(err).trim();
  }
  const errMsg = raw || fallback;

  if (String(errMsg).includes("FunctionName parameter could not be found")) {
    return "服务暂未就绪，请稍后重试。";
  }
  if (String(errMsg).includes("Environment not found")) {
    return "服务暂不可用，请稍后重试。";
  }

  const s = String(errMsg);

  if (/[\u4e00-\u9fff]/.test(s) && s.length <= 200) {
    return s;
  }

  if (/timeout|超时/i.test(s)) return "请求超时，请稍后重试。";
  if (
    /network|ECONNRESET|ENOTFOUND|ETIMEDOUT|request:fail|downloadFile:fail|ssl|certificate/i.test(
      s
    )
  ) {
    return "网络异常，请稍后重试。";
  }

  return fallback;
};

module.exports = {
  MISSING_CLOUD_ENV_TIP,
  buildCloudErrorText,
};
