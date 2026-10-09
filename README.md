# 台電電表資料掃描系統 (Meter Scan PWA)

台電現場作業專用的高效電表 QRCode 雙碼自動比對、電號貼紙掃描與 Excel 匯出網頁應用程式 (PWA)。

---

## 🌟 核心特色

1. **極致 QR Code 辨識引擎**：
   - **硬體加速 ML Kit (Shape Detection API)**：在 Android Chrome / Edge 等現代行動瀏覽器上自動啟動 GPU/DSP 硬體加速，幀率高達 60 FPS。
   - **單幀雙碼並行比對**：鏡頭同時涵蓋電表 1/2 與 2/2 雙 QR 時，一幀即可直接完成配對，無延遲、零頓挫。
   - **相機光學約束優化**：自動啟用連續自動對焦（Continuous Auto-Focus）、高解析度（1080p）採樣與手電筒（Torch）補光控制。
   - **智慧 Fallback 機制**：Safari、Firefox 或不支援 BarcodeDetector 的環境自動切換至高精度 ZXing 引擎。

2. **100% 離線運作 (PWA Progressive Web App)**：
   - 內建 Service Worker 與 Web Manifest，支援「加入主畫面」全螢幕安裝。
   - 地下室、偏遠山區、配電室等無訊號環境下仍可完整讀取、記錄與儲存。
   - 資料庫採用瀏覽器端 IndexedDB 本地儲存，資料安全不上傳外部雲端。

3. **台電電號 11 碼檢算機制**：
   - 預設區號（如台南區處預設 `10`，可於設定隨時切換）。
   - 現場掃描或手動輸入僅需 8 碼（配合固定前綴僅需 2 碼）。
   - Excel 匯出自動補齊區號並即時計算模數十（加權數 3131313131）檢算碼，匯出標準 11 碼完整電號。

4. **防呆與智慧流程**：
   - 表號鎖定與自動遞進（Auto-advance）切換。
   - 等待電號貼紙保護機制：未貼貼紙前防止被誤掃的新表覆蓋。
   - 支援 Excel 匯出、統計報表與 JSON 完整備份還原。

---

## 🚀 部署與使用

### 線上體驗 (GitHub Pages)
直接開啟手機瀏覽器訪問：
`https://aertyuloq8.github.io/meter-scan/`

> **提示**：在手機 Chrome 或 Safari 點選瀏覽器選單中的 **「加到主畫面」**，即可像原生 App 一樣全螢幕流暢使用！

### 開發與本地建置
```bash
# 安裝相依套件
npm install

# 啟動本地開發伺服器
npm run dev

# 執行測試套件
npm run test

# 生產環境建置
npm run build
```
