import type {
  AndroidManifestFacts,
  AndroidManifestReadFailure,
  ArchiveFailureReason,
} from "../../domain/android/androidManifestFacts.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../ArtifactReader.js";
import { streamChunkToBuffer } from "../StreamBytes.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import {
  MAX_MANIFEST_BYTES,
  readAndroidManifest,
} from "./AndroidManifestReader.js";

/** Metadata (central directory) reads are bounded before allocation. */
const ZIP_METADATA_READ_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_ENTRY = "AndroidManifest.xml";

export interface ApkManifestObservation {
  readonly manifest: AndroidManifestFacts;
  /** `lib/<abi>/` directory names seen in ZIP paths; not confirmed from ELF headers. */
  readonly native_abi_paths: readonly string[];
}

/**
 * `ZipArtifactReader.entries()` surfaces zip.js format errors as bare `Error`
 * instances (for example "File format is not recognized") next to its own
 * typed `ArtifactReaderFailure`. Both describe the input; subclasses of
 * `Error` do not.
 */
const isArchiveInputError = (cause: unknown): cause is Error =>
  cause instanceof ArtifactReaderFailure ||
  (cause instanceof Error && cause.constructor === Error);

const failure = (
  kind: Exclude<AndroidManifestReadFailure["kind"], "archive_unreadable">,
  message: string,
): Result<never, AndroidManifestReadFailure> => err({ kind, message });

const archiveFailure = (
  reason: ArchiveFailureReason,
  message: string,
): Result<never, AndroidManifestReadFailure> =>
  err({ kind: "archive_unreadable", reason, message });

/** Keep I/O and availability distinct from container-format problems. */
const archiveReasonOf = (cause: Error): ArchiveFailureReason => {
  if (cause instanceof ArtifactReaderFailure)
    return cause.reason === "cancelled" || cause.reason === "limit"
      ? "format"
      : cause.reason;
  const code = (cause as NodeJS.ErrnoException).code;
  return typeof code === "string" ? "io" : "format";
};

/**
 * Read the compiled manifest and path-level ABI directories from one APK
 * without executing it. A ZIP integrity or format problem is reported as a
 * typed failure with its reason; cancellation is rethrown to the caller.
 */
export const readAndroidManifestFromApk = async (
  path: string,
  signal?: AbortSignal,
): Promise<Result<ApkManifestObservation, AndroidManifestReadFailure>> => {
  const reader = new ZipArtifactReader(
    path,
    "apk",
    ZIP_METADATA_READ_MAX_BYTES,
  );
  try {
    const abis = new Set<string>();
    let manifestEntry: ArtifactEntry | undefined;
    for await (const entry of reader.entries(signal)) {
      if (entry.kind !== "file") continue;
      if (entry.path === MANIFEST_ENTRY) {
        // Defence in depth: the reader rejects repeated names on current
        // upstream, but an ambiguous manifest must never be resolved by order.
        if (manifestEntry !== undefined)
          return failure(
            "malformed",
            `${MANIFEST_ENTRY} appears more than once; the manifest is ambiguous`,
          );
        manifestEntry = entry;
      }
      const abi = /^lib\/([^/]+)\/[^/]+$/u.exec(entry.path)?.[1];
      if (abi !== undefined) abis.add(abi);
    }
    if (manifestEntry === undefined)
      return failure(
        "not_found",
        `${MANIFEST_ENTRY} is not present in the APK`,
      );
    if (
      manifestEntry.declaredSize !== null &&
      manifestEntry.declaredSize > MAX_MANIFEST_BYTES
    )
      return failure(
        "limit_exceeded",
        `${MANIFEST_ENTRY} declares ${manifestEntry.declaredSize} bytes, above ${MAX_MANIFEST_BYTES}`,
      );
    const stream = await reader.open(manifestEntry, signal);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = streamChunkToBuffer(chunk);
      total += bytes.length;
      if (total > MAX_MANIFEST_BYTES) {
        stream.destroy();
        return failure(
          "limit_exceeded",
          `${MANIFEST_ENTRY} exceeds ${MAX_MANIFEST_BYTES} bytes while reading`,
        );
      }
      chunks.push(bytes);
    }
    const parsed = readAndroidManifest(Buffer.concat(chunks));
    if (!parsed.ok) return parsed;
    return ok({
      manifest: parsed.value,
      native_abi_paths: [...abis].sort(),
    });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    // Only container/input problems become typed failures. Anything else (a
    // TypeError, RangeError, ...) is a defect in this code or its callee and
    // must stay visible.
    if (!isArchiveInputError(cause)) throw cause;
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return failure(
        "limit_exceeded",
        `APK could not be read: ${cause.message}`,
      );
    return archiveFailure(
      archiveReasonOf(cause),
      `APK container could not be read: ${cause.message}`,
    );
  } finally {
    await reader.close();
  }
};
