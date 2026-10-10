export type MeterRecord = {
  serviceNumber: string;
  model: string;
  meterNumber: string;
  manufactureDate: string;
  inspectionNumber: string;
  expiryDate: string;
};

export type StoredFolder = {
  records: MeterRecord[];
  seenQrTexts: string[];
};

export type StoredAppData = {
  version: number;
  folders: Record<string, StoredFolder>;
  districtCode: string; // 區處代碼（2碼，預設 "10" 台南）
  servicePrefix: string;
  servicePrefixEnabled: boolean;
  scanIntervalMs: number;
  scanMode: "auto" | "manual";
  serviceQrEnabled: boolean;
  keypadMode: "large" | "system";
  lastQrText: string;
  defaultExpiryDate: string;
  modelExpiryMap: Record<string, string>;
  // 自訂 QR Code 識別標頭與規則
  serviceQrHeader: string; // 電號貼紙前綴標頭，預設 "MS:"
  inspectionQrHeaders: string; // 檢定號碼識別標頭，預設 "LOLH, L0LH"
  meterMinDigits: number; // 表號最小位數，預設 7
  meterMaxDigits: number; // 表號最大位數，預設 10
};

export type QrParseOptions = {
  serviceQrHeader?: string;
  inspectionQrHeaders?: string;
  meterMinDigits?: number;
  meterMaxDigits?: number;
};

export type Status = "idle" | "scanning" | "done" | "duplicate" | "error";

// 統一編輯抽屜 draft：掃描補電號（complete）與清單編輯（edit）共用
export type RecordEditDraft = {
  mode: "complete" | "edit";
  targetIndex?: number;
  anchorMeterNumber: string;
  serviceNumber: string;
  model: string;
  meterNumber: string;
  manufactureDate: string;
  inspectionNumber: string;
  expiryDate: string;
  prefix: string;
  prefixEnabled: boolean;
};
