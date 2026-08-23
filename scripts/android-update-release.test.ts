import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNativeClientRelease,
  type AndroidApkMetadata,
} from "./android-update-release.js";

describe("Android account release bundle", () => {
  it("binds immutable APK metadata for Gateway publication", () => {
    const apkBytes = Buffer.from("signed-apk-fixture");
    const metadata: AndroidApkMetadata = {
      packageName: "id.my.anciety.codever",
      versionCode: 42,
      versionName: "0.1.0-alpha.42",
      minimumAndroid: 31,
      architecture: "arm64-v8a",
      signingCertificateSha256: "b".repeat(64),
    };
    const release = createNativeClientRelease({
      metadata,
      apkBytes,
      buildId: "android-alpha-42",
      channel: "alpha",
      publishedAt: 1_787_400_000_000,
      baseUrl: "https://rd.anciety.my.id",
      importance: "recommended",
      releaseNotes: ["Reliable direct updates"],
      artifactName: "codever.apk",
    });

    expect(release.artifact.sha256).toBe(
      createHash("sha256").update(apkBytes).digest("hex"),
    );
    expect(release.artifact.url).toContain(
      "/native-updates/releases/android/alpha/42/",
    );
    expect(release).toMatchObject({
      platform: "android",
      versionCode: 42,
      buildId: "android-alpha-42",
    });
    expect(release).not.toHaveProperty("signature");
  });
});
