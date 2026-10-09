import { describe, expect, it } from "vitest";
import {
  calculateCheckDigit,
  formatExpiryDate,
  formatFullServiceNumber11,
  formatServiceNumber,
  normalizeServiceNumberTo8Digits,
  toFullServiceNumber11,
} from "./ocr";

describe("formatServiceNumber", () => {
  it("formats 8 digits into XX-XXXX-XX (40-4406-50)", () => {
    expect(formatServiceNumber("40440650")).toBe("40-4406-50");
  });

  it("formats 10 digits into XX-XX-XXXX-XX (10-40-4406-50)", () => {
    expect(formatServiceNumber("1040440650")).toBe("10-40-4406-50");
  });

  it("formats 11 digits into XX-XX-XXXX-XX-X", () => {
    expect(formatServiceNumber("10404406501")).toBe("10-40-4406-50-1");
  });

  it("formats partial digits with hyphens", () => {
    expect(formatServiceNumber("404406")).toBe("40-4406");
    expect(formatServiceNumber("4044065")).toBe("40-4406-5");
    expect(formatServiceNumber("104044065")).toBe("10-40-4406-5");
    expect(formatServiceNumber("401")).toBe("40-1");
  });
});

describe("formatExpiryDate", () => {
  it("formats 5 digits into Republic of China year/month (e.g. 12512 -> 125/12)", () => {
    expect(formatExpiryDate("12512")).toBe("125/12");
    expect(formatExpiryDate("12206")).toBe("122/06");
  });

  it("handles inputs with slashes or dashes", () => {
    expect(formatExpiryDate("125/12")).toBe("125/12");
    expect(formatExpiryDate("125-12")).toBe("125/12");
    expect(formatExpiryDate("125/6")).toBe("125/06");
  });

  it("formats partial input gracefully during typing", () => {
    expect(formatExpiryDate("125")).toBe("125");
    expect(formatExpiryDate("1251")).toBe("125/1");
  });

  it("handles 6 digits western year", () => {
    expect(formatExpiryDate("203612")).toBe("2036/12");
  });

  it("handles empty or blank string", () => {
    expect(formatExpiryDate("")).toBe("");
    expect(formatExpiryDate("   ")).toBe("");
  });
});

describe("calculateCheckDigit (《檢算碼原理》規範)", () => {
  it("calculates correct check digit for PDF official sample 1119438110 -> 5", () => {
    expect(calculateCheckDigit("1119438110")).toBe(5);
  });

  it("calculates correct check digit for 10-40-4406-50 (1040440650) -> 9", () => {
    expect(calculateCheckDigit("1040440650")).toBe(9);
  });

  it("calculates correct check digit for 10-56-9654-02 (1056965402) -> 1", () => {
    expect(calculateCheckDigit("1056965402")).toBe(1);
  });
});

describe("normalizeServiceNumberTo8Digits", () => {
  it("keeps 8 digits unchanged", () => {
    expect(normalizeServiceNumberTo8Digits("40440650")).toBe("40440650");
  });

  it("strips district code from 10 digits to get 8 digits", () => {
    expect(normalizeServiceNumberTo8Digits("1040440650")).toBe("40440650");
  });

  it("strips district code and check digit from 11 digits to get 8 digits", () => {
    expect(normalizeServiceNumberTo8Digits("10404406509")).toBe("40440650");
    expect(normalizeServiceNumberTo8Digits("10-40-4406-50-9")).toBe("40440650");
  });
});

describe("toFullServiceNumber11 and formatFullServiceNumber11", () => {
  it("generates full 11 digits and formatted string with default district 10 (台南)", () => {
    expect(toFullServiceNumber11("40440650", "10")).toBe("10404406509");
    expect(formatFullServiceNumber11("40440650", "10")).toBe("10-40-4406-50-9");
  });

  it("supports custom district code for other cities", () => {
    // 台北 11: 11-40-4406-50
    // 1140440650 check digit:
    // 1*2=2, 1*1=1, 4*2=8, 0*1=0, 4*2=8, 4*1=4, 0*2=0, 6*1=6, 5*2=10(1+0=1), 0*1=0
    // Sum: 2+1+8+0+8+4+0+6+1+0 = 30 -> 0
    expect(toFullServiceNumber11("40440650", "11")).toBe("11404406500");
    expect(formatFullServiceNumber11("40440650", "11")).toBe("11-40-4406-50-0");
  });
});
