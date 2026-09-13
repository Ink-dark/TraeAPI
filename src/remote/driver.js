const { randomUUID } = require("node:crypto");
const { TraeRemoteClient, summarizeStreamEvents } = require("./client");
const { buildRemoteConfig } = require("./config");
const { normalizeRemoteError, RemoteApiError } = require("./errors");

function createTraeRemoteDriver(options = {}) {
  const config =
    options.config ||
    buildRemoteConfig(options);
  const client =
    options.client ||
    (options.createClient
      ? options.createClient(config)
      : new TraeRemoteClient({ config }));
  const now = typeof options.now === "function" ? options.now : Date.now;
  let queue = Promise.resolve();
  let queuedCount = 0;
  let lastReadiness = {
    ready: false,
    mode: "remote"
  };

  async function runRequest(requestId, payload = {}) {
    const startedAt = new Date().toISOString();
    const body = payload.body || {};
    const content = String(body.content || "").trim();
    if (!content) {
      throw new RemoteApiError("INVALID_MESSAGE_CONTENT", "content must be a non-empty string");
    }
    const title = String(body.title || content).slice(0, 64);
    const channel = payload.channel || "trae:conversation:send";

    const session = await client.createSession({
      content,
      title
    });
    const sessionId = session.chat_session_id;

    const events = [];
    const chunks = [];
    let collectedText = "";

    const emit = (event) => {
      events.push(event);
      if (typeof payload.onEvent === "function") {
        try {
          payload.onEvent(event);
        } catch (error) {
          // Observer errors never kill the request.
        }
      }
      if (event.type === "delta" || event.type === "replace") {
        if (event.data) {
          chunks.push(event.data);
          collectedText += event.data;
        }
      }
    };

    // Consume the SSE stream; summarize its final answer.
    const sseEvents = [];
    await client.streamEvents(sessionId, (sseEvent) => {
      sseEvents.push(sseEvent);
    }, {});
    const summary = summarizeStreamEvents(sseEvents);

    if (summary.text) {
      emit({
        type: chunks.length ? "delta" : "replace",
        data: summary.text,
        source: "remote",
        requestId,
        channel
      });
    }
    emit({ type: "done", requestId, channel });

    return {
      status: "ok",
      requestId,
      channel,
      startedAt,
      finishedAt: new Date().toISOString(),
      events,
      chunks,
      response: {
        text: summary.text || ""
      },
      session: session || null,
      summary: summary || null
    };
  }

  function enqueueOperation(operation) {
    queuedCount += 1;
    const queued = queue.then(operation, operation);
    queue = queued.catch(() => {});
    return queued.finally(() => {
      queuedCount = Math.max(0, queuedCount - 1);
    });
  }

  return {
    async getReadiness() {
      const ready = Boolean(config.authToken) || !config.requiresAuth;
      lastReadiness = {
        ready,
        mode: "remote",
        host: config.host,
        details: {
          hasToken: Boolean(config.authToken),
          requiresAuth: config.requiresAuth,
          agentType: config.agentType,
          modeName: config.mode
        }
      };
      if (!ready) {
        lastReadiness.error = {
          code: "REMOTE_TOKEN_MISSING",
          message: "Set TRAE_API_TOKEN to the TraeWork session JWT"
        };
      }
      return lastReadiness;
    },
    getSnapshot() {
      const clientSnapshot =
        typeof client.getSnapshot === "function" ? client.getSnapshot() : {};
      return {
        mode: "remote",
        queuedRequestCount: queuedCount,
        lastReadiness,
        ...clientSnapshot
      };
    },
    normalizeError(error, fallbackCode = "REMOTE_ERROR") {
      return normalizeRemoteError(error, fallbackCode);
    },
    dispatchRequest(payload = {}) {
      const requestId = payload.requestId || randomUUID();
      const response = enqueueOperation(() => runRequest(requestId, payload));
      return { requestId, response };
    }
  };
}

module.exports = {
  createTraeRemoteDriver
};