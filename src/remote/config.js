const DEFAULT_HOST = String(process.env.TRAE_API_HOST || "core-normal.trae.ai").trim() || "core-normal.trae.ai";
const DEFAULT_REGION = String(process.env.TRAE_API_USER_REGION || "SG").trim() || "SG";
const DEFAULT_LANGUAGE = String(process.env.TRAE_API_LANGUAGE || "en").trim() || "en";
const DEFAULT_MODE = String(process.env.TRAE_API_MODE || "work").trim() || "work";
const DEFAULT_ENVIRONMENT_ID = String(process.env.TRAE_API_ENVIRONMENT_ID || "default").trim() || "default";
const DEFAULT_AGENT_TYPE = String(process.env.TRAE_API_AGENT_TYPE || "solo_work_remote").trim() || "solo_work_remote";
const DEFAULT_MODEL_SELECTION = String(process.env.TRAE_API_MODEL_SELECTION || "auto").trim() || "auto";
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAE_API_TIMEOUT_MS || 120000);
const DEFAULT_EVENTS_TIMEOUT_MS = Number(process.env.TRAE_API_EVENTS_TIMEOUT_MS || 180000);
const DEFAULT_AUTH_HEADER = "authorization";
const DEFAULT_AUTH_SCHEME = "Cloud-IDE-JWT";

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object") {
    return value;
  }
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function parseStringList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

function buildRemoteConfig(options = {}) {
  const authToken = String(options.authToken || process.env.TRAE_API_TOKEN || "").trim();
  const authHeader = String(options.authHeader || process.env.TRAE_API_AUTH_HEADER || DEFAULT_AUTH_HEADER)
    .trim()
    .toLowerCase();
  // Allow the caller to disable scheme prefixing by passing authScheme: "".
  const authSchemeDisabled = options.authScheme === null || options.authScheme === "";
  const authScheme = authSchemeDisabled
    ? ""
    : String(options.authScheme || process.env.TRAE_API_AUTH_SCHEME || DEFAULT_AUTH_SCHEME).trim();

  // If the token already contains an embedded prefix like
  // "Cloud-IDE-JWT eyJ...", pass it through verbatim. Otherwise prefix it.
  const lookup =
    String(authScheme || "").length > 0 ? new RegExp(`^\\s*${authScheme}\\s+`, "i") : null;
  const authValue = authSchemeDisabled
    ? authToken
    : authToken && lookup && lookup.test(authToken)
      ? authToken
      : authToken && authScheme
        ? `${authScheme} ${authToken}`
        : authToken;

  return {
    host: String(options.host || DEFAULT_HOST).trim() || DEFAULT_HOST,
    protocol: String(options.protocol || process.env.TRAE_API_PROTOCOL || "https").trim() || "https",
    basePath: String(options.basePath || process.env.TRAE_API_BASE_PATH || "/api/remote/v1").trim() || "/api/remote/v1",
    authToken,
    authHeader,
    authScheme,
    authValue,
    requiresAuth: Boolean(
      options.requiresAuth !== false &&
        (process.env.TRAE_API_REQUIRE_TOKEN === "1" ||
          process.env.TRAE_API_REQUIRE_AUTH === "1" ||
          Boolean(authToken) ||
          Boolean(options.requireToken))
    ),
    userRegion: String(options.userRegion || DEFAULT_REGION),
    language: String(options.language || DEFAULT_LANGUAGE),
    timezone: String(options.timezone || process.env.TRAE_API_USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"),
    clientType: String(options.clientType || process.env.TRAE_API_CLIENT_TYPE || "web").trim() || "web",
    mode: String(options.mode || DEFAULT_MODE).trim() || DEFAULT_MODE,
    environmentId: String(options.environmentId || DEFAULT_ENVIRONMENT_ID).trim() || DEFAULT_ENVIRONMENT_ID,
    agentType: String(options.agentType || DEFAULT_AGENT_TYPE).trim() || DEFAULT_AGENT_TYPE,
    modelSelectionStrategy: String(options.modelSelectionStrategy || DEFAULT_MODEL_SELECTION).trim() || DEFAULT_MODEL_SELECTION,
    modelName: String(options.modelName || process.env.TRAE_API_MODEL_NAME || "").trim(),
    agentId: String(options.agentId || process.env.TRAE_API_AGENT_ID || options.agentType || DEFAULT_AGENT_TYPE).trim() || DEFAULT_AGENT_TYPE,
    commonParams: parseJsonObject(options.commonParams || process.env.TRAE_API_COMMON_PARAMS, {}),
    requestTimeoutMs: Number(options.requestTimeoutMs || DEFAULT_TIMEOUT_MS),
    eventsTimeoutMs: Number(options.eventsTimeoutMs || DEFAULT_EVENTS_TIMEOUT_MS),
    pollIntervalMs: Number(options.pollIntervalMs || process.env.TRAE_API_POLL_INTERVAL_MS || 2500),
    userAgent: String(
      options.userAgent ||
        process.env.TRAE_API_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36"
    ),
    extraHeaders: parseJsonObject(options.extraHeaders || process.env.TRAE_API_EXTRA_HEADERS, {}),
    extraBodyFields: parseJsonObject(options.extraBodyFields || process.env.TRAE_API_EXTRA_BODY_FIELDS, {}),
    models: parseStringList(options.models || process.env.TRAE_API_MODELS, ["gpt-5.4", "deepseek-v4-flash", "gemini-3-pro"])
  };
}

function buildBaseUrl(config) {
  return `${config.protocol}://${config.host}${config.basePath}`;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_REGION,
  DEFAULT_LANGUAGE,
  DEFAULT_MODE,
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_AGENT_TYPE,
  DEFAULT_MODEL_SELECTION,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_EVENTS_TIMEOUT_MS,
  DEFAULT_AUTH_HEADER,
  buildBaseUrl,
  buildRemoteConfig
};