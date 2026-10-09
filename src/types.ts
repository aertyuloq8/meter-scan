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
