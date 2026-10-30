import test from "node:test";
import assert from "node:assert/strict";
import { getProvider, listProviders } from "../lib/provider-registry.js";
import capabilitiesHandler from "../api/capabilities.js";

function responseMock() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("registry exposes five platforms without falsely enabling downloads", () => {
  const providers = listProviders();
  assert.deepEqual(providers.map(item => item.platform), ["TikTok", "Kwai", "Instagram", "Facebook", "YouTube"]);
  for (const provider of providers) {
    assert.equal(provider.enabled, false);
    assert.equal(provider.status, "planned");
    assert.deepEqual(provider.supportedOperations, []);
  }
});

test("provider lookup returns defensive copies", () => {
  const provider = getProvider("YouTube");
  assert.equal(provider.id, "youtube");
  provider.supportedOperations.push("unexpected");
  assert.deepEqual(getProvider("YouTube").supportedOperations, []);
  assert.equal(getProvider("youtube"), null);
  assert.equal(getProvider("Unknown"), null);
});

test("capabilities endpoint returns provider status and safety policy", () => {
  const res = responseMock();
  capabilitiesHandler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.providers.length, 5);
  assert.equal(res.body.policy.downloadsRequireAuthorization, true);
  assert.equal(res.body.policy.bypassDrm, false);
});

test("capabilities endpoint rejects non-GET methods", () => {
  const res = responseMock();
  capabilitiesHandler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});
