// @vitest-environment happy-dom
// 實機重演測試：跑真正的 <App/>（原生掃描 mock），用 field-test 原圖解出的真字串，
// 把現場回報的兩個 bug 原樣重演：
//   Bug1：存檔繼續掃後亂入別張 MS，不能問覆蓋，只能回「請先掃描電表QRcode」
//   Bug2：存檔繼續掃後同表重掃，不能卡死，換下一顆表不能要求人工重設
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const FIELD = {
  RT_NP: "AMC;RT-120;24196744;114/07",
  RT_INSP: "L0LH14D41096;24196744",
  GV_NP: "CHEM;GV-CGM;23041742;113/12",
  GV_INSP: "L0LH14305543;23041742",
  MS02: "MS:56965402",
  MS04: "MS:56965404",
};

type Barcode = { rawValue?: string; displayValue?: string };

const scanMock = vi.hoisted(() => ({
  listener: null as null | ((event: { barcodes: Barcode[] }) => void),
  startCalls: 0,
  singleQueue: [] as string[][],
  hangStop: false,
  reset() {
    this.listener = null;
    this.startCalls = 0;
    this.singleQueue = [];
    this.hangStop = false;
  },
}));

vi.mock("@capacitor-mlkit/barcode-scanning", () => ({
  BarcodeFormat: { QrCode: "QR_CODE" },
  BarcodeScanner: {
    checkPermissions: async () => ({ camera: "granted" }),
    requestPermissions: async () => ({ camera: "granted" }),
    isSupported: async () => ({ supported: true }),
    isGoogleBarcodeScannerModuleAvailable: async () => ({ available: true }),
    installGoogleBarcodeScannerModule: async () => undefined,
    startScan: async () => {
      scanMock.startCalls += 1;
    },
    stopScan: async () => {
      if (scanMock.hangStop) {
        await new Promise(() => {});
      }
    },
    toggleTorch: async () => undefined,
    isTorchEnabled: async () => ({ enabled: false }),
    disableTorch: async () => undefined,
    addListener: async (_event: string, fn: (event: { barcodes: Barcode[] }) => void) => {
      scanMock.listener = fn;
      return {
        remove: async () => {
          if (scanMock.listener === fn) {
            scanMock.listener = null;
          }
        },
      };
    },
    scan: async () => {
      const next = scanMock.singleQueue.shift() ?? [];
      return { barcodes: next.map((rawValue) => ({ rawValue, displayValue: rawValue })) };
    },
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

if (typeof window.confirm !== "function") {
  (window as unknown as { confirm: (message?: string) => boolean }).confirm = () => true;
}
const confirmSpy = vi.spyOn(window, "confirm");

function bannerText(): string {
  return document.querySelector(".scan-tab-view .status-banner span")?.textContent ?? "";
}

async function expectBanner(text: string) {
  await waitFor(() => expect(bannerText()).toContain(text), { timeout: 8000 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 注意：App 的 native listener 包了一層 void（不回傳 promise），
// 這裡不能 await，只能等 handler 跑完（mock 的原生呼叫都是即時 resolve）。
// 先等有結果（banner/抽屜變化）再下一步，跟真人看畫面操作一樣。
async function emit(texts: string[]) {
  await waitFor(() => expect(scanMock.listener).not.toBeNull(), { timeout: 8000 });
  scanMock.listener!({ barcodes: texts.map((rawValue) => ({ rawValue })) });
  await sleep(300);
}

// 像真實相機一樣重送：單幀可能在忙碌時被丟棄（debounce），
// 重送直到畫面出現預期結果；_merge 本身是冪等的，重送安全
async function emitUntil(texts: string[], banner: string, tries = 5) {
  for (let attempt = 1; ; attempt += 1) {
    await emit(texts);
    try {
      await waitFor(() => expect(bannerText()).toContain(banner), { timeout: 1500 });
      return;
    } catch {
      if (attempt >= tries) {
        throw new Error(`重送 ${tries} 次仍未出現「${banner}」，最後畫面：「${bannerText()}」`);
      }
    }
  }
}

function gotoTab(name: string) {
  fireEvent.click(screen.getByText(name));
}

async function pressStartContinuous() {
  fireEvent.click(screen.getByText("開始連續掃描"));
  fireEvent.click(await screen.findByText("確認並開始掃描", {}, { timeout: 8000 }));
  await waitFor(() => expect(scanMock.listener).not.toBeNull(), { timeout: 8000 });
  // 等相機真正就緒（重啟延遲 650ms 等）：真人按下後也要瞄準，不會 0ms 開掃
  await sleep(900);
}

async function bootContinuous() {
  cleanup();
  await sleep(100);
  vi.resetModules();
  scanMock.reset();
  confirmSpy.mockClear();
  confirmSpy.mockReturnValue(true);
  localStorage.clear();
  const { resetStorageCacheForTests } = await import("./storage");
  resetStorageCacheForTests();
  const { App } = await import("./App");
  render(<App />);
  // 切連續掃描（預設單次）
  fireEvent.click(screen.getByLabelText("單次掃描 (讀完即停)"));
  // 電號標籤掃描預設必須是開的
  expect((screen.getByLabelText("電號標籤掃描") as HTMLInputElement).checked).toBe(true);
  await pressStartContinuous();
}

async function saveAndContinue() {
  fireEvent.click(screen.getByText("儲存並繼續掃描"));
  await waitFor(() => expect(screen.queryByText("輸入電號")).toBeNull(), { timeout: 8000 });
}

beforeEach(() => {
  confirmSpy.mockClear();
  confirmSpy.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe("連續＋標籤開：正常三張流程", () => {
  it("2表QR→等貼紙提示→MS預填→存檔，抽屜顯示純8碼 56965402", async () => {
    await bootContinuous();
    await emitUntil([FIELD.RT_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.RT_INSP], "配對成功，請掃電號貼紙");
    await emit([FIELD.MS02]);
    await screen.findByText("56965402", {}, { timeout: 8000 });
    expect(confirmSpy).not.toHaveBeenCalled();
    await saveAndContinue();
    gotoTab("電表清單");
    await screen.findByText("56-9654-02", {}, { timeout: 8000 });
  }, 60000);
});

describe("Bug1：存檔繼續掃後亂入別張MS", () => {
  it("不問覆蓋，只回請先掃描電表QRcode", async () => {
    await bootContinuous();
    await emitUntil([FIELD.RT_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.RT_INSP], "配對成功，請掃電號貼紙");
    await emit([FIELD.MS02]);
    await screen.findByText("56965402", {}, { timeout: 8000 });
    await saveAndContinue();
    gotoTab("電表清單");
    await screen.findByText("56-9654-02", {}, { timeout: 8000 });
    gotoTab("現場掃描");
    // 鏡頭還照著舊表＋亂入別張貼紙（同框）：舊表只提示已完成，不建鎖定
    await emit([FIELD.RT_NP, FIELD.MS04]);
    await expectBanner("這台電表已完成");
    // 再單張亂入：無歸屬，只能回請先掃描
    await emit([FIELD.MS04]);
    await expectBanner("請先掃描電表QRcode");
    expect(confirmSpy).not.toHaveBeenCalled();
  }, 120000);
});

describe("Bug2：存檔繼續掃後同表重掃＋換下一顆", () => {
  it("同表顯示已完成，下一顆直接鎖定，不用人工重設", async () => {
    await bootContinuous();
    await emitUntil([FIELD.RT_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.RT_INSP], "配對成功，請掃電號貼紙");
    await emit([FIELD.MS02]);
    await screen.findByText("56965402", {}, { timeout: 8000 });
    await saveAndContinue();
    // 同表重掃：提示已完成（沒有按換表也能繼續）
    await emit([FIELD.RT_NP]);
    await expectBanner("這台電表已完成");
    // 直接掃下一顆：免重設，直接 1/2
    await emitUntil([FIELD.GV_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.GV_INSP], "配對成功，請掃電號貼紙");
  }, 120000);
});

describe("原生hang住：抽屜照開、線程不死", () => {
  it("stopScan hang 時 MS 照樣開抽屜，之後掃描不受影響", async () => {
    await bootContinuous();
    await emitUntil([FIELD.RT_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.RT_INSP], "配對成功，請掃電號貼紙");
    scanMock.hangStop = true;
    await emit([FIELD.MS02]);
    // 停相機卡住，抽屜還是要開（先開抽屜再停相機）
    await screen.findByText("56965402", {}, { timeout: 8000 });
    scanMock.hangStop = false;
    await saveAndContinue();
    // 存檔事實改看清單（存檔後的 banner 會被重啟訊息蓋掉，本來就是暫態）
    gotoTab("電表清單");
    await screen.findByText("56-9654-02", {}, { timeout: 8000 });
    gotoTab("現場掃描");
    // 線程沒死：下一顆照掃
    await emitUntil([FIELD.GV_NP], "1 / 2 缺檢驗號碼");
    expect(confirmSpy).not.toHaveBeenCalled();
  }, 120000);
});

describe("無貼紙表：停止改手輸", () => {
  it("等貼紙時按停止，彈空抽屜，大鍵盤可手輸儲存", async () => {
    await bootContinuous();
    await emitUntil([FIELD.GV_NP], "23041742");
    await emitUntil([FIELD.GV_INSP], "配對成功，請掃電號貼紙");
    fireEvent.click(document.querySelector(".hero-scan-btn.danger")!);
    await screen.findByText("輸入電號", {}, { timeout: 8000 });
    await screen.findByText("點擊下方數字鍵盤輸入 (固定 8 碼)", {}, { timeout: 8000 });
    for (const digit of ["4", "0", "7", "0", "1", "1", "3", "9"]) {
      fireEvent.click(screen.getByText(digit, { selector: ".keypad-num-btn" }));
    }
    await screen.findByText("40701139", {}, { timeout: 8000 });
    fireEvent.click(screen.getByText("儲存並結束"));
    await expectBanner("電表 23041742 已完成儲存");
  }, 90000);
});

describe("Bug3：等貼紙時誤掃新電表不能被取代", () => {
  it("等貼紙時誤掃新電表，維持鎖定原表，掃到貼紙仍正確歸屬原表", async () => {
    await bootContinuous();
    // 1. RT-120 配對雙 QR 完成，進入等貼紙狀態
    await emitUntil([FIELD.RT_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.RT_INSP], "配對成功，請掃電號貼紙");

    // 2. 鏡頭誤掃到隔壁新電表 GV-CGM 的 QR
    await emit([FIELD.GV_NP]);
    // 嚴禁被 GV 取代！畫面必須維持提示 RT 等貼紙
    await expectBanner("已配對表號24196744，請掃電號貼紙");

    // 3. 正確照到 RT 的貼紙 MS02
    await emit([FIELD.MS02]);
    // 貼紙必須正確綁定到 RT (24196744) 彈出抽屜
    await screen.findByText("56965402", {}, { timeout: 8000 });
    expect((await screen.findAllByText("24196744")).length).toBeGreaterThan(0);
    expect(confirmSpy).not.toHaveBeenCalled();
    await saveAndContinue();

    // 4. 存檔後鏡頭移到 GV-CGM，此時才自動換表鎖定 GV
    await emitUntil([FIELD.GV_NP], "1 / 2 缺檢驗號碼");
    await emitUntil([FIELD.GV_INSP], "配對成功，請掃電號貼紙");
  }, 120000);
});

