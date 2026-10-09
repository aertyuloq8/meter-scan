import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), ...(mode === "https" ? [basicSsl()] : [])],
  server: {
    host: "0.0.0.0",
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          const p = id.replace(/\\/g, "/");
          // xlsx 及其附帶依賴（cfb/ssf/crc-32/codepage 等）合併為單塊，避免散落主包
          if (/\/node_modules\/(xlsx|cfb|ssf|crc-32|codepage|frac|adler-32|word|wmf)\//.test(p)) {
            return "xlsx";
          }
          if (p.includes("/node_modules/@zxing/")) {
            return "zxing";
          }
          if (p.includes("/node_modules/@capacitor/") || p.includes("/node_modules/@capacitor-mlkit/")) {
            return "capacitor";
          }
          if (p.includes("/node_modules/lucide-react/")) {
            return "lucide";
          }
          // 精確匹配 react 本體，避免把 lucide-react 等含 "react" 字串的套件誤吸入
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(p)) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
}));
