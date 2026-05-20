/**
 * 腾讯云 COS 数据万象：媒体转码任务（CreateMediaJobs / DescribeMediaJob）
 * 文档：https://cloud.tencent.com/document/product/460/84777
 */
const COS = require("cos-nodejs-sdk-v5");
const { MSG, fmt } = require("../messages");

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getCiEnv() {
  const secretId = process.env.TENCENT_SECRET_ID || "";
  const secretKey = process.env.TENCENT_SECRET_KEY || "";
  const bucket = process.env.TENCENT_COS_BUCKET || "";
  const region = process.env.TENCENT_COS_REGION || "";
  const templateId = process.env.TENCENT_CI_TRANSCODE_TEMPLATE_ID || "";
  return { secretId, secretKey, bucket, region, templateId };
}

function isCiTranscodeConfigured() {
  const e = getCiEnv();
  return !!(e.secretId && e.secretKey && e.bucket && e.region && e.templateId);
}

function createCosClient() {
  const { secretId, secretKey } = getCiEnv();
  return new COS({
    SecretId: secretId,
    SecretKey: secretKey,
  });
}

function cosRequestAsync(cos, params) {
  return new Promise((resolve, reject) => {
    cos.request(params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function cosGetObjectAsync(cos, params) {
  return new Promise((resolve, reject) => {
    cos.getObject(params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function cosPutObjectAsync(cos, params) {
  return new Promise((resolve, reject) => {
    cos.putObject(params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function cosDeleteObjectAsync(cos, params) {
  return new Promise((resolve, reject) => {
    cos.deleteObject(params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * 从 DescribeMediaJob / CreateMediaJobs 的 XML 中解析 JobsDetail
 */
function parseJobsDetailXml(xml) {
  if (!xml || typeof xml !== "string") {
    return { state: "", jobId: "", code: "", message: "", outputObject: "" };
  }
  const jd = xml.match(/<JobsDetail>([\s\S]*?)<\/JobsDetail>/i);
  const block = jd ? jd[1] : xml;
  const pick = (tag) => {
    const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
    return m ? String(m[1]).trim() : "";
  };
  let outputObject = "";
  const op = block.match(/<Operation>([\s\S]*?)<\/Operation>/i);
  if (op) {
    const om = op[1].match(/<Output>[\s\S]*?<Object>([^<]+)<\/Object>/i);
    if (om) outputObject = String(om[1]).trim();
  }
  return {
    code: pick("Code"),
    message: pick("Message"),
    jobId: pick("JobId"),
    state: pick("State"),
    outputObject,
  };
}

function getCiHost(bucket, region) {
  return `${bucket}.ci.${region}.myqcloud.com`;
}

/**
 * 提交转码任务（极速高清 / 普通转码模板均可，由控制台模板 ID 决定）
 */
async function createTranscodeJob({ inputKey, outputKey }) {
  const { bucket, region, templateId } = getCiEnv();
  const cos = createCosClient();
  const body = [
    "<Request>",
    "<Tag>Transcode</Tag>",
    "<Input>",
    `<Object>${escapeXml(inputKey)}</Object>`,
    "</Input>",
    "<Operation>",
    `<TemplateId>${escapeXml(templateId)}</TemplateId>`,
    "<Output>",
    `<Region>${escapeXml(region)}</Region>`,
    `<Bucket>${escapeXml(bucket)}</Bucket>`,
    `<Object>${escapeXml(outputKey)}</Object>`,
    "</Output>",
    "</Operation>",
    "</Request>",
  ].join("");

  const url = `https://${getCiHost(bucket, region)}/jobs`;
  const data = await cosRequestAsync(cos, {
    Bucket: bucket,
    Region: region,
    Method: "POST",
    Url: url,
    Key: "/jobs",
    Body: body,
    Headers: {
      "Content-Type": "application/xml",
    },
  });

  const xml = (data && (data.Body || data.body)) ? String(data.Body || data.body) : "";
  const detail = parseJobsDetailXml(xml);
  if (!detail.jobId) {
    const errMsg = detail.message || detail.code || xml.slice(0, 500) || MSG.CI_NO_JOB_ID;
    throw new Error(fmt(MSG.CI_SUBMIT_FAILED, errMsg));
  }
  return { jobId: detail.jobId, rawXml: xml };
}

/**
 * 查询任务 GET /jobs/{jobId}
 */
async function describeMediaJob(ciJobId) {
  const { bucket, region } = getCiEnv();
  const cos = createCosClient();
  const id = encodeURIComponent(String(ciJobId).trim());
  const url = `https://${getCiHost(bucket, region)}/jobs/${id}`;
  const data = await cosRequestAsync(cos, {
    Bucket: bucket,
    Region: region,
    Method: "GET",
    Url: url,
    Key: `/jobs/${id}`,
  });
  const xml = (data && (data.Body || data.body)) ? String(data.Body || data.body) : "";
  return parseJobsDetailXml(xml);
}

async function putObjectBuffer(key, buffer) {
  const { bucket, region } = getCiEnv();
  const cos = createCosClient();
  await cosPutObjectAsync(cos, {
    Bucket: bucket,
    Region: region,
    Key: key,
    Body: buffer,
    ContentType: "video/mp4",
  });
}

async function getObjectBuffer(key) {
  const { bucket, region } = getCiEnv();
  const cos = createCosClient();
  const data = await cosGetObjectAsync(cos, {
    Bucket: bucket,
    Region: region,
    Key: key,
  });
  const body = data && data.Body;
  if (!body || !Buffer.isBuffer(body)) {
    throw new Error(MSG.CI_GET_OBJECT_EMPTY);
  }
  return body;
}

async function deleteObjectKey(key) {
  try {
    const { bucket, region } = getCiEnv();
    const cos = createCosClient();
    await cosDeleteObjectAsync(cos, {
      Bucket: bucket,
      Region: region,
      Key: key,
    });
  } catch (e) {
    console.error("[deleteObjectKey]", key, e && e.message);
  }
}

module.exports = {
  getCiEnv,
  isCiTranscodeConfigured,
  createTranscodeJob,
  describeMediaJob,
  putObjectBuffer,
  getObjectBuffer,
  deleteObjectKey,
  parseJobsDetailXml,
};
