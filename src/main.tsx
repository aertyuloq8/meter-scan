import React from "react";
import ReactDOM from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Web 模式（瀏覽器 / PWA）自動註冊 Service Worker 提供完整離線與快顯能力
if (typeof window !== "undefined" && !Capacitor.isNativePlatform() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        // 定期或背景檢查是否有新版本
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn("Service Worker 註冊失敗：", err);
      });
  });
}
