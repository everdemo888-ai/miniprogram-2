/**
 * 腾讯云 ASR — TC3 签名与通用 API 调用（录音文件识别 CreateRecTask / DescribeTaskStatus 等）
 * 环境变量：TENCENT_SECRET_ID、TENCENT_SECRET_KEY；可选 TENCENT_ASR_REGION（默认 ap-guangzhou）
 */
const crypto = require("crypto");
const axios = require("axios");
const { ASR } = require("../config");
const { MSG, fmt } = require("../messages");

const ASR_API_VERSION = "2019-06-14";

const tc3Sign = (secretId, secretKey, service, host, action, version, region, payloadStr) => {
  const timestamp = Math.floor(Date.now() / 1000);
  // Credential 内 Date 须为 UTC 的 YYYY-MM-DD（带横线），见 cloud.tencent.com/document/api/1093/35641
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedRequestPayload = crypto.createHash("sha256").update(payloadStr, "utf8").digest("hex");
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
  const algorithm = "TC3-HMAC-SHA256";
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const kDate = crypto.createHmac("sha256", `TC3${secretKey}`).update(date).digest();
  const kService = crypto.createHmac("sha256", kDate).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("tc3_request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    timestamp,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Region": region,
    },
  };
};

/**
 * 调用 asr.tencentcloudapi.com 任意 Action（JSON POST）
 * @param {string} action 如 CreateRecTask、DescribeTaskStatus
 * @param {object} body
 */
async function callAsrApi(action, body) {
  const secretId = String(process.env.TENCENT_SECRET_ID || "").trim();
  const secretKey = String(process.env.TENCENT_SECRET_KEY || "").trim();
  if (!secretId || !secretKey) {
    const err = new Error("MISSING_TENCENT_CREDS");
    err.code = "MISSING_TENCENT_CREDS";
    throw err;
  }
  const service = "asr";
  const host = ASR.HOST;
  const region = ASR.REGION;
  const payloadStr = JSON.stringify(body);
  const { headers } = tc3Sign(
    secretId,
    secretKey,
    service,
    host,
    action,
    ASR_API_VERSION,
    region,
    payloadStr
  );

  const res = await axios.post(`https://${host}/`, payloadStr, {
    headers,
    timeout: 120000,
    validateStatus: () => true,
  });

  const data = res.data || {};
  if (res.status !== 200) {
    const e = data.Response && data.Response.Error;
    throw new Error(
      (e && (e.Message || e.Code)) || fmt(MSG.ASR_REQUEST_FAILED, res.status)
    );
  }
  if (data.Response && data.Response.Error) {
    const e = data.Response.Error;
    throw new Error(e.Message || e.Code || MSG.ASR_RESPONSE_ERROR);
  }
  return data;
}

module.exports = {
  callAsrApi,
  ASR_API_VERSION,
};
