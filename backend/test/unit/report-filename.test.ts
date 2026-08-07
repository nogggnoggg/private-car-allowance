/**
 * PHASE-008-T3 — `report-filename.ts`（安全檔名純函式）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（Spec `docs/specs/PHASE-008.md`）
 * ---------------------------------------------------------------------------
 * §2.E AC-20（檔名組成，三型逐型）：`{類型}_{使用者姓名}_{日期或年度}_{報表編號}.pdf`；
 *   類型為 zh-TW 標籤（`差旅`／`保養`／`折舊`）；日期或年度：差旅＝出差日期
 *   （`YYYY-MM-DD`）、保養＝本次保養日期（`YYYY-MM-DD`）、折舊＝申請年度（`YYYY`）；
 *   三型各一測試、四段值逐字斷言；同一使用者之多份報表因編號段而互異；日期／年度
 *   來源為 `null` 之防禦：以 `Application.primaryDate` 為 fallback（三型皆非空，§8.4）。
 * §2.E AC-21（不安全字元 gate table，12 列）：`../../etc/passwd`、`a/b\c`、
 *   `名字:*?"<>|`、含 `\r\n`、含空位元組與控制字元、純空白、前後綴 `.` 與空白、
 *   `CON`／`NUL`、300 字、空字串。規則：`[\\/:*?"<>|]` 與控制字元 → `_`；連續空白
 *   → `_`；去前後綴 `.` 與空白；姓名段上限 30（截斷）；整體檔名（含副檔名）上限
 *   120；清理後為空 → `使用者`。輸出恆不含 `/`、`\`、`\r`、`\n`、空位元組，且恆含
 *   報表編號（保證絕不與 Windows 保留裝置名全等）。
 * §16 D7（推薦選項 (a)＋(i)）：組成規則如上；檔名於產生時持久化（T8 接線，本檔
 *   僅涵蓋純函式）。
 *
 * ---------------------------------------------------------------------------
 * FW-4（T2 複審必引）
 * ---------------------------------------------------------------------------
 * 報表編號一律經 `generateReportNumber`（`report-number.ts`）取得或以其產出字串為
 * 輸入；本檔的 `buildReportFileName` 不重算編號，一律以「已產生之報表編號字串」
 * 作為輸入參數。測試中之 `reportNumber` 皆來自 `generateReportNumber`（或其格式的
 * 固定字面量），驗證與 `report-number.ts` 之整合面。
 *
 * ---------------------------------------------------------------------------
 * 實作決策揭露（本檔內部順序選擇；Spec 未逐字定義執行順序，非阻斷性歧義，已於
 * Handoff 揭露交複審）
 * ---------------------------------------------------------------------------
 * 1. 姓名段清理內部順序：先去前後綴 `.`／空白 → 再逐字元替換不安全字元／控制字元
 *    → 再收合內部連續空白 → 再截斷至 30 → 再空值防禦。此順序使「純空白」與
 *    「前後綴 `.` 與空白」兩列真正被去除而非殘留底線裝飾字元，最貼合規則文字之
 *    自然語意（AC-21 僅要求「輸出安全且非空」，不要求逐字元輸出，此順序選擇不影
 *    響任何 gate 斷言之通過與否）。
 * 2. 整體檔名 120 上限之截斷優先序（AC-21 未逐字定義）：報表編號與 `.pdf` 副檔名
 *    恆保留；超長時先截姓名段、其次截日期／年度段（Packet Stop Conditions 之建議
 *    合理解讀）。姓名段本已於 sanitizeDisplayName 中上限 30，此處之二次截斷僅為
 *    「報表編號本身異常長」之防禦性測試情境所觸發（正常編號長度不會觸發）。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（本檔）
 * ---------------------------------------------------------------------------
 * 1. AC-20：三型各一測試，四段值以精確字串相等斷言（非僅正則）；同使用者多份因
 *    編號互異之測試；`typeSpecificDate`／`applicationYear` 為 `null` 時之
 *    `primaryDate` fallback 測試（三型各一）。
 * 2. AC-21：12 列 gate table，逐列斷言「安全（不含 `/ \ CR LF \x00`）且非空且含報
 *    表編號」；300 字姓名段截斷至 30、整體 ≤120 之精確長度斷言；空字串／純空白
 *    之 `使用者` fallback 精確斷言；`CON`／`NUL` 之「整體檔名恆不等於保留裝置名」
 *    精確斷言。
 * 3. 整體 120 上限：以人工建構之超長 `reportNumber`（防禦性測試，非真實編號格式）
 *    觸發截斷路徑，驗證編號與 `.pdf` 恆保留、姓名段優先於日期段被犧牲。
 * 4. 200 例不變式 sweep：以確定性 LCG（線性同餘產生器，固定種子，非
 *    `Math.random`）窮舉建構姓名字串（字元域含全部不安全字元／控制字元／空位元
 *    組／CJK／ASCII），逐例斷言恆不含 `/ \ CR LF \x00`、恆含報表編號、非空、
 *    `.pdf` 結尾、長度 ≤120。
 */

import type { ApplicationType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_NAME_LENGTH,
  MAX_NAME_SEGMENT_LENGTH,
  REPORT_TYPE_LABEL,
  buildReportFileName,
  getReportTypeLabel,
  resolveDateOrYearSegment,
  sanitizeDisplayName,
} from "../../src/reports/report-filename.js";
import { generateReportNumber } from "../../src/reports/report-number.js";

/**
 * SF-2（期中複審）：控制字元（0x00-0x1F、0x7F）不變式檢查——以逐字元比對取代
 * 正則（biome `noControlCharactersInRegex` 禁止正則字面量內含控制字元跳脫），
 * 邊界值 0x1F 與 isControlChar 之 `<=0x1f` 判斷一致（鑑別 `<=0x1f`→`<0x1f`
 * mutant 的必要前提）。
 */
function containsControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

describe("REPORT_TYPE_LABEL / getReportTypeLabel — AC-20 型別 zh-TW 標籤", () => {
  it("TRAVEL → 差旅", () => {
    expect(getReportTypeLabel("TRAVEL")).toBe("差旅");
  });

  it("MAINTENANCE → 保養", () => {
    expect(getReportTypeLabel("MAINTENANCE")).toBe("保養");
  });

  it("DEPRECIATION → 折舊", () => {
    expect(getReportTypeLabel("DEPRECIATION")).toBe("折舊");
  });

  it("映射恰為三型窮舉（無多餘、無缺漏鍵）", () => {
    const keys = Object.keys(REPORT_TYPE_LABEL).sort();
    expect(keys).toEqual(["DEPRECIATION", "MAINTENANCE", "TRAVEL"]);
  });

  it("三標籤值互異（鑑別「對調」mutant 的必要前提）", () => {
    const values = Object.values(REPORT_TYPE_LABEL);
    expect(new Set(values).size).toBe(3);
  });
});

describe("buildReportFileName — AC-20 三型組成，四段值逐字斷言", () => {
  it("TRAVEL：差旅_王小明_2026-03-05_TRV-202608-0001.pdf", () => {
    const reportNumber = generateReportNumber("TRAVEL", new Date("2026-08-01T00:00:00Z"), 1);
    const fileName = buildReportFileName({
      type: "TRAVEL",
      displayName: "王小明",
      dateOrYearSource: new Date("2026-03-05T00:00:00Z"),
      primaryDate: new Date("2026-03-05T00:00:00Z"),
      reportNumber,
    });
    expect(fileName).toBe(`差旅_王小明_2026-03-05_${reportNumber}.pdf`);
    const [type, name, dateOrYear, rest] = fileName.split("_");
    expect(type).toBe("差旅");
    expect(name).toBe("王小明");
    expect(dateOrYear).toBe("2026-03-05");
    expect(rest).toBe(`${reportNumber}.pdf`);
  });

  it("MAINTENANCE：保養_陳大文_2026-07-20_MNT-202608-0002.pdf", () => {
    const reportNumber = generateReportNumber("MAINTENANCE", new Date("2026-08-01T00:00:00Z"), 2);
    const fileName = buildReportFileName({
      type: "MAINTENANCE",
      displayName: "陳大文",
      dateOrYearSource: new Date("2026-07-20T00:00:00Z"),
      primaryDate: new Date("2026-07-20T00:00:00Z"),
      reportNumber,
    });
    expect(fileName).toBe(`保養_陳大文_2026-07-20_${reportNumber}.pdf`);
    const [type, name, dateOrYear, rest] = fileName.split("_");
    expect(type).toBe("保養");
    expect(name).toBe("陳大文");
    expect(dateOrYear).toBe("2026-07-20");
    expect(rest).toBe(`${reportNumber}.pdf`);
  });

  it("DEPRECIATION：折舊_林小美_2026_DEP-202608-0003.pdf（年度段僅 YYYY）", () => {
    const reportNumber = generateReportNumber("DEPRECIATION", new Date("2026-08-01T00:00:00Z"), 3);
    const fileName = buildReportFileName({
      type: "DEPRECIATION",
      displayName: "林小美",
      dateOrYearSource: 2026,
      primaryDate: new Date("2026-12-31T00:00:00Z"),
      reportNumber,
    });
    expect(fileName).toBe(`折舊_林小美_2026_${reportNumber}.pdf`);
    const [type, name, dateOrYear, rest] = fileName.split("_");
    expect(type).toBe("折舊");
    expect(name).toBe("林小美");
    expect(dateOrYear).toBe("2026");
    expect(rest).toBe(`${reportNumber}.pdf`);
  });

  it("同一使用者同型多份報表：因編號段互異而檔名互異，其餘三段相同", () => {
    const primaryDate = new Date("2026-03-05T00:00:00Z");
    const base = {
      type: "TRAVEL" as ApplicationType,
      displayName: "王小明",
      dateOrYearSource: primaryDate,
      primaryDate,
    };
    const fileNameA = buildReportFileName({
      ...base,
      reportNumber: generateReportNumber("TRAVEL", new Date("2026-08-01T00:00:00Z"), 1),
    });
    const fileNameB = buildReportFileName({
      ...base,
      reportNumber: generateReportNumber("TRAVEL", new Date("2026-08-01T00:00:00Z"), 2),
    });
    expect(fileNameA).not.toBe(fileNameB);
    expect(fileNameA).toBe("差旅_王小明_2026-03-05_TRV-202608-0001.pdf");
    expect(fileNameB).toBe("差旅_王小明_2026-03-05_TRV-202608-0002.pdf");
  });

  describe("null 防禦：以 Application.primaryDate 為 fallback（三型各一）", () => {
    it("TRAVEL：出差日期為 null → 落回 primaryDate", () => {
      const fileName = buildReportFileName({
        type: "TRAVEL",
        displayName: "王小明",
        dateOrYearSource: null,
        primaryDate: new Date("2026-04-09T00:00:00Z"),
        reportNumber: "TRV-202608-0001",
      });
      expect(fileName).toBe("差旅_王小明_2026-04-09_TRV-202608-0001.pdf");
    });

    it("MAINTENANCE：本次保養日期為 null → 落回 primaryDate", () => {
      const fileName = buildReportFileName({
        type: "MAINTENANCE",
        displayName: "陳大文",
        dateOrYearSource: null,
        primaryDate: new Date("2026-05-11T00:00:00Z"),
        reportNumber: "MNT-202608-0001",
      });
      expect(fileName).toBe("保養_陳大文_2026-05-11_MNT-202608-0001.pdf");
    });

    it("DEPRECIATION：申請年度為 null → 落回 primaryDate 之年", () => {
      const fileName = buildReportFileName({
        type: "DEPRECIATION",
        displayName: "林小美",
        dateOrYearSource: null,
        primaryDate: new Date("2026-12-31T00:00:00Z"),
        reportNumber: "DEP-202608-0001",
      });
      expect(fileName).toBe("折舊_林小美_2026_DEP-202608-0001.pdf");
    });
  });
});

describe("sanitizeDisplayName / buildReportFileName — AC-21 不安全字元 gate table（12 列）", () => {
  const PRIMARY_DATE = new Date("2026-03-05T00:00:00Z");
  const REPORT_NUMBER = "TRV-202608-0001";

  function assertSafeNonEmpty(fileName: string): void {
    expect(fileName.length).toBeGreaterThan(0);
    expect(fileName).not.toContain("/");
    expect(fileName).not.toContain("\\");
    expect(fileName).not.toContain("\r");
    expect(fileName).not.toContain("\n");
    expect(fileName).not.toContain("\x00");
    // SF-2（期中複審）：控制字元規則（isControlChar `<=0x1f`）之不變式斷言——
    // 未涵蓋此前恰於邊界值 0x1f 存活（mutant `<=0x1f`→`<0x1f`）。
    expect(containsControlChar(fileName)).toBe(false);
    expect(fileName).toContain(REPORT_NUMBER);
    expect(fileName.endsWith(".pdf")).toBe(true);
  }

  function fileNameFor(displayName: string): string {
    return buildReportFileName({
      type: "TRAVEL",
      displayName,
      dateOrYearSource: PRIMARY_DATE,
      primaryDate: PRIMARY_DATE,
      reportNumber: REPORT_NUMBER,
    });
  }

  it("gate-1 ../../etc/passwd", () => {
    assertSafeNonEmpty(fileNameFor("../../etc/passwd"));
  });

  it("gate-2 a/b\\c", () => {
    assertSafeNonEmpty(fileNameFor("a/b\\c"));
  });

  it('gate-3 名字:*?"<>|', () => {
    assertSafeNonEmpty(fileNameFor('名字:*?"<>|'));
  });

  it("gate-4 含 \\r\\n（header injection）", () => {
    assertSafeNonEmpty(fileNameFor("王小明\r\nSet-Cookie: evil=1"));
  });

  it("gate-5 含空位元組（\\x00）與控制字元", () => {
    assertSafeNonEmpty(fileNameFor("王\x00小\x01明\x1f\x7f"));
  });

  it("gate-6 純空白 → 使用者", () => {
    const fileName = fileNameFor("    ");
    assertSafeNonEmpty(fileName);
    expect(fileName).toBe(`差旅_使用者_2026-03-05_${REPORT_NUMBER}.pdf`);
  });

  it("gate-7 前後綴 . 與空白 → 去除，保留中段", () => {
    const fileName = fileNameFor("  ..王小明..  ");
    assertSafeNonEmpty(fileName);
    expect(fileName).toBe(`差旅_王小明_2026-03-05_${REPORT_NUMBER}.pdf`);
  });

  it("gate-8a CON（Windows 保留裝置名）→ 整體檔名恆不等於 CON 或 CON.pdf", () => {
    const fileName = fileNameFor("CON");
    assertSafeNonEmpty(fileName);
    expect(fileName).not.toBe("CON");
    expect(fileName).not.toBe("CON.pdf");
    expect(fileName).toBe(`差旅_CON_2026-03-05_${REPORT_NUMBER}.pdf`);
  });

  it("gate-8b NUL（Windows 保留裝置名）→ 整體檔名恆不等於 NUL 或 NUL.pdf", () => {
    const fileName = fileNameFor("NUL");
    assertSafeNonEmpty(fileName);
    expect(fileName).not.toBe("NUL");
    expect(fileName).not.toBe("NUL.pdf");
    expect(fileName).toBe(`差旅_NUL_2026-03-05_${REPORT_NUMBER}.pdf`);
  });

  it("gate-9 長度 300 字 → 姓名段截斷至 30、整體 ≤120", () => {
    const longName = "王".repeat(300);
    const fileName = fileNameFor(longName);
    assertSafeNonEmpty(fileName);
    const nameSegment = sanitizeDisplayName(longName);
    expect(nameSegment.length).toBe(MAX_NAME_SEGMENT_LENGTH);
    expect(fileName.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(fileName).toBe(`差旅_${"王".repeat(30)}_2026-03-05_${REPORT_NUMBER}.pdf`);
  });

  it("gate-10 空字串 → 使用者", () => {
    const fileName = fileNameFor("");
    assertSafeNonEmpty(fileName);
    expect(fileName).toBe(`差旅_使用者_2026-03-05_${REPORT_NUMBER}.pdf`);
  });
});

describe("sanitizeDisplayName — 個別規則之精確斷言", () => {
  it("不安全字元逐字元替換為 _", () => {
    const result = sanitizeDisplayName('a/b\\c:d*e?f"g<h>i|j');
    expect(result).not.toMatch(/[\\/:*?"<>|]/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("連續空白收合為單一 _", () => {
    const result = sanitizeDisplayName("王   小明");
    expect(result).toBe("王_小明");
  });

  it("去除前後綴 . 與空白，保留中段", () => {
    expect(sanitizeDisplayName("  王小明  ")).toBe("王小明");
    expect(sanitizeDisplayName("..王小明..")).toBe("王小明");
    expect(sanitizeDisplayName(" . 王小明 . ")).toBe("王小明");
  });

  it("姓名段上限 30 字（截斷，不四捨五入、不拋錯）", () => {
    const result = sanitizeDisplayName("a".repeat(50));
    expect(result.length).toBe(30);
    expect(result).toBe("a".repeat(30));
  });

  it("清理後為空 → 使用者", () => {
    expect(sanitizeDisplayName("")).toBe("使用者");
    expect(sanitizeDisplayName("   ")).toBe("使用者");
    expect(sanitizeDisplayName("...")).toBe("使用者");
    expect(sanitizeDisplayName(" . . . ")).toBe("使用者");
  });

  it("恆不含 / \\ \\r \\n \\x00（任意輸入）", () => {
    const inputs = [
      "../../etc/passwd",
      "a/b\\c",
      '名字:*?"<>|',
      "王\r\n明",
      "王\x00明",
      // SF-2（期中複審）：\x1f 恰為 isControlChar 邊界值（mutant `<=0x1f`→`<0x1f`
      // 存活之關鍵輸入）。
      "王\x1f明",
    ];
    for (const input of inputs) {
      const result = sanitizeDisplayName(input);
      expect(result).not.toContain("/");
      expect(result).not.toContain("\\");
      expect(result).not.toContain("\r");
      expect(result).not.toContain("\n");
      expect(result).not.toContain("\x00");
      // SF-2（期中複審）：控制字元規則之不變式斷言（涵蓋邊界值 0x1f）。
      expect(containsControlChar(result)).toBe(false);
    }
  });
});

describe("buildReportFileName — 整體 120 上限截斷（防禦性：異常長報表編號）", () => {
  it("編號與 .pdf 恆保留；優先截姓名段、其次截日期段，最終仍 ≤120", () => {
    // 人為建構超長 reportNumber（真實編號不會如此長；此處純為驗證截斷防禦邏輯）。
    // reportNumber 長度 105：初始總長 127（>120）；姓名段（3 字）先被壓縮至 0
    // （仍 124，>120）；日期段（10 字）再被壓縮至 6 字，最終恰為 120。
    const hugeReportNumber = `TRV-202608-${"9".repeat(94)}`;
    expect(hugeReportNumber.length).toBe(105);
    const fileName = buildReportFileName({
      type: "TRAVEL",
      displayName: "王小明",
      dateOrYearSource: new Date("2026-03-05T00:00:00Z"),
      primaryDate: new Date("2026-03-05T00:00:00Z"),
      reportNumber: hugeReportNumber,
    });
    expect(fileName.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(fileName).toContain(hugeReportNumber);
    expect(fileName.endsWith(".pdf")).toBe(true);
    expect(fileName).toBe(`差旅__2026-0_${hugeReportNumber}.pdf`);
  });

  it("reportNumber 本身已逼近或超出 120 預算之不可化解情境：姓名段與日期段皆壓縮至 0，編號與 .pdf 仍逐字完整（優先序之極限行為）", () => {
    // reportNumber 長度 125：即使姓名段與日期段皆壓縮至 0，總長仍為 9+125=134，
    // 大於 120。此為「編號與 .pdf 恆保留」優先序下的預期極限行為——非本函式之
    // 缺陷，而是 Stop Condition 揭露之合理解讀的直接推論（編號與副檔名不可犧
    // 牲）；此情境於實務上不會出現（真實報表編號長度遠短於此)。
    const hugeReportNumber = `TRV-202608-${"9".repeat(114)}`;
    const fileName = buildReportFileName({
      type: "TRAVEL",
      displayName: "王小明",
      dateOrYearSource: new Date("2026-03-05T00:00:00Z"),
      primaryDate: new Date("2026-03-05T00:00:00Z"),
      reportNumber: hugeReportNumber,
    });
    expect(fileName).toContain(hugeReportNumber);
    expect(fileName.endsWith(".pdf")).toBe(true);
    expect(fileName).toBe(`差旅___${hugeReportNumber}.pdf`);
  });
});

describe("200 例不變式 sweep — 恆不含 / \\ CR LF \\x00、恆含報表編號（確定性 LCG，非 Math.random）", () => {
  const UNSAFE_CHAR_POOL = [
    "/",
    "\\",
    ":",
    "*",
    "?",
    '"',
    "<",
    ">",
    "|",
    "\r",
    "\n",
    "\x00",
    "\x01",
    "\x1f",
    "\x7f",
    " ",
    ".",
    "a",
    "王",
    "1",
    "_",
    "-",
  ];
  const TYPES: ApplicationType[] = ["TRAVEL", "MAINTENANCE", "DEPRECIATION"];

  /** 確定性線性同餘產生器（固定種子），非執行期隨機。 */
  function nextSeed(seed: number): number {
    return (Math.imul(seed, 1103515245) + 12345) >>> 0;
  }

  function buildFuzzName(seed: number): string {
    let s = "";
    let x = seed;
    const len = 3 + (seed % 20);
    for (let i = 0; i < len; i++) {
      x = nextSeed(x);
      s += UNSAFE_CHAR_POOL[x % UNSAFE_CHAR_POOL.length];
    }
    return s;
  }

  it("200 組確定性構造之姓名輸入，逐例通過不變式", () => {
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const seed = nextSeed(i + 1);
      const displayName = buildFuzzName(seed);
      const type = TYPES[i % TYPES.length];
      const reportNumber = generateReportNumber(
        type,
        new Date("2026-08-01T00:00:00Z"),
        (i % 9999) + 1
      );
      const primaryDate = new Date(2020 + (i % 10), i % 12, 1 + (i % 28));
      const dateOrYearSource = type === "DEPRECIATION" ? 2020 + (i % 10) : primaryDate;

      const fileName = buildReportFileName({
        type,
        displayName,
        dateOrYearSource,
        primaryDate,
        reportNumber,
      });

      expect(fileName.length).toBeGreaterThan(0);
      expect(fileName).not.toContain("/");
      expect(fileName).not.toContain("\\");
      expect(fileName).not.toContain("\r");
      expect(fileName).not.toContain("\n");
      expect(fileName).not.toContain("\x00");
      // SF-2（期中複審）：控制字元規則之不變式斷言（含邊界值 0x1f；UNSAFE_CHAR_POOL
      // 已含 "\x1f"，200 例覆蓋下足以鑑別 isControlChar 邊界 mutant）。
      expect(containsControlChar(fileName)).toBe(false);
      expect(fileName).toContain(reportNumber);
      expect(fileName.endsWith(".pdf")).toBe(true);
      expect(fileName.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);

      checked += 1;
    }
    // 200 例逐一驗證覆蓋數固定，避免迴圈邏輯誤刪樣本而靜默通過
    expect(checked).toBe(200);
  });
});

describe("SF-1（期中複審）：姓名段截斷不得產生孤兒代理字元（surrogate pair 邊界）", () => {
  /**
   * 逐 UTF-16 碼元掃描字串，偵測未成對之代理字元（孤兒高代理／孤兒低代理）。
   * 自寫檢查（非依賴 ES2024 `String.prototype.isWellFormed`，本專案 lib 為
   * ES2022）。
   */
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const isLow = code >= 0xdc00 && code <= 0xdfff;
      if (isHigh) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : Number.NaN;
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return true;
        }
        i += 1; // 跳過已配對之低代理
      } else if (isLow) {
        return true; // 低代理未被前一個高代理消耗，即為孤兒
      }
    }
    return false;
  }

  it("sanitizeDisplayName：'a' + 😀×20（UTF-16 碼元數 41 > 30）截斷後段內無孤兒代理，encodeURIComponent 不擲錯", () => {
    const raw = `a${"😀".repeat(20)}`;
    const result = sanitizeDisplayName(raw);
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  it("buildReportFileName：完整管線之輸出亦無孤兒代理，encodeURIComponent 不擲錯", () => {
    const raw = `a${"😀".repeat(20)}`;
    const primaryDate = new Date("2026-03-05T00:00:00Z");
    const fileName = buildReportFileName({
      type: "TRAVEL",
      displayName: raw,
      dateOrYearSource: primaryDate,
      primaryDate,
      reportNumber: "TRV-202608-0001",
    });
    expect(hasLoneSurrogate(fileName)).toBe(false);
    expect(() => encodeURIComponent(fileName)).not.toThrow();
  });
});

describe("SF-3（期中複審）：日期／年度段跨時區不變式（getUTC*，不受主機時區影響）", () => {
  // T2 複審 FW-6 修正版還原語意：一律以 vi.stubEnv／vi.unstubAllEnvs 覆寫與還原
  // TZ，不用裸 `process.env.TZ = original`（original 為 undefined 時會寫入字串
  // "undefined"）。
  const TIMEZONES = ["UTC", "EST5EDT", "Asia/Taipei", "Pacific/Kiritimati"];

  it("resolveDateOrYearSegment — TRAVEL/MAINTENANCE 日期段（UTC 早晨邊界，落後 UTC 之時區會使本地日期倒退一天）", () => {
    // 2026-08-01T02:00:00Z：EST5EDT（UTC-4）本地為 2026-07-31T22:00 ——若採本地
    // getter 將得 2026-07-31，與 UTC 之 2026-08-01 不同。
    const date = new Date("2026-08-01T02:00:00Z");
    try {
      for (const tz of TIMEZONES) {
        vi.stubEnv("TZ", tz);
        expect(resolveDateOrYearSegment("TRAVEL", date, date)).toBe("2026-08-01");
        expect(resolveDateOrYearSegment("MAINTENANCE", date, date)).toBe("2026-08-01");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolveDateOrYearSegment — TRAVEL/MAINTENANCE 日期段（UTC 深夜邊界，領先 UTC 之時區會使本地日期提前一天）", () => {
    // 2026-08-31T23:30:00Z：Pacific/Kiritimati（UTC+14）本地為
    // 2026-09-01T13:30 ——若採本地 getter 將得 2026-09-01，與 UTC 之
    // 2026-08-31 不同。
    const date = new Date("2026-08-31T23:30:00Z");
    try {
      for (const tz of TIMEZONES) {
        vi.stubEnv("TZ", tz);
        expect(resolveDateOrYearSegment("TRAVEL", date, date)).toBe("2026-08-31");
        expect(resolveDateOrYearSegment("MAINTENANCE", date, date)).toBe("2026-08-31");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolveDateOrYearSegment — DEPRECIATION 之 primaryDate fallback 年度段（UTC 跨年邊界，落後 UTC 之時區會使本地年度倒退一年）", () => {
    // 2026-01-01T02:00:00Z：EST5EDT（UTC-4）本地為 2025-12-31T22:00 ——若採本地
    // getter 將得 2025，與 UTC 之 2026 不同。
    const primaryDate = new Date("2026-01-01T02:00:00Z");
    try {
      for (const tz of TIMEZONES) {
        vi.stubEnv("TZ", tz);
        expect(resolveDateOrYearSegment("DEPRECIATION", null, primaryDate)).toBe("2026");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("buildReportFileName — 完整管線之日期段跨時區不變（UTC 深夜邊界）", () => {
    const date = new Date("2026-08-31T23:30:00Z");
    try {
      for (const tz of TIMEZONES) {
        vi.stubEnv("TZ", tz);
        const fileName = buildReportFileName({
          type: "TRAVEL",
          displayName: "王小明",
          dateOrYearSource: date,
          primaryDate: date,
          reportNumber: "TRV-202608-0001",
        });
        expect(fileName).toBe("差旅_王小明_2026-08-31_TRV-202608-0001.pdf");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
