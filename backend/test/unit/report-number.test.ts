/**
 * PHASE-008-T2 — `report-number.ts`（報表編號純函式）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * §2.B AC-02（型別前綴三型窮舉）：TRAVEL→TRV／MAINTENANCE→MNT／DEPRECIATION→DEP。
 *   實作以 `Record<ApplicationType, string>` 承載（未來新型別編譯期失敗）；三型各
 *   有正向測試，且映射對調（TRV↔MNT）之 mutant 必紅。
 * §2.B AC-03 編號格式與月份歸屬：
 *   (a) 格式逐字 `{PREFIX}-{YYYYMM}-{NNNN}`；正則
 *       `^(TRV|MNT|DEP)-\d{6}-\d{4,}$` ＋逐段值精確等值。
 *   (b) `YYYYMM` 取自產生時間，依 Asia/Taipei（UTC+08:00 固定偏移，無日光節約）
 *       換算。四點邊界：
 *         2026-08-31T15:59:59Z → 202608
 *         2026-08-31T16:00:00Z → 202609
 *         2026-12-31T16:00:00Z → 202701
 *         2026-01-01T00:00:00Z → 202601
 *       改為 UTC 之 mutant 必紅。
 *   (c) `NNNN` 自 1 起 `padStart(4, "0")`；序號 ≥10000 自然延伸為 5 位（不截斷、
 *       不歸零、不拒絕）——以 `sequence=10000` 之測試固定。
 *   (d) 編號字串僅含 `[A-Z0-9-]`（與 AC-20 檔名安全相依）。
 * §16 D2（推薦選項 (a)）：Asia/Taipei 固定 +08:00 偏移，以純算術（UTC ms ＋8h）
 *   實作，不使用時區資料庫、不使用會被主機時區污染的 `Date` 區域方法
 *   （`getFullYear`／`getMonth` 等一律不得使用，一律 `getUTC*`）。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（本檔）
 * ---------------------------------------------------------------------------
 * 1. AC-02：三型正向斷言 + 「前綴對調」mutant（手動於 report-number.ts 暫改
 *    `REPORT_NUMBER_PREFIX` 之 TRAVEL/MAINTENANCE 值互換）之紅燈實證見 Handoff。
 * 2. AC-03(b)：四點邊界逐一斷言；「移除 +8h 偏移改用純 UTC」mutant 之紅燈實證見
 *    Handoff。
 * 3. AC-03(c)：`sequence=10000` 固定為 `"10000"`（5 位，非截斷為 `"0000"` 或拒絕）。
 * 4. AC-03(d)：字元集不變式 sweep——三型 × 多個跨年月份 × `sequence`∈
 *    {1,9,99,999,9999,10000,99999} 全數比對正則且逐段可反解（split("-") 三段，
 *    各段與獨立計算值全等）。
 */

import type { ApplicationType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  REPORT_NUMBER_PREFIX,
  buildReportNumber,
  generateReportNumber,
  getReportNumberPeriod,
  getReportNumberPrefix,
} from "../../src/reports/report-number.js";

describe("REPORT_NUMBER_PREFIX / getReportNumberPrefix — AC-02", () => {
  it("TRAVEL → TRV", () => {
    expect(getReportNumberPrefix("TRAVEL")).toBe("TRV");
  });

  it("MAINTENANCE → MNT", () => {
    expect(getReportNumberPrefix("MAINTENANCE")).toBe("MNT");
  });

  it("DEPRECIATION → DEP", () => {
    expect(getReportNumberPrefix("DEPRECIATION")).toBe("DEP");
  });

  it("映射恰為三型窮舉（無多餘、無缺漏鍵）", () => {
    const keys = Object.keys(REPORT_NUMBER_PREFIX).sort();
    expect(keys).toEqual(["DEPRECIATION", "MAINTENANCE", "TRAVEL"]);
  });

  it("三前綴值互異（鑑別「對調」mutant 的必要前提——若 TRV/MNT 互換，上方個別斷言即紅）", () => {
    const values = Object.values(REPORT_NUMBER_PREFIX);
    expect(new Set(values).size).toBe(3);
  });
});

describe("getReportNumberPeriod — AC-03(b) Asia/Taipei 四點邊界", () => {
  it("2026-08-31T15:59:59Z → 202608（台北 08/31 23:59:59，仍屬 8 月）", () => {
    expect(getReportNumberPeriod(new Date("2026-08-31T15:59:59Z"))).toBe("202608");
  });

  it("2026-08-31T16:00:00Z → 202609（台北 09/01 00:00:00，跨入新月）", () => {
    expect(getReportNumberPeriod(new Date("2026-08-31T16:00:00Z"))).toBe("202609");
  });

  it("2026-12-31T16:00:00Z → 202701（台北跨年 01/01 00:00:00）", () => {
    expect(getReportNumberPeriod(new Date("2026-12-31T16:00:00Z"))).toBe("202701");
  });

  it("2026-01-01T00:00:00Z → 202601（台北 01/01 08:00:00，仍屬 1 月）", () => {
    expect(getReportNumberPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("202601");
  });

  it("YYYYMM 不受主機時區影響（TZ 覆寫下四點邊界不變）", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "EST5EDT", "Asia/Taipei"]) {
        process.env.TZ = tz;
        expect(getReportNumberPeriod(new Date("2026-08-31T15:59:59Z"))).toBe("202608");
        expect(getReportNumberPeriod(new Date("2026-08-31T16:00:00Z"))).toBe("202609");
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("buildReportNumber / generateReportNumber — AC-03(a)(c) 格式與序號", () => {
  const FORMAT_RE = /^(TRV|MNT|DEP)-\d{6}-\d{4,}$/;

  it("格式逐字為 {PREFIX}-{YYYYMM}-{NNNN}，例：TRV-202608-0001", () => {
    const result = buildReportNumber("TRV", "202608", 1);
    expect(result).toBe("TRV-202608-0001");
    expect(result).toMatch(FORMAT_RE);
  });

  it("逐段值精確等值（非僅正則寬鬆匹配）", () => {
    const result = buildReportNumber("MNT", "202612", 42);
    const [prefix, period, sequence] = result.split("-");
    expect(prefix).toBe("MNT");
    expect(period).toBe("202612");
    expect(sequence).toBe("0042");
  });

  it('sequence 自 1 起 padStart(4, "0")', () => {
    expect(buildReportNumber("DEP", "202601", 1)).toBe("DEP-202601-0001");
    expect(buildReportNumber("DEP", "202601", 9)).toBe("DEP-202601-0009");
    expect(buildReportNumber("DEP", "202601", 99)).toBe("DEP-202601-0099");
    expect(buildReportNumber("DEP", "202601", 999)).toBe("DEP-202601-0999");
    expect(buildReportNumber("DEP", "202601", 9999)).toBe("DEP-202601-9999");
  });

  it("sequence=10000 → 自然延伸為 5 位「10000」，不截斷、不歸零、不拒絕", () => {
    const result = buildReportNumber("TRV", "202608", 10000);
    expect(result).toBe("TRV-202608-10000");
    expect(result).toMatch(FORMAT_RE);
    const [, , sequence] = result.split("-");
    expect(sequence).toBe("10000");
    expect(sequence.length).toBe(5);
  });

  it("generateReportNumber 整合三型 + 月份 + 序號之完整管線", () => {
    const generatedAt = new Date("2026-08-31T16:00:00Z"); // 台北 09/01 00:00:00
    expect(generateReportNumber("TRAVEL", generatedAt, 1)).toBe("TRV-202609-0001");
    expect(generateReportNumber("MAINTENANCE", generatedAt, 1)).toBe("MNT-202609-0001");
    expect(generateReportNumber("DEPRECIATION", generatedAt, 1)).toBe("DEP-202609-0001");
  });
});

describe("編號字元集不變式 — AC-03(d)", () => {
  const CHARSET_RE = /^[A-Z0-9-]+$/;
  const TYPES: ApplicationType[] = ["TRAVEL", "MAINTENANCE", "DEPRECIATION"];
  const SAMPLE_DATES = [
    new Date("2026-01-01T00:00:00Z"), // 202601
    new Date("2026-08-31T15:59:59Z"), // 202608
    new Date("2026-08-31T16:00:00Z"), // 202609
    new Date("2026-12-31T16:00:00Z"), // 202701
    new Date("2030-06-15T12:00:00Z"), // 中段月份，非邊界
  ];
  const SEQUENCES = [1, 9, 99, 999, 9999, 10000, 99999];

  it("三型 × 5 個跨年月份 × 7 個序號（含五位延伸）之全數組合皆符合 [A-Z0-9-]+ 且逐段可反解", () => {
    let checked = 0;
    for (const type of TYPES) {
      for (const generatedAt of SAMPLE_DATES) {
        for (const sequence of SEQUENCES) {
          const number = generateReportNumber(type, generatedAt, sequence);

          expect(number).toMatch(CHARSET_RE);

          const [prefix, period, seqPart] = number.split("-");
          expect(prefix).toBe(getReportNumberPrefix(type));
          expect(period).toBe(getReportNumberPeriod(generatedAt));
          expect(seqPart).toBe(String(sequence).padStart(4, "0"));
          expect(number.split("-").length).toBe(3);

          checked += 1;
        }
      }
    }
    // 3 型 × 5 月份 × 7 序號 = 105 組合，逐一驗證覆蓋數固定，避免迴圈邏輯誤刪樣本而靜默通過
    expect(checked).toBe(3 * 5 * 7);
  });
});
