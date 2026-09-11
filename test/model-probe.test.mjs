import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { PRESETS, applyPreset, normalizeProfile, testConnection } from "../packages/core/src/index.mjs";

const SECRET = "sk-test-1234567890";
const NOW = "2026-09-10T00:00:00.000Z";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function profileFor(baseUrl, api = "anthropic") {
  return normalizeProfile(
    { id: "p", name: "P", endpoint: { baseUrl, api, apiKey: SECRET }, models: { main: { id: "test-model" } } },
    { now: NOW },
  );
}

// 硬要求（spec §12.5 / §13）：密钥绝不进返回对象、message 或 url（url 也不得带 query 形式的密钥）。
function assertNoSecret(result) {
  assert.equal(JSON.stringify(result).includes(SECRET), false, "probe result must not contain the api key");
  assert.equal(String(result.message).includes(SECRET), false, "probe message must not contain the api key");
  assert.equal(String(result.url ?? "").includes(SECRET), false, "probe url must not contain the api key");
}

function responding(seen) {
  return (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  };
}

test("presets only prefill connection fields", () => {
  assert.equal(PRESETS.length, 6);
  for (const preset of PRESETS) {
    assert.equal(typeof preset.baseUrl, "string");
    assert.equal("models" in preset, false);
    assert.equal("apiKey" in preset, false);
  }
  assert.deepEqual(Object.keys(applyPreset(PRESETS[0].id)).sort(), ["api", "baseUrl", "id", "label"]);
  // 六个 baseUrl / api 逐字来自计划 :2455-2462，实现不得自行改动（服务商模型 ID 不预填）。
  assert.deepEqual(
    Object.fromEntries(PRESETS.map((preset) => [preset.id, [preset.baseUrl, preset.api]])),
    {
      anthropic: ["https://api.anthropic.com", "anthropic"],
      "xiaomi-mimo": ["https://token-plan-cn.xiaomimimo.com/anthropic", "anthropic"],
      "moonshot-kimi": ["https://api.moonshot.cn/anthropic", "anthropic"],
      zhipu: ["https://open.bigmodel.cn/api/anthropic", "anthropic"],
      deepseek: ["https://api.deepseek.com", "openai-chat"],
      openai: ["https://api.openai.com/v1", "openai-responses"],
    },
  );
  assert.equal(applyPreset("nope"), null);
});

test("testConnection posts a minimal Anthropic request and reports success", async () => {
  const seen = [];
  await withServer(responding(seen), async (baseUrl) => {
    const base = profileFor(baseUrl);
    const result = await testConnection(base);
    assert.equal(result.ok, true);
    assert.equal(result.category, "2xx");
    assert.equal(result.status, 200);
    assert.equal(seen[0].url, "/v1/messages");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    // 计划测试原文断言 x-api-key，但默认 authField = ANTHROPIC_AUTH_TOKEN 走 Authorization: Bearer
    // （Anthropic 官方语义，也是 authField 存在的意义）——实现正确，此处按真实分支断言两个方向。
    assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(seen[0].headers["x-api-key"], undefined);
    assert.equal(seen[0].body.max_tokens, 1);
    assert.equal(seen[0].body.model, "test-model");
    assert.equal(result.model, "test-model");
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 1 });
    assertNoSecret(result);

    // 同一个 mock server 再发一次：ANTHROPIC_API_KEY 必须切到 x-api-key 且不带 Authorization。
    const keyed = { ...base, endpoint: { ...base.endpoint, authField: "ANTHROPIC_API_KEY" } };
    const keyedResult = await testConnection(keyed);
    assert.equal(keyedResult.ok, true);
    assert.equal(seen[1].headers["x-api-key"], SECRET);
    assert.equal(seen[1].headers.authorization, undefined);
    assertNoSecret(keyedResult);
  });
});

test("testConnection posts OpenAI-shaped requests for openai-chat and openai-responses", async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (baseUrl) => {
    await testConnection(profileFor(baseUrl, "openai-chat"));
    await testConnection(profileFor(baseUrl, "openai-responses"));
    assert.deepEqual(paths.map((entry) => entry.url), ["/v1/chat/completions", "/v1/responses"]);
    assert.equal(paths[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(paths[1].headers.authorization, `Bearer ${SECRET}`);
  });
});

test("testConnection does not duplicate an existing /v1 segment", async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (baseUrl) => {
    await testConnection(profileFor(`${baseUrl}/v1`));
    await testConnection(profileFor(baseUrl));
    await testConnection(profileFor(`${baseUrl}/`));
    await testConnection(profileFor(`${baseUrl}/v1/`));
    assert.deepEqual(paths, ["/v1/messages", "/v1/messages", "/v1/messages", "/v1/messages"]);
  });
});

test("testConnection classifies failures", async () => {
  const cases = [
    [401, "auth"],
    [403, "auth"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "server-error"],
  ];
  for (const [status, category] of cases) {
    await withServer((request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "nope" } }));
    }, async (baseUrl) => {
      const result = await testConnection(profileFor(baseUrl));
      assert.equal(result.ok, false);
      assert.equal(result.category, category);
      assert.equal(result.status, status);
      assert.equal(result.message.includes("连接失败 ≠ 密钥无效"), true);
      assertNoSecret(result);
      // spec §11 排查指引：404 的文案必须点名 /v1 段。
      if (status === 404) assert.equal(result.message.includes("/v1"), true);
    });
  }
});

test("testConnection classifies unreachable hosts and timeouts", async () => {
  const unreachable = await testConnection(profileFor("http://127.0.0.1:9/v1"));
  assert.equal(unreachable.category, "network");
  assert.equal(unreachable.status, null);
  assertNoSecret(unreachable);

  await withServer((request, response) => { /* never respond */ }, async (baseUrl) => {
    const result = await testConnection(profileFor(baseUrl), { timeoutMs: 200 });
    assert.equal(result.category, "timeout");
    assert.equal(result.ok, false);
    assertNoSecret(result);
  });
});

test("testConnection stops before any request when the profile has no main model", async () => {
  let requestCount = 0;
  await withServer((request, response) => { requestCount += 1; }, async (baseUrl) => {
    const profile = normalizeProfile(
      { id: "p", name: "P", endpoint: { baseUrl, api: "anthropic", apiKey: SECRET } },
      { now: NOW },
    );
    assert.equal(profile.models.main, undefined);
    const result = await testConnection(profile, { timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.equal(result.url, null);
    assert.equal(result.status, null);
    assert.equal(result.message.includes("主模型"), true);
    assert.equal(requestCount, 0);
    assertNoSecret(result);
  });
});

test("testConnection takes the endpoint from options.endpoint when provided", async () => {
  const seen = [];
  await withServer(responding(seen), async (baseUrl) => {
    // profile 指向不可达端口：若实现未采用 options.endpoint，这条必然红。
    const profile = profileFor("http://127.0.0.1:9/v1");
    const result = await testConnection(profile, {
      endpoint: { ...profile.endpoint, baseUrl, authField: "ANTHROPIC_API_KEY" },
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/v1/messages");
    assert.equal(seen[0].headers["x-api-key"], SECRET);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(result.url, `${baseUrl}/v1/messages`);
    assertNoSecret(result);
  });
});

test("testConnection falls back to options.model when the profile has no main model", async () => {
  const seen = [];
  await withServer(responding(seen), async (baseUrl) => {
    const profile = normalizeProfile(
      { id: "p", name: "P", endpoint: { baseUrl, api: "anthropic", apiKey: SECRET } },
      { now: NOW },
    );
    const result = await testConnection(profile, { model: "fallback-model" });
    assert.equal(result.ok, true);
    assert.equal(seen[0].body.model, "fallback-model");
    assert.equal(result.model, "test-model");
    assertNoSecret(result);
  });
});

test("testConnection accepts an injected fetch and touches no real port", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
      hasSignal: init.signal instanceof AbortSignal,
    });
    return { status: 200, text: async () => JSON.stringify({ model: "fake-model", usage: { input_tokens: 2, output_tokens: 0 } }) };
  };
  const result = await testConnection(profileFor("http://127.0.0.1:9/v1"), { fetch: fakeFetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://127.0.0.1:9/v1/messages");
  assert.deepEqual(calls[0].body, { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].hasSignal, true);
  assert.equal(result.ok, true);
  assert.equal(result.model, "fake-model");
  assertNoSecret(result);
});

test("testConnection classifies boundary statuses 199/204/301", async () => {
  await withServer((request, response) => {
    response.writeHead(204, { "content-type": "application/json" });
    response.end();
  }, async (baseUrl) => {
    const result = await testConnection(profileFor(baseUrl));
    assert.equal(result.ok, true);
    assert.equal(result.category, "2xx");
    assert.equal(result.status, 204);
    assertNoSecret(result);
  });

  // 301 不属于 2xx/auth/404/429/5xx → 计划的取舍是落入 server-error 兜底（名字不精确但如实钉死）。
  await withServer((request, response) => {
    response.writeHead(301, { "content-type": "application/json" });
    response.end("{}");
  }, async (baseUrl) => {
    const result = await testConnection(profileFor(baseUrl));
    assert.equal(result.ok, false);
    assert.equal(result.category, "server-error");
    assert.equal(result.status, 301);
    assertNoSecret(result);
  });

  // 199 是 1xx：undici 视其为 informational、永远不当作最终响应交付（本地实测会挂起），
  // 故通过注入 fetch 的契约钉 categoryFor 的兜底分支。
  const result = await testConnection(profileFor("http://127.0.0.1:9/v1"), {
    fetch: async () => ({ status: 199, text: async () => "" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, "server-error");
  assert.equal(result.status, 199);
  assertNoSecret(result);
});

test("testConnection clears its timeout timer so the process can exit promptly", async () => {
  const moduleUrl = new URL("../packages/core/src/index.mjs", import.meta.url).href;
  const script = `
    import http from "node:http";
    const { normalizeProfile, testConnection } = await import(${JSON.stringify(moduleUrl)});
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "m" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    const profile = normalizeProfile({ id: "p", name: "P", endpoint: { baseUrl, api: "anthropic", apiKey: ${JSON.stringify(SECRET)} }, models: { main: { id: "m" } } });
    const result = await testConnection(profile, { timeoutMs: 8000 });
    console.log(result.category);
    await new Promise((resolve) => server.close(resolve));
  `;
  const startedAt = Date.now();
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { timeout: 30_000 }, (error, out, err) => {
      if (error) reject(new Error(`${error.message}\n${err}`));
      else resolve(out);
    });
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(stdout.trim(), "2xx");
  assert.equal(stdout.includes(SECRET), false);
  // 8s 的看门定时器若未 clear，子进程要等它触发才退出（elapsed ≈ 8s）。
  assert.equal(elapsed < 4000, true, `child took ${elapsed} ms with an 8s timeout - timer leaked`);
});
