/**
 * PHASE-007-T3 — `computeDepreciationBlockers`（折舊完成度純函式，兩段式）
 *
 * Spec `docs/specs/PHASE-007.md`：
 *   §7.5 完成阻擋碼四碼與固定順序（1 `YEAR_REQUIRED`／2
 *        `DEPRECIATION_ATTACHMENT_REQUIRED`／3 `PARAMETER_NOT_AVAILABLE`／
 *        4 `AMOUNT_OUT_OF_RANGE`）＋兩段式定義＋不變式
 *        「`calculable=false ⇒ blockingCodes 至少一項`」
 *   §9.3 ②③④ 呼叫順序（②與③④之順序不可對調）
 *   §2 AC-16(b)（缺參數之草稿／預覽同步暴露）／AC-18（`deriveDepreciation`
 *        `ok:false` 視同缺參數同型）／AC-22(c)（草稿與預覽同步暴露容量
 *        blocker）／AC-24（判定層：`LINKED` 附件數 < 1）
 *   §11.1 單元測試重點列（四碼順序穩定／兩段式語意／不變式 sweep／
 *        `Invalid Date`／`NaN` 防禦）
 *
 * TDD 紅燈起點：本檔第一版於 `src/applications/depreciation-blockers.ts`
 * 尚不存在時撰寫，`import` 即失敗（Vitest 回報
 * `Failed to load url ../../src/applications/depreciation-blockers.js`），
 * 全檔紅；實作落地後轉綠。
 *
 * 本地已實跑之 mutant（實作完成後逐一改寫 `depreciation-blockers.ts`、執行
 * `npx vitest run test/unit/depreciation-blockers.test.ts
 *  test/unit/depreciation-calculation.test.ts`，確認轉紅後以原檔還原並複跑
 * 綠燈；八個 mutant 全數被殺，紅燈數見 Handoff）：
 *   M1 拆除第二段閘門（結構性未通過仍評估第 3/4 項）           → 3 紅
 *   M2 缺參數路徑「順手」再跑一次容量 predicate（FW-1 直接對象）→ 2 紅
 *   M3 §7.5 輸出順序對調（第 2 項排到第 1 項之前）             → 2 紅
 *   M4 附件判定改回裸 `count < 1`（拆除 `Number.isInteger` 防禦）→ 2 紅
 *   M5 年度判定改回裸 `=== null`（拆除 `NaN` 年度防禦）         → 3 紅
 *   M6 容量判定改為就地重寫閾值（第二份閾值拷貝，違 FW-8）      → 4 紅
 *   M7 拆除「尚未查詢」抑制（`officialKm=null` 仍評估第 3 項）  → 7 紅
 *   M8 第 2 項 zh-TW 文案漂移                                   → 1 紅
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

/** 第一段（結構性）全通過之基準輸入。 */
const PASSING_STRUCTURAL: ComputeDepreciationBlockersInput = {
  applicationYear: 2026,
  attachmentCount: 1,
};

// ---------------------------------------------------------------------------
// §1 四碼固定順序與文案（§7.5 表格逐字；006 T3「零文案差異」義務同型）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — §7.5 四碼、固定順序與 zh-TW 文案", () => {
  it("§7.5 順序 1/2：結構性兩碼同時未過時，依表格順序輸出（不可只回第一項）", () => {
    const result = computeDepreciationBlockers({ applicationYear: null, attachmentCount: 0 });
    expect(codes(result)).toEqual(["YEAR_REQUIRED", "DEPRECIATION_ATTACHMENT_REQUIRED"]);
  });

  it("§7.5 第 1 項文案與欄位路徑逐字（006 T3 AR-2 教訓：`Blocker.field` 零斷言即隱形）", () => {
    const [blocker] = computeDepreciationBlockers({ applicationYear: null, attachmentCount: 1 });
    expect(blocker).toEqual({
      code: "YEAR_REQUIRED",
      field: "applicationYear",
      message: "請選擇申請年度",
    });
  });

  it("§7.5 第 2 項文案逐字，且**不具**欄位路徑（附件非表單欄位——§7.5「`fields[]` 僅具欄位路徑者」）", () => {
    const [blocker] = computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 0 });
    expect(blocker).toEqual({
      code: "DEPRECIATION_ATTACHMENT_REQUIRED",
      message: "請至少上傳 1 張折舊證明",
    });
    expect(Object.hasOwn(blocker, "field")).toBe(false);
  });

  it("AC-16(b) §7.5 第 3 項文案逐字，且不具欄位路徑", () => {
    const [blocker] = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("1000.00"),
      perKmUnitPrice: null,
    });
    expect(blocker).toEqual({
      code: "PARAMETER_NOT_AVAILABLE",
      message: "該年度尚無有效折舊參數，請聯絡管理員設定",
    });
    expect(Object.hasOwn(blocker, "field")).toBe(false);
  });

  it("AC-22(c) §7.5 第 4 項文案逐字，且不具欄位路徑", () => {
    const [blocker] = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("9999999999.99"),
      perKmUnitPrice: d("1.0000"),
    });
    expect(blocker).toEqual({
      code: "AMOUNT_OUT_OF_RANGE",
      message: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
    });
    expect(Object.hasOwn(blocker, "field")).toBe(false);
  });

  it("四碼聯集恰為 §7.5 表格之四碼（不多、不少——新增第五碼或改碼名必紅）", () => {
    const observed = new Set<string>();
    for (const year of [null, 2026]) {
      for (const attachmentCount of [0, 1]) {
        for (const officialKm of [null, d("1000.00"), d("9999999999.99")]) {
          for (const perKmUnitPrice of [null, d("1.0000")]) {
            for (const code of codes(
              computeDepreciationBlockers({
                applicationYear: year,
                attachmentCount,
                officialKm,
                perKmUnitPrice,
              })
            )) {
              observed.add(code);
            }
          }
        }
      }
    }
    expect([...observed].sort()).toEqual([
      "AMOUNT_OUT_OF_RANGE",
      "DEPRECIATION_ATTACHMENT_REQUIRED",
      "PARAMETER_NOT_AVAILABLE",
      "YEAR_REQUIRED",
    ]);
  });

  it("純函式性質：同輸入同輸出、不變動輸入之 Decimal、不拋錯", () => {
    const officialKm = d("1234.56");
    const perKmUnitPrice = d("6.6667");
    const input: ComputeDepreciationBlockersInput = {
      ...PASSING_STRUCTURAL,
      officialKm,
      perKmUnitPrice,
    };
    const first = computeDepreciationBlockers(input);
    const second = computeDepreciationBlockers(input);
    expect(first).toEqual(second);
    expect(officialKm.toString()).toBe("1234.56");
    expect(perKmUnitPrice.toString()).toBe("6.6667");
  });
});

// ---------------------------------------------------------------------------
// §2 第一段（結構性）判定 —— AC-24 判定層
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 第一段（結構性，§9.3 ②）", () => {
  it("AC-24 判定層：`LINKED` 附件數 < 1 → `DEPRECIATION_ATTACHMENT_REQUIRED`；≥ 1 → 無此碼", () => {
    expect(
      codes(computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 0 }))
    ).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
    expect(
      codes(computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 1 }))
    ).toEqual([]);
    expect(
      codes(computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 5 }))
    ).toEqual([]);
  });

  it("`applicationYear` 為 `null` → `YEAR_REQUIRED`；合法年度 → 無此碼（年度值域 [1900,2999] 屬 T4 驗證層，本檔不判定）", () => {
    expect(
      codes(computeDepreciationBlockers({ applicationYear: null, attachmentCount: 1 }))
    ).toEqual(["YEAR_REQUIRED"]);
    for (const year of [1900, 2026, 2999]) {
      expect(
        codes(computeDepreciationBlockers({ applicationYear: year, attachmentCount: 1 }))
      ).toEqual([]);
    }
  });

  it("§9.3 ②：第一段呼叫形狀 `{ applicationYear, attachmentCount }`（無里程／單價欄）即可使用，結構性全通過回空陣列", () => {
    expect(computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 3 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3 兩段式語意 —— `null` 表「尚未查詢」，完全抑制第 3/4 項
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 兩段式（§7.5／§9.3 ②與③④之順序不可對調）", () => {
  it("`officialKm=null`（尚未查詢）→ 完全抑制第 3/4 項，即使 `perKmUnitPrice` 亦為 `null`", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: null,
          perKmUnitPrice: null,
        })
      )
    ).toEqual([]);
  });

  it("`officialKm` 省略（`undefined`）等同 `null`（§7.5 之 `officialKm?: Decimal | null`）", () => {
    expect(codes(computeDepreciationBlockers({ ...PASSING_STRUCTURAL }))).toEqual([]);
    expect(
      codes(computeDepreciationBlockers({ ...PASSING_STRUCTURAL, perKmUnitPrice: d("1.0000") }))
    ).toEqual([]);
  });

  it("結構性未通過時，第 3/4 項**完全不評估**——即使里程與單價已帶入且必然超出容量（M1 之直接對象）", () => {
    const overCapacity = { officialKm: d("9999999999.99"), perKmUnitPrice: d("1.0000") };
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: null, attachmentCount: 1, ...overCapacity })
      )
    ).toEqual(["YEAR_REQUIRED"]);
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: 2026, attachmentCount: 0, ...overCapacity })
      )
    ).toEqual(["DEPRECIATION_ATTACHMENT_REQUIRED"]);
    expect(
      codes(
        computeDepreciationBlockers({ applicationYear: null, attachmentCount: 0, ...overCapacity })
      )
    ).toEqual(["YEAR_REQUIRED", "DEPRECIATION_ATTACHMENT_REQUIRED"]);
  });

  it("結構性未通過時，第 3 項亦不評估（缺參數 ＋ 缺年度 → 僅回 `YEAR_REQUIRED`）", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          applicationYear: null,
          attachmentCount: 1,
          officialKm: d("1000.00"),
          perKmUnitPrice: null,
        })
      )
    ).toEqual(["YEAR_REQUIRED"]);
  });
});

// ---------------------------------------------------------------------------
// §4 AC-16(b)／AC-18 —— PARAMETER_NOT_AVAILABLE
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — AC-16(b)/AC-18 缺參數（第 3 項）", () => {
  it("AC-16(b): PARAMETER_NOT_AVAILABLE blocker is produced when no effective version exists", () => {
    const result = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("12345.67"),
      perKmUnitPrice: null,
    });
    expect(codes(result)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
  });

  it("AC-18: deriveDepreciation ok:false is mapped to the same PARAMETER_NOT_AVAILABLE blocker (呼叫端以 `perKmUnitPrice=null` 表達；本層不區分兩來源——訊息互異之義務在完成端點 409 body，屬 T7/T9)", () => {
    // 兩來源（查無有效版本／推導失敗）於呼叫端皆折算為 `perKmUnitPrice=null`，
    // 故本層輸出全等——AC-18「視同缺參數同型拒絕」逐字。
    const noVersion = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      perKmUnitPrice: null,
    });
    const derivationFailed = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      perKmUnitPrice: null,
    });
    expect(noVersion).toEqual(derivationFailed);
    expect(codes(noVersion)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
  });

  it("AC-18 絕不以單價 0 完成：`perKmUnitPrice=null` 不得被當成 `0` 而靜默通過（零 blocker）", () => {
    const missing = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      perKmUnitPrice: null,
    });
    const zeroPrice = computeDepreciationBlockers({
      ...PASSING_STRUCTURAL,
      officialKm: d("100.00"),
      perKmUnitPrice: d("0.0000"),
    });
    expect(codes(missing)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
    // 單價真的是 0（合法 Decimal）時可計算 → 無 blocker，兩者不可混同。
    expect(codes(zeroPrice)).toEqual([]);
  });

  it("T2 即審 FW-1：缺參數時 `blockingCodes` **不含** `AMOUNT_OUT_OF_RANGE`（不得順手跑容量 predicate 多吐一碼；M2 之直接對象）", () => {
    for (const officialKm of [
      d("0"),
      d("1000.00"),
      d("9999999999.99"), // 本身合法，但無單價即無從計算金額
      d("99999999999999"), // 已超 snapshotOfficialKm 容量
      d("NaN"),
      d("Infinity"),
    ]) {
      const result = computeDepreciationBlockers({
        ...PASSING_STRUCTURAL,
        officialKm,
        perKmUnitPrice: null,
      });
      expect(codes(result)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
      expect(codes(result)).not.toContain("AMOUNT_OUT_OF_RANGE");
    }
  });
});

// ---------------------------------------------------------------------------
// §5 AC-22(c) —— AMOUNT_OUT_OF_RANGE（容量判定一律沿用 T2 predicate）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — AC-22(c) 容量（第 4 項）", () => {
  it("AC-22(c): 超出容量時產生 `AMOUNT_OUT_OF_RANGE`，且與 T2 predicate 判定逐項一致（W-3 語意沿用，不得自建第二套判定）", () => {
    const cases: Array<{ officialKm: Prisma.Decimal; perKmUnitPrice: Prisma.Decimal }> = [
      { officialKm: d("0"), perKmUnitPrice: d("0") },
      { officialKm: d("1000.00"), perKmUnitPrice: d("6.6667") },
      { officialKm: d("2147483647"), perKmUnitPrice: d("1.0000") },
      { officialKm: d("2147483648"), perKmUnitPrice: d("1.0000") },
      { officialKm: d("9999999999.99"), perKmUnitPrice: d("1.0000") },
      { officialKm: d("9999999999.9999"), perKmUnitPrice: d("0.0001") },
      { officialKm: d("10000000000"), perKmUnitPrice: d("0.0001") },
      { officialKm: d("1000"), perKmUnitPrice: d("9999999999.9999") },
      { officialKm: d("NaN"), perKmUnitPrice: d("1.0000") },
      { officialKm: d("Infinity"), perKmUnitPrice: d("1.0000") },
      { officialKm: d("1000.00"), perKmUnitPrice: d("NaN") },
    ];
    for (const input of cases) {
      const expectedOverCapacity = isDepreciationCalculationOverCapacity(
        calculateDepreciation(input)
      );
      const observed = codes(computeDepreciationBlockers({ ...PASSING_STRUCTURAL, ...input }));
      expect(observed.includes("AMOUNT_OUT_OF_RANGE")).toBe(expectedOverCapacity);
      expect(observed).toEqual(expectedOverCapacity ? ["AMOUNT_OUT_OF_RANGE"] : []);
    }
  });

  it("AC-22(d) 邊界正例防誤殺：`int4` 上界 `2147483647` 通過、`2147483648` 拒絕", () => {
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: d("2147483647"),
          perKmUnitPrice: d("1.0000"),
        })
      )
    ).toEqual([]);
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: d("2147483648"),
          perKmUnitPrice: d("1.0000"),
        })
      )
    ).toEqual(["AMOUNT_OUT_OF_RANGE"]);
  });

  it("AC-22(d) 邊界正例防誤殺：`Decimal(14,4)` 上界 `1e10 − ε` 通過、恰 `1e10` 拒絕（單價欄）", () => {
    // 里程取 0 使金額恆為 0（int4 恆通過），單獨鑑別單價欄之容量邊界。
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: d("0"),
          perKmUnitPrice: d("9999999999.9999"),
        })
      )
    ).toEqual([]);
    expect(
      codes(
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm: d("0"),
          perKmUnitPrice: d("10000000000"),
        })
      )
    ).toEqual(["AMOUNT_OUT_OF_RANGE"]);
  });

  it("T2 即審 FW-8：容量閾值零第二份拷貝——原始碼不得出現任何容量魔術數或就地閾值推導（M6 之直接對象）", () => {
    const rawSource = fs.readFileSync(BLOCKERS_SRC_PATH, "utf8");
    const blanked = blankCommentsAndStrings(rawSource);
    // 閾值字面（1e10 / 2147483647 / 2147483648 / 10 ** n / .pow(）一律不得出現。
    expect(blanked).not.toMatch(/2147483647|2147483648|1e10|10000000000/);
    expect(blanked).not.toMatch(/\.pow\(/);
    expect(blanked).not.toMatch(/\*\*/);
    expect(blanked).not.toMatch(/DEPRECIATION_COLUMN_CAPACITY/);
    // 正對照：確實 import 了 T2 之容量 predicate（W-3 單一判定來源）。
    expect(blanked).toMatch(
      /import\s*\{[^}]*isDepreciationCalculationOverCapacity[^}]*\}\s*from\s*/
    );
    expect(blanked).toMatch(/isDepreciationCalculationOverCapacity\(/);
    // 常數本身仍由 T2 匯出且為本檔判定之唯一事實來源（接線正對照）。
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
// §6 不變式 sweep —— 「`calculable=false ⇒ 至少一 blocker`」走真實映射
//    （T2 即審 FW-2：不得只斷言 predicate 本身）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — 不變式 sweep（§7.5：`calculable=false ⇒ blockingCodes 至少一項`）", () => {
  const years: Array<number | null> = [null, 2026, Number.NaN];
  const attachmentCounts: number[] = [0, 1, Number.NaN];
  const officialKms: Array<Prisma.Decimal | null> = [
    null,
    d("0"),
    d("1000.50"),
    d("9999999999.99"),
    d("99999999999999"),
    d("NaN"),
    d("Infinity"),
  ];
  const perKmUnitPrices: Array<Prisma.Decimal | null> = [
    null,
    d("0"),
    d("6.6667"),
    d("9999999999.9999"),
    d("10000000000"),
    d("NaN"),
  ];

  it("sweep：全組合下，第二段之空 blocker 清單 ⇔ 真實計算可行且未超出容量（映射由 production 函式產生，非測試自算）", () => {
    let phaseTwoCombinations = 0;
    let emptyInPhaseTwo = 0;
    for (const applicationYear of years) {
      for (const attachmentCount of attachmentCounts) {
        for (const officialKm of officialKms) {
          for (const perKmUnitPrice of perKmUnitPrices) {
            const blockers = computeDepreciationBlockers({
              applicationYear,
              attachmentCount,
              officialKm,
              perKmUnitPrice,
            });
            const structuralOk =
              applicationYear !== null &&
              Number.isInteger(applicationYear) &&
              Number.isInteger(attachmentCount) &&
              attachmentCount >= 1;

            if (!structuralOk) {
              // 結構性未過：必有至少一 blocker，且必不含第 3/4 項（兩段式）。
              expect(blockers.length).toBeGreaterThan(0);
              expect(codes(blockers)).not.toContain("PARAMETER_NOT_AVAILABLE");
              expect(codes(blockers)).not.toContain("AMOUNT_OUT_OF_RANGE");
              continue;
            }
            if (officialKm === null) {
              // 第一段呼叫：空清單僅表示「結構性通過，可進行查詢」。
              expect(blockers).toEqual([]);
              continue;
            }
            phaseTwoCombinations++;
            if (perKmUnitPrice === null) {
              expect(codes(blockers)).toEqual(["PARAMETER_NOT_AVAILABLE"]);
              continue;
            }
            const result = calculateDepreciation({ officialKm, perKmUnitPrice });
            const unusable = !result.calculable || isDepreciationCalculationOverCapacity(result);
            if (unusable) {
              // 不變式本體：不可計算（含非有限值）或超容量 ⇒ 至少一 blocker。
              expect(blockers.length).toBeGreaterThan(0);
              expect(codes(blockers)).toContain("AMOUNT_OUT_OF_RANGE");
            } else {
              expect(blockers).toEqual([]);
              emptyInPhaseTwo++;
            }
          }
        }
      }
    }
    // sweep 有效性自證：確實走過第二段，且正負兩側皆有樣本（避免恆真 sweep）。
    expect(phaseTwoCombinations).toBeGreaterThan(0);
    expect(emptyInPhaseTwo).toBeGreaterThan(0);
    expect(emptyInPhaseTwo).toBeLessThan(phaseTwoCombinations);
  });

  it("不變式之最強形式：`calculateDepreciation` 回 `calculable=false` 之全部輸入，blocker 清單皆非空", () => {
    const nonFinite = [d("NaN"), d("Infinity"), d("-Infinity")];
    let checked = 0;
    for (const officialKm of [...nonFinite, d("1000.00")]) {
      for (const perKmUnitPrice of [...nonFinite, d("1.0000")]) {
        const result = calculateDepreciation({ officialKm, perKmUnitPrice });
        if (result.calculable) continue;
        checked++;
        const blockers = computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm,
          perKmUnitPrice,
        });
        expect(blockers.length).toBeGreaterThan(0);
        expect(codes(blockers)).toEqual(["AMOUNT_OUT_OF_RANGE"]);
      }
    }
    expect(checked).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// §7 `Invalid Date`／`NaN` 防禦（保守失敗，不得靜默放行）
// ---------------------------------------------------------------------------

describe("computeDepreciationBlockers — `Invalid Date`／`NaN` 防禦", () => {
  it('`Invalid Date` 推導之年度（`new Date("nope").getUTCFullYear()` → `NaN`）→ `YEAR_REQUIRED`，不得靜默放行（M5 之直接對象）', () => {
    const invalidYear = new Date("not-a-date").getUTCFullYear();
    expect(Number.isNaN(invalidYear)).toBe(true);
    expect(
      codes(computeDepreciationBlockers({ applicationYear: invalidYear, attachmentCount: 1 }))
    ).toEqual(["YEAR_REQUIRED"]);
  });

  it("非整數／非有限年度（`NaN`／`Infinity`／`2026.5`）一律 `YEAR_REQUIRED`（保守失敗）", () => {
    for (const applicationYear of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2026.5,
    ]) {
      expect(codes(computeDepreciationBlockers({ applicationYear, attachmentCount: 1 }))).toEqual([
        "YEAR_REQUIRED",
      ]);
    }
  });

  it("非整數／非有限附件數一律 `DEPRECIATION_ATTACHMENT_REQUIRED`（`NaN < 1` 恆 `false` 之靜默放行缺口封閉；006 T3 AR-1 同型；M4 之直接對象）", () => {
    for (const attachmentCount of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(
        codes(computeDepreciationBlockers({ applicationYear: 2026, attachmentCount }))
      ).toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
    }
  });

  it("非有限 `Decimal`（`NaN`／`±Infinity`）於第二段一律 `AMOUNT_OUT_OF_RANGE`（W-3：predicate 於 `calculable=false` 回 `true`），絕不拋錯", () => {
    for (const officialKm of [d("NaN"), d("Infinity"), d("-Infinity")]) {
      expect(() =>
        computeDepreciationBlockers({
          ...PASSING_STRUCTURAL,
          officialKm,
          perKmUnitPrice: d("1.0000"),
        })
      ).not.toThrow();
      expect(
        codes(
          computeDepreciationBlockers({
            ...PASSING_STRUCTURAL,
            officialKm,
            perKmUnitPrice: d("1.0000"),
          })
        )
      ).toEqual(["AMOUNT_OUT_OF_RANGE"]);
    }
  });
});

// ---------------------------------------------------------------------------
// §8 掃描 helper（AR-1 已登記之第五份拷貝——PHASE-011 抽共用候選）
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留）。做法沿用
 * CHORE-003-T3／PHASE-005a／PHASE-006／PHASE-007-T2 之既有慣例。
 *
 * ※ T2 移交 W-5：本檔為第五份拷貝；抽共用會跨 Phase 改既有測試檔，超出本
 *   Task 之 Files Allowed（PHASE-011 候選）。
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
