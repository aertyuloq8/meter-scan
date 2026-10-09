/**
 * Google Drive 雲端儲存與備份服務 (參考 webpro 核心架構)
 * 100% 用戶端伺服器無相依，透過 Google Identity Services (GIS) 與 OAuth 2.0 授權
 * 範圍限定 drive.file (僅存取此應用程式所建立之檔案，保障使用者隱私)
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_CLIENT_ID_DEFAULT = "1005424982828-ncebcgsd539occ7ds0rjpae3coodae9u.apps.googleusercontent.com";

let inMemoryToken: string | null = null;
let tokenExpiresAt = 0;

export function getDriveClientId(): string {
  if (typeof window === "undefined") return DRIVE_CLIENT_ID_DEFAULT;
  const fromUrl = new URLSearchParams(window.location.search).get("driveClientId");
  if (fromUrl) return fromUrl;
  const fromStorage = localStorage.getItem("meter_scan_drive_client_id");
  if (fromStorage) return fromStorage;
  return DRIVE_CLIENT_ID_DEFAULT;
}

export function setCustomDriveClientId(id: string): void {
  if (!id || id.trim() === "") {
    localStorage.removeItem("meter_scan_drive_client_id");
  } else {
    localStorage.setItem("meter_scan_drive_client_id", id.trim());
  }
  clearDriveAccessToken();
}

export function clearDriveAccessToken(): void {
  inMemoryToken = null;
  tokenExpiresAt = 0;
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPod/.test(navigator.userAgent) ||
    /iPad/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function loadGIS(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  // @ts-expect-error - google namespace on window
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("無法載入 Google 登入元件，請確認網路連線")));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("無法載入 Google 登入元件，請確認網路可連線 Google 後重試"));
    document.head.appendChild(script);
  });
}

function getDriveTokenViaRedirect(clientId: string, resumeData?: unknown): Promise<string> {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  if (resumeData) {
    try {
      sessionStorage.setItem("meter_drive_resume", JSON.stringify(resumeData));
    } catch {
      // 忽略超過配額
    }
  }
  sessionStorage.setItem("meter_drive_oauth_state", state);
  const redirectUri = encodeURIComponent(window.location.href.split("#")[0]);
  window.location.href =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + redirectUri +
    "&response_type=token" +
    "&scope=" + encodeURIComponent(DRIVE_SCOPE) +
    "&prompt=select_account" +
    "&state=" + state +
    "&include_granted_scopes=true";

  return new Promise(() => {
    // 頁面跳轉
  });
}

/**
 * 處理 iOS / 跳轉回調之 OAuth 權杖
 */
export function handleDriveOAuthRedirect(onResume?: (resume: any) => void): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token=")) return false;

  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("access_token");
  if (!token) return false;

  const state = params.get("state");
  const savedState = sessionStorage.getItem("meter_drive_oauth_state");
  if (state && savedState && savedState !== state) {
    console.warn("Drive OAuth state 不符，略過回跳處理");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return false;
  }
  sessionStorage.removeItem("meter_drive_oauth_state");

  inMemoryToken = token;
  const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
  tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  const resumeRaw = sessionStorage.getItem("meter_drive_resume");
  sessionStorage.removeItem("meter_drive_resume");
  if (resumeRaw && onResume) {
    try {
      const parsed = JSON.parse(resumeRaw);
      onResume(parsed);
    } catch {
      // ignore
    }
  }
  return true;
}

/**
 * 取得 Google Drive 存取權杖（Access Token）
 * 預設 reuseExisting 為 false：遵循使用者要求，每次點選雲端功能皆強制彈出 Google 帳號選擇視窗
 */
export async function getDriveAccessToken(
  resumeData?: unknown,
  reuseExisting = false,
): Promise<string> {
  const clientId = getDriveClientId();
  if (!clientId) {
    throw new Error("尚未設定 Google Client ID，無法連線雲端硬碟");
  }

  if (reuseExisting && inMemoryToken && tokenExpiresAt > Date.now() + 60000) {
    return inMemoryToken;
  }

  clearDriveAccessToken();

  if (isIOSDevice()) {
    return getDriveTokenViaRedirect(clientId, resumeData);
  }

  await loadGIS();

  return new Promise((resolve, reject) => {
    let settled = false;
    let popupHandle: Window | null = null;
    let pollTimer: number | null = null;
    const realOpen = window.open;

    const isPopupClosed = (popup: Window | null) => {
      try {
        return !!(popup && popup.closed);
      } catch {
        return false;
      }
    };

    const finish = (fn: (arg: any) => void, arg: any) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      window.open = realOpen;
      if (popupHandle && !isPopupClosed(popupHandle)) {
        try {
          popupHandle.close();
        } catch {
          // ignore
        }
      }
      fn(arg);
    };

    window.open = (...args: any[]) => {
      const opened = realOpen.apply(window, args as any);
      if (opened) popupHandle = opened;
      return opened;
    };

    pollTimer = window.setInterval(() => {
      if (isPopupClosed(popupHandle)) {
        finish(reject, new Error("Google 登入視窗已關閉，已取消"));
      }
    }, 400);

    const timeoutId = window.setTimeout(
      () => finish(reject, new Error("Google 登入逾時，請重試")),
      120000,
    );

    // @ts-expect-error - GIS on window
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      prompt: "select_account",
      callback: (resp: any) => {
        window.clearTimeout(timeoutId);
        if (resp.error) {
          return finish(
            reject,
            new Error("Google 登入失敗：" + (resp.error_description || resp.error)),
          );
        }
        inMemoryToken = resp.access_token;
        tokenExpiresAt = Date.now() + 3300000;
        finish(resolve, resp.access_token);
      },
    });

    client.requestAccessToken();
  });
}

export async function driveFetch(
  url: string,
  options: RequestInit = {},
  reuseExisting = true,
  maxRetries = 2,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const token = await getDriveAccessToken(undefined, reuseExisting);
      const resp = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const json = await resp.json();
          detail = json.error?.message || "";
        } catch {
          // ignore
        }

        // 若遇 503 (Service Unavailable)、500 或 429，依 Google 建議執行短暫延遲重試 (Exponential Backoff)
        if ((resp.status === 503 || resp.status === 500 || resp.status === 429) && attempt < maxRetries) {
          console.warn(
            `Google Drive API 暫時忙碌 (${resp.status})${detail ? `：${detail}` : ""}，將在 ${600 * (attempt + 1)}ms 後重試第 ${attempt + 1} 次...`,
          );
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }

        throw new Error(`Google Drive 請求失敗 (${resp.status})` + (detail ? `：${detail}` : ""));
      }

      return resp;
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        attempt < maxRetries &&
        (msg.includes("503") ||
          msg.includes("NetworkError") ||
          msg.includes("Failed to fetch") ||
          msg.includes("Load failed"))
      ) {
        console.warn(`Google Drive 連線抖動，將在 ${600 * (attempt + 1)}ms 後重試...`, msg);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Google Drive 請求失敗，請稍後重試");
}

export interface DriveUploadedFile {
  id: string;
  name: string;
}

// 即時同步快取：徹底解決 Google Drive 搜尋索引（Eventual Consistency）延遲與瀏覽器快取問題
const recentUploadedFiles = new Map<string, DriveFileInfo>();
const recentDeletedFileIds = new Set<string>();

export function recordRecentDriveUpload(file: DriveFileInfo): void {
  recentDeletedFileIds.delete(file.id);
  recentUploadedFiles.set(file.id, file);
}

export function recordRecentDriveDelete(fileId: string): void {
  recentUploadedFiles.delete(fileId);
  recentDeletedFileIds.add(fileId);
}

export function clearDriveSyncCache(): void {
  recentUploadedFiles.clear();
  recentDeletedFileIds.clear();
}

/**
 * 透過 Google Drive Resumable Upload 協定直接上傳檔案（支援即時進度百分比回報）
 */
export async function uploadFileToDrive(
  blob: Blob,
  name: string,
  mimeType: string,
  description = "",
  onProgress?: (percent: number) => void,
): Promise<DriveUploadedFile> {
  const token = await getDriveAccessToken();

  return new Promise((resolve, reject) => {
    const init = new XMLHttpRequest();
    init.open("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable");
    init.setRequestHeader("Authorization", `Bearer ${token}`);
    init.setRequestHeader("Content-Type", "application/json");
    init.setRequestHeader("X-Upload-Content-Type", mimeType);
    init.setRequestHeader("X-Upload-Content-Length", String(blob.size));

    init.onload = () => {
      const location = init.getResponseHeader("Location");
      if (init.status < 200 || init.status >= 300 || !location) {
        reject(new Error(`Google Drive 未提供上傳位址 (${init.status})`));
        return;
      }

      const put = new XMLHttpRequest();
      put.open("PUT", location);
      put.setRequestHeader("Content-Type", mimeType);
      put.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      put.onload = () => {
        if (put.status >= 200 && put.status < 300) {
          try {
            const parsed = JSON.parse(put.responseText);
            if (parsed.id) {
              recordRecentDriveUpload({
                id: parsed.id,
                name: parsed.name || name,
                size: blob.size,
                createdTime: new Date().toISOString(),
                description,
              });
            }
            resolve(parsed);
          } catch {
            resolve({ id: "", name });
          }
        } else {
          reject(new Error(`上傳至雲端失敗 (${put.status})，請確認網路後重試`));
        }
      };

      put.onerror = () => reject(new Error("上傳雲端硬碟連線失敗，請檢查網路連線"));
      put.send(blob);
    };

    init.onerror = () => reject(new Error("Google Drive 登入或連線逾時，請重試"));
    const metadata: Record<string, string> = { name, mimeType };
    if (description) {
      metadata.description = description.slice(0, 1000);
    }
    init.send(JSON.stringify(metadata));
  });
}

export interface DriveFileInfo {
  id: string;
  name: string;
  size?: number;
  createdTime?: string;
  description?: string;
}

/**
 * 查詢 Google 雲端硬碟中的電表備份或報表清單
 */
export async function listDriveBackups(keyword = "電表"): Promise<DriveFileInfo[]> {
  const query = encodeURIComponent(`name contains '${keyword}' and trashed = false`);
  const resp = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,size,createdTime,description)`,
    {},
    true,
  );
  const data = (await resp.json()) as { files?: DriveFileInfo[] };
  let remoteFiles = data.files || [];

  // 1. 濾除剛被刪除但 Google 搜尋索引尚未移除的幽靈檔案
  remoteFiles = remoteFiles.filter((f) => !recentDeletedFileIds.has(f.id));

  // 2. 自動合併剛剛上傳但 Google 搜尋索引尚未建置完成的最新檔案
  const remoteIds = new Set(remoteFiles.map((f) => f.id));
  const missingRecents: DriveFileInfo[] = [];
  for (const [id, file] of recentUploadedFiles.entries()) {
    if (!remoteIds.has(id) && !recentDeletedFileIds.has(id)) {
      missingRecents.push(file);
    }
  }

  // 最新檔案置於清單頂端
  return [...missingRecents, ...remoteFiles];
}

/**
 * 從 Google 雲端硬碟下載檔案 Blob（具備暫態錯誤重試保護）
 */
export async function downloadDriveFile(
  fileId: string,
  onProgress?: (percent: number) => void,
  maxRetries = 2,
): Promise<Blob> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const token = await getDriveAccessToken(undefined, true);
      const blob = await new Promise<Blob>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        xhr.responseType = "blob";
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);

        xhr.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response as Blob);
          } else {
            reject(new Error(`下載雲端檔案失敗 (${xhr.status})`));
          }
        };

        xhr.onerror = () => reject(new Error("下載雲端檔案連線失敗，請檢查網路連線"));
        xhr.send();
      });
      return blob;
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        attempt < maxRetries &&
        (msg.includes("503") ||
          msg.includes("500") ||
          msg.includes("連線失敗") ||
          msg.includes("NetworkError"))
      ) {
        console.warn(`下載雲端檔案暫態異常，將在 ${600 * (attempt + 1)}ms 後重試...`, msg);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("下載雲端檔案失敗，請稍後重試");
}

/**
 * 從 Google 雲端硬碟刪除檔案（具備 404 容錯保護）
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  recordRecentDriveDelete(fileId);
  try {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("notFound") || msg.includes("File not found")) {
      console.warn(`檔案 ${fileId} 在雲端已不存在 (404)，視為已清理成功`);
      return;
    }
    throw err;
  }
}
