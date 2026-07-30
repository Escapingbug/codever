export const MAX_QR_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_LIVE_SCAN_DIMENSION = 1_200;
const MAX_IMAGE_SCAN_DIMENSION = 2_048;

export type NativeQrDetector = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
};

type NativeQrDetectorConstructor = new (options?: {
  formats?: string[];
}) => NativeQrDetector;

export function createNativeQrDetector(): NativeQrDetector | null {
  const Detector = (
    globalThis as typeof globalThis & {
      BarcodeDetector?: NativeQrDetectorConstructor;
    }
  ).BarcodeDetector;
  if (!Detector) return null;
  try {
    return new Detector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export function drawVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): boolean {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  if (!video.videoWidth || !video.videoHeight) return false;
  drawSource(
    video,
    video.videoWidth,
    video.videoHeight,
    canvas,
    MAX_LIVE_SCAN_DIMENSION,
  );
  return true;
}

export async function detectQrFromCanvas(
  canvas: HTMLCanvasElement,
  nativeDetector: NativeQrDetector | null,
): Promise<string | null> {
  if (nativeDetector) {
    try {
      const value = (await nativeDetector.detect(canvas))[0]?.rawValue.trim();
      if (value) return value;
    } catch {
      // Native BarcodeDetector support varies by browser and platform. The
      // local pixel decoder below is the compatibility path.
    }
  }
  const context = getCanvasContext(canvas);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { decodeQrPixels } = await import("./qrDecodeFallback");
  return decodeQrPixels(pixels.data, pixels.width, pixels.height);
}

export async function decodeQrImageFile(file: File): Promise<string | null> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("Choose an image containing a Codever QR code.");
  }
  if (file.size > MAX_QR_IMAGE_BYTES) {
    throw new Error("The selected image is larger than 20 MB.");
  }

  const canvas = document.createElement("canvas");
  const nativeDetector = createNativeQrDetector();
  const bitmap = await loadImage(file);
  try {
    drawSource(
      bitmap.source,
      bitmap.width,
      bitmap.height,
      canvas,
      MAX_IMAGE_SCAN_DIMENSION,
    );
    return await detectQrFromCanvas(canvas, nativeDetector);
  } finally {
    bitmap.dispose();
  }
}

async function loadImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Fall through to an object URL for browsers whose createImageBitmap
      // cannot decode a camera format that their image element can display.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = document.createElement("img");
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("The selected image could not be decoded."));
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => URL.revokeObjectURL(objectUrl),
  };
}

function drawSource(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
  maxDimension: number,
): void {
  if (!sourceWidth || !sourceHeight) {
    throw new Error("The selected image has no readable pixels.");
  }
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = getCanvasContext(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot read QR image pixels.");
  return context;
}
