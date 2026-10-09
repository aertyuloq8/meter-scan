/**
 * 格式化電號顯示
 * 8 碼：XX-XXXX-XX（如 40-4406-50）
 * 10 碼：XX-XX-XXXX-XX（如 10-40-4406-50）
 * 11 碼：XX-XX-XXXX-XX-X（如 10-40-4406-50-1）
 */
export function formatServiceNumber(digits: string): string {
  const clean = digits.replace(/\D/g, "");
  // 11 碼擴展格式：10-40-4406-50-1 (區號2-營業區2-戶號4-分號2-檢算號1)
  if (clean.length === 11) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 10)}-${clean.slice(10, 11)}`;
  }
  // 10 碼標準格式：10-40-4406-50 (2-2-4-2)
  if (clean.length === 10) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 10)}`;
  }
  // 8 碼標準格式：40-4406-50 (2-4-2)
  if (clean.length === 8) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 6)}-${clean.slice(6, 8)}`;
  }
  // 9 碼打字途中 (10 碼進行中)：10-40-4406-5
  if (clean.length === 9) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 8)}-${clean.slice(8)}`;
  }
  // 7 碼打字途中 (8 碼進行中)：40-4406-5
  if (clean.length === 7) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 6)}-${clean.slice(6)}`;
  }
  // 6 碼打字途中：40-4406
  if (clean.length === 6) {
    return `${clean.slice(0, 2)}-${clean.slice(2, 6)}`;
  }
  if (clean.length > 2) {
    return `${clean.slice(0, 2)}-${clean.slice(2)}`;
  }
  return clean;
}

/**
 * 計算用戶電號檢算號（輸入 10 碼純數字：區號2 + 營業區2 + 戶號4 + 分號2）
 * 演算法規範來自《檢算碼原理》：
 * 奇數位（第 1, 3, 5, 7, 9 位）乘以 2，乘積若達二位數則十位數與個位數相加；
 * 偶數位（第 2, 4, 6, 8, 10 位）乘以 1；
 * 加總後取個位數作為檢算號。
 */
export function calculateCheckDigit(digits10: string): number {
  const clean = digits10.replace(/\D/g, "");
  if (clean.length !== 10) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const n = Number(clean[i]);
    if (i % 2 === 0) {
      const prod = n * 2;
      sum += prod >= 10 ? Math.floor(prod / 10) + (prod % 10) : prod;
    } else {
      sum += n;
    }
  }
  return sum % 10;
}

/**
 * 將電號正規化為 8 碼（若來源為 10 碼或 11 碼，自動剝除前置區號與末位檢算碼）
 */
export function normalizeServiceNumberTo8Digits(input: string): string {
  const clean = input.replace(/\D/g, "");
  if (clean.length === 11) {
    // 11 碼：區號2 + 營業戶號分號8 + 檢算碼1 -> 取中間 8 碼
    return clean.slice(2, 10);
  }
  if (clean.length === 10) {
    // 10 碼：區號2 + 營業戶號分號8 -> 取後 8 碼
    return clean.slice(2, 10);
  }
  if (clean.length === 8) {
    return clean;
  }
  return clean.slice(0, 8);
}

/**
 * 補上前置區號（預設 "10" 台南）並計算檢算碼，產生完整 11 碼純數字電號
 */
export function toFullServiceNumber11(serviceNumber: string, districtCode = "10"): string {
  const clean = serviceNumber.replace(/\D/g, "");
  if (!clean) return "";
  const district = (districtCode || "10").replace(/\D/g, "").slice(0, 2) || "10";
  let tenDigits = "";
  if (clean.length === 8) {
    tenDigits = `${district}${clean}`;
  } else if (clean.length === 10) {
    tenDigits = clean;
  } else if (clean.length === 11) {
    return clean;
  } else {
    tenDigits = `${district}${clean.padStart(8, "0").slice(0, 8)}`;
  }
  const checkDigit = calculateCheckDigit(tenDigits);
  return `${tenDigits}${checkDigit}`;
}

/**
 * 格式化為完整 11 碼電號字串（如 10-40-4406-50-1）供 Excel 匯出呈現
 */
export function formatFullServiceNumber11(serviceNumber: string, districtCode = "10"): string {
  const full11 = toFullServiceNumber11(serviceNumber, districtCode);
  if (!full11) return "";
  return formatServiceNumber(full11);
}

/**
 * 格式化檢定期限顯示（民國年月簡式，如 12512 -> 125/12）
 * 支援 5 碼（如 12512）、6 碼（如 203612）、手動帶斜線（如 125/12, 125/6 -> 125/06）
 */
export function formatExpiryDate(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  // 若使用者已手動輸入斜線或連字號
  if (trimmed.includes("/") || trimmed.includes("-") || trimmed.includes(".")) {
    const parts = trimmed.split(/[/.-]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const year = parts[0].replace(/\D/g, "");
      const monthRaw = parts[1].replace(/\D/g, "");
      const month = monthRaw.length === 1 ? `0${monthRaw}` : monthRaw.slice(0, 2);
      return `${year}/${month}`;
    }
  }

  const clean = trimmed.replace(/\D/g, "");
  // 西元年 6 碼（如 203612 -> 2036/12）
  if (clean.length === 6 && (clean.startsWith("20") || clean.startsWith("19"))) {
    return `${clean.slice(0, 4)}/${clean.slice(4, 6)}`;
  }
  // 民國年 5 碼（如 12512 -> 125/12）
  if (clean.length === 5) {
    return `${clean.slice(0, 3)}/${clean.slice(3, 5)}`;
  }
  // 輸入中：4 碼（如 1251 -> 125/1）
  if (clean.length === 4 && clean.startsWith("1")) {
    return `${clean.slice(0, 3)}/${clean.slice(3, 4)}`;
  }
  // 輸入中：超過 5 碼則取前 5 碼
  if (clean.length > 5) {
    return `${clean.slice(0, 3)}/${clean.slice(3, 5)}`;
  }

  return clean;
}
