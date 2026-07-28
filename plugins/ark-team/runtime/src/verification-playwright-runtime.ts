import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Browser,
  BrowserContext,
  CDPSession,
  ConsoleMessage,
  Locator,
  Page,
  Response,
} from "@playwright/test";

import { ArkTeamError } from "./errors.js";
import {
  VerificationBrowserContractError,
  type VerificationBrowserDialogEvidence,
  type VerificationBrowserDriverV2Request,
  type VerificationBrowserDriverV2Result,
  type VerificationBrowserNavigationEvidence,
  type VerificationBrowserStepEvidence,
} from "./verification-browser-adapter.js";
import { sha256CanonicalJson } from "./verification-contract.js";
import type {
  VerificationScreenshotRuntimeImage,
  VerificationScreenshotRuntimeV2Result,
} from "./verification-visual-adapter.js";

export const VERIFICATION_PLAYWRIGHT_ADAPTER = Object.freeze({
  name: "playwright-cli" as const,
  version: "ark-ui-1.0.0-pw-1.62.0",
});
export const VERIFICATION_PLAYWRIGHT_BROWSER_BUILD =
  "chromium-headless-shell-151.0.7922.34-r1234";
export const VERIFICATION_PLAYWRIGHT_BROWSER_VERSION = "151.0.7922.34";
export const VERIFICATION_UI_RUNTIME_SPEC_SHA256 =
  "29f69eda06ba8bf47d32e0e3914686f147ef0e5e7c01d3d18f4cd3b4549f4047";

const PLAYWRIGHT_PACKAGE_VERSION = "1.62.0";
const PLAYWRIGHT_PACKAGE_INTEGRITY =
  "sha512-9zOJ6ZQRAena31MpOH9VSzIz8Ou3YJ/wtY/eQm5T2uhfhG7/U3COrMS8xOtUrZrp9OgdmzEnIYODye3nY1VqzA==";
const HEADLESS_SHELL_REVISION = "1234";
const RESOLVER_ARGUMENT =
  "--host-resolver-rules=MAP devbox 127.0.0.1";
const MAX_BROWSER_EVENTS = 100;
const MAX_MESSAGE_CHARACTERS = 1_000;
const TRACE_MAX_BYTES = 50 * 1_024 * 1_024;
const CLEANUP_TIMEOUT_MS = 5_000;
const CREDENTIAL_PATTERN =
  /(?:authorization|bearer|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)/i;
const SAFE_BROWSER_ENVIRONMENT_KEYS = [
  "FONTCONFIG_PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "PATH",
  "TMPDIR",
  "XDG_DATA_DIRS",
] as const;
const REQUIRED_VIEWPORTS = [
  { name: "375x812", width: 375, height: 812 },
  { name: "768x1024", width: 768, height: 1_024 },
  { name: "1440x900", width: 1_440, height: 900 },
] as const;
type AriaRole = Parameters<Page["getByRole"]>[0];
type PlaywrightRuntime = Pick<
  typeof import("@playwright/test"),
  "chromium" | "expect"
>;
type PlaywrightExpect = PlaywrightRuntime["expect"];
let playwrightRuntimePromise: Promise<PlaywrightRuntime> | undefined;

const repositoryRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const runtimeSpecPath = path.join(
  repositoryRoot,
  "docs/specs/verification-ui-runtime/SPEC.md",
);
const packageLockPath = path.join(repositoryRoot, "package-lock.json");

export interface VerificationPlaywrightRuntimeProbe {
  readonly available: boolean;
  readonly adapter: typeof VERIFICATION_PLAYWRIGHT_ADAPTER;
  readonly browser_build: typeof VERIFICATION_PLAYWRIGHT_BROWSER_BUILD;
  readonly package_version: string | null;
  readonly browser_version: string | null;
  readonly executable_path: string | null;
  readonly spec_sha256: string | null;
  readonly reason: string | null;
}

export async function probeVerificationPlaywrightRuntime(
  signal?: AbortSignal,
): Promise<VerificationPlaywrightRuntimeProbe> {
  let browser: Browser | null = null;
  let packageVersion: string | null = null;
  let browserVersion: string | null = null;
  let executablePath: string | null = null;
  let specSha256: string | null = null;
  let failure: unknown = null;

  try {
    const { chromium } = await loadPlaywrightRuntime();
    const staticIdentity = await inspectStaticRuntimeIdentity(chromium);
    packageVersion = staticIdentity.package_version;
    executablePath = staticIdentity.executable_path;
    specSha256 = staticIdentity.spec_sha256;
    assertNotAborted(signal);
    browser = await chromium.launch({
      headless: true,
      args: [RESOLVER_ARGUMENT],
      env: browserChildEnvironment(process.env),
      timeout: 60_000,
    });
    assertNotAborted(signal);
    browserVersion = browser.version();
    if (browserVersion !== VERIFICATION_PLAYWRIGHT_BROWSER_VERSION) {
      throw new Error(
        `bundled Chromium version ${browserVersion} does not match ${VERIFICATION_PLAYWRIGHT_BROWSER_VERSION}`,
      );
    }
  } catch (error) {
    failure = error;
  }

  if (browser !== null) {
    try {
      await boundedCleanup(
        browser.close({ reason: "verification capability probe complete" }),
      );
    } catch (error) {
      failure ??= error;
    }
  }

  return Object.freeze({
    available: failure === null,
    adapter: VERIFICATION_PLAYWRIGHT_ADAPTER,
    browser_build: VERIFICATION_PLAYWRIGHT_BROWSER_BUILD,
    package_version: packageVersion,
    browser_version: browserVersion,
    executable_path: executablePath,
    spec_sha256: specSha256,
    reason:
      failure === null
        ? null
        : boundedMessage(failure, "Playwright runtime is unavailable"),
  });
}

export async function executeVerificationPlaywrightBrowserDriverV2(
  request: Readonly<VerificationBrowserDriverV2Request>,
  inputSignal?: AbortSignal,
): Promise<VerificationBrowserDriverV2Result> {
  assertExactRuntimeRequest(request);

  const timeoutSignal = AbortSignal.timeout(request.case_timeout_ms);
  const signal =
    inputSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([inputSignal, timeoutSignal]);
  const startedAt = Date.now();
  const traceRoot = await mkdtemp(
    path.join(os.tmpdir(), "ark-team-playwright-"),
  );
  await chmod(traceRoot, 0o700);
  const tracePath = resolveTracePath(traceRoot, request.trace.relative_path);
  await mkdir(path.dirname(tracePath), { recursive: true, mode: 0o700 });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let networkSession: CDPSession | null = null;
  let tracingStarted = false;
  let execution: SuccessfulExecution | null = null;
  let traceBytes: Uint8Array | null = null;
  let failure: unknown = null;
  let boundary: NetworkBoundary | null = null;

  try {
    assertNotAborted(signal);
    const { chromium, expect } = await loadPlaywrightRuntime();
    browser = await chromium.launch({
      headless: true,
      args: [RESOLVER_ARGUMENT],
      env: browserChildEnvironment(process.env),
      timeout: request.auto_wait_timeout_ms,
    });
    assertNotAborted(signal);
    if (browser.version() !== VERIFICATION_PLAYWRIGHT_BROWSER_VERSION) {
      throw new ArkTeamError(
        "ENVIRONMENT_UNAVAILABLE",
        "launched Chromium does not match the approved browser build",
      );
    }

    const initialViewport = request.context.viewports.find(
      ({ name }) => name === "1440x900",
    );
    if (initialViewport === undefined) {
      throw contractFailure("the initial 1440x900 viewport is missing");
    }
    context = await browser.newContext({
      viewport: {
        width: initialViewport.width,
        height: initialViewport.height,
      },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "no-preference",
      serviceWorkers: "block",
      permissions: [],
      acceptDownloads: false,
    });
    context.setDefaultTimeout(request.auto_wait_timeout_ms);
    context.setDefaultNavigationTimeout(request.auto_wait_timeout_ms);

    const networkBoundary = createNetworkBoundary();
    boundary = networkBoundary;
    await context.routeWebSocket(/.*/, async (webSocket) => {
      if (!webSocketUrlIsAllowed(webSocket.url(), request.origin)) {
        networkBoundary.violate(
          `blocked WebSocket origin ${safeOrigin(webSocket.url())} outside the recorded origin`,
        );
        await webSocket.close({
          code: 1008,
          reason: "outside recorded origin",
        });
        return;
      }
      webSocket.connectToServer();
    });

    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    tracingStarted = true;

    const page = await context.newPage();
    networkSession = await installExactOriginNetworkGuard(
      context,
      page,
      networkBoundary,
      request.origin,
    );
    await context.route("**/*", async (route) => {
      let requestPage: Page | null = null;
      try {
        requestPage = route.request().frame().page();
      } catch {
        // A request without the owned page cannot be part of this UI case.
      }
      if (requestPage !== page) {
        networkBoundary.violate(
          "popup network request was blocked before effect",
        );
        await route.abort("blockedbyclient");
        return;
      }
      await route.fallback();
    });
    const events = attachPageEvidence(
      page,
      context,
      networkBoundary,
      request.origin,
      startedAt,
    );
    const navigationResponse = await page.goto(request.url, {
      waitUntil: "domcontentloaded",
      timeout: request.auto_wait_timeout_ms,
      signal,
    });
    if (navigationResponse === null) {
      throw contractFailure("initial navigation returned no HTTP response");
    }
    networkBoundary.assertClear();
    assertExactOriginUrl(page.url(), request.origin);

    const readinessStartedAt = Date.now();
    await page.locator(request.readiness.selector).waitFor({
      state: "visible",
      timeout: request.readiness.timeout_ms,
      signal,
    });
    const readiness = {
      passed: true as const,
      elapsed_ms: Date.now() - readinessStartedAt,
      message: null,
    };
    networkBoundary.assertClear();

    const actionEvidence: VerificationBrowserStepEvidence[] = [];
    for (const { sequence, action } of request.actions) {
      actionEvidence.push(
        await successfulStep(action, async () => {
          const locator = page.locator(action.selector);
          if (action.type === "click") {
            await locator.click({
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (action.type === "fill") {
            await locator.fill(action.value, {
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (action.type === "press") {
            await locator.press(action.key, {
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else {
            await locator.waitFor({
              state: "visible",
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          }
        }, sequence),
      );
      networkBoundary.assertClear();
      assertSinglePage(context);
    }

    await events.waitForDialogs();
    const assertionEvidence: VerificationBrowserStepEvidence[] = [];
    for (const { sequence, assertion } of request.assertions) {
      assertionEvidence.push(
        await successfulStep(assertion, async () => {
          if (assertion.kind === "visible") {
            const locator = page.getByRole(assertion.role as AriaRole, {
              name: assertion.name,
              exact: true,
            });
            await expectStrictLocator(
              locator,
              request.auto_wait_timeout_ms,
              signal,
              expect,
            );
            await expect(locator).toBeVisible({
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (assertion.kind === "text") {
            const locator = page.locator(assertion.selector);
            await expectStrictLocator(
              locator,
              request.auto_wait_timeout_ms,
              signal,
              expect,
            );
            await expect(locator).toHaveText(assertion.value, {
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (assertion.kind === "url") {
            const expectedUrl = exactLocalUrl(assertion.value, request.origin);
            await expect(page).toHaveURL(expectedUrl, {
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (assertion.kind === "value") {
            const locator = page.locator(assertion.selector);
            await expectStrictLocator(
              locator,
              request.auto_wait_timeout_ms,
              signal,
              expect,
            );
            await expect(locator).toHaveValue(assertion.value, {
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
          } else if (assertion.kind === "accessibility_snapshot") {
            const ariaSnapshot = await page.locator("body").ariaSnapshot({
              timeout: request.auto_wait_timeout_ms,
              signal,
            });
            const actualSha256 = sha256Bytes(
              Buffer.from(ariaSnapshot, "utf8"),
            );
            if (actualSha256 !== assertion.sha256) {
              throw new Error("accessibility snapshot SHA-256 differs");
            }
          } else {
            const expectedUrl = exactLocalUrl(assertion.path, request.origin);
            if (
              !events.responses.some(
                (response) =>
                  response.url() === expectedUrl &&
                  response.status() === assertion.expected_status,
              )
            ) {
              await page.waitForEvent("response", {
                predicate: (response) =>
                  response.url() === expectedUrl &&
                  response.status() === assertion.expected_status,
                timeout: request.auto_wait_timeout_ms,
                signal,
              });
            }
          }
        }, sequence),
      );
      networkBoundary.assertClear();
      assertSinglePage(context);
    }

    await events.waitForDialogs();
    networkBoundary.assertClear();
    const finalUrl = page.url();
    assertExactOriginUrl(finalUrl, request.origin);
    if (events.navigation.at(-1)?.url !== finalUrl) {
      throw contractFailure(
        "the final browser URL has no matching navigation response",
      );
    }

    const screenshots: VerificationScreenshotRuntimeImage[] = [];
    for (const capture of request.screenshot.captures) {
      await page.setViewportSize({
        width: capture.width,
        height: capture.height,
      });
      await page.locator(request.screenshot.readiness.selector).waitFor({
        state: "visible",
        timeout: request.screenshot.readiness.timeout_ms,
        signal,
      });
      networkBoundary.assertClear();
      if (page.url() !== finalUrl) {
        throw contractFailure("the page navigated during screenshot capture");
      }
      const bytes = Uint8Array.from(
        await page.screenshot({
          type: "png",
          fullPage: false,
          animations: "disabled",
          caret: "hide",
          omitBackground: false,
          scale: "css",
          timeout: request.screenshot.timeout_ms,
          signal,
        }),
      );
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > request.screenshot.max_file_bytes
      ) {
        throw contractFailure("captured PNG exceeds the evidence byte limit");
      }
      screenshots.push({
        ...capture,
        url: finalUrl,
        captured_at_utc: new Date().toISOString(),
        byte_length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        capture: {
          browser_chrome: "excluded",
          full_page: false,
          resized: false,
          cropped: false,
          converted: false,
          color_space_converted: false,
          alpha_normalized: false,
          post_processed: false,
        },
        bytes,
      });
    }
    networkBoundary.assertClear();
    assertSinglePage(context);

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > request.case_timeout_ms) {
      throw new Error("combined browser case exceeded its wall-clock limit");
    }
    execution = {
      elapsed_ms: elapsedMs,
      readiness,
      actions: actionEvidence,
      assertions: assertionEvidence,
      navigation: events.navigation,
      console: events.console,
      page_errors: events.pageErrors,
      dialogs: events.dialogs,
      final_url: finalUrl,
      screenshot: {
        schema_version: 2,
        contract_id: "verification_screenshot_runtime_result_v2",
        run_id: request.screenshot.run_id,
        snapshot_id: request.screenshot.snapshot_id,
        case_id: request.screenshot.case_id,
        attempt_id: request.screenshot.attempt_id,
        case_sha256: request.screenshot.case_sha256,
        package_fingerprint: request.screenshot.package_fingerprint,
        source_fingerprint: request.screenshot.source_fingerprint,
        adapter: { ...request.screenshot.adapter },
        browser_build: request.screenshot.browser_build,
        origin: request.screenshot.origin,
        url: finalUrl,
        screenshots,
      },
    };
  } catch (error) {
    try {
      boundary?.assertClear();
      failure = error;
    } catch (boundaryError) {
      failure = boundaryError;
    }
  }

  if (context !== null && tracingStarted) {
    try {
      await boundedCleanup(context.tracing.stop({ path: tracePath }));
      tracingStarted = false;
      await chmod(tracePath, 0o600);
      const bytes = Uint8Array.from(await readFile(tracePath));
      if (bytes.byteLength === 0 || bytes.byteLength > TRACE_MAX_BYTES) {
        throw new Error("Playwright trace is empty or exceeds 50 MiB");
      }
      traceBytes = bytes;
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    boundary?.assertClear();
  } catch (error) {
    failure = error;
  }
  if (networkSession !== null) {
    try {
      await boundedCleanup(networkSession.detach());
    } catch (error) {
      failure ??= error;
    }
  }
  if (context !== null) {
    try {
      await boundedCleanup(
        context.close({ reason: "combined UI verification complete" }),
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (browser !== null) {
    try {
      await boundedCleanup(
        browser.close({ reason: "combined UI verification complete" }),
      );
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await rm(traceRoot, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }

  if (failure !== null) {
    if (failure instanceof ArkTeamError) {
      throw failure;
    }
    if (failure instanceof VerificationBrowserContractError) {
      throw failure;
    }
    throw new ArkTeamError(
      "ENVIRONMENT_UNAVAILABLE",
      boundedMessage(failure, "Playwright combined execution failed"),
      { cause: failure },
    );
  }
  if (execution === null || traceBytes === null) {
    throw new ArkTeamError(
      "ENVIRONMENT_UNAVAILABLE",
      "Playwright combined execution produced no complete result",
    );
  }

  return {
    schema_version: 2,
    contract_id: "verification_browser_driver_result_v2",
    case_id: request.case_id,
    case_sha256: request.case_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    final_url: execution.final_url,
    context: structuredClone(request.context),
    elapsed_ms: execution.elapsed_ms,
    readiness: execution.readiness,
    actions: execution.actions,
    assertions: execution.assertions,
    navigation: execution.navigation,
    console: execution.console,
    page_errors: execution.page_errors,
    dialogs: execution.dialogs,
    trace: {
      relative_path: request.trace.relative_path,
      media_type: "application/zip",
      sha256: sha256Bytes(traceBytes),
      bytes: traceBytes,
    },
    passed: true,
    message: "all declared deterministic assertions passed",
    screenshot: execution.screenshot,
  };
}

interface SuccessfulExecution {
  readonly elapsed_ms: number;
  readonly readiness: VerificationBrowserDriverV2Result["readiness"];
  readonly actions: readonly VerificationBrowserStepEvidence[];
  readonly assertions: readonly VerificationBrowserStepEvidence[];
  readonly navigation: readonly VerificationBrowserNavigationEvidence[];
  readonly console: readonly {
    readonly sequence: number;
    readonly level: "debug" | "info" | "log" | "warn" | "error";
    readonly message: string;
  }[];
  readonly page_errors: readonly {
    readonly sequence: number;
    readonly message: string;
  }[];
  readonly dialogs: readonly VerificationBrowserDialogEvidence[];
  readonly final_url: string;
  readonly screenshot: VerificationScreenshotRuntimeV2Result;
}

async function installExactOriginNetworkGuard(
  context: BrowserContext,
  page: Page,
  boundary: NetworkBoundary,
  allowedOrigin: string,
): Promise<CDPSession> {
  const session = await context.newCDPSession(page);
  session.on("Fetch.requestPaused", (event) => {
    void handlePausedRequest(
      session,
      event,
      boundary,
      allowedOrigin,
      page,
    );
  });
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  return session;
}

async function handlePausedRequest(
  session: CDPSession,
  event: {
    readonly requestId: string;
    readonly resourceType: string;
    readonly request: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };
  },
  boundary: NetworkBoundary,
  allowedOrigin: string,
  page: Page,
): Promise<void> {
  const { requestId, request, resourceType } = event;
  try {
    if (!networkUrlIsAllowed(request.url, allowedOrigin, page.url())) {
      boundary.violate(
        resourceType === "WebSocket"
          ? `blocked WebSocket origin ${safeOrigin(request.url)} outside the recorded origin`
          : `blocked network origin ${safeOrigin(request.url)} outside the recorded origin`,
      );
      await session.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
      return;
    }
    if (
      Object.keys(request.headers).some((name) =>
        ["authorization", "cookie", "proxy-authorization"].includes(
          name.toLowerCase(),
        ),
      )
    ) {
      boundary.violate("credential-bearing browser request was blocked");
      await session.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
      return;
    }
    await session.send("Fetch.continueRequest", { requestId });
  } catch (error) {
    boundary.violate(
      boundedMessage(error, "network request interception failed"),
    );
    await session
      .send("Fetch.failRequest", {
        requestId,
        errorReason: "Failed",
      })
      .catch(() => undefined);
  }
}

function attachPageEvidence(
  page: Page,
  context: BrowserContext,
  boundary: NetworkBoundary,
  allowedOrigin: string,
  startedAt: number,
) {
  const navigation: VerificationBrowserNavigationEvidence[] = [];
  const console: SuccessfulExecution["console"][number][] = [];
  const pageErrors: SuccessfulExecution["page_errors"][number][] = [];
  const dialogs: VerificationBrowserDialogEvidence[] = [];
  const responses: Response[] = [];
  const pendingDialogs = new Set<Promise<void>>();

  page.on("response", (response) => {
    pushBounded(responses, response, boundary, "response");
    try {
      if (
        response.request().isNavigationRequest() &&
        response.request().frame() === page.mainFrame()
      ) {
        pushBounded(
          navigation,
          {
            sequence: navigation.length,
            url: response.url(),
            status: response.status(),
            elapsed_ms: Date.now() - startedAt,
          },
          boundary,
          "navigation",
        );
      }
    } catch {
      boundary.violate("navigation response could not be inspected");
    }
  });
  page.on("request", (request) => {
    const url = request.url();
    if (
      !networkUrlIsAllowed(
        url,
        allowedOrigin,
        safeFrameUrl(request.frame),
      )
    ) {
      boundary.violate(
        `blocked network origin ${safeOrigin(url)} outside the recorded origin`,
      );
    }
  });
  page.on("console", (event) => {
    pushBounded(
      console,
      {
        sequence: console.length,
        level: consoleLevel(event),
        message: boundedMessage(event.text(), ""),
      },
      boundary,
      "console",
    );
  });
  page.on("pageerror", (error) => {
    pushBounded(
      pageErrors,
      {
        sequence: pageErrors.length,
        message: boundedMessage(error, "page error"),
      },
      boundary,
      "page error",
    );
  });
  page.on("dialog", (dialog) => {
    pushBounded(
      dialogs,
      {
        sequence: dialogs.length,
        type: dialog.type(),
        message: boundedMessage(dialog.message(), ""),
        action: "dismissed",
      },
      boundary,
      "dialog",
    );
    const dismissal = dialog
      .dismiss()
      .catch((error: unknown) => {
        boundary.violate(
          boundedMessage(error, "browser dialog could not be dismissed"),
        );
      })
      .finally(() => {
        pendingDialogs.delete(dismissal);
      });
    pendingDialogs.add(dismissal);
  });
  page.on("download", (download) => {
    boundary.violate("download was requested by the browser case");
    void download.cancel();
  });
  page.on("filechooser", () => {
    boundary.violate("file upload was requested by the browser case");
  });
  context.on("page", (candidate) => {
    if (candidate !== page) {
      boundary.violate("popup creation is not a declared browser action");
      void candidate.close();
    }
  });

  return {
    navigation,
    console,
    pageErrors,
    dialogs,
    responses,
    async waitForDialogs(): Promise<void> {
      await Promise.all([...pendingDialogs]);
    },
  };
}

function createNetworkBoundary(): NetworkBoundary {
  let violation: VerificationBrowserContractError | null = null;
  return {
    violate(message: string): void {
      violation ??= contractFailure(message);
    },
    assertClear(): void {
      if (violation !== null) {
        throw violation;
      }
    },
  };
}

interface NetworkBoundary {
  violate(message: string): void;
  assertClear(): void;
}

async function successfulStep(
  input: unknown,
  operation: () => Promise<void>,
  sequence = 0,
): Promise<VerificationBrowserStepEvidence> {
  const startedAt = Date.now();
  try {
    await operation();
  } catch (error) {
    throw contractFailure(
      boundedMessage(error, `declared browser step ${sequence} failed`),
    );
  }
  return {
    sequence,
    input_sha256: sha256CanonicalJson(input),
    passed: true,
    elapsed_ms: Date.now() - startedAt,
    message: null,
  };
}

async function expectStrictLocator(
  locator: Locator,
  timeout: number,
  signal: AbortSignal,
  expect: PlaywrightExpect,
): Promise<void> {
  await expect(locator).toHaveCount(1, { timeout, signal });
}

function assertExactRuntimeRequest(
  request: Readonly<VerificationBrowserDriverV2Request>,
): void {
  if (
    request.schema_version !== 2 ||
    request.contract_id !== "verification_browser_driver_v2" ||
    request.adapter.name !== VERIFICATION_PLAYWRIGHT_ADAPTER.name ||
    request.adapter.version !== VERIFICATION_PLAYWRIGHT_ADAPTER.version ||
    request.browser_build !== VERIFICATION_PLAYWRIGHT_BROWSER_BUILD ||
    request.engine !== "chromium" ||
    request.execution.shell !== false ||
    request.context.fresh !== true ||
    request.context.isolated !== true ||
    request.context.device_scale_factor !== 1 ||
    request.context.locale !== "en-US" ||
    request.context.timezone !== "UTC" ||
    request.context.color_scheme !== "light" ||
    request.context.reduced_motion !== "no-preference" ||
    request.network.allowed_origin !== request.origin ||
    request.network.redirects !== "same-origin-only" ||
    request.network.proxy !== "disabled" ||
    request.network.credentials !== "omit" ||
    request.policy.screenshots !== "required"
  ) {
    throw contractFailure(
      "combined browser request differs from the approved runtime identity",
    );
  }
  assertExactOriginUrl(request.url, request.origin);
  const origin = new URL(request.origin);
  if (
    origin.hostname !== "devbox" ||
    origin.username !== "" ||
    origin.password !== "" ||
    Number(origin.port) < 10_001
  ) {
    throw contractFailure(
      "recorded browser origin is not the approved devbox origin",
    );
  }
  if (
    request.screenshot.run_id !== request.run_id ||
    request.screenshot.snapshot_id !== request.snapshot_id ||
    request.screenshot.case_id !== request.case_id ||
    request.screenshot.attempt_id !== request.attempt_id ||
    request.screenshot.case_sha256 !== request.case_sha256 ||
    request.screenshot.package_fingerprint !== request.package_fingerprint ||
    request.screenshot.source_fingerprint !== request.source_fingerprint ||
    request.screenshot.adapter.name !== request.adapter.name ||
    request.screenshot.adapter.version !== request.adapter.version ||
    request.screenshot.browser_build !== request.browser_build ||
    request.screenshot.origin !== request.origin ||
    request.screenshot.initial_url !== request.url ||
    request.screenshot.expected_url_source !==
      "validated-browser-final-url" ||
    request.screenshot.context.case_state !== "after-declared-actions" ||
    request.screenshot.policy.actions !== "disabled" ||
    request.screenshot.policy.navigation !== "disabled"
  ) {
    throw contractFailure(
      "combined screenshot plan differs from the browser request",
    );
  }
  if (
    sha256CanonicalJson(request.context.viewports) !==
      sha256CanonicalJson(REQUIRED_VIEWPORTS) ||
    sha256CanonicalJson(
      request.screenshot.captures.map(
        ({ sequence, viewport, width, height, device_scale_factor }) => ({
          sequence,
          viewport,
          width,
          height,
          device_scale_factor,
        }),
      ),
    ) !==
      sha256CanonicalJson(
        REQUIRED_VIEWPORTS.map((viewport, sequence) => ({
          sequence,
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          device_scale_factor: 1,
        })),
      )
  ) {
    throw contractFailure("combined screenshot viewport matrix is not exact");
  }
  if (
    CREDENTIAL_PATTERN.test(
      JSON.stringify({
        actions: request.actions,
        assertions: request.assertions,
      }),
    )
  ) {
    throw contractFailure("credential-bearing browser input is forbidden");
  }
  resolveTracePath(path.parse(request.execution.cwd).root, request.trace.relative_path);
}

function assertExactOriginUrl(value: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw contractFailure("browser URL is invalid", error);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw contractFailure("browser URL leaves the exact recorded origin");
  }
}

function exactLocalUrl(value: string, origin: string): string {
  let result: string;
  try {
    result = new URL(value, origin).toString();
  } catch (error) {
    throw contractFailure("declared URL assertion is invalid", error);
  }
  assertExactOriginUrl(result, origin);
  return result;
}

function networkUrlIsAllowed(
  value: string,
  allowedOrigin: string,
  frameUrl: string | null,
): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin === allowedOrigin;
    }
    if (parsed.protocol === "blob:") {
      return parsed.origin === allowedOrigin;
    }
    if (parsed.protocol === "about:" && parsed.href === "about:blank") {
      return true;
    }
    if (parsed.protocol === "data:") {
      return (
        frameUrl !== null &&
        new URL(frameUrl).origin === allowedOrigin
      );
    }
  } catch {
    return false;
  }
  return false;
}

function webSocketUrlIsAllowed(value: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(value);
    const allowed = new URL(allowedOrigin);
    const expectedProtocol =
      allowed.protocol === "https:" ? "wss:" : "ws:";
    return (
      parsed.protocol === expectedProtocol &&
      parsed.hostname === allowed.hostname &&
      parsed.port === allowed.port &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function safeFrameUrl(
  frame: () => { url(): string },
): string | null {
  try {
    return frame().url();
  } catch {
    return null;
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function assertSinglePage(context: BrowserContext): void {
  if (context.pages().length !== 1) {
    throw contractFailure("browser case created an undeclared page");
  }
}

function pushBounded<T>(
  values: T[],
  value: T,
  boundary: NetworkBoundary,
  label: string,
): void {
  if (values.length >= MAX_BROWSER_EVENTS) {
    boundary.violate(`${label} evidence exceeds the fixed event bound`);
    return;
  }
  values.push(value);
}

function consoleLevel(
  event: ConsoleMessage,
): "debug" | "info" | "log" | "warn" | "error" {
  const type = event.type();
  if (type === "debug" || type === "info" || type === "log") {
    return type;
  }
  if (type === "warning") {
    return "warn";
  }
  return "error";
}

function resolveTracePath(root: string, relativePath: string): string {
  if (
    relativePath === "" ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((component) => component === "..")
  ) {
    throw contractFailure("trace path is not a safe relative path");
  }
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, relativePath);
  const relation = path.relative(normalizedRoot, resolved);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw contractFailure("trace path escapes its owner-only root");
  }
  return resolved;
}

async function inspectStaticRuntimeIdentity(
  chromium: PlaywrightRuntime["chromium"],
): Promise<{
  readonly package_version: string;
  readonly executable_path: string;
  readonly spec_sha256: string;
}> {
  const specBytes = await readFile(runtimeSpecPath);
  const specSha256 = sha256Bytes(specBytes);
  if (specSha256 !== VERIFICATION_UI_RUNTIME_SPEC_SHA256) {
    throw new Error(
      `runtime SPEC SHA-256 ${specSha256} does not match the approved bytes`,
    );
  }

  const packageLock = JSON.parse(
    await readFile(packageLockPath, "utf8"),
  ) as PackageLock;
  const rootPlaywright =
    packageLock.packages?.[""]?.dependencies?.["@playwright/test"];
  const lockedPlaywright =
    packageLock.packages?.["node_modules/@playwright/test"];
  if (
    rootPlaywright !== PLAYWRIGHT_PACKAGE_VERSION ||
    lockedPlaywright?.version !== PLAYWRIGHT_PACKAGE_VERSION ||
    lockedPlaywright.integrity !== PLAYWRIGHT_PACKAGE_INTEGRITY
  ) {
    throw new Error("package-lock does not contain the approved Playwright bytes");
  }

  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@playwright/test/package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as { readonly version?: string };
  if (packageJson.version !== PLAYWRIGHT_PACKAGE_VERSION) {
    throw new Error("installed @playwright/test version is not approved");
  }

  const corePackageJsonPath = require.resolve("playwright-core/package.json");
  const browsers = JSON.parse(
    await readFile(path.join(path.dirname(corePackageJsonPath), "browsers.json"), "utf8"),
  ) as {
    readonly browsers?: readonly {
      readonly name?: string;
      readonly revision?: string;
      readonly browserVersion?: string;
    }[];
  };
  const shell = browsers.browsers?.find(
    ({ name }) => name === "chromium-headless-shell",
  );
  if (
    shell?.revision !== HEADLESS_SHELL_REVISION ||
    shell.browserVersion !== VERIFICATION_PLAYWRIGHT_BROWSER_VERSION
  ) {
    throw new Error("Playwright browser registry does not match the approved shell");
  }

  const chromiumExecutable = chromium.executablePath();
  const cacheRoot = path.dirname(
    path.dirname(path.dirname(chromiumExecutable)),
  );
  const shellRoot = path.join(
    cacheRoot,
    `chromium_headless_shell-${HEADLESS_SHELL_REVISION}`,
  );
  const executablePath = await findHeadlessShellExecutable(shellRoot);
  return {
    package_version: packageJson.version,
    executable_path: executablePath,
    spec_sha256: specSha256,
  };
}

interface PackageLock {
  readonly packages?: Readonly<
    Record<
      string,
      {
        readonly version?: string;
        readonly integrity?: string;
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
      }
    >
  >;
}

async function findHeadlessShellExecutable(root: string): Promise<string> {
  const candidates: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (
        entry.isFile() &&
        ["chrome-headless-shell", "headless_shell.exe"].includes(entry.name)
      ) {
        candidates.push(candidate);
      }
    }
  };
  await visit(root, 0);
  if (candidates.length !== 1) {
    throw new Error("exact bundled headless-shell executable is unavailable");
  }
  const executable = candidates[0]!;
  const metadata = await lstat(executable);
  if (
    !metadata.isFile() ||
    (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
  ) {
    throw new Error("bundled headless-shell is not executable");
  }
  return executable;
}

function browserChildEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_BROWSER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  environment.TZ = "UTC";
  return environment;
}

async function loadPlaywrightRuntime(): Promise<PlaywrightRuntime> {
  playwrightRuntimePromise ??= import("@playwright/test");
  return playwrightRuntimePromise;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Playwright execution was aborted");
  }
}

async function boundedCleanup(operation: Promise<void>): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Playwright cleanup exceeded its fixed timeout"));
    }, CLEANUP_TIMEOUT_MS);
    timer.unref();
  });
  await Promise.race([operation, timeout]);
}

function boundedMessage(error: unknown, fallback: string): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  return message.replaceAll("\0", "").slice(0, MAX_MESSAGE_CHARACTERS);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contractFailure(
  message: string,
  cause?: unknown,
): VerificationBrowserContractError {
  return new VerificationBrowserContractError(message, { cause });
}
