import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import test from "node:test";

import {
  createVerificationBrowserDriverV2Request,
  normalizeVerificationBrowserDriverV2Result,
  VerificationBrowserContractError,
  type VerificationBrowserDriverV2Request,
} from "../src/verification-browser-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
} from "../src/verification-contract.js";
import {
  executeVerificationPlaywrightBrowserDriverV2,
  probeVerificationPlaywrightRuntime,
  VERIFICATION_PLAYWRIGHT_ADAPTER,
  VERIFICATION_PLAYWRIGHT_BROWSER_BUILD,
  VERIFICATION_PLAYWRIGHT_BROWSER_VERSION,
  VERIFICATION_UI_RUNTIME_SPEC_SHA256,
} from "../src/verification-playwright-runtime.js";
import { inspectVerificationPng } from "../src/verification-png.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const ARIA_SNAPSHOT = [
  '- heading "Dashboard" [level=1]',
  "- text: Name",
  '- textbox "Name": Ada',
  "- text: Ready for QA Socket ready",
].join("\n");
type BrowserAction =
  VerificationBrowserDriverV2Request["actions"][number]["action"];
type BrowserAssertion =
  VerificationBrowserDriverV2Request["assertions"][number]["assertion"];

test(
  "UIR-TEST-001 probes only the exact stable Playwright and bundled headless shell",
  { concurrency: false },
  async () => {
    const probe = await probeVerificationPlaywrightRuntime();

    assert.equal(probe.available, true, probe.reason ?? undefined);
    assert.deepEqual(probe.adapter, VERIFICATION_PLAYWRIGHT_ADAPTER);
    assert.equal(probe.browser_build, VERIFICATION_PLAYWRIGHT_BROWSER_BUILD);
    assert.equal(probe.package_version, "1.62.0");
    assert.equal(probe.browser_version, VERIFICATION_PLAYWRIGHT_BROWSER_VERSION);
    assert.match(
      probe.executable_path ?? "",
      /chromium_headless_shell-1234[\\/]chrome-headless-shell-/,
    );
    assert.equal(probe.spec_sha256, VERIFICATION_UI_RUNTIME_SPEC_SHA256);
  },
);

test(
  "UIR-TEST-002..005 runs actions once and captures three exact viewports in the same context",
  { concurrency: false },
  async () => {
    const fixture = await startFixtureServer();
    const originalProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    try {
      const request = createRequest(fixture.port, {
        path: "/",
        readiness: "body",
        actions: [
          { type: "fill", selector: "#name", value: "Ada" },
          { type: "press", selector: "#name", key: "Tab" },
          { type: "click", selector: "#go" },
          {
            type: "wait_for_selector",
            selector: "#ws-ready, #ws-error",
          },
        ],
        assertions: [
          { kind: "visible", role: "heading", name: "Dashboard" },
          { kind: "text", selector: "#done", value: "Ready for QA" },
          {
            kind: "text",
            selector: ".ws-status",
            value: "Socket ready",
          },
          { kind: "url", value: "/dashboard" },
          { kind: "value", selector: "#name", value: "Ada" },
          {
            kind: "accessibility_snapshot",
            sha256: sha256Text(ARIA_SNAPSHOT),
          },
          {
            kind: "response",
            path: "/side-effect",
            expected_status: 204,
          },
        ],
      });

      const result = await executeVerificationPlaywrightBrowserDriverV2(
        request,
      );
      const normalized = normalizeVerificationBrowserDriverV2Result(
        request,
        result,
      );

      assert.equal(normalized.passed, true);
      assert.equal(fixture.counters.sideEffects, 1);
      assert.equal(fixture.counters.allowedWebSockets, 1);
      assert.equal(fixture.counters.externalWebSockets, 0);
      assert.equal(result.final_url, `${fixture.origin}/dashboard`);
      assert.equal(result.screenshot.url, result.final_url);
      assert.equal(result.trace.bytes[0], 0x50);
      assert.equal(result.trace.bytes[1], 0x4b);
      assert.deepEqual(
        result.screenshot.screenshots.map((screenshot) => {
          const png = inspectVerificationPng(screenshot.bytes);
          return {
            viewport: screenshot.viewport,
            width: png.width,
            height: png.height,
            dpr: screenshot.device_scale_factor,
            url: screenshot.url,
          };
        }),
        [
          {
            viewport: "375x812",
            width: 375,
            height: 812,
            dpr: 1,
            url: result.final_url,
          },
          {
            viewport: "768x1024",
            width: 768,
            height: 1_024,
            dpr: 1,
            url: result.final_url,
          },
          {
            viewport: "1440x900",
            width: 1_440,
            height: 900,
            dpr: 1,
            url: result.final_url,
          },
        ],
      );
      assert.equal(
        normalized.screenshot.images.every(
          ({ evidence }) => evidence.url === result.final_url,
        ),
        true,
      );
    } finally {
      if (originalProxy === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalProxy;
      }
      await fixture.close();
    }
  },
);

test(
  "UIR-TEST-002 blocks a cross-origin redirect before the external HTTP effect",
  { concurrency: false },
  async () => {
    const fixture = await startFixtureServer();
    try {
      const request = createRequest(fixture.port, {
        path: "/redirect-external",
        readiness: "body",
        actions: [],
        assertions: [
          { kind: "visible", role: "heading", name: "unreachable" },
        ],
      });

      await assert.rejects(
        executeVerificationPlaywrightBrowserDriverV2(request),
        (error: unknown) =>
          error instanceof VerificationBrowserContractError &&
          /blocked network origin/.test(error.message),
      );
      assert.equal(fixture.counters.externalHttp, 0);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "UIR-TEST-002 blocks a popup before its external HTTP effect",
  { concurrency: false },
  async () => {
    const fixture = await startFixtureServer();
    try {
      const request = createRequest(fixture.port, {
        path: "/popup",
        readiness: "body",
        actions: [{ type: "click", selector: "#popup" }],
        assertions: [
          { kind: "visible", role: "heading", name: "Popup" },
        ],
      });

      await assert.rejects(
        executeVerificationPlaywrightBrowserDriverV2(request),
        (error: unknown) =>
          error instanceof VerificationBrowserContractError &&
          /popup network request was blocked/.test(error.message),
      );
      assert.equal(fixture.counters.externalHttp, 0);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "UIR-TEST-002 blocks an external WebSocket before its upgrade effect",
  { concurrency: false },
  async () => {
    const fixture = await startFixtureServer();
    try {
      const request = createRequest(fixture.port, {
        path: "/external-ws",
        readiness: "#ready",
        actions: [],
        assertions: [
          { kind: "visible", role: "heading", name: "External socket" },
        ],
      });

      await assert.rejects(
        executeVerificationPlaywrightBrowserDriverV2(request),
        (error: unknown) =>
          error instanceof VerificationBrowserContractError &&
          /blocked WebSocket origin/.test(error.message),
      );
      assert.equal(fixture.counters.externalWebSockets, 0);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "UIR-TEST-003 rejects a selector that resolves to multiple elements",
  { concurrency: false },
  async () => {
    const fixture = await startFixtureServer();
    try {
      const request = createRequest(fixture.port, {
        path: "/strict",
        readiness: "body",
        actions: [{ type: "click", selector: ".duplicate" }],
        assertions: [
          { kind: "visible", role: "heading", name: "Strict selectors" },
        ],
      });

      await assert.rejects(
        executeVerificationPlaywrightBrowserDriverV2(request),
        (error: unknown) =>
          error instanceof VerificationBrowserContractError &&
          /strict mode violation/.test(error.message),
      );
      assert.equal(fixture.counters.sideEffects, 0);
    } finally {
      await fixture.close();
    }
  },
);

function createRequest(
  port: number,
  browserCase: {
    readonly path: string;
    readonly readiness: string;
    readonly actions: readonly BrowserAction[];
    readonly assertions: readonly BrowserAssertion[];
  },
): VerificationBrowserDriverV2Request {
  const config = validVerificationCoordinatorConfig();
  if (!config.ui.enabled) {
    throw new Error("fixture requires an enabled UI lane");
  }
  config.ui.deterministic_adapter_version =
    VERIFICATION_PLAYWRIGHT_ADAPTER.version;
  config.ui.browser_build = VERIFICATION_PLAYWRIGHT_BROWSER_BUILD;
  config.ui.browser_cases = [
    {
      id: "playwright-runtime",
      path: browserCase.path,
      readiness: browserCase.readiness,
      actions: [...browserCase.actions],
      assertions: [...browserCase.assertions],
      required: true,
    },
  ];
  const snapshot = buildVerificationRunSnapshot({
    run_id: "ark-20260728t000000z-170800",
    project_path: process.cwd(),
    artifact_root: `${process.cwd()}/.ark-team-test-artifacts`,
    server_port: port,
    created_at_utc: "2026-07-28T00:00:00.000Z",
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(process.cwd()),
    config,
  });
  return createVerificationBrowserDriverV2Request({
    snapshot,
    case_id: "playwright-runtime",
    attempt_id: "combined-attempt-1",
  });
}

interface FixtureCounters {
  sideEffects: number;
  externalHttp: number;
  allowedWebSockets: number;
  externalWebSockets: number;
}

interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  readonly counters: FixtureCounters;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const counters: FixtureCounters = {
    sideEffects: 0,
    externalHttp: 0,
    allowedWebSockets: 0,
    externalWebSockets: 0,
  };
  const sockets = new Set<Socket>();
  let activePort = 0;
  const server = createServer(
    (request, response) =>
      serveFixture(request, response, activePort, counters),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const host = request.headers.host ?? "";
    if (host.startsWith("devbox:")) {
      counters.allowedWebSockets += 1;
    } else {
      counters.externalWebSockets += 1;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    socket.resume();
  });

  activePort = await listenAtAvailablePort(server);
  return {
    port: activePort,
    origin: `http://devbox:${activePort}`,
    counters,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

async function listenAtAvailablePort(server: Server): Promise<number> {
  for (let port = 10_001; port <= 10_100; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
      });
      return port;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error;
      }
    }
  }
  throw new Error("no fixture port is available at or above 10001");
}

function serveFixture(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  counters: FixtureCounters,
): void {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://devbox:${port}`,
  );
  if (requestUrl.pathname === "/side-effect" && request.method === "POST") {
    counters.sideEffects += 1;
    response.writeHead(204);
    response.end();
    return;
  }
  if (requestUrl.pathname === "/dashboard") {
    html(
      response,
      [
        "<h1>Dashboard</h1>",
        '<label>Name <input id="name" value="Ada"></label>',
        '<div id="done"> Ready   for QA </div>',
        '<div class="ws-status" id="ws-status">Socket pending</div>',
        "<script>",
        "const socket = new WebSocket(`ws://${location.host}/ws`);",
        "socket.addEventListener('open', () => {",
        "  const status = document.querySelector('#ws-status');",
        "  status.id = 'ws-ready';",
        "  status.textContent = 'Socket ready';",
        "});",
        "socket.addEventListener('error', () => {",
        "  const status = document.querySelector('#ws-status');",
        "  status.id = 'ws-error';",
        "  status.textContent = 'Socket error';",
        "});",
        "</script>",
      ].join(""),
    );
    return;
  }
  if (requestUrl.pathname === "/redirect-external") {
    response.writeHead(302, {
      location: `http://127.0.0.1:${port}/outside`,
    });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/outside") {
    counters.externalHttp += 1;
    html(response, "<h1>Outside</h1>");
    return;
  }
  if (requestUrl.pathname === "/popup") {
    html(
      response,
      [
        "<h1>Popup</h1>",
        '<button id="popup">Open</button>',
        "<script>",
        "document.querySelector('#popup').addEventListener('click', () => {",
        `  window.open("http://127.0.0.1:${port}/outside");`,
        "});",
        "</script>",
      ].join(""),
    );
    return;
  }
  if (requestUrl.pathname === "/external-ws") {
    html(
      response,
      [
        "<h1>External socket</h1>",
        "<script>",
        `new WebSocket("ws://127.0.0.1:${port}/outside");`,
        "setTimeout(() => {",
        "  const ready = document.createElement('div');",
        "  ready.id = 'ready';",
        "  document.body.append(ready);",
        "}, 75);",
        "</script>",
      ].join(""),
    );
    return;
  }
  if (requestUrl.pathname === "/strict") {
    html(
      response,
      [
        "<h1>Strict selectors</h1>",
        '<button class="duplicate">One</button>',
        '<button class="duplicate">Two</button>',
      ].join(""),
    );
    return;
  }
  html(
    response,
    [
      "<h1>Home</h1>",
      '<label>Name <input id="name"></label>',
      '<button id="go">Continue</button>',
      "<script>",
      "document.querySelector('#go').addEventListener('click', async () => {",
      "  const name = document.querySelector('#name').value;",
      "  await fetch('/side-effect', { method: 'POST' });",
      "  location.href = '/dashboard';",
      "});",
      "</script>",
    ].join(""),
  );
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body>${body}</body></html>`,
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
