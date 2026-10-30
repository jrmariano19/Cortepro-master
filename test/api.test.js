import test from "node:test";
import assert from "node:assert/strict";
import detectHandler from "../api/detect.js";
import extractHandler from "../api/extract.js";

function responseMock() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("detect endpoint only accepts POST", () => {
  const res = responseMock();
  detectHandler({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
  assert.equal(res.body.success, false);
});

test("detect endpoint returns the recognized platform", () => {
  const res = responseMock();
  detectHandler({ method: "POST", body: { url: "https://youtu.be/abc123" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.platform, "YouTube");
});

test("detect endpoint rejects unsupported URLs", () => {
  const res = responseMock();
  detectHandler({ method: "POST", body: { url: "https://example.org/video" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test("extract endpoint remains disabled without an authorized provider", () => {
  const res = responseMock();
  extractHandler({ method: "POST", body: { url: "https://www.tiktok.com/@user/video/123" } }, res);
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.code, "INTEGRATION_UNAVAILABLE");
  assert.equal(res.body.platform, "TikTok");
});

test("extract endpoint rejects unsupported URLs before provider selection", () => {
  const res = responseMock();
  extractHandler({ method: "POST", body: { url: "https://example.org/video" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});
