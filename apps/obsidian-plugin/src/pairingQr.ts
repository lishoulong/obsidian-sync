import * as QRCode from "qrcode";

export async function createPairingQrDataUrl(link: string): Promise<string> {
  const svg = await QRCode.toString(link, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    color: {
      dark: "#000000",
      light: "#ffffff"
    }
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
