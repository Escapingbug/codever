import jsQR from "jsqr";

export function decodeQrPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels.length !== width * height * 4
  ) {
    throw new Error("QR image pixels have invalid dimensions.");
  }
  const decoded = jsQR(pixels, width, height, {
    inversionAttempts: "attemptBoth",
  })?.data.trim();
  return decoded || null;
}
