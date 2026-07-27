import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { ArkTeamError } from "./errors.js";
import {
  canonicalJson,
  verificationApprovedBaselineManifestSchema,
  verificationBaselineSetSha256,
  type VerificationApprovedBaselineManifest,
  type VerificationLinkedRecord,
  type VerificationRunSnapshot,
} from "./verification-contract.js";

export type VerificationArtifactPayload = Extract<
  Extract<VerificationLinkedRecord, { schema_version: 2 }>["payload"],
  { kind: "artifact" }
>;

export interface VerificationArtifactStoreOptions {
  state_root: string;
  project_root: string;
  snapshot: VerificationRunSnapshot;
}

export interface WriteVerificationArtifactInput {
  artifact_id: string;
  relative_path: string;
  media_type: VerificationArtifactPayload["media_type"];
  bytes: Uint8Array;
  sha256: string;
}

export interface VerificationApprovedBaselineResult {
  manifest: VerificationApprovedBaselineManifest;
  manifest_sha256: string;
  baseline_set_sha256: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 50 * 1_024 * 1_024;
const MAX_TOTAL_BYTES = 500 * 1_024 * 1_024;
const MAX_FILES = 500;
const MAX_PHYSICAL_ENTRIES = MAX_FILES * 8;
const MAX_METADATA_BYTES = 64 * 1_024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const CRC32_TABLE = buildCrc32Table();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class VerificationArtifactStore {
  readonly state_root: string;
  readonly project_root: string;
  readonly artifact_root: string;

  private readonly snapshot: VerificationRunSnapshot;

  constructor(options: VerificationArtifactStoreOptions) {
    assertCanonicalAbsolutePath(options.state_root, "state root");
    assertCanonicalAbsolutePath(options.project_root, "project root");
    this.state_root = options.state_root;
    this.project_root = options.project_root;
    this.snapshot = options.snapshot;
    this.artifact_root = options.snapshot.artifact_root;
  }

  async registerRoot(): Promise<void> {
    this.assertV4Snapshot();
    await this.assertRegistrationParents();
    try {
      await mkdir(this.artifact_root, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw artifactRootError("unable to register artifact root", error);
      }
    }
    await assertExactDirectory(this.artifact_root, "artifact root");
    await syncDirectory(path.dirname(this.artifact_root));
    const entries = await readdir(this.artifact_root);
    if (entries.length !== 0) {
      throw artifactRootError(
        "newly registered artifact root is not empty",
      );
    }
  }

  async artifactRootExists(): Promise<boolean> {
    this.assertV4Snapshot();
    await this.assertRegistrationParents();
    try {
      await assertExactDirectory(this.artifact_root, "artifact root");
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async cleanupResidueExists(): Promise<boolean> {
    this.assertV4Snapshot();
    await this.assertRegistrationParents();
    const container = this.cleanupContainerPath();
    try {
      await assertExactDirectory(container, "cleanup quarantine");
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async write(
    input: WriteVerificationArtifactInput,
    existingArtifacts: readonly VerificationArtifactPayload[],
  ): Promise<VerificationArtifactPayload> {
    this.assertV4Snapshot();
    await this.assertRegisteredRoot();
    assertArtifactId(input.artifact_id);
    assertCanonicalRelativePath(input.relative_path);
    const expectedMediaType = mediaTypeForPath(input.relative_path);
    if (
      expectedMediaType === null ||
      input.media_type !== expectedMediaType
    ) {
      throw invalidArtifact("artifact media type does not match its suffix");
    }
    if (!SHA256_PATTERN.test(input.sha256)) {
      throw invalidArtifact("artifact requires an exact SHA-256");
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.byteLength === 0) {
      throw invalidArtifact("artifact bytes must not be empty");
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw invalidArtifact("artifact exceeds the per-file byte limit");
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== input.sha256) {
      throw invalidArtifact("artifact SHA-256 does not match its bytes");
    }
    const imageMetadata = validateArtifactBytes(
      input.media_type,
      bytes,
    );
    await this.verifyArtifacts(existingArtifacts);
    if (
      existingArtifacts.length >= MAX_FILES ||
      existingArtifacts.some(
        (artifact) =>
          artifact.artifact_id === input.artifact_id ||
          artifact.relative_path === input.relative_path,
      )
    ) {
      throw invalidArtifact(
        "artifact count, ID, or relative path is not append-only",
      );
    }
    const existingBytes = existingArtifacts.reduce(
      (total, artifact) => total + artifact.byte_length,
      0,
    );
    if (existingBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
      throw invalidArtifact("artifact run exceeds the total byte limit");
    }
    const payload = {
      kind: "artifact" as const,
      artifact_id: input.artifact_id,
      relative_path: input.relative_path,
      media_type: input.media_type,
      byte_length: bytes.byteLength,
      sha256: actualSha256,
      image_metadata: imageMetadata,
    } satisfies VerificationArtifactPayload;
    if (Buffer.byteLength(canonicalJson(payload), "utf8") > MAX_METADATA_BYTES) {
      throw invalidArtifact("artifact metadata exceeds 64 KiB");
    }

    const finalPath = await this.prepareArtifactPath(input.relative_path);
    const temporaryPath = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    let published = false;
    try {
      const handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const temporaryRelativePath = path
        .relative(this.artifact_root, temporaryPath)
        .split(path.sep)
        .join("/");
      const temporaryFile = await readSafeRegularFile(
        this.artifact_root,
        temporaryRelativePath,
        false,
        bytes.byteLength,
      );
      if (
        temporaryFile.bytes.byteLength !== bytes.byteLength ||
        sha256(temporaryFile.bytes) !== actualSha256
      ) {
        throw artifactRootError(
          "exclusive artifact temporary file changed before publication",
        );
      }
      try {
        await link(temporaryPath, finalPath);
        published = true;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw invalidArtifact("artifact replacement is forbidden");
        }
        throw error;
      }
      await this.verifyOne(payload);
      await rm(temporaryPath);
      await syncDirectory(path.dirname(finalPath));
      return payload;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (published) {
        try {
          await rm(finalPath, { force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await syncDirectory(path.dirname(finalPath));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw artifactRootError(
          "artifact publication failed and rollback was incomplete",
          new AggregateError([error, ...cleanupErrors]),
        );
      }
      if (error instanceof ArkTeamError) {
        throw error;
      }
      throw artifactRootError("unable to publish artifact atomically", error);
    }
  }

  async removeWrittenArtifact(
    artifact: VerificationArtifactPayload,
  ): Promise<void> {
    this.assertV4Snapshot();
    await this.assertRegisteredRoot();
    await this.verifyOne(artifact);
    const target = resolveBeneath(
      this.artifact_root,
      artifact.relative_path,
      "artifact path",
    );
    await rm(target);
    await syncDirectory(path.dirname(target));
    let current = path.dirname(target);
    while (current !== this.artifact_root) {
      const parent = path.dirname(current);
      try {
        await rmdir(current);
        await syncDirectory(parent);
      } catch (error) {
        if (isNodeError(error, "ENOTEMPTY")) {
          break;
        }
        throw artifactRootError(
          "unable to remove empty artifact directory",
          error,
        );
      }
      current = parent;
    }
  }

  async verifyArtifacts(
    artifacts: readonly VerificationArtifactPayload[],
  ): Promise<void> {
    this.assertV4Snapshot();
    await this.assertRegisteredRoot();
    await this.verifyArtifactsAtRoot(this.artifact_root, artifacts);
  }

  private async verifyArtifactsAtRoot(
    root: string,
    artifacts: readonly VerificationArtifactPayload[],
  ): Promise<void> {
    assertCanonicalAbsolutePath(root, "artifact root");
    await assertExactDirectory(root, "artifact root");
    if (artifacts.length > MAX_FILES) {
      throw invalidArtifact("artifact manifest exceeds the file-count limit");
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const artifact of artifacts) {
      assertArtifactId(artifact.artifact_id);
      assertCanonicalRelativePath(artifact.relative_path);
      if (
        ids.has(artifact.artifact_id) ||
        paths.has(artifact.relative_path)
      ) {
        throw invalidArtifact("artifact manifest contains duplicates");
      }
      ids.add(artifact.artifact_id);
      paths.add(artifact.relative_path);
      totalBytes += artifact.byte_length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw invalidArtifact("artifact manifest exceeds the run byte limit");
      }
      await this.verifyOneAtRoot(root, artifact);
    }
    const physicalPaths = await listRegularFiles(root);
    const expectedPaths = [...paths].sort(compareUtf8);
    if (physicalPaths.join("\0") !== expectedPaths.join("\0")) {
      throw artifactRootError(
        "artifact root contains unregistered or missing files",
      );
    }
  }

  async verifyApprovedBaseline(): Promise<VerificationApprovedBaselineResult> {
    this.assertV4Snapshot();
    if (
      this.snapshot.schema_version !== 2 ||
      !this.snapshot.ui_contract.enabled ||
      this.snapshot.baseline_root === null ||
      this.snapshot.baseline_identity === null
    ) {
      throw baselineError("approved UI baseline is not registered");
    }
    try {
      const root = this.snapshot.baseline_root;
      assertCanonicalAbsolutePath(root, "baseline root");
      await assertExactDirectory(root, "baseline root");
      const identity = this.snapshot.baseline_identity;
      const manifestRelativePath =
        `manifests/${identity.id}/${identity.sha256}.json`;
      const manifestFile = await readSafeRegularFile(
        root,
        manifestRelativePath,
        true,
        MAX_METADATA_BYTES,
      );
      let decoded: string;
      let parsedJson: unknown;
      try {
        decoded = UTF8_DECODER.decode(manifestFile.bytes);
        parsedJson = JSON.parse(decoded) as unknown;
      } catch (error) {
        throw baselineError("approved baseline manifest is not valid UTF-8 JSON", error);
      }
      const parsed =
        verificationApprovedBaselineManifestSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw baselineError(
          "approved baseline manifest does not match strict schema v1",
          parsed.error,
        );
      }
      const manifest = parsed.data;
      if (decoded !== canonicalJson(manifest)) {
        throw baselineError("approved baseline manifest is not canonical JSON");
      }
      const ui = this.snapshot.ui_contract;
      if (
        manifest.baseline_id !== identity.id ||
        manifest.source_commit !== identity.source_commit ||
        manifest.source_tree !== identity.source_tree ||
        canonicalJson(manifest.environment) !==
          canonicalJson(identity.environment) ||
        manifest.adapter.name !== ui.deterministic_adapter ||
        manifest.adapter.version !== ui.deterministic_adapter_version ||
        manifest.browser_build !== ui.browser_build
      ) {
        throw baselineError(
          "approved baseline manifest does not match the snapshot",
        );
      }
      const expectedEntryKeys = [...ui.browser_cases]
        .sort((left, right) => compareUtf8(left.id, right.id))
        .flatMap((browserCase) =>
          ui.viewports.map(
            (viewport) => `${browserCase.id}\0${viewport}`,
          ),
        );
      const actualEntryKeys = manifest.entries.map(
        (entry) => `${entry.case_id}\0${entry.viewport}`,
      );
      if (actualEntryKeys.join("\0") !== expectedEntryKeys.join("\0")) {
        throw baselineError(
          "approved baseline manifest does not cover the exact case and viewport matrix",
        );
      }
      const baselineSetSha256 = verificationBaselineSetSha256(manifest);
      if (baselineSetSha256 !== identity.sha256) {
        throw baselineError(
          "approved baseline set hash does not match its identity",
        );
      }
      for (const entry of manifest.entries) {
        const object = await readSafeRegularFile(
          root,
          entry.path,
          true,
          MAX_FILE_BYTES,
        );
        if (
          object.bytes.byteLength === 0 ||
          sha256(object.bytes) !== entry.sha256
        ) {
          throw baselineError(
            "approved baseline PNG bytes do not match their object hash",
          );
        }
        const dimensions = parsePngDimensions(object.bytes);
        if (
          dimensions.width !== entry.width ||
          dimensions.height !== entry.height
        ) {
          throw baselineError(
            "approved baseline PNG dimensions do not match its manifest",
          );
        }
      }
      return {
        manifest,
        manifest_sha256: sha256(manifestFile.bytes),
        baseline_set_sha256: baselineSetSha256,
      };
    } catch (error) {
      if (
        error instanceof ArkTeamError &&
        error.code === "BASELINE_NOT_APPROVED"
      ) {
        throw error;
      }
      throw baselineError("approved baseline verification failed", error);
    }
  }

  async cleanupRegisteredRoot(
    artifacts: readonly VerificationArtifactPayload[],
  ): Promise<void> {
    this.assertV4Snapshot();
    await this.assertRegistrationParents();
    await assertExactDirectory(this.artifact_root, "artifact root");
    const container = this.cleanupContainerPath();
    const quarantinedRoot = path.join(container, "root");
    let moved = false;
    try {
      await mkdir(container, { recursive: false, mode: 0o700 });
      await syncDirectory(path.dirname(container));
      await rename(this.artifact_root, quarantinedRoot);
      moved = true;
      await syncDirectory(path.dirname(this.artifact_root));
      await syncDirectory(container);
      await this.verifyArtifactsAtRoot(quarantinedRoot, artifacts);
      await rm(quarantinedRoot, { recursive: true });
      await syncDirectory(container);
      await rmdir(container);
      await syncDirectory(path.dirname(container));
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        if (
          moved &&
          (await pathEntryExists(quarantinedRoot)) &&
          !(await pathEntryExists(this.artifact_root))
        ) {
          await rename(quarantinedRoot, this.artifact_root);
          moved = false;
          await syncDirectory(path.dirname(this.artifact_root));
          await syncDirectory(container);
        }
        if (!moved && (await pathEntryExists(container))) {
          await rmdir(container);
          await syncDirectory(path.dirname(container));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      throw artifactRootError(
        "unable to remove only the verified registered artifact root",
        rollbackErrors.length === 0
          ? error
          : new AggregateError([error, ...rollbackErrors]),
      );
    }
    try {
      await lstat(this.artifact_root);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw artifactRootError("unable to verify artifact-root cleanup", error);
    }
    throw artifactRootError("registered artifact root remains after cleanup");
  }

  private cleanupContainerPath(): string {
    return `${this.artifact_root}.cleanup-pending`;
  }

  private assertV4Snapshot(): void {
    if (
      this.snapshot.schema_version !== 2 ||
      this.snapshot.package.package_id !== "verification-spec-v4"
    ) {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "verification-spec-v3 and contract-v1 artifacts are read-only",
      );
    }
    assertCanonicalAbsolutePath(this.artifact_root, "artifact root");
    if (this.snapshot.source.worktree_root !== this.project_root) {
      throw artifactRootError(
        "artifact store project root does not match the snapshot source",
      );
    }
    const expected = path.join(
      this.state_root,
      this.snapshot.run_id,
      "verification",
    );
    if (this.artifact_root !== expected) {
      throw artifactRootError(
        "artifact root does not match the registered run root",
      );
    }
  }

  private async assertRegistrationParents(): Promise<void> {
    await assertExactDirectory(this.state_root, "state root");
    await assertExactDirectory(this.project_root, "project root");
    const runRoot = path.join(this.state_root, this.snapshot.run_id);
    await assertExactDirectory(runRoot, "run root");
    if (
      isPathWithin(this.project_root, this.artifact_root) ||
      isPathWithin(this.artifact_root, this.project_root)
    ) {
      throw artifactRootError(
        "artifact output must remain outside the project checkout",
      );
    }
  }

  private async assertRegisteredRoot(): Promise<void> {
    await this.assertRegistrationParents();
    await assertExactDirectory(this.artifact_root, "artifact root");
  }

  private async prepareArtifactPath(relativePath: string): Promise<string> {
    const components = relativePath.split("/");
    const fileName = components.pop();
    if (fileName === undefined) {
      throw invalidArtifact("artifact path has no filename");
    }
    let current = this.artifact_root;
    for (const component of components) {
      const parent = current;
      current = path.join(current, component);
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
        await syncDirectory(parent);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw artifactRootError(
            "unable to create artifact directory",
            error,
          );
        }
      }
      await assertExactDirectory(current, "artifact directory");
    }
    const finalPath = path.join(current, fileName);
    try {
      await lstat(finalPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return finalPath;
      }
      throw artifactRootError("unable to inspect artifact destination", error);
    }
    throw invalidArtifact("artifact replacement is forbidden");
  }

  private async verifyOne(
    artifact: VerificationArtifactPayload,
  ): Promise<void> {
    this.assertV4Snapshot();
    await this.assertRegisteredRoot();
    await this.verifyOneAtRoot(this.artifact_root, artifact);
  }

  private async verifyOneAtRoot(
    root: string,
    artifact: VerificationArtifactPayload,
  ): Promise<void> {
    assertArtifactId(artifact.artifact_id);
    assertCanonicalRelativePath(artifact.relative_path);
    if (
      artifact.byte_length <= 0 ||
      artifact.byte_length > MAX_FILE_BYTES ||
      !SHA256_PATTERN.test(artifact.sha256)
    ) {
      throw invalidArtifact("artifact metadata is outside fixed limits");
    }
    const expectedMediaType = mediaTypeForPath(artifact.relative_path);
    if (
      expectedMediaType === null ||
      artifact.media_type !== expectedMediaType
    ) {
      throw invalidArtifact("artifact metadata type does not match its path");
    }
    const file = await readSafeRegularFile(
      root,
      artifact.relative_path,
      false,
      MAX_FILE_BYTES,
    );
    if (
      file.bytes.byteLength !== artifact.byte_length ||
      sha256(file.bytes) !== artifact.sha256
    ) {
      throw invalidArtifact("physical artifact does not match its metadata");
    }
    const imageMetadata = validateArtifactBytes(
      artifact.media_type,
      file.bytes,
    );
    if (
      canonicalJson(imageMetadata) !==
        canonicalJson(artifact.image_metadata)
    ) {
      throw invalidArtifact("artifact image metadata does not match its bytes");
    }
  }
}

function validateArtifactBytes(
  mediaType: VerificationArtifactPayload["media_type"],
  bytes: Buffer,
): { width: number; height: number } | null {
  try {
    if (mediaType === "image/png") {
      return parsePngDimensions(bytes);
    }
    if (mediaType === "application/json") {
      JSON.parse(UTF8_DECODER.decode(bytes));
      return null;
    }
    if (mediaType === "application/x-ndjson") {
      const lines = UTF8_DECODER.decode(bytes).split(/\r?\n/);
      const records = lines.filter((line) => line.length > 0);
      if (records.length === 0) {
        throw new Error("JSONL has no records");
      }
      for (const record of records) {
        JSON.parse(record);
      }
      return null;
    }
    if (mediaType === "text/plain") {
      UTF8_DECODER.decode(bytes);
      return null;
    }
    validateOpaqueZip(bytes);
    return null;
  } catch (error) {
    throw invalidArtifact("artifact bytes do not match their declared type", error);
  }
}

function parsePngDimensions(bytes: Buffer): {
  width: number;
  height: number;
} {
  if (
    bytes.byteLength < 57 ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw invalidArtifact("PNG is missing its signature or required chunks");
  }
  let offset = PNG_SIGNATURE.byteLength;
  let dimensions: { width: number; height: number } | null = null;
  let sawImageData = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw invalidArtifact("PNG chunk header is truncated");
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcOffset = dataStart + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.byteLength) {
      throw invalidArtifact("PNG chunk exceeds the byte stream");
    }
    const type = bytes.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw invalidArtifact("PNG chunk type is invalid");
    }
    if (
      crc32(bytes.subarray(typeStart, crcOffset)) !==
      bytes.readUInt32BE(crcOffset)
    ) {
      throw invalidArtifact("PNG chunk CRC is invalid");
    }
    if (offset === PNG_SIGNATURE.byteLength && type !== "IHDR") {
      throw invalidArtifact("PNG IHDR must be the first chunk");
    }
    if (type === "IHDR") {
      if (dimensions !== null || length !== 13) {
        throw invalidArtifact("PNG has an invalid or duplicate IHDR");
      }
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8] ?? 0;
      const colorType = bytes[dataStart + 9] ?? 255;
      const compression = bytes[dataStart + 10] ?? 255;
      const filter = bytes[dataStart + 11] ?? 255;
      const interlace = bytes[dataStart + 12] ?? 255;
      const validDepths = new Map<number, readonly number[]>([
        [0, [1, 2, 4, 8, 16]],
        [2, [8, 16]],
        [3, [1, 2, 4, 8]],
        [4, [8, 16]],
        [6, [8, 16]],
      ]);
      if (
        width === 0 ||
        height === 0 ||
        !validDepths.get(colorType)?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        ![0, 1].includes(interlace)
      ) {
        throw invalidArtifact("PNG IHDR metadata is invalid");
      }
      dimensions = { width, height };
    } else if (type === "IDAT") {
      if (dimensions === null) {
        throw invalidArtifact("PNG IDAT appears before IHDR");
      }
      sawImageData = true;
    } else if (type === "IEND") {
      if (
        length !== 0 ||
        dimensions === null ||
        !sawImageData ||
        nextOffset !== bytes.byteLength
      ) {
        throw invalidArtifact("PNG IEND or image-data boundary is invalid");
      }
      return dimensions;
    }
    offset = nextOffset;
  }
  throw invalidArtifact("PNG is missing its terminal IEND chunk");
}

function validateOpaqueZip(bytes: Buffer): void {
  if (bytes.byteLength < 22) {
    throw new Error("trace ZIP is truncated");
  }
  const minimumEocd = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEocd; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error("trace ZIP has no bounded end-of-directory record");
  }
  const disk = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entriesOnDisk === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new Error("trace ZIP uses an unsupported directory layout");
  }
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > eocdOffset ||
      bytes.readUInt32LE(cursor) !== 0x02014b50
    ) {
      throw new Error("trace ZIP central directory is malformed");
    }
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next =
      cursor + 46 + nameLength + extraLength + commentLength;
    if (
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      next > eocdOffset ||
      localOffset + 30 > centralOffset ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error("trace ZIP entry boundary is malformed");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) {
      throw new Error("trace ZIP entry data exceeds its local boundary");
    }
    cursor = next;
  }
  if (cursor !== eocdOffset) {
    throw new Error("trace ZIP directory size does not match its entries");
  }
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function readSafeRegularFile(
  root: string,
  relativePath: string,
  requireReadOnly: boolean,
  maxBytes: number,
): Promise<{ bytes: Buffer }> {
  assertCanonicalRelativePath(relativePath);
  const target = resolveBeneath(root, relativePath, "registered file path");
  const components = relativePath.split("/");
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      throw artifactRootError("registered file path is unavailable", error);
    }
    if (stats.isSymbolicLink()) {
      throw artifactRootError("registered file path traverses a symlink");
    }
    if (index < components.length - 1) {
      if (!stats.isDirectory()) {
        throw artifactRootError(
          "registered file parent is not a directory",
        );
      }
    } else if (!stats.isFile()) {
      throw artifactRootError("registered artifact is not a regular file");
    }
  }
  const actualBeforeOpen = await realpath(target);
  if (actualBeforeOpen !== target) {
    throw artifactRootError("registered file path is not canonical");
  }
  let handle;
  try {
    handle = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw artifactRootError(
      "registered file could not be opened without following links",
      error,
    );
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const linked = await lstat(target, { bigint: true });
    const actualAfterOpen = await realpath(target);
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      actualAfterOpen !== target
    ) {
      throw artifactRootError(
        "registered file changed while it was being opened",
      );
    }
    if (requireReadOnly && (opened.mode & 0o222n) !== 0n) {
      throw baselineError("approved baseline files must be read-only");
    }
    if (opened.size > BigInt(maxBytes)) {
      throw artifactRootError("registered file exceeds its fixed byte limit");
    }
    const length = Number(opened.size);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(
        bytes,
        offset,
        length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, length);
    const after = await handle.stat({ bigint: true });
    const linkedAfter = await lstat(target, { bigint: true });
    const actualAfterRead = await realpath(target);
    if (
      offset !== length ||
      extra.bytesRead !== 0 ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      after.dev !== linkedAfter.dev ||
      after.ino !== linkedAfter.ino ||
      linkedAfter.isSymbolicLink() ||
      actualAfterRead !== target
    ) {
      throw artifactRootError(
        "registered file changed while it was being read",
      );
    }
    return { bytes };
  } finally {
    await handle.close();
  }
}

async function listRegularFiles(
  root: string,
  current = root,
  counter = { entries: 0, files: 0 },
): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    counter.entries += 1;
    if (counter.entries > MAX_PHYSICAL_ENTRIES) {
      throw artifactRootError(
        "artifact root exceeds the bounded physical-entry limit",
      );
    }
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      throw artifactRootError("artifact root contains a symlink");
    }
    if (entry.isDirectory()) {
      result.push(...(await listRegularFiles(root, absolute, counter)));
    } else if (entry.isFile()) {
      counter.files += 1;
      if (counter.files > MAX_FILES) {
        throw artifactRootError(
          "artifact root exceeds the physical file-count limit",
        );
      }
      result.push(relative);
    } else {
      throw artifactRootError("artifact root contains a special file");
    }
  }
  return result.sort(compareUtf8);
}

async function assertExactDirectory(
  target: string,
  description: string,
): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw artifactRootError(`${description} is not a regular directory`);
  }
  const actual = await realpath(target);
  if (actual !== target) {
    throw artifactRootError(`${description} is not canonical`);
  }
}

async function pathEntryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertCanonicalAbsolutePath(
  value: string,
  description: string,
): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value
  ) {
    throw artifactRootError(`${description} must be absolute and canonical`);
  }
}

function assertCanonicalRelativePath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 1_000 ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .some(
        (component) =>
          component.length === 0 ||
          component === "." ||
          component === ".." ||
          component.includes("\0"),
      )
  ) {
    throw artifactRootError(
      "artifact path must be canonical and relative",
    );
  }
}

function assertArtifactId(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw invalidArtifact("artifact ID is invalid");
  }
}

function mediaTypeForPath(
  relativePath: string,
): VerificationArtifactPayload["media_type"] | null {
  if (relativePath.endsWith(".playwright-trace.zip")) {
    return "application/zip";
  }
  if (relativePath.endsWith(".png")) {
    return "image/png";
  }
  if (relativePath.endsWith(".jsonl")) {
    return "application/x-ndjson";
  }
  if (relativePath.endsWith(".json")) {
    return "application/json";
  }
  if (relativePath.endsWith(".txt")) {
    return "text/plain";
  }
  return null;
}

function resolveBeneath(
  root: string,
  relativePath: string,
  description: string,
): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isPathWithin(root, resolved) || resolved === root) {
    throw artifactRootError(`${description} escapes its registered root`);
  }
  return resolved;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalidArtifact(message: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError(
    "INVALID_RECORD",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function artifactRootError(message: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError(
    "ARTIFACT_ROOT_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function baselineError(message: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError(
    "BASELINE_NOT_APPROVED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
