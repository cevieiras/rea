import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import { readAndroidManifestFromApk } from "./readAndroidManifestFromApk.js";
import { splitSetApk } from "./androidSplitSetFixtures.js";

const write = async (name: string, bytes: Uint8Array): Promise<string> => {
  const directory = await createTestTempDirectory("rea-apk-manifest-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

describe("readAndroidManifestFromApk", () => {
  it("reads the manifest and path-level ABI directories", async () => {
    const path = await write("arm.apk", splitSetApk("config-arm64_v8a"));
    const result = await readAndroidManifestFromApk(path);
    expect(result).toMatchObject({
      ok: true,
      value: {
        manifest: { split: "config.arm64_v8a", version_code: 7 },
        native_abi_paths: ["arm64-v8a"],
      },
    });
  });

  it("reports no ABI directories for a split without native libraries", async () => {
    const path = await write("en.apk", splitSetApk("config-en"));
    const result = await readAndroidManifestFromApk(path);
    expect(result).toMatchObject({ ok: true, value: { native_abi_paths: [] } });
  });

  it("returns a typed failure for a truncated APK", async () => {
    const whole = splitSetApk("base");
    const path = await write("cut.apk", whole.subarray(0, whole.length - 30));
    const result = await readAndroidManifestFromApk(path);
    expect(result).toMatchObject({ ok: false });
  });

  it("returns a typed failure for bytes that are not a ZIP", async () => {
    const path = await write("junk.apk", Buffer.from("not a zip archive"));
    const result = await readAndroidManifestFromApk(path);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "archive_unreadable", reason: "format" },
    });
  });

  it("keeps a missing file distinct from a malformed container", async () => {
    const directory = await createTestTempDirectory("rea-apk-manifest-");
    const result = await readAndroidManifestFromApk(
      join(directory, "absent.apk"),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "archive_unreadable", reason: "io" },
    });
  });

  it("does not hide a defect behind an input failure", async () => {
    const path = await write("defect.apk", splitSetApk("base"));
    const spy = vi
      .spyOn(ZipArtifactReader.prototype, "entries")
      .mockImplementation(() => {
        throw new TypeError("simulated defect");
      });
    try {
      await expect(readAndroidManifestFromApk(path)).rejects.toThrow(
        "simulated defect",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows cancellation instead of reporting a parse failure", async () => {
    const path = await write("cancel.apk", splitSetApk("base"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      readAndroidManifestFromApk(path, controller.signal),
    ).rejects.toThrow();
  });
});
