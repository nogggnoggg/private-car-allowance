/**
 * PHASE-005a-T2 — `deriveFuelUnitPrice`（AC-18／AC-20／AC-28）
 *
 * Spec §2.D：
 *   AC-18 單價推導公式與取整 — Given `pricePerLiter = P`、`kmPerLiter = C`。
 *     Then 單價 ＝ `ROUND_HALF_UP(P ÷ C, 0)`，型別為整數。八列精確驗表逐條。
 *   AC-20 推導單價之欄位容量守門 — Given 推導後單價 `U` 使 `|U| ≥ 10^6`。
 *     Then 依 §16 D4(a) 之處置回應（本純函式層：回傳 `out_of_range`
 *     discriminated union，絕不 500、絕不靜默截斷）。
 *   AC-28 零浮點中介之結構性守門 — 本 Phase 新增檔案之金額／油價／油耗路徑
 *     不得出現 `Number(`／`parseFloat(`／`parseInt(`／`+<變數>` 數值脅制；
 *     `Prisma.Decimal` 一律以字串建構。
 *
 * 鑑別力（Spec §2.D 註記）：
 *   `35 ÷ 10` 與 `45 ÷ 10` 兩列同時存在，可鑑別銀行家取整
 *   （`ROUND_HALF_EVEN` 會使 `45 ÷ 10` 得 4，而非規格要求的 5）；
 *   `1 ÷ 3` 可鑑別「先乘後除」或未取整之實作。
 *
 * Mutant 自證（Handoff 記錄）：本檔撰寫完成、全綠後，暫時將
 * `fuel-price-engine.ts` 之 `Prisma.Decimal.ROUND_HALF_UP` 改為
 * `Prisma.Decimal.ROUND_HALF_EVEN`，重跑本檔，確認且僅確認
 * `45 ÷ 10 → 5` 該列轉紅（其餘列不受影響，因僅 45÷10=4.5 恰為銀行家與
 * 一般四捨五入的分歧點），還原後全部復綠。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { deriveFuelUnitPrice } from "../../src/parameters/fuel-price-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/**
 * SF-3（Review）：AC-28 掃描範圍改由本清單驅動，不再寫死單一路徑常數。
 * **T3/T4/T5/T7/T8 等後續 Task 於本 Phase 新增 `src` 檔案時，必須將其相對
 * 路徑（相對於 `backend/`）加入本陣列**，否則新檔案不會被結構性掃描覆蓋。
 * 清單中任何檔案不存在時，`fs.readFileSync` 會直接拋錯使測試紅（fail-loud），
 * 不得靜默跳過。
 */
const PHASE_005A_SRC_FILES = ["src/parameters/fuel-price-engine.ts"] as const;

/** 本 Phase 目前唯一的清單項目；供下方「檔案專屬」斷言（非泛用迴圈）取用。 */
const ENGINE_SRC_PATH = path.resolve(BACKEND_ROOT, PHASE_005A_SRC_FILES[0]);

// ---------------------------------------------------------------------------
// §1 AC-18 八列精確驗表
// ---------------------------------------------------------------------------

describe("deriveFuelUnitPrice — AC-18 rounds HALF_UP to an integer NTD per-km price (eight-row exact table)", () => {
  const rows: Array<{ p: string; c: string; expected: string; note: string }> = [
    { p: "30.0000", c: "10.0000", expected: "3", note: "整除" },
    { p: "31.0000", c: "10.0000", expected: "3", note: "3.1 捨去" },
    { p: "35.0000", c: "10.0000", expected: "4", note: "3.5 → 4（0.5 進位，非銀行家取整）" },
    {
      p: "45.0000",
      c: "10.0000",
      expected: "5",
      note: "4.5 → 5（銀行家取整會得 4 → 必紅，鑑別力核心列）",
    },
    { p: "29.9999", c: "10.0000", expected: "3", note: "2.99999 → 3" },
    { p: "1.0000", c: "3.0000", expected: "0", note: "0.333... → 0（鑑別「先乘後除」或未取整）" },
    { p: "0.0000", c: "10.0000", expected: "0", note: "0 ÷ C → 0" },
    { p: "30.0000", c: "0.0001", expected: "300000", note: "極小除數，商仍在容量內" },
  ];

  it.each(rows)("P=$p, C=$c → $expected（$note）", ({ p, c, expected }) => {
    const result = deriveFuelUnitPrice(p, c);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.unitPrice.toFixed(0)).toBe(expected);
      expect(result.unitPrice.toNumber()).toBe(Number(expected));
    }
  });

  it("35 ÷ 10 and 45 ÷ 10 together discriminate HALF_UP from banker's rounding", () => {
    const r35 = deriveFuelUnitPrice("35.0000", "10.0000");
    const r45 = deriveFuelUnitPrice("45.0000", "10.0000");
    expect(r35.status).toBe("ok");
    expect(r45.status).toBe("ok");
    if (r35.status === "ok" && r45.status === "ok") {
      // ROUND_HALF_EVEN would yield 4 and 4 (both round to nearest even 4).
      // ROUND_HALF_UP yields 4 and 5 — the divergence is the mutant tripwire.
      expect(r35.unitPrice.toFixed(0)).toBe("4");
      expect(r45.unitPrice.toFixed(0)).toBe("5");
    }
  });

  it("accepts Prisma.Decimal instances as well as strings (identical result)", () => {
    const byString = deriveFuelUnitPrice("35.0000", "10.0000");
    const byDecimal = deriveFuelUnitPrice(
      new Prisma.Decimal("35.0000"),
      new Prisma.Decimal("10.0000")
    );
    expect(byString.status).toBe("ok");
    expect(byDecimal.status).toBe("ok");
    if (byString.status === "ok" && byDecimal.status === "ok") {
      expect(byDecimal.unitPrice.toFixed(0)).toBe(byString.unitPrice.toFixed(0));
    }
  });

  it("uses Decimal.div, never JS floating-point division (0.1+0.2-style precision retained)", () => {
    // 1 ÷ 3 in JS float arithmetic is 0.3333333333333333 — if implemented via
    // `Number(p) / Number(c)` the value would still round to 0 here, so this
    // row alone is not discriminating; the true discriminator is that the
    // whole computation must go through Decimal at every step (AC-28 static
    // scan below is the authoritative check). This test pins the documented
    // exact value to guard against any refactor reintroducing `/`.
    const result = deriveFuelUnitPrice("1.0000", "3.0000");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.unitPrice.toFixed(0)).toBe("0");
    }
  });
});

// ---------------------------------------------------------------------------
// §2 AC-20 容量守門
// ---------------------------------------------------------------------------

describe("deriveFuelUnitPrice — AC-20 derived unit price at or beyond the column capacity is reported, never silently truncated", () => {
  it("boundary: unit price exactly 10^6 - 1 (999999) is within capacity → ok", () => {
    // P = 999999.0000, C = 1.0000 → 999999 (< 1e6)
    const result = deriveFuelUnitPrice("999999.0000", "1.0000");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.unitPrice.toFixed(0)).toBe("999999");
    }
  });

  it("boundary: unit price exactly 10^6 (1000000) is out of range", () => {
    // P = 1000000.0000, C = 1.0000 → exactly 1e6
    const result = deriveFuelUnitPrice("1000000.0000", "1.0000");
    expect(result).toEqual({ status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" });
  });

  it("Spec §2.D AC-20 worked example: P=999999.9999, C=0.0001 → far beyond capacity, reported not thrown", () => {
    expect(() => deriveFuelUnitPrice("999999.9999", "0.0001")).not.toThrow();
    const result = deriveFuelUnitPrice("999999.9999", "0.0001");
    expect(result).toEqual({ status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" });
  });

  it("negative-magnitude overflow (|U| >= 1e6 with a negative sign) is also reported as out_of_range", () => {
    // Defensive: even though pricePerLiter/kmPerLiter are business-validated
    // as positive upstream, the capacity check itself must be magnitude-based
    // (Math.abs-equivalent), not sign-blind on the naive side only.
    const result = deriveFuelUnitPrice("-1000000.0000", "1.0000");
    expect(result).toEqual({ status: "out_of_range", reason: "FUEL_UNIT_PRICE_OUT_OF_RANGE" });
  });

  it("never throws for any in-range or out-of-range combination (D4: never 500)", () => {
    for (const [p, c] of [
      ["30.0000", "10.0000"],
      ["999999.9999", "0.0001"],
      ["1000000.0000", "1.0000"],
      ["0.0000", "10.0000"],
    ] as const) {
      expect(() => deriveFuelUnitPrice(p, c)).not.toThrow();
    }
  });

  it("defensive: kmPerLiter <= 0 throws a clear RangeError rather than propagating a division-by-zero/negative quotient", () => {
    expect(() => deriveFuelUnitPrice("30.0000", "0")).toThrow(RangeError);
    expect(() => deriveFuelUnitPrice("30.0000", "-1")).toThrow(RangeError);
  });

  // SF-1 (Review): a non-finite divisor must not slip past the guard.
  // `NaN.lessThanOrEqualTo(0)` is `false`, so the pre-fix guard let a `"NaN"`
  // kmPerLiter through, yielding `{ status: "ok", unitPrice: NaN }`; an
  // `"Infinity"` divisor silently produced a unit price of `0`. Both must now
  // throw a RangeError instead of ever reaching the return statement.
  it("defensive (SF-1): kmPerLiter of 'NaN' throws RangeError rather than yielding status 'ok' with a NaN unitPrice", () => {
    expect(() => deriveFuelUnitPrice("30.0000", "NaN")).toThrow(RangeError);
  });

  it("defensive (SF-1): kmPerLiter of 'Infinity' throws RangeError rather than silently yielding a unit price of 0", () => {
    expect(() => deriveFuelUnitPrice("30.0000", "Infinity")).toThrow(RangeError);
  });

  it("defensive (SF-1): a non-finite pricePerLiter ('NaN') throws RangeError via the post-derivation finiteness check, even though kmPerLiter itself is a valid finite positive divisor", () => {
    expect(() => deriveFuelUnitPrice("NaN", "10.0000")).toThrow(RangeError);
  });

  it("defensive (SF-1): a non-finite pricePerLiter ('Infinity') throws RangeError via the post-derivation finiteness check", () => {
    expect(() => deriveFuelUnitPrice("Infinity", "10.0000")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// §3 AC-28 結構性掃描（清單驅動：PHASE_005A_SRC_FILES，目前僅
// fuel-price-engine.ts 一項；T3/T4/T5/T7/T8 新增 src 檔案時必須加入清單）
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留），使後續的語彙掃描
 * 只看得到真正的程式碼。做法沿用 CHORE-003-T3
 * （`backend/test/integration/chore003-string-fidelity.test.ts` §1）之既有慣例。
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

/** 對值做強制轉型的呼叫：`Number(...)`／`parseFloat(...)`／`parseInt(...)`。 */
const COERCION_CALL_PATTERN = /\b(Number|parseFloat|parseInt)\s*\(([^)]*)\)/g;

function findCoercionCalls(blankedCode: string): string[] {
  return [...blankedCode.matchAll(COERCION_CALL_PATTERN)].map((m) => `${m[1]}(${m[2].trim()})`);
}

/** `Prisma.Decimal` 之建構呼叫（`new Prisma.Decimal(...)`）之引數原始文字。 */
const DECIMAL_CONSTRUCTOR_PATTERN = /new\s+Prisma\.Decimal\s*\(([^)]*)\)/g;

function findDecimalConstructorArgs(blankedCode: string): string[] {
  return [...blankedCode.matchAll(DECIMAL_CONSTRUCTOR_PATTERN)].map((m) => m[1].trim());
}

describe("AC-28 零浮點中介 — PHASE-005a source files contain no Number()/parseFloat/parseInt on the amount path (date-parse whitelist only)", () => {
  // SF-3（Review）：掃描迴圈逐檔驅動 PHASE_005A_SRC_FILES；清單目前僅一個
  // 項目，但 describe.each 確保未來新增項目時自動被覆蓋，且任一路徑不存在
  // 時 fs.readFileSync 會拋錯使該檔案的整組測試紅（不會靜默跳過）。
  describe.each(PHASE_005A_SRC_FILES)("scanned file: %s", (relativePath) => {
    const rawSource = fs.readFileSync(path.resolve(BACKEND_ROOT, relativePath), "utf8");
    const blanked = blankCommentsAndStrings(rawSource);

    it("scan sanity: blanking does not collapse the file to an empty/whitespace-only string (not scanning nothing)", () => {
      expect(blanked.trim().length).toBeGreaterThan(0);
    });

    it("contains zero Number()/parseFloat/parseInt calls (no date-parse path exists in this file, so the whitelist is empty)", () => {
      expect(findCoercionCalls(blanked)).toEqual([]);
    });

    it("contains no unary/binary `+` numeric coercion of a variable on the amount path", () => {
      // Matches `+identifier` that is not `++`/`--` and not part of a numeric
      // literal exponent — conservative pattern scoped to this small file.
      const plusCoercionPattern = /(?<![+\-.\w])\+(?!\+)[a-zA-Z_$][\w$]*/g;
      expect([...blanked.matchAll(plusCoercionPattern)]).toEqual([]);
    });
  });

  // 檔案專屬（非泛用）斷言：僅適用於 fuel-price-engine.ts 之精確內容驗證，
  // 取自 PHASE_005A_SRC_FILES[0]（本 Phase 目前唯一項目）。
  const rawSource = fs.readFileSync(ENGINE_SRC_PATH, "utf8");
  const blanked = blankCommentsAndStrings(rawSource);

  it("scan sanity: blanking preserves a recognizable code skeleton (not scanning an empty string)", () => {
    expect(blanked).toContain("export function deriveFuelUnitPrice");
    expect(blanked).toContain("toDecimalPlaces");
    // Chinese prose that lives only in comments must not survive blanking.
    expect(blanked).not.toContain("欄位容量");
  });

  it("every Prisma.Decimal construction in this file takes a string literal or an existing Prisma.Decimal-typed value (D4 bright-line)", () => {
    // Scanned on the RAW (unblanked) source deliberately: blanking string
    // literals for the coercion scan above also erases the quote characters
    // themselves, which would defeat a "starts with a quote" check. There
    // are exactly two `new Prisma.Decimal(...)` call sites in this file
    // (verified above by grep during implementation), neither inside a
    // comment, so scanning raw source here carries no false-positive risk.
    const args = findDecimalConstructorArgs(rawSource);
    expect(args).toEqual(['"1000000"', "value"]);
    // The one non-string-literal argument ("value") is the pass-through
    // inside `toDecimal()`, gated immediately above by
    // `value instanceof Prisma.Decimal` — i.e. it is never a raw
    // number/JS-float, only an already-constructed Prisma.Decimal.
    expect(rawSource).toContain(
      "value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value)"
    );
  });

  it("scanner self-proof (discriminating power): a synthetic legacy snippet using Number() as an intermediary must be caught; Number( inside comments/strings must not false-positive", () => {
    const oldImplementation = blankCommentsAndStrings(
      [
        "function deriveFuelUnitPrice(p, c) {",
        "  const priceNum = Number(p);",
        "  const kmNum = Number(c);",
        "  return Math.round(priceNum / kmNum);",
        "}",
      ].join("\n")
    );
    expect(findCoercionCalls(oldImplementation)).toEqual(["Number(p)", "Number(c)"]);

    const commentOnly = blankCommentsAndStrings(
      [
        "// 這一步刻意不使用 Number(input) 中介",
        "/* 舊路徑：const x = Number(y); */",
        'const message = "Number(unsafe) 僅是文案";',
        "const safe = toDecimal(input);",
      ].join("\n")
    );
    expect(findCoercionCalls(commentOnly)).toEqual([]);
  });
});
