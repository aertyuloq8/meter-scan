/// <reference types="vite/client" />

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}
