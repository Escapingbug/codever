declare module "qrcode/lib/browser.js" {
  import type {
    QRCodeRenderersOptions,
    QRCodeSegment,
  } from "qrcode";

  type BrowserQrCode = {
    toDataURL(
      text: string | QRCodeSegment[],
      options?: QRCodeRenderersOptions,
    ): Promise<string>;
  };

  const QRCode: BrowserQrCode;
  export default QRCode;
}
