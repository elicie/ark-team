import { createHash } from "node:crypto";

import {
  canonicalJson,
  sha256CanonicalJson,
  verificationRunSnapshotV2Schema,
  type VerificationRunSnapshot,
} from "./verification-contract.js";

type VerificationRunSnapshotV2 = Extract<
  VerificationRunSnapshot,
  { schema_version: 2 }
>;

export type VerificationApiErrorCode =
  | "API_CONTRACT_MISMATCH"
  | "INVALID_RECORD";

export interface VerificationApiContractIdentity {
  schema_version: 2;
  contract_id: "verification_contract_v2";
  run_id: string;
  snapshot_id: string;
  source_fingerprint: string;
  package_fingerprint: string;
  resolved_config_sha256: string;
  lane: "backend";
  lane_required: boolean;
  probe_id: string;
  probe_required: boolean;
  probe_sha256: string;
  adapter: {
    name: "curl";
    version: string;
  };
}

export interface VerificationApiRuntimeRequest {
  schema_version: 1;
  kind: "verification_api_request";
  identity: VerificationApiContractIdentity;
  request_sha256: string;
  execution: {
    argv: readonly string[];
    cwd: string;
    shell: false;
    stdin: Uint8Array | null;
  };
  request: {
    origin: string;
    url: string;
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query: readonly (readonly [string, string])[];
    headers: readonly (readonly [string, string])[];
    body_sha256: string | "none";
    expected_status: number;
    expected_content_type: string;
    credentials: "omit";
    redirect: "manual";
    max_redirects: 0;
    proxy: false;
  };
  limits: {
    timeout_ms: number;
    max_response_bytes: number;
    max_metadata_bytes: number;
    max_preview_bytes: number;
    max_header_count: number;
  };
}

export interface VerificationApiRuntimeResult {
  request_sha256: string;
  url: string;
  status: number;
  headers: Readonly<Record<string, string | readonly string[]>>;
  body: Uint8Array;
  elapsed_ms: number;
}

export interface VerificationApiResponseHeaderEvidence {
  name: string;
  value: string;
}

export interface VerificationApiEvidence {
  identity: VerificationApiContractIdentity;
  request_sha256: string;
  expected_status: number;
  expected_content_type: string;
  actual_status: number | null;
  actual_content_type: string | null;
  observed_url: string | null;
  headers: readonly VerificationApiResponseHeaderEvidence[];
  headers_sha256: string;
  headers_truncated: boolean;
  body_preview: string;
  body_preview_bytes: number;
  body_preview_truncated: boolean;
  body_bytes: number;
  body_sha256: string | null;
  response_sha256: string | null;
  elapsed_ms: number | null;
}

export interface VerificationApiNormalizedResult {
  passed: boolean;
  error_code: VerificationApiErrorCode | null;
  message: string | null;
  evidence: VerificationApiEvidence;
}

export class VerificationApiAdapterError extends Error {
  readonly code: VerificationApiErrorCode;

  constructor(code: VerificationApiErrorCode, message: string) {
    super(message);
    this.name = "VerificationApiAdapterError";
    this.code = code;
  }
}

const RESPONSE_RESULT_KEYS = [
  "body",
  "elapsed_ms",
  "headers",
  "request_sha256",
  "status",
  "url",
] as const;
const SAFE_AUTOMATIC_HEADERS = ["Accept", "Content-Type", "Expect", "User-Agent"];
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const SENSITIVE_HEADER_PATTERN =
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key|x-auth-token)$/i;
const SECRET_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_:.-]+/gi, "<redacted>"],
  [
    /\b(?:api[_-]?key|authorization|cookie|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi,
    "$1=<redacted>",
  ],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>"],
  [
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "<redacted>",
  ],
  [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    "<redacted>",
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted>"],
  [/\b[A-Za-z0-9+/_=-]{48,}\b/g, "<redacted>"],
];

export function createVerificationApiRequest(
  snapshotInput: VerificationRunSnapshotV2,
  probeId: string,
  bodyBytes?: Uint8Array,
): VerificationApiRuntimeRequest {
  const parsed = verificationRunSnapshotV2Schema.safeParse(snapshotInput);
  if (!parsed.success) {
    throw new VerificationApiAdapterError(
      "INVALID_RECORD",
      "verification API snapshot is invalid",
    );
  }
  const snapshot = parsed.data;
  if (!snapshot.backend_contract.enabled) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "backend verification is disabled",
    );
  }
  const probe = snapshot.backend_contract.api_probes.find(
    (candidate) => candidate.id === probeId,
  );
  if (probe === undefined) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "API probe is not declared in the snapshot",
    );
  }

  const stdin = bodyBytes === undefined ? null : new Uint8Array(bodyBytes);
  const actualBodySha256 =
    stdin === null ? "none" : sha256Bytes(stdin);
  if (
    (probe.body_digest === "none" && stdin !== null) ||
    (probe.body_digest !== "none" &&
      (stdin === null || actualBodySha256 !== probe.body_digest))
  ) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "request body bytes do not match the snapshotted digest",
    );
  }
  if (
    stdin !== null &&
    stdin.byteLength > snapshot.evidence_policy.max_file_bytes
  ) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "request body exceeds the snapshotted byte limit",
    );
  }

  const query = Object.entries(probe.query)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => [name, value] as const);
  const headers = Object.entries(probe.headers)
    .sort(([left], [right]) =>
      compareText(left.toLowerCase(), right.toLowerCase()),
    )
    .map(([name, value]) => {
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new VerificationApiAdapterError(
          "API_CONTRACT_MISMATCH",
          "request header contains a control character",
        );
      }
      return [name, value] as const;
    });
  const requestMetadataBytes = Buffer.byteLength(
    canonicalJson({ query, headers }),
    "utf8",
  );
  if (
    requestMetadataBytes >
    snapshot.evidence_policy.max_metadata_bytes_per_check
  ) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "request metadata exceeds the snapshotted byte limit",
    );
  }

  const url = new URL(probe.path, snapshot.server.api_origin);
  for (const [name, value] of query) {
    url.searchParams.append(name, value);
  }
  if (
    url.origin !== snapshot.server.api_origin ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "API request is outside the snapshotted local origin",
    );
  }
  if (Buffer.byteLength(url.toString(), "utf8") > 8_192) {
    throw new VerificationApiAdapterError(
      "API_CONTRACT_MISMATCH",
      "API request URL exceeds the adapter byte limit",
    );
  }

  const identity: VerificationApiContractIdentity = {
    schema_version: 2,
    contract_id: snapshot.contract_id,
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    resolved_config_sha256: snapshot.resolved_config_sha256,
    lane: "backend",
    lane_required: snapshot.backend_contract.required,
    probe_id: probe.id,
    probe_required: probe.required,
    probe_sha256: sha256CanonicalJson(probe),
    adapter: {
      name: snapshot.backend_contract.api_adapter,
      version: snapshot.backend_contract.api_adapter_version,
    },
  };
  const argv = [
    "curl",
    "--disable",
    "--silent",
    "--show-error",
    "--globoff",
    ...(probe.method === "HEAD" ? [] : ["--dump-header", "-"]),
    "--max-time",
    (snapshot.timeouts_ms.api_ms / 1_000).toString(),
    ...(probe.method === "HEAD"
      ? []
      : [
          "--max-filesize",
          snapshot.evidence_policy.max_file_bytes.toString(),
        ]),
    "--resolve",
    `${url.hostname}:${url.port}:127.0.0.1`,
    ...(probe.method === "HEAD"
      ? ["--head"]
      : ["--request", probe.method]),
    "--url",
    url.toString(),
    "--max-redirs",
    "0",
    "--proxy",
    "",
    "--noproxy",
    "*",
  ];
  const declaredHeaderNames = new Set(
    headers.map(([name]) => name.toLowerCase()),
  );
  for (const name of SAFE_AUTOMATIC_HEADERS) {
    if (!declaredHeaderNames.has(name.toLowerCase())) {
      argv.push("--header", `${name}:`);
    }
  }
  for (const [name, value] of headers) {
    argv.push("--header", `${name}: ${value}`);
  }
  if (stdin !== null) {
    argv.push("--data-binary", "@-");
  }

  const execution = {
    argv,
    cwd: snapshot.source.worktree_root,
    shell: false as const,
    stdin,
  };
  const request = {
    origin: snapshot.server.api_origin,
    url: url.toString(),
    method: probe.method,
    path: probe.path,
    query,
    headers,
    body_sha256: probe.body_digest,
    expected_status: probe.expected_status,
    expected_content_type: probe.expected_content_type,
    credentials: "omit" as const,
    redirect: "manual" as const,
    max_redirects: 0 as const,
    proxy: false as const,
  };
  const limits = {
    timeout_ms: snapshot.timeouts_ms.api_ms,
    max_response_bytes: snapshot.evidence_policy.max_file_bytes,
    max_metadata_bytes:
      snapshot.evidence_policy.max_metadata_bytes_per_check,
    max_preview_bytes: snapshot.evidence_policy.api_preview_byte_limit,
    max_header_count: snapshot.evidence_policy.network_event_limit,
  };
  const requestSha256 = sha256CanonicalJson({
    identity,
    execution: {
      argv,
      cwd: execution.cwd,
      shell: false,
      stdin_sha256: probe.body_digest,
    },
    request,
    limits,
  });

  return {
    schema_version: 1,
    kind: "verification_api_request",
    identity,
    request_sha256: requestSha256,
    execution,
    request,
    limits,
  };
}

export function normalizeVerificationApiResult(
  request: VerificationApiRuntimeRequest,
  resultInput: unknown,
): VerificationApiNormalizedResult {
  const emptyEvidence = createEmptyEvidence(request);
  if (!requestDigestMatches(request)) {
    return failure(
      "INVALID_RECORD",
      "API request descriptor changed after it was created",
      emptyEvidence,
    );
  }
  if (!isExactRuntimeResult(resultInput)) {
    return failure(
      "INVALID_RECORD",
      "registered API runtime returned an invalid result",
      emptyEvidence,
    );
  }
  const result = resultInput;
  if (result.request_sha256 !== request.request_sha256) {
    return failure(
      "INVALID_RECORD",
      "registered API runtime returned a result for another request",
      emptyEvidence,
    );
  }

  const parsedHeaders = parseResponseHeaders(result.headers, request);
  const bodySha256 = sha256Bytes(result.body);
  const responseWithinLimit =
    result.body.byteLength <= request.limits.max_response_bytes;
  const redactedPreview = responseWithinLimit
    ? boundedUtf8(
        redactText(new TextDecoder().decode(result.body)),
        request.limits.max_preview_bytes,
      )
    : {
        value: "<redacted:oversized-response>",
        truncated: true,
      };
  const evidence: VerificationApiEvidence = {
    ...emptyEvidence,
    actual_status: result.status,
    actual_content_type:
      parsedHeaders.contentType === null
        ? null
        : boundedUtf8(redactText(parsedHeaders.contentType), 256).value,
    observed_url: redactUrlEvidence(result.url),
    headers: parsedHeaders.evidence,
    headers_sha256: sha256CanonicalJson(parsedHeaders.raw),
    headers_truncated: parsedHeaders.truncated,
    body_preview: redactedPreview.value,
    body_preview_bytes: Buffer.byteLength(redactedPreview.value, "utf8"),
    body_preview_truncated: redactedPreview.truncated,
    body_bytes: result.body.byteLength,
    body_sha256: bodySha256,
    response_sha256: sha256CanonicalJson({
      status: result.status,
      headers_sha256: sha256CanonicalJson(parsedHeaders.raw),
      body_sha256: bodySha256,
    }),
    elapsed_ms: result.elapsed_ms,
  };

  if (!responseWithinLimit) {
    return failure(
      "API_CONTRACT_MISMATCH",
      "API response body exceeds the snapshotted byte limit",
      evidence,
    );
  }
  if (parsedHeaders.invalidMessage !== null) {
    return failure(
      "API_CONTRACT_MISMATCH",
      parsedHeaders.invalidMessage,
      evidence,
    );
  }
  if (!isExactRequestUrl(result.url, request.request.url)) {
    return failure(
      "API_CONTRACT_MISMATCH",
      "API runtime observed a URL outside the exact local request",
      evidence,
    );
  }
  if (parsedHeaders.crossOriginLocation) {
    return failure(
      "API_CONTRACT_MISMATCH",
      "API response contains a cross-origin redirect location",
      evidence,
    );
  }
  if (result.status !== emptyEvidence.expected_status) {
    return failure(
      "API_CONTRACT_MISMATCH",
      "API response status does not match the snapshot",
      evidence,
    );
  }
  if (
    parsedHeaders.contentType === null ||
    normalizeMediaType(parsedHeaders.contentType) !==
      normalizeMediaType(emptyEvidence.expected_content_type)
  ) {
    return failure(
      "API_CONTRACT_MISMATCH",
      "API response content type does not match the snapshot",
      evidence,
    );
  }

  return {
    passed: true,
    error_code: null,
    message: null,
    evidence,
  };
}

function requestDigestMatches(request: VerificationApiRuntimeRequest): boolean {
  const stdinSha256 =
    request.execution.stdin === null
      ? "none"
      : sha256Bytes(request.execution.stdin);
  if (
    stdinSha256 !== request.request.body_sha256 ||
    request.execution.shell !== false ||
    request.request.credentials !== "omit" ||
    request.request.redirect !== "manual" ||
    request.request.max_redirects !== 0 ||
    request.request.proxy !== false
  ) {
    return false;
  }
  return (
    request.request_sha256 ===
    sha256CanonicalJson({
      identity: request.identity,
      execution: {
        argv: request.execution.argv,
        cwd: request.execution.cwd,
        shell: false,
        stdin_sha256: request.request.body_sha256,
      },
      request: request.request,
      limits: request.limits,
    })
  );
}

function createEmptyEvidence(
  request: VerificationApiRuntimeRequest,
): VerificationApiEvidence {
  return {
    identity: request.identity,
    request_sha256: request.request_sha256,
    expected_status: request.request.expected_status,
    expected_content_type: request.request.expected_content_type,
    actual_status: null,
    actual_content_type: null,
    observed_url: null,
    headers: [],
    headers_sha256: sha256CanonicalJson([]),
    headers_truncated: false,
    body_preview: "",
    body_preview_bytes: 0,
    body_preview_truncated: false,
    body_bytes: 0,
    body_sha256: null,
    response_sha256: null,
    elapsed_ms: null,
  };
}

function failure(
  errorCode: VerificationApiErrorCode,
  message: string,
  evidence: VerificationApiEvidence,
): VerificationApiNormalizedResult {
  return {
    passed: false,
    error_code: errorCode,
    message,
    evidence,
  };
}

function isExactRuntimeResult(
  value: unknown,
): value is VerificationApiRuntimeResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RESPONSE_RESULT_KEYS.length ||
    keys.some((key, index) => key !== RESPONSE_RESULT_KEYS[index])
  ) {
    return false;
  }
  return (
    typeof value.request_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.request_sha256) &&
    typeof value.url === "string" &&
    value.url.length <= 8_192 &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    isPlainRecord(value.headers) &&
    value.body instanceof Uint8Array &&
    typeof value.elapsed_ms === "number" &&
    Number.isSafeInteger(value.elapsed_ms) &&
    value.elapsed_ms >= 0
  );
}

function parseResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
  request: VerificationApiRuntimeRequest,
): {
  raw: readonly VerificationApiResponseHeaderEvidence[];
  evidence: readonly VerificationApiResponseHeaderEvidence[];
  contentType: string | null;
  crossOriginLocation: boolean;
  truncated: boolean;
  invalidMessage: string | null;
} {
  const raw: VerificationApiResponseHeaderEvidence[] = [];
  let invalidMessage: string | null = null;
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      invalidMessage ??= "API response contains an invalid header name";
      continue;
    }
    const values =
      typeof rawValue === "string"
        ? [rawValue]
        : Array.isArray(rawValue) && rawValue.every((value) => typeof value === "string")
          ? rawValue
          : null;
    if (values === null) {
      invalidMessage ??= "API response contains an invalid header value";
      continue;
    }
    for (const value of values) {
      if (/[\u0000\r\n]/.test(value)) {
        invalidMessage ??= "API response header contains a control character";
        continue;
      }
      raw.push({ name: name.toLowerCase(), value });
    }
  }
  raw.sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.value, right.value),
  );
  if (raw.length > request.limits.max_header_count) {
    invalidMessage ??= "API response header count exceeds the snapshotted limit";
  }
  if (
    Buffer.byteLength(canonicalJson(raw), "utf8") >
    request.limits.max_metadata_bytes
  ) {
    invalidMessage ??= "API response headers exceed the snapshotted byte limit";
  }

  const contentTypes = raw
    .filter((header) => header.name === "content-type")
    .map((header) => header.value);
  if (contentTypes.length > 1) {
    invalidMessage ??= "API response contains multiple content types";
  }
  const locations = raw
    .filter((header) => header.name === "location")
    .map((header) => header.value);
  let crossOriginLocation = false;
  for (const location of locations) {
    try {
      const target = new URL(location, request.request.url);
      if (
        target.origin !== request.request.origin ||
        target.username !== "" ||
        target.password !== ""
      ) {
        crossOriginLocation = true;
      }
    } catch {
      invalidMessage ??= "API response contains an invalid redirect location";
    }
  }

  const evidence: VerificationApiResponseHeaderEvidence[] = [];
  let truncated = false;
  for (const header of raw) {
    const redacted = {
      name: header.name,
      value: SENSITIVE_HEADER_PATTERN.test(header.name)
        ? "<redacted>"
        : header.name === "location"
          ? redactUrlEvidence(header.value, request.request.url)
          : redactText(header.value),
    };
    if (
      Buffer.byteLength(canonicalJson([...evidence, redacted]), "utf8") >
      request.limits.max_metadata_bytes
    ) {
      truncated = true;
      continue;
    }
    evidence.push(redacted);
  }
  return {
    raw,
    evidence,
    contentType: contentTypes[0] ?? null,
    crossOriginLocation,
    truncated,
    invalidMessage,
  };
}

function isExactRequestUrl(observed: string, expected: string): boolean {
  try {
    const url = new URL(observed);
    return (
      url.username === "" &&
      url.password === "" &&
      url.toString() === expected
    );
  } catch {
    return false;
  }
}

function redactUrlEvidence(value: string, base?: string): string {
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    const query = [...url.searchParams.entries()].map(([name]) => [
      redactText(name),
      "<redacted>",
    ] as const);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    for (const [name, redactedValue] of query) {
      url.searchParams.append(name, redactedValue);
    }
    return boundedUtf8(redactText(url.toString()), 8_192).value;
  } catch {
    return "<redacted:invalid-url>";
  }
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function redactText(value: string): string {
  let redacted = value.replace(/\u0000/g, "\uFFFD");
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function boundedUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  let end = maxBytes;
  while (
    end > 0 &&
    (bytes[end] === undefined || (bytes[end]! & 0b1100_0000) === 0b1000_0000)
  ) {
    end -= 1;
  }
  return {
    value: bytes.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
