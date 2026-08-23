import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  nativeClientReleaseSchema,
  type NativeClientRelease,
} from "@codever/protocol";

const DEFAULT_BASE_URL = "https://rd.anciety.my.id";
const DEFAULT_CHANNEL = "alpha";
const MAX_APK_BYTES = 100 * 1024 * 1024;

export type AndroidApkMetadata = {
  packageName: string;
  versionCode: number;
  versionName: string;
  minimumAndroid: number;
  architecture: "arm64-v8a";
  signingCertificateSha256: string;
};

export function createNativeClientRelease(input: {
  metadata: AndroidApkMetadata;
  apkBytes: Buffer;
  buildId: string;
  channel: string;
  publishedAt: number;
  baseUrl: string;
  importance: "recommended" | "required";
  releaseNotes: string[];
  artifactName: string;
}): NativeClientRelease {
  const { metadata } = input;
  return nativeClientReleaseSchema.parse({
    platform: "android",
    channel: input.channel,
    architecture: metadata.architecture,
    packageName: metadata.packageName,
    versionCode: metadata.versionCode,
    versionName: metadata.versionName,
    buildId: input.buildId,
    publishedAt: input.publishedAt,
    minimumAndroid: metadata.minimumAndroid,
    nativeBridgeMinimum: 1,
    nativeBridgeMaximum: 1,
    importance: input.importance,
    releaseNotes: input.releaseNotes,
    artifact: {
      url: `${input.baseUrl}/native-updates/releases/android/${input.channel}/${metadata.versionCode}/${input.artifactName}`,
      size: input.apkBytes.byteLength,
      sha256: createHash("sha256").update(input.apkBytes).digest("hex"),
      signingCertificateSha256: metadata.signingCertificateSha256,
    },
  });
}

function main(argv: string[]) {
  const options = parseArguments(argv);
  const sdkRoot = androidSdkRoot(options.sdk);
  const tools = androidBuildTools(sdkRoot);
  const apkPath = resolve(required(options, "apk"));
  if (!existsSync(apkPath) || !statSync(apkPath).isFile()) {
    throw new Error(`APK does not exist: ${apkPath}`);
  }
  const metadata = inspectApk(apkPath, tools.aapt, tools.apksigner);
  const apkBytes = readFileSync(apkPath);
  if (apkBytes.byteLength < 1 || apkBytes.byteLength > MAX_APK_BYTES) {
    throw new Error("The APK exceeds the native update size boundary.");
  }
  const channel = options.channel ?? DEFAULT_CHANNEL;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) throw new Error("Invalid update channel.");
  const publishedAt = integerOption(options["published-at"], Date.now(), "published-at");
  const buildId = options["build-id"] ?? deriveNativeBuildId(metadata.versionName);
  const baseUrl = new URL(options["base-url"] ?? DEFAULT_BASE_URL);
  const allowLoopbackE2e = options["allow-loopback-e2e"] === "true";
  const loopbackE2eOrigin = allowLoopbackE2e &&
    baseUrl.protocol === "http:" && baseUrl.hostname === "127.0.0.1" &&
    Number(baseUrl.port) >= 1 && Number(baseUrl.port) <= 65_535;
  if (
    (baseUrl.protocol !== "https:" && !loopbackE2eOrigin) ||
    baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash ||
    baseUrl.pathname !== "/"
  ) {
    throw new Error("--base-url must be a credential-free HTTPS origin.");
  }
  const importance = options.importance ?? "recommended";
  if (importance !== "recommended" && importance !== "required") {
    throw new Error("--importance must be recommended or required.");
  }
  const releaseNotes = repeatedOption(argv, "release-note");
  if (releaseNotes.length > 20 || releaseNotes.some((note) => note.length < 1 || note.length > 500)) {
    throw new Error("Provide at most 20 non-empty release notes of at most 500 characters.");
  }
  const safeVersion = metadata.versionName.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 160);
  const artifactName = `codever-native-${safeVersion}-arm64.apk`;
  const release = createNativeClientRelease({
    metadata,
    apkBytes,
    buildId,
    channel,
    publishedAt,
    baseUrl: baseUrl.origin,
    importance,
    releaseNotes,
    artifactName,
  });
  const outputRoot = resolve(options.out ?? "dist/native-update");
  const releaseDirectory = join(
    outputRoot,
    "releases",
    "android",
    channel,
    String(metadata.versionCode),
  );
  const releasePath = join(outputRoot, "client-release.json");
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(dirname(releasePath), { recursive: true });
  const destinationApk = join(releaseDirectory, artifactName);
  if (existsSync(destinationApk)) {
    const existing = createHash("sha256").update(readFileSync(destinationApk)).digest("hex");
    if (existing !== release.artifact.sha256) {
      throw new Error("Refusing to overwrite an immutable release artifact.");
    }
  } else {
    copyFileSync(apkPath, destinationApk);
  }
  atomicWrite(releasePath, `${JSON.stringify(release)}\n`);
  process.stdout.write(`${JSON.stringify({
    releasePath,
    artifactPath: destinationApk,
    release,
  }, null, 2)}\n`);
}

function inspectApk(apkPath: string, aapt: string, apksigner: string): AndroidApkMetadata {
  const badging = run(aapt, ["dump", "badging", apkPath]);
  const packageMatch = badging.match(
    /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m,
  );
  const minimumMatch = badging.match(/^sdkVersion:'([0-9]+)'/m);
  const architectures = badging.match(/^native-code: (.+)$/m)?.[1]
    ?.match(/'([^']+)'/g)
    ?.map((value) => value.slice(1, -1)) ?? [];
  if (!packageMatch || !minimumMatch) throw new Error("Could not inspect APK metadata.");
  if (architectures.length !== 1 || architectures[0] !== "arm64-v8a") {
    throw new Error("The Alpha update APK must contain only arm64-v8a native code.");
  }
  const certificates = run(apksigner, ["verify", "--verbose", "--print-certs", apkPath]);
  const digest = certificates.match(/Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)/)?.[1];
  if (!digest || !/^[0-9a-fA-F]{64}$/.test(digest)) {
    throw new Error("The APK is unsigned or its signing certificate could not be inspected.");
  }
  return {
    packageName: packageMatch[1]!,
    versionCode: Number(packageMatch[2]),
    versionName: packageMatch[3]!,
    minimumAndroid: Number(minimumMatch[1]),
    architecture: "arm64-v8a",
    signingCertificateSha256: digest.toLowerCase(),
  };
}

function androidSdkRoot(explicit?: string): string {
  const configured = explicit || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (configured && existsSync(configured)) return resolve(configured);
  const localProperties = resolve("clients/android/local.properties");
  if (existsSync(localProperties)) {
    const match = readFileSync(localProperties, "utf8").match(/^sdk\.dir=(.+)$/m);
    if (match?.[1] && existsSync(match[1])) return resolve(match[1]);
  }
  throw new Error("Android SDK not found; supply --sdk or ANDROID_SDK_ROOT.");
}

function androidBuildTools(sdkRoot: string): { aapt: string; apksigner: string } {
  const root = join(sdkRoot, "build-tools");
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const aapt = join(root, version, "aapt");
    const apksigner = join(root, version, "apksigner");
    if (existsSync(aapt) && existsSync(apksigner)) return { aapt, apksigner };
  }
  throw new Error("Android aapt and apksigner were not found in build-tools.");
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed: ${(result.stderr || result.stdout).trim().slice(0, 1_000)}`);
  }
  return result.stdout;
}

function atomicWrite(path: string, value: string) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o644 });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    if (name !== "release-note" && parsed[name] !== undefined) {
      throw new Error(`Duplicate option --${name}.`);
    }
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function repeatedOption(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((value, index) => {
    if (value === `--${name}` && argv[index + 1]) values.push(argv[index + 1]!);
  });
  return values;
}

function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
}

function integerOption(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer.`);
  return parsed;
}

function deriveNativeBuildId(versionName: string): string {
  const marker = "-dev.";
  const markerIndex = versionName.indexOf(marker);
  if (markerIndex < 0) return `android-${versionName}`;
  return `android-${versionName.slice(markerIndex + marker.length).replace("+", "-")}`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
