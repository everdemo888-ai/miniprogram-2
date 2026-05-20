/**
 * 微信云托管 HTTP 入口：将云函数 exports.main(event) 暴露为 POST JSON 接口。
 *
 * 请求体与 wx.cloud.callFunction 的 data 一致，例如：
 *   { "type": "getUserProfile" }
 *   { "type": "getVideoJobStatus", "jobId": "xxx" }
 *
 * 健康检查：GET / 或 GET /health
 * 业务调用：POST / 或 POST /invoke（Content-Type: application/json）
 */
"use strict";

const http = require("http");
const { main } = require("./index");

const MAX_BODY = 15 * 1024 * 1024;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    json(res, 200, {
      ok: true,
      service: "quickstartFunctions",
      hint: "POST JSON body same as wx.cloud.callFunction data",
    });
    return;
  }

  if (req.method === "POST" && (url === "/" || url === "/invoke")) {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", async () => {
      if (size > MAX_BODY) {
        json(res, 413, { success: false, errMsg: "payload too large" });
        return;
      }
      let event = {};
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) {
        try {
          event = JSON.parse(raw);
        } catch (e) {
          json(res, 400, { success: false, errMsg: "invalid JSON" });
          return;
        }
      }
      try {
        const result = await main(event, {});
        json(res, 200, result === undefined ? { success: true } : result);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        json(res, 500, { success: false, errMsg: msg });
      }
    });
    req.on("error", () => {
      try {
        json(res, 400, { success: false, errMsg: "request error" });
      } catch (_) {}
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const port = parseInt(process.env.PORT || process.env.CLOUD_RUN_PORT || "80", 10);
server.listen(port, "0.0.0.0", () => {
  console.log(`[cloudrun] listening on 0.0.0.0:${port}`);
});
