class RemoteApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RemoteApiError";
    this.code = code;
    this.details = details;
  }
}

function normalizeRemoteError(
  error,
  fallbackCode = "REMOTE_ERROR",
  fallbackMessage = "Trae API request failed"
) {
  if (!error) {
    return {
      code: fallbackCode,
      message: fallbackMessage,
      details: {},
      normalized: true
    };
  }

  if (error instanceof RemoteApiError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details || {},
      normalized: true
    };
  }

  const details = typeof error === "object" && error !== null ? { ...error } : {};
  const code = typeof error.code === "string" ? error.code : fallbackCode;
  const message = typeof error.message === "string" ? error.message : fallbackMessage;
  return {
    code,
    message,
    details,
    normalized: true
  };
}

module.exports = {
  RemoteApiError,
  normalizeRemoteError
};