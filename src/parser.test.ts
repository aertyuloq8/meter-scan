import { describe, expect, it } from "vitest";
import {
  chooseBestQrText,
  countDistinctQrCodesForMeter,
  getMeterPairStatus,
  hasMeterQrPair,
  isMeterPairComplete,
  isServiceQrText,
  mergeQrTexts,
  normalizeQrText,
  parseQrText,
  parseServiceQrText,
  scanMessage,
  selectBatchMeterHint,
} from "./parser";

describe("normalizeQrText", () => {
  it("removes all whitespace", () => {
    expect(normalizeQrText("  LOLH 123456 ;  24 / 5 ")).toBe("LOLH123456;24/5");
  });
});

describe("parseQrText", () => {
  it("extracts meter number, model, date and inspection number", () => {
    const parsed = parseQrText("LOLH12345678; 2601234567 ; 24/5 ; SC20-123");
    expect(parsed).not.toBeNull();
    expect(parsed?.meterNumber).toBe("2601234567");
    expect(parsed?.partialRecord.model).toBe("SC");
    expect(parsed?.partialRecord.manufactureDate).toBe("24/5");
    expect(parsed?.partialRecord.inspectionNumber).toBe("12345678");
  });

  it("handles the L0LH inspection prefix with zero", () => {
    const parsed = parseQrText("L0LH987654321; 2601234567");
    expect(parsed?.partialRecord.inspectionNumber).toBe("987654321");
  });

  it("picks the most frequent meter number among digits tokens", () => {
    const parsed = parseQrText("2601234567;123;2601234567;2601234567;AB");
    expect(parsed?.meterNumber).toBe("2601234567");
  });

  it("returns null for unreadable text", () => {
    expect(parseQrText("no useful information here")).toBeNull();
  });

  it("rejects too-short digit tokens as meter numbers", () => {
    const parsed = parseQrText("LOLH12345678; 123 ; 24/5");
    expect(parsed?.meterNumber).toBe("");
    expect(parsed?.partialRecord.inspectionNumber).toBe("12345678");
  });
});

describe("mergeQrTexts", () => {
  it("adds a new meter from the first QR", () => {
    const result = mergeQrTexts([], [], ["LOLH12345678; 2601234567 ; 24/5 ; SC20-123"]);
    expect(result.added).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].meterNumber).toBe("2601234567");
    expect(result.seenQrTexts).toHaveLength(1);
  });

  it("merges the second QR of the same meter into the existing record", () => {
    const first = mergeQrTexts([], [], ["LOLH12345678; 2601234567 ; 24/5"]);
    const second = mergeQrTexts(first.records, first.seenQrTexts, ["LOLH99999999; 2601234567; 24/5"]);
    expect(second.added).toBe(1);
    expect(second.records).toHaveLength(1);
    expect(second.seenQrTexts).toHaveLength(2);
    expect(second.records[0].inspectionNumber).toBe("99999999");
    expect(hasMeterQrPair("2601234567", second.seenQrTexts)).toBe(true);
  });

  it("counts repeat scans as duplicates without adding records", () => {
    const first = mergeQrTexts([], [], ["LOLH12345678; 2601234567"]);
    const second = mergeQrTexts(first.records, first.seenQrTexts, ["LOLH12345678; 2601234567"]);
    expect(second.duplicates).toBe(1);
    expect(second.added).toBe(0);
    expect(second.records).toHaveLength(1);
  });

  it("counts unreadable QRs as invalid", () => {
    const result = mergeQrTexts([], [], ["garbage without digits"]);
    expect(result.invalid).toBe(1);
    expect(result.records).toHaveLength(0);
  });
});

describe("countDistinctQrCodesForMeter", () => {
  it("counts only unique texts belonging to the meter", () => {
    const seen = ["LOLH12345678; 2601234567", "LOLH99999999; 2601234567", "LOLH12345678; 2601234567", "LOLH555; 9999999999"];
    expect(countDistinctQrCodesForMeter("2601234567", seen)).toBe(2);
  });
});

describe("chooseBestQrText", () => {
  it("prefers the QR with the most parsed fields", () => {
    const rich = "LOLH12345678; 2601234567; 24/5; SC20-123";
    const poor = "2601234567";
    expect(chooseBestQrText([poor, rich])).toBe(rich);
  });
});

describe("isMeterPairComplete & getMeterPairStatus", () => {
  it("rejects record with only 1 QR scanned (missing inspectionNumber)", () => {
    const record = {
      meterNumber: "24094034",
      model: "GT",
      manufactureDate: "114/06",
      inspectionNumber: "",
      serviceNumber: "",
    };
    expect(isMeterPairComplete(record)).toBe(false);
    const status = getMeterPairStatus(record);
    expect(status.count).toBe(1);
    expect(status.label).toBe("1 / 2 缺檢驗號碼");
    expect(status.isComplete).toBe(false);
  });

  it("rejects record with only inspection QR scanned (missing model & date)", () => {
    const record = {
      meterNumber: "24094034",
      model: "",
      manufactureDate: "",
      inspectionNumber: "14A37241",
      serviceNumber: "",
    };
    expect(isMeterPairComplete(record)).toBe(false);
    const status = getMeterPairStatus(record);
    expect(status.count).toBe(1);
    expect(status.label).toBe("1 / 2 缺型式銘版");
    expect(status.isComplete).toBe(false);
  });

  it("accepts record when both inspection and model/date are present", () => {
    const record = {
      meterNumber: "24094034",
      model: "GT",
      manufactureDate: "114/06",
      inspectionNumber: "14A37241",
      serviceNumber: "",
    };
    const seen = [
      "ACBEL;GT-100;24094034;114/06",
      "L0LH14A37241;24094034",
    ];
    expect(isMeterPairComplete(record, seen)).toBe(true);
    const status = getMeterPairStatus(record, seen);
    expect(status.count).toBe(2);
    expect(status.label).toBe("2 / 2 配對成功");
    expect(status.isComplete).toBe(true);
  });

  it("treats restored/imported record as complete even if seenQrTexts only contains another meter's QR", () => {
    // 雲端還原或 Excel 匯入的完整資料：未在目前相機緩衝區掃過
    const restoredRecord = {
      meterNumber: "24094034",
      model: "GT",
      manufactureDate: "114/06",
      inspectionNumber: "14A37221",
      expiryDate: "125/05",
      serviceNumber: "41805634",
    };
    // 目前相機緩衝區只包含新掃描的另一顆電表 (24094054)
    const seenOtherMeters = [
      "AMC;RT-120;24094054;114/06",
      "L0LH14A37241;24094054",
    ];
    expect(isMeterPairComplete(restoredRecord, seenOtherMeters)).toBe(true);
    const status = getMeterPairStatus(restoredRecord, seenOtherMeters);
    expect(status.isComplete).toBe(true);
    expect(status.label).toBe("2 / 2 配對成功");
  });
});

describe("parseServiceQrText", () => {
  it("parses MS: 8-digit service numbers", () => {
    expect(parseServiceQrText("MS:40701139")?.serviceNumber).toBe("40701139");
  });

  it("is case-insensitive and tolerates dashes", () => {
    expect(parseServiceQrText("ms:40-7011-39")?.serviceNumber).toBe("40701139");
  });

  it("rejects wrong lengths and non-MS text", () => {
    expect(parseServiceQrText("MS:123")).toBeNull();
    expect(parseServiceQrText("40701139")).toBeNull();
    expect(parseServiceQrText("LOLH12345678; 2601234567")).toBeNull();
  });

  it("detects MS prefix without parsing", () => {
    expect(isServiceQrText("MS:40701139")).toBe(true);
    expect(isServiceQrText("LOLH12345678; 2601234567")).toBe(false);
  });
});

describe("selectBatchMeterHint", () => {
  const completeRecord = {
    serviceNumber: "",
    model: "GT",
    meterNumber: "24094034",
    manufactureDate: "114/06",
    inspectionNumber: "14A37241",
    expiryDate: "",
  };
  const completeSeen = ["ACBEL;GT-100;24094034;114/06", "L0LH14A37241;24094034"];

  it("hints a new meter not yet in records", () => {
    expect(selectBatchMeterHint(["24094034"], [], [])).toBe("24094034");
  });

  it("skips an already pair-complete meter", () => {
    expect(selectBatchMeterHint(["24094034"], [completeRecord], completeSeen)).toBeUndefined();
  });

  it("returns undefined for mixed or empty batches", () => {
    expect(selectBatchMeterHint(["111", "222"], [], [])).toBeUndefined();
    expect(selectBatchMeterHint([], [], [])).toBeUndefined();
  });
});

describe("scanMessage", () => {
  it("formats parsed fields into a human readable message", () => {
    const parsed = parseQrText("LOLH12345678; 2601234567; 24/5");
    const message = scanMessage(parsed);
    expect(message).toContain("檢驗號碼 12345678");
    expect(message).toContain("表號 2601234567");
    expect(message).toContain("製造日期 24/5");
  });
});

