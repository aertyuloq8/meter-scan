import * as XLSX from "xlsx";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MeterRecord, StoredFolder } from "./types";
import { formatFullServiceNumber11, normalizeServiceNumberTo8Digits } from "./ocr";

const headers = ["電號", "型式", "表號", "製造日期", "檢驗號碼", "檢定期限", "匯出時間"] as const;

export type ExportDeliveryMode = "share" | "download" | "auto";

export type ExportResult = {
  fileName: string;
  recordCount: number;
  incompleteCount: number;
  delivery?: { shared: boolean; downloaded: boolean; cancelled?: boolean };
};

export function canBrowserShareFiles(): boolean {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) {
    return false;
  }
  try {
    const testFile = new File(["test"], "test.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

export async function exportRecords(
  records: MeterRecord[],
  folderDate: string,
  districtCode = "10",
  mode: ExportDeliveryMode = "auto",
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
  const delivery = await writeOrShareWorkbook(workbook, fileName, mode);

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
  const delivery = await writeOrShareWorkbook(workbook, fileName, mode);

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

async function writeOrShareWorkbook(
  workbook: XLSX.WorkBook,
  fileName: string,
  mode: ExportDeliveryMode = "auto",
): Promise<{ shared: boolean; downloaded: boolean; cancelled?: boolean }> {
  // 1. 原生 Capacitor App（若打包為 APK）
  if (isNativeApp()) {
    const base64 = XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
    const result = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Cache,
    });

    if (mode === "download") {
      await Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory: Directory.Documents,
      });
      return { shared: false, downloaded: true };
    }

    await Share.share({
      title: "匯出電表資料",
      text: fileName,
      url: result.uri,
      dialogTitle: "儲存或分享 Excel（可存至 Google 雲端硬碟、LINE）",
    });
    return { shared: true, downloaded: false };
  }

  // 2. Web 環境（PWA / 瀏覽器）
  const arrayBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const blob = new Blob([arrayBuffer], { type: mimeType });

  const shouldShare = mode === "share" || (mode === "auto" && canBrowserShareFiles());

  if (shouldShare && canBrowserShareFiles()) {
    try {
      const file = new File([blob], fileName, { type: mimeType });
      await navigator.share({
        title: "電表資料",
        text: `電表資料：${fileName}`,
        files: [file],
      });
      return { shared: true, downloaded: false };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { shared: false, downloaded: false, cancelled: true };
      }
      console.warn("Web Share 失敗，自動切換至下載：", error);
    }
  }

  downloadBlob(blob, fileName);
  return { shared: false, downloaded: true };
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