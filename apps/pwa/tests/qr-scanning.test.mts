import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import { decodeQrPixels } from "../app/qrDecodeFallback.ts";

test("decodes a dense Codever invitation with the browser fallback", () => {
  const link =
    "https://codever.example/#invite=" +
    Buffer.from("signed-device-invitation".repeat(40)).toString("base64url");
  const { pixels, width } = renderQrPixels(link);
  assert.equal(decodeQrPixels(pixels, width, width), link);
});

test("keeps a short encrypted invitation compact and scannable", () => {
  const link =
    "https://rd.anciety.my.id/#i=" +
    "a".repeat(22) +
    "&k=" +
    "b".repeat(43);
  const qr = QRCode.create(link, { errorCorrectionLevel: "L" });
  const { pixels, width } = renderQrPixels(link);

  assert.ok(link.length < 100);
  assert.ok(qr.modules.size <= 41);
  assert.equal(decodeQrPixels(pixels, width, width), link);
});

test("returns null when an image contains no QR code", () => {
  const width = 80;
  const pixels = new Uint8ClampedArray(width * width * 4);
  pixels.fill(255);
  assert.equal(decodeQrPixels(pixels, width, width), null);
});

test("rejects malformed pixel dimensions", () => {
  assert.throws(
    () => decodeQrPixels(new Uint8ClampedArray(8), 2, 2),
    /invalid dimensions/,
  );
});

function renderQrPixels(link: string) {
  const qr = QRCode.create(link, { errorCorrectionLevel: "L" });
  const quietZone = 4;
  const scale = 5;
  const modules = qr.modules.size;
  const width = (modules + quietZone * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);

  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - quietZone;
      const moduleY = Math.floor(y / scale) - quietZone;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < modules &&
        moduleY < modules &&
        qr.modules.get(moduleX, moduleY);
      const value = dark ? 0 : 255;
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }

  return { pixels, width };
}
