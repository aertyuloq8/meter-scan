import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MeterRecord, StoredAppData, StoredFolder } from "./types";

export const STORAGE_KEY = "meter-scan-data-v3";
export const SCHEMA_VERSION = 3;

const LEGACY_STORAGE_KEY = "meter-scan-data-v2";
const IDB_NAME = "meter_scan_idb";
const IDB_VERSION = 1;
const IDB_STORE = "app_state";
const IDB_KEY = "main";

const defaultData: StoredAppData = {
  version: SCHEMA_VERSION,
  folders: {},
  districtCode: "10",
  servicePrefix: "",
  servicePrefixEnabled: false,
  scanIntervalMs: 1000,
  scanMode: "manual",
  serviceQrEnabled: true,
  keypadMode: "large",
  lastQrText: "",
  defaultExpiryDate: "",
  modelExpiryMap: {},
};

let cachedInMemoryData: StoredAppData | null = null;
let saveTimer: number | undefined;
let pendingData: StoredAppData | null = null;

// ===================== IndexedDB 底層存取 =====================

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("當前環境不支援 IndexedDB"));
      return;
    }

    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadFromIndexedDb(): Promise<StoredAppData | null> {
  try {
    const db = await openIndexedDb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => {
        if (req.result) {
          resolve(sanitizeData(req.result));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveToIndexedDb(data: StoredAppData): Promise<void> {
  try {
    const db = await openIndexedDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(data, IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn("寫入 IndexedDB 失敗：", error);
  }
}

// ===================== 同步與非同步資料載入 =====================

/**
 * 同步載入（用於 React 初始 state，優先從記憶體快取或 LocalStorage 取得以避免初次渲染空白）
 */
export function loadData(): StoredAppData {
  if (cachedInMemoryData) {
    return cachedInMemoryData;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const sanitized = sanitizeData(JSON.parse(raw));
      cachedInMemoryData = sanitized;
      return sanitized;
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const migrated = { ...sanitizeData(JSON.parse(legacyRaw)), scanMode: "manual" as const };
      cachedInMemoryData = migrated;
      persistNow(migrated);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return migrated;
    }
  } catch {
    // 忽略 LocalStorage 讀取例外
  }

  const def = cloneDefault();
  cachedInMemoryData = def;
  return def;
}

/**
 * 應用程式啟動時呼叫：從 IndexedDB 載入完整資料庫
 * 自動同步記憶體快取與回傳最新資料（若 IndexedDB 為空則自動將現有資料遷移至 IndexedDB）
 */
export async function initStorage(onDataLoaded?: (data: StoredAppData) => void): Promise<StoredAppData> {
  const idbData = await loadFromIndexedDb();

  if (idbData) {
    cachedInMemoryData = idbData;
    onDataLoaded?.(idbData);
    return idbData;
  }

  // IndexedDB 尚無資料，從 LocalStorage 遷移進 IndexedDB
  const current = loadData();
  await saveToIndexedDb(current);
  return current;
}

export function sanitizeData(raw: unknown): StoredAppData {
  if (!raw || typeof raw !== "object") {
    return cloneDefault();
  }

  const candidate = raw as Partial<StoredAppData>;
  const folders: Record<string, StoredFolder> = {};

  const todayStr = (() => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = `${now.getMonth() + 1}`.padStart(2, "0");
    const dd = `${now.getDate()}`.padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  })();

  if (candidate.folders && typeof candidate.folders === "object") {
    for (const [date, folder] of Object.entries(candidate.folders)) {
      const safeFolder = folder as Partial<StoredFolder> | undefined;
      const records: MeterRecord[] = Array.isArray(safeFolder?.records)
        ? safeFolder.records.map((record) => ({
            serviceNumber: String(record.serviceNumber ?? ""),
            model: String(record.model ?? ""),
            meterNumber: String(record.meterNumber ?? ""),
            manufactureDate: String(record.manufactureDate ?? ""),
            inspectionNumber: String(record.inspectionNumber ?? ""),
            expiryDate: String(record.expiryDate ?? ""),
          }))
        : [];
      const seenQrTexts: string[] = Array.isArray(safeFolder?.seenQrTexts)
        ? safeFolder.seenQrTexts.map((text) => String(text)).filter(Boolean)
        : [];

      // 自動清理過往無任何電表資料的空白測試資料夾（保留今日工作空間）
      if (records.length === 0 && date !== todayStr) {
        continue;
      }

      folders[date] = { records, seenQrTexts };
    }
  }

  const modelExpiryMap: Record<string, string> = {};
  if (candidate.modelExpiryMap && typeof candidate.modelExpiryMap === "object") {
    for (const [model, expiry] of Object.entries(candidate.modelExpiryMap)) {
      if (model && typeof expiry === "string") {
        modelExpiryMap[model] = expiry;
      }
    }
  }

  return {
    version: SCHEMA_VERSION,
    folders,
    districtCode: String(candidate.districtCode ?? "10").replace(/\D/g, "").slice(0, 2) || "10",
    servicePrefix: String(candidate.servicePrefix ?? "").replace(/\D/g, ""),
    servicePrefixEnabled: Boolean(candidate.servicePrefixEnabled),
    scanIntervalMs:
      typeof candidate.scanIntervalMs === "number" && candidate.scanIntervalMs > 0
        ? candidate.scanIntervalMs
        : defaultData.scanIntervalMs,
    scanMode: candidate.scanMode === "auto" ? "auto" : "manual",
    serviceQrEnabled: candidate.serviceQrEnabled ?? true,
    keypadMode: candidate.keypadMode === "system" ? "system" : "large",
    lastQrText: String(candidate.lastQrText ?? ""),
    defaultExpiryDate: String(candidate.defaultExpiryDate ?? ""),
    modelExpiryMap,
  };
}

/**
 * 防抖儲存（400ms），寫入 IndexedDB 與記憶體快取，解決 LocalStorage 5MB 限制
 */
export function persistData(data: StoredAppData, delayMs = 400): void {
  cachedInMemoryData = data;
  pendingData = data;

  if (saveTimer !== undefined) {
    return;
  }

  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    if (pendingData) {
      persistNow(pendingData);
      pendingData = null;
    }
  }, delayMs);
}

/**
 * 立即儲存至 IndexedDB 與 LocalStorage 備援
 */
export function persistNow(data: StoredAppData): void {
  cachedInMemoryData = data;

  // 1. 寫入 IndexedDB（無 5MB 限制，高可靠性）
  void saveToIndexedDb(data);

  // 2. 備份至 LocalStorage（若容量滿了則容錯保護）
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn("LocalStorage 配額已滿，主要資料已安全存入 IndexedDB", error);
  }
}

export function flushPendingSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (pendingData) {
    persistNow(pendingData);
    pendingData = null;
  }
}

export async function exportBackup(data: StoredAppData): Promise<string> {
  const json = JSON.stringify(data, null, 2);
  const fileName = `電表資料備份_${timestampForName()}.json`;

  if (Capacitor.isNativePlatform()) {
    const result = await Filesystem.writeFile({
      path: fileName,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({
      title: "匯出電表資料備份",
      text: fileName,
      url: result.uri,
      dialogTitle: "儲存或分享 JSON 備份",
    });
    return fileName;
  }

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

export function restoreFromFile(file: File): Promise<StoredAppData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取備份檔失敗"));
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const sanitized = sanitizeData(parsed);
        if (!Object.keys(sanitized.folders).length && !sanitized.lastQrText) {
          reject(new Error("備份檔內容似乎不是有效的電表資料"));
          return;
        }
        persistNow(sanitized);
        resolve(sanitized);
      } catch {
        reject(new Error("備份檔格式錯誤"));
      }
    };
    reader.readAsText(file);
  });
}

function timestampForName(): string {
  const now = new Date();
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function cloneDefault(): StoredAppData {
  return {
    ...defaultData,
    folders: {},
  };
}

export function resetStorageCacheForTests(): void {
  cachedInMemoryData = null;
  pendingData = null;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
}