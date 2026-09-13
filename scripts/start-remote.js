// Startup entry for the remote HTTP backend (no DOM, no local Trae window).
process.env.TRAE_BACKEND = process.env.TRAE_BACKEND || "remote";
process.env.TRAE_ENABLE_OPENAI_ENDPOINTS =
  process.env.TRAE_ENABLE_OPENAI_ENDPOINTS || "1";

require("./start-gateway");