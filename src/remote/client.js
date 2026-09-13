const { RemoteApiError } = require("./errors");
const { buildRemoteConfig, buildBaseUrl } = require("./config");

const DEFAULT_PAGE_SIZE = 20;

function createHeaders(config, extra = {}) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: `https://${config.host}`.replace(/:.*$/, ""),
    referer: `https://${config.host}/`,
    "user-agent": config.userAgent,
    "x-preferenced-language": config.language,
    "x-trae-client-type": config.clientType,
    "x-trae-user-timezone": config.timezone,
    "x-user-region": config.userRegion,
    ...config.extraHeaders
  };
  headers.origin = config.origin || headers.origin;
  headers.referer = config.referer || headers.referer;
  if (config.authToken) {
    headers[config.authHeader] = config.authToken;
  }
  return {
    ...headers,
    ...extra
  };
}

function buildQuery(content) {
  return JSON.stringify([
    {
      type: "text",
      data: {
        content
      }
    }
  ]);
}

function buildCommonParamsJson(config) {
  const base = {
    language: config.language,
    app_language: config.language,
    quality: "stable",
    user_identity: "Free",
    solo_chat_mode: config.mode,
    scope: config.scope || "marscode-us",
    tenant: config.tenant || "marscode",
    region: config.region || "Singapore-Central",
    aiRegion: config.aiRegion || "Singapore-Central"
  };
  return JSON.stringify({
    ...base,
    ...config.commonParams
  });
}

class TraeRemoteClient {
  constructor(options = {}) {
    this.config =
      options.config ||
      buildRemoteConfig(options);
    this.options = options;
    this.baseUrl = buildBaseUrl(this.config);
  }

  _assertAuthed() {
    if (this.config.requiresAuth && !this.config.authToken) {
      throw new RemoteApiError(
        "REMOTE_TOKEN_MISSING",
        "TRAE_API_TOKEN is required for the remote backend (set it to your session JWT from GetUserToken)"
      );
    }
  }

  async _request(method, path, { query = {}, body, headers = {}, acceptSse = false } = {}) {
    this._assertAuthed();
    const params = new URLSearchParams(
      Object.entries(query).reduce((acc, [key, value]) => {
        if (value !== undefined && value !== null) {
          acc[key] = String(value);
        }
        return acc;
      }, {})
    );
    const search = params.toString();
    const url = `${this.baseUrl}${path}${search ? `?${search}` : ""}`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    const requestInit = {
      method,
      headers: {
        ...createHeaders(this.config, headers),
        ...(acceptSse ? { accept: "text/event-stream" } : {})
      },
      signal: controller.signal
    };
    if (body !== undefined) {
      requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    try {
      const response = await fetch(url, requestInit);
      if (!response.ok) {
        throw new RemoteApiError(
          "REMOTE_HTTP_STATUS",
          `Trae API returned HTTP ${response.status} for ${method} ${path}`,
          { status: response.status, path, host: this.config.host }
        );
      }
      if (acceptSse) {
        return response;
      }
      return await response.json();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new RemoteApiError(
          "REMOTE_TIMEOUT",
          `Trae API timed out after ${this.config.requestTimeoutMs}ms for ${method} ${path}`,
          { path }
        );
      }
      if (error instanceof RemoteApiError) {
        throw error;
      }
      throw new RemoteApiError("REMOTE_REQUEST_FAILED", `Failed to call Trae API: ${error.message}`, {
        path
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async createSession({ content, title, extraBodyFields = {} } = {}) {
    const body = {
      mode: this.config.mode,
      environment_id: this.config.environmentId,
      initial_message: {
        chat_session_id: "",
        content: [],
        query: buildQuery(content || ""),
        model_name: this.config.modelName,
        agent_type: this.config.agentType,
        agent_id: this.config.agentId,
        model_selection_strategy: this.config.modelSelectionStrategy,
        common_params: buildCommonParamsJson(this.config)
      },
      env: "remote",
      auto_create_env: false,
      ...extraBodyFields,
      ...this.config.extraBodyFields
    };
    const json = await this._request("POST", "/chat_sessions", { body });
    if (json && json.code !== undefined && json.code !== 0) {
      throw new RemoteApiError(
        "REMOTE_API_ERROR",
        `Trae API rejected createSession: ${json.message || json.code}`,
        { code: json.code }
      );
    }
    const data = json && json.data ? json.data : json;
    if (!data || !data.chat_session_id) {
      throw new RemoteApiError("REMOTE_NO_SESSION_ID", "Trae createSession returned no chat_session_id", {
        payload: data
      });
    }
    // Best-effort commit of the conversation title.
    if (title) {
      try {
        await this.commitTitle(data.chat_session_id, title);
      } catch (error) {
        // Title commit is non-fatal.
      }
    }
    return data;
  }

  async getSession(sessionId) {
    const json = await this._request("GET", `/chat_sessions/${encodeURIComponent(sessionId)}`);
    return json && json.data ? json.data : json;
  }

  async listMessages(sessionId, pageSize = DEFAULT_PAGE_SIZE) {
    const json = await this._request("GET", `/chat_sessions/${encodeURIComponent(sessionId)}/messages`, {
      query: { page_size: pageSize }
    });
    const data = json && json.data ? json.data : json;
    return Array.isArray(data) ? data : Array.isArray(data && data.items) ? data.items : [];
  }

  async commitTitle(sessionId, title) {
    const json = await this._request("POST", `/chat_sessions/${encodeURIComponent(sessionId)}/commit`, {
      body: { title: String(title || "") }
    });
    if (json && json.code !== undefined && json.code !== 0) {
      throw new RemoteApiError("REMOTE_API_ERROR", `Trae commitTitle rejected: ${json.message || json.code}`, {
        code: json.code
      });
    }
    return json;
  }

  async streamEvents(sessionId, onEvent, { onClientClose } = {}) {
    this._assertAuthed();
    const path = `/chat_sessions/${encodeURIComponent(sessionId)}/events`;
    const params = new URLSearchParams({ reply_to_message_id: "" });
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.config.eventsTimeoutMs);
    const requestInit = {
      method: "GET",
      headers: {
        ...createHeaders(this.config),
        accept: "text/event-stream"
      },
      signal: controller.signal
    };

    let stream = null;
    try {
      const response = await fetch(url, requestInit);
      if (!response.ok) {
        throw new RemoteApiError(
          "REMOTE_HTTP_STATUS",
          `Trae events endpoint returned HTTP ${response.status}`,
          { status: response.status, path }
        );
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new RemoteApiError("REMOTE_SSE_UNSUPPORTED", "The Trae events endpoint did not return a readable stream");
      }

      stream = {
        url,
        response,
        controller,
        _heldTimeout: timeoutHandle,
        async close() {
          try {
            controller.abort();
          } catch (error) {
            // Ignore already-aborted streams.
          }
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resolved = false;

      const emit = (fn, payload) => {
        if (typeof fn === "function") {
          try {
            fn(payload);
          } catch (error) {
            // Observer errors must not kill the stream loop.
          }
        }
      };

      while (!resolved) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (controller.signal.aborted) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = extractSseBlocks(buffer);
        buffer = events.remainder;

        if (events.blocks.length === 0) {
          continue;
        }

        for (const block of events.blocks) {
          if (controller.signal.aborted) {
            resolved = true;
            break;
          }
          const event = parseSseBlock(block);
          if (!event) {
            continue;
          }
          emit(onEvent, event);
          if (event.event === "done") {
            const status = event.data && event.data.status;
            if (status === "completed" || status === "error" || status === "failed") {
              resolved = true;
              break;
            }
          }
        }
      }

      return resolved;
    } catch (error) {
      if (error && error.name === "AbortError") {
        const abortedError = new RemoteApiError("REMOTE_STREAM_TIMEOUT", "The Trae events stream timed out or was aborted");
        if (onClientClose) {
          emit(onClientClose, abortedError);
        }
        return false;
      }
      if (onClientClose) {
        emit(onClientClose, error);
      }
      if (error instanceof RemoteApiError) {
        throw error;
      }
      throw new RemoteApiError("REMOTE_STREAM_FAILED", "Failed to consume the Trae events stream");
    } finally {
      clearTimeout(timeoutHandle);
      if (stream && typeof stream.close === "function") {
        try {
          stream.controller = controller;
          // Ensure the controller aborts so no sockets leak.
          controller.abort();
        } catch (error) {
          // Ignore.
        }
      }
    }
  }

  getSnapshot() {
    return {
      mode: "remote",
      host: this.config.host,
      baseUrl: this.baseUrl,
      hasToken: Boolean(this.config.authToken),
      requiresAuth: this.config.requiresAuth,
      modeName: this.config.mode,
      agentType: this.config.agentType
    };
  }
}

function extractSseBlocks(text) {
  const blocks = [];
  const raw = String(text || "");
  let markerIndex = raw.indexOf("\n\n");
  let cursor = 0;
  while (markerIndex >= 0) {
    const chunk = raw.slice(cursor, markerIndex);
    if (chunk.trim()) {
      blocks.push(chunk);
    }
    cursor = markerIndex + 2;
    markerIndex = raw.indexOf("\n\n", cursor);
    if (blocks.length > 512) {
      break;
    }
  }
  return {
    blocks,
    remainder: raw.slice(cursor)
  };
}

function parseSseBlock(block) {
  let event = null;
  let id = null;
  const dataParts = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice("id:".length).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice("data:".length).replace(/^ /, ""));
    } else if (line.startsWith(":")) {
      // Comment line; ignore.
    }
  }
  if (!event) {
    return null;
  }
  const dataText = dataParts.join("\n");
  let data = null;
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch (error) {
      data = { raw: dataText };
    }
  }
  return { event, id, data };
}

// Extracts the final assistant answer and optional reasoning from a streamed
// event sequence (TraeWork web protocol). The plain "hello" exchange answers
// through plan_item whose tool_call_info.name === "finish"; params.summary
// carries the reply text.
function summarizeStreamEvents(events = []) {
  let text = "";
  let reasoning = "";
  let status = "pending";
  let model = null;
  let tokenUsage = null;
  const planItems = [];

  for (const evt of events) {
    if (!evt) {
      continue;
    }
    if (evt.data && typeof evt.data !== "object") {
      continue;
    }
    const d = evt.data || {};
    switch (evt.event) {
      case "metadata":
        if (!status || status === "pending") {
          status = d.status === "in_progress" ? "running" : status || "pending";
        }
        break;
      case "done":
        if (d.status) {
          status = d.status === "completed" ? "completed" : d.status;
        }
        break;
      case "model_config":
        model = d.config_name || d.model_name || model;
        break;
      case "plan_item": {
        const tool = d.tool_call_info || {};
        const name = String(tool.name || "");
        if (name === "finish") {
          const params = tool.params && typeof tool.params === "object" ? tool.params : {};
          if (typeof params.summary === "string" && params.summary) {
            text = params.summary;
          }
        } else {
          planItems.push(d);
          const thought = String(d.thought || "");
          const reasoningText = String(d.reasoning_content || "");
          if (reasoningText) {
            reasoning = reasoningText;
          } else if (thought && !reasoning) {
            reasoning = thought;
          }
        }
        break;
      }
      case "token_usage":
        tokenUsage = d;
        break;
      default:
        break;
    }
  }

  if (!text) {
    // Fallback: prefer the last non-empty plan_item thought when no final
    // finish tool surfaced.
    for (const item of planItems) {
      const thought = String(item.thought || "").trim();
      if (thought) {
        text = thought;
      }
    }
  }

  return {
    text,
    reasoning,
    status: status || "pending",
    model,
    tokenUsage
  };
}

module.exports = {
  TraeRemoteClient,
  buildCommonParamsJson,
  buildQuery,
  createHeaders,
  extractSseBlocks,
  parseSseBlock,
  summarizeStreamEvents
};