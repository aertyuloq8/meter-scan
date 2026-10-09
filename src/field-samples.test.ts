// 實機照片回放測試（2026-10-04 field-test：貼紙單 + RT-120 + GV-CGM）。
// QR 字串由 decode.js 從原圖直接解出，鎖死 parser 行為，避免現場格式漂移沒人發現。
import { describe, expect, it } from "vitest";
import { formatServiceNumber } from "./ocr";
import {
  getMeterPairStatus,
  isMeterPairComplete,
  mergeQrTexts,
  parseQrText,
  parseServiceQrText,
  selectBatchMeterHint,
} from "./parser";

const RT_NAMEPLATE = "AMC;RT-120;24196744;114/07";
const RT_INSPECTION = "L0LH14D41096;24196744";
const GV_NAMEPLATE = "CHEM;GV-CGM;23041742;113/12";
const GV_INSPECTION = "L0LH14305543;23041742";
const MS_02 = "MS:56965402";
const MS_03 = "MS:56965403";
const MS_04 = "MS:56965404";

describe("field RT-120 (24196744)", () => {
  it("parses nameplate fields", () => {
    const parsed = parseQrText(RT_NAMEPLATE);
    expect(parsed?.meterNumber).toBe("24196744");
    expect(parsed?.partialRecord.model).toBe("RT");
    expect(parsed?.partialRecord.manufactureDate).toBe("114/07");
    expect(parsed?.partialRecord.inspectionNumber ?? "").toBe("");
  });

  it("parses inspection QR", () => {
    const parsed = parseQrText(RT_INSPECTION);
    expect(parsed?.meterNumber).toBe("24196744");
    expect(parsed?.partialRecord.inspectionNumber).toBe("14D41096");
  });

  it("two QRs complete the pair (no sticker prompt missing)", () => {
    const first = mergeQrTexts([], [], [RT_NAMEPLATE]);
    expect(first.added).toBe(1);
    expect(isMeterPairComplete(first.records[0])).toBe(false);
    expect(getMeterPairStatus(first.records[0]).label).toBe("1 / 2 缺檢驗號碼");

    const second = mergeQrTexts(first.records, first.seenQrTexts, [RT_INSPECTION]);
    expect(second.records).toHaveLength(1);
    expect(isMeterPairComplete(second.records[0], second.seenQrTexts)).toBe(true);
    expect(getMeterPairStatus(second.records[0], second.seenQrTexts).label).toBe("2 / 2 配對成功");
  });

  it("re-scanning the same two QRs never forks a duplicate record (race guard)", () => {
    const base = mergeQrTexts([], [], [RT_NAMEPLATE]);
    const burstA = mergeQrTexts(base.records, base.seenQrTexts, [RT_INSPECTION]);
    // 第二包從同一快照算（模擬 bursts 沒等到最新 state），結果必須一致：單筆、完整
    const burstB = mergeQrTexts(base.records, base.seenQrTexts, [RT_INSPECTION]);
    for (const burst of [burstA, burstB]) {
      expect(burst.records).toHaveLength(1);
      expect(burst.records[0].meterNumber).toBe("24196744");
      expect(isMeterPairComplete(burst.records[0], burst.seenQrTexts)).toBe(true);
    }
  });
});

describe("field GV-CGM (23041742)", () => {
  it("two QRs complete the pair", () => {
    const first = mergeQrTexts([], [], [GV_NAMEPLATE]);
    expect(first.records[0].meterNumber).toBe("23041742");
    expect(first.records[0].model).toBe("GV");
    const second = mergeQrTexts(first.records, first.seenQrTexts, [GV_INSPECTION]);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].inspectionNumber).toBe("14305543");
    expect(isMeterPairComplete(second.records[0], second.seenQrTexts)).toBe(true);
  });
});

describe("field KT-A13 (25068560 - IMG_20260716_080052)", () => {
  const KT_NAMEPLATE = "ACBEL;KT-A13;25068560;114/11";
  const KT_INSPECTION = "L0LH15132054;25068560";

  it("parses nameplate and inspection QR", () => {
    const np = parseQrText(KT_NAMEPLATE);
    expect(np?.meterNumber).toBe("25068560");
    expect(np?.partialRecord.model).toBe("KT");
    expect(np?.partialRecord.manufactureDate).toBe("114/11");

    const insp = parseQrText(KT_INSPECTION);
    expect(insp?.meterNumber).toBe("25068560");
    expect(insp?.partialRecord.inspectionNumber).toBe("15132054");
  });

  it("two QRs complete the pair", () => {
    const res = mergeQrTexts([], [], [KT_NAMEPLATE, KT_INSPECTION]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0].meterNumber).toBe("25068560");
    expect(res.records[0].model).toBe("KT");
    expect(res.records[0].inspectionNumber).toBe("15132054");
    expect(isMeterPairComplete(res.records[0], res.seenQrTexts)).toBe(true);
  });
});

describe("field GV-CGM (24094034 & 24094054 - IMG_20260722_172432..55)", () => {
  const GV_34_NP = "CHEM;GV-CGM;24094034;114/09";
  const GV_34_INSP = "L0LH14A37221;24094034";
  const GV_54_NP = "CHEM;GV-CGM;24094054;114/09";
  const GV_54_INSP = "L0LH14A37241;24094054";

  it("parses 24094034 correctly", () => {
    const res = mergeQrTexts([], [], [GV_34_NP, GV_34_INSP]);
    expect(res.records[0].meterNumber).toBe("24094034");
    expect(res.records[0].model).toBe("GV");
    expect(res.records[0].inspectionNumber).toBe("14A37221");
    expect(isMeterPairComplete(res.records[0], res.seenQrTexts)).toBe(true);
  });

  it("parses 24094054 correctly", () => {
    const res = mergeQrTexts([], [], [GV_54_NP, GV_54_INSP]);
    expect(res.records[0].meterNumber).toBe("24094054");
    expect(res.records[0].model).toBe("GV");
    expect(res.records[0].inspectionNumber).toBe("14A37241");
    expect(isMeterPairComplete(res.records[0], res.seenQrTexts)).toBe(true);
  });
});

describe("field MS stickers", () => {
  it("decode to 8-digit service numbers matching the printed text", () => {
    expect(parseServiceQrText(MS_02)?.serviceNumber).toBe("56965402");
    expect(parseServiceQrText(MS_03)?.serviceNumber).toBe("56965403");
    expect(parseServiceQrText(MS_04)?.serviceNumber).toBe("56965404");
    expect(formatServiceNumber("56965402")).toBe("56-9654-02");
    expect(formatServiceNumber("56965403")).toBe("56-9654-03");
    expect(formatServiceNumber("56965404")).toBe("56-9654-04");
  });

  it("a completed meter does not hijack a stray sticker (no cover-loop)", () => {
    const done = mergeQrTexts([], [], [GV_NAMEPLATE]);
    const complete = mergeQrTexts(done.records, done.seenQrTexts, [GV_INSPECTION]);
    expect(
      selectBatchMeterHint(["23041742"], complete.records, complete.seenQrTexts),
    ).toBeUndefined();
  });

  it("a fresh meter in the same batch still provides the hint (gallery mixed photo)", () => {
    expect(selectBatchMeterHint(["24196744"], [], [])).toBe("24196744");
  });
});

