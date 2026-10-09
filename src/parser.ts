import type { MeterRecord } from "./types";

export type QrParseResult = {
  rawText: string;
  meterNumber: string;
  partialRecord: Partial<MeterRecord>;
};

export type QrMergeResult = {
  records: MeterRecord[];
  seenQrTexts: string[];
  added: number;
  updated: number;
  duplicates: number;
  invalid: number;
};

export function createEmptyRecord(): MeterRecord {
  return {
    serviceNumber: "",
    model: "",
    meterNumber: "",
    manufactureDate: "",
    inspectionNumber: "",
    expiryDate: "",
  };
}

export type ServiceQrParseResult = {
  rawText: string;
  serviceNumber: string;
};

/**
 * 電號貼紙 QR（MS: 開頭）與電表 QR 靠內容前綴自動分流，不用模式開關。
 * 格式：MS:40701139（純數字 8/10/11 碼，容許 dash/空白）。
 * 無前綴的純數字維持走電表路徑（可能誤判為表號，所以貼紙一定要印 MS:）。
 */
export function parseServiceQrText(rawText: string): ServiceQrParseResult | null {
  const cleaned = normalizeQrText(rawText);
  const match = cleaned.match(/^MS:(.+)$/i);
  if (!match) {
    return null;
  }

  const digits = (match[1] ?? "").replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 10 && digits.length !== 11) {
    return null;
  }

  return { rawText: cleaned, serviceNumber: digits };
}

export function isServiceQrText(rawText: string): boolean {
  return normalizeQrText(rawText).toUpperCase().startsWith("MS:");
}

/**
 * 同批掃到電表 QR + MS 貼紙時，判斷 MS 該不該吃這批的表號當歸屬。
 * 已配對完成的表不吃（避免存檔後下一幀殘留的舊表 QR 把亂入的 MS 導向覆蓋問句，
 * 這種一律走無鎖定流程，顯示請先掃描電表 QRcode）。
 */
export function selectBatchMeterHint(
  meterNumbers: string[],
  records: MeterRecord[],
  seenQrTexts: string[],
): string | undefined {
  const distinct = [...new Set(meterNumbers.filter(Boolean))];
  if (distinct.length !== 1) {
    return undefined;
  }

  const meterNumber = distinct[0];
  const record = records.find((item) => item.meterNumber === meterNumber);
  if (record && isMeterPairComplete(record, seenQrTexts)) {
    return undefined;
  }

  return meterNumber;
}

export function parseQrText(rawText: string): QrParseResult | null {
  const cleaned = normalizeQrText(rawText);
  const tokens = cleaned.split(";").map((token) => token.trim()).filter(Boolean);
  const partialRecord: Partial<MeterRecord> = {};
  const meterNumber = mostLikelyMeterNumber(tokens);

  if (meterNumber) {
    partialRecord.meterNumber = meterNumber;
  }

  const modelToken = tokens.find((token) => /^[A-Z0-9]{2,}-[A-Z0-9-]+$/i.test(token));
  if (modelToken) {
    partialRecord.model = modelToken.slice(0, 2).toUpperCase();
  }

  const dateToken = tokens.find((token) => /^\d{2,3}\/\d{1,2}$/.test(token));
  if (dateToken) {
    partialRecord.manufactureDate = dateToken;
  }

  const inspectionNumber = findInspectionNumber(tokens);
  if (inspectionNumber) {
    partialRecord.inspectionNumber = inspectionNumber;
  }

  if (!meterNumber && !Object.keys(partialRecord).length) {
    return null;
  }

  return {
    rawText: cleaned,
    meterNumber,
    partialRecord,
  };
}

export function mergeQrIntoRecords(records: MeterRecord[], rawText: string): MeterRecord[] {
  const parsed = parseQrText(rawText);
  if (!parsed) {
    return records;
  }

  const recordIndex = records.findIndex(
    (record) => parsed.meterNumber && record.meterNumber === parsed.meterNumber,
  );

  if (recordIndex >= 0) {
    return records.map((record, index) =>
      index === recordIndex ? mergeRecord(record, parsed.partialRecord) : record,
    );
  }

  return [mergeRecord(createEmptyRecord(), parsed.partialRecord), ...records];
}

export function mergeQrTexts(
  records: MeterRecord[],
  seenQrTexts: string[],
  rawTexts: string[],
): QrMergeResult {
  let nextRecords = records;
  let nextSeenQrTexts = seenQrTexts;
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const rawText of rawTexts) {
    const cleaned = normalizeQrText(rawText);
    if (!cleaned) {
      continue;
    }

    if (nextSeenQrTexts.includes(cleaned)) {
      duplicates += 1;
      const merged = mergeQrIntoRecords(nextRecords, cleaned);
      if (hasRecordChanges(nextRecords, merged)) {
        nextRecords = merged;
        updated += 1;
      }
      continue;
    }

    const merged = mergeQrIntoRecords(nextRecords, cleaned);
    if (merged === nextRecords) {
      invalid += 1;
      continue;
    }

    nextRecords = merged;
    nextSeenQrTexts = [cleaned, ...nextSeenQrTexts];
    added += 1;
  }

  return {
    records: nextRecords,
    seenQrTexts: nextSeenQrTexts,
    added,
    updated,
    duplicates,
    invalid,
  };
}

export function normalizeQrText(rawText: string): string {
  return rawText.replace(/\s+/g, "").trim();
}

export function countDistinctQrCodesForMeter(meterNumber: string, seenQrTexts: string[]): number {
  if (!meterNumber) {
    return 0;
  }

  return new Set(
    seenQrTexts
      .map((rawText) => normalizeQrText(rawText))
      .filter(Boolean)
      .filter((rawText) => parseQrText(rawText)?.meterNumber === meterNumber),
  ).size;
}

export function hasMeterQrPair(meterNumber: string, seenQrTexts: string[]): boolean {
  return countDistinctQrCodesForMeter(meterNumber, seenQrTexts) >= 2;
}

/**
 * 嚴謹判定電表是否完成兩組 QRCode 配對：
 * 1. 必須有表號 (meterNumber)
 * 2. 必須具備檢驗號碼 (inspectionNumber，來自檢定合格貼紙 QRCode)
 * 3. 必須具備型式 (model) 或製造日期 (manufactureDate，來自電表銘版 QRCode)
 * 4. 若傳入 seenQrTexts，必須至少有 2 組不同 QRCode 文本
 */
export function isMeterPairComplete(
  record: Partial<MeterRecord> | null | undefined,
  seenQrTexts?: string[],
): boolean {
  if (!record || !record.meterNumber) {
    return false;
  }

  const hasNameplateInfo = Boolean(record.model || record.manufactureDate);
  const hasInspectionInfo = Boolean(record.inspectionNumber);

  if (!hasNameplateInfo || !hasInspectionInfo) {
    return false;
  }

  if (seenQrTexts && seenQrTexts.length > 0) {
    return countDistinctQrCodesForMeter(record.meterNumber, seenQrTexts) >= 2;
  }

  return true;
}

/**
 * 取得當前電表記錄的 QRCode 配對狀態資訊
 */
export function getMeterPairStatus(
  record: Partial<MeterRecord> | null | undefined,
  seenQrTexts?: string[],
): { count: number; total: number; label: string; isComplete: boolean } {
  if (!record || (!record.meterNumber && !record.model && !record.inspectionNumber)) {
    return { count: 0, total: 2, label: "0 / 2 未掃描", isComplete: false };
  }

  const complete = isMeterPairComplete(record, seenQrTexts);
  if (complete) {
    return { count: 2, total: 2, label: "2 / 2 配對成功", isComplete: true };
  }

  const hasNameplate = Boolean(record.model || record.manufactureDate);
  const hasInspection = Boolean(record.inspectionNumber);

  if (hasNameplate && !hasInspection) {
    return { count: 1, total: 2, label: "1 / 2 缺檢驗號碼", isComplete: false };
  }
  if (!hasNameplate && hasInspection) {
    return { count: 1, total: 2, label: "1 / 2 缺型式銘版", isComplete: false };
  }

  return { count: 1, total: 2, label: "1 / 2 部分判別", isComplete: false };
}

export function mergeRecord(record: MeterRecord, patch: Partial<MeterRecord>): MeterRecord {
  return {
    serviceNumber: patch.serviceNumber || record.serviceNumber,
    model: patch.model || record.model,
    meterNumber: patch.meterNumber || record.meterNumber,
    manufactureDate: patch.manufactureDate || record.manufactureDate,
    inspectionNumber: patch.inspectionNumber || record.inspectionNumber,
    expiryDate: patch.expiryDate || record.expiryDate,
  };
}

export function chooseBestQrText(texts: string[]): string {
  return (
    texts
      .map((text) => ({ text, parsed: parseQrText(text) }))
      .sort((a, b) => scoreParsedQr(b.parsed) - scoreParsedQr(a.parsed))[0]?.text ?? ""
  );
}

export function scanMessage(parsed: QrParseResult | null): string {
  if (!parsed) {
    return "已掃描 QRCode";
  }

  const parts = [];
  if (parsed.partialRecord.inspectionNumber) {
    parts.push(`檢驗號碼 ${parsed.partialRecord.inspectionNumber}`);
  }
  if (parsed.partialRecord.model) {
    parts.push(`型式 ${parsed.partialRecord.model}`);
  }
  if (parsed.partialRecord.meterNumber) {
    parts.push(`表號 ${parsed.partialRecord.meterNumber}`);
  }
  if (parsed.partialRecord.manufactureDate) {
    parts.push(`製造日期 ${parsed.partialRecord.manufactureDate}`);
  }

  return parts.length ? `已掃描：${parts.join(" / ")}` : "已掃描 QRCode";
}

function scoreParsedQr(parsed: QrParseResult | null): number {
  if (!parsed) {
    return 0;
  }

  return (
    (parsed.partialRecord.inspectionNumber ? 8 : 0) +
    (parsed.partialRecord.model ? 4 : 0) +
    (parsed.partialRecord.manufactureDate ? 2 : 0) +
    (parsed.partialRecord.meterNumber ? 1 : 0)
  );
}

function mostLikelyMeterNumber(tokens: string[]): string {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    if (/^\d{7,10}$/.test(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function findInspectionNumber(tokens: string[]): string {
  for (const token of tokens) {
    const compactToken = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const knownPrefixMatch = compactToken.match(/^L[0O]LH([A-Z0-9]{6,})$/);
    if (knownPrefixMatch) {
      return knownPrefixMatch[1];
    }

    if (token.includes("-") || /^\d+$/.test(token) || /^\d{2,3}\/\d{1,2}$/.test(token)) {
      continue;
    }

    const match = token.match(/^[A-Z]+([0-9][A-Z0-9]{5,})$/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  return "";
}

function hasRecordChanges(previous: MeterRecord[], next: MeterRecord[]): boolean {
  if (previous.length !== next.length) {
    return true;
  }

  return previous.some((record, index) => {
    const nextRecord = next[index];
    return (
      record.serviceNumber !== nextRecord.serviceNumber ||
      record.model !== nextRecord.model ||
      record.meterNumber !== nextRecord.meterNumber ||
      record.manufactureDate !== nextRecord.manufactureDate ||
      record.inspectionNumber !== nextRecord.inspectionNumber ||
      record.expiryDate !== nextRecord.expiryDate
    );
  });
}