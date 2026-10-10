import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./version";
import packageJson from "../package.json";
import { sanitizeData } from "./storage";

describe("版本同步與空白資料夾管理", () => {
  it("APP_VERSION 必須與 package.json 嚴格同步", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toBe("2.4.6");
  });

  it("sanitizeData 自動清理過往無任何紀錄的空白測試資料夾，保留今日與有紀錄資料夾", () => {
    const todayStr = (() => {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = `${now.getMonth() + 1}`.padStart(2, "0");
      const dd = `${now.getDate()}`.padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();

    const raw = {
      version: 1,
      folders: {
        "2026-09-01": { records: [], seenQrTexts: [] }, // 過去空資料夾，應被清理
        "2026-09-02": { records: [], seenQrTexts: ["dummy"] }, // 過去空資料夾（雖有殘留 QR 但無電表），應被清理
        "2026-09-03": {
          records: [
            {
              serviceNumber: "40440650",
              model: "RT",
              meterNumber: "12345678",
              manufactureDate: "114/07",
              inspectionNumber: "EA123456",
              expiryDate: "125/12",
            },
          ],
          seenQrTexts: [],
        }, // 有紀錄，應保留
        [todayStr]: { records: [], seenQrTexts: [] }, // 今日空資料夾，應保留
      },
    };

    const sanitized = sanitizeData(raw);

    expect(sanitized.folders["2026-09-01"]).toBeUndefined();
    expect(sanitized.folders["2026-09-02"]).toBeUndefined();
    expect(sanitized.folders["2026-09-03"]).toBeDefined();
    expect(sanitized.folders["2026-09-03"].records.length).toBe(1);
    expect(sanitized.folders[todayStr]).toBeDefined();
  });
});
