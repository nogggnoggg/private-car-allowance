/**
 * PHASE-007-R3 — `computeDepreciationBlockers`（折舊完成度純函式，兩段式／三段互斥）
 *
 * Spec `docs/specs/PHASE-007.md`（**修訂段以 §20 為準，衝突處覆蓋 §1~§17**）：
 *   §20.5.1 六碼固定順序表（1 `YEAR_REQUIRED`／2 `ANNUAL_TOTAL_KM_REQUIRED`／
 *        3 `ANNUAL_TOTAL_KM_INVALID`／4 `PARAMETER_NOT_AVAILABLE`／
 *        5 `OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM`／6 `AMOUNT_OUT_OF_RANGE`）
 *        ＋兩段式紀律＋**互斥關係**「第 2 與第 3 項互斥；第 4 項與第 5／6 項
 *        互斥；第 5 與第 6 項可同時出現……任一回應之 `blockers[]` 至多含兩碼：
 *        `{1, 2|3}` 或 `{4}` 或 `{5, 6}` 之子集」＋不變式
 *        「`calculable=false ⇒ blockingCodes 至少一項`」
 *   §20.5.2 blocker code 聯集之異動（退場 1 ＋ 新增 3）
 *   §2／§20.3：AC-52（比例 >100% 擋完成，判定層）／AC-53(b)(e)（未輸入與
 *        `≤0`／非有限之防禦層，判定層）／AC-54(b)（附件必備碼退場，本檔零殘留）／
 *        AC-18（推導失敗視同缺參數，判定層）／AC-22(c)(d)（容量，判定層）
 *   §20.11.3：「`computeDepreciationBlockers`：六碼順序穩定、三段互斥語意、
 *        不變式 sweep」
 *
 * ── 相對 T3 版之測試遷移（§20.11.2 授權；覆蓋面不得淨減） ───────────────────
 *   遷移 A：`attachmentCount` 輸入欄與附件必備碼之全部案例 → **退場**
 *           （AC-54 語意反轉：證明改選填）。其「結構性第二碼」之覆蓋角色由
 *           `ANNUAL_TOTAL_KM_REQUIRED`／`ANNUAL_TOTAL_KM_INVALID` 承接，
 *           含 `NaN` 保守失敗（原 M4）之同型案例。
 *   遷移 B：`perKmUnitPrice` 輸入欄 → `annualDepreciation`（§20.4 新公式；
 *           第 4 碼語意不變）。
 *   遷移 C：原「AC-22(d) 邊界正例防誤殺：`Decimal(14,4)` 上界（**單價欄**）」
 *           —— 單價欄已依 §20.7.2 退出判定集合，依 §20.11.2 遷移為新判定集合
 *           之 `snapshotAnnualTotalKm`（`Decimal(9,1)` → 上界 `1e8`）同型邊界，
 *           **另**新增 `snapshotRatio`（`Decimal(9,6)` → 上界 `1e3`）邊界，
 *           故「非 int4 之 Decimal 欄邊界」覆蓋面由 1 欄增為 2 欄（淨增）。
 *
 * TDD 紅燈起點：本版先於實作改造撰寫，`ComputeDepreciationBlockersInput` 尚無
 * `annualTotalKm`／`annualDepreciation` 欄且仍具 `attachmentCount`，型別與行為
 * 雙紅；實作落地後轉綠。
 *
 * 本地已實跑之 mutant（實作完成後逐一改寫 `depreciation-blockers.ts`、執行
 * `npx vitest run test/unit/depreciation-blockers.test.ts`，確認轉紅後以原檔
 * 還原並複跑綠燈；紅燈數見 Handoff）：
 *   M1  拆除第二段閘門（結構性未通過仍評估第 4~6 項）
 *   M2  缺參數路徑「順手」再跑一次容量 predicate（FW-1 直接對象）
 *   M3  §20.5.1 輸出順序對調（第 6 項排到第 5 項之前）
 *   M4  第 3 碼判定改回裸 `lessThanOrEqualTo(0)`（拆除非有限值防禦）
 *   M5  年度判定改回裸 `=== null`（拆除 `NaN` 年度防禦）
 *   M6  容量判定改為就地重寫閾值（第二份閾值拷貝，違 FW-8）
 *   M7  拆除「尚未查詢」抑制（`officialKm=null` 仍評估第 4 項）
 *   M8  第 2 碼 zh-TW 文案漂移
 *   M9  比例守門 `>` 改 `>=`（AC-52(b) 雙側殺之一）
 *   M10 比例守門改為恆 `false`（AC-52(b) 雙側殺之二）
 *   M11 比例守門改以 6dp 取整後之 `ratioString` 比較（AC-52(c) 直接對象）
 *   M12 第 2/3 碼互斥拆除（同時輸出）
 *   M13 退場碼「復活」（第 3 碼改吐附件必備碼）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type Blocker,
  type ComputeDepreciationBlockersInput,
  computeDepreciationBlockers,
  isOfficialKmExceedsAnnualTotalKm,
} from "../../src/applications/depreciation-blockers.js";
import {
  DEPRECIATION_COLUMN_CAPACITY,
  calculateDepreciation,
  isDepreciationCalculationOverCapacity,
} from "../../src/applications/depreciation-calculation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const BLOCKERS_SRC_PATH = path.resolve(BACKEND_ROOT, "src/applications/depreciation-blockers.ts");

const d = (value: string) => new Prisma.Decimal(value);
const codes = (blockers: Blocker[]) => blockers.map((b) => b.code);

/** §20.5.1 表格之六碼，**逐字且依表格順序**。順序穩定之唯一事實來源。 */
const ORDERED_CODES = [
  "YEAR_REQUIRED",
  "ANNUAL_TOTAL_KM_REQUIRED",
  "ANNUAL_TOTAL_KM_INVALID",
  "PARAMETER_NOT_AVAILABLE",
  "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
  "AMOUNT_OUT_OF_RANGE",
] as const;

/** §20.5.1 互斥段之三段分組（`{1, 2|3}`／`{4}`／`{5, 6}`）。 */
const STRUCTURAL_GROUP = ORDERED_CODES.slice(0, 3) as readonly string[];
const PARAMETER_GROUP = ORDERED_CODES.slice(3, 4) as readonly string[];
const COMPUTED_GROUP = ORDERED_CODES.slice(4, 6) as readonly string[];

/** AC-54(b)：已退場之附件必備碼（本檔以組合方式構成，避免 src 掃描斷言自我污染）。 */
const RETIRED_ATTACHMENT_CODE = ["DEPRECIATION", "ATTACHMENT", "REQUIRED"].join("_");

/** 第一段（結構性）全通過之基準輸入。 */
const PASSING_STRUCTURAL: ComputeDepreciationBlockersInput = {
  applicationYear: 2026,
  annualTotalKm: d("10000.0"),
};

// ---------------------------------------------------------------------------
// §1 六碼固定順序與 zh-TW 文案（§20.5.1 表格逐字；006 T3「零文案差異」義務同型）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — §20.5.1 六碼、固定順序與 zh-TW 文案", () => {
  it("§20.5.1 順序 1/2：年度缺漏 ＋ 年度總里程缺漏，依表格順序輸出（不可只回第一項）", () => {
    const result = computeDepreciationBlockers({ applicationYear: null, annualTotalKm: null });
    expect(codes(result)).toEqual(["YEAR_REQUIRED", "ANNUAL_TOTAL_KM_REQUIRED"]);
  });

  it("§20.5.1 順序 1/3：年度缺漏 ＋ 年度總里程 `≤0`，依表格順序輸出", () => {
    const result = computeDepreciationBlockers({ applicationYear: null, annualTotalKm: d("0") });
    expect(codes(result)).toEqual(["YEAR_REQUIRED", "ANNUAL_TOTAL_KM_INVALID"]);
  });

  it("§20.5.1 第 1 項文案與欄位路徑逐字（006 T3 AR-2 教訓：`Blocker.field` 零斷言即隱形）", () => {
    const [blocker] = computeDepreciationBlockers({
      applicationYear: null,
      annualTotalKm: d("10000.0"),
    });
    expect(blocker).toEqual({
      code: "YEAR_REQUIRED",
      field: "applicationYear",
      message: "請選擇申請年度",
    });
  });

  it("AC-53(b) §20.5.1 第 2 項文案與欄位路徑逐字（`field=annualTotalKm`）", () => {
    const [blocker] = computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm: null });
    expect(blocker).toEqual({
      code: "ANNUAL_TOTAL_KM_REQUIRED",
      field: "annualTotalKm",
      message: "請輸入該車年度總里程",
    });
  });

  it("AC-53(e) §20.5.1 第 3 項文案與欄位路徑逐字（`field=annualTotalKm`）", () => {
    const [blocker] = computeDepreciationBlockers({
      applicationYear: 2026,
      annualTotalKm: d("0"),
    });
    expect(blocker).toEqual({
      code: "ANNUAL_TOTAL_KM_INVALID",
      field: "annualTotalKm",
      message: "年度總里程必須大於 0",
    });
  });

  it("AC-16(b) §20.5.1 第 4 項文案逐字，且不具欄位路徑（409 路徑）", () => {
    const [blocker] = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("1000.00"),
      annualDepreciation: null,
    });
    expect(blocker).toEqual({
      code: "PARAMETER_NOT_AVAILABLE",
      message: "該年度尚無有效折舊參數，請聯絡管理員設定",
    });
    expect(Object.hasOwn(blocker, "field")).toBe(false);
  });

  it("AC-52(a) §20.5.1 第 5 項文案與欄位路徑逐字（`field=annualTotalKm`）", () => {
    const [blocker] = computeDepreciationBlockers({
      applicationYear: 2026,
      annualTotalKm: d("100.0"),
      officialKm: d("200.00"),
      annualDepreciation: d("10.00"),
    });
    expect(blocker).toEqual({
      code: "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
      field: "annualTotalKm",
      message: "年度公務里程大於年度總里程，請檢查年度總里程",
    });
  });

  it("AC-22(c) §20.5.1 第 6 項文案逐字，且不具欄位路徑", () => {
    const [blocker] = computeDepreciationBlockers({
      applicationYear: 2026,
      annualTotalKm: d("1.0"),
      officialKm: d("1.00"),
      annualDepreciation: d("2147483648.00"),
    });
    expect(blocker).toEqual({
      code: "AMOUNT_OUT_OF_RANGE",
      message: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
    });
    expect(Object.hasOwn(blocker, "field")).toBe(false);
  });

  it("六碼聯集恰為 §20.5.1 表格之六碼（不多、不少——新增第七碼或改碼名必紅）", () => {
    const observed = new Set<string>();
    for (const applicationYear of [null, 2026]) {
      for (const annualTotalKm of [null, d("0"), d("100.0"), d("100000000")]) {
        for (const officialKm of [null, d("50.00"), d("100.00"), d("200000.00")]) {
          for (const annualDepreciation of [null, d("10.00"), d("9999999999.99")]) {
            for (const code of codes(
              computeDepreciationBlockers({
                applicationYear,
                annualTotalKm,
                officialKm,
                annualDepreciation,
              })
            )) {
              observed.add(code);
            }
          }
        }
      }
    }
    expect([...observed].sort()).toEqual([...ORDERED_CODES].sort());
  });

  it("AC-54(b) 退場碼於本檔零殘留：原始碼（含註解）零命中，且任何輸入組合皆不吐該碼（M13 之直接對象）", () => {
    const rawSource = fs.readFileSync(BLOCKERS_SRC_PATH, "utf8");
    expect(rawSource).not.toContain(RETIRED_ATTACHMENT_CODE);
    // 掃描自證：斷言確實具鑑別力（同一斷言施於含該碼之合成片段必命中）。
    expect(`code: "${RETIRED_ATTACHMENT_CODE}"`).toContain(RETIRED_ATTACHMENT_CODE);
    // 行為面：輸入不再具 `attachmentCount`，任何組合皆不可能產生該碼。
    const observed = new Set<string>();
    for (const applicationYear of [null, 2026]) {
      for (const annualTotalKm of [null, d("0"), d("100.0")]) {
        for (const officialKm of [null, d("50.00"), d("200.00")]) {
          for (const annualDepreciation of [null, d("10.00")]) {
            for (const code of codes(
              computeDepreciationBlockers({
                applicationYear,
                annualTotalKm,
                officialKm,
                annualDepreciation,
              })
            )) {
              observed.add(code);
            }
          }
        }
      }
    }
    expect(observed.has(RETIRED_ATTACHMENT_CODE)).toBe(false);
  });

  it("輸入形狀零殘留 `attachmentCount`：原始碼不再出現該識別字（附件計數參數移除之機械證明）", () => {
    const blanked = blankCommentsAndStrings(fs.readFileSync(BLOCKERS_SRC_PATH, "utf8"));
    expect(blanked).not.toMatch(/attachmentCount/);
  });

  it("純函式性質：同輸入同輸出、不變動輸入之 Decimal、不拋錯", () => {
    const annualTotalKm = d("12345.6");
    const officialKm = d("1234.56");
    const annualDepreciation = d("66666.67");
    const input: ComputeDepreciationBlockersInput = {
      applicationYear: 2026,
      annualTotalKm,
      officialKm,
      annualDepreciation,
    };
    const first = computeDepreciationBlockers(input);
    const second = computeDepreciationBlockers(input);
    expect(first).toEqual(second);
    expect(annualTotalKm.toString()).toBe("12345.6");
    expect(officialKm.toString()).toBe("1234.56");
    expect(annualDepreciation.toString()).toBe("66666.67");
  });
});

// ---------------------------------------------------------------------------
// §2 第一段（結構性，第 1~3 項）—— AC-53(b)(e) 判定層
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 第一段（結構性，§20.5.1 第 1~3 項）", () => {
  it("`applicationYear` 為 `null` → `YEAR_REQUIRED`；合法年度 → 無此碼（年度值域 [1900,2999] 屬驗證層，本檔不判定）", () => {
    expect(
      codes(computeDepreciationBlockers({ applicationYear: null, annualTotalKm: d("100.0") }))
    ).toEqual(["YEAR_REQUIRED"]);
    for (const applicationYear of [1900, 2026, 2999]) {
      expect(
        codes(computeDepreciationBlockers({ applicationYear, annualTotalKm: d("100.0") }))
      ).toEqual([]);
    }
  });

  it("AC-53(b) 判定層：`annualTotalKm` 為 `null` → `ANNUAL_TOTAL_KM_REQUIRED`（草稿寬容之預覽提示來源）", () => {
    expect(
      codes(computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm: null }))
    ).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
  });

  it("AC-53(e) 判定層：`annualTotalKm ≤ 0` → `ANNUAL_TOTAL_KM_INVALID`（API 路徑結構性不可達，防禦層不得移除）", () => {
    for (const annualTotalKm of [d("0"), d("0.0"), d("-0.1"), d("-12345.6")]) {
      expect(codes(computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm }))).toEqual([
        "ANNUAL_TOTAL_KM_INVALID",
      ]);
    }
  });

  it("AC-53(e) 保守失敗：非有限 `annualTotalKm`（`NaN`／`±Infinity`）一律 `ANNUAL_TOTAL_KM_INVALID`（M4 之直接對象）", () => {
    for (const annualTotalKm of [d("NaN"), d("Infinity"), d("-Infinity")]) {
      expect(codes(computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm }))).toEqual([
        "ANNUAL_TOTAL_KM_INVALID",
      ]);
    }
  });

  it("正例防誤殺：`annualTotalKm > 0`（含最小 1 位小數 `0.1`）→ 結構性通過", () => {
    for (const annualTotalKm of [d("0.1"), d("1"), d("12345.6"), d("99999999.9")]) {
      expect(codes(computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm }))).toEqual(
        []
      );
    }
  });

  it("§20.5.1 互斥：第 2 與第 3 項**永不**同時出現（`null` vs `≤0` 為互斥前提；M12 之直接對象）", () => {
    for (const annualTotalKm of [null, d("0"), d("-1"), d("NaN"), d("100.0")]) {
      const observed = codes(computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm }));
      expect(
        observed.includes("ANNUAL_TOTAL_KM_REQUIRED") &&
          observed.includes("ANNUAL_TOTAL_KM_INVALID")
      ).toBe(false);
    }
  });

  it("保守失敗（絕不拋錯）：`annualTotalKm` 為 `undefined`（呼叫端漏帶）折為 `ANNUAL_TOTAL_KM_REQUIRED`，不得於 `.isFinite()` 上拋錯", () => {
    const input = { applicationYear: 2026 } as unknown as ComputeDepreciationBlockersInput;
    expect(() => computeDepreciationBlockers(input)).not.toThrow();
    expect(codes(computeDepreciationBlockers(input))).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
  });

  it("§20.5 兩段式：第一段呼叫形狀 `{ applicationYear, annualTotalKm }`（無公務里程／每年費用欄）即可使用", () => {
    expect(
      computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm: d("30000.0") })
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3 兩段式語意 —— `officialKm == null` 表「尚未查詢」，完全抑制第 4~6 項
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 兩段式（§20.5：結構性先算、非空即拒絕、不查詢）", () => {
  it("`officialKm=null`（尚未查詢）→ 完全抑制第 4~6 項，即使 `annualDepreciation` 亦為 `null`（M7 之直接對象）", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: null,
          annualDepreciation: null,
        })
      )
    ).toEqual([]);
  });

  it("`officialKm` 省略（`undefined`）等同 `null`（§20.5 之 `officialKm?: Decimal | null`）", () => {
    expect(codes(computeDepreciationBlockers({ ...PASSING_STRUCTURAL }))).toEqual([]);
    expect(
      codes(
        computeDepreciationBlockers({ ...PASSING_STRUCTURAL, annualDepreciation: d("10000.00") })
      )
    ).toEqual([]);
  });

  it("結構性未通過時，第 4~6 項**完全不評估**——即使里程與每年費用已帶入且必然超出容量／比例（M1 之直接對象）", () => {
    const computed = { officialKm: d("9999999999.99"), annualDepreciation: d("9999999999.99") };
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: null,
          annualTotalKm: d("100.0"),
          ...computed,
        })
      )
    ).toEqual(["YEAR_REQUIRED"]);
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm: null, ...computed })
      )
    ).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: 2026, annualTotalKm: d("0"), ...computed })
      )
    ).toEqual(["ANNUAL_TOTAL_KM_INVALID"]);
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: null, annualTotalKm: null, ...computed })
      )
    ).toEqual(["YEAR_REQUIRED", "ANNUAL_TOTAL_KM_REQUIRED"]);
  });

  it("結構性未通過時，第 4 項亦不評估（缺參數 ＋ 缺年度 → 僅回 `YEAR_REQUIRED`）", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: null,
          annualTotalKm: d("100.0"),
          officialKm: d("50.00"),
          annualDepreciation: null,
        })
      )
    ).toEqual(["YEAR_REQUIRED"]);
  });
});

// ---------------------------------------------------------------------------
// §4 AC-16(b)／AC-18 —— PARAMETER_NOT_AVAILABLE（第 4 項）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — AC-16(b)/AC-18 缺參數（第 4 項）", () => {
  it("AC-16(b): PARAMETER_NOT_AVAILABLE blocker is produced when no effective version exists", () => {
    const result = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("12345.67"),
      annualDepreciation: null,
    });
    expect(codes(result)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
  });

  it("AC-18: deriveAnnualDepreciation ok:false is mapped to the same PARAMETER_NOT_AVAILABLE blocker (呼叫端以 `annualDepreciation=null` 表達；本層不區分兩來源——訊息互異之義務在完成端點 409 body)", () => {
    const noVersion = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      annualDepreciation: null,
    });
    const derivationFailed = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      annualDepreciation: null,
    });
    expect(noVersion).toEqual(derivationFailed);
    expect(codes(noVersion)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
  });

  it("AC-18 絕不以每年費用 0 完成：`annualDepreciation=null` 不得被當成 `0` 而靜默通過（零 blocker）", () => {
    const missing = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      annualDepreciation: null,
    });
    const zeroCost = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      annualDepreciation: d("0.00"),
    });
    expect(codes(missing)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
    // 每年費用真的是 0（合法 Decimal）時可計算 → 無 blocker，兩者不可混同。
    expect(codes(zeroCost)).toEqual([]);
  });

  it("§20.5.1 互斥 ＋ FW-1：缺參數時 `blockingCodes` **恰一碼**，不含第 5／6 項（不得順手跑比例守門或容量 predicate；M2 之直接對象）", () => {
    for (const officialKm of [
      d("0"),
      d("100.00"),
      d("99999.00"), // 超出 annualTotalKm（第 5 項之觸發值），但無每年費用即不評估
      d("99999999999999"), // 已超 snapshotOfficialKm 容量
      d("NaN"),
      d("Infinity"),
    ]) {
      const result = computeDepreciationBlockers({
        ...PASSING_STRUCTURAL,
        officialKm,
        annualDepreciation: null,
      });
      expect(codes(result)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
    }
  });
});

// ---------------------------------------------------------------------------
// §5 AC-52 —— OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM（第 5 項，比例 > 100%）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — AC-52 比例守門（第 5 項）", () => {
  it("AC-52(a): officialKm > annualTotalKm produces OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM with field=annualTotalKm", () => {
    const result = computeDepreciationBlockers({
      applicationYear: 2026,
      annualTotalKm: d("10000.0"),
      officialKm: d("10000.01"),
      annualDepreciation: d("50000.00"),
    });
    expect(codes(result)).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM"]);
    expect(result[0]?.field).toBe("annualTotalKm");
  });

  it("AC-52(b) 邊界: ratio 恰 100%（`officialKm == annualTotalKm`）is allowed to complete（`>` 改 `>=` 必紅；M9 之直接對象）", () => {
    for (const [annualTotalKm, officialKm] of [
      ["10000.0", "10000.00"], // 不同 scale 之等值（Decimal 值比較，非字串比較）
      ["1.0", "1.00"],
      ["99999999.9", "99999999.90"],
    ] as const) {
      expect(
        codes(
          computeDepreciationBlockers({
            applicationYear: 2026,
            annualTotalKm: d(annualTotalKm),
            officialKm: d(officialKm),
            annualDepreciation: d("1000.00"),
          })
        )
      ).toEqual([]);
    }
  });

  it("AC-52(b) 邊界: `officialKm` 恰大 `0.01` → 擋（守門改為恆 `false` 必紅；M10 之直接對象）", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: 2026,
          annualTotalKm: d("10000.0"),
          officialKm: d("10000.01"),
          annualDepreciation: d("1000.00"),
        })
      )
    ).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM"]);
  });

  it("AC-52(c): 比較以兩里程之 `Decimal` 直接進行——取整後之 ratio 看似恰 100% 者仍須擋（M11 之直接對象）", () => {
    const annualTotalKm = d("1000000.0");
    const officialKm = d("1000000.01");
    // 鑑別力自證：6dp 之 ratio 顯示字串與 4dp 之百分比字串皆「看似」恰 100%。
    const computed = calculateDepreciation({
      annualDepreciation: d("100.00"),
      officialKm,
      annualTotalKm,
    });
    expect(computed.ratioString).toBe("1.000000");
    expect(computed.ratioPercentString).toBe("100.0000");
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: 2026,
          annualTotalKm,
          officialKm,
          annualDepreciation: d("100.00"),
        })
      )
    ).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM"]);
  });

  it("AC-52(c) 單一事實來源：blocker 之第 5 項與匯出 predicate `isOfficialKmExceedsAnnualTotalKm` 逐項一致（service 層不得就地重寫）", () => {
    const pairs: Array<[string, string]> = [
      ["10000.0", "0"],
      ["10000.0", "9999.99"],
      ["10000.0", "10000.00"],
      ["10000.0", "10000.01"],
      ["10000.0", "20000.00"],
      ["1000000.0", "1000000.01"],
      ["10000.0", "NaN"],
      ["10000.0", "Infinity"],
      ["10000.0", "-Infinity"],
    ];
    for (const [annualTotalKm, officialKm] of pairs) {
      const expected = isOfficialKmExceedsAnnualTotalKm(d(officialKm), d(annualTotalKm));
      const observed = codes(
        computeDepreciationBlockers({
          applicationYear: 2026,
          annualTotalKm: d(annualTotalKm),
          officialKm: d(officialKm),
          annualDepreciation: d("1000.00"),
        })
      );
      expect(observed.includes("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM")).toBe(expected);
    }
  });

  it("保守失敗：非有限 `officialKm` 視同超出（predicate 層），且絕不拋錯", () => {
    for (const officialKm of [d("NaN"), d("Infinity"), d("-Infinity")]) {
      expect(isOfficialKmExceedsAnnualTotalKm(officialKm, d("10000.0"))).toBe(true);
      expect(() =>
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm,
          annualDepreciation: d("1000.00"),
        })
      ).not.toThrow();
      expect(
        codes(
          computeDepreciationBlockers({
            ...PASSING_STRUCTURAL,
            officialKm,
            annualDepreciation: d("1000.00"),
          })
        )
      ).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM", "AMOUNT_OUT_OF_RANGE"]);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 AC-22(c)(d) —— AMOUNT_OUT_OF_RANGE（第 6 項；容量判定沿用 R2 predicate）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — AC-22(c)(d) 容量（第 6 項）", () => {
  it("AC-22(c): 超出容量時產生 `AMOUNT_OUT_OF_RANGE`，且與 R2 predicate 判定逐項一致（不得自建第二套判定）", () => {
    const cases: Array<{
      annualTotalKm: Prisma.Decimal;
      officialKm: Prisma.Decimal;
      annualDepreciation: Prisma.Decimal;
    }> = [
      { annualTotalKm: d("1.0"), officialKm: d("1.00"), annualDepreciation: d("0.00") },
      { annualTotalKm: d("12345.6"), officialKm: d("1001.66"), annualDepreciation: d("100000.00") },
      {
        annualTotalKm: d("1.0"),
        officialKm: d("1.00"),
        annualDepreciation: d("2147483647.00"),
      },
      {
        annualTotalKm: d("1.0"),
        officialKm: d("1.00"),
        annualDepreciation: d("2147483648.00"),
      },
      {
        annualTotalKm: d("99999999.9"),
        officialKm: d("1000.00"),
        annualDepreciation: d("0.00"),
      },
      {
        annualTotalKm: d("100000000"),
        officialKm: d("1000.00"),
        annualDepreciation: d("0.00"),
      },
      { annualTotalKm: d("1.0"), officialKm: d("1000.00"), annualDepreciation: d("1.00") },
      {
        annualTotalKm: d("10000.0"),
        officialKm: d("10000.00"),
        annualDepreciation: d("NaN"),
      },
    ];
    for (const input of cases) {
      const expectedOverCapacity = isDepreciationCalculationOverCapacity(
        calculateDepreciation(input)
      );
      const observed = codes(computeDepreciationBlockers({ applicationYear: 2026, ...input }));
      expect(observed.includes("AMOUNT_OUT_OF_RANGE")).toBe(expectedOverCapacity);
    }
  });

  it("AC-22(d) 邊界正例防誤殺：`int4` 上界 `2147483647` 通過、`2147483648` 拒絕", () => {
    const base = { applicationYear: 2026, annualTotalKm: d("1.0"), officialKm: d("1.00") };
    expect(
      codes(computeDepreciationBlockers({ ...base, annualDepreciation: d("2147483647.00") }))
    ).toEqual([]);
    expect(
      codes(computeDepreciationBlockers({ ...base, annualDepreciation: d("2147483648.00") }))
    ).toEqual(["AMOUNT_OUT_OF_RANGE"]);
  });

  it("AC-22(d) 邊界正例防誤殺（遷移 C-1）：`snapshotAnnualTotalKm` `Decimal(9,1)` 上界 `1e8 − ε` 通過、恰 `1e8` 拒絕", () => {
    // 每年費用取 0 使金額恆為 0（int4 恆通過），單獨鑑別年度總里程欄之容量邊界。
    const base = {
      applicationYear: 2026,
      officialKm: d("1000.00"),
      annualDepreciation: d("0.00"),
    };
    expect(codes(computeDepreciationBlockers({ ...base, annualTotalKm: d("99999999.9") }))).toEqual(
      []
    );
    expect(codes(computeDepreciationBlockers({ ...base, annualTotalKm: d("100000000") }))).toEqual([
      "AMOUNT_OUT_OF_RANGE",
    ]);
  });

  it("AC-22(d) 邊界正例防誤殺（遷移 C-2）：`snapshotRatio` `Decimal(9,6)` 上界 `1e3 − ε` 通過、恰 `1e3` 拒絕", () => {
    // 比例 999.99（< 1e3）與 1000（= 1e3）；兩者皆 > 100%，故第 5 項一併出現
    // （§20.5.1「第 5 與第 6 項可同時出現」）。
    const base = { applicationYear: 2026, annualTotalKm: d("1.0"), annualDepreciation: d("1.00") };
    expect(codes(computeDepreciationBlockers({ ...base, officialKm: d("999.99") }))).toEqual([
      "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
    ]);
    expect(codes(computeDepreciationBlockers({ ...base, officialKm: d("1000.00") }))).toEqual([
      "OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM",
      "AMOUNT_OUT_OF_RANGE",
    ]);
  });

  it("§20.5.1「第 5 與第 6 項可同時出現」且順序為 5 → 6（M3 之直接對象）", () => {
    const observed = codes(
      computeDepreciationBlockers({
        applicationYear: 2026,
        annualTotalKm: d("1.0"),
        officialKm: d("1000.00"),
        annualDepreciation: d("1.00"),
      })
    );
    expect(observed).toEqual(["OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM", "AMOUNT_OUT_OF_RANGE"]);
  });

  it("FW-8：容量閾值零第二份拷貝——原始碼不得出現任何容量魔術數或就地閾值推導（M6 之直接對象）", () => {
    const rawSource = fs.readFileSync(BLOCKERS_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    expect(blanked).not.toMatch(/2147483647|2147483648|1e10|10000000000/);
    expect(blanked).not.toMatch(/\.pow\(/);
    expect(blanked).not.toMatch(/\*\*/);
    expect(blanked).not.toMatch(/DEPRECIATION_COLUMN_CAPACITY/);
    // 正對照：確實 import 了 R2 之容量 predicate（單一判定來源）。
    expect(blanked).toMatch(
      /import\s*\{[^}]*isDepreciationCalculationOverCapacity[^}]*\}\s*from\s*/
    );
    expect(blanked).toMatch(/isDepreciationCalculationOverCapacity\(/);
    // 常數本身仍由 R2 匯出且為本檔判定之唯一事實來源（接線正對照）。
    expect(DEPRECIATION_COLUMN_CAPACITY.totalAmount.max).toBe(2147483647);
  });

  it("接線活體突變自證：若刪除 import 改以私有複製之閾值判定，上一條掃描必紅（此處以合成片段證明掃描具鑑別力）", () => {
    const privateCopy = blankCommentsAndStrings(
      ["function overCapacity(amount) {", "  return amount > 2147483647;", "}"].join("\n")
    );
    expect(privateCopy).toMatch(/2147483647/);
    const wired = blankCommentsAndStrings(
      'import { isDepreciationCalculationOverCapacity } from "./depreciation-calculation.js";'
    );
    expect(wired).toMatch(/isDepreciationCalculationOverCapacity/);
    expect(wired).not.toMatch(/2147483647/);
  });
});

// ---------------------------------------------------------------------------
// §7 三段互斥與順序穩定（§20.5.1 互斥段逐字；全組合機械守護）
// ---------------------------------------------------------------------------

const SWEEP_YEARS: Array<number | null> = [null, 2026, Number.NaN];
const SWEEP_ANNUAL_TOTAL_KMS: Array<Prisma.Decimal | null> = [
  null,
  d("0"),
  d("-1.0"),
  d("NaN"),
  d("Infinity"),
  d("1.0"),
  d("10000.0"),
  d("99999999.9"),
  d("100000000"),
];
const SWEEP_OFFICIAL_KMS: Array<Prisma.Decimal | null> = [
  null,
  d("0"),
  d("1.00"),
  d("1000.00"),
  d("10000.00"),
  d("10000.01"),
  d("NaN"),
];
const SWEEP_ANNUAL_DEPRECIATIONS: Array<Prisma.Decimal | null> = [
  null,
  d("0.00"),
  d("100000.00"),
  d("2147483648.00"),
  d("NaN"),
];

function sweep(
  visit: (input: ComputeDepreciationBlockersInput, blockers: Blocker[]) => void
): void {
  for (const applicationYear of SWEEP_YEARS) {
    for (const annualTotalKm of SWEEP_ANNUAL_TOTAL_KMS) {
      for (const officialKm of SWEEP_OFFICIAL_KMS) {
        for (const annualDepreciation of SWEEP_ANNUAL_DEPRECIATIONS) {
          const input: ComputeDepreciationBlockersInput = {
            applicationYear,
            annualTotalKm,
            officialKm,
            annualDepreciation,
          };
          visit(input, computeDepreciationBlockers(input));
        }
      }
    }
  }
}

describe("computeDepreciationBlockers — §20.5.1 三段互斥與順序穩定（全組合）", () => {
  it("六碼順序穩定：任何輸出之碼序必嚴格遞增於 §20.5.1 表格順序（M3 之全域守護）", () => {
    let observedOutputs = 0;
    sweep((_input, blockers) => {
      const indices = codes(blockers).map((code) => ORDERED_CODES.indexOf(code as never));
      expect(indices).not.toContain(-1);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1] as number);
      }
      if (blockers.length > 0) observedOutputs++;
    });
    expect(observedOutputs).toBeGreaterThan(0);
  });

  it("三段互斥：任一輸出僅落在 `{1,2|3}`／`{4}`／`{5,6}` 之單一段，且至多兩碼", () => {
    const seenShapes = new Set<string>();
    sweep((_input, blockers) => {
      const observed = codes(blockers);
      expect(observed.length).toBeLessThanOrEqual(2);
      const groupsHit = [STRUCTURAL_GROUP, PARAMETER_GROUP, COMPUTED_GROUP].filter((group) =>
        observed.some((code) => group.includes(code))
      );
      expect(groupsHit.length).toBeLessThanOrEqual(1);
      // 第 2 與第 3 項互斥。
      expect(
        observed.includes("ANNUAL_TOTAL_KM_REQUIRED") &&
          observed.includes("ANNUAL_TOTAL_KM_INVALID")
      ).toBe(false);
      seenShapes.add(observed.join("+"));
    });
    // sweep 有效性自證：三段與空集合皆有樣本（避免恆真 sweep）。
    expect(seenShapes.has("")).toBe(true);
    expect(seenShapes.has("YEAR_REQUIRED+ANNUAL_TOTAL_KM_REQUIRED")).toBe(true);
    expect(seenShapes.has("YEAR_REQUIRED+ANNUAL_TOTAL_KM_INVALID")).toBe(true);
    expect(seenShapes.has("PARAMETER_NOT_AVAILABLE")).toBe(true);
    expect(seenShapes.has("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM")).toBe(true);
    expect(seenShapes.has("AMOUNT_OUT_OF_RANGE")).toBe(true);
    expect(seenShapes.has("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM+AMOUNT_OUT_OF_RANGE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §8 不變式 sweep —— 「`calculable=false ⇒ 至少一 blocker`」走真實映射
//    （FW-2：不得只斷言 predicate 本身）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 不變式 sweep（§20.5：`calculable=false ⇒ blockingCodes 至少一項`）", () => {
  it("sweep：全組合下，第二段之空 blocker 清單 ⇔ 真實計算可行、比例未超限且未超出容量（映射由 production 函式產生，非測試自算）", () => {
    let phaseTwoCombinations = 0;
    let emptyInPhaseTwo = 0;
    sweep((input, blockers) => {
      const { applicationYear, annualTotalKm, officialKm, annualDepreciation } = input;
      const structuralOk =
        applicationYear !== null &&
        Number.isInteger(applicationYear) &&
        annualTotalKm !== null &&
        annualTotalKm !== undefined &&
        annualTotalKm.isFinite() &&
        annualTotalKm.greaterThan(0);

      if (!structuralOk) {
        // 結構性未過：必有至少一 blocker，且必不含第 4~6 項（兩段式）。
        expect(blockers.length).toBeGreaterThan(0);
        for (const code of [...PARAMETER_GROUP, ...COMPUTED_GROUP]) {
          expect(codes(blockers)).not.toContain(code);
        }
        return;
      }
      if (officialKm === null || officialKm === undefined) {
        // 第一段呼叫：空清單僅表示「結構性通過，可進行查詢」。
        expect(blockers).toEqual([]);
        return;
      }
      phaseTwoCombinations++;
      if (annualDepreciation === null || annualDepreciation === undefined) {
        expect(codes(blockers)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
        return;
      }
      const result = calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm });
      const exceeds = isOfficialKmExceedsAnnualTotalKm(officialKm, annualTotalKm);
      const overCapacity = isDepreciationCalculationOverCapacity(result);
      if (!result.calculable || overCapacity || exceeds) {
        // 不變式本體：不可計算（含非有限值）／比例超限／超容量 ⇒ 至少一 blocker。
        expect(blockers.length).toBeGreaterThan(0);
        expect(codes(blockers).includes("AMOUNT_OUT_OF_RANGE")).toBe(overCapacity);
        expect(codes(blockers).includes("OFFICIAL_KM_EXCEEDS_ANNUAL_TOTAL_KM")).toBe(exceeds);
      } else {
        expect(blockers).toEqual([]);
        emptyInPhaseTwo++;
      }
    });
    // sweep 有效性自證：確實走過第二段，且正負兩側皆有樣本（避免恆真 sweep）。
    expect(phaseTwoCombinations).toBeGreaterThan(0);
    expect(emptyInPhaseTwo).toBeGreaterThan(0);
    expect(emptyInPhaseTwo).toBeLessThan(phaseTwoCombinations);
  });

  it("不變式之最強形式：`calculateDepreciation` 回 `calculable=false` 之全部輸入，blocker 清單皆非空", () => {
    const nonFinite = [d("NaN"), d("Infinity"), d("-Infinity")];
    let checked = 0;
    for (const annualDepreciation of [...nonFinite, d("1000.00")]) {
      for (const officialKm of [...nonFinite, d("1000.00")]) {
        const annualTotalKm = d("10000.0");
        const result = calculateDepreciation({ annualDepreciation, officialKm, annualTotalKm });
        if (result.calculable) continue;
        checked++;
        const blockers = computeDepreciationBlockers({
          applicationYear: 2026,
          annualTotalKm,
          officialKm,
          annualDepreciation,
        });
        expect(blockers.length).toBeGreaterThan(0);
        expect(codes(blockers)).toContain("AMOUNT_OUT_OF_RANGE");
      }
    }
    expect(checked).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// §9 `Invalid Date`／`NaN` 防禦（保守失敗，不得靜默放行）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — `Invalid Date`／`NaN` 防禦", () => {
  it('`Invalid Date` 推導之年度（`new Date("nope").getUTCFullYear()` → `NaN`）→ `YEAR_REQUIRED`，不得靜默放行（M5 之直接對象）', () => {
    const invalidYear = new Date("not-a-date").getUTCFullYear();
    expect(Number.isNaN(invalidYear)).toBe(true);
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: invalidYear,
          annualTotalKm: d("10000.0"),
        })
      )
    ).toEqual(["YEAR_REQUIRED"]);
  });

  it("非整數／非有限年度（`NaN`／`±Infinity`／`2026.5`）一律 `YEAR_REQUIRED`（保守失敗）", () => {
    for (const applicationYear of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2026.5,
    ]) {
      expect(
        codes(computeDepreciationBlockers({ applicationYear, annualTotalKm: d("10000.0") }))
      ).toEqual(["YEAR_REQUIRED"]);
    }
  });

  it("非有限 `Decimal` 之每年費用於第二段一律 `AMOUNT_OUT_OF_RANGE`（predicate 於 `calculable=false` 回 `true`），絕不拋錯", () => {
    for (const annualDepreciation of [d("NaN"), d("Infinity"), d("-Infinity")]) {
      const input: ComputeDepreciationBlockersInput = {
        ...PASSING_STRUCTURAL,
        officialKm: d("1000.00"),
        annualDepreciation,
      };
      expect(() => computeDepreciationBlockers(input)).not.toThrow();
      expect(codes(computeDepreciationBlockers(input))).toEqual(["AMOUNT_OUT_OF_RANGE"]);
    }
  });
});

// ---------------------------------------------------------------------------
// §10 掃描 helper（AR-1 已登記之第五份拷貝——PHASE-011 抽共用候選）
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留）。做法沿用
 * CHORE-003-T3／PHASE-005a／PHASE-006／PHASE-007-T2／T3 之既有慣例。
 */
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe("掃描 helper 自證（鑑別力）", () => {
  it("挖空後保留可辨識之程式骨架，且註解散文消失", () => {
    const rawSource = fs.readFileSync(BLOCKERS_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    expect(blanked.trim().length).toBeGreaterThan(0);
    expect(blanked).toContain("export function computeDepreciationBlockers");
    expect(blanked).not.toContain("兩段式");
  });
});
