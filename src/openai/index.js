const { randomUUID } = require("node:crypto");
const { RemoteApiError } = require("../remote/errors");

const DEFAULT_MODEL = "gpt-5.4";

// Core OpenAI helpers -----------------------------------------------------

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildChatCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function nowCreated() {
  return Math.floor(Date.now() / 1000);
}

function normalizeMessages(messages = []) {
  const cleaned = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = String(message.role || "").toLowerCase();
    const content = extractMessageContent(message.content);
    if (!role || !content) {
      continue;
    }
    cleaned.push({ role, content });
  }
  return cleaned;
}

function extractMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      if (typeof part.text === "string") {
        parts.push(part.text.trim());
      } else if (part.type === "text" && typeof part.text_content === "string") {
        parts.push(part.text_content.trim());
      }
    }
    return parts.filter(Boolean).join("\n").trim();
  }
  return "";
}

function pickPrompt(messages = []) {
  const last = [...messages].filter((m) => m && m.role === "user").pop();
  return last ? String(last.content || "") : "";
}

// Route handlers ----------------------------------------------------------

async function handleListModels(req, res, options = {}) {
  const { apiMeta, driver } = options;
  const models = [];
  if (driver && typeof driver.getSnapshot === "function") {
    const snapshot = driver.getSnapshot();
    if (snapshot && Array.isArray(snapshot.models)) {
      for (const name of snapshot.models) {
        models.push({ id: name, object: "model", created: nowCreated(), owned_by: "trae" });
      }
    }
  }
  if (models.length === 0) {
    models.push({ id: DEFAULT_MODEL, object: "model", created: nowCreated(), owned_by: "trae" });
  }
  writeJsonResult(res, 200, { object: "list", data: models }, apiMeta);
}

function writeJsonResult(res, statusCode, payload, apiMeta = {}) {
  const body = {
    success: true,
    code: "OK",
    data: payload,
    meta: {
      requestId: apiMeta.requestId || null,
      idempotencyKey: apiMeta.idempotencyKey || null
    }
  };
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeOpenAiError(res, error, apiMeta = {}) {
  const status = Number(error.statusCode || error.status || error.details?.status || 500);
  const code = error.code || (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST");
  const message = error.message || "Internal server error";
  const body = {
    success: false,
    code,
    message,
    details: error.details || {},
    meta: {
      requestId: apiMeta.requestId || null
    }
  };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleChatCompletions(req, res, options = {}) {
  const { driver, apiMeta } = options;
  // We need the driver which matches dispatchRequest contract.
  const body = req.__parsedJsonBody || {};
  const requestedStream = body.stream === true || body.stream === "true";

  const messages = normalizeMessages(body.messages);
  const prompt = pickPrompt(messages);
  if (!prompt) {
    const invalidError = new RemoteApiError("INVALID_MESSAGE_CONTENT", "messages must include at least one non-empty user message");
    invalidError.statusCode = 400;
    throw invalidError;
  }
  const model = String(body.model || DEFAULT_MODEL);

  if (!driver || typeof driver.dispatchRequest !== "function") {
    const unavailableError = new RemoteApiError("REMOTE_DRIVER_UNAVAILABLE", "Remote driver is unavailable");
    unavailableError.statusCode = 503;
    throw unavailableError;
  }
  const readiness = await driver.getReadiness();
  if (!readiness.ready) {
    const error = new RemoteApiError(
      (readiness.error && readiness.error.code) || "AUTOMATION_NOT_READY",
      (readiness.error && readiness.error.message) || "Trae API is not ready"
    );
    error.statusCode = 503;
    throw error;
  }

  const dispatched = driver.dispatchRequest({
    channel: requestedStream ? "trae:conversation:stream" : "trae:conversation:send",
    body: {
      sessionId: null,
      content: prompt,
      title: String(body.title || ""),
      metadata: body.metadata || {},
      model: model,
      messages: messages
    },
    onEvent(event) {
      if (requestedStream && typeof options.onUpstreamEvent === "function") {
        options.onUpstreamEvent(event);
      }
    }
  });

  const result = await dispatched.response;

  if (!requestedStream) {
    const text = (result && result.response && result.response.text) || "";
    const output = buildNonStreamCompletion({
      id: buildChatCompletionId(),
      model,
      text,
      usage: result && result.summary ? result.summary.tokenUsage : null
    });
    writeJsonResult(res, 200, output, apiMeta);
    return;
  }

  // Streaming path: emit an OpenAI chat.completion.chunk sequence.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const completionId = buildChatCompletionId();
  const created = nowCreated();
  const choicesStream = {
    index: 0,
    delta: { role: "assistant", content: "" },
    finish_reason: null
  };
  const roleChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [choicesStream]
  };
  writeSseEvent(res, roleChunk);

  const startChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content: "" }, finish_reason: null }]
  };
  writeSseEvent(res, startChunk);

  const text = (result && result.response && result.response.text) || "";
  if (text) {
    const contentChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    };
    writeSseEvent(res, contentChunk);
  }

  const doneChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  };
  writeSseEvent(res, doneChunk);
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildNonStreamCompletion({ id, model, text, usage }) {
  const choices = [
    {
      index: 0,
      message: {
        role: "assistant",
        content: text
      },
      finish_reason: "stop"
    }
  ];
  const builtUsage = usage && typeof usage === "object"
    ? {
        prompt_tokens: Number(usage.prompt_tokens || usage.input || 0),
        completion_tokens: Number(usage.completion_tokens || usage.output || 0),
        total_tokens: Number(
          (usage.prompt_tokens || usage.input || 0) + (usage.completion_tokens || usage.output || 0)
        )
      }
    : null;
  return {
    id,
    object: "chat.completion",
    created: nowCreated(),
    model,
    choices,
    usage: builtUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

module.exports = {
  DEFAULT_MODEL,
  buildChatCompletionId,
  buildNonStreamCompletion,
  extractMessageContent,
  handleChatCompletions,
  handleListModels,
  normalizeMessages,
  nowCreated,
  pickPrompt,
  writeJsonResult,
  writeOpenAiError,
  writeSseEvent
};