const { createTraeAutomationDriver } = require("../src/cdp/dom-driver");
const { createMockAutomationDriver } = require("../src/cdp/mock-driver");
const { createTraeRemoteDriver } = require("../src/remote/driver");
const { startGatewayServer } = require("../src/server");

function isSafeAttachModeEnabled() {
  return process.env.TRAE_SAFE_ATTACH_ONLY === "1";
}

function isMockDriverEnabled() {
  return process.env.TRAE_ENABLE_MOCK_BRIDGE !== "0";
}

function isRemoteDriverEnabled() {
  return process.env.TRAE_BACKEND === "remote" || process.env.TRAE_REMOTE_DRIVER === "1";
}

async function main() {
  if (isRemoteDriverEnabled()) {
    const remoteDriver = createTraeRemoteDriver();
    const readiness = await remoteDriver.getReadiness();
    if (!readiness.ready && !isSafeAttachModeEnabled()) {
      throw Object.assign(new Error(readiness.error?.message || "Remote Trae API is not ready"), {
        code: readiness.error?.code || "REMOTE_NOT_READY",
        details: readiness.error?.details || {}
      });
    }
    console.warn(
      JSON.stringify(
        {
          code: "REMOTE_DRIVER_ACTIVE",
          message: "Remote HTTP driver is active (TRAE_API physical protocol, no DOM window)",
          note: "Requires TRAE_API_TOKEN set to a valid TraeWork session JWT"
        },
        null,
        2
      )
    );
    startGatewayServer({
      automationDriver: remoteDriver
    });
    return;
  }

  let automationDriver = createTraeAutomationDriver();
  let readiness = await automationDriver.getReadiness();

  if (!readiness.ready) {
    if (!isSafeAttachModeEnabled()) {
      throw Object.assign(new Error(readiness.error?.message || "Trae automation is not ready"), {
        code: readiness.error?.code || "AUTOMATION_NOT_READY",
        details: readiness.error?.details || {}
      });
    }

    console.warn(
      JSON.stringify(
        {
          code: "SAFE_ATTACH_MODE_ACTIVE",
          message: "Safe attach mode is active, so the gateway will not attempt to relaunch Trae"
        },
        null,
        2
      )
    );

    if (isMockDriverEnabled()) {
      automationDriver = createMockAutomationDriver();
      readiness = await automationDriver.getReadiness();
      console.warn(
        JSON.stringify(
          {
            code: "MOCK_DRIVER_ACTIVE",
            message: "Mock automation driver is active for local API validation",
            note: "Responses are simulated and do not reflect the live Trae window"
          },
          null,
          2
        )
      );
    }
  }

  startGatewayServer({
    automationDriver
  });
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        code: error.code || "GATEWAY_START_BLOCKED",
        message: error.message,
        details: error.details || {}
      },
      null,
      2
    )
  );
  process.exit(1);
});
