import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Codever agent workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Your agents, anywhere · Codever<\/title>/i);
  assert.match(html, /Matrix PWA rewrite/);
  assert.match(html, /Gateway online/);
  assert.match(html, /end-to-end encrypted/);
  assert.match(html, /Permission required/);
  assert.match(html, /Allow once/);
  assert.match(html, /Message Codex/);
  assert.match(html, /Real Matrix/);
  assert.match(html, /Connection mode/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("ships a complete installable offline shell", async () => {
  const [manifestText, serviceWorker, source, styles] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", appRoot), "utf8"),
    readFile(new URL("public/sw.js", appRoot), "utf8"),
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "Codever — Secure Agent Workspace");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(source, /navigator\.serviceWorker\?\.register\("\/sw\.js"\)/);
  assert.match(source, /setPermission\("approved"\)/);
  assert.match(source, /stopStreaming/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /\.mobile-chat-open \.conversation-panel/);
  await assert.rejects(access(new URL("app/_sites-preview", appRoot)));
});

test("keeps Real Matrix credentials local and signs strict command envelopes", async () => {
  const [matrix, settings, app, packageJson] = await Promise.all([
    readFile(new URL("app/matrix.ts", appRoot), "utf8"),
    readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
    readFile(new URL("app/CodeverApp.tsx", appRoot), "utf8"),
    readFile(new URL("package.json", appRoot), "utf8"),
  ]);

  assert.match(packageJson, /"matrix-js-sdk": "41\.0\.0"/);
  assert.match(packageJson, /"@codever\/security"/);
  assert.match(matrix, /initRustCrypto\(\{/);
  assert.match(matrix, /useIndexedDB: true/);
  assert.match(matrix, /cryptoDatabasePrefix:/);
  assert.match(matrix, /indexedDB\.open\(DEVICE_DATABASE/);
  assert.match(matrix, /signCommand\(command, identity\.privateKey/);
  assert.match(matrix, /kind: "signed_command"/);
  assert.match(matrix, /signed_command: envelope/);
  assert.match(matrix, /globalBlacklistUnverifiedDevices = true/);
  assert.match(matrix, /AllDevicesIsolationMode/);
  assert.match(matrix, /gatewayMatrixEd25519/);
  assert.match(matrix, /setDeviceVerified/);
  assert.match(matrix, /getOwnDeviceKeys\(\)/);
  assert.match(matrix, /Refusing to send to an unencrypted Matrix room/);
  assert.match(matrix, /localStorage\.setItem/);
  assert.doesNotMatch(matrix, /fetch\(["'`]\/api|server action|use server/i);
  assert.match(settings, /Credentials stay in this browser/);
  assert.match(app, /appMode.*"demo".*"matrix"/s);
  assert.match(app, /connectRealMatrix/);
  assert.match(app, /sendRealCommand/);
});
