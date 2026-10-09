import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { normalizeQrText } from "./parser";

export type ImageScanResult = {
  qrTexts: string[];
};

export async function scanImage(file: File): Promise<ImageScanResult> {
  const imageUrl = URL.createObjectURL(file);

  try {
    return {
      qrTexts: await readQrCodes(file, imageUrl),
    };
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function readQrCodes(file: File, imageUrl: string): Promise<string[]> {
  const results = new Set<string>();

  try {
    for (const result of await readQrCodesWithBarcodeDetector(file)) {
      results.add(normalizeQrText(result));
    }

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new BrowserQRCodeReader(hints);
    const result = await reader.decodeFromImageUrl(imageUrl).catch(() => null);
    if (result?.getText()) {
      results.add(normalizeQrText(result.getText()));
    }

    return [...results].filter(Boolean);
  } catch {
    return [...results].filter(Boolean);
  }
}

async function readQrCodesWithBarcodeDetector(file: File): Promise<string[]> {
  if (!("BarcodeDetector" in window)) {
    return [];
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return [];
  }
  try {
    // 手機原圖常達 12MP，先降到長邊 1920 再切塊辨識，避免低階機 OOM；QR 解碼不需要全解析度
    const scaled = await downscaleBitmap(bitmap, 1920);
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const detections = await detectAcrossCrops(detector, scaled);
    if (scaled !== bitmap) {
      scaled.close();
    }
    return [...new Set(detections.map((result) => result.rawValue).filter(Boolean))];
  } finally {
    bitmap.close();
  }
}

// 長邊超過 maxDim 時等比縮小，回傳新 bitmap（未超標則回傳原圖，呼叫端勿重複 close）
async function downscaleBitmap(bitmap: ImageBitmap, maxDim: number): Promise<ImageBitmap> {
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= maxDim) {
    return bitmap;
  }
  const scale = maxDim / longest;
  const width = Math.max(1, Math.floor(bitmap.width * scale));
  const height = Math.max(1, Math.floor(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return bitmap;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  try {
    return await createImageBitmap(canvas);
  } catch {
    return bitmap;
  }
}

async function detectAcrossCrops(
  detector: BarcodeDetector,
  bitmap: ImageBitmap,
): Promise<Array<{ rawValue: string }>> {
  const boxes = [
    [0, 0, 1, 1],
    [0, 0, 1, 0.58],
    [0, 0.42, 1, 0.58],
    [0.45, 0.3, 0.55, 0.4],
    [0.55, 0.48, 0.4, 0.28],
    [0.55, 0.6, 0.4, 0.22],
  ];
  const detections: Array<{ rawValue: string }> = [];

  for (const [x, y, width, height] of boxes) {
    const crop = await createImageBitmap(
      bitmap,
      Math.floor(bitmap.width * x),
      Math.floor(bitmap.height * y),
      Math.floor(bitmap.width * width),
      Math.floor(bitmap.height * height),
    );

    try {
      detections.push(...(await detector.detect(crop)));
    } finally {
      crop.close();
    }
  }

  return detections;
}