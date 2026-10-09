// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listDriveBackups,
  recordRecentDriveUpload,
  recordRecentDriveDelete,
  clearDriveSyncCache,
  clearDriveAccessToken,
} from "./googleDrive";

describe("Google Drive API 服務模組", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearDriveAccessToken();
    clearDriveSyncCache();
    window.open = vi.fn();
    // 預設模擬 GIS 回傳 token
    // @ts-expect-error test mock
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(({ callback }: any) => ({
            requestAccessToken: () => callback({ access_token: "test_token_123" }),
          })),
        },
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("listDriveBackups 產生的網址必須符合官方標準規範（無 _t 與無自訂 Cache 標頭）", async () => {
    let capturedUrl = "";
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn(async (url: any, options: any) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const files = await listDriveBackups("電表");

    expect(files).toEqual([]);
    // 驗證 URL 不帶任何 non-standard query 參數
    expect(capturedUrl).not.toContain("_t=");
    expect(capturedUrl).not.toContain("spaces=drive");
    expect(capturedUrl).toContain("https://www.googleapis.com/drive/v3/files?q=");
    expect(capturedUrl).toContain("orderBy=createdTime desc");
    expect(capturedUrl).toContain("pageSize=50");

    // 驗證標頭只有標準 Authorization，沒有被加入觸發 CORS 預檢失敗的 Expires/Pragma
    expect(capturedOptions?.headers?.Authorization).toBe("Bearer test_token_123");
    expect(capturedOptions?.headers?.Expires).toBeUndefined();
    expect(capturedOptions?.headers?.Pragma).toBeUndefined();
  });

  it("遇 503 暫態錯誤時，driveFetch 應自動重試並成功恢復", async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // 第一次模擬 503 Service Unavailable
        return new Response(JSON.stringify({ error: { message: "The service is temporarily unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 第二次成功回傳
      return new Response(JSON.stringify({ files: [{ id: "file_001", name: "電表備份_2026.json" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const files = await listDriveBackups("電表");

    expect(callCount).toBe(2);
    expect(files.length).toBe(1);
    expect(files[0].id).toBe("file_001");
  });

  it("本機即時快取應能克服 Google 搜尋索引延遲（即時顯示剛上傳與移除剛刪除）", async () => {
    // 模擬 Google Drive 搜尋索引尚未包含新上傳的檔案
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ files: [{ id: "old_file", name: "舊電表備份.json" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    // 模擬剛上傳新備份
    recordRecentDriveUpload({
      id: "just_uploaded",
      name: "最新電表備份.json",
      size: 1024,
      createdTime: new Date().toISOString(),
    });

    let files = await listDriveBackups("電表");
    expect(files.some((f) => f.id === "just_uploaded")).toBe(true);
    expect(files[0].id).toBe("just_uploaded"); // 最新上傳置於頂端

    // 模擬刪除舊備份
    recordRecentDriveDelete("old_file");
    files = await listDriveBackups("電表");
    expect(files.some((f) => f.id === "old_file")).toBe(false);

    // 切換帳號時快取清空
    clearDriveSyncCache();
    files = await listDriveBackups("電表");
    expect(files.length).toBe(1);
    expect(files[0].id).toBe("old_file");
  });
});
