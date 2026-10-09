import * as XLSX from "xlsx";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MeterRecord, StoredFolder } from "./types";
import { formatFullServiceNumber11, normalizeServiceNumberTo8Digits } from "./ocr";

import { uploadFileToDrive } from "./googleDrive";

const headers = ["電號", "型式", "表號", "製造日期", "檢驗號碼", "檢定期限", "匯出時間"] as const;

export type ExportDeliveryMode = "local" | "drive" | "both" | "share" | "download" | "auto";

export type ExportResult = {
  fileName: string;
  recordCount: number;
  incompleteCount: number;
  delivery?: {
    shared?: boolean;
    downloaded?: boolean;
    uploadedToDrive?: boolean;
    cancelled?: boolean;
    format?: "xlsx" | "csv";
    unsupported?: boolean;
    summaryText?: string;
    lineShareUrl?: string;
  };
};

export function canShareFile(file: File): boolean {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function canBrowserShareFiles(): boolean {
  if (typeof navigator === "undefined" || !navigator.share) {
    return false;
  }
  if (!navigator.canShare) {
    return true;
  }
  try {
    const testFile = new File(["test"], "test.csv", {
      type: "text/csv",
    });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

export function buildCsvBlob(rows: string[][]): Blob {
  const escapeCell = (val: string) => {
    const text = String(val ?? "");
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = rows.map((row) => row.map(escapeCell).join(","));
  const csvContent = "\uFEFF" + lines.join("\r\n");
  return new Blob([csvContent], { type: "text/csv" });
}

export async function exportRecords(
  records: MeterRecord[],
  folderDate: string,
  districtCode = "10",
  mode: ExportDeliveryMode = "auto",
  onProgress?: (percent: number) => void,
): Promise<ExportResult> {
  const exportTime = formattedNow();
  const rows: string[][] = records.map((record) => [
    record.serviceNumber ? formatFullServiceNumber11(record.serviceNumber, districtCode) : "",
    record.model,
    record.meterNumber,
    record.manufactureDate,
    record.inspectionNumber,
    record.expiryDate || "",
    exportTime,
  ]);

  const fileName = `電表資料_${folderDate.replaceAll("-", "")}.xlsx`;
  const workbook = buildWorkbook([headers.slice(), ...rows], statsSheet(folderDate, records));
  const csvRows = [headers.slice(), ...rows];
  const delivery = await writeOrShareWorkbook(
    workbook,
    fileName,
    mode,
    csvRows,
    `電表報表 · 日期：${folderDate} · 筆數：${records.length}筆`,
    onProgress,
  );

  return {
    fileName,
    recordCount: records.length,
    incompleteCount: records.filter((record) => !record.serviceNumber).length,
    delivery,
  };
}

export async function exportAllDates(
  folders: Record<string, MeterRecord[]>,
  preferredOrder: string[],
  districtCode = "10",
  mode: ExportDeliveryMode = "auto",
  onProgress?: (percent: number) => void,
): Promise<ExportResult> {
  const exportTime = formattedNow();
  const dates = preferredOrder.filter((date) => (folders[date] ?? []).length > 0);
  const rows: string[][] = [];

  for (const date of dates) {
    for (const record of folders[date] ?? []) {
      rows.push([
        date,
        record.serviceNumber ? formatFullServiceNumber11(record.serviceNumber, districtCode) : "",
        record.model,
        record.meterNumber,
        record.manufactureDate,
        record.inspectionNumber,
        record.expiryDate || "",
        exportTime,
      ]);
    }
  }

  if (!rows.length) {
    throw new Error("沒有任何日期有資料可匯出");
  }

  const allHeaders = ["日期", ...headers] as const;
  const fileName = `電表資料全部_${exportTime.replace(/[/:]/g, "")}.xlsx`;
  const workbook = buildWorkbook([allHeaders.slice(), ...rows], undefined);
  const csvRows = [allHeaders.slice(), ...rows];
  const delivery = await writeOrShareWorkbook(
    workbook,
    fileName,
    mode,
    csvRows,
    `電表全部歷史報表 · 總筆數：${rows.length}筆`,
    onProgress,
  );

  return {
    fileName,
    recordCount: rows.length,
    incompleteCount: rows.filter((row) => !row[1]).length,
    delivery,
  };
}

export function incompleteCount(records: MeterRecord[]): number {
  return records.filter((record) => !record.serviceNumber).length;
}

export function restoreFromExcel(file: File): Promise<Record<string, StoredFolder>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取 Excel 檔失敗"));
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: "array" });
        const sheetName = workbook.SheetNames.find((name) => name.includes("電表")) ?? workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
          reject(new Error("Excel 檔內找不到資料工作表"));
          return;
        }

        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
        const headerIndex = rows.findIndex((row) => row.some((cell) => String(cell).trim() === "電號"));
        if (headerIndex < 0) {
          reject(new Error("Excel 格式錯誤：找不到「電號」欄位標題"));
          return;
        }

        const headerRow = rows[headerIndex].map((cell) => String(cell).trim());
        const columnOf = (name: string) => headerRow.indexOf(name);
        const colDate = columnOf("日期");
        const colExpiry = columnOf("檢定期限");
        const columns = ["電號", "型式", "表號", "製造日期", "檢驗號碼"].map(columnOf);
        if (columns.some((index) => index < 0)) {
          reject(new Error("Excel 格式錯誤：欄位標題不完整"));
          return;
        }

        let fallbackDate = "";
        if (colDate < 0) {
          fallbackDate = dateFromStatsSheet(workbook);
          if (!fallbackDate) {
            reject(new Error("找不到日期資訊，請改用「匯出全部」的 Excel 檔還原"));
            return;
          }
        }

        const folders: Record<string, StoredFolder> = {};
        let rowCount = 0;

        for (const row of rows.slice(headerIndex + 1)) {
          const values = columns.map((index) => String(row[index] ?? "").trim());
          if (!values.join("")) {
            continue;
          }
          const record: MeterRecord = {
            serviceNumber: normalizeServiceNumberTo8Digits(values[0]),
            model: values[1],
            meterNumber: values[2].replace(/\D/g, "").slice(0, 8),
            manufactureDate: values[3],
            inspectionNumber: values[4],
            expiryDate: colExpiry >= 0 ? String(row[colExpiry] ?? "").trim() : "",
          };
          const date = colDate >= 0 ? normalizeDate(String(row[colDate] ?? "")) : fallbackDate;
          if (!date) {
            continue;
          }
          const folder = folders[date] ?? { records: [], seenQrTexts: [] };
          folder.records.push(record);
          folders[date] = folder;
          rowCount += 1;
        }

        if (!rowCount) {
          reject(new Error("Excel 檔內沒有任何資料列"));
          return;
        }

        resolve(folders);
      } catch {
        reject(new Error("Excel 檔格式錯誤"));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function dateFromStatsSheet(workbook: XLSX.WorkBook): string {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "" });
    for (const row of rows) {
      if (String(row[0] ?? "").trim() === "統計日期") {
        return normalizeDate(String(row[1] ?? ""));
      }
    }
  }
  return "";
}

function normalizeDate(value: string): string {
  const text = value.trim().replace(/[/.]/g, "-");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const [y, m, d] = text.split("-").map((part) => part.padStart(2, "0"));
    return `${y}-${m}-${d}`;
  }
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return "";
}

function statsSheet(folderDate: string, records: MeterRecord[]): string[][] {
  const total = records.length;
  const incomplete = incompleteCount(records);
  return [
    ["統計日期", folderDate],
    ["總筆數", `${total}`],
    ["缺電號筆數", `${incomplete}`],
    ["完整筆數", `${total - incomplete}`],
  ];
}

function buildWorkbook(rows: string[][], stats: string[][] | undefined) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 14 },
    { wch: 8 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 18 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "電表資料");

  if (stats) {
    const statsSheetObj = XLSX.utils.aoa_to_sheet(stats);
    statsSheetObj["!cols"] = [{ wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(workbook, statsSheetObj, "統計");
  }

  return workbook;
}

function isAppleDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod|Macintosh/i.test(navigator.userAgent);
}

export function buildShareSummaryText(fileName: string, recordCount: number, csvRows?: string[][]): string {
  let text = `【電表資料報表】\n檔案：${fileName}\n筆數：共 ${recordCount} 筆\n匯出時間：${formattedNow()}`;
  if (csvRows && csvRows.length > 1) {
    const dataRows = csvRows.slice(1);
    const previewCount = Math.min(dataRows.length, 6);
    text += "\n\n📋 紀錄摘要：";
    for (let i = 0; i < previewCount; i++) {
      const row = dataRows[i];
      const isDateFirst = /^\d{4}-\d{2}-\d{2}$/.test(row[0] || "");
      const serviceNo = isDateFirst ? (row[1] || "(無電號)") : (row[0] || "(無電號)");
      const meterNo = isDateFirst ? (row[3] || row[2] || "") : (row[2] || row[1] || "");
      text += `\n${i + 1}. 電號 ${serviceNo} / 表號 ${meterNo}`;
    }
    if (dataRows.length > previewCount) {
      text += `\n...等共 ${dataRows.length} 筆電表資料`;
    }
  }
  return text;
}

async function writeOrShareWorkbook(
  workbook: XLSX.WorkBook,
  fileName: string,
  mode: ExportDeliveryMode = "auto",
  csvRows?: string[][],
  description?: string,
  onProgress?: (percent: number) => void,
): Promise<{
  shared?: boolean;
  downloaded?: boolean;
  uploadedToDrive?: boolean;
  cancelled?: boolean;
  format?: "xlsx" | "csv";
  unsupported?: boolean;
  summaryText?: string;
  lineShareUrl?: string;
}> {
  // 1. 原生 Capacitor App（若打包為 APK）
  if (isNativeApp()) {
    const base64 = XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
    const result = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Cache,
    });

    if (mode === "download" || mode === "local") {
      await Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory: Directory.Documents,
      });
      return { shared: false, downloaded: true, format: "xlsx" };
    }

    await Share.share({
      title: "匯出電表資料",
      text: fileName,
      url: result.uri,
      dialogTitle: "儲存或分享 Excel（可存至 Google 雲端硬碟、LINE）",
    });
    return { shared: true, downloaded: false, format: "xlsx" };
  }

  // 模式 C: 系統原生分享 (Web Share API) —— 優先執行，保持瞬態手勢（User Activation）有效！
  if (mode === "share") {
    const recordCount = csvRows && csvRows.length > 1 ? csvRows.length - 1 : 0;
    const textSummary = buildShareSummaryText(fileName, recordCount, csvRows);
    const lineShareUrl = `https://line.me/R/msg/text/?${encodeURIComponent(textSummary)}`;

    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      const isApple = isAppleDevice();

      // (A) Apple 裝置（iOS Safari / macOS）：支援原版 .xlsx
      if (isApple) {
        const arrayBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
        const xlsxMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        const xlsxBlob = new Blob([arrayBuffer], { type: xlsxMimeType });
        const xlsxFile = new File([xlsxBlob], fileName, { type: xlsxMimeType });

        if (canShareFile(xlsxFile)) {
          try {
            await navigator.share({
              title: "電表資料",
              text: `電表資料：${fileName}`,
              files: [xlsxFile],
            });
            return { shared: true, downloaded: false, format: "xlsx", summaryText: textSummary, lineShareUrl };
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              return { shared: false, downloaded: false, cancelled: true };
            }
          }
        }
      }

      // (B) Android / Chromium 裝置：FILE_TYPES.md 支援 text/csv（禁止 .xlsx）。
      // 避免 XLSX.write 耗時消耗點擊授權，直接以純 CSV 瞬間觸發系統原生分享！
      if (csvRows && csvRows.length > 0) {
        const csvBlob = buildCsvBlob(csvRows);
        const safeCsvFileName = fileName.replace(/\.xlsx$/i, ".csv");
        const csvFile = new File([csvBlob], safeCsvFileName, { type: "text/csv" });

        if (canShareFile(csvFile)) {
          try {
            await navigator.share({
              title: "電表資料",
              text: `電表資料：${safeCsvFileName}`,
              files: [csvFile],
            });
            return { shared: true, downloaded: false, format: "csv", summaryText: textSummary, lineShareUrl };
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              return { shared: false, downloaded: false, cancelled: true };
            }
          }
        }
      }

      // (C) 降級：若檔案拋送受限制，改以摘要文字呼叫原生分享面板（支援 LINE、Gmail）
      try {
        await navigator.share({
          title: "電表資料報表",
          text: textSummary,
        });
        return { shared: true, downloaded: false, format: "csv", summaryText: textSummary, lineShareUrl };
      } catch (textError) {
        if (textError instanceof Error && textError.name === "AbortError") {
          return { shared: false, downloaded: false, cancelled: true };
        }
      }
    }

    // (D) 若瀏覽器環境完全不支援 Web Share API（如 Android WebView、LINE 內建瀏覽器等）：
    // 回傳 unsupported 與 lineShareUrl，讓前端彈窗直接提供「一鍵分享至 LINE」與「複製內容」
    return {
      shared: false,
      downloaded: false,
      unsupported: true,
      format: "xlsx",
      summaryText: textSummary,
      lineShareUrl,
    };
  }

  // 2. Web 環境（非 share 模式：產生 XLSX）
  const arrayBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const xlsxMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const xlsxBlob = new Blob([arrayBuffer], { type: xlsxMimeType });

  // 模式 A: 上傳至 Google Drive (個人雲端硬碟) 或本機與雲端皆存
  if (mode === "drive" || mode === "both") {
    await uploadFileToDrive(
      xlsxBlob,
      fileName,
      xlsxMimeType,
      description || fileName,
      onProgress,
    );
    if (mode === "both") {
      downloadBlob(xlsxBlob, fileName);
      return { shared: false, downloaded: true, uploadedToDrive: true, format: "xlsx" };
    }
    return { shared: false, downloaded: false, uploadedToDrive: true, format: "xlsx" };
  }

  // 模式 B: 明確本地下載
  if (mode === "local" || mode === "download") {
    downloadBlob(xlsxBlob, fileName);
    return { shared: false, downloaded: true, format: "xlsx" };
  }

  // 模式 D: 自動（auto）在支援分享環境下嘗試分享
  if (mode === "auto" && canBrowserShareFiles() && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const xlsxFile = new File([xlsxBlob], fileName, { type: xlsxMimeType });
    if (canShareFile(xlsxFile)) {
      try {
        await navigator.share({
          title: "電表資料",
          text: `電表資料：${fileName}`,
          files: [xlsxFile],
        });
        return { shared: true, downloaded: false, format: "xlsx" };
      } catch {
        // 略過，降級下載
      }
    }
  }

  // 自動降級保底：本地下載
  downloadBlob(xlsxBlob, fileName);
  return { shared: false, downloaded: true, format: "xlsx" };
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formattedNow(): string {
  const now = new Date();
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}