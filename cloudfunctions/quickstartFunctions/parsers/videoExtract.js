/**
 * 视频链接解析：优先使用环境变量 VIDEO_PARSE_URL 自定义接口，否则按平台调用内置解析。
 * 自定义接口：GET，将 {{url}} 替换为 encodeURIComponent(用户链接)。
 * 返回 JSON 中用 VIDEO_PARSE_JSON_PATH 指定视频地址，默认 data.videoUrl（点号分隔嵌套键）。
 *
 * 生产级建议（与「免费聚合接口」对比）：
 * - 稳定性：对接签约商用解析 API（独享线路/SLA），配置 VIDEO_PARSE_URL；勿依赖单一免费站。
 * - 合规：确认业务与第三方解析服务的使用条款及版权要求。
 * - 架构：解析与下载宜异步队列（消息队列 + 独立 worker），避免长请求占满云函数并发。
 * - 可观测：接入云函数日志检索/告警，对失败率、耗时、供应商错误码做监控。
 * - 安全：限流、用户配额、风控（防刷）、密钥仅存环境变量。
 * 可选环境变量：DOUYIN_PARSE_FALLBACK_URL，VIDEO_PARSE_DOUYIN_URL，DOUYIN_PARSE_FALLBACK_JSON_PATH
 * BugPK：默认聚合 https://api.bugpk.com/api/short_videos（GET ?url=）；BUGPK_UNIFIED_URL 可覆盖；BUGPK_USE_PLATFORM_ROUTING=1 恢复按平台子接口。BUGPK_DISABLE=1 可全关。
 * 商用解析（推荐）：VIDEO_PARSE_URL、VIDEO_PARSE_JSON_PATH；可增设 VIDEO_PARSE_URL_EXTRA、VIDEO_PARSE_JSON_PATH_EXTRA
 * HelloTik：https://www.hellotik.app/api/parse 需鉴权，配置 HELLOTIK_API_TOKEN（见 ENV.example）
 * 龟龟呀聚合（接口侧多为「抖音解析」）：配置 GUIGUIYA_API_KEY；默认仅对抖音链接调用（见 GUIGUIYA_ONLY_DOUYIN）。失败时默认回退内置线路，仅当 GUIGUIYA_STRICT=1 时中断并抛出龟龟呀错误。
 * 说明见同目录 ENV.example
 */
const axios = require("axios");
const cloud = require("wx-server-sdk");
const { TIMEOUT, PLATFORM_REFERER, TRUNCATE, UPLOAD_LIMIT, SHORT_VIDEO } = require("../config");
const { MSG, fmt } = require("../messages");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 抖音解析：默认首条线路（返回 JSON：code 200，data.url 为直链） */
const BUGPK_DOUYIN = "https://api.bugpk.com/api/douyin";
/** 快手解析：默认首条线路（与 BugPK 抖音结构类似，须带 url 参数） */
const BUGPK_KUAISHOU = "https://api.bugpk.com/api/ksjx";
/** 小红书解析：BugPK svparse（须带 url 参数） */
const BUGPK_XHSJX = "https://api.bugpk.com/api/svparse";
/** 小红书解析备用：BugPK xhs */
const BUGPK_XHS = "https://api.bugpk.com/api/xhs";
/** BugPK 官方短视频聚合（多平台同一入口，GET ?url=） */
const BUGPK_SHORT_VIDEOS = "https://api.bugpk.com/api/short_videos";
const DEVTOOL_DOUYIN = "https://www.devtool.top/api/douyin/parse";
/** 备用聚合（与 devtool 不同源，失败时可多一次机会；亦可能限流） */
const TENAPI_VIDEO = "https://tenapi.cn/v2/video";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractFirstUrlFromText(input) {
  const text = String(input || "");
  const m = text.match(/https?:\/\/[^\s]+/i);
  if (!m || !m[0]) return "";
  return m[0].replace(/[),.;!?\u3002\uff0c\uff1b\uff01\uff1f]+$/g, "");
}

function normalizeShareUrl(url) {
  const fromText = extractFirstUrlFromText(url);
  let s = fromText || String(url || "").trim().replace(/\s+/g, "");
  if (s && !/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function parseResponseOk(data) {
  if (data == null) return false;
  const c = data.code;
  return c === 200 || c === "200" || Number(c) === 200;
}

/** BugPK 系及 devtool 等共用：从 data 中取视频直链（含 B 站 data.videos、抖音 live_photo） */
function pickBugpkVideoUrl(data) {
  if (!data || !data.data) return null;
  const d = data.data;
  if (d.video && isHttpUrl(d.video.url)) return d.video.url;
  if (isHttpUrl(d.video_url)) return d.video_url;
  if (isHttpUrl(d.url)) return d.url;
  if (d.video && d.video.play_addr && isHttpUrl(d.video.play_addr.url)) {
    return d.video.play_addr.url;
  }
  if (Array.isArray(d.videos) && d.videos.length > 0) {
    const u = d.videos[0] && d.videos[0].url;
    if (u && isHttpUrl(String(u))) return String(u);
  }
  if (Array.isArray(d.live_photo) && d.live_photo.length > 0) {
    const lp = d.live_photo[0];
    if (lp && lp.video && isHttpUrl(String(lp.video))) return String(lp.video);
  }
  return null;
}

function pickDouyinVideoUrl(data) {
  return pickBugpkVideoUrl(data);
}

async function axiosGetWithRetry(url, config, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      const status = e && e.response && e.response.status;
      const retryable =
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ECONNABORTED" ||
        code === "EPIPE" ||
        status === 408 ||
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        (e.response && e.response.status >= 500);
      if (!retryable || i === retries) break;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

function formatAxiosError(e) {
  if (!e) return "网络请求失败";
  if (e.response) {
    return `HTTP ${e.response.status}${e.response.statusText ? ` ${e.response.statusText}` : ""}`;
  }
  if (e.code) return `${e.code}: ${e.message || ""}`;
  return e.message || String(e);
}

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function detectPlatform(link) {
  const u = String(link).toLowerCase();
  /** 视频号分享链：内置无解析实现，须配置 VIDEO_PARSE_URL 等第三方聚合 */
  if (u.includes("channels.weixin.qq.com")) return "weixin_channels";
  if (u.includes("douyin.com") || u.includes("iesdouyin.com")) return "douyin";
  if (
    u.includes("kuaishou.com") ||
    u.includes("kwai.com") ||
    u.includes("gifshow.com") ||
    u.includes("chenzhongtech.com")
  ) {
    return "kuaishou";
  }
  if (
    u.includes("bilibili.com") ||
    u.includes("b23.tv") ||
    u.includes("bilibili.tv") ||
    u.includes("bilivideo.com")
  ) {
    return "bilibili";
  }
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xhs";
  return "unknown";
}

function envStr(k) {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : "";
}

/**
 * 按平台选 BugPK 子路径（仅当 BUGPK_USE_PLATFORM_ROUTING=1 时使用）。
 */
function resolveBugpkPerPlatformEndpoint(link) {
  const plat = detectPlatform(link);
  if (plat === "weixin_channels") return null;

  if (plat === "douyin") {
    if (process.env.DOUYIN_BUGPK_DISABLE === "1" || process.env.DOUYIN_BUGPK_DISABLE === "true") {
      return null;
    }
    return envStr("DOUYIN_BUGPK_URL") || BUGPK_DOUYIN;
  }
  if (plat === "kuaishou") {
    if (process.env.KUAISHOU_BUGPK_DISABLE === "1" || process.env.KUAISHOU_BUGPK_DISABLE === "true") {
      return null;
    }
    return envStr("KUAISHOU_BUGPK_URL") || BUGPK_KUAISHOU;
  }
  if (plat === "xhs") {
    if (process.env.XHS_BUGPK_DISABLE === "1" || process.env.XHS_BUGPK_DISABLE === "true") {
      return null;
    }
    return envStr("XHS_BUGPK_URL") || BUGPK_XHSJX;
  }
  if (plat === "bilibili") {
    if (process.env.BILIBILI_BUGPK_DISABLE === "1" || process.env.BILIBILI_BUGPK_DISABLE === "true") {
      return null;
    }
    /** B 站统一走短视频聚合；需单独子接口时设 BILIBILI_BUGPK_URL */
    return envStr("BILIBILI_BUGPK_URL") || BUGPK_SHORT_VIDEOS;
  }

  const unknownUrl = envStr("BUGPK_UNKNOWN_URL");
  if (unknownUrl === "0") return null;
  return unknownUrl || BUGPK_DOUYIN;
}

/**
 * 默认 short_videos 聚合；BUGPK_UNIFIED_URL 非空且非 0 时覆盖；BUGPK_USE_PLATFORM_ROUTING=1 时按平台子接口。
 */
function resolveBugpkEndpoint(link) {
  if (process.env.BUGPK_DISABLE === "1" || process.env.BUGPK_DISABLE === "true") {
    return null;
  }
  const unified = envStr("BUGPK_UNIFIED_URL");
  if (unified && unified !== "0") return unified;

  if (
    process.env.BUGPK_USE_PLATFORM_ROUTING === "1" ||
    process.env.BUGPK_USE_PLATFORM_ROUTING === "true"
  ) {
    return resolveBugpkPerPlatformEndpoint(link);
  }

  if (detectPlatform(link) === "weixin_channels") return null;
  return BUGPK_SHORT_VIDEOS;
}

function finishBugpkUnifiedResponse(data, link) {
  if (!parseResponseOk(data)) {
    const msg =
      (data && (data.msg || data.message || data.error)) || "接口返回非成功状态";
    throw new Error(`[BugPK] ${msg}`);
  }
  const videoUrl = pickBugpkVideoUrl(data);
  if (!videoUrl) {
    const msg =
      (data && (data.msg || data.message || data.error)) || MSG.EXTRACT_NO_VIDEO_URL;
    throw new Error(`[BugPK] ${msg}`);
  }
  const d = data.data || {};
  const plat = detectPlatform(link);
  const outPlat = plat === "unknown" ? "bugpk" : plat;
  return {
    platform: outPlat,
    title: d.title || d.desc || (data.title || ""),
    cover: d.cover || d.coverUrl || "",
    videoUrl,
  };
}

async function tryExtractBugpk(url) {
  const endpoint = resolveBugpkEndpoint(url);
  if (!endpoint) return null;
  try {
    const { data } = await axiosGetWithRetry(
      endpoint,
      {
        params: { url },
        timeout: TIMEOUT.API_AGGREGATE,
        headers: { "User-Agent": UA },
      },
      2
    );
    return finishBugpkUnifiedResponse(data, url);
  } catch (e) {
    console.error("[tryExtractBugpk]", endpoint, e && e.message);
    return null;
  }
}

/** 跟随重定向，把 v.douyin.com 短链尽量展开成长链，提高解析成功率（失败会重试一次） */
async function expandDouyinShareUrl(url) {
  if (!url || !isHttpUrl(url)) return url;
  const lower = url.toLowerCase();
  if (!lower.includes("douyin.com") && !lower.includes("iesdouyin.com")) {
    return url;
  }
  const tryOnce = async (timeoutMs) => {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: timeoutMs,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const req = res.request;
    const final =
      (req && req.res && req.res.responseUrl) ||
      (req && req.responseURL) ||
      (res.config && res.config.url);
    if (final && typeof final === "string" && final.startsWith("http")) {
      const clean = final.split("#")[0];
      if (clean && clean !== url) {
        console.error("[expandDouyinShareUrl]", url, "->", clean);
        return clean;
      }
    }
    return url;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await tryOnce(attempt === 0 ? 22000 : 32000);
    } catch (e) {
      console.error("[expandDouyinShareUrl]", attempt, e && e.message);
      if (attempt === 0) await sleep(500);
    }
  }
  return url;
}

function finishDouyinFromResponse(data, tag) {
  const label = tag ? `/${tag}` : "";
  if (!parseResponseOk(data)) {
    const msg = (data && (data.msg || data.message)) || "接口返回非成功状态";
    throw new Error(`[抖音解析${label}] ${msg}`);
  }
  const videoUrl = pickDouyinVideoUrl(data);
  if (!videoUrl) {
    const msg = (data && (data.msg || data.message)) || MSG.EXTRACT_NO_VIDEO_URL;
    throw new Error(`[抖音解析${label}] ${msg}`);
  }
  const d = data.data || {};
  const cover =
    (d.video && d.video.cover) || d.cover || d.origin_cover || "";
  return {
    platform: "douyin",
    title: d.title || d.desc || "",
    cover,
    videoUrl,
  };
}

async function extractDouyinPrimary(url) {
  const primary =
    process.env.VIDEO_PARSE_DOUYIN_URL || DEVTOOL_DOUYIN;
  const isTemplate = primary.includes("{{url}}");
  const requestUrl = isTemplate
    ? primary.replace(/\{\{url\}\}/g, encodeURIComponent(url))
    : primary;
  const config = isTemplate
    ? { timeout: TIMEOUT.API_REQUEST, headers: { "User-Agent": UA } }
    : {
        params: { url },
        timeout: TIMEOUT.API_REQUEST,
        headers: { "User-Agent": UA },
      };

  const { data } = await axiosGetWithRetry(requestUrl, config, 2);
  return finishDouyinFromResponse(data, "GET");
}

/**
 * devtool 等接口：POST 时往往要求与 GET 一样把 url 放在 QueryString，
 * JSON body 会返回「未指定要解析的地址」。
 */
async function extractDouyinPostWithQuery(url) {
  const endpoint = process.env.VIDEO_PARSE_DOUYIN_URL || DEVTOOL_DOUYIN;
  if (endpoint.includes("{{url}}")) {
    throw new Error("skip post: template endpoint");
  }
  const { data } = await axios.post(
    endpoint,
    null,
    {
      params: { url },
      timeout: TIMEOUT.API_REQUEST,
      headers: { "User-Agent": UA },
    }
  );
  return finishDouyinFromResponse(data, "POST_QS");
}

async function extractDouyinPostForm(url) {
  const endpoint = process.env.VIDEO_PARSE_DOUYIN_URL || DEVTOOL_DOUYIN;
  if (endpoint.includes("{{url}}")) {
    throw new Error("skip post: template endpoint");
  }
  const { data } = await axios.post(
    endpoint,
    `url=${encodeURIComponent(url)}`,
    {
      timeout: TIMEOUT.API_REQUEST,
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return finishDouyinFromResponse(data, "FORM");
}

/**
 * TenAPI：POST form（文档推荐）；502 时重试；失败再试 GET ?url=
 * 可选环境变量 TENAPI_VIDEO_URL 覆盖默认 https://tenapi.cn/v2/video
 */
async function extractDouyinTenapi(url) {
  const endpoint = process.env.TENAPI_VIDEO_URL || TENAPI_VIDEO;
  const body = `url=${encodeURIComponent(url)}`;
  const base = {
    timeout: TIMEOUT.API_AGGREGATE,
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    validateStatus: () => true,
  };

  const finishFromTenapiResponse = (res, tag) => {
    if (res.status >= 500) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = res.data;
    if (!data || typeof data !== "object") {
      throw new Error(fmt(MSG.EXTRACT_INVALID_RESPONSE, res.status));
    }
    if (!parseResponseOk(data)) {
      const msg = data.msg || data.message || "接口失败";
      throw new Error(msg);
    }
    const d = data.data || {};
    const videoUrl = d.url;
    if (!videoUrl || !isHttpUrl(String(videoUrl))) {
      throw new Error(MSG.EXTRACT_NO_VIDEO_URL);
    }
    return {
      platform: "douyin",
      title: d.title || "",
      cover: d.cover || "",
      videoUrl: String(videoUrl),
    };
  };

  for (let i = 0; i < 3; i++) {
    const res = await axios.post(endpoint, body, base);
    if (res.status >= 500 && res.status < 600) {
      if (i < 2) {
        await sleep(1000 * (i + 1));
        continue;
      }
      break;
    }
    try {
      return finishFromTenapiResponse(res, "/POST");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`[抖音解析/TENAPI/POST] ${msg}`);
    }
  }

  for (let i = 0; i < 2; i++) {
    const res = await axios.get(endpoint, {
      ...base,
      params: { url },
    });
    if (res.status >= 500 && res.status < 600) {
      if (i < 1) {
        await sleep(800 * (i + 1));
        continue;
      }
      throw new Error(`[抖音解析/TENAPI/GET] HTTP ${res.status}`);
    }
    try {
      return finishFromTenapiResponse(res, "/GET");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`[抖音解析/TENAPI/GET] ${msg}`);
    }
  }

  throw new Error("[抖音解析/TENAPI] POST/GET 均失败");
}

/**
 * devtool：GET → POST_QS → POST_FORM（devtool 不支持 JSON body，已去掉 POST_JSON）
 * → TenAPI（重试+GET 备用）→ 环境变量 DOUYIN_PARSE_FALLBACK_URL（BugPK 已在 extractVideoMeta 前统一尝试）
 */
async function extractDouyin(rawUrl) {
  let url = normalizeShareUrl(rawUrl);
  url = await expandDouyinShareUrl(url);

  const attempts = [
    { name: "GET", fn: () => extractDouyinPrimary(url) },
    { name: "POST_QS", fn: () => extractDouyinPostWithQuery(url) },
    { name: "POST_FORM", fn: () => extractDouyinPostForm(url) },
    { name: "TENAPI", fn: () => extractDouyinTenapi(url) },
  ];

  const errs = [];
  for (const { name, fn } of attempts) {
    try {
      return await fn();
    } catch (e) {
      errs.push(`${name}:${e && e.message ? e.message : String(e)}`);
    }
  }

  const fallback = process.env.DOUYIN_PARSE_FALLBACK_URL;
  if (fallback && String(fallback).trim()) {
    try {
      const full = fallback.replace(/\{\{url\}\}/g, encodeURIComponent(url));
      console.error("[extractDouyin] trying env DOUYIN_PARSE_FALLBACK_URL");
      const { data } = await axiosGetWithRetry(
        full,
        { timeout: TIMEOUT.API_REQUEST, headers: { "User-Agent": UA } },
        1
      );
      const jsonPath =
        process.env.DOUYIN_PARSE_FALLBACK_JSON_PATH || "data.video.url";
      const videoUrl =
        getByPath(data, jsonPath) || pickDouyinVideoUrl(data);
      if (!videoUrl || !isHttpUrl(String(videoUrl))) {
        throw new Error(MSG.EXTRACT_FALLBACK_NO_URL);
      }
      return {
        platform: "douyin",
        title: getByPath(data, "data.title") || "",
        cover: getByPath(data, "data.video.cover") || "",
        videoUrl: String(videoUrl),
      };
    } catch (e) {
      errs.push(`ENV_FALLBACK:${e && e.message}`);
    }
  }

  const detail = errs.join(" | ").slice(0, TRUNCATE.DOUYIN_ERRS);
  throw new Error(
    `[抖音解析] 内置线路均失败（含 devtool / TenAPI 等，BugPK 若已在前序步骤失败请见日志）。详情：${detail}。` +
      `解决：微信云开发控制台 → 云函数 quickstartFunctions → 环境变量，配置 VIDEO_PARSE_URL（商用解析），` +
      `参考项目内 cloudfunctions/quickstartFunctions/ENV.example`
  );
}

/**
 * 内置快手线路：api.tjit.net（需 key）；BugPK 已在 extractVideoMeta 前统一尝试。
 * https://api.tjit.net/user/key ；也可整体换成自建/商用 URL（VIDEO_PARSE_KUAISHOU_URL）。
 */
async function extractKuaishouTjit(url) {
  const base =
    process.env.VIDEO_PARSE_KUAISHOU_URL || "https://api.tjit.net/api/kuaishou/";
  const key =
    process.env.VIDEO_PARSE_KUAISHOU_KEY ||
    process.env.TJIT_API_KEY ||
    "";
  const keyParam = (process.env.VIDEO_PARSE_KUAISHOU_KEY_PARAM || "key").trim();

  const params = { url };
  if (key && String(key).trim()) {
    params[keyParam] = String(key).trim();
  }

  const { data } = await axiosGetWithRetry(
    base,
    {
      params,
      timeout: TIMEOUT.API_REQUEST,
      headers: { "User-Agent": UA },
    },
    1
  );

  const msg = (data && (data.msg || data.message)) || "";
  const code = data && data.code;
  const looksLikeKeyError =
    msg &&
    (msg.includes("密钥") ||
      msg.includes("key") ||
      msg.includes("Key") ||
      msg.includes("控制台") ||
      msg.includes("tjit"));
  if (looksLikeKeyError || (code && Number(code) === 401)) {
    throw new Error(
      `[快手解析/TJIT] ${msg || "鉴权失败"}。请在云函数环境变量配置 VIDEO_PARSE_KUAISHOU_KEY（见 api.tjit.net 用户控制台），或改用 VIDEO_PARSE_URL 商用解析`
    );
  }

  const play =
    data.play ||
    data.play_url ||
    data.video_url ||
    (data.data && (data.data.video_url || data.data.play || data.data.photoUrl));
  if (!play) {
    throw new Error(
      msg ||
        "快手解析未返回视频地址。请配置 VIDEO_PARSE_KUAISHOU_KEY，或设置 VIDEO_PARSE_URL"
    );
  }
  return {
    platform: "kuaishou",
    title: data.title || (data.data && data.data.title) || "",
    cover: (data.data && data.data.coverUrl) || "",
    videoUrl: play,
  };
}

async function extractKuaishou(url) {
  return extractKuaishouTjit(url);
}

async function extractCustom(url) {
  const templates = [];
  const a = process.env.VIDEO_PARSE_URL;
  const b = process.env.VIDEO_PARSE_URL_EXTRA;
  if (a && String(a).trim()) templates.push(String(a).trim());
  if (b && String(b).trim()) templates.push(String(b).trim());
  if (templates.length === 0) return null;

  const path1 = process.env.VIDEO_PARSE_JSON_PATH || "data.videoUrl";
  const path2 = process.env.VIDEO_PARSE_JSON_PATH_EXTRA || path1;

  const headers = { "User-Agent": UA };
  const key = process.env.VIDEO_PARSE_API_KEY;
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers["X-API-Key"] = key;
  }

  let lastErr;
  for (let i = 0; i < templates.length; i++) {
    const template = templates[i];
    const jsonPath = i === 0 ? path1 : path2;
    try {
      const fullUrl = template.replace(/\{\{url\}\}/g, encodeURIComponent(url));
      const { data } = await axiosGetWithRetry(fullUrl, {
        timeout: TIMEOUT.API_REQUEST,
        headers: { ...headers },
      }, 1);
      const videoUrl = getByPath(data, jsonPath);
      if (!videoUrl || typeof videoUrl !== "string") {
        throw new Error(
          (data && (data.msg || data.message)) ||
            "自定义接口未返回有效视频地址，请检查 VIDEO_PARSE_JSON_PATH"
        );
      }
      return {
        platform: "custom",
        title: getByPath(data, process.env.VIDEO_PARSE_TITLE_PATH || "") || "",
        cover: getByPath(data, process.env.VIDEO_PARSE_COVER_PATH || "") || "",
        videoUrl,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("自定义解析均失败");
}

function parseGuiguiyaOk(data) {
  if (!data || typeof data !== "object") return false;
  if (data.success === true) return true;
  const c = data.code;
  return c === 200 || c === 0 || c === "200" || c === "0";
}

/** 龟龟呀偶发返回纯文本（如「无效密钥」），或 axios 已解析好的 JSON 对象 */
function normalizeGuiguiyaBody(raw, attemptName) {
  if (raw == null) {
    throw new Error(`[龟龟呀/${attemptName}] 空响应`);
  }
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) throw new Error(`[龟龟呀/${attemptName}] 空响应`);
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new Error(`[龟龟呀/${attemptName}] ${t.slice(0, TRUNCATE.GUIGUIYA_ERR)}`);
      }
    }
    throw new Error(`[龟龟呀/${attemptName}] ${t.slice(0, TRUNCATE.GUIGUIYA_ERR)}`);
  }
  throw new Error(`[龟龟呀/${attemptName}] 未知响应类型`);
}

/** 在嵌套对象里找最像视频直链的 http(s) 地址（兜底，排除明显图片） */
function findLikelyVideoUrlInTree(obj, depth = 0) {
  if (depth > 8 || obj == null) return null;
  if (typeof obj === "string") {
    const u = obj.trim();
    if (!isHttpUrl(u)) return null;
    const low = u.toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(low)) return null;
    if (
      /\.(mp4|m3u8|flv)(\?|$)/i.test(low) ||
      low.includes("douyinvod") ||
      low.includes("aweme") ||
      low.includes("/video/tos") ||
      low.includes("playwm") ||
      low.includes("play") && (low.includes("video") || low.includes("vod"))
    ) {
      return u;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = findLikelyVideoUrlInTree(item, depth + 1);
      if (v) return v;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const v = findLikelyVideoUrlInTree(obj[k], depth + 1);
      if (v) return v;
    }
  }
  return null;
}

function pickGuiguiyaVideoUrl(data) {
  const path = process.env.GUIGUIYA_JSON_PATH;
  if (path) {
    const v = getByPath(data, path);
    if (v && isHttpUrl(String(v)) && String(v).trim()) return String(v).trim();
  }
  const keys = [
    "data.url",
    "data.video",
    "data.videoUrl",
    "data.video_url",
    "data.play",
    "data.down",
    "data.down_url",
    "data.nwm",
    "data.nowm",
    "data.data.url",
    "data.download",
    "url",
  ];
  for (const k of keys) {
    const v = getByPath(data, k);
    if (v && isHttpUrl(String(v)) && String(v).trim()) return String(v).trim();
  }
  const guess = findLikelyVideoUrlInTree(data);
  return guess || null;
}

/**
 * 龟龟呀 api.guiguiya.com 聚合：先普通 GET（apiKey+url），再 type=json 模式。
 * url 可传 string 或 string[]：展开链与原始短链各试一轮，提高成功率。
 * 需环境变量 GUIGUIYA_API_KEY，勿把密钥写进代码仓库。
 */
async function extractGuiguiya(urlOrUrls) {
  const key = process.env.GUIGUIYA_API_KEY;
  if (!key || !String(key).trim()) return null;

  const base =
    process.env.GUIGUIYA_API_BASE ||
    "https://api.guiguiya.com/api/video_qsy/juhe";

  const list = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  const uniq = [];
  for (const u of list) {
    if (u && typeof u === "string" && uniq.indexOf(u) === -1) uniq.push(u);
  }
  if (!uniq.length) return null;

  let lastErr;
  for (const url of uniq) {
    const attempts = [
      { name: "GET", params: { apiKey: key.trim(), url } },
      { name: "JSON", params: { type: "json", apiKey: key.trim(), url } },
    ];
    for (const { name, params } of attempts) {
      try {
        const { data: raw } = await axiosGetWithRetry(
          base,
          {
            params,
            timeout: TIMEOUT.API_AGGREGATE,
            headers: { "User-Agent": UA },
          },
          3
        );
        const data = normalizeGuiguiyaBody(raw, name);
        if (!parseGuiguiyaOk(data)) {
          const msg = (data && (data.msg || data.message)) || "接口未返回成功";
          throw new Error(`[龟龟呀/${name}] ${msg}`);
        }
        const videoUrl = pickGuiguiyaVideoUrl(data);
        if (!videoUrl) {
          const hint = (data && data.msg && String(data.msg)) || "";
          throw new Error(
            `[龟龟呀/${name}] 返回成功但无有效视频直链（链接无效/已失效/接口未返回 url）。${hint ? `msg:${hint} ` : ""}可设置 GUIGUIYA_JSON_PATH 或换一条含有效视频的分享链接`
          );
        }
        return {
          platform: "guiguiya",
          title:
            getByPath(data, "data.title") ||
            getByPath(data, "data.desc") ||
            getByPath(data, "data.author") ||
            "",
          cover:
            getByPath(data, "data.cover") ||
            getByPath(data, "data.pic") ||
            "",
          videoUrl,
        };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("[龟龟呀] GET 与 type=json 均失败");
}

/**
 * HelloTik 聚合解析（POST JSON）。未配置 HELLOTIK_API_TOKEN 时跳过。
 * 官方接口在未携带有效 Token 时返回 {"error":"Authentication required"}。
 */
async function extractHellotik(url) {
  const token = process.env.HELLOTIK_API_TOKEN;
  if (!token || !String(token).trim()) return null;

  const endpoint =
    process.env.HELLOTIK_PARSE_URL || "https://www.hellotik.app/api/parse";

  const headers = {
    "User-Agent": UA,
    "Content-Type": "application/json",
    Referer: "https://www.hellotik.app/",
    Origin: "https://www.hellotik.app",
  };

  const mode = (process.env.HELLOTIK_AUTH_MODE || "bearer").toLowerCase();
  if (mode === "bearer") {
    headers.Authorization = `Bearer ${token.trim()}`;
  } else if (mode === "x-api-key") {
    headers["X-API-Key"] = token.trim();
  } else if (mode === "raw") {
    headers.Authorization = token.trim();
  }

  const bodyKey = process.env.HELLOTIK_BODY_URL_KEY || "url";
  const body = { [bodyKey]: url };

  const res = await axios.post(endpoint, body, {
    headers,
    timeout: TIMEOUT.API_AGGREGATE,
    validateStatus: () => true,
  });

  const data = res.data;
  if (res.status >= 400) {
    throw new Error(
      `[HelloTik] HTTP ${res.status} ${(data && data.error) || ""}`
    );
  }
  if (data && data.error) {
    throw new Error(`[HelloTik] ${data.error}`);
  }

  const path = process.env.HELLOTIK_JSON_PATH;
  let videoUrl = path ? getByPath(data, path) : null;
  if (!videoUrl) {
    videoUrl =
      getByPath(data, "data.url") ||
      getByPath(data, "data.videoUrl") ||
      getByPath(data, "data.video.url") ||
      getByPath(data, "data.download") ||
      getByPath(data, "url");
  }
  if (!videoUrl || !isHttpUrl(String(videoUrl))) {
    throw new Error(
      "[HelloTik] 响应中无视频直链，请对照实际返回 JSON 设置 HELLOTIK_JSON_PATH"
    );
  }

  return {
    platform: "hellotik",
    title:
      getByPath(data, "data.title") ||
      getByPath(data, "title") ||
      "",
    cover:
      getByPath(data, "data.cover") ||
      getByPath(data, "cover") ||
      "",
    videoUrl: String(videoUrl),
  };
}

/**
 * @returns {{ platform: string, title: string, cover: string, videoUrl: string }}
 */
async function extractVideoMeta(videoLink) {
  const raw = normalizeShareUrl(videoLink);
  if (!raw) {
    throw new Error(MSG.EXTRACT_LINK_EMPTY);
  }

  /** 抖音短链须先展开，否则龟龟呀等聚合常返回「无法解析视频 ID」 */
  let urlForApis = raw;
  if (detectPlatform(raw) === "douyin") {
    try {
      urlForApis = await expandDouyinShareUrl(raw);
    } catch (e) {
      console.error("[extractVideoMeta] expandDouyinShareUrl", e && e.message);
    }
  }

  if (process.env.VIDEO_PARSE_URL || process.env.VIDEO_PARSE_URL_EXTRA) {
    try {
      const custom = await extractCustom(urlForApis);
      if (custom) return custom;
    } catch (e) {
      console.error("[extractCustom]", e && e.message);
    }
  }

  /** BugPK：统一聚合（BUGPK_UNIFIED_URL）或按平台子接口；在龟龟呀 / HelloTik / 各内置线路之前 */
  const bugpkMeta = await tryExtractBugpk(urlForApis);
  if (bugpkMeta) return bugpkMeta;

  const guiguiyaKey =
    process.env.GUIGUIYA_API_KEY && String(process.env.GUIGUIYA_API_KEY).trim();
  /** 龟龟呀 juhe 多为抖音专用；默认仅抖音走此路。若你的套餐支持全平台，设 GUIGUIYA_ONLY_DOUYIN=0 */
  const guiguiyaOnlyDouyin = process.env.GUIGUIYA_ONLY_DOUYIN !== "0";
  const platformEarly = detectPlatform(raw);
  const shouldTryGuiguiya =
    guiguiyaKey && (!guiguiyaOnlyDouyin || platformEarly === "douyin");

  if (shouldTryGuiguiya) {
    try {
      const guiguiyaUrls = [urlForApis];
      if (raw !== urlForApis) guiguiyaUrls.push(raw);
      const gg = await extractGuiguiya(guiguiyaUrls);
      if (gg) return gg;
    } catch (e) {
      console.error("[extractGuiguiya]", e && e.message);
      if (process.env.GUIGUIYA_STRICT === "1") {
        throw e;
      }
    }
  }

  if (process.env.HELLOTIK_API_TOKEN && String(process.env.HELLOTIK_API_TOKEN).trim()) {
    try {
      const hel = await extractHellotik(urlForApis);
      if (hel) return hel;
    } catch (e) {
      console.error("[extractHellotik]", e && e.message);
    }
  }

  const platform = detectPlatform(raw);
  try {
    if (platform === "douyin") return await extractDouyin(urlForApis);
    if (platform === "kuaishou") return await extractKuaishou(urlForApis);
  } catch (e) {
    const wrapped = formatAxiosError(e);
    if (e && e.message && String(e.message).startsWith("[")) throw e;
    throw new Error(`${e.message || wrapped}（${MSG.EXTRACT_CONTINUOUS_FAILURE}）`);
  }

  if (platform === "xhs") {
    // BugPK 主入口已失败，补试小红书专用端点 xhs / xhsjx（另一条未试过的）
    const tried =
      process.env.XHS_BUGPK_URL ||
      (process.env.BUGPK_USE_PLATFORM_ROUTING === "1" ? BUGPK_XHSJX : null);
    const fallbacks = [BUGPK_XHS, BUGPK_XHSJX].filter(
      (u) => u && u !== tried
    );
    for (const ep of fallbacks) {
      try {
        const { data } = await axiosGetWithRetry(
          ep,
          { params: { url: urlForApis }, timeout: TIMEOUT.API_AGGREGATE, headers: { "User-Agent": UA } },
          1
        );
        return finishBugpkUnifiedResponse(data, urlForApis);
      } catch (e) {
        console.error("[xhs fallback]", ep, e && e.message);
      }
    }
    throw new Error(MSG.EXTRACT_XHS_FAILED);
  }

  if (platform === "bilibili") {
    throw new Error(MSG.EXTRACT_BILIBILI_FAILED);
  }

  if (platform === "weixin_channels") {
    throw new Error(MSG.EXTRACT_WECHAT_CHANNELS_FAILED);
  }

  throw new Error(MSG.EXTRACT_UNKNOWN_DOMAIN);
}

function maxUploadBytes() {
  const mb = Number(process.env.EXTRACT_MAX_UPLOAD_MB || UPLOAD_LIMIT.DEFAULT_MB);
  return Math.min(Math.max(mb, UPLOAD_LIMIT.MIN_MB), UPLOAD_LIMIT.MAX_MB) * 1024 * 1024;
}

const isM3u8Url = (url) => typeof url === "string" && /\.m3u8(\?|$)/i.test(url);

/**
 * 下载 HLS/m3u8 流的所有分片并合并为单个 Buffer。
 * 并发下载 3 个分片，单个分片失败重试 2 次，总量不超过 maxBytes，最多 200 个分片。
 */
async function downloadHlsAndConcat(m3u8Url, headers, maxBytes) {
  // 下载 m3u8 播放列表（重试 2 次）
  let playlistRes;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      playlistRes = await axios.get(m3u8Url, {
        responseType: "text",
        timeout: TIMEOUT.HLS_PLAYLIST_DL,
        headers,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(800 * (attempt + 1));
    }
  }
  if (!playlistRes) throw lastErr || new Error("m3u8 播放列表下载失败");

  const playlist = playlistRes.data;
  if (!playlist || typeof playlist !== "string") {
    throw new Error(MSG.HLS_PLAYLIST_EMPTY);
  }

  // 解析分片 URL（跳过 # 注释行，支持相对/绝对路径）
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
  const lines = playlist.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const segmentUrls = lines.map((l) => {
    const u = l.trim();
    return /^https?:\/\//i.test(u) ? u : baseUrl + u;
  });

  if (!segmentUrls.length) throw new Error(MSG.HLS_NO_SEGMENTS);
  if (segmentUrls.length > 200) throw new Error(fmt(MSG.HLS_TOO_MANY_SEGMENTS, segmentUrls.length));

  // 下载单个分片（含重试）
  const downloadOneSegment = async (segUrl, attempt) => {
    try {
      const res = await axios.get(segUrl, {
        responseType: "arraybuffer",
        timeout: TIMEOUT.HLS_SEGMENT_DL,
        headers,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      return Buffer.from(res.data);
    } catch (e) {
      if (attempt < 2) {
        await sleep(600 * (attempt + 1));
        return downloadOneSegment(segUrl, attempt + 1);
      }
      throw e;
    }
  };

  // 并发下载分片（每次 3 个）
  const buffers = [];
  let totalBytes = 0;
  for (let i = 0; i < segmentUrls.length; i += 3) {
    const batch = segmentUrls.slice(i, i + 3);
    const results = await Promise.all(
      batch.map((segUrl) => downloadOneSegment(segUrl, 0))
    );
    for (const buf of results) {
      totalBytes += buf.length;
      if (totalBytes > maxBytes) throw new Error(fmt(MSG.HLS_MERGED_OVER_LIMIT, (maxBytes / 1048576).toFixed(0)));
      buffers.push(buf);
    }
  }

  console.log(`[downloadHlsAndConcat] ${segmentUrls.length} segments, ${(totalBytes / 1048576).toFixed(1)}MB total`);
  return Buffer.concat(buffers);
}

/** 下载前的通用请求头（按平台补 Referer / Origin，B站 CDN 用桌面 UA 伪装） */
function buildDownloadHeaders(videoUrl) {
  const isBilibiliCdn =
    videoUrl.includes("bilivideo") ||
    videoUrl.includes("hdslb.com") ||
    videoUrl.includes("bilibili.com") ||
    videoUrl.includes("akamaized.net");
  const isAkamai = videoUrl.includes("akamaized.net");
  const referer =
    process.env.EXTRACT_VIDEO_REFERER ||
    (videoUrl.includes("douyin") || videoUrl.includes("douyinvod")
      ? PLATFORM_REFERER.douyin
      : videoUrl.includes("xiaohongshu.com") || videoUrl.includes("xhscdn")
        ? PLATFORM_REFERER.xiaohongshu
        : isBilibiliCdn
          ? PLATFORM_REFERER.bilibili
          : PLATFORM_REFERER.kuaishou);
  const ua = isBilibiliCdn ? UA_DESKTOP : UA;
  const base = {
    "User-Agent": ua,
    Referer: referer,
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  // Akamai 域名通常不需要额外 Origin，甚至可能拦截带 Origin 的无 Cookie 请求
  if (isBilibiliCdn && !isAkamai) {
    base.Origin = PLATFORM_REFERER.bilibili;
  }
  return base;
}

/**
 * 下载直链并上传云存储，返回 fileID；过大或失败时返回 { fileID: '', videoUrl, skipReason }
 * 自动检测 m3u8/HLS 流，下载全部分片后合并上传。
 */
async function downloadAndUploadVideo(videoUrl, jobId, platform) {
  if (process.env.EXTRACT_SKIP_UPLOAD === "1") {
    return { fileID: "", videoUrl, skipReason: "upload_disabled" };
  }

  const maxBytes = maxUploadBytes();
  const headers = buildDownloadHeaders(videoUrl);
  const shortMax = Number(process.env.SHORT_VIDEO_MAX_MB || 25) * 1024 * 1024;
  // 需云端转存的平台不走短视频跳过逻辑
  const platformNeedsCloud = platform === "bilibili" || platform === "weixin_channels";

  // 短视频（< 25MB 约合 90s 以内）：不下载不转存，前端直连源 CDN 更快
  // 但 B站/视频号等防盗链平台必须走云端
  if (!platformNeedsCloud && !isM3u8Url(videoUrl)) {
    try {
      const head = await axios.head(videoUrl, {
        timeout: 15000,
        headers,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const cl = parseInt(String(head.headers["content-length"] || ""), 10);
      if (cl > 0 && cl <= shortMax) {
        return { fileID: "", videoUrl, skipReason: "short_video", sizeBytes: cl };
      }
    } catch (_) {
      // HEAD 失败退回到完整下载流程
    }
  }

  let buf;
  try {
    if (isM3u8Url(videoUrl)) {
      buf = await downloadHlsAndConcat(videoUrl, headers, maxBytes);
    } else {
      // 直链下载（重试 2 次）
      let res;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await axios.get(videoUrl, {
            responseType: "arraybuffer",
            timeout: TIMEOUT.DIRECT_DOWNLOAD,
            maxContentLength: maxBytes + 1,
            maxBodyLength: maxBytes + 1,
            headers,
            validateStatus: (s) => s >= 200 && s < 400,
          });
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await sleep(1000 * (attempt + 1));
        }
      }
      if (!res) throw lastErr || new Error(MSG.DL_DIRECT_FAILED);

      const ct = String(res.headers["content-type"] || "").toLowerCase();
      if (
        ct.includes("application/vnd.apple.mpegurl") ||
        ct.includes("application/x-mpegurl") ||
        ct.includes("audio/mpegurl")
      ) {
        // 返回的是 m3u8 播放列表但 URL 不以 .m3u8 结尾，用 HLS 方式处理
        buf = await downloadHlsAndConcat(videoUrl, headers, maxBytes);
      } else {
        buf = Buffer.from(res.data);
      }
    }
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    const status = (e && e.response && e.response.status) || "";
    const urlHost = (() => { try { return new URL(videoUrl).hostname; } catch (_) { return ""; } })();
    const detail = [
      `域名: ${urlHost || "未知"}`,
      status ? `HTTP ${status}` : "",
      errMsg ? `${errMsg}` : "",
    ].filter(Boolean).join("，");
    console.error(`[downloadAndUploadVideo] FAIL ${detail} | url=${String(videoUrl).slice(0, TRUNCATE.LOG_URL)}`);
    return {
      fileID: "",
      videoUrl,
      skipReason: "download_failed",
      error: detail.slice(0, TRUNCATE.ERROR_DETAIL),
    };
  }

  if (!buf || buf.length < 1024) {
    return {
      fileID: "",
      videoUrl,
      skipReason: "download_failed",
      error: fmt(MSG.DL_CONTENT_EMPTY, buf ? buf.length : 0),
    };
  }

  if (buf.length > maxBytes) {
    return {
      fileID: "",
      videoUrl,
      skipReason: "file_too_large",
      sizeBytes: buf.length,
    };
  }

  try {
    const cloudPath = `extracted/${jobId}_${Date.now()}.mp4`;
    const upload = await cloud.uploadFile({
      cloudPath,
      fileContent: buf,
    });
    return { fileID: upload.fileID, videoUrl, sizeBytes: buf.length };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return {
      fileID: "",
      videoUrl,
      skipReason: "upload_failed",
      error: fmt(MSG.UL_CLOUD_FAILED, msg.slice(0, TRUNCATE.UPLOAD_ERROR)),
      sizeBytes: buf.length,
    };
  }
}

module.exports = {
  extractVideoMeta,
  downloadAndUploadVideo,
  detectPlatform,
};
