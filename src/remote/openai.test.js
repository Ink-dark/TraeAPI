const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createGatewayServer } = require("../http/gateway");
const { createTraeRemoteDriver } = require("./driver");
const { TraeRemoteClient } = require("./client");

function readResponseBody(response) {
  return new Promise((resolve) => {
    let data = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => (data += chunk));
    response.on("end", () => resolve(data));
  });
}

function createFakeRemoteClient() {
  const calls = [];
  const fake = {
    calls,
    async createSession({ content, title }) {
      calls.push({ kind: "createSession", content, title });
      return {
        chat_session_id: "session-123",
        status: 2,
        mode: "work",
        sandbox: { name: "run-agent-fake", allocation_status: 3, sandbox_type: "agent" }
      };
    },
    async getSession() {
      calls.push({ kind: "getSession" });
      return { chat_session_id: "session-123", status: 3 };
    },
    async listMessages() {
      calls.push({ kind: "listMessages" });
      return [];
    },
    async commitTitle() {
      calls.push({ kind: "commitTitle" });
      return { code: 0, message: "success" };
    },
    getSnapshot() {
      return { mode: "remote", host: "fake", hasToken: true };
    },
    async streamEvents(sessionId, onEvent) {
      calls.push({ kind: "streamEvents", sessionId });
      onEvent({ event: "metadata", data: { status: "in_progress" } });
      onEvent({ event: "model_config", data: { config_name: "gpt-5.4" } });
      onEvent({
        event: "plan_item",
        data: {
          thought: "thinking about reply",
          tool_call_info: { name: "finish", params: { summary: "Hello. How can I help?" } }
        }
      });
      onEvent({ event: "done", data: { status: "completed" } });
      return true;
    }
  };
  return fake;
}

function createMockRemoteDriver(options = {}) {
  const client = options.client || createFakeRemoteClient();
  const driver = createTraeRemoteDriver({ client, ...options });
  const original = driver.dispatchRequest;
  // attach the fake for assertions
  driver._client = client;
  return driver;
}

function sendJson(port, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: { "content-type": "application/json", ...(headers || {}) }
      },
      async (res) => {
        const text = await readResponseBody(res);
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (error) {
          json = null;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function sendRaw(port, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers: { ...(headers || {}) } },
      async (res) => {
        const text = await readResponseBody(res);
        resolve({ statusCode: res.statusCode, headers: res.headers, text });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("remote driver adapts the gateway session/message contract", async () => {
  const client = createFakeRemoteClient();
  const driver = createMockRemoteDriver({ client });
  const { server } = createGatewayServer({ automationDriver: driver });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const create = await sendJson(port, { method: "POST", path: "/v1/sessions", body: {} });
  assert.equal(create.statusCode, 201);
  const sessionId = create.json.data.session.sessionId;

  const send = await sendJson(port, {
    method: "POST",
    path: `/v1/sessions/${sessionId}/messages`,
    body: { content: "hello" }
  });
  assert.equal(send.statusCode, 200);
  assert.equal(send.json.data.result.response.text, "Hello. How can I help?");
  assert.ok(client.calls.some((c) => c.kind === "createSession" && c.content === "hello"));

  await new Promise((resolve) => server.close(resolve));
});

test("openai /v1/models and /v1/chat/completions routes are exposed when enabled", async () => {
  const client = createFakeRemoteClient();
  const driver = createMockRemoteDriver({ client });
  const { server } = createGatewayServer({
    automationDriver: driver,
    enableOpenAiEndpoints: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const models = await sendJson(port, { method: "GET", path: "/v1/models" });
  assert.equal(models.statusCode, 200);
  assert.equal(models.json.data.object, "list");
  assert.ok(models.json.data.data.length >= 1);

  const completion = await sendJson(port, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }
  });
  assert.equal(completion.statusCode, 200);
  assert.equal(completion.json.data.object, "chat.completion");
  assert.equal(completion.json.data.choices[0].message.content, "Hello. How can I help?");
  assert.equal(completion.json.data.choices[0].finish_reason, "stop");

  await new Promise((resolve) => server.close(resolve));
});

test("openai streaming /v1/chat/completions returns SSE chunks and [DONE]", async () => {
  const client = createFakeRemoteClient();
  const driver = createMockRemoteDriver({ client });
  const { server } = createGatewayServer({
    automationDriver: driver,
    enableOpenAiEndpoints: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const resp = await sendRaw(port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: true,
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(resp.statusCode, 200);
  assert.ok(resp.text.includes("chat.completion.chunk"));
  assert.ok(resp.text.includes("Hello. How can I help?"));
  assert.ok(resp.text.includes("data: [DONE]"));

  await new Promise((resolve) => server.close(resolve));
});

test("openai route returns 400 when no user message is present", async () => {
  const client = createFakeRemoteClient();
  const driver = createMockRemoteDriver({ client });
  const { server } = createGatewayServer({
    automationDriver: driver,
    enableOpenAiEndpoints: true
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const resp = await sendJson(port, {
    method: "POST",
    path: "/v1/chat/completions",
    body: { model: "gpt-5.4", messages: [] }
  });
  assert.equal(resp.statusCode, 400);
  assert.equal(resp.json.code, "INVALID_MESSAGE_CONTENT");

  await new Promise((resolve) => server.close(resolve));
});

test("openai routes are disabled unless enabled", async () => {
  const client = createFakeRemoteClient();
  const driver = createMockRemoteDriver({ client });
  const { server } = createGatewayServer({ automationDriver: driver });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const models = await sendJson(port, { method: "GET", path: "/v1/models" });
  assert.equal(models.statusCode, 404);

  await new Promise((resolve) => server.close(resolve));
});

test("real client getSnapshot reflects config without network", () => {
  const client = new TraeRemoteClient({ config: { host: "x", authToken: "t" } });
  const snap = client.getSnapshot();
  assert.equal(snap.mode, "remote");
  assert.equal(snap.hasToken, true);
});