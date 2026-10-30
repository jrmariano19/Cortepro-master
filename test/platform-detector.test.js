import test from "node:test";
import assert from "node:assert/strict";
import { detectPlatform } from "../lib/platform-detector.js";

test("recognizes the five supported platforms", () => {
  const cases = [
    ["https://www.tiktok.com/@creator/video/123", "TikTok"],
    ["https://v.kwai.com/abc123", "Kwai"],
    ["https://www.instagram.com/reel/abc123/", "Instagram"],
    ["https://m.facebook.com/watch/?v=123", "Facebook"],
    ["https://youtu.be/abc123", "YouTube"]
  ];

  for (const [url, platform] of cases) {
    const result = detectPlatform(url);
    assert.equal(result.valid, true, url);
    assert.equal(result.platform, platform, url);
    assert.equal(result.normalizedUrl, new URL(url).toString());
  }
});

test("accepts legitimate subdomains but not lookalike domains", () => {
  assert.equal(detectPlatform("https://m.youtube.com/watch?v=123").platform, "YouTube");
  assert.equal(detectPlatform("https://tiktok.com.example.org/video").valid, false);
  assert.equal(detectPlatform("https://notinstagram.com/reel/123").valid, false);
  assert.equal(detectPlatform("https://youtube.com.evil.test/watch").valid, false);
});

test("rejects malformed, unsupported and non-HTTPS URLs", () => {
  for (const value of [null, undefined, 123, "", "not a url", "https://example.com/video", "http://tiktok.com/video", "javascript:alert(1)"]) {
    assert.equal(detectPlatform(value).valid, false, String(value));
  }
});

test("rejects credentials and explicit ports", () => {
  assert.equal(detectPlatform("https://user:pass@tiktok.com/video").valid, false);
  assert.equal(detectPlatform("https://tiktok.com:8443/video").valid, false);
});

test("rejects oversized input", () => {
  assert.equal(detectPlatform("https://tiktok.com/" + "a".repeat(2048)).valid, false);
});
