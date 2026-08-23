import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageName = "id.my.anciety.codever.e2e";
const activity = `${packageName}/id.my.anciety.codever.web.MainActivity`;
const installAction = "id.my.anciety.codever.action.INSTALL_NATIVE_UPDATE";
const publishAction = "id.my.anciety.codever.action.E2E_PUBLISH_NATIVE_RELEASE";
const versionEpoch = 1_577_836_800_000;

async function main() {
  assert.equal(
    process.env.CODEVER_ANDROID_UPDATE_E2E,
    "1",
    "Set CODEVER_ANDROID_UPDATE_E2E=1 to run the destructive .e2e package upgrade fixture.",
  );
  const serial = await selectEmulator();
  const root = mkdtempSync(join(tmpdir(), "codever-android-update-e2e-"));
  const port = await availablePort();
  const updateOrigin = `http://127.0.0.1:${port}`;
  const now = Date.now();
  const oldEpoch = now - 120_000;
  const newEpoch = now;
  const expectedVersionCode = versionCode(newEpoch);
  const oldApk = join(root, "old.apk");
  const newApk = join(root, "new.apk");
  const bundle = join(root, "bundle");
  const served = join(root, "served");
  let server: ReturnType<typeof spawn> | null = null;

  try {
    await buildE2eApk(oldEpoch, updateOrigin);
    copyFileSync("clients/android/app/build/outputs/apk/e2e/app-e2e.apk", oldApk);
    await buildE2eApk(newEpoch, updateOrigin);
    copyFileSync("clients/android/app/build/outputs/apk/e2e/app-e2e.apk", newApk);
    await run("pnpm", [
      "release:android-update",
      "--",
      "--apk", newApk,
      "--out", bundle,
      "--base-url", updateOrigin,
      "--allow-loopback-e2e", "true",
      "--release-note", "Native update E2E fixture",
    ]);

    mkdirSync(served, { recursive: true });
    symlinkSync(bundle, join(served, "native-updates"), "dir");
    writeFileSync(join(served, "index.html"), "<!doctype html><title>Codever update fixture</title>");
    server = spawn(
      "python3",
      ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", served],
      { stdio: "ignore" },
    );
    await waitForHttp(`${updateOrigin}/native-updates/releases/android/alpha/${expectedVersionCode}/`);
    await adb(serial, ["reverse", `tcp:${port}`, `tcp:${port}`]);

    await adb(serial, ["uninstall", packageName], true);
    await adb(serial, ["install", oldApk]);
    await adb(serial, ["shell", "appops", "set", packageName, "REQUEST_INSTALL_PACKAGES", "allow"]);
    await adb(serial, ["shell", "am", "start", "-n", activity]);
    await waitFor(
      "the old APK data directory",
      async () => runAsSucceeds(serial, ["test", "-d", "files"]),
      10_000,
    );
    await adb(serial, [
      "shell",
      `run-as ${packageName} sh -c 'printf preserved-update-state > files/native-update-e2e-sentinel'`,
    ]);
    const release = readFileSync(join(bundle, "client-release.json"));
    await adb(serial, [
      "shell", "am", "start", "-n", activity, "-a", publishAction,
      "--es", "native-release", release.toString("base64url"),
    ]);

    await waitFor(
      "the verified APK to become ready",
      async () => runAsSucceeds(serial, [
        "test", "-f", `no_backup/native-update-v2/${expectedVersionCode}.apk`,
      ]),
      90_000,
    );
    await adb(serial, [
      "shell", "am", "start", "-n", activity, "-a", installAction,
    ]);

    await waitFor(
      "Android to install the higher version",
      async () => {
        if ((await installedVersionCode(serial)) === expectedVersionCode) return true;
        await acceptInstallerConfirmation(serial);
        return false;
      },
      90_000,
    );
    const sentinel = await adb(serial, [
      "shell", "run-as", packageName, "cat", "files/native-update-e2e-sentinel",
    ]);
    assert.equal(sentinel.trim(), "preserved-update-state", "PackageInstaller lost application data.");

    await adb(serial, ["shell", "am", "start", "-n", activity]);
    await waitFor(
      "the new APK to converge and clear the obsolete ready artifact",
      async () => !(await runAsSucceeds(serial, [
        "test", "-f", `no_backup/native-update-v2/${expectedVersionCode}.apk`,
      ])),
      30_000,
    );
    process.stdout.write(
      `Android direct-update E2E passed on ${serial}: version ${versionCode(oldEpoch)} -> ${expectedVersionCode}, state preserved.\n`,
    );
  } catch (error) {
    const diagnostics = await adb(serial, [
      "shell", "run-as", packageName, "cat", "files/diagnostics/native-current.log",
    ], true);
    const packageState = await adb(serial, [
      "shell", "dumpsys", "package", packageName,
    ], true);
    process.stderr.write(
      `Native update E2E diagnostics:\n${diagnostics.slice(-40_000)}\n` +
      `Installed package state:\n${packageState.match(/versionCode=[^\n]+/)?.[0] ?? "unavailable"}\n`,
    );
    throw error;
  } finally {
    server?.kill("SIGTERM");
    await adb(serial, ["reverse", "--remove", `tcp:${port}`], true);
    await adb(serial, ["uninstall", packageName], true);
    rmSync(root, { recursive: true, force: true });
  }
}

async function buildE2eApk(epoch: number, updateOrigin: string) {
  await run("./gradlew", [":app:assembleE2e"], {
    cwd: "clients/android",
    env: {
      ...process.env,
      CODEVER_ANDROID_BUILD_EPOCH_MS: String(epoch),
      CODEVER_ANDROID_E2E_UPDATE_ORIGIN: updateOrigin,
    },
    timeout: 10 * 60_000,
  });
}

async function selectEmulator(): Promise<string> {
  const output = await run("adb", ["devices"]);
  const devices = output.split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts[0] && parts[1] === "device")
    .map((parts) => parts[0]!);
  const requested = process.env.CODEVER_ANDROID_SERIAL;
  const serial = requested ?? devices[0];
  assert(serial && devices.includes(serial), "Exactly one reachable Android test device is required.");
  const emulator = (await adb(serial, ["shell", "getprop", "ro.kernel.qemu"])).trim() === "1";
  assert(emulator, "The native update E2E is restricted to an emulator.");
  return serial;
}

async function installedVersionCode(serial: string): Promise<number | null> {
  const output = await adb(serial, ["shell", "dumpsys", "package", packageName], true);
  const value = output.match(/versionCode=([0-9]+)/)?.[1];
  return value ? Number(value) : null;
}

async function acceptInstallerConfirmation(serial: string) {
  await adb(serial, ["shell", "uiautomator", "dump", "/sdcard/codever-update-window.xml"], true);
  const xml = await adb(serial, ["shell", "cat", "/sdcard/codever-update-window.xml"], true);
  for (const node of xml.match(/<node\b[^>]+>/gu) ?? []) {
    if (!/text="(?:Update|Install)"/u.test(node)) continue;
    const bounds = node.match(/bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/u);
    if (!bounds) continue;
    const x = Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2);
    const y = Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2);
    await adb(serial, ["shell", "input", "tap", String(x), String(y)], true);
    return;
  }
}

async function runAsSucceeds(serial: string, command: string[]): Promise<boolean> {
  try {
    await adb(serial, ["shell", "run-as", packageName, ...command]);
    return true;
  } catch {
    return false;
  }
}

async function adb(serial: string, args: string[], tolerateFailure = false): Promise<string> {
  try {
    return await run("adb", ["-s", serial, ...args]);
  } catch (error) {
    if (tolerateFailure) return "";
    throw error;
  }
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForHttp(url: string) {
  await waitFor("the local update server", async () => {
    try {
      return (await fetch(url, { cache: "no-store" })).ok;
    } catch {
      return false;
    }
  }, 10_000);
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function versionCode(epoch: number): number {
  return Math.floor((epoch - versionEpoch) / 1_000) + 1;
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
