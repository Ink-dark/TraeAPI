const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractSseBlocks,
  parseSseBlock,
  summarizeStreamEvents,
  buildCommonParamsJson,
  buildQuery
} = require("./client");
const { buildRemoteConfig } = require("./config");
const { normalizeRemoteError, RemoteApiError } = require("./errors");

test("buildRemoteConfig parses env and defaults", () => {
  const config = buildRemoteConfig({
    host: "core-normal.trae.ai",
    authToken: "jwt-token",
    mode: "work",
    agentType: "solo_work_remote"
  });
  assert.equal(config.host, "core-normal.trae.ai");
  assert.equal(config.authToken, "jwt-token");
  assert.equal(config.authHeader, "authorization");
  assert.equal(config.basePath, "/api/remote/v1");
  assert.equal(config.mode, "work");
  assert.equal(config.requiresAuth, true);
  assert.equal(config.models.length > 0, true);
});

test("buildQuery and buildCommonParamsJson produce the HAR-shaped payload", () => {
  const config = buildRemoteConfig({});
  assert.deepEqual(JSON.parse(buildQuery("hello")), [
    { type: "text", data: { content: "hello" } }
  ]);
  const common = JSON.parse(buildCommonParamsJson(config));
  assert.equal(common.language, "en");
  assert.equal(common.user_identity, "Free");
  assert.equal(common.solo_chat_mode, "work");
});

test("extractSseBlocks splits on blank lines and keeps remainder", () => {
  const input = `event: metadata\ndata: {"a":1}\n\nevent: done\ndata: {"b":2}\n\npartial`;
  const { blocks, remainder } = extractSseBlocks(input);
  assert.equal(blocks.length, 2);
  assert.equal(remainder, "partial");
});

test("parseSseBlock parses event/data", () => {
  const parsed = parseSseBlock('event: plan_item\ndata: {"x": 1}');
  assert.equal(parsed.event, "plan_item");
  assert.deepEqual(parsed.data, { x: 1 });
});

test("summarizeStreamEvents extracts full answer from finish tool and status done", () => {
  const events = [
    { event: "metadata", data: { status: "in_progress" } },
    { event: "model_config", data: { config_name: "gpt-5.4" } },
    {
      event: "plan_item",
      data: {
        thought: "I will greet",
        tool_call_info: { name: "finish", params: { summary: "Hello. How can I help?" } }
      }
    },
    { event: "done", data: { status: "completed" } }
  ];
  const summary = summarizeStreamEvents(events);
  assert.equal(summary.text, "Hello. How can I help?");
  assert.equal(summary.status, "completed");
  assert.equal(summary.model, "gpt-5.4");
});

test("summarizeStreamEvents extracts non-finish thought as reasoning", () => {
  const events = [
    {
      event: "plan_item",
      data: { thought: "reasoning text", tool_call_info: { name: "edit_file", params: {} } }
    }
  ];
  const summary = summarizeStreamEvents(events);
  assert.equal(summary.reasoning, "reasoning text");
});

test("normalizeRemoteError wraps unknown errors and preserves codes", () => {
  const direct = new RemoteApiError("REMOTE_TIMEOUT", "boom");
  assert.equal(normalizeRemoteError(direct).code, "REMOTE_TIMEOUT");
  // Generic errors keep their message; missing codes fall back.
  const generic = normalizeRemoteError(new Error("oops"), "FALLBACK");
  assert.equal(generic.code, "FALLBACK");
  assert.equal(generic.message, "oops");
  // A undefined error falls back on both.
  const empty = normalizeRemoteError(undefined, "EMPTY", "nothing");
  assert.equal(empty.code, "EMPTY");
  assert.equal(empty.message, "nothing");
});