import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPlus,
  Cloud,
  CloudDownload,
  CloudUpload,
  Database,
  Download,
  Edit3,
  FileSpreadsheet,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Upload,
  User,
  X,
  XCircle,
  Zap,
  ZapOff,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { BarcodeFormat, BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat as ZXBarcodeFormat, DecodeHintType } from "@zxing/library";
import {
  exportRecords,
  exportAllDates,
  incompleteCount,
  restoreFromExcel,
  canBrowserShareFiles,
  type ExportDeliveryMode,
} from "./exportExcel";
import {
  clearDriveAccessToken,
  clearDriveSyncCache,
  getDriveAccessToken,
  handleDriveOAuthRedirect,
  listDriveBackups,
  downloadDriveFile,
  deleteDriveFile,
  type DriveFileInfo,
} from "./googleDrive";
import { scanImage } from "./scanner";
import {
  chooseBestQrText,
  getMeterPairStatus,
  isMeterPairComplete,
  isServiceQrText,
  mergeQrTexts,
  normalizeQrText,
  parseQrText,
  parseServiceQrText,
  scanMessage,
  selectBatchMeterHint,
} from "./parser";
import {
  exportBackup,
  initStorage,
  loadData,
  persistData,
  restoreFromFile,
  restoreFromDriveBlob,
  flushPendingSave,
} from "./storage";
import { formatExpiryDate, formatServiceNumber, normalizeServiceNumberTo8Digits } from "./ocr";
import { feedbackDuplicate, feedbackError, feedbackSuccess, vibrate } from "./feedback";
import {
  LargeKeypad,
  RecordCard,
  RecordEditSheet,
  ScanDebug,
  type SheetEditableField,
} from "./components";
import type {
  MeterRecord,
  QrParseOptions,
  RecordEditDraft,
  Status,
  StoredAppData,
  StoredFolder,
} from "./types";
import { APP_VERSION } from "./version";

type HandleQrOptions = {
  continuous?: boolean;
};

type ActiveTab = "scan" | "list" | "settings";

type ExportTarget =
  | { type: "date"; date: string }
  | { type: "all" }
  | { type: "backup" };

export interface NoticeModalAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  styleClass?: string;
}

interface NoticeModalData {
  type?: "success" | "info" | "warning" | "error";
  title: string;
  message: string;
  details?: Array<{ label: string; value: string }>;
  confirmText?: string;
  onConfirm?: () => void;
  actions?: NoticeModalAction[];
}

export type CameraWindowSize = "large" | "xlarge" | "compact";

export function App() {
  const [data, setData] = useState<StoredAppData>(() => loadData());

  const qrParseOptions = useMemo<QrParseOptions>(
    () => ({
      serviceQrHeader: data.serviceQrHeader,
      inspectionQrHeaders: data.inspectionQrHeaders,
      meterMinDigits: data.meterMinDigits,
      meterMaxDigits: data.meterMaxDigits,
    }),
    [data.serviceQrHeader, data.inspectionQrHeaders, data.meterMinDigits, data.meterMaxDigits],
  );

  const [expandedSettingsCards, setExpandedSettingsCards] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("settings_expanded_cards");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // 略過
    }
    return {
      export: true,
      backup: false,
      scan: false,
      rules: false,
      qrRules: false,
      expiry: false,
      system: false,
      debug: false,
    };
  });

  function toggleSettingsCard(cardKey: string) {
    setExpandedSettingsCards((prev) => {
      const next = { ...prev, [cardKey]: !prev[cardKey] };
      try {
        localStorage.setItem("settings_expanded_cards", JSON.stringify(next));
      } catch {
        // 略過
      }
      return next;
    });
  }

  function setAllSettingsCards(open: boolean) {
    const next = {
      export: open,
      backup: open,
      scan: open,
      rules: open,
      qrRules: open,
      expiry: open,
      system: open,
      debug: open,
    };
    setExpandedSettingsCards(next);
    try {
      localStorage.setItem("settings_expanded_cards", JSON.stringify(next));
    } catch {
      // 略過
    }
  }

  const [cameraWindowSize, setCameraWindowSize] = useState<CameraWindowSize>(() => {
    try {
      const saved = localStorage.getItem("camera_window_size");
      if (saved === "large" || saved === "xlarge" || saved === "compact") {
        return saved;
      }
    } catch {
      // 略過
    }
    return "large";
  });

  function cycleCameraSize() {
    setCameraWindowSize((prev) => {
      const next = prev === "large" ? "xlarge" : prev === "xlarge" ? "compact" : "large";
      try {
        localStorage.setItem("camera_window_size", next);
      } catch {
        // 略過
      }
      return next;
    });
  }
  const [activeTab, setActiveTab] = useState<ActiveTab>("scan");
  const [activeDate, setActiveDate] = useState(today());
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("按掃描開始讀取 QRCode");
  const [cameraActive, setCameraActive] = useState(false);
  const [editDraft, setEditDraft] = useState<RecordEditDraft | null>(null);
  const [editError, setEditError] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [torchActive, setTorchActive] = useState(false);
  const [targetMeter, setTargetMeter] = useState<string | null>(null);
  const [showPreScanExpiryModal, setShowPreScanExpiryModal] = useState(false);
  const [skipPreScanExpiryCheck, setSkipPreScanExpiryCheck] = useState(false);
  const [preScanExpiryDraft, setPreScanExpiryDraft] = useState("");
  const [preScanKeypadOpen, setPreScanKeypadOpen] = useState(false);
  const [quickKeypadField, setQuickKeypadField] = useState<"prefix" | "expiryDate" | "districtCode" | null>(null);
  const [quickKeypadDraft, setQuickKeypadDraft] = useState("");
  const [selectedExportDate, setSelectedExportDate] = useState(today());
  const [scanEngine, setScanEngine] = useState<"native" | "mlkit" | "zxing" | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [driveProgress, setDriveProgress] = useState<{ percent: number; text: string } | null>(null);
  const [driveModal, setDriveModal] = useState<{
    type: "restore" | "delete";
    files: DriveFileInfo[];
    selectedIds: string[];
  } | null>(null);
  const [isDriveBusy, setIsDriveBusy] = useState(false);
  const [noticeModal, setNoticeModal] = useState<NoticeModalData | null>(null);
  const [justSavedMeter, setJustSavedMeter] = useState<string | null>(null);
  const justSavedMeterRef = useRef<{ meter: string; until: number } | null>(null);
  const isShareSupported = useMemo(() => canBrowserShareFiles() || isNativeApp(), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const webScannerStopRef = useRef<(() => void) | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const nativeScanActiveRef = useRef(false);
  const nativeScanStartedRef = useRef(false);
  const nativeStartInFlightRef = useRef(false);
  const nativeRestartReadyAtRef = useRef(0);
  const nativeListenerRef = useRef<{ remove: () => Promise<void> } | null>(null);
  const nativeSessionTextsRef = useRef(new Set<string>());
  const pendingCompletionRef = useRef<string | null>(null);
  const nativeSessionIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const continueScanTimerRef = useRef<number | null>(null);
  // 掃描監聽器一旦註冊就永遠閉包舊 render 的 state，
  // 事件處理一律讀這兩個 live ref（state 只管畫面，寫入時兩邊同步）。
  const editDraftRef = useRef<RecordEditDraft | null>(null);
  const targetMeterLiveRef = useRef<string | null>(null);
  const nativeTargetMeterRef = useRef<string | null>(null);
  const nativeProcessingRef = useRef(false);
  const scanReadyAtRef = useRef(0);
  const dataRef = useRef(data);
  const activeDateRef = useRef(activeDate);
  const cameraActiveRef = useRef(cameraActive);

  const activeFolder = data.folders[activeDate] ?? { records: [], seenQrTexts: [] };
  const records = activeFolder.records;

  // 啟動時從 IndexedDB 載入最新完整資料（解決 5MB 上限）
  useEffect(() => {
    void initStorage((freshData) => {
      dataRef.current = freshData;
      setData(freshData);
    });

    handleDriveOAuthRedirect((resume) => {
      if (resume?.type === "backup") {
        void handleDriveBackup();
      } else if (resume?.type === "restore") {
        void handleDriveRestoreList();
      } else if (resume?.type === "export" && resume.target) {
        void executeExport(resume.target, resume.mode || "drive");
      }
    });
  }, []);

  useEffect(() => {
    dataRef.current = data;
    persistData(data);
  }, [data]);

  useEffect(() => {
    activeDateRef.current = activeDate;
    setSelectedIndexes([]);
    setSelectionMode(false);
    setSearchQuery("");
  }, [activeDate]);

  useEffect(() => {
    cameraActiveRef.current = cameraActive;
  }, [cameraActive]);

  useEffect(() => {
    editDraftRef.current = editDraft;
  }, [editDraft]);

  useEffect(() => {
    targetMeterLiveRef.current = targetMeter;
  }, [targetMeter]);

  function setEditDraftLive(next: RecordEditDraft | null) {
    editDraftRef.current = next;
    setEditDraft(next);
  }

  function setTargetMeterLive(next: string | null) {
    targetMeterLiveRef.current = next;
    setTargetMeter(next);
  }

  useEffect(() => {
    isMountedRef.current = true;
    const onVisibilityChange = () => {
      if (document.hidden && cameraActiveRef.current) {
        void stopActiveScanner();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flushPendingSave);

    return () => {
      isMountedRef.current = false;
      if (continueScanTimerRef.current !== null) {
        window.clearTimeout(continueScanTimerRef.current);
        continueScanTimerRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flushPendingSave);
      void stopActiveScanner();
      flushPendingSave();
    };
  }, []);

  const folderDates = useMemo(() => {
    const dates = new Set([
      today(),
      ...Object.keys(data.folders).filter((d) => d === today() || (data.folders[d]?.records.length ?? 0) > 0),
    ]);
    if (activeDate) dates.add(activeDate);
    return [...dates].sort((a, b) => b.localeCompare(a));
  }, [activeDate, data.folders]);

  const incompleteInActiveFolder = useMemo(() => {
    return records.filter((r) => !r.serviceNumber.trim()).length;
  }, [records]);

  // 型式快選：全部日期出現過的型式（近→遠，最多 8 個），抽屜一點即填
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const dates = Object.keys(data.folders).sort((a, b) => b.localeCompare(a));
    for (const date of dates) {
      for (const record of data.folders[date]?.records ?? []) {
        const model = (record.model || "").trim();
        if (model && !seen.has(model)) {
          seen.add(model);
          ordered.push(model);
        }
      }
    }
    return ordered.slice(0, 8);
  }, [data.folders]);

  const totalAllRecordsCount = useMemo(() => {
    return Object.values(data.folders).reduce((acc, folder) => acc + folder.records.length, 0);
  }, [data.folders]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let entries = records.map((record, index) => ({ record, index }));

    if (incompleteOnly) {
      entries = entries.filter(({ record }) => !record.serviceNumber.trim());
    }

    if (!query) {
      return entries;
    }

    return entries.filter(({ record }) =>
      [record.serviceNumber, record.meterNumber, record.inspectionNumber, record.model].some(
        (value) => value.toLowerCase().includes(query),
      ),
    );
  }, [records, searchQuery, incompleteOnly]);

  const selectedCount = selectedIndexes.length;
  const lastParsedQr = useMemo(() => {
    const texts = data.lastQrText.split(/\r?\n/).filter(Boolean);
    return parseQrText(chooseBestQrText(texts, qrParseOptions), qrParseOptions);
  }, [data.lastQrText, qrParseOptions]);

  // 關鍵：掃描 bursts 間隔極短，React 的 function-updater 是非同步執行的，
  // 不能在 setData 後立刻讀結果（時而拿到、時而拿不到，造成提示消失、抽屜不彈）。
  // 這裡改同步算出 next 並立刻寫進 dataRef，setData 只負責觸發渲染。
  // 所有 updater 都是純計算（mergeQrTexts／物件展開），這樣做是安全的。
  function updateData(updater: (current: StoredAppData) => StoredAppData) {
    const next = updater(dataRef.current);
    dataRef.current = next;
    setData(next);
  }

  function updateActiveFolder(updater: (folder: StoredFolder) => StoredFolder) {
    updateData((current) => {
      const date = activeDateRef.current;
      const folder = current.folders[date] ?? { records: [], seenQrTexts: [] };
      return {
        ...current,
        folders: {
          ...current.folders,
          [date]: updater(folder),
        },
      };
    });
  }

  function deleteRecord(index: number) {
    if (!window.confirm("確定刪除這筆資料？此操作無法復原。")) {
      return;
    }

    const targetRecord = activeFolder.records[index];
    const targetMeter = targetRecord?.meterNumber;

    updateActiveFolder((folder) => {
      const records = folder.records.filter((_, recordIndex) => recordIndex !== index);
      const stillHasMeter = targetMeter && records.some((r) => r.meterNumber === targetMeter);
      const seenQrTexts = stillHasMeter || !targetMeter
        ? folder.seenQrTexts
        : folder.seenQrTexts.filter((raw) => parseQrText(raw)?.meterNumber !== targetMeter);

      return {
        ...folder,
        records,
        seenQrTexts,
      };
    });
    setSelectedIndexes((current) => current.filter((selectedIndex) => selectedIndex !== index));
    setStatus("done");
    setMessage("已刪除 1 筆資料");
  }

  function toggleSelection(index: number) {
    setSelectedIndexes((current) =>
      current.includes(index)
        ? current.filter((selectedIndex) => selectedIndex !== index)
        : [...current, index],
    );
  }

  function toggleSelectionMode() {
    setSelectionMode((current) => {
      if (current) {
        setSelectedIndexes([]);
      }
      return !current;
    });
  }

  function selectAllRecords() {
    setSelectionMode(true);
    setSelectedIndexes(filteredEntries.map(({ index }) => index));
  }

  function deleteSelectedRecords() {
    if (!selectedIndexes.length) {
      return;
    }

    const selectedSet = new Set(selectedIndexes);
    updateActiveFolder((folder) => {
      const records = folder.records.filter((_, index) => !selectedSet.has(index));
      // 與單筆刪除一致：清除已無紀錄參照的表號 QR 文本，避免殘留造成重掃誤判 duplicate
      const remainingMeters = new Set(records.map((record) => record.meterNumber).filter(Boolean));
      const seenQrTexts = folder.seenQrTexts.filter((raw) => {
        const meterNumber = parseQrText(raw)?.meterNumber || "";
        return !meterNumber || remainingMeters.has(meterNumber);
      });
      return { ...folder, records, seenQrTexts };
    });
    setSelectedIndexes([]);
    setSelectionMode(false);
    setStatus("done");
    setMessage(`已刪除 ${selectedSet.size} 筆資料`);
  }

  function deleteFolderByDate(targetDate: string) {
    if (!data.folders[targetDate]) {
      return;
    }

    const count = data.folders[targetDate]?.records.length ?? 0;
    const confirmMsg = count > 0
      ? `確定刪除 ${targetDate} 資料夾（內含 ${count} 筆資料）？此操作無法復原。`
      : `確定刪除 ${targetDate} 空白資料夾？`;

    if (!window.confirm(confirmMsg)) {
      return;
    }

    updateData((current) => {
      const nextFolders = { ...current.folders };
      delete nextFolders[targetDate];
      return { ...current, folders: nextFolders };
    });
    if (activeDate === targetDate) {
      setActiveDate(today());
    }
    if (selectedExportDate === targetDate) {
      setSelectedExportDate(today());
    }
    setSelectedIndexes([]);
    setSelectionMode(false);
    setStatus("done");
    setMessage(`已刪除 ${targetDate} 資料夾`);
  }

  function cleanupEmptyFolders() {
    const todayDate = today();
    const emptyDates = Object.keys(data.folders).filter(
      (d) => (data.folders[d]?.records.length ?? 0) === 0 && d !== todayDate
    );

    if (emptyDates.length === 0) {
      alert("目前沒有任何過往的空白日期資料夾！");
      return;
    }

    if (!window.confirm(`共發現 ${emptyDates.length} 個空白日期資料夾：\n${emptyDates.slice(0, 8).join("、")}${emptyDates.length > 8 ? " 等..." : ""}\n\n確定全部一鍵清理？`)) {
      return;
    }

    updateData((current) => {
      const nextFolders = { ...current.folders };
      for (const d of emptyDates) {
        delete nextFolders[d];
      }
      return { ...current, folders: nextFolders };
    });

    if (emptyDates.includes(activeDate)) {
      setActiveDate(todayDate);
    }
    if (emptyDates.includes(selectedExportDate)) {
      setSelectedExportDate(todayDate);
    }

    setStatus("done");
    setMessage(`已成功清理 ${emptyDates.length} 個空白日期資料夾`);
  }

  function addBlankRecord() {
    updateActiveFolder((folder) => ({
      ...folder,
      records: [
        {
          ...emptyRecord(),
          expiryDate: dataRef.current.defaultExpiryDate || "",
        },
        ...folder.records,
      ],
    }));
    setSelectionMode(false);
    setSelectedIndexes([]);
    setStatus("done");
    setMessage("已新增空白資料，可手動輸入電號");
  }

  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // 忽視 wake lock
    }
  }

  async function releaseWakeLock() {
    try {
      await wakeLockRef.current?.release();
    } catch {
      // 忽視
    }
    wakeLockRef.current = null;
  }

  // ===================== 手電筒 (Torch) 切換 =====================

  async function toggleTorch() {
    if (isNativeApp()) {
      try {
        await BarcodeScanner.toggleTorch();
        const res = await BarcodeScanner.isTorchEnabled();
        setTorchActive(res.enabled);
      } catch (err) {
        console.warn("原生手電筒切換失敗", err);
      }
      return;
    }

    // Web 模式透過 MediaStream Track 控制
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (track && "applyConstraints" in track) {
        const nextState = !torchActive;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await track.applyConstraints({ advanced: [{ torch: nextState } as any] });
        setTorchActive(nextState);
      }
    } catch (err) {
      console.warn("Web 手電筒不支援", err);
    }
  }

  // ===================== 連續掃描中途換表重置機制 =====================

  function resetTargetMeter() {
    nativeTargetMeterRef.current = null;
    pendingCompletionRef.current = null;
    setTargetMeterLive(null);
    nativeSessionTextsRef.current.clear();
    setStatus("scanning");
    setMessage("已重設電表鎖定，請對準新電表");
    feedbackSuccess();
  }

  async function startCamera() {
    if (!isMountedRef.current) {
      return;
    }
    pendingCompletionRef.current = null;
    targetMeterLiveRef.current = null;
    nativeTargetMeterRef.current = null;
    setTargetMeterLive(null);
    nativeSessionTextsRef.current.clear();
    if (isNativeApp()) {
      await startNativeContinuousScan();
      return;
    }

    await startWebScanner();
  }

  async function createWebBarcodeDetector(): Promise<BarcodeDetector | null> {
    if (typeof window !== "undefined" && "BarcodeDetector" in window && window.BarcodeDetector) {
      try {
        if (typeof BarcodeDetector.getSupportedFormats === "function") {
          const formats = await BarcodeDetector.getSupportedFormats();
          if (formats && !formats.includes("qr_code")) {
            return null;
          }
        }
        return new BarcodeDetector({ formats: ["qr_code"] });
      } catch (e) {
        console.warn("BarcodeDetector 初始化失敗", e);
      }
    }
    return null;
  }

  async function startWebScanner() {
    setCameraActive(true);
    if (!(justSavedMeterRef.current && Date.now() < justSavedMeterRef.current.until)) {
      setStatus("scanning");
      setMessage("相機已開啟，請對準電表 QRCode");
    }
    void acquireWakeLock();

    // 等待 DOM 掛載 video 節點
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    const video = videoRef.current;
    if (!video || !isMountedRef.current) {
      return;
    }

    // 1. 取得後置相機最佳串流（優先請求 1080p 高清與 60fps，大幅提升遠距與微小 QR 辨識率）
    let stream: MediaStream;
    const deviceId = await pickRearCameraDeviceId();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: { ideal: "environment" },
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
          frameRate: { ideal: 60, min: 30 },
        },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: deviceId ? { ideal: deviceId } : undefined,
            facingMode: { ideal: "environment" },
          },
        });
      } catch (err) {
        setStatus("error");
        setMessage("無法開啟相機，請檢查瀏覽器相機權限");
        await stopActiveScanner();
        return;
      }
    }

    if (!isMountedRef.current || !cameraActiveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // 2. 針對硬體啟用連續自動對焦（Continuous Auto-Focus）與曝光優化，防止近距離掃描模糊
    const track = stream.getVideoTracks()[0];
    if (track && "applyConstraints" in track) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capabilities = (track as any).getCapabilities?.() || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const advanced: any = {};
        if (capabilities.focusMode?.includes("continuous")) {
          advanced.focusMode = "continuous";
        }
        if (capabilities.exposureMode?.includes("continuous")) {
          advanced.exposureMode = "continuous";
        }
        if (capabilities.whiteBalanceMode?.includes("continuous")) {
          advanced.whiteBalanceMode = "continuous";
        }
        if (Object.keys(advanced).length > 0) {
          await track.applyConstraints({ advanced: [advanced] });
        }
      } catch {
        // 忽略個別硬體約束套用異常
      }
    }

    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // 忽略自動播放限制
    }

    // 3. 偵測硬體加速 BarcodeDetector (Chrome/Chromium 原生 ML Kit，極致 60FPS 多碼並行辨識)
    const detector = await createWebBarcodeDetector();

    if (detector) {
      setScanEngine("mlkit");
      let active = true;
      // 相機節流：每幀都辨識太耗電，限制最快 120ms 一次（約每秒 8 次），
      // 人手持至少停 0.5 秒，體感掃速不變，工作量剩約 1/7。
      let lastDetectAt = 0;
      const SCAN_THROTTLE_MS = 120;

      webScannerStopRef.current = () => {
        active = false;
        stopVideoTracks(video);
      };

      const scanFrame = async () => {
        if (!active || !cameraActiveRef.current || !videoRef.current) {
          return;
        }

        const now = Date.now();
        if (
          video.readyState >= 2 &&
          !nativeProcessingRef.current &&
          now - lastDetectAt >= SCAN_THROTTLE_MS
        ) {
          lastDetectAt = now;
          try {
            const detected = await detector.detect(video);
            if (detected.length > 0 && cameraActiveRef.current && canAcceptCameraScan()) {
              await handleScannedBarcodes(detected);
            }
          } catch {
            // 單幀可能丟失或忙碌，忽略
          }
        }

        if (active && cameraActiveRef.current) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ("requestVideoFrameCallback" in (video as any)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (video as any).requestVideoFrameCallback(() => {
              void scanFrame();
            });
          } else {
            requestAnimationFrame(() => {
              void scanFrame();
            });
          }
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ("requestVideoFrameCallback" in (video as any)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (video as any).requestVideoFrameCallback(() => {
          void scanFrame();
        });
      } else {
        requestAnimationFrame(() => {
          void scanFrame();
        });
      }
    } else {
      // 4. Fallback：ZXing 解碼器（針對 Safari / Firefox 等環境）
      setScanEngine("zxing");
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [ZXBarcodeFormat.QR_CODE]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserQRCodeReader(hints, { delayBetweenScanAttempts: 150 });

      try {
        const controls = await reader.decodeFromVideoElement(video, (result) => {
          if (!result || !cameraActiveRef.current) {
            return;
          }
          const text = result.getText();
          if (!text || !canAcceptCameraScan()) {
            return;
          }

          void handleScannedBarcodes([{ rawValue: text }]);
        });

        webScannerStopRef.current = () => {
          controls.stop();
          stopVideoTracks(video);
        };
      } catch (err) {
        console.warn("ZXing 啟動失敗", err);
        setStatus("error");
        setMessage("解碼器啟動失敗，請重試");
        await stopActiveScanner();
      }
    }
  }

  function stopCamera() {
    // 等貼紙中按停止：回到手輸，彈抽屜讓人工輸入電號
    justSavedMeterRef.current = null;
    setJustSavedMeter(null);
    const pendingMeter = pendingCompletionRef.current;
    pendingCompletionRef.current = null;
    void stopActiveScanner().then(() => {
      if (!pendingMeter) {
        setStatus("idle");
        setMessage("按掃描開始讀取 QRCode");
        return;
      }
      const folder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
      const pendingIndex = folder.records.findIndex((record) => record.meterNumber === pendingMeter);
      const pendingRecord = pendingIndex >= 0 ? folder.records[pendingIndex] : undefined;
      if (pendingRecord && !(pendingRecord.serviceNumber ?? "").replace(/\D/g, "")) {
        setTargetMeterLive(null);
        openCompletionDraft(pendingRecord, pendingIndex);
      } else {
        setStatus("idle");
        setMessage("按掃描開始讀取 QRCode");
      }
    });
  }

  function openQuickKeypad(field: "prefix" | "expiryDate" | "districtCode") {
    if (field === "prefix") {
      setQuickKeypadDraft(data.servicePrefix || "");
    } else if (field === "expiryDate") {
      setQuickKeypadDraft(data.defaultExpiryDate || "");
    } else if (field === "districtCode") {
      setQuickKeypadDraft(data.districtCode || "");
    }
    setQuickKeypadField(field);
  }

  function commitQuickKeypad() {
    if (!quickKeypadField) return;
    if (quickKeypadField === "prefix") {
      const clean = quickKeypadDraft.replace(/\D/g, "").slice(0, 6);
      setPrefix(clean);
      if (clean) {
        setPrefixEnabled(true);
      } else {
        setPrefixEnabled(false);
      }
      setMessage(clean ? `已設定固定前綴：${clean}` : "已清空固定前綴");
    } else if (quickKeypadField === "expiryDate") {
      const formatted = quickKeypadDraft ? formatExpiryDate(quickKeypadDraft) : "";
      updateData((current) => {
        const date = activeDateRef.current;
        const latestModel = current.folders[date]?.records[0]?.model || "";
        const nextMap = { ...current.modelExpiryMap };
        if (latestModel && formatted) {
          nextMap[latestModel] = formatted;
        }
        for (const key of Object.keys(nextMap)) {
          if (!nextMap[key]) delete nextMap[key];
        }
        return { ...current, defaultExpiryDate: formatted, modelExpiryMap: nextMap };
      });
      setMessage(formatted ? `已設定預設檢定期限：${formatted}` : "已清除預設檢定期限");
    } else if (quickKeypadField === "districtCode") {
      const clean = quickKeypadDraft.replace(/\D/g, "").slice(0, 2);
      setDistrictCode(clean);
      setMessage(clean ? `已設定區處代碼：${clean}` : "已還原預設區處代碼");
    }
    setQuickKeypadField(null);
  }

  function requestStartScan() {
    if (cameraActive) {
      stopCamera();
      return;
    }
    if (!skipPreScanExpiryCheck) {
      setPreScanExpiryDraft(data.defaultExpiryDate || "");
      setPreScanKeypadOpen(false);
      setShowPreScanExpiryModal(true);
      return;
    }
    void startCamera();
  }

  async function ensureNativeCameraPermission(): Promise<boolean> {
    try {
      const status = await BarcodeScanner.checkPermissions();
      if (status.camera === "granted") {
        return true;
      }
      const request = await BarcodeScanner.requestPermissions();
      if (request.camera === "granted") {
        return true;
      }
      setStatus("error");
      setMessage("相機權限被拒絕，請到系統設定開啟相機權限後再試");
      return false;
    } catch {
      // 舊版 plugin 無 permission API，交由掃描呼叫自行觸發系統授權
      return true;
    }
  }

  async function startNativeContinuousScan() {
    if (!isMountedRef.current) {
      return;
    }
    if (nativeScanActiveRef.current || nativeStartInFlightRef.current) {
      return;
    }

    if (!(await ensureNativeCameraPermission())) {
      return;
    }

    nativeStartInFlightRef.current = true;

    try {
      // 新 session 世代＋1：之前 hang 住還沒回來的 stop 收尾看到世代變了就會住手
      nativeSessionIdRef.current += 1;
      const currentSessionId = nativeSessionIdRef.current;
      const waitMs = nativeRestartReadyAtRef.current - Date.now();
      if (waitMs > 0) {
        await delay(waitMs);
      }

      if (!isMountedRef.current || nativeSessionIdRef.current !== currentSessionId) {
        return;
      }

      const supported = await BarcodeScanner.isSupported();
      if (!supported.supported) {
        setStatus("error");
        setMessage("此裝置不支援原生 QRCode 掃描");
        return;
      }

      nativeSessionTextsRef.current.clear();
      nativeTargetMeterRef.current = null;
      pendingCompletionRef.current = null;
      setTargetMeterLive(null);
      nativeProcessingRef.current = false;
      nativeScanActiveRef.current = true;
      setCameraActive(true);
      document.documentElement.classList.add("barcode-scanner-active");
      document.body.classList.add("barcode-scanner-active");
      if (!(justSavedMeterRef.current && Date.now() < justSavedMeterRef.current.until)) {
        setStatus("scanning");
        setMessage("連續掃描中，請先掃同一個電表的兩個 QRCode");
      }
      void acquireWakeLock();

      nativeListenerRef.current = await BarcodeScanner.addListener("barcodesScanned", (event) => {
        void handleNativeBarcodes(event.barcodes);
      });

      const started = await withNativeTimeout(
        BarcodeScanner.startScan({
          formats: [BarcodeFormat.QrCode],
        }).then(
          () => true,
          () => false,
        ),
        4000,
      );
      if (started === true && nativeScanActiveRef.current) {
        nativeScanStartedRef.current = true;
      } else {
        await withNativeTimeout(BarcodeScanner.stopScan().catch(() => undefined), 2500);
        if (started !== true) {
          throw new Error("相機啟動逾時，請重試");
        }
      }
    } catch (error) {
      await stopActiveScanner();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "連續掃描啟動失敗");
    } finally {
      nativeStartInFlightRef.current = false;
    }
  }

  async function handleScannedBarcodes(barcodes: Array<{ rawValue?: string; displayValue?: string }>) {
    const isScanning = isNativeApp() ? nativeScanActiveRef.current : cameraActiveRef.current;
    if (!isScanning || nativeProcessingRef.current) {
      return;
    }

    const candidateTexts = [...new Set(
      barcodes
        .map((barcode) => barcode.rawValue || barcode.displayValue || "")
        .map((text) => text.replace(/\s+/g, "").trim())
        .filter((text) => text && !nativeSessionTextsRef.current.has(text)),
    )];

    if (!candidateTexts.length) {
      return;
    }

    // MS 電號貼紙靠 MS: 前綴自動分流：同框有電表 QR 時先處理電表，
    // MS 留到下一幀再讀（屆時用鎖定或等貼紙狀態歸屬；都沒有就回請先掃描）
    const serviceTexts = candidateTexts.filter((text) => isServiceQrText(text, qrParseOptions));
    const meterTexts = candidateTexts.filter((text) => !isServiceQrText(text, qrParseOptions));

    // 0. 先檢驗當前鎖定表號：若該表已在資料庫中結案（已配對完成且已有電號），立即自動解鎖！
    const currentFolder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
    if (nativeTargetMeterRef.current) {
      const lockedRec = currentFolder.records.find((r) => r.meterNumber === nativeTargetMeterRef.current);
      if (
        lockedRec &&
        isMeterPairComplete(lockedRec, currentFolder.seenQrTexts, qrParseOptions) &&
        Boolean((lockedRec.serviceNumber ?? "").replace(/\D/g, ""))
      ) {
        nativeTargetMeterRef.current = null;
        setTargetMeterLive(null);
        pendingCompletionRef.current = null;
      }
    }

    if (!meterTexts.length) {
      for (const serviceText of serviceTexts) {
        nativeSessionTextsRef.current.add(serviceText);
        const parsedService = parseServiceQrText(serviceText, qrParseOptions);
        if (!parsedService) {
          setStatus("error");
          setMessage("電號貼紙格式不正確");
          feedbackError();
          continue;
        }
        handleServiceQrText(parsedService.rawText, parsedService.serviceNumber);
      }
      return;
    }

    // 2. 判斷已完成電表的舊 QR（若是已完成的表，提示移開）
    const completedOldTexts = meterTexts.filter((text) => isCompletedExistingQr(text));
    if (completedOldTexts.length) {
      completedOldTexts.forEach((text) => nativeSessionTextsRef.current.add(text));
      // 若當前畫面「只有」已完成的表，沒有任何新電表的 QR，才提示移動至下一台
      const hasAnyNew = meterTexts.some((text) => !completedOldTexts.includes(text));
      if (!hasAnyNew) {
        const completedMeter = parseQrText(completedOldTexts[0], qrParseOptions)?.meterNumber || "";
        if (
          justSavedMeterRef.current &&
          justSavedMeterRef.current.meter === completedMeter &&
          Date.now() < justSavedMeterRef.current.until
        ) {
          // 剛存好，鏡頭還停留在原表：保持安心綠色儲存成功提示，不跳紅光、不震動！
          return;
        }
        setStatus("duplicate");
        setMessage(
          completedMeter
            ? `此電表已完成 (表號 ${completedMeter})，請移至下一台`
            : "此電表已完成，請移動到下一個電表"
        );
        feedbackDuplicate();
        return;
      }
    }

    const newMeterCandidates = meterTexts.filter((text) => !completedOldTexts.includes(text));
    if (!newMeterCandidates.length) {
      return;
    }

    justSavedMeterRef.current = null;
    setJustSavedMeter(null);

    // 3. 自動切換電表鎖定（Auto-advance）：
    // 嚴格保護規則：
    // 若當前電表正在等待掃描電號貼紙 (pendingCompletionRef)，絕對禁止自動切換或被新電表取代！
    // 只有在當前「未鎖定任何電表」且「未在等待貼紙」；或者「當前鎖定的電表已完整結案（配對完成且已有電號）」時，才允許自動鎖定新電表！
    const detectedNewMeter =
      newMeterCandidates.map((text) => parseQrText(text, qrParseOptions)?.meterNumber || "").find(Boolean) || null;
    if (detectedNewMeter) {
      const currentLocked = nativeTargetMeterRef.current;
      if (!currentLocked) {
        if (!pendingCompletionRef.current) {
          nativeTargetMeterRef.current = detectedNewMeter;
          setTargetMeterLive(detectedNewMeter);
        }
      } else if (currentLocked !== detectedNewMeter) {
        // 當前已鎖定某電表：只有該電表「已配對完成且已有電號（已完整存檔結案）」才允許自動移至新電表
        const lockedRec = currentFolder.records.find((r) => r.meterNumber === currentLocked);
        const isCurrentFinished = lockedRec
          ? isMeterPairComplete(lockedRec, currentFolder.seenQrTexts, qrParseOptions) &&
            Boolean((lockedRec.serviceNumber ?? "").replace(/\D/g, ""))
          : false;

        // 若當前電表正在等貼紙 (pendingCompletionRef) 或尚未結案，嚴禁被新電表取代！
        if (isCurrentFinished && !pendingCompletionRef.current) {
          nativeTargetMeterRef.current = detectedNewMeter;
          setTargetMeterLive(detectedNewMeter);
        }
      }
    }

    const freshTexts = newMeterCandidates.filter((text) => {
      const meterNumber = parseQrText(text)?.meterNumber || "";
      // 等貼紙中：只允許當前待貼紙電表的 QR，任何其他新電表的 QR 一律過濾排除
      if (pendingCompletionRef.current) {
        return meterNumber === pendingCompletionRef.current;
      }
      return !nativeTargetMeterRef.current || meterNumber === nativeTargetMeterRef.current;
    });

    if (!freshTexts.length) {
      if (pendingCompletionRef.current) {
        setStatus("scanning");
        setMessage(`已配對表號${pendingCompletionRef.current}，請掃電號貼紙（無貼紙按停止改手輸）`);
        feedbackDuplicate();
      } else if (nativeTargetMeterRef.current) {
        setStatus("duplicate");
        setMessage(`已鎖定表號${nativeTargetMeterRef.current}，請掃同表號的第二個 QRCode`);
        feedbackDuplicate();
      }
      return;
    }

    freshTexts.forEach((text) => nativeSessionTextsRef.current.add(text));
    nativeProcessingRef.current = true;
    try {
      await handleQrTexts(freshTexts, { continuous: true });
    } finally {
      nativeProcessingRef.current = false;
    }
  }

  const handleNativeBarcodes = handleScannedBarcodes;

  function isCompletedExistingQr(rawText: string): boolean {
    if (isServiceQrText(rawText)) {
      return false;
    }
    // 等貼紙中的表不算已完成：重掃同表 QR 應提醒掃貼紙，而非叫人移下一台
    if (pendingCompletionRef.current) {
      const pendingMeter = parseQrText(normalizeQrText(rawText))?.meterNumber || "";
      if (pendingMeter && pendingMeter === pendingCompletionRef.current) {
        return false;
      }
    }
    const cleaned = normalizeQrText(rawText);
    const meterNumber = parseQrText(cleaned)?.meterNumber || "";
    if (!cleaned || !meterNumber) {
      return false;
    }

    const folder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
    const matchedRecord = folder.records.find((record) => record.meterNumber === meterNumber);
    if (!matchedRecord) {
      return false;
    }
    const hasService = Boolean((matchedRecord.serviceNumber ?? "").replace(/\D/g, ""));
    const pairComplete = isMeterPairComplete(matchedRecord, folder.seenQrTexts);
    // 只要此表已配對完成且已填電號，該電表即為已結案完成！
    if (pairComplete && hasService) {
      return true;
    }
    return folder.seenQrTexts.includes(cleaned) && pairComplete;
  }

  async function stopActiveScanner() {
    const shouldStopNative = nativeScanActiveRef.current || nativeScanStartedRef.current;
    // 世代標記：stop 的後半段是非同步收尾，若它 hang 住很久才回來，
    // 不能把期間已重啟的新 session 的監聽器和畫面一起拆掉
    nativeSessionIdRef.current += 1;
    const sessionId = nativeSessionIdRef.current;
    const listenerToRemove = nativeListenerRef.current;
    nativeScanActiveRef.current = false;
    nativeScanStartedRef.current = false;
    nativeSessionTextsRef.current.clear();
    nativeTargetMeterRef.current = null;
    setTargetMeterLive(null);
    nativeProcessingRef.current = false;

    if (webScannerStopRef.current) {
      try {
        webScannerStopRef.current();
      } catch {
        // 忽略
      }
      webScannerStopRef.current = null;
    }
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopVideoTracks(videoRef.current);
    setScanEngine(null);

    if (shouldStopNative) {
      // 原生呼叫在某些機種會 hang 住，加逾時自保，避免掃描線程整個卡死要重開 App
      await withNativeTimeout(BarcodeScanner.disableTorch().catch(() => undefined), 2500);
      await withNativeTimeout(BarcodeScanner.stopScan().catch(() => undefined), 2500);
    }

    // 有新 session 接手才跳過收尾（上面旗標已即時清掉，不影響新 session 運作）
    if (nativeSessionIdRef.current !== sessionId) {
      return;
    }

    setTorchActive(false);

    if (listenerToRemove && nativeListenerRef.current === listenerToRemove) {
      await withNativeTimeout(listenerToRemove.remove().catch(() => undefined), 2500);
      if (nativeListenerRef.current === listenerToRemove) {
        nativeListenerRef.current = null;
      }
    }
    document.documentElement.classList.remove("barcode-scanner-active");
    document.body.classList.remove("barcode-scanner-active");
    nativeRestartReadyAtRef.current = Date.now() + 650;
    scanReadyAtRef.current = 0;
    await releaseWakeLock();
    setCameraActive(false);
    setStatus((prev) => (prev === "scanning" || prev === "duplicate" ? "idle" : prev));
    setMessage((prev) =>
      prev.includes("請移至下一台") ||
      prev.includes("請移動到下一個電表") ||
      prev.includes("連續掃描中")
        ? "按掃描開始讀取 QRCode"
        : prev,
    );
  }

  function canAcceptCameraScan(): boolean {
    return Date.now() >= scanReadyAtRef.current;
  }

  function resolveExpiryDate(model: string, currentData: StoredAppData): string {
    if (model && currentData.modelExpiryMap[model]) {
      return currentData.modelExpiryMap[model];
    }
    return currentData.defaultExpiryDate || "";
  }

  function openCompletionDraft(record: MeterRecord, targetIndex?: number) {
    const prefix = dataRef.current.servicePrefix;
    const prefixEnabled = dataRef.current.servicePrefixEnabled;
    const expiry = record.expiryDate || resolveExpiryDate(record.model, dataRef.current);
    setEditError("");
    setEditDraftLive({
      mode: "complete",
      targetIndex,
      anchorMeterNumber: record.meterNumber,
      serviceNumber: record.serviceNumber || (prefixEnabled ? prefix : ""),
      model: record.model,
      meterNumber: record.meterNumber,
      manufactureDate: record.manufactureDate,
      inspectionNumber: record.inspectionNumber,
      expiryDate: expiry,
      prefix,
      prefixEnabled,
    });
  }

  function openEditDraft(record: MeterRecord, targetIndex: number) {
    setEditError("");
    setEditDraftLive({
      mode: "edit",
      targetIndex,
      anchorMeterNumber: record.meterNumber,
      serviceNumber: record.serviceNumber,
      model: record.model,
      meterNumber: record.meterNumber,
      manufactureDate: record.manufactureDate,
      inspectionNumber: record.inspectionNumber,
      expiryDate: record.expiryDate,
      prefix: dataRef.current.servicePrefix,
      prefixEnabled: dataRef.current.servicePrefixEnabled,
    });
  }

  // MS 電號貼紙歸屬：抽屜錨定 > 連續掃描鎖定 > 無鎖定則拒收（選項 C）。
  // 注意：呼叫者幾乎都是長效監聽器回呼，只能讀 live ref，不能讀 render state。
  function resolveServiceTargetMeter(batchMeterHint?: string): string | null {
    const liveDraft = editDraftRef.current;
    if (liveDraft?.anchorMeterNumber) {
      return liveDraft.anchorMeterNumber;
    }
    if (liveDraft?.meterNumber) {
      return liveDraft.meterNumber;
    }

    // 抽屜未開時：只有「未結案」（尚未掃完兩張或尚未填電號）的電表才能當作 MS 貼紙目標！
    // 嚴禁將已配對完成且已有電號的歷史電表當作目標（避免鏡頭掃過舊表殘留鎖定，誤將新貼紙覆蓋或彈窗詢問）。
    const folder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
    const isCompleted = (meter: string | null | undefined): boolean => {
      if (!meter) return false;
      const rec = folder.records.find((r) => r.meterNumber === meter);
      if (!rec) return false;
      const hasService = Boolean((rec.serviceNumber ?? "").replace(/\D/g, ""));
      return hasService && isMeterPairComplete(rec, folder.seenQrTexts);
    };

    if (nativeTargetMeterRef.current && !isCompleted(nativeTargetMeterRef.current)) {
      return nativeTargetMeterRef.current;
    }
    if (targetMeterLiveRef.current && !isCompleted(targetMeterLiveRef.current)) {
      return targetMeterLiveRef.current;
    }
    // 等貼紙狀態本身就是鎖定（Web 連續掃描沒有 native 鎖定，全靠這個歸屬）
    if (pendingCompletionRef.current && !isCompleted(pendingCompletionRef.current)) {
      return pendingCompletionRef.current;
    }
    if (batchMeterHint && !isCompleted(batchMeterHint)) {
      return batchMeterHint;
    }
    return null;
  }

  function handleServiceQrText(cleanedServiceText: string, rawServiceNumber: string, batchMeterHint?: string) {
    const serviceNumber = normalizeServiceNumberTo8Digits(rawServiceNumber);
    const targetMeterNumber = resolveServiceTargetMeter(batchMeterHint);
    if (!targetMeterNumber) {
      updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
      setStatus("error");
      setMessage("請先掃描電表QRcode");
      feedbackError();
      return;
    }

    const folder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
    const digitsOf = (value: string) => (value ?? "").replace(/\D/g, "");

    // MS 只服務配對完成的表：第一張 QR 就掃貼紙不准預填，
    // 否則會存出缺檢驗號碼的壞資料。沒掃完兩張的一律退回。
    const targetRecord = folder.records.find((record) => record.meterNumber === targetMeterNumber);
    if (!targetRecord || !isMeterPairComplete(targetRecord, folder.seenQrTexts)) {
      updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
      setStatus("error");
      setMessage(
        targetRecord ? "請先掃完兩張電表QR，再掃電號貼紙" : "請先掃描電表QRcode",
      );
      feedbackError();
      return;
    }

    // 抽屜開著：直接預填進抽屜，不靜默寫入紀錄（讀 live ref，監聽器閉包會凍結舊 state）
    const liveDraft = editDraftRef.current;
    if (liveDraft && (liveDraft.anchorMeterNumber === targetMeterNumber || liveDraft.meterNumber === targetMeterNumber)) {
      const draftService = digitsOf(liveDraft.serviceNumber);
      if (draftService === serviceNumber) {
        setStatus("duplicate");
        setMessage("這張電號貼紙已綁定，已忽略");
        feedbackDuplicate();
        return;
      }
      const conflict = folder.records.find(
        (record) => digitsOf(record.serviceNumber) === serviceNumber && record.meterNumber !== targetMeterNumber,
      );
      if (conflict) {
        setStatus("error");
        setMessage(`電號${formatServiceNumber(serviceNumber)}已綁定表號${conflict.meterNumber}，不可重複`);
        feedbackError();
        return;
      }
      if (draftService) {
        if (!window.confirm(`已填 ${formatServiceNumber(draftService)}，掃描值 ${formatServiceNumber(serviceNumber)}，要覆蓋嗎？`)) {
          setStatus("done");
          setMessage("已保留原電號，未覆蓋");
          return;
        }
      }
      setEditDraftLive({ ...liveDraft, serviceNumber });
      setEditError("");
      pendingCompletionRef.current = null;
      updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
      setStatus("done");
      setMessage(`已掃到電號${formatServiceNumber(serviceNumber)}，請確認後儲存`);
      feedbackSuccess();
      return;
    }

    // 抽屜沒開：找到鎖定表號的紀錄，開抽屜預填等人按儲存
    const recordIndex = folder.records.findIndex((record) => record.meterNumber === targetMeterNumber);
    if (recordIndex < 0) {
      updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
      setStatus("error");
      setMessage("請先掃描電表QRcode");
      feedbackError();
      return;
    }
    const record = folder.records[recordIndex];
    const recordService = digitsOf(record.serviceNumber);
    if (recordService === serviceNumber) {
      setStatus("duplicate");
      setMessage("這張電號貼紙已綁定，已忽略");
      feedbackDuplicate();
      return;
    }
    const conflict = folder.records.find(
      (other, index) => index !== recordIndex && digitsOf(other.serviceNumber) === serviceNumber,
    );
    if (conflict) {
      setStatus("error");
      setMessage(`電號${formatServiceNumber(serviceNumber)}已綁定表號${conflict.meterNumber}，不可重複`);
      feedbackError();
      return;
    }
    if (recordService) {
      // 抽屜未開且該表已有電號：代表這張表早已完成，相機掃到的 MS 貼紙不可覆蓋，提示請先掃下一個電表
      updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
      setStatus("error");
      setMessage("請先掃描電表QRcode");
      feedbackError();
      return;
    }
    pendingCompletionRef.current = null;
    updateData((current) => ({ ...current, lastQrText: cleanedServiceText }));
    // 先開抽屜再停相機：停相機的原生呼叫若 hang 住，抽屜照樣開，不會讓貼紙看似沒反應
    openCompletionDraft({ ...record, serviceNumber }, recordIndex);
    setTargetMeterLive(null);
    setStatus("done");
    setMessage(`已掃到電號${formatServiceNumber(serviceNumber)}，請確認後儲存`);
    feedbackSuccess();
    void stopActiveScanner();
  }

  async function handleQrTexts(texts: string[], options: HandleQrOptions = {}) {
    const readableTexts = texts.filter((text) => text.trim());
    if (!readableTexts.length) {
      return;
    }

    // MS 電號貼紙靠 MS: 前綴自動分流，不進電表合併、不計入 1/2 配對、不進 seenQrTexts
    const serviceRawTexts = readableTexts.filter((text) => isServiceQrText(text, qrParseOptions));
    const meterRawTexts = readableTexts.filter((text) => !isServiceQrText(text, qrParseOptions));
    const batchMeters = [...new Set(
      meterRawTexts.map((text) => parseQrText(text, qrParseOptions)?.meterNumber || "").filter(Boolean),
    )];
    const hintFolder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
    const batchMeterHint = selectBatchMeterHint(batchMeters, hintFolder.records, hintFolder.seenQrTexts);

    // 單次/相簿同批（表 QR＋MS 同框）：先合併電表再吃貼紙，
    // 新表同框才能一次搞定（貼紙需要已配對完成的紀錄才能歸屬）。
    // 連續掃描維持先貼紙後電表（原生連續本來就分幀送達，不影響）。
    const meterFirst = !options.continuous && meterRawTexts.length > 0 && serviceRawTexts.length > 0;

    function runServiceTexts() {
      for (const serviceText of serviceRawTexts) {
        const parsedService = parseServiceQrText(serviceText, qrParseOptions);
        if (!parsedService) {
          updateData((current) => ({ ...current, lastQrText: normalizeQrText(serviceText) }));
          setStatus("error");
          setMessage("電號貼紙格式不正確");
          feedbackError();
          continue;
        }
        handleServiceQrText(parsedService.rawText, parsedService.serviceNumber, batchMeterHint);
      }
    }

    if (meterFirst) {
      await runMeterTexts();
      runServiceTexts();
      return;
    }
    runServiceTexts();

    async function runMeterTexts() {
    if (!meterRawTexts.length) {
      return;
    }

    // 連續掃描中：若正處於等待貼紙 (pendingCompletionRef)，只允許當前待貼紙電表，避免被誤掃的新電表沖掉
    if (options.continuous && pendingCompletionRef.current) {
      const nonMatching = meterRawTexts.filter((text) => {
        const m = parseQrText(text, qrParseOptions)?.meterNumber;
        return m && m !== pendingCompletionRef.current;
      });
      if (nonMatching.length > 0 && nonMatching.length === meterRawTexts.length) {
        setStatus("scanning");
        setMessage(`已配對表號${pendingCompletionRef.current}，請掃電號貼紙（無貼紙按停止改手輸）`);
        feedbackDuplicate();
        return;
      }
    }

    // 連續掃描中：若當前已鎖定某電表 (targetMeterLiveRef) 且尚未完成，避免被誤掃的新電表沖掉
    if (options.continuous && targetMeterLiveRef.current) {
      const curFolder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
      const currentRec = curFolder.records.find((r) => r.meterNumber === targetMeterLiveRef.current);
      const isCurrentFinished = currentRec
        ? isMeterPairComplete(currentRec, curFolder.seenQrTexts, qrParseOptions) &&
          Boolean((currentRec.serviceNumber ?? "").replace(/\D/g, ""))
        : false;
      if (!isCurrentFinished) {
        const nonMatching = meterRawTexts.filter((text) => {
          const m = parseQrText(text, qrParseOptions)?.meterNumber;
          return m && m !== targetMeterLiveRef.current;
        });
        if (nonMatching.length > 0 && nonMatching.length === meterRawTexts.length) {
          setStatus("duplicate");
          setMessage(`已鎖定表號${targetMeterLiveRef.current}，請掃同表號的第二個 QRCode`);
          feedbackDuplicate();
          return;
        }
      }
    }

    const bestText = chooseBestQrText(meterRawTexts, qrParseOptions);
    const parsed = parseQrText(bestText, qrParseOptions);
    const cleanedText = meterRawTexts.map((text) => parseQrText(text, qrParseOptions)?.rawText || text.trim()).join("\n");

    // dataRef 經 write-through 永遠是最新（見 updateData），連續掃描 bursts 直接用它算，
    // 不會蓋掉前一包、不會生出同表號兩筆。
    const currentData = dataRef.current;
    const date = activeDateRef.current;
    const folder = currentData.folders[date] ?? { records: [], seenQrTexts: [] };
    const mergeResult = mergeQrTexts(folder.records, folder.seenQrTexts, meterRawTexts, qrParseOptions);

    if (mergeResult.added || mergeResult.updated) {
      // 掃描紀錄保持電號空白（前綴只在輸入對話框預填），避免「前綴半成品」被視為已填寫並匯出；
      // 檢定期限則可安全自動套用（同型式記憶）。
      const recordsWithExpiry = mergeResult.records.map((record) => {
        if (record.expiryDate) {
          return record;
        }
        const autoExpiry = resolveExpiryDate(record.model, currentData);
        return autoExpiry ? { ...record, expiryDate: autoExpiry } : record;
      });

      updateData((current) => {
        const currentDate = activeDateRef.current;
        return {
          ...current,
          lastQrText: cleanedText,
          folders: {
            ...current.folders,
            [currentDate]: {
              records: recordsWithExpiry,
              seenQrTexts: mergeResult.seenQrTexts,
            },
          },
        };
      });

      const scannedMeterNumbers = new Set(
        meterRawTexts
          .map((text) => parseQrText(text)?.meterNumber || "")
          .filter(Boolean),
      );
      const completedRecord = options.continuous
        ? recordsWithExpiry.find(
            (record) =>
              Boolean(record.meterNumber) &&
              scannedMeterNumbers.has(record.meterNumber) &&
              isMeterPairComplete(record, mergeResult.seenQrTexts),
          )
        : undefined;

      if (completedRecord) {
        // 電號標籤掃描開啟時：配對完成先不彈抽屜，留在同個掃描視窗等第三張（MS 貼紙）；
        // 沒貼紙就按停止，改手輸電號。
        if (
          options.continuous &&
          dataRef.current.serviceQrEnabled &&
          !(completedRecord.serviceNumber ?? "").replace(/\D/g, "")
        ) {
          pendingCompletionRef.current = completedRecord.meterNumber;
          setStatus("scanning");
          setMessage(`已配對表號${completedRecord.meterNumber}，配對成功，請掃電號貼紙（無貼紙按停止改手輸）`);
          feedbackSuccess();
          return;
        }
        pendingCompletionRef.current = null;
        setStatus("done");
        setMessage("兩組 QRCode 均已讀取並完整配對，請輸入電號");
        feedbackSuccess();
        setTargetMeterLive(null);
        openCompletionDraft(completedRecord);
        void stopActiveScanner();
        return;
      }

      setStatus(options.continuous ? "scanning" : "done");
      const matchedRecord = parsed?.meterNumber
        ? recordsWithExpiry.find((r) => r.meterNumber === parsed.meterNumber)
        : null;
      const pairStatus = matchedRecord ? getMeterPairStatus(matchedRecord, mergeResult.seenQrTexts) : null;

      setMessage(
        options.continuous
          ? `${scanMessage(parsed)}，${pairStatus?.label ?? "請掃同表號的第二個 QRCode"}`
          : scanMessage(parsed),
      );
      feedbackSuccess();
      return;
    }

    if (mergeResult.duplicates) {
      if (options.continuous) {
        // 等貼紙時重掃同表 QR：提醒下一步是掃貼紙，不是移下一台
        const scannedMeters = new Set(
          meterRawTexts.map((text) => parseQrText(text)?.meterNumber || "").filter(Boolean),
        );
        if (pendingCompletionRef.current && scannedMeters.has(pendingCompletionRef.current)) {
          setStatus("scanning");
          setMessage(`已配對表號${pendingCompletionRef.current}，配對成功，請掃電號貼紙（無貼紙按停止改手輸）`);
          feedbackDuplicate();
          return;
        }

        const dupMeter =
          meterRawTexts.map((text) => parseQrText(text)?.meterNumber || "").find(Boolean) || "";
        const curFolder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
        const dupRec = curFolder.records.find((r) => r.meterNumber === dupMeter);
        const isDupDone =
          dupRec &&
          isMeterPairComplete(dupRec, curFolder.seenQrTexts) &&
          Boolean((dupRec.serviceNumber ?? "").replace(/\D/g, ""));

        if (
          isDupDone &&
          justSavedMeterRef.current &&
          justSavedMeterRef.current.meter === dupMeter &&
          Date.now() < justSavedMeterRef.current.until
        ) {
          // 剛存好，鏡頭還停留在原表：保持安心綠色儲存成功提示，不跳紅光、不震動！
          return;
        }

        setStatus("duplicate");
        if (isDupDone) {
          setMessage(
            dupMeter
              ? `此電表已完成 (表號 ${dupMeter})，請移至下一台`
              : "此電表已完成，請移動到下一個電表"
          );
        } else if (dupMeter) {
          setMessage(`QRCode 已掃過 (表號 ${dupMeter})，請掃同表另一組 QR`);
        } else {
          setMessage("這組 QRCode 已掃描過，請移動到同一個電表的另一個 QRCode");
        }
        feedbackDuplicate();
        return;
      }

      const dupMeter =
        meterRawTexts.map((text) => parseQrText(text)?.meterNumber || "").find(Boolean) || "";
      updateData((current) => ({ ...current, lastQrText: cleanedText }));
      setStatus("duplicate");
      setMessage(
        dupMeter
          ? `此電表已掃過 (表號 ${dupMeter})，已忽略`
          : "這組 QRCode 已掃描過，已忽略"
      );
      feedbackDuplicate();
      return;
    }

    if (mergeResult.invalid) {
      updateData((current) => ({ ...current, lastQrText: cleanedText }));
      setStatus("error");
      setMessage("無法判讀這組 QRCode");
      feedbackError();
    }
    }

    if (!meterFirst) {
      await runMeterTexts();
    }
  }

  function exportDateDirectly(dateToExport: string) {
    const targetFolder = data.folders[dateToExport];
    const targetRecords = targetFolder?.records ?? [];
    if (!targetRecords.length) {
      setStatus("error");
      setMessage(`${dateToExport} 沒有任何電表資料可匯出`);
      return;
    }
    setExportTarget({ type: "date", date: dateToExport });
  }

  function handleExportAll() {
    const hasAny = Object.values(data.folders).some((folder) => folder.records.length > 0);
    if (!hasAny) {
      setStatus("error");
      setMessage("沒有任何資料可匯出");
      return;
    }
    setExportTarget({ type: "all" });
  }

  function handleBackup() {
    setExportTarget({ type: "backup" });
  }

  async function executeExport(target: ExportTarget, mode: ExportDeliveryMode) {
    if (mode === "drive" || mode === "both") {
      clearDriveAccessToken();
    }
    setIsExporting(true);
    setDriveProgress(
      mode === "drive" || mode === "both"
        ? { percent: 10, text: "正在連接 Google 雲端硬碟…" }
        : null,
    );
    const onProgress = (pct: number) => {
      setDriveProgress({
        percent: 10 + Math.round(pct * 0.85),
        text: `上傳雲端硬碟 ${pct}%…`,
      });
    };

    try {
      if (target.type === "date") {
        const targetRecords = dataRef.current.folders[target.date]?.records ?? [];
        const result = await exportRecords(
          targetRecords,
          target.date,
          dataRef.current.districtCode,
          mode,
          onProgress,
        );
        setExportTarget(null);

        if (result.delivery?.cancelled) {
          setStatus("idle");
          setMessage("已取消分享");
          return;
        }

        setStatus("done");
        if (result.delivery?.uploadedToDrive) {
          const bothText = result.delivery.downloaded ? "，本機檔案亦同步下載至「下載」資料夾" : "";
          setMessage(`✅ Excel 報表已成功上傳至個人 Google 雲端硬碟！${bothText}`);
          setNoticeModal({
            type: "success",
            title: mode === "both" ? "雙重保存完成" : "雲端硬碟儲存成功",
            message: mode === "both"
              ? "報表已成功上傳至您的個人 Google 雲端硬碟，且本機下載檔案亦已儲存完畢！"
              : "報表已成功直接上傳至您選取的個人 Google 雲端硬碟！",
            details: [
              { label: "報表日期", value: target.date },
              { label: "檔案名稱", value: result.fileName },
              { label: "資料筆數", value: `${result.recordCount} 筆` },
              { label: "儲存位置", value: mode === "both" ? "Google 雲端硬碟 + 手機本機下載" : "個人 Google 雲端硬碟 (根目錄)" },
            ],
          });
        } else if (result.delivery?.shared) {
          const fmtText = result.delivery.format === "csv" ? "（相容試算表 CSV 格式）" : "（Excel 活頁簿）";
          setMessage(`已開啟手機系統分享選單！${fmtText}`);
          setNoticeModal({
            type: "success",
            title: "已開啟系統分享",
            message: "已成功喚醒手機原生分享選單！\n您可選擇直接傳送至 LINE 好友、群組、Gmail 或其他通訊軟體。",
            details: [
              { label: "報表日期", value: target.date },
              { label: "檔案名稱", value: result.fileName },
              { label: "資料筆數", value: `${result.recordCount} 筆` },
              { label: "分享格式", value: fmtText },
            ],
          });
        } else if (result.delivery?.unsupported) {
          setMessage(`目前瀏覽器不支援原生分享面板，提供快捷傳送 LINE 或下載（${result.recordCount} 筆）`);
          setNoticeModal({
            type: "warning",
            title: "瀏覽器不支援系統原生分享",
            message: "您目前使用的環境（如 LINE 內建瀏覽器或特定手機 WebView）限制調用系統原生分享面板。\n\n請選擇以下快捷方式傳送或保存資料：",
            details: [
              { label: "報表日期", value: target.date },
              { label: "檔案名稱", value: result.fileName },
              { label: "資料筆數", value: `${result.recordCount} 筆` },
            ],
            confirmText: "關閉視窗",
            actions: [
              ...(result.delivery?.lineShareUrl
                ? [
                    {
                      label: "🟢 直接傳送至 LINE",
                      primary: true,
                      styleClass: "line-btn",
                      onClick: () => {
                        window.open(result.delivery?.lineShareUrl, "_blank");
                      },
                    },
                  ]
                : []),
              ...(result.delivery?.summaryText
                ? [
                    {
                      label: "📋 複製報表文字內容",
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(result.delivery!.summaryText!);
                          setMessage("已複製報表摘要至剪貼簿！可直接貼至任何通訊軟體");
                        } catch {
                          setMessage("複製失敗，請手動複製");
                        }
                      },
                    },
                  ]
                : []),
              {
                label: "📥 直接下載 Excel 檔至手機",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "download");
                },
              },
              {
                label: "☁️ 儲存至 Google 雲端硬碟",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "drive");
                },
              },
            ],
          });
        } else {
          setMessage(`已下載 ${target.date} 的資料（${result.recordCount} 筆）`);
          setNoticeModal({
            type: "success",
            title: "檔案下載完成",
            message: "報表已成功下載至您裝置的「下載」資料夾，可隨時使用 Excel 開啟。",
            details: [
              { label: "報表日期", value: target.date },
              { label: "檔案名稱", value: result.fileName },
              { label: "資料筆數", value: `${result.recordCount} 筆` },
            ],
          });
        }
      } else if (target.type === "all") {
        const recordsByDate: Record<string, MeterRecord[]> = {};
        for (const [date, folder] of Object.entries(dataRef.current.folders)) {
          if (folder.records.length) {
            recordsByDate[date] = folder.records;
          }
        }
        const result = await exportAllDates(
          recordsByDate,
          folderDates,
          dataRef.current.districtCode,
          mode,
          onProgress,
        );
        setExportTarget(null);

        if (result.delivery?.cancelled) {
          setStatus("idle");
          setMessage("已取消分享");
          return;
        }

        setStatus("done");
        if (result.delivery?.uploadedToDrive) {
          const bothText = result.delivery.downloaded ? "，本機檔案亦同步下載至「下載」資料夾" : "";
          setMessage(`✅ 全部歷史報表已成功上傳至個人 Google 雲端硬碟！${bothText}`);
          setNoticeModal({
            type: "success",
            title: mode === "both" ? "雙重保存完成" : "雲端硬碟儲存成功",
            message: mode === "both"
              ? "全部日期歷史報表已成功上傳至您的個人 Google 雲端硬碟，且本機下載檔案亦已儲存完畢！"
              : "全部日期歷史報表已成功直接上傳至您選取的個人 Google 雲端硬碟！",
            details: [
              { label: "匯出範圍", value: `全部歷史紀錄（${folderDates.length} 個工作日）` },
              { label: "檔案名稱", value: result.fileName },
              { label: "總筆數", value: `${result.recordCount} 筆` },
              { label: "儲存位置", value: mode === "both" ? "Google 雲端硬碟 + 手機本機下載" : "個人 Google 雲端硬碟 (根目錄)" },
            ],
          });
        } else if (result.delivery?.shared) {
          const fmtText = result.delivery.format === "csv" ? "（相容試算表 CSV 格式）" : "（Excel 活頁簿）";
          setMessage(`已開啟手機系統分享選單！${fmtText}`);
          setNoticeModal({
            type: "success",
            title: "已開啟系統分享",
            message: "已成功喚醒手機原生分享選單！\n您可選擇直接傳送至 LINE 好友、群組、Gmail 或其他通訊軟體。",
            details: [
              { label: "檔案名稱", value: result.fileName },
              { label: "總筆數", value: `${result.recordCount} 筆` },
              { label: "分享格式", value: fmtText },
            ],
          });
        } else if (result.delivery?.unsupported) {
          setMessage(`目前瀏覽器不支援原生分享面板，提供快捷傳送 LINE 或下載（共 ${result.recordCount} 筆）`);
          setNoticeModal({
            type: "warning",
            title: "瀏覽器不支援系統原生分享",
            message: "您目前使用的環境（如 LINE 內建瀏覽器或特定手機 WebView）限制調用系統原生分享面板。\n\n請選擇以下快捷方式傳送或保存資料：",
            details: [
              { label: "匯出範圍", value: `全部歷史紀錄（${folderDates.length} 個工作日）` },
              { label: "檔案名稱", value: result.fileName },
              { label: "總筆數", value: `${result.recordCount} 筆` },
            ],
            confirmText: "關閉視窗",
            actions: [
              ...(result.delivery?.lineShareUrl
                ? [
                    {
                      label: "🟢 直接傳送至 LINE",
                      primary: true,
                      styleClass: "line-btn",
                      onClick: () => {
                        window.open(result.delivery?.lineShareUrl, "_blank");
                      },
                    },
                  ]
                : []),
              ...(result.delivery?.summaryText
                ? [
                    {
                      label: "📋 複製報表文字內容",
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(result.delivery!.summaryText!);
                          setMessage("已複製報表摘要至剪貼簿！可直接貼至任何通訊軟體");
                        } catch {
                          setMessage("複製失敗，請手動複製");
                        }
                      },
                    },
                  ]
                : []),
              {
                label: "📥 直接下載 Excel 檔至手機",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "download");
                },
              },
              {
                label: "☁️ 儲存至 Google 雲端硬碟",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "drive");
                },
              },
            ],
          });
        } else {
          setMessage(`已下載全部日期的資料（共 ${result.recordCount} 筆）`);
          setNoticeModal({
            type: "success",
            title: "全部報表下載完成",
            message: "全部日期之歷史報表已成功下載至您裝置的「下載」資料夾。",
            details: [
              { label: "工作日數", value: `${folderDates.length} 個工作日` },
              { label: "檔案名稱", value: result.fileName },
              { label: "總筆數", value: `${result.recordCount} 筆` },
            ],
          });
        }
      } else if (target.type === "backup") {
        const result = await exportBackup(dataRef.current, mode, onProgress);
        setExportTarget(null);

        if (result.cancelled) {
          setStatus("idle");
          setMessage("已取消分享");
          return;
        }

        setStatus("done");
        if (result.uploadedToDrive) {
          const bothText = result.downloaded ? "，本機備份檔亦同步下載至「下載」資料夾" : "";
          setMessage(`✅ 完整備份檔已成功上傳至個人 Google 雲端硬碟！${bothText}`);
          const totalRecords = Object.values(dataRef.current.folders).reduce((s, f) => s + f.records.length, 0);
          setNoticeModal({
            type: "success",
            title: mode === "both" ? "雙重保存備份完成" : "Google 雲端備份成功",
            message: mode === "both"
              ? "系統資料庫完整備份檔已上傳至 Google 雲端硬碟，且本機備份檔亦下載完畢！"
              : "系統資料庫完整備份檔已成功上傳至您選取的個人 Google 雲端硬碟！",
            details: [
              { label: "備份檔名", value: result.fileName },
              { label: "涵蓋工作日", value: `${Object.keys(dataRef.current.folders).length} 個` },
              { label: "總電表數", value: `${totalRecords} 筆` },
              { label: "儲存位置", value: mode === "both" ? "Google 雲端硬碟 + 手機本機下載" : "個人 Google 雲端硬碟 (根目錄)" },
            ],
          });
        } else if (result.shared) {
          setMessage(`已開啟備份分享面板（${result.fileName}，可儲存至 Google 雲端硬碟或 LINE）`);
          setNoticeModal({
            type: "success",
            title: "已開啟系統分享",
            message: "已成功開啟手機系統原生分享選單！\n您可選擇傳送備份檔至 LINE 好友、Gmail 或 Google 雲端硬碟。",
            details: [
              { label: "備份檔名", value: result.fileName },
            ],
          });
        } else if (result.unsupported) {
          setMessage(`目前瀏覽器不支援原生分享面板，提供快捷傳送 LINE 或下載備份（${result.fileName}）`);
          setNoticeModal({
            type: "warning",
            title: "瀏覽器不支援系統原生分享",
            message: "您目前使用的環境（如 LINE 內建瀏覽器或特定手機 WebView）限制調用系統原生分享面板。\n\n請選擇以下快捷方式傳送或保存備份：",
            details: [
              { label: "備份檔名", value: result.fileName },
            ],
            confirmText: "關閉視窗",
            actions: [
              ...(result.lineShareUrl
                ? [
                    {
                      label: "🟢 直接傳送至 LINE",
                      primary: true,
                      styleClass: "line-btn",
                      onClick: () => {
                        window.open(result.lineShareUrl, "_blank");
                      },
                    },
                  ]
                : []),
              ...(result.summaryText
                ? [
                    {
                      label: "📋 複製備份摘要內容",
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(result.summaryText!);
                          setMessage("已複製備份摘要至剪貼簿！");
                        } catch {
                          setMessage("複製失敗，請手動複製");
                        }
                      },
                    },
                  ]
                : []),
              {
                label: "📥 下載備份檔 (.json)",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "download");
                },
              },
              {
                label: "☁️ 備份至 Google 雲端硬碟",
                onClick: () => {
                  setNoticeModal(null);
                  void executeExport(target, "drive");
                },
              },
            ],
          });
        } else {
          setMessage(`已下載備份檔（${result.fileName}），請妥善保存`);
          setNoticeModal({
            type: "success",
            title: "備份檔下載完成",
            message: "系統完整備份檔 (.json) 已下載至您裝置的「下載」資料夾，請妥善保存。",
            details: [
              { label: "備份檔名", value: result.fileName },
            ],
          });
        }
      }
    } catch (error) {
      setExportTarget(null);
      const errMsg = error instanceof Error ? error.message : "匯出失敗";
      if (errMsg.includes("已取消") || errMsg.includes("closed")) {
        setStatus("idle");
        setMessage("已取消 Google 登入");
      } else {
        setStatus("error");
        setMessage(errMsg);
        setNoticeModal({
          type: "error",
          title: "匯出/儲存失敗",
          message: errMsg,
        });
      }
    } finally {
      setIsExporting(false);
      setTimeout(() => setDriveProgress(null), 1500);
    }
  }

  async function handleDriveBackup() {
    clearDriveAccessToken();
    setIsDriveBusy(true);
    setDriveProgress({ percent: 10, text: "正在連接 Google 雲端硬碟…" });
    try {
      const result = await exportBackup(dataRef.current, "drive", (pct) => {
        setDriveProgress({
          percent: 10 + Math.round(pct * 0.85),
          text: `上傳備份至雲端硬碟 ${pct}%…`,
        });
      });
      setDriveProgress({ percent: 100, text: "完成" });
      setStatus("done");
      setMessage(`✅ 系統資料庫已成功備份至個人 Google 雲端硬碟（${result.fileName}）`);
      const totalRecords = Object.values(dataRef.current.folders).reduce((s, f) => s + f.records.length, 0);
      setNoticeModal({
        type: "success",
        title: "Google 雲端備份成功",
        message: "您的系統資料庫已成功直接備份至個人 Google 雲端硬碟！",
        details: [
          { label: "備份檔名", value: result.fileName },
          { label: "工作日數", value: `${Object.keys(dataRef.current.folders).length} 個工作日` },
          { label: "電表總數", value: `${totalRecords} 筆` },
          { label: "儲存位置", value: "個人 Google 雲端硬碟 (根目錄)" },
        ],
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "雲端備份失敗";
      if (errMsg.includes("已取消") || errMsg.includes("closed")) {
        setStatus("idle");
        setMessage("已取消 Google 登入");
      } else {
        setStatus("error");
        setMessage(errMsg);
        setNoticeModal({
          type: "error",
          title: "雲端備份失敗",
          message: errMsg,
        });
      }
    } finally {
      setIsDriveBusy(false);
      setTimeout(() => setDriveProgress(null), 2000);
    }
  }

  async function handleDriveRestoreList() {
    clearDriveAccessToken();
    setIsDriveBusy(true);
    setDriveProgress({ percent: 20, text: "正在查詢雲端硬碟備份清單…" });
    try {
      const files = await listDriveBackups("電表");
      if (!files.length) {
        setStatus("idle");
        setMessage("您的 Google 雲端硬碟中找不到任何電表備份檔案");
        setNoticeModal({
          type: "info",
          title: "未找到雲端備份檔案",
          message: "在此 Google 帳號的個人雲端硬碟中，找不到任何含有「電表」關鍵字的備份或 Excel 檔案。\n\n💡 提示：若您的備份存於其他 Google 帳號，請再次點選「從 Google Drive 還原」並選取正確的 Google 帳號。",
        });
        return;
      }
      setDriveModal({
        type: "restore",
        files,
        selectedIds: [files[0].id],
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "讀取雲端備份清單失敗";
      if (errMsg.includes("已取消") || errMsg.includes("closed")) {
        setStatus("idle");
        setMessage("已取消 Google 登入");
      } else {
        setStatus("error");
        setMessage(errMsg);
        setNoticeModal({
          type: "error",
          title: "讀取雲端備份失敗",
          message: errMsg,
        });
      }
    } finally {
      setIsDriveBusy(false);
      setDriveProgress(null);
    }
  }

  async function handleDriveDeleteList() {
    clearDriveAccessToken();
    setIsDriveBusy(true);
    setDriveProgress({ percent: 20, text: "正在查詢雲端硬碟備份清單…" });
    try {
      const files = await listDriveBackups("電表");
      if (!files.length) {
        setStatus("idle");
        setMessage("您的 Google 雲端硬碟中目前沒有電表備份檔案");
        setNoticeModal({
          type: "info",
          title: "無雲端備份檔案",
          message: "在此 Google 帳號的雲端硬碟中，目前沒有可清理的電表備份檔案。",
        });
        return;
      }
      setDriveModal({
        type: "delete",
        files,
        selectedIds: [],
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "讀取雲端備份清單失敗";
      if (errMsg.includes("已取消") || errMsg.includes("closed")) {
        setStatus("idle");
        setMessage("已取消 Google 登入");
      } else {
        setStatus("error");
        setMessage(errMsg);
        setNoticeModal({
          type: "error",
          title: "讀取雲端備份失敗",
          message: errMsg,
        });
      }
    } finally {
      setIsDriveBusy(false);
      setDriveProgress(null);
    }
  }

  async function confirmDriveRestore() {
    if (!driveModal || !driveModal.selectedIds.length) return;
    const fileId = driveModal.selectedIds[0];
    const targetFile = driveModal.files.find((f) => f.id === fileId);
    if (!targetFile) return;

    if (
      !window.confirm(
        `確定從 Google 雲端硬碟下載並還原備份「${targetFile.name}」？此操作將合併/更新目前紀錄。`,
      )
    ) {
      return;
    }

    setIsDriveBusy(true);
    setDriveProgress({ percent: 10, text: "正在從雲端硬碟下載備份…" });
    try {
      const blob = await downloadDriveFile(fileId, (pct) => {
        setDriveProgress({
          percent: 10 + Math.round(pct * 0.7),
          text: `下載雲端檔案 ${pct}%…`,
        });
      });
      setDriveProgress({ percent: 85, text: "正在解析並還原資料庫…" });

      let recordCountNotice = 0;
      if (/\.(xlsx|xls)$/i.test(targetFile.name)) {
        const file = new File([blob], targetFile.name);
        const importedFolders = await restoreFromExcel(file);
        updateData((current) => {
          const folders = { ...current.folders };
          for (const [date, imported] of Object.entries(importedFolders)) {
            const existing = folders[date] ?? { records: [], seenQrTexts: [] };
            const known = new Set(existing.records.map((r) => JSON.stringify(r)));
            const merged = [...existing.records];
            for (const r of imported.records) {
              const sig = JSON.stringify(r);
              if (!known.has(sig)) {
                merged.push(r);
                known.add(sig);
              }
            }
            folders[date] = { ...existing, records: merged };
          }
          return { ...current, folders };
        });
        recordCountNotice = Object.values(importedFolders).reduce((s, f) => s + f.records.length, 0);
      } else {
        const restored = await restoreFromDriveBlob(blob);
        setData(restored);
        dataRef.current = restored;
        recordCountNotice = Object.values(restored.folders).reduce((s, f) => s + f.records.length, 0);
      }

      setDriveProgress({ percent: 100, text: "還原成功" });
      setDriveModal(null);
      setStatus("done");
      setMessage(`✅ 雲端備份「${targetFile.name}」已成功還原！`);
      setNoticeModal({
        type: "success",
        title: "雲端還原成功",
        message: `已成功從個人 Google 雲端硬碟下載並完整還原「${targetFile.name}」！\n所有電表資料已即時載入並更新至本機資料庫。`,
        details: [
          { label: "還原檔案", value: targetFile.name },
          { label: "檔案大小", value: targetFile.size ? `${(targetFile.size / 1024).toFixed(1)} KB` : "未知" },
          { label: "資料筆數", value: `共 ${recordCountNotice} 筆電表` },
          { label: "目前狀態", value: "資料已同步生效" },
        ],
      });
    } catch (error) {
      setStatus("error");
      const errMsg = error instanceof Error ? error.message : "雲端還原失敗";
      setMessage(errMsg);
      setNoticeModal({
        type: "error",
        title: "雲端還原失敗",
        message: errMsg,
      });
    } finally {
      setIsDriveBusy(false);
      setTimeout(() => setDriveProgress(null), 1500);
    }
  }

  async function confirmDriveDelete() {
    if (!driveModal || !driveModal.selectedIds.length) {
      alert("請先勾選要刪除的備份檔案");
      return;
    }

    if (
      !window.confirm(
        `確定自個人 Google 雲端硬碟刪除所選的 ${driveModal.selectedIds.length} 個備份？此動作無法復原（本機資料不受影響）。`,
      )
    ) {
      return;
    }

    setIsDriveBusy(true);
    setDriveProgress({ percent: 10, text: "正在自雲端硬碟刪除備份…" });
    try {
      let deleted = 0;
      for (const id of driveModal.selectedIds) {
        await deleteDriveFile(id);
        deleted++;
        setDriveProgress({
          percent: 10 + Math.round((deleted / driveModal.selectedIds.length) * 85),
          text: `已刪除 ${deleted} / ${driveModal.selectedIds.length} 個備份…`,
        });
      }
      setDriveProgress({ percent: 100, text: "刪除完成" });

      // 即時樂觀更新：立即從目前視窗清單移除已刪除的檔案，避免殘留
      const remainingFiles = driveModal.files.filter((f) => !driveModal.selectedIds.includes(f.id));
      if (remainingFiles.length > 0) {
        setDriveModal({ ...driveModal, files: remainingFiles, selectedIds: [] });
      } else {
        setDriveModal(null);
      }

      setStatus("done");
      setMessage(`✅ 已成功從 Google 雲端硬碟刪除 ${deleted} 個備份檔案`);
      setNoticeModal({
        type: "success",
        title: "雲端備份刪除完成",
        message: `已成功從個人 Google 雲端硬碟中安全刪除 ${deleted} 個備份檔案！\n\n本機資料庫完好無缺，不受任何影響。`,
        details: [
          { label: "已刪除數量", value: `${deleted} 個檔案` },
          { label: "操作目標", value: "個人 Google 雲端硬碟" },
          { label: "剩餘雲端備份", value: `${remainingFiles.length} 個檔案` },
          { label: "本機資料", value: "安全保留未變動" },
        ],
      });
    } catch (error) {
      setStatus("error");
      const errMsg = error instanceof Error ? error.message : "刪除雲端備份失敗";
      setMessage(errMsg);
      setNoticeModal({
        type: "error",
        title: "刪除雲端備份失敗",
        message: errMsg,
      });
    } finally {
      setIsDriveBusy(false);
      setTimeout(() => setDriveProgress(null), 1500);
    }
  }

  async function handleRefreshDriveList() {
    if (!driveModal) return;
    setIsDriveBusy(true);
    setDriveProgress({ percent: 30, text: "正在即時更新雲端檔案清單…" });
    try {
      const files = await listDriveBackups("電表");
      setDriveModal((prev) => (prev ? { ...prev, files, selectedIds: [] } : null));
      setMessage(`已更新 Google 雲端硬碟檔案清單（共 ${files.length} 個）`);
    } catch (err) {
      console.warn("重整清單失敗", err);
    } finally {
      setIsDriveBusy(false);
      setDriveProgress(null);
    }
  }

  async function handleSwitchDriveAccount() {
    if (!driveModal) return;
    clearDriveAccessToken();
    clearDriveSyncCache();
    setIsDriveBusy(true);
    setDriveProgress({ percent: 20, text: "正在選取 Google 帳號…" });
    try {
      await getDriveAccessToken(undefined, false);
      const files = await listDriveBackups("電表");
      setDriveModal((prev) => (prev ? { ...prev, files, selectedIds: [] } : null));
      setMessage(`已切換 Google 帳號並載入清單（共 ${files.length} 個）`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "切換帳號失敗";
      if (errMsg.includes("已取消") || errMsg.includes("closed")) {
        setMessage("已取消帳號選取");
      } else {
        setMessage(errMsg);
      }
    } finally {
      setIsDriveBusy(false);
      setDriveProgress(null);
    }
  }

  async function handleRestore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    const isExcel = /\.(xlsx|xls)$/i.test(file.name);

    if (isExcel) {
      if (!window.confirm("從 Excel 匯入會將資料加入相同或新的日期（不會覆蓋其他資料），確定繼續？")) {
        return;
      }
      try {
        const importedFolders = await restoreFromExcel(file);
        let count = 0;
        updateData((current) => {
          const folders = { ...current.folders };
          for (const [date, imported] of Object.entries(importedFolders)) {
            const existing = folders[date] ?? { records: [], seenQrTexts: [] };
            const known = new Set(existing.records.map((record) => JSON.stringify(record)));
            const merged = [...existing.records];
            for (const record of imported.records) {
              const key = JSON.stringify(record);
              if (!known.has(key)) {
                known.add(key);
                merged.push(record);
              }
            }
            folders[date] = { records: merged, seenQrTexts: existing.seenQrTexts };
            count += merged.length - existing.records.length;
          }
          return { ...current, folders };
        });
        setStatus("done");
        setMessage(`已從 Excel 匯入 ${count} 筆資料（設定與掃描紀錄請使用 JSON 備份還原）`);
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Excel 匯入失敗");
      }
      return;
    }

    if (!window.confirm("還原備份會覆蓋目前的全部資料，確定繼續？")) {
      return;
    }

    try {
      const restored = await restoreFromFile(file);
      dataRef.current = restored;
      setData(restored);
      setStatus("done");
      setMessage("已從備份檔還原資料");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "還原失敗");
    }
  }

  async function handleGalleryScan(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setStatus("scanning");
    setMessage("正在讀取圖片中的 QRCode...");
    try {
      const result = await scanImage(file);
      if (result.qrTexts.length) {
        await handleQrTexts(result.qrTexts);
      } else {
        setStatus("error");
        setMessage("圖片中找不到可判讀的 QRCode");
        feedbackError();
      }
    } catch {
      setStatus("error");
      setMessage("讀取圖片失敗");
      feedbackError();
    }
  }

  function setPrefixEnabled(enabled: boolean) {
    updateData((current) => ({ ...current, servicePrefixEnabled: enabled }));
  }

  function setPrefix(prefix: string) {
    updateData((current) => ({ ...current, servicePrefix: prefix.replace(/\D/g, "").slice(0, 6) }));
  }

  function setDistrictCode(code: string) {
    updateData((current) => ({ ...current, districtCode: code.replace(/\D/g, "").slice(0, 2) }));
  }

  function setScanInterval(scanIntervalMs: number) {
    updateData((current) => ({ ...current, scanIntervalMs }));
  }

  function setServiceQrEnabled(enabled: boolean) {
    updateData((current) => ({ ...current, serviceQrEnabled: enabled }));
    setStatus("done");
    setMessage(enabled ? "電號標籤掃描已開啟：配對後請續掃貼紙" : "電號標籤掃描已關閉：配對後直接手輸電號");
  }

  function setKeypadMode(keypadMode: StoredAppData["keypadMode"]) {
    updateData((current) => ({ ...current, keypadMode }));
    setStatus("done");
    setMessage(keypadMode === "large" ? "已切換為自製大鍵盤輸入" : "已切換為手機系統鍵盤輸入");
  }

  function updateEditField(field: SheetEditableField, value: string) {
    setEditDraft((current) => {
      if (!current) {
        return current;
      }
      if (field === "serviceNumber") {
        return { ...current, serviceNumber: value.replace(/\D/g, "").slice(0, 8) };
      }
      if (field === "meterNumber") {
        return { ...current, meterNumber: value.replace(/\D/g, "").slice(0, 8) };
      }
      if (field === "prefix") {
        return { ...current, prefix: value.replace(/\D/g, "").slice(0, 6) };
      }
      if (field === "expiryDate") {
        return { ...current, expiryDate: value };
      }
      if (field === "model") {
        return { ...current, model: value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) };
      }
      if (field === "manufactureDate") {
        return { ...current, manufactureDate: value.replace(/[^0-9/]/g, "").slice(0, 6) };
      }
      if (field === "inspectionNumber") {
        return { ...current, inspectionNumber: value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) };
      }
      return { ...current, [field]: value };
    });
    setEditError("");
  }

  async function handleForceRefreshCache() {
    if (!navigator.onLine) {
      alert("目前處於離線狀態，請先連上網路後再點擊更新快取！");
      return;
    }
    if (!window.confirm(`即將清除舊快取並重載最新版本 (v${APP_VERSION})，是否繼續？`)) {
      return;
    }
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        for (const key of keys) {
          await caches.delete(key);
        }
      }
    } catch {
      // 忽略清理錯誤
    }
    window.location.reload();
  }

  function setServiceQrHeader(serviceQrHeader: string) {
    updateData((current) => ({ ...current, serviceQrHeader }));
  }

  function setInspectionQrHeaders(inspectionQrHeaders: string) {
    updateData((current) => ({ ...current, inspectionQrHeaders }));
  }

  function setMeterDigitsRange(min: number, max: number) {
    const meterMinDigits = Math.min(min, max);
    const meterMaxDigits = Math.max(min, max);
    updateData((current) => ({ ...current, meterMinDigits, meterMaxDigits }));
  }

  function resetQrHeaderSettings() {
    updateData((current) => ({
      ...current,
      serviceQrHeader: "MS:",
      inspectionQrHeaders: "LOLH, L0LH",
      meterMinDigits: 7,
      meterMaxDigits: 10,
    }));
    setStatus("done");
    setMessage("已恢復 QR 辨識標頭與碼數預設值");
  }

  function setEditPrefixEnabled(enabled: boolean) {
    setEditDraft((current) => {
      if (!current) {
        return current;
      }

      const serviceNumber =
        enabled && !current.serviceNumber
          ? current.prefix
          : !enabled && current.serviceNumber === current.prefix
            ? ""
            : current.serviceNumber;

      return { ...current, prefixEnabled: enabled, serviceNumber };
    });
  }

  // 檢定期限快捷輸入：打字時只更新預設值（不碰型式記憶），離開欄位才正式提交。
  // 避免輸入中間態（如 "1"、"12"）污染 modelExpiryMap。
  function handleQuickExpiryDraft(val: string) {
    const formatted = formatExpiryDate(val);
    updateData((current) => ({ ...current, defaultExpiryDate: formatted }));
  }

  function commitQuickExpiry() {
    updateData((current) => {
      const formatted = formatExpiryDate(current.defaultExpiryDate || "");
      const date = activeDateRef.current;
      const latestModel = current.folders[date]?.records[0]?.model || "";
      const nextMap = { ...current.modelExpiryMap };
      if (latestModel && formatted) {
        nextMap[latestModel] = formatted;
      }
      for (const key of Object.keys(nextMap)) {
        if (!nextMap[key]) {
          delete nextMap[key];
        }
      }
      return { ...current, defaultExpiryDate: formatted, modelExpiryMap: nextMap };
    });
  }

  function clearQuickExpiry() {
    // 只清預設值，不動已記憶的各型式期限
    updateData((current) => ({ ...current, defaultExpiryDate: "" }));
  }

  function dismissEditDraft() {
    const wasComplete = editDraftRef.current?.mode === "complete";
    setEditDraftLive(null);
    setEditError("");
    nativeTargetMeterRef.current = null;
    targetMeterLiveRef.current = null;
    pendingCompletionRef.current = null;
    setTargetMeterLive(null);
    nativeSessionTextsRef.current.clear();
    setStatus("done");
    setMessage(wasComplete ? "掃描已停止，電號可稍後在清單中補填" : "已取消編輯");
  }

  function saveEditDraft(continueScanning: boolean) {
    const liveDraft = editDraftRef.current;
    if (!liveDraft) {
      return;
    }

    const draft = liveDraft;
    const serviceNumber = draft.serviceNumber.replace(/\D/g, "").slice(0, 8);
    // 掃描補電號流程必須有電號；清單編輯允許清空（回到缺電號狀態）
    if (draft.mode === "complete" && !serviceNumber) {
      setEditError("請輸入電號");
      return;
    }
    if (serviceNumber && serviceNumber.length !== 8) {
      setEditError("電號必須為固定 8 碼");
      return;
    }

    // 電號唯一性：同一電號不可重複綁定兩顆表，擋下不給存
    if (serviceNumber) {
      const folder = dataRef.current.folders[activeDateRef.current] ?? { records: [], seenQrTexts: [] };
      const conflict = folder.records.find((record, index) => {
        if ((record.serviceNumber ?? "").replace(/\D/g, "") !== serviceNumber) {
          return false;
        }
        if (draft.mode === "edit" || draft.targetIndex !== undefined) {
          return index !== draft.targetIndex;
        }
        return record.meterNumber !== draft.anchorMeterNumber;
      });
      if (conflict) {
        setEditError(`電號${formatServiceNumber(serviceNumber)}已綁定表號${conflict.meterNumber}，不可重複儲存`);
        return;
      }
    }

    const expiryDate = draft.expiryDate ? formatExpiryDate(draft.expiryDate) : "";
    const meterNumber = draft.meterNumber.replace(/\D/g, "").slice(0, 8);
    if (meterNumber && meterNumber.length !== 8) {
      setEditError("表號必須為固定 8 碼");
      return;
    }

    updateActiveFolder((folder) => {
      const records = folder.records.map((record, idx) => {
        const isTarget =
          draft.mode === "edit" || draft.targetIndex !== undefined
            ? idx === draft.targetIndex
            : Boolean(draft.anchorMeterNumber && record.meterNumber === draft.anchorMeterNumber);

        if (isTarget) {
          return {
            serviceNumber,
            model: draft.model,
            meterNumber,
            manufactureDate: draft.manufactureDate,
            inspectionNumber: draft.inspectionNumber,
            expiryDate: expiryDate || record.expiryDate,
          };
        }

        // 同型式若未填寫檢定期限，一併自動套用！
        if (expiryDate && draft.model && record.model === draft.model && !record.expiryDate) {
          return { ...record, expiryDate };
        }

        return record;
      });

      // 表號被修改時，舊表號殘留的 QR 文本一併清理（與刪除邏輯一致）
      const remainingMeters = new Set(records.map((record) => record.meterNumber).filter(Boolean));
      const seenQrTexts = folder.seenQrTexts.filter((raw) => {
        const seenMeter = parseQrText(raw)?.meterNumber || "";
        return !seenMeter || remainingMeters.has(seenMeter);
      });

      return { ...folder, records, seenQrTexts };
    });

    updateData((current) => {
      const nextMap = { ...current.modelExpiryMap };
      if (draft.model && expiryDate) {
        nextMap[draft.model] = expiryDate;
      }
      // 注意：不再把本次期限寫回 defaultExpiryDate，避免上批期限污染新批次新機型；
      // 預設值只由設定頁／快捷列／掃描前確認等明確操作修改。
      return {
        ...current,
        servicePrefixEnabled: draft.prefixEnabled,
        servicePrefix: draft.prefix,
        modelExpiryMap: nextMap,
      };
    });

    setEditDraftLive(null);
    setEditError("");
    nativeTargetMeterRef.current = null;
    targetMeterLiveRef.current = null;
    pendingCompletionRef.current = null;
    setTargetMeterLive(null);
    nativeSessionTextsRef.current.clear();

    const isContinuingComplete = continueScanning && draft.mode === "complete";
    if (isContinuingComplete && meterNumber) {
      justSavedMeterRef.current = { meter: meterNumber, until: Date.now() + 2500 };
      setJustSavedMeter(meterNumber);
      window.setTimeout(() => {
        setJustSavedMeter((cur) => (cur === meterNumber ? null : cur));
      }, 2500);
      setStatus("done");
      setMessage(`表號 ${meterNumber} 儲存成功！此電表已完成，請移至下一台`);
    } else {
      justSavedMeterRef.current = null;
      setJustSavedMeter(null);
      setStatus("done");
      setMessage(`電表 ${meterNumber || "資料"} 已完成儲存`);
    }

    if (continueScanning && draft.mode === "complete") {
      if (continueScanTimerRef.current !== null) {
        window.clearTimeout(continueScanTimerRef.current);
      }
      continueScanTimerRef.current = window.setTimeout(() => {
        continueScanTimerRef.current = null;
        if (!isMountedRef.current) return;
        void startCamera();
      }, 0);
    }
  }

  const isWaitingSticker =
    cameraActive &&
    (Boolean(pendingCompletionRef.current) || message.includes("請掃電號"));
  const isDuplicateAlert =
    cameraActive &&
    status !== "done" &&
    (status === "duplicate" ||
      message.includes("此電表已完成") ||
      message.includes("請移至下一台") ||
      message.includes("已掃過") ||
      message.includes("已掃描過"));
  const alertMeterMatch = message.match(/表號[:\s]*([A-Z0-9]+)/i);
  const activeAlertMeter = alertMeterMatch ? alertMeterMatch[1] : (pendingCompletionRef.current || targetMeter || "");

  return (
    <main className="app-shell">
      <section className={`mobile-workspace ${isNativeApp() && cameraActive ? "native-scan-workspace" : ""}`}>
        {/* 隱藏的相簿與還原檔案上傳器 */}
        <input
          ref={galleryInputRef}
          accept="image/*"
          hidden
          type="file"
          onChange={(event) => void handleGalleryScan(event)}
        />
        <input
          ref={restoreInputRef}
          accept=".json,.txt,application/json,text/plain,.xlsx,.xls"
          hidden
          type="file"
          onChange={(event) => void handleRestore(event)}
        />

        {/* ======================= TAB 1: 現場掃描 ======================= */}
        {activeTab === "scan" && (
          <div className="scan-tab-view">
            <header className="app-header">
              <div className="app-header-left">
                <div className="eyebrow-row">
                  <span className="eyebrow-text">電表作業</span>
                  <span className="eyebrow-version">v{APP_VERSION}</span>
                </div>
                <h1 className="header-title">電表 QRCode 掃描</h1>
              </div>
              <div className="header-right">
                <span className="date-pill">{activeDate}</span>
              </div>
            </header>

            <div
              className={`status-banner ${status} ${isWaitingSticker ? "waiting-sticker" : ""} ${
                isDuplicateAlert ? "duplicate-alert" : ""
              }`}
            >
              {isDuplicateAlert ? (
                <AlertTriangle className="banner-alert-icon" size={18} />
              ) : isWaitingSticker ? (
                <Tag className="banner-alert-icon" size={18} />
              ) : status === "done" ? (
                <CheckCircle2 size={18} />
              ) : status === "duplicate" ? (
                <AlertTriangle size={18} />
              ) : status === "scanning" ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <ClipboardPlus size={18} />
              )}
              <span>{message}</span>
            </div>

            {/* Web 相機畫面 (若是 Web 模式下開啟相機) */}
            {!isNativeApp() && cameraActive ? (
              <div
                className={`camera-frame size-${cameraWindowSize} ${
                  isWaitingSticker ? "waiting-sticker" : ""
                } ${isDuplicateAlert ? "duplicate-alert" : ""}`}
              >
                <div className="web-camera-tools">
                  <button
                    type="button"
                    className="camera-size-toggle-btn"
                    onClick={cycleCameraSize}
                    title="切換相機視窗大小（黃金大視窗 / 全幅超大視窗 / 精簡視窗）"
                  >
                    {cameraWindowSize === "xlarge" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    <span>
                      {cameraWindowSize === "xlarge" ? "全幅超大" : cameraWindowSize === "compact" ? "精簡視窗" : "黃金大視窗"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`torch-toggle-btn ${torchActive ? "active" : ""}`}
                    onClick={() => void toggleTorch()}
                  >
                    {torchActive ? <Zap size={16} /> : <ZapOff size={16} />}
                    <span>{torchActive ? "關閉補光" : "開啟補光"}</span>
                  </button>
                  {targetMeter ? (
                    <button type="button" className="reset-meter-btn small" onClick={resetTargetMeter}>
                      <RefreshCw size={14} /> 換表 ({targetMeter})
                    </button>
                  ) : null}
                </div>
                {scanEngine ? (
                  <div className={`engine-badge ${scanEngine}`} aria-hidden="true">
                    {scanEngine === "mlkit" ? <Zap size={12} /> : null}
                  </div>
                ) : null}
                <div className="scan-reticle">
                  <div className="scan-reticle-corner tl" />
                  <div className="scan-reticle-corner tr" />
                  <div className="scan-reticle-corner bl" />
                  <div className="scan-reticle-corner br" />
                  <div className="scan-laser-line" />
                </div>
                {isDuplicateAlert ? (
                  <div className="camera-scan-hud duplicate-hud">
                    <AlertTriangle size={15} className="hud-icon-pulse" />
                    <span>此電表已完成{activeAlertMeter ? ` (${activeAlertMeter})` : ""}・請移下一台</span>
                  </div>
                ) : isWaitingSticker ? (
                  <div className="camera-scan-hud sticker-hud">
                    <Tag size={15} className="hud-icon-pulse" />
                    <span>已配對{activeAlertMeter ? ` (${activeAlertMeter})` : ""}・請掃電號標籤</span>
                  </div>
                ) : justSavedMeter ? (
                  <div className="camera-scan-hud success-hud">
                    <CheckCircle2 size={15} className="hud-icon-pulse" />
                    <span>表號 {justSavedMeter} 儲存成功・請移下一台</span>
                  </div>
                ) : null}
                <video ref={videoRef} muted playsInline />
              </div>
            ) : null}

            {/* 核心掃描控制卡片 */}
            <div className="hero-scan-card">
              {cameraActive ? (
                <button className="hero-scan-btn danger" type="button" onClick={stopCamera}>
                  <Square size={22} />
                  <div className="hero-scan-text">
                    <span className="hero-title">停止掃描</span>
                    <span className="hero-subtitle">結束相機讀取狀態</span>
                  </div>
                </button>
              ) : (
                <button
                  className="hero-scan-btn"
                  type="button"
                  onClick={requestStartScan}
                >
                  <Camera size={26} />
                  <div className="hero-scan-text">
                    <span className="hero-title">開始連續掃描</span>
                    <span className="hero-subtitle">
                      {`自動比對雙QR・間隔 ${data.scanIntervalMs / 1000}秒`}
                    </span>
                  </div>
                </button>
              )}

              <div className="scan-secondary-actions">
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                >
                  <ImageIcon size={16} />
                  相簿辨識
                </button>

                <button className="secondary-button compact" type="button" onClick={addBlankRecord}>
                  <Plus size={16} />
                  手動新增
                </button>
              </div>

              <div className="scan-quick-card">
                {targetMeter ? (
                  <div className="quick-mode-strip">
                    <span className="pref-pill-label">鎖定中：{targetMeter}</span>
                    <button type="button" className="link-btn text-danger reset-btn-pill" onClick={resetTargetMeter}>
                      <RefreshCw size={12} /> 換表
                    </button>
                  </div>
                ) : null}

                <div className="quick-setting-row">
                  <label className="pref-pill-label">
                    <input
                      checked={data.serviceQrEnabled}
                      disabled={cameraActive}
                      type="checkbox"
                      onChange={(event) => setServiceQrEnabled(event.target.checked)}
                    />
                    <span>電號標籤掃描</span>
                  </label>
                  <span className="pref-field-sub">開：配對後續掃貼紙自動帶入</span>
                </div>

                <div className="quick-setting-row">
                  <label className="pref-pill-label">
                    <input
                      checked={data.servicePrefixEnabled}
                      type="checkbox"
                      onChange={(event) => setPrefixEnabled(event.target.checked)}
                    />
                    <span>固定前綴</span>
                  </label>
                  <div className="quick-input-cell">
                    <div className="input-with-clear-wrap">
                      {data.keypadMode === "large" ? (
                        <button
                          type="button"
                          className={`quick-ctrl-display-btn ${!data.servicePrefix ? "placeholder" : ""}`}
                          disabled={!data.servicePrefixEnabled}
                          title="點此使用大鍵盤輸入前綴"
                          onClick={() => openQuickKeypad("prefix")}
                        >
                          {data.servicePrefix || (data.servicePrefixEnabled ? "點此輸入" : "未啟用")}
                        </button>
                      ) : (
                        <input
                          className="quick-ctrl-input"
                          disabled={!data.servicePrefixEnabled}
                          inputMode="numeric"
                          maxLength={6}
                          placeholder={data.servicePrefixEnabled ? "例如 40 或 10 (最多6碼)" : "點左側勾選啟用"}
                          title="固定電號前綴 (最多6碼)"
                          value={data.servicePrefix}
                          onChange={(event) => setPrefix(event.target.value.replace(/\D/g, ""))}
                        />
                      )}
                      {data.servicePrefixEnabled && data.servicePrefix ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空前綴"
                          onClick={() => setPrefix("")}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="quick-setting-row">
                  <div className="quick-label-cell">
                    <span className="pref-field-title">檢定期限</span>
                    <span className="pref-field-sub">同型式套用 (免打/自動補)</span>
                  </div>
                  <div className="quick-input-cell">
                    <div className="input-with-clear-wrap">
                      {data.keypadMode === "large" ? (
                        <button
                          type="button"
                          className={`quick-ctrl-display-btn ${!data.defaultExpiryDate ? "placeholder" : ""}`}
                          title="點此使用大鍵盤輸入期限 (可免輸入/，如 12512 自動補 /)"
                          onClick={() => openQuickKeypad("expiryDate")}
                        >
                          {data.defaultExpiryDate || "未設定 (可空白)"}
                        </button>
                      ) : (
                        <input
                          className="quick-ctrl-input"
                          inputMode="numeric"
                          placeholder="如 12512 (免打/自動補) 或 125/12"
                          title="當前檢定期限 (可免輸入/，連打數字自動補 /)"
                          value={data.defaultExpiryDate}
                          onChange={(event) => handleQuickExpiryDraft(event.target.value)}
                          onBlur={commitQuickExpiry}
                        />
                      )}
                      {data.defaultExpiryDate ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空期限"
                          onClick={() => clearQuickExpiry()}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="quick-setting-row">
                  <div className="quick-label-cell">
                    <span className="pref-field-title">區處代碼</span>
                    <span className="pref-field-sub">匯出補11碼</span>
                  </div>
                  <div className="quick-input-cell">
                    <div className="input-with-clear-wrap">
                      {data.keypadMode === "large" ? (
                        <button
                          type="button"
                          className={`quick-ctrl-display-btn ${!data.districtCode ? "placeholder" : ""}`}
                          title="點此使用大鍵盤輸入區處代碼"
                          onClick={() => openQuickKeypad("districtCode")}
                        >
                          {data.districtCode || "10 (預設)"}
                        </button>
                      ) : (
                        <input
                          className="quick-ctrl-input"
                          inputMode="numeric"
                          maxLength={2}
                          placeholder="10"
                          title="區處代碼（預設 10 台南）"
                          value={data.districtCode}
                          onChange={(event) => setDistrictCode(event.target.value)}
                        />
                      )}
                      {data.districtCode ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空區處代碼"
                          onClick={() => setDistrictCode("")}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 最新電表卡片 / 導引卡片 */}
            {records.length > 0 ? (
              <div className="recent-meter-card">
                <div className="recent-card-header">
                  <div className="recent-card-title">
                    <Sparkles size={16} />
                    <span>最新處理電表</span>
                  </div>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setActiveTab("list")}
                  >
                    查看清單 ({records.length}筆) <ChevronRight size={14} />
                  </button>
                </div>

                <div className="recent-card-body">
                  <div className="recent-meter-main">
                    <span className="recent-meter-label">表號</span>
                    <span className="recent-meter-number">{records[0].meterNumber || "尚未取得表號"}</span>
                    {!isMeterPairComplete(records[0], activeFolder.seenQrTexts) ? (
                      <span className="pair-pill partial">1/2 缺檢驗</span>
                    ) : null}
                  </div>

                  <div className="recent-pills-row">
                    <span className="summary-pill">型式: {records[0].model || "—"}</span>
                    <span className="summary-pill">製造: {records[0].manufactureDate || "—"}</span>
                    <span className="summary-pill">檢驗: {records[0].inspectionNumber || "—"}</span>
                    <span className="summary-pill">檢定: {records[0].expiryDate || "—"}</span>
                  </div>

                  <div className="recent-service-box">
                    {records[0].serviceNumber ? (
                      <div className="recent-service-filled">
                        <span>電號：<strong>{formatServiceNumber(records[0].serviceNumber)}</strong></span>
                        <button
                          type="button"
                          className="recent-edit-btn"
                          onClick={() => openEditDraft(records[0], 0)}
                        >
                          修改
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="recent-fill-service-btn"
                        onClick={() => openCompletionDraft(records[0], 0)}
                      >
                        <Edit3 size={15} />
                        <span>尚未填寫電號・點此輸入 (手動)</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="guide-card">
                <div className="guide-item">
                  <span className="guide-step">1</span>
                  <div>
                    <strong>對準電表掃描</strong>
                    <p>自動比對讀取雙 QRCode（表號與檢驗號碼）</p>
                  </div>
                </div>
                <div className="guide-item">
                  <span className="guide-step">2</span>
                  <div>
                    <strong>填寫電號貼紙</strong>
                    <p>超大數字鍵盤防誤觸，單手快速點擊輸入</p>
                  </div>
                </div>
                <div className="guide-item">
                  <span className="guide-step">3</span>
                  <div>
                    <strong>自動儲存與匯出</strong>
                    <p>離線安全保存在本機 IndexedDB，隨時可匯出 Excel</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ======================= TAB 2: 電表清單 ======================= */}
        {activeTab === "list" && (
          <div className="list-tab-view">
            <header className="app-header compact">
              <div className="app-header-left">
                <h1 className="header-title">電表清單</h1>
              </div>
              <button
                className="secondary-button compact"
                type="button"
                onClick={addBlankRecord}
              >
                <Plus size={16} /> 新增
              </button>
            </header>

            <div className="list-top-bar">
              <div className="date-select-wrapper">
                <select value={activeDate} onChange={(event) => setActiveDate(event.target.value)}>
                  {folderDates.map((date) => (
                    <option key={date} value={date}>
                      {date} ({data.folders[date]?.records.length ?? 0}筆)
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="list-date-export-btn"
                  title={`匯出 ${activeDate} 報表`}
                  onClick={() => void exportDateDirectly(activeDate)}
                >
                  <Download size={13} /> 匯出此日
                </button>
              </div>

              <div className="stats-badges-row">
                <span className="stat-pill">共 {records.length} 筆</span>
                {incompleteInActiveFolder > 0 ? (
                  <span className="stat-pill warning">缺電號 {incompleteInActiveFolder}</span>
                ) : (
                  <span className="stat-pill success">全齊全</span>
                )}
              </div>
            </div>

            <div className="filter-chips-row">
              <button
                type="button"
                className={`filter-chip-btn ${!incompleteOnly ? "active" : ""}`}
                onClick={() => setIncompleteOnly(false)}
              >
                全部 ({records.length})
              </button>
              <button
                type="button"
                className={`filter-chip-btn warning-chip ${incompleteOnly ? "active" : ""}`}
                onClick={() => setIncompleteOnly(true)}
              >
                僅看缺電號 ({incompleteInActiveFolder})
              </button>
            </div>

            <div className="batch-bar">
              <button className="text-button" type="button" disabled={!records.length} onClick={toggleSelectionMode}>
                {selectionMode ? "取消選取" : "選取"}
              </button>
              <button className="text-button" type="button" disabled={!filteredEntries.length} onClick={selectAllRecords}>
                全選
              </button>
              {selectionMode ? (
                <button
                  className="text-button danger-text"
                  type="button"
                  disabled={!selectedCount}
                  onClick={deleteSelectedRecords}
                >
                  <Trash2 size={14} /> 刪除 ({selectedCount})
                </button>
              ) : null}
            </div>

            <div className="data-tools">
              <label className="search-field">
                <Search size={15} />
                <input
                  placeholder="搜尋電號 / 表號 / 檢驗號碼"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="input-inline-clear-btn"
                    title="清空搜尋"
                    onClick={(e) => {
                      e.preventDefault();
                      setSearchQuery("");
                    }}
                  >
                    <X size={15} />
                  </button>
                ) : null}
              </label>
            </div>

            {filteredEntries.length ? (
              <div className="records">
                {filteredEntries.map(({ record, index }) => (
                  <RecordCard
                    key={`${record.meterNumber || "new"}-${index}`}
                    record={record}
                    index={index}
                    selectionMode={selectionMode}
                    selected={selectedIndexes.includes(index)}
                    seenQrTexts={activeFolder.seenQrTexts}
                    onToggleSelection={toggleSelection}
                    onDelete={deleteRecord}
                    onEdit={openEditDraft}
                    onQuickFillServiceNumber={(rec) => openEditDraft(rec, index)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <FileSpreadsheet size={34} />
                <p>
                  {searchQuery
                    ? "沒有符合搜尋條件的資料"
                    : incompleteOnly
                    ? "太棒了！目前沒有缺少電號的資料"
                    : "今日尚未建立電表資料，點擊右上角新增或至掃描頁開始"}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ======================= TAB 3: 匯出與設定 ======================= */}
        {activeTab === "settings" && (
          <div className="settings-tab-view">
            <header className="app-header">
              <div className="app-header-left">
                <div className="eyebrow-row">
                  <span className="eyebrow-text">系統管理</span>
                  <span className="eyebrow-version">v{APP_VERSION}</span>
                </div>
                <h1 className="header-title">匯出與偏好設定</h1>
              </div>
              <div className="header-right">
                <div className="settings-accordion-toggle-group">
                  <button
                    type="button"
                    className="settings-toggle-all-btn"
                    onClick={() => setAllSettingsCards(true)}
                    title="展開全部設定卡片"
                  >
                    全部展開
                  </button>
                  <button
                    type="button"
                    className="settings-toggle-all-btn"
                    onClick={() => setAllSettingsCards(false)}
                    title="收合全部設定卡片"
                  >
                    全部收合
                  </button>
                </div>
                <span className="date-pill">{today()}</span>
              </div>
            </header>

            {/* 卡片 1: 資料匯出 */}
            <div className="settings-card">
              <div
                className="settings-card-header collapsible"
                onClick={() => toggleSettingsCard("export")}
                role="button"
                tabIndex={0}
              >
                <div className="settings-card-header-left">
                  <Download size={16} />
                  <span>報表資料匯出 (Excel)</span>
                  {!expandedSettingsCards.export && (
                    <span className="settings-header-pill">
                      今日 {data.folders[today()]?.records.length ?? 0} 筆
                    </span>
                  )}
                </div>
                <div className="settings-card-header-right">
                  <ChevronDown
                    size={18}
                    className={`settings-chevron ${expandedSettingsCards.export ? "open" : ""}`}
                  />
                </div>
              </div>

              {expandedSettingsCards.export && (
                <div className="settings-card-content">
                  <div className="settings-tip-banner">
                <Share2 size={16} />
                <span>手機提示：點擊匯出後選擇「分享」，即可直接儲存至「Google 雲端硬碟」或傳送至 LINE！</span>
              </div>

              {/* 項目 1: 一鍵匯出今日資料 (最直覺快捷) */}
              <div className="settings-item highlight-export">
                <div className="settings-item-info">
                  <span className="settings-item-title">匯出今日資料 ({today()})</span>
                  <span className="settings-item-desc">
                    今日累計共 {data.folders[today()]?.records.length ?? 0} 筆電表
                    {data.folders[today()] && incompleteCount(data.folders[today()].records) > 0
                      ? `（缺電號 ${incompleteCount(data.folders[today()].records)} 筆）`
                      : "（資料齊全）"}
                  </span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn primary-action"
                    disabled={!(data.folders[today()]?.records.length)}
                    type="button"
                    onClick={() => void exportDateDirectly(today())}
                  >
                    <Download size={14} /> 匯出今日
                  </button>
                </div>
              </div>

              {/* 項目 2: 直接在此選擇指定日期並匯出 (免跳到清單頁) */}
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">選擇指定日期匯出</span>
                  <div className="settings-date-picker-row">
                    <select
                      className="settings-date-select"
                      value={selectedExportDate}
                      onChange={(e) => setSelectedExportDate(e.target.value)}
                    >
                      {folderDates.map((d) => (
                        <option key={d} value={d}>
                          {d} ({data.folders[d]?.records.length ?? 0}筆)
                        </option>
                      ))}
                    </select>
                    <span className="settings-date-meta">
                      共 {data.folders[selectedExportDate]?.records.length ?? 0} 筆
                      {data.folders[selectedExportDate] && incompleteCount(data.folders[selectedExportDate].records) > 0
                        ? ` (缺 ${incompleteCount(data.folders[selectedExportDate].records)})`
                        : ""}
                    </span>
                  </div>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    disabled={!(data.folders[selectedExportDate]?.records.length)}
                    type="button"
                    onClick={() => void exportDateDirectly(selectedExportDate)}
                  >
                    <Download size={14} /> 匯出此日
                  </button>
                </div>
              </div>

              {/* 項目 3: 匯出全部歷史資料 */}
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">匯出全部歷史資料</span>
                  <span className="settings-item-desc">包含所有工作天數的所有電表（累計共 {totalAllRecordsCount} 筆）</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    type="button"
                    onClick={() => void handleExportAll()}
                  >
                    <Download size={14} /> 匯出全部
                  </button>
                </div>
              </div>

              {/* 項目 4: 刪除此日期資料夾 */}
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">刪除選定日期資料夾</span>
                  <span className="settings-item-desc">清除所選日期 ({selectedExportDate}) 的資料夾與電表資料</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn danger"
                    disabled={!data.folders[selectedExportDate]}
                    type="button"
                    onClick={() => deleteFolderByDate(selectedExportDate)}
                  >
                    <Trash2 size={14} /> 刪除
                  </button>
                </div>
              </div>

              {/* 項目 5: 一鍵清理所有空白資料夾 */}
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">一鍵清理空白資料夾</span>
                  <span className="settings-item-desc">
                    掃描並清除所有 0 筆電表的測試空白日期資料夾（保留今日）
                  </span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    type="button"
                    onClick={cleanupEmptyFolders}
                  >
                    <Trash2 size={14} /> 清理空資料夾
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

          {/* 卡片 2: 資料備份與還原 */}
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("backup")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <Database size={16} />
                <span>資料備份與還原</span>
                {!expandedSettingsCards.backup && (
                  <span className="settings-header-pill">Google 雲端 · 本地備份</span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.backup ? "open" : ""}`}
                />
              </div>
            </div>

            {expandedSettingsCards.backup && (
              <div className="settings-card-content">

              {/* 雲端 Drive 專區 */}
              <div
                className="settings-tip-banner"
                style={{ background: "#f0f9ff", borderColor: "#bae6fd", color: "#0369a1" }}
              >
                <Cloud size={16} />
                <span>Google 雲端硬碟直連：免裝軟體，一鍵備份與跨裝置還原</span>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">備份到 Google Drive</span>
                  <span className="settings-item-desc">登入 Google 帳號，直接將資料庫備份儲存至個人雲端硬碟</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    style={{ background: "#0284c7", color: "#fff", borderColor: "#0284c7" }}
                    disabled={isDriveBusy}
                    type="button"
                    onClick={() => void handleDriveBackup()}
                  >
                    {isDriveBusy ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />} 備份至 Drive
                  </button>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">從 Google Drive 還原</span>
                  <span className="settings-item-desc">讀取個人雲端硬碟中的電表備份檔案清單並直接還原</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    disabled={isDriveBusy}
                    type="button"
                    onClick={() => void handleDriveRestoreList()}
                  >
                    {isDriveBusy ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />} 從 Drive 還原
                  </button>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">刪除雲端硬碟舊備份</span>
                  <span className="settings-item-desc">清理個人雲端硬碟中的歷史電表備份（本機資料不受影響）</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn danger"
                    disabled={isDriveBusy}
                    type="button"
                    onClick={() => void handleDriveDeleteList()}
                  >
                    <Trash2 size={14} /> 刪除雲端備份
                  </button>
                </div>
              </div>

              <hr style={{ border: "none", borderTop: "1px solid #eef2ed", margin: "10px 0" }} />

              {/* 本地檔案備份與還原 */}
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">完整備份 (本地下載)</span>
                  <span className="settings-item-desc">將所有日期、電表紀錄與設定輸出為單一 JSON 備份檔至本機</span>
                </div>
                <div className="settings-item-action">
                  <button className="settings-action-btn" type="button" onClick={handleBackup}>
                    <Download size={14} /> 本地備份
                  </button>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">資料還原 (本地選擇)</span>
                  <span className="settings-item-desc">從本機選取 JSON 備份檔或歷史 Excel 報表匯入</span>
                </div>
                <div className="settings-item-action">
                  <button
                    className="settings-action-btn"
                    type="button"
                    onClick={() => restoreInputRef.current?.click()}
                  >
                    <Upload size={14} /> 選擇檔案
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

          {/* 卡片 3: 掃描偏好設定 */}
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("scan")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <SlidersHorizontal size={16} />
                <span>掃描偏好設定</span>
                {!expandedSettingsCards.scan && (
                  <span className="settings-header-pill">
                    {data.scanIntervalMs / 1000}s · {data.keypadMode === "large" ? "大鍵盤" : "系統鍵盤"}
                  </span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.scan ? "open" : ""}`}
                />
              </div>
            </div>

            {expandedSettingsCards.scan && (
              <div className="settings-card-content">

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">連續掃描間隔時間</span>
                  <span className="settings-item-desc">每次成功讀取後的間隔秒數，避免重複刷碼</span>
                </div>
                <div className="settings-item-action">
                  <select
                    value={data.scanIntervalMs}
                    onChange={(e) => setScanInterval(Number(e.target.value))}
                  >
                    <option value={500}>0.5 秒</option>
                    <option value={1000}>1.0 秒</option>
                    <option value={1500}>1.5 秒</option>
                    <option value={2000}>2.0 秒</option>
                  </select>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">輸入鍵盤</span>
                  <span className="settings-item-desc">編輯電號、表號、期限時使用的鍵盤（全域統一）</span>
                </div>
                <div className="settings-item-action">
                  <select
                    value={data.keypadMode}
                    onChange={(e) => setKeypadMode(e.target.value === "system" ? "system" : "large")}
                  >
                    <option value="large">自製大鍵盤</option>
                    <option value="system">手機系統鍵盤</option>
                  </select>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">相機取景視窗尺寸</span>
                  <span className="settings-item-desc">調整相機畫面比例與瞄準框視野（大視窗 / 全幅 / 精簡）</span>
                </div>
                <div className="settings-item-action">
                  <select
                    value={cameraWindowSize}
                    onChange={(e) => {
                      const val = e.target.value as CameraWindowSize;
                      setCameraWindowSize(val);
                      try {
                        localStorage.setItem("camera_window_size", val);
                      } catch {
                        // 略過
                      }
                    }}
                  >
                    <option value="large">黃金大視窗 (4:3 推薦)</option>
                    <option value="xlarge">全幅超大視窗 (1:1)</option>
                    <option value="compact">精簡視窗 (16:10)</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

          {/* 卡片 4: 電號規則 */}
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("rules")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <FileText size={16} />
                <span>電號規則</span>
                {!expandedSettingsCards.rules && (
                  <span className="settings-header-pill">
                    {data.servicePrefixEnabled ? `前綴 ${data.servicePrefix}` : "未啟用前綴"} · 區號 {data.districtCode}
                  </span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.rules ? "open" : ""}`}
                />
              </div>
            </div>

            {expandedSettingsCards.rules && (
              <div className="settings-card-content">
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">啟用電號前綴預填</span>
                  <span className="settings-item-desc">新增電號時自動填入固定區域前綴碼</span>
                </div>
                <div className="settings-item-action">
                  <label className="switch-toggle">
                    <input
                      checked={data.servicePrefixEnabled}
                      type="checkbox"
                      onChange={(e) => setPrefixEnabled(e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>

              {data.servicePrefixEnabled ? (
                <div className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">電號前綴碼</span>
                    <span className="settings-item-desc">例如 40 或 10 (最多6碼)</span>
                  </div>
                  <div className="settings-item-action">
                    <div className="input-with-clear-wrap">
                      <input
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="最多6碼"
                        style={{ width: "105px", textAlign: "center", fontWeight: "bold" }}
                        value={data.servicePrefix}
                        onChange={(e) => setPrefix(e.target.value.replace(/\D/g, ""))}
                      />
                      {data.servicePrefix ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空"
                          onClick={() => setPrefix("")}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">縣市／區處代碼 (區號)</span>
                  <span className="settings-item-desc">預設 10 (台南區處)。Excel 匯出時自動在 8 碼電號前補此 2 碼並計算第 11 碼檢算碼，呈現完整 11 碼電號</span>
                </div>
                <div className="settings-item-action">
                  <div className="input-with-clear-wrap">
                    <input
                      inputMode="numeric"
                      maxLength={2}
                      placeholder="10"
                      style={{ width: "70px", textAlign: "center", fontWeight: "bold" }}
                      value={data.districtCode}
                      onChange={(e) => setDistrictCode(e.target.value)}
                    />
                    {data.districtCode ? (
                      <button
                        type="button"
                        className="input-inline-clear-btn"
                        title="清空"
                        onClick={() => setDistrictCode("")}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

          {/* 卡片 5: QR Code 辨識標頭與規則 (全新自訂功能) */}
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("qrRules")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <QrCode size={16} />
                <span>QR Code 辨識標頭與規則</span>
                {!expandedSettingsCards.qrRules && (
                  <span className="settings-header-pill">
                    標頭 {data.serviceQrHeader} · {data.inspectionQrHeaders.split(",")[0].trim()}
                  </span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.qrRules ? "open" : ""}`}
                />
              </div>
            </div>

            {expandedSettingsCards.qrRules && (
              <div className="settings-card-content">
                <div
                  className="settings-tip-banner"
                  style={{ background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534" }}
                >
                  <Info size={16} />
                  <span>
                    <strong>自動分流與標頭辨識說明：</strong>
                    系統掃瞄時會自動分析內容。電號貼紙與檢定合格貼紙的前綴代碼可在此彈性自訂，未來若標頭更換，直接修改即可即時生效，無需改寫程式！
                  </span>
                </div>

                {/* 項目 1: 電號貼紙標頭 */}
                <div className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">電號貼紙識別標頭</span>
                    <span className="settings-item-desc">
                      預設 <code>MS:</code>。掃到以此字首開頭的 QR 碼時自動判為電號貼紙並擷取後方電號（例如 <code>MS:40701139</code>）。支援逗號分隔多組（例如 <code>MS:, NO:, CUST:</code>）。
                    </span>
                  </div>
                  <div className="settings-item-action">
                    <div className="input-with-clear-wrap">
                      <input
                        type="text"
                        placeholder="例如 MS:"
                        style={{ width: "120px", textAlign: "center", fontWeight: "bold" }}
                        value={data.serviceQrHeader}
                        onChange={(e) => setServiceQrHeader(e.target.value)}
                      />
                      {data.serviceQrHeader ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空"
                          onClick={() => setServiceQrHeader("")}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* 項目 2: 檢定號碼識別標頭 */}
                <div className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">檢定號碼前綴標頭</span>
                    <span className="settings-item-desc">
                      預設 <code>LOLH, L0LH</code>。檢定合格貼紙 QR 碼常以此字首開頭（如 <code>L0LH14A37241;...</code>），系統會自動去除此前綴擷取合格號碼。支援逗號分隔多組。
                    </span>
                  </div>
                  <div className="settings-item-action">
                    <div className="input-with-clear-wrap">
                      <input
                        type="text"
                        placeholder="例如 LOLH, L0LH"
                        style={{ width: "140px", textAlign: "center", fontWeight: "bold" }}
                        value={data.inspectionQrHeaders}
                        onChange={(e) => setInspectionQrHeaders(e.target.value)}
                      />
                      {data.inspectionQrHeaders ? (
                        <button
                          type="button"
                          className="input-inline-clear-btn"
                          title="清空"
                          onClick={() => setInspectionQrHeaders("")}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* 項目 3: 表號純數字碼數範圍 */}
                <div className="settings-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">表號連續數字長度限制</span>
                    <span className="settings-item-desc">
                      預設 7 ～ 10 碼。系統會在電表銘版與貼紙的各項資料中，自動篩選此長度的純數字作為電表號碼。
                    </span>
                  </div>
                  <div className="settings-item-action" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <select
                      value={data.meterMinDigits}
                      onChange={(e) => setMeterDigitsRange(Number(e.target.value), data.meterMaxDigits)}
                      style={{ width: "68px", textAlign: "center", fontWeight: "bold" }}
                    >
                      {[5, 6, 7, 8].map((n) => (
                        <option key={n} value={n}>{n} 碼</option>
                      ))}
                    </select>
                    <span style={{ fontSize: "12px", color: "#666" }}>至</span>
                    <select
                      value={data.meterMaxDigits}
                      onChange={(e) => setMeterDigitsRange(data.meterMinDigits, Number(e.target.value))}
                      style={{ width: "68px", textAlign: "center", fontWeight: "bold" }}
                    >
                      {[8, 9, 10, 11, 12, 14].map((n) => (
                        <option key={n} value={n}>{n} 碼</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* 項目 4: 型式與製造日期自動判斷說明 */}
                <div className="settings-item" style={{ background: "#fafbfc" }}>
                  <div className="settings-item-info" style={{ width: "100%" }}>
                    <span className="settings-item-title" style={{ color: "#374151" }}>型式與製造日期識別原理（免手動設定）</span>
                    <div style={{ fontSize: "12px", color: "#4b5563", marginTop: "4px", lineHeight: "1.6" }}>
                      <div>• <strong>型式 (Model)</strong>：自動辨識含破折號之規格代碼（如 <code>GT-100</code>、<code>RT-120</code>、<code>SC20-123</code>），自動擷取破折號前 2 碼英文（如 <code>GT</code>、<code>RT</code>、<code>SC</code>）。</div>
                      <div>• <strong>製造日期 (Date)</strong>：自動辨識符合年/月格式之數字（如 <code>114/06</code> 或 <code>24/5</code>），自動記錄為製造年月。</div>
                    </div>
                  </div>
                </div>

                {/* 項目 5: 重設預設值按鈕 */}
                <div className="settings-item" style={{ justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={resetQrHeaderSettings}
                    title="將所有 QR 識別標頭與碼數還原為預設值"
                  >
                    <RefreshCw size={13} />
                    <span>恢復 QR 預設規則</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 卡片 6: 型式檢定期限記憶 */}
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("expiry")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <FileText size={16} />
                <span>型式檢定期限記憶 (同型式自動套用)</span>
                {!expandedSettingsCards.expiry && (
                  <span className="settings-header-pill">
                    {data.defaultExpiryDate ? `預設 ${data.defaultExpiryDate}` : "未設預設"} · 已記憶 {Object.keys(data.modelExpiryMap).length} 型
                  </span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.expiry ? "open" : ""}`}
                />
              </div>
            </div>

            {expandedSettingsCards.expiry && (
              <div className="settings-card-content">
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">預設檢定期限</span>
                  <span className="settings-item-desc">未特定型式時使用的通用檢定期限</span>
                </div>
                <div className="settings-item-action">
                  <div className="input-with-clear-wrap">
                    <input
                      inputMode="numeric"
                      placeholder="例如 125/12"
                      style={{ width: "100px", textAlign: "center", fontWeight: "bold" }}
                      value={data.defaultExpiryDate}
                      onChange={(e) => handleQuickExpiryDraft(e.target.value)}
                      onBlur={commitQuickExpiry}
                    />
                    {data.defaultExpiryDate ? (
                      <button
                        type="button"
                        className="input-inline-clear-btn"
                        title="清空"
                        onClick={() => clearQuickExpiry()}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              {Object.keys(data.modelExpiryMap).length > 0 ? (
                <div className="model-expiry-list">
                  <div className="model-expiry-header">已記憶型式期限：</div>
                  <div className="model-expiry-tags">
                    {Object.entries(data.modelExpiryMap).map(([model, expiry]) => (
                      <span key={model} className="model-expiry-badge">
                        <strong>{model}</strong>: {expiry}
                        <button
                          type="button"
                          className="badge-remove-btn"
                          title="清除此型式記憶"
                          onClick={() => {
                            updateData((current) => {
                              const nextMap = { ...current.modelExpiryMap };
                              delete nextMap[model];
                              return { ...current, modelExpiryMap: nextMap };
                            });
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* 卡片 7: 系統與儲存狀態 */}
        <div className="settings-card">
          <div
            className="settings-card-header collapsible"
            onClick={() => toggleSettingsCard("system")}
            role="button"
            tabIndex={0}
          >
            <div className="settings-card-header-left">
              <Info size={16} />
              <span>系統與儲存狀態</span>
              {!expandedSettingsCards.system && (
                <span className="settings-header-pill">v{APP_VERSION} · IndexedDB</span>
              )}
            </div>
            <div className="settings-card-header-right">
              <ChevronDown
                size={18}
                className={`settings-chevron ${expandedSettingsCards.system ? "open" : ""}`}
              />
            </div>
          </div>

          {expandedSettingsCards.system && (
            <div className="settings-card-content">
              <div className="storage-stats-container">
                <div className="storage-stat-box">
                  <span className="stat-box-label">本地儲存引擎</span>
                  <span className="stat-box-value">IndexedDB (大容量)</span>
                </div>
                <div className="storage-stat-box">
                  <span className="stat-box-label">累計工作天</span>
                  <span className="stat-box-value">
                    {Object.keys(data.folders).filter((d) => (data.folders[d]?.records.length ?? 0) > 0).length} 天
                  </span>
                </div>
                <div className="storage-stat-box">
                  <span className="stat-box-label">累計電表總數</span>
                  <span className="stat-box-value">{totalAllRecordsCount} 筆</span>
                </div>
                <div className="storage-stat-box">
                  <span className="stat-box-label">應用程式版本</span>
                  <span className="stat-box-value">v{APP_VERSION}</span>
                </div>
                <div className="storage-stat-box">
                  <span className="stat-box-label">離線快取管理</span>
                  <button
                    type="button"
                    className="cache-refresh-pill-btn"
                    onClick={() => void handleForceRefreshCache()}
                    title="清除舊快取並重載最新版本"
                  >
                    <RefreshCw size={12} />
                    <span>更新離線快取</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 卡片 8: 最後掃描 QR 原始資訊 */}
        {data.lastQrText ? (
          <div className="settings-card">
            <div
              className="settings-card-header collapsible"
              onClick={() => toggleSettingsCard("debug")}
              role="button"
              tabIndex={0}
            >
              <div className="settings-card-header-left">
                <Sparkles size={16} />
                <span>最後掃描 QR 原始資訊 (除錯)</span>
                {!expandedSettingsCards.debug && (
                  <span className="settings-header-pill">點擊展開資料</span>
                )}
              </div>
              <div className="settings-card-header-right">
                <ChevronDown
                  size={18}
                  className={`settings-chevron ${expandedSettingsCards.debug ? "open" : ""}`}
                />
              </div>
            </div>
            {expandedSettingsCards.debug && (
              <div className="settings-card-content" style={{ padding: "10px 14px" }}>
                <ScanDebug lastQrText={data.lastQrText} parsed={lastParsedQr} />
              </div>
            )}
          </div>
        ) : null}
          </div>
        )}

        {/* ======================= 底部固定導航欄 ======================= */}
        <nav className="bottom-nav-bar">
          <button
            type="button"
            className={`nav-tab-btn ${activeTab === "scan" ? "active" : ""}`}
            onClick={() => setActiveTab("scan")}
          >
            <Camera size={20} />
            <span>現場掃描</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${activeTab === "list" ? "active" : ""}`}
            onClick={() => setActiveTab("list")}
          >
            <div className="nav-icon-wrapper">
              <FileSpreadsheet size={20} />
              {records.length > 0 ? (
                <span className={`nav-badge ${incompleteInActiveFolder > 0 ? "warning" : ""}`}>
                  {incompleteInActiveFolder > 0 ? incompleteInActiveFolder : records.length}
                </span>
              ) : null}
            </div>
            <span>電表清單</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            <Settings size={20} />
            <span>匯出設定</span>
          </button>
        </nav>

        {/* 統一編輯抽屜：掃描補電號＋清單編輯共用同一套大鍵盤 */}
        {editDraft ? (
          <RecordEditSheet
            title={editDraft.mode === "complete" ? "輸入電號" : "編輯電表資料"}
            seenQrTexts={activeFolder.seenQrTexts}
            serviceNumber={editDraft.serviceNumber}
            model={editDraft.model}
            meterNumber={editDraft.meterNumber}
            manufactureDate={editDraft.manufactureDate}
            inspectionNumber={editDraft.inspectionNumber}
            expiryDate={editDraft.expiryDate}
            prefix={editDraft.prefix}
            prefixEnabled={editDraft.prefixEnabled}
            keypadMode={data.keypadMode}
            error={editError}
            modelOptions={modelOptions}
            onField={updateEditField}
            onPrefixEnabledChange={setEditPrefixEnabled}
            onDismiss={dismissEditDraft}
            actions={
              editDraft.mode === "complete" ? (
                <>
                  <div className="action-main-row">
                    <button
                      className="secondary-button compact-action"
                      type="button"
                      onClick={() => saveEditDraft(false)}
                    >
                      儲存並結束
                    </button>
                    <button
                      className="primary-button highlight-btn compact-action"
                      type="button"
                      onClick={() => saveEditDraft(true)}
                    >
                      儲存並繼續掃描
                    </button>
                  </div>
                  <button
                    className="text-button compact-dismiss"
                    type="button"
                    onClick={dismissEditDraft}
                  >
                    稍後輸入 (暫存)
                  </button>
                </>
              ) : (
                <>
                  <div className="action-main-row">
                    <button
                      className="secondary-button compact-action"
                      type="button"
                      onClick={dismissEditDraft}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button highlight-btn compact-action"
                      type="button"
                      onClick={() => saveEditDraft(false)}
                    >
                      儲存修改
                    </button>
                  </div>
                </>
              )
            }
          />
        ) : null}

        {/* 掃描前確認本次檢定期限彈窗 */}
        {/* 掃描前確認本次檢定期限彈窗 */}
        {showPreScanExpiryModal ? (
          <div className="completion-overlay" onClick={() => setShowPreScanExpiryModal(false)}>
            <section
              className="pre-scan-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="prescan-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pre-scan-header">
                <h3 id="prescan-title">確認本次檢定期限</h3>
                <button
                  type="button"
                  className="dialog-close-btn"
                  title="關閉"
                  onClick={() => setShowPreScanExpiryModal(false)}
                >
                  <X size={20} />
                </button>
              </div>

              <div className="pre-scan-body">
                <p className="pre-scan-notice">
                  換批次或型式時，期限可能不同。請確認目前檢定期限是否正確：
                </p>

                {data.keypadMode === "large" ? (
                  <div className="pre-scan-keypad-flow">
                    <div
                      className={`pre-scan-display-strip ${preScanKeypadOpen ? "active" : ""}`}
                      onClick={() => setPreScanKeypadOpen((prev) => !prev)}
                    >
                      <div className="pre-scan-card-top">
                        <span className="pre-scan-label">檢定期限</span>
                        <div className="pre-scan-strip-actions">
                          <span className="pre-scan-edit-hint">
                            {preScanKeypadOpen ? "收起大鍵盤" : "點此修改"}
                          </span>
                          <button
                            type="button"
                            className={`quick-keypad-clear-pill-btn ${!preScanExpiryDraft ? "disabled" : ""}`}
                            title="整欄清除"
                            disabled={!preScanExpiryDraft}
                            onClick={(e) => {
                              e.stopPropagation();
                              vibrate(20);
                              setPreScanExpiryDraft("");
                            }}
                          >
                            <X size={12} />
                            <span>整欄清除</span>
                          </button>
                        </div>
                      </div>
                      <div className="pre-scan-card-bottom">
                        <strong className="pre-scan-val-text">
                          {preScanExpiryDraft || <span className="placeholder">未設定期限 (保持空白)</span>}
                        </strong>
                      </div>
                    </div>

                    {preScanKeypadOpen ? (
                      <div className="pre-scan-keypad-container">
                        <LargeKeypad
                          value={preScanExpiryDraft}
                          maxLength={7}
                          extras="slash"
                          activeLabel="民國年月 (連打如 12512 自動補 /)"
                          onChange={(val) => setPreScanExpiryDraft(val)}
                          onClear={() => setPreScanExpiryDraft("")}
                        />
                      </div>
                    ) : (
                      <div className="pre-scan-hint">
                        💡 提示：免輸入斜線「/」，連打數字（如 12512 系統自動轉為 125/12）。同型式電表將自動套用；無特定期限可保持空白。
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="pre-scan-input-card">
                    <div className="pre-scan-input-row">
                      <span className="pre-scan-label">檢定期限</span>
                      <div className="input-with-clear-wrap">
                        <input
                          className="pre-scan-input"
                          inputMode="numeric"
                          placeholder="如 12512 (免打/自動補) 或 125/12"
                          value={preScanExpiryDraft}
                          onChange={(e) => setPreScanExpiryDraft(e.target.value)}
                        />
                        {preScanExpiryDraft ? (
                          <button
                            type="button"
                            className="input-inline-clear-btn"
                            title="清空"
                            onClick={() => setPreScanExpiryDraft("")}
                          >
                            <X size={15} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="pre-scan-hint">
                      💡 提示：免輸入斜線「/」，連打數字（如 12512 系統自動轉為 125/12）。同型式電表將自動套用；無特定期限可保持空白。
                    </div>
                  </div>
                )}

                <label className="pre-scan-checkbox-label">
                  <input
                    type="checkbox"
                    checked={skipPreScanExpiryCheck}
                    onChange={(e) => setSkipPreScanExpiryCheck(e.target.checked)}
                  />
                  <span>本次作業中不再重複提示</span>
                </label>
              </div>

              <div className="pre-scan-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setPreScanKeypadOpen(false);
                    setShowPreScanExpiryModal(false);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button highlight-btn"
                  onClick={() => {
                    const formatted = preScanExpiryDraft ? formatExpiryDate(preScanExpiryDraft) : "";
                    if (formatted !== data.defaultExpiryDate) {
                      updateData((current) => ({ ...current, defaultExpiryDate: formatted }));
                    }
                    setPreScanKeypadOpen(false);
                    setShowPreScanExpiryModal(false);
                    void startCamera();
                  }}
                >
                  確認並開始掃描
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {/* 現場掃描：快速設定自製大鍵盤抽屜 */}
        {quickKeypadField ? (
          <div className="completion-overlay" onClick={() => setQuickKeypadField(null)}>
            <section
              className="quick-keypad-sheet"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="quick-keypad-header">
                <div className="quick-keypad-title">
                  <SlidersHorizontal size={18} />
                  <span>
                    {quickKeypadField === "prefix"
                      ? "設定固定電號前綴"
                      : quickKeypadField === "expiryDate"
                      ? "設定預設檢定期限"
                      : "設定區處代碼"}
                  </span>
                </div>
                <button
                  type="button"
                  className="dialog-close-btn"
                  title="關閉"
                  onClick={() => setQuickKeypadField(null)}
                >
                  <X size={20} />
                </button>
              </div>

              <div className="quick-keypad-display-card">
                <div className="quick-keypad-card-top">
                  <span className="quick-keypad-display-label">
                    {quickKeypadField === "prefix"
                      ? "固定前綴"
                      : quickKeypadField === "expiryDate"
                      ? "檢定期限"
                      : "區處代碼"}
                  </span>
                  <button
                    type="button"
                    className={`quick-keypad-clear-pill-btn ${!quickKeypadDraft ? "disabled" : ""}`}
                    title="整欄清除"
                    disabled={!quickKeypadDraft}
                    onClick={() => {
                      vibrate(20);
                      setQuickKeypadDraft("");
                    }}
                  >
                    <X size={12} />
                    <span>整欄清除</span>
                  </button>
                </div>
                <div className="quick-keypad-card-bottom">
                  <strong className="quick-keypad-val-large">
                    {quickKeypadDraft || (
                      <span className="placeholder">
                        {quickKeypadField === "prefix"
                          ? "未設定前綴"
                          : quickKeypadField === "expiryDate"
                          ? "無特定期限 (保持空白)"
                          : "預設 10"}
                      </span>
                    )}
                  </strong>
                </div>
              </div>

              <div className="quick-keypad-hint">
                {quickKeypadField === "prefix"
                  ? "配對電表後若續掃電號貼紙或手動輸入，將自動預填此前綴（例如 40 或 10，最多 6 碼）。"
                  : quickKeypadField === "expiryDate"
                  ? "💡 提示：可免輸入斜線「/」，直接連打數字（例如 12512），系統會自動補 / 為 125/12。同型式電表將自動套用此期限。"
                  : "Excel 匯出時自動在 8 碼電號前補此 2 碼並計算第 11 碼檢查號。"}
              </div>

              <LargeKeypad
                value={quickKeypadDraft}
                maxLength={
                  quickKeypadField === "prefix" ? 6 : quickKeypadField === "expiryDate" ? 7 : 2
                }
                extras={quickKeypadField === "expiryDate" ? "slash" : undefined}
                activeLabel={
                  quickKeypadField === "prefix"
                    ? "前綴數字 (最多6碼)"
                    : quickKeypadField === "expiryDate"
                    ? "民國年月 (免輸入/ 連打如12512自動補/)"
                    : "區處2碼 (如 10)"
                }
                onChange={(val) => setQuickKeypadDraft(val)}
                onClear={() => setQuickKeypadDraft("")}
              />

              <div className="quick-keypad-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setQuickKeypadField(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button highlight-btn"
                  onClick={commitQuickKeypad}
                >
                  確定儲存
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {/* Android 原生掃描覆蓋層 */}
        {isNativeApp() && cameraActive ? (
          <div className="native-scan-overlay">
            <div className="native-scan-status">
              <div
                className={`status-banner ${status} ${isWaitingSticker ? "waiting-sticker" : ""} ${
                  isDuplicateAlert ? "duplicate-alert" : ""
                }`}
              >
                {isDuplicateAlert ? (
                  <AlertTriangle className="banner-alert-icon" size={18} />
                ) : isWaitingSticker ? (
                  <Tag className="banner-alert-icon" size={18} />
                ) : status === "done" ? (
                  <CheckCircle2 size={18} />
                ) : status === "duplicate" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <Loader2 className="spin" size={18} />
                )}
                <span>{message}</span>
              </div>

              {/* 手電筒補光開關與中途換表重置 */}
              <div className="native-scan-quick-tools">
                <button
                  type="button"
                  className={`torch-toggle-btn ${torchActive ? "active" : ""}`}
                  onClick={() => void toggleTorch()}
                >
                  {torchActive ? <Zap size={18} /> : <ZapOff size={18} />}
                  <span>{torchActive ? "補光燈：開" : "補光燈：關"}</span>
                </button>

                {targetMeter ? (
                  <button type="button" className="reset-meter-btn" onClick={resetTargetMeter}>
                    <RefreshCw size={15} /> 換表 / 重設 (目前:{targetMeter})
                  </button>
                ) : null}
              </div>
            </div>

            {isDuplicateAlert ? (
              <div className="camera-scan-hud duplicate-hud native-hud">
                <AlertTriangle size={15} className="hud-icon-pulse" />
                <span>此電表已完成{activeAlertMeter ? ` (${activeAlertMeter})` : ""}・請移下一台</span>
              </div>
            ) : isWaitingSticker ? (
              <div className="camera-scan-hud sticker-hud native-hud">
                <Tag size={15} className="hud-icon-pulse" />
                <span>已配對{activeAlertMeter ? ` (${activeAlertMeter})` : ""}・請掃電號標籤</span>
              </div>
            ) : justSavedMeter ? (
              <div className="camera-scan-hud success-hud native-hud">
                <CheckCircle2 size={15} className="hud-icon-pulse" />
                <span>表號 {justSavedMeter} 儲存成功・請移下一台</span>
              </div>
            ) : null}

            <div className="native-scan-target" aria-hidden="true" />

            <button className="secondary-button danger native-stop-button" type="button" onClick={stopCamera}>
              <Square size={18} />
              停止掃描
            </button>
          </div>
        ) : null}

        {/* 匯出選項彈窗 (分享至 Google 雲端硬碟 / 下載至本機) */}
        {exportTarget ? (
          <div className="completion-overlay" onClick={() => !isExporting && setExportTarget(null)}>
            <section
              className="export-dialog-card"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="export-dialog-header">
                <div>
                  <h3>
                    {exportTarget.type === "backup"
                      ? "匯出 JSON 備份檔"
                      : exportTarget.type === "all"
                      ? "匯出全部歷史報表 (Excel)"
                      : `匯出 ${exportTarget.date} 報表 (Excel)`}
                  </h3>
                  <span className="export-dialog-subtitle">請選擇儲存或分享方式</span>
                </div>
                <button
                  type="button"
                  className="dialog-close-btn"
                  title="關閉"
                  disabled={isExporting}
                  onClick={() => setExportTarget(null)}
                >
                  <X size={20} />
                </button>
              </div>

              {exportTarget.type === "date" && (() => {
                const recs = data.folders[exportTarget.date]?.records ?? [];
                const missing = incompleteCount(recs);
                return (
                  <div className="export-summary-box">
                    <div className="export-summary-row">
                      <span className="export-summary-label">匯出日期</span>
                      <span className="export-summary-val">{exportTarget.date}</span>
                    </div>
                    <div className="export-summary-row">
                      <span className="export-summary-label">總筆數</span>
                      <span className="export-summary-val">{recs.length} 筆（已填電號 {recs.length - missing} 筆）</span>
                    </div>
                    {missing > 0 ? (
                      <div className="export-summary-warning">
                        ⚠️ 尚有 <strong>{missing}</strong> 筆資料未填電號，仍可照常匯出
                      </div>
                    ) : null}
                  </div>
                );
              })()}

              {exportTarget.type === "all" && (() => {
                const total = totalAllRecordsCount;
                const missing = Object.values(data.folders).reduce(
                  (sum, folder) => sum + incompleteCount(folder.records),
                  0,
                );
                return (
                  <div className="export-summary-box">
                    <div className="export-summary-row">
                      <span className="export-summary-label">涵蓋日期</span>
                      <span className="export-summary-val">全部日期（共 {folderDates.length} 個工作日）</span>
                    </div>
                    <div className="export-summary-row">
                      <span className="export-summary-label">總筆數</span>
                      <span className="export-summary-val">{total} 筆（已填電號 {total - missing} 筆）</span>
                    </div>
                    {missing > 0 ? (
                      <div className="export-summary-warning">
                        ⚠️ 全部日期中共有 <strong>{missing}</strong> 筆未填電號，仍可照常匯出
                      </div>
                    ) : null}
                  </div>
                );
              })()}

              {exportTarget.type === "backup" && (
                <div className="export-summary-box">
                  <div className="export-summary-row">
                    <span className="export-summary-label">備份項目</span>
                    <span className="export-summary-val">完整系統資料庫（含所有日期電表與偏好設定）</span>
                  </div>
                  <div className="export-summary-row">
                    <span className="export-summary-label">總筆數</span>
                    <span className="export-summary-val">{totalAllRecordsCount} 筆電表資料</span>
                  </div>
                </div>
              )}

              {/* 即時上傳 / 下載進度條 */}
              {driveProgress ? (
                <div className="drive-progress-container">
                  <div className="drive-progress-head">
                    <span>{driveProgress.text}</span>
                    <span>{driveProgress.percent}%</span>
                  </div>
                  <div className="drive-progress-bar">
                    <div
                      className="drive-progress-fill"
                      style={{ width: `${driveProgress.percent}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="export-actions-list">
                {/* 1. 儲存至 Google 雲端硬碟 */}
                <button
                  type="button"
                  className="export-option-btn cloud-drive"
                  disabled={isExporting}
                  onClick={() => void executeExport(exportTarget, "drive")}
                >
                  <div className="export-option-icon drive-icon">
                    {isExporting ? <Loader2 size={24} className="spin" /> : <CloudUpload size={24} />}
                  </div>
                  <div className="export-option-info">
                    <div className="export-option-title-row">
                      <span className="export-option-title">儲存至 Google 雲端硬碟 (Drive)</span>
                      <span className="export-option-badge" style={{ background: "#0284c7" }}>雲端直存</span>
                    </div>
                    <span className="export-option-desc">
                      登入個人 Google 帳號，直接將檔案上傳至 Google 雲端硬碟，免佔手機容量
                    </span>
                  </div>
                </button>

                {/* 2. 直接下載至本機 */}
                <button
                  type="button"
                  className="export-option-btn secondary-download"
                  disabled={isExporting}
                  onClick={() => void executeExport(exportTarget, "download")}
                >
                  <div className="export-option-icon download-icon">
                    <Download size={24} />
                  </div>
                  <div className="export-option-info">
                    <div className="export-option-title-row">
                      <span className="export-option-title">
                        {exportTarget.type === "backup" ? "直接下載備份檔 (.json)" : "直接下載 Excel 檔 (.xlsx)"}
                      </span>
                      <span className="export-option-badge" style={{ background: "#64748b" }}>本地下載</span>
                    </div>
                    <span className="export-option-desc">
                      直接將檔案儲存至手機或電腦「下載」資料夾，隨時可用
                    </span>
                  </div>
                </button>

                {/* 3. 本機與雲端都要 */}
                <button
                  type="button"
                  className="export-option-btn both-option"
                  disabled={isExporting}
                  onClick={() => void executeExport(exportTarget, "both")}
                >
                  <div className="export-option-icon both-icon">
                    <HardDrive size={24} />
                  </div>
                  <div className="export-option-info">
                    <div className="export-option-title-row">
                      <span className="export-option-title">本機與雲端都要 (雙重保存)</span>
                      <span className="export-option-badge" style={{ background: "#ca8a04" }}>雙重保險</span>
                    </div>
                    <span className="export-option-desc">
                      下載檔案至手機本機，同時自動上傳備份至個人的 Google 雲端硬碟
                    </span>
                  </div>
                </button>

                {/* 4. 手機系統原生分享 */}
                <button
                  type="button"
                  className="export-option-btn system-share"
                  disabled={isExporting}
                  onClick={() => void executeExport(exportTarget, "share")}
                >
                  <div className="export-option-icon system-icon">
                    <Share2 size={24} />
                  </div>
                  <div className="export-option-info">
                    <div className="export-option-title-row">
                      <span className="export-option-title">手機系統原生分享</span>
                      <span className="export-option-badge" style={{ background: "#475569" }}>
                        {isShareSupported ? "手機支援" : "LINE / 郵件"}
                      </span>
                    </div>
                    <span className="export-option-desc">
                      呼叫手機系統原生分享選單，可將報表直接傳送至 LINE 好友、Gmail 或其他通訊軟體
                    </span>
                  </div>
                </button>
              </div>

              <div className="export-dialog-footer">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={isExporting}
                  onClick={() => setExportTarget(null)}
                >
                  取消
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {/* Google 雲端硬碟備份還原與刪除彈窗 */}
        {driveModal ? (
          <div className="completion-overlay" onClick={() => !isDriveBusy && setDriveModal(null)}>
            <section
              className="export-dialog-card"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="export-dialog-header">
                <div className="export-dialog-title-group">
                  <h3>
                    {driveModal.type === "restore"
                      ? "☁️ 選擇 Google 雲端備份並還原"
                      : "🗑 刪除 Google 雲端硬碟備份"}
                  </h3>
                  <span className="export-dialog-subtitle">
                    {driveModal.type === "restore"
                      ? "請選取要從雲端下載並還原的備份檔案："
                      : "請勾選要自雲端硬碟刪除的備份檔案（可多選）："}
                  </span>
                </div>
                <button
                  type="button"
                  className="dialog-close-btn"
                  title="關閉"
                  disabled={isDriveBusy}
                  onClick={() => setDriveModal(null)}
                >
                  <X size={20} />
                </button>
              </div>

              <div className="drive-dialog-toolbar">
                <span className="drive-toolbar-hint">
                  {driveModal.files.length > 0
                    ? `共 ${driveModal.files.length} 個備份檔案`
                    : "已連線至 Google 雲端硬碟"}
                </span>
                <div className="drive-toolbar-buttons">
                  <button
                    type="button"
                    className="drive-toolbar-btn"
                    title="強制重新整理雲端檔案清單"
                    disabled={isDriveBusy}
                    onClick={() => void handleRefreshDriveList()}
                  >
                    <RefreshCw size={13} className={isDriveBusy ? "spin" : ""} />
                    <span>重新整理</span>
                  </button>
                  <button
                    type="button"
                    className="drive-toolbar-btn"
                    title="更換其他 Google 帳號"
                    disabled={isDriveBusy}
                    onClick={() => void handleSwitchDriveAccount()}
                  >
                    <User size={13} />
                    <span>切換帳號</span>
                  </button>
                </div>
              </div>

              {driveProgress ? (
                <div className="drive-progress-container">
                  <div className="drive-progress-head">
                    <span>{driveProgress.text}</span>
                    <span>{driveProgress.percent}%</span>
                  </div>
                  <div className="drive-progress-bar">
                    <div
                      className="drive-progress-fill"
                      style={{ width: `${driveProgress.percent}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="drive-file-list">
                {driveModal.files.length === 0 ? (
                  <div className="drive-empty-notice">
                    <p>目前在此 Google 帳號中找不到電表備份檔案。</p>
                    <div className="drive-empty-actions">
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={isDriveBusy}
                        onClick={() => void handleRefreshDriveList()}
                      >
                        <RefreshCw size={14} className={isDriveBusy ? "spin" : ""} />
                        <span>重新整理</span>
                      </button>
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={isDriveBusy}
                        onClick={() => void handleSwitchDriveAccount()}
                      >
                        切換其他 Google 帳號
                      </button>
                    </div>
                  </div>
                ) : (
                  driveModal.files.map((file) => {
                    const isChecked = driveModal.selectedIds.includes(file.id);
                    return (
                      <label key={file.id} className="drive-file-item">
                        <input
                          type={driveModal.type === "restore" ? "radio" : "checkbox"}
                          name="driveBackupItem"
                          className="drive-file-radio"
                          checked={isChecked}
                          onChange={() => {
                            if (driveModal.type === "restore") {
                              setDriveModal({ ...driveModal, selectedIds: [file.id] });
                            } else {
                              const next = isChecked
                                ? driveModal.selectedIds.filter((id) => id !== file.id)
                                : [...driveModal.selectedIds, file.id];
                              setDriveModal({ ...driveModal, selectedIds: next });
                            }
                          }}
                        />
                        <div className="drive-file-details">
                          <span className="drive-file-name">{file.name}</span>
                          <span className="drive-file-meta">
                            {file.createdTime ? new Date(file.createdTime).toLocaleString("zh-TW") : ""}
                            {file.size ? ` · ${(file.size / 1024).toFixed(1)} KB` : ""}
                          </span>
                          {file.description ? (
                            <span className="drive-file-desc">📋 {file.description}</span>
                          ) : null}
                        </div>
                      </label>
                    );
                  })
                )}
              </div>

              <div className="export-dialog-footer" style={{ gap: "10px" }}>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={isDriveBusy}
                  onClick={() => setDriveModal(null)}
                >
                  取消
                </button>
                {driveModal.type === "restore" ? (
                  <button
                    type="button"
                    className="primary-button"
                    style={{ background: "#0284c7" }}
                    disabled={isDriveBusy || !driveModal.selectedIds.length}
                    onClick={() => void confirmDriveRestore()}
                  >
                    {isDriveBusy ? <Loader2 size={16} className="spin" /> : <CloudDownload size={16} />} 下載並還原
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-button"
                    style={{ background: "#dc2626" }}
                    disabled={isDriveBusy || !driveModal.selectedIds.length}
                    onClick={() => void confirmDriveDelete()}
                  >
                    {isDriveBusy ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />} 確定刪除所選
                  </button>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {/* 全域反饋提示彈窗 (NoticeModal) */}
        {noticeModal ? (
          <div className="completion-overlay" onClick={() => setNoticeModal(null)}>
            <section
              className="notice-modal-card"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="notice-modal-header">
                <div className={`notice-modal-icon-badge ${noticeModal.type ?? "info"}`}>
                  {noticeModal.type === "success" ? (
                    <CheckCircle2 size={24} />
                  ) : noticeModal.type === "error" ? (
                    <XCircle size={24} />
                  ) : noticeModal.type === "warning" ? (
                    <AlertTriangle size={24} />
                  ) : (
                    <Info size={24} />
                  )}
                </div>
                <h3 className="notice-modal-title">{noticeModal.title}</h3>
              </div>

              <div className="notice-modal-body">{noticeModal.message}</div>

              {noticeModal.details && noticeModal.details.length > 0 ? (
                <div className="notice-modal-details">
                  {noticeModal.details.map((d, idx) => (
                    <div key={idx} className="notice-modal-detail-row">
                      <span className="notice-modal-detail-label">{d.label}</span>
                      <span className="notice-modal-detail-val">{d.value}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {noticeModal.actions && noticeModal.actions.length > 0 ? (
                <div className="notice-modal-actions">
                  {noticeModal.actions.map((act, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`notice-modal-action-btn ${act.styleClass ?? (act.primary ? "primary" : "secondary")}`}
                      onClick={() => {
                        act.onClick();
                      }}
                    >
                      {act.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="notice-modal-footer">
                <button
                  type="button"
                  className="notice-modal-btn"
                  onClick={() => {
                    const action = noticeModal.onConfirm;
                    setNoticeModal(null);
                    if (action) action();
                  }}
                >
                  {noticeModal.confirmText ?? "我知道了"}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function emptyRecord(): MeterRecord {
  return {
    serviceNumber: "",
    model: "",
    meterNumber: "",
    manufactureDate: "",
    inspectionNumber: "",
    expiryDate: "",
  };
}

function today(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// 原生掃描呼叫加逾時：某些機種 stopScan/startScan 會 hang 住不回，
// 不能讓整個掃描線程陪它卡死（逾時後放行，狀態由訊息告知使用者重試）。
function withNativeTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = window.setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }) as Promise<T | undefined>;
}

// Web：優先選後鏡頭（ZXing 只吃 deviceId；首次未授權時 label 為空則退回最後一顆鏡頭）
async function pickRearCameraDeviceId(): Promise<string | undefined> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter((device) => device.kind === "videoinput");
    if (!videos.length) {
      return undefined;
    }
    const rear = videos.find((device) => /back|rear|environment|後置|主鏡/i.test(device.label));
    return (rear ?? videos[videos.length - 1]).deviceId || undefined;
  } catch {
    return undefined;
  }
}

// Web：ZXing 的 controls.stop() 在部分瀏覽器不會釋放硬體，顯式停止所有 track
function stopVideoTracks(video: HTMLVideoElement | null): void {
  try {
    const stream = (video?.srcObject ?? null) as MediaStream | null;
    stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // 忽略個別 track 停止失敗
      }
    });
    if (video) {
      video.srcObject = null;
    }
  } catch {
    // 忽略釋放失敗
  }
}