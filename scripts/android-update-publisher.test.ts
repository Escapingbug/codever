import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Android update publisher", () => {
  it("uploads to the SSH artifact host and publishes through the local Gateway", () => {
    const root = mkdtempSync(join(tmpdir(), "codever-update-publisher-"));
    temporaryDirectories.push(root);
    const fakeBin = join(root, "bin");
    const bundle = join(root, "bundle");
    const versionCode = 42;
    const relativeArtifact =
      `releases/android/alpha/${versionCode}/codever-native-alpha-42.apk`;
    const artifact = join(bundle, relativeArtifact);
    const releasePath = join(bundle, "client-release.json");
    const adminSocket = join(root, "gateway-data", "admin.sock");
    const identityFile = join(root, "deploy-key");
    const sshLog = join(root, "ssh.log");
    const scpLog = join(root, "scp.log");
    const curlLog = join(root, "curl.log");
    const bytes = Buffer.from("signed-apk-fixture");
    const artifactUrl =
      `https://rd.anciety.my.id/native-updates/${relativeArtifact}`;

    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(artifact, bytes);
    writeFileSync(identityFile, "test-only-key");
    writeFileSync(releasePath, JSON.stringify({
      platform: "android",
      channel: "alpha",
      architecture: "arm64-v8a",
      versionCode,
      artifact: {
        url: artifactUrl,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }));
    writeExecutable(join(fakeBin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CODEVER_TEST_SSH_LOG"
cat >/dev/null || true
`);
    writeExecutable(join(fakeBin, "scp"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CODEVER_TEST_SCP_LOG"
`);
    writeExecutable(join(fakeBin, "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CODEVER_TEST_CURL_LOG"
printf '{"changed":true}'
`);

    const result = spawnSync(resolve("deploy/native-update/publish.sh"), [
      bundle,
      "ubuntu@rd.anciety.my.id",
      adminSocket,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CODEVER_TEST_SSH_LOG: sshLog,
        CODEVER_TEST_SCP_LOG: scpLog,
        CODEVER_TEST_CURL_LOG: curlLog,
        CODEVER_NATIVE_UPDATE_SSH_IDENTITY_FILE: identityFile,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const scpCalls = readFileSync(scpLog, "utf8");
    const sshCalls = readFileSync(sshLog, "utf8");
    expect(scpCalls).toContain(`-i ${identityFile}`);
    expect(scpCalls).toContain("artifact.apk");
    expect(scpCalls).not.toContain("client-release.json");
    expect(sshCalls).toContain(`-i ${identityFile}`);
    expect(sshCalls).not.toContain(adminSocket);
    const curlCalls = readFileSync(curlLog, "utf8");
    expect(curlCalls).toContain(`--head ${artifactUrl}`);
    expect(curlCalls).toContain(`--unix-socket ${adminSocket}`);
    expect(curlCalls).toContain(`--data-binary @${releasePath}`);
    expect(curlCalls).toContain("http://localhost/v1/client-releases/android");
    expect(result.stdout).toContain(
      "through the local Gateway",
    );
  });
});

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
