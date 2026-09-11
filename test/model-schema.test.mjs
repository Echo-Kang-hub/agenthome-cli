import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MODEL_ROLES,
  canonicalJson,
  libraryFingerprint,
  maskSecret,
  modelsFile,
  normalizeProfile,
  projectModelFile,
  validateBaseUrl,
  validateEnvKey,
  validateModelId,
  validateProviderId,
} from "../packages/core/src/index.mjs";

const ENVIRONMENT = { AVENIC_STATE_DIR: path.join(os.tmpdir(), "avenic-schema-state") };

test("model file paths live under the existing Avenic state root", () => {
  assert.equal(modelsFile(ENVIRONMENT), path.join(ENVIRONMENT.AVENIC_STATE_DIR, "models.json"));
  assert.equal(projectModelFile("C:\\proj"), path.join("C:\\proj", ".agents", "model.json"));
});

test("normalizeProfile fills defaults, pins timestamps and strips unknown top-level keys", () => {
  const profile = normalizeProfile(
    {
      id: "mimo",
      name: "小米 MiMo",
      endpoint: { baseUrl: "https://example.com/anthropic", api: "anthropic", apiKey: "sk-abcdefghijklmn" },
      models: { main: { id: "mimo-v2.5-pro" } },
      unknownKey: "ignored",
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  assert.equal(profile.endpoint.authField, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(profile.id, "mimo");
  assert.equal(profile.createdAt, "2026-09-10T00:00:00.000Z");
  assert.equal(profile.updatedAt, "2026-09-10T00:00:00.000Z");
  assert.deepEqual(profile.toggles, {});
  assert.deepEqual(profile.env, {});
  assert.deepEqual(profile.overrides, {});
  assert.equal("unknownKey" in profile, false);
  assert.deepEqual(Object.keys(profile.models), ["main"]);
  assert.equal(profile.codex.providerId, "avenic_mimo");
  assert.equal(profile.codex.envKey, "AVENIC_MODEL_KEY");
  assert.equal(profile.codex.reasoningEffort, "medium");
  assert.equal(profile.opencode.providerId, "mimo");
  assert.equal(profile.opencode.npmAdapter, "@ai-sdk/openai-compatible");
});

test("normalizeProfile keeps createdAt when updating an existing profile", () => {
  const created = normalizeProfile({ id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "sk-1" } }, { now: "2026-01-01T00:00:00.000Z" });
  const updated = normalizeProfile({ ...created, name: "A2" }, { now: "2026-02-02T00:00:00.000Z", existing: created });
  assert.equal(updated.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.updatedAt, "2026-02-02T00:00:00.000Z");
  assert.equal(updated.name, "A2");
});

test("validation rejects cmd metacharacters, percent signs and empty values", () => {
  assert.equal(validateBaseUrl("https://gw.example/v1/api-version=2024-02-01"), "https://gw.example/v1/api-version=2024-02-01");
  assert.throws(() => validateBaseUrl("https://gw.example/v1?a=1&b=2"), /must not contain/i);
  assert.throws(() => validateBaseUrl("https://gw.example/v1?a=1%20b"), /must not contain/i);
  assert.throws(() => validateBaseUrl("https://gw.example/v1`x"), /must not contain/i);
  assert.throws(() => validateBaseUrl("not-a-url"), /must start with http/i);
  assert.equal(validateProviderId("avenic_mimo"), "avenic_mimo");
  assert.throws(() => validateProviderId("MiMo-Dash"), /provider id/i);
  assert.equal(validateEnvKey("AVENIC_MODEL_KEY"), "AVENIC_MODEL_KEY");
  assert.throws(() => validateEnvKey("modelKey"), /environment variable/i);
  assert.equal(validateModelId("mimo-v2.5-pro"), "mimo-v2.5-pro");
  assert.throws(() => validateModelId("mimo v2"), /model id/i);
});

test("maskSecret keeps three leading and four trailing characters", () => {
  assert.equal(maskSecret("sk-1234567890abcd"), "sk-…abcd");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(undefined), "");
  // 长度边界：<=8 全掩，9 起前 3 后 4
  assert.equal(maskSecret("12345678"), "••••");
  assert.equal(maskSecret("123456789"), "123…6789");
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(1234), "");
});

test("canonicalJson sorts keys recursively and libraryFingerprint is stable", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  const profile = normalizeProfile({ id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "sk-1" }, models: { main: { id: "m" } } }, { now: "2026-01-01T00:00:00.000Z" });
  assert.equal(libraryFingerprint(profile), libraryFingerprint({ ...profile }));
  assert.notEqual(libraryFingerprint(profile), libraryFingerprint({ ...profile, models: { main: { id: "other" } } }));
  assert.equal(libraryFingerprint(profile).startsWith("sha256:"), true);
  assert.deepEqual(MODEL_ROLES, ["main", "opus", "sonnet", "haiku", "fable", "subagent"]);
});

test("canonicalJson normalizes non-JSON values and empty containers", () => {
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"a":null,"b":1}');
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson([1, undefined, "x"]), '[1,null,"x"]');
});

test("libraryFingerprint ignores identity/timestamps but tracks every projected surface", () => {
  const profile = normalizeProfile(
    {
      id: "a",
      name: "A",
      endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "sk-1" },
      models: { main: { id: "m" } },
      toggles: { teams: true },
      env: { FOO: "1" },
      claude: { settings: { theme: "dark" } },
    },
    { now: "2026-01-01T00:00:00.000Z" },
  );
  const base = libraryFingerprint(profile);
  assert.equal(libraryFingerprint({ ...profile, name: "Renamed" }), base);
  assert.equal(libraryFingerprint({ ...profile, createdAt: "2000-01-01T00:00:00.000Z" }), base);
  assert.equal(libraryFingerprint({ ...profile, updatedAt: "2030-12-31T23:59:59.999Z" }), base);
  assert.notEqual(libraryFingerprint({ ...profile, endpoint: { ...profile.endpoint, baseUrl: "https://b.example" } }), base);
  assert.notEqual(libraryFingerprint({ ...profile, models: { main: { id: "m2" } } }), base);
  assert.notEqual(libraryFingerprint({ ...profile, toggles: {} }), base);
  assert.notEqual(libraryFingerprint({ ...profile, env: { FOO: "2" } }), base);
  assert.notEqual(libraryFingerprint({ ...profile, claude: { settings: {} } }), base);
});
