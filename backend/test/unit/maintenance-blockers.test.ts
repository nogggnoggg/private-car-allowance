/**
 * PHASE-006-T3 — `computeMaintenanceBlockers`（AC-07/08/09/10/18）
 *
 * Spec §2：
 *   AC-07 保養日期順序 — `本次 ≤ 上次`（含相等）→ `MAINTENANCE_DATE_ORDER_INVALID`；
 *     `本次 = 上次 + 1 日` 為最小合法鑑別案例。
 *   AC-08 里程表順序 — `本次 ≤ 上次`（含相等）→ `ODOMETER_ORDER_INVALID`；
 *     `本次 = 上次 + 0.01` 為最小合法鑑別案例。
 *   AC-09 費用值域 — `≤ 0`（含 `0`、`-0.01`）→ `ACTUAL_COST_INVALID`；`0.01`
 *     為最小合法鑑別案例。
 *   AC-10 回傳全部未通過項，§7.4 固定順序；`*_REQUIRED` 與同組
 *     `*_ORDER_INVALID` 互斥；officialKm=null 兩段式抑制第 9/11 項。
 *   AC-18 `期間公務里程 > 保養區間里程` → `OFFICIAL_KM_EXCEEDS_INTERVAL`；
 *     `O == I` 合法（恰 100%），`O = I + 0.01` 被擋；判定須以 Decimal 直接
 *     比較，不得以取整後之 ratio 比較（否則 `O = I + 0.0000001` 會被誤放行）。
 *
 * Mutant 自證（Handoff 記錄）：本檔撰寫完成、全綠後，實際執行下列兩項
 * 手動 mutant 驗證（暫改 `maintenance-blockers.ts`，重跑本檔，確認且僅確認
 * 對應測試轉紅，還原後全部復綠——詳見 Handoff）：
 *   (1) 比例比較 mutant — 將 AC-18 之 `officialKm.greaterThan(intervalKm)`
 *       改為「先各自四捨五入至 6 位小數字串再比較」（模擬誤用已取整 ratio
 *       比較），預期使 `officialKm = intervalKm + 0.0000001` 之鑑別測試轉紅
 *       （原本被擋，mutant 下會誤放行）。
 *   (2) 順序／互斥 mutant — 將 `MAINTENANCE_DATE_ORDER_INVALID` 之判定條件
 *       由 `lastMaintenanceDate !== null && currentMaintenanceDate !== null && ...`
 *       改為僅 `isDateOrderInvalid(...)`（移除互斥防護，NaN-safe 的
 *       `isInvalidDate` 內部保守 true 語意會使「僅缺上次日期」案例同時冒出
 *       `MAINTENANCE_DATE_ORDER_INVALID`），預期使 AC-10 互斥規則測試轉紅。
 */

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  type Blocker,
  type ComputeMaintenanceBlockersInput,
  computeMaintenanceBlockers,
} from "../../src/applications/maintenance-blockers.js";

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function codes(blockers: Blocker[]): string[] {
  return blockers.map((b) => b.code);
}

/** 基準合法輸入（全部欄位皆為最小合法鑑別值，attachmentCount=1，officialKm 未查詢）。 */
function validInput(
  overrides: Partial<ComputeMaintenanceBlockersInput> = {}
): ComputeMaintenanceBlockersInput {
  return {
    lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
    currentMaintenanceDate: new Date("2026-01-02T00:00:00.000Z"), // 上次 + 1 日
    lastOdometerKm: d("1000.00"),
    currentOdometerKm: d("1000.01"), // 上次 + 0.01
    actualCost: d("0.01"),
    attachmentCount: 1,
    officialKm: null,
    ...overrides,
  };
}

describe("computeMaintenanceBlockers — baseline: all fields minimally legal yields zero blockers", () => {
  it("returns an empty array when every field is at its minimal legal discriminating value", () => {
    expect(computeMaintenanceBlockers(validInput())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-07 — 保養日期順序
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — AC-07 current <= last maintenance date yields MAINTENANCE_DATE_ORDER_INVALID (equal and earlier)", () => {
  it("current === last is rejected", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
        currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    expect(codes(result)).toEqual(["MAINTENANCE_DATE_ORDER_INVALID"]);
  });

  it("current < last (earlier) is rejected", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("2026-01-05T00:00:00.000Z"),
        currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    expect(codes(result)).toEqual(["MAINTENANCE_DATE_ORDER_INVALID"]);
  });

  it("current = last + 1 day is accepted (discriminating positive, must not be falsely blocked)", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
        currentMaintenanceDate: new Date("2026-01-02T00:00:00.000Z"),
      })
    );
    expect(codes(result)).not.toContain("MAINTENANCE_DATE_ORDER_INVALID");
  });
});

// ---------------------------------------------------------------------------
// AC-08 — 里程表順序
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — AC-08 current <= last odometer yields ODOMETER_ORDER_INVALID (equal and smaller)", () => {
  it("current === last is rejected", () => {
    const result = computeMaintenanceBlockers(
      validInput({ lastOdometerKm: d("1000.00"), currentOdometerKm: d("1000.00") })
    );
    expect(codes(result)).toEqual(["ODOMETER_ORDER_INVALID"]);
  });

  it("current < last is rejected", () => {
    const result = computeMaintenanceBlockers(
      validInput({ lastOdometerKm: d("1000.00"), currentOdometerKm: d("999.99") })
    );
    expect(codes(result)).toEqual(["ODOMETER_ORDER_INVALID"]);
  });

  it("current = last + 0.01 is accepted (discriminating positive)", () => {
    const result = computeMaintenanceBlockers(
      validInput({ lastOdometerKm: d("1000.00"), currentOdometerKm: d("1000.01") })
    );
    expect(codes(result)).not.toContain("ODOMETER_ORDER_INVALID");
  });
});

// ---------------------------------------------------------------------------
// AC-09 — 費用值域
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — AC-09 actualCost <= 0 yields ACTUAL_COST_INVALID (0 and -0.01)", () => {
  it("actualCost === 0 is rejected", () => {
    const result = computeMaintenanceBlockers(validInput({ actualCost: d("0") }));
    expect(codes(result)).toEqual(["ACTUAL_COST_INVALID"]);
  });

  it("actualCost === -0.01 is rejected", () => {
    const result = computeMaintenanceBlockers(validInput({ actualCost: d("-0.01") }));
    expect(codes(result)).toEqual(["ACTUAL_COST_INVALID"]);
  });

  it("actualCost === 0.01 is accepted (discriminating positive)", () => {
    const result = computeMaintenanceBlockers(validInput({ actualCost: d("0.01") }));
    expect(codes(result)).not.toContain("ACTUAL_COST_INVALID");
  });
});

// ---------------------------------------------------------------------------
// §7.4 items 1/2/4/5/7/10 — REQUIRED codes (individually)
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — individual *_REQUIRED codes (§7.4 items 1/2/4/5/7/10)", () => {
  it("lastMaintenanceDate === null yields LAST_MAINTENANCE_DATE_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ lastMaintenanceDate: null }));
    expect(codes(result)).toEqual(["LAST_MAINTENANCE_DATE_REQUIRED"]);
  });

  it("currentMaintenanceDate === null yields CURRENT_MAINTENANCE_DATE_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ currentMaintenanceDate: null }));
    expect(codes(result)).toEqual(["CURRENT_MAINTENANCE_DATE_REQUIRED"]);
  });

  it("lastOdometerKm === null yields LAST_ODOMETER_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ lastOdometerKm: null }));
    expect(codes(result)).toEqual(["LAST_ODOMETER_REQUIRED"]);
  });

  it("currentOdometerKm === null yields CURRENT_ODOMETER_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ currentOdometerKm: null }));
    expect(codes(result)).toEqual(["CURRENT_ODOMETER_REQUIRED"]);
  });

  it("actualCost === null yields ACTUAL_COST_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ actualCost: null }));
    expect(codes(result)).toEqual(["ACTUAL_COST_REQUIRED"]);
  });

  it("attachmentCount < 1 yields MAINTENANCE_ATTACHMENT_REQUIRED only", () => {
    const result = computeMaintenanceBlockers(validInput({ attachmentCount: 0 }));
    expect(codes(result)).toEqual(["MAINTENANCE_ATTACHMENT_REQUIRED"]);
  });

  it("all zh-TW messages match the §7.4 recommended wording exactly", () => {
    expect(computeMaintenanceBlockers(validInput({ lastMaintenanceDate: null }))[0].message).toBe(
      "請填寫上次保養日期"
    );
    expect(
      computeMaintenanceBlockers(validInput({ currentMaintenanceDate: null }))[0].message
    ).toBe("請填寫本次保養日期");
    expect(
      computeMaintenanceBlockers(
        validInput({
          lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
          currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
        })
      )[0].message
    ).toBe("本次保養日期必須晚於上次保養日期");
    expect(computeMaintenanceBlockers(validInput({ lastOdometerKm: null }))[0].message).toBe(
      "請填寫上次里程表數值"
    );
    expect(computeMaintenanceBlockers(validInput({ currentOdometerKm: null }))[0].message).toBe(
      "請填寫本次里程表數值"
    );
    expect(
      computeMaintenanceBlockers(
        validInput({ lastOdometerKm: d("1000.00"), currentOdometerKm: d("1000.00") })
      )[0].message
    ).toBe("本次里程表數值必須大於上次里程表數值");
    expect(computeMaintenanceBlockers(validInput({ actualCost: null }))[0].message).toBe(
      "請填寫本次實際保養費用"
    );
    expect(computeMaintenanceBlockers(validInput({ actualCost: d("0") }))[0].message).toBe(
      "本次實際保養費用必須大於 0"
    );
    expect(computeMaintenanceBlockers(validInput({ attachmentCount: 0 }))[0].message).toBe(
      "請至少上傳 1 張保養證明"
    );
    expect(
      computeMaintenanceBlockers(
        validInput({ officialKm: d("100"), lastOdometerKm: d("0"), currentOdometerKm: d("10") })
      )[0].message
    ).toBe("期間公務里程大於保養區間里程，請檢查差旅、日期或里程資料");
    expect(
      computeMaintenanceBlockers(validInput({ officialKm: d("0"), amountOutOfRange: true }))[0]
        .message
    ).toBe("計算結果超出可儲存之金額範圍，請檢查里程與費用");
  });
});

// ---------------------------------------------------------------------------
// AC-10 — 回傳全部未通過項、§7.4 固定順序、互斥規則、兩段式
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — AC-10 returns EVERY unmet condition, never only the first, in the §7.4 fixed order", () => {
  it("all REQUIRED fields missing + zero attachments yields items 1,2,4,5,7,10 in that exact order (3/6/8 suppressed, 9/11 suppressed by two-phase)", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: null,
        currentMaintenanceDate: null,
        lastOdometerKm: null,
        currentOdometerKm: null,
        actualCost: null,
        attachmentCount: 0,
        officialKm: null,
      })
    );
    expect(codes(result)).toEqual([
      "LAST_MAINTENANCE_DATE_REQUIRED",
      "CURRENT_MAINTENANCE_DATE_REQUIRED",
      "LAST_ODOMETER_REQUIRED",
      "CURRENT_ODOMETER_REQUIRED",
      "ACTUAL_COST_REQUIRED",
      "MAINTENANCE_ATTACHMENT_REQUIRED",
    ]);
  });

  it("all fields present but all relational/value checks violated + zero attachments yields items 3,6,8,10 in that exact order", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("2026-01-05T00:00:00.000Z"),
        currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
        lastOdometerKm: d("1000.00"),
        currentOdometerKm: d("999.00"),
        actualCost: d("-0.01"),
        attachmentCount: 0,
        officialKm: null,
      })
    );
    expect(codes(result)).toEqual([
      "MAINTENANCE_DATE_ORDER_INVALID",
      "ODOMETER_ORDER_INVALID",
      "ACTUAL_COST_INVALID",
      "MAINTENANCE_ATTACHMENT_REQUIRED",
    ]);
  });

  it("shuffled violation combination still comes back in the fixed §7.4 order, not input order", () => {
    // 刻意以「後面欄位缺、前面欄位正常」的組合輸入，驗證輸出順序恆依表格
    // 順序而非物件屬性宣告順序或違規發生順序。
    const result = computeMaintenanceBlockers(
      validInput({
        actualCost: null, // item 7
        lastMaintenanceDate: null, // item 1
        attachmentCount: 0, // item 10
        currentOdometerKm: null, // item 5
      })
    );
    expect(codes(result)).toEqual([
      "LAST_MAINTENANCE_DATE_REQUIRED",
      "CURRENT_ODOMETER_REQUIRED",
      "ACTUAL_COST_REQUIRED",
      "MAINTENANCE_ATTACHMENT_REQUIRED",
    ]);
  });

  it("full second-phase call with a 9+10+11 combination preserves fixed order 9 before 10 before 11", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("10.00"), // intervalKm = 10
        officialKm: d("10.01"), // > intervalKm → item 9
        attachmentCount: 0, // item 10
        amountOutOfRange: true, // item 11
      })
    );
    expect(codes(result)).toEqual([
      "OFFICIAL_KM_EXCEEDS_INTERVAL",
      "MAINTENANCE_ATTACHMENT_REQUIRED",
      "AMOUNT_OUT_OF_RANGE",
    ]);
  });

  it("AC-10 mutual exclusion: a missing field never also reports its ORDER_INVALID counterpart (date pair)", () => {
    const onlyLastMissing = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: null,
        currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    expect(codes(onlyLastMissing)).toEqual(["LAST_MAINTENANCE_DATE_REQUIRED"]);
    expect(codes(onlyLastMissing)).not.toContain("MAINTENANCE_DATE_ORDER_INVALID");

    const onlyCurrentMissing = computeMaintenanceBlockers(
      validInput({
        currentMaintenanceDate: null,
        lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    expect(codes(onlyCurrentMissing)).toEqual(["CURRENT_MAINTENANCE_DATE_REQUIRED"]);
    expect(codes(onlyCurrentMissing)).not.toContain("MAINTENANCE_DATE_ORDER_INVALID");
  });

  it("AC-10 mutual exclusion: a missing field never also reports its ORDER_INVALID counterpart (odometer pair)", () => {
    const onlyLastMissing = computeMaintenanceBlockers(
      validInput({ lastOdometerKm: null, currentOdometerKm: d("1000.00") })
    );
    expect(codes(onlyLastMissing)).toEqual(["LAST_ODOMETER_REQUIRED"]);
    expect(codes(onlyLastMissing)).not.toContain("ODOMETER_ORDER_INVALID");

    const onlyCurrentMissing = computeMaintenanceBlockers(
      validInput({ currentOdometerKm: null, lastOdometerKm: d("1000.00") })
    );
    expect(codes(onlyCurrentMissing)).toEqual(["CURRENT_ODOMETER_REQUIRED"]);
    expect(codes(onlyCurrentMissing)).not.toContain("ODOMETER_ORDER_INVALID");
  });

  it("AC-10 two-phase: officialKm=null suppresses OFFICIAL_KM_EXCEEDS_INTERVAL and AMOUNT_OUT_OF_RANGE even when the interval is trivially small and amountOutOfRange=true", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("0.01"), // interval 極小，若查詢必超比例
        officialKm: null, // 第一段：尚未查詢
        amountOutOfRange: true, // 即使旗標為 true 也須被抑制（未查詢時無意義）
      })
    );
    expect(result).toEqual([]);
  });

  it("AC-10 two-phase: providing officialKm (second phase) re-enables items 9/11 evaluation", () => {
    const suppressed = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("10.00"),
        officialKm: null,
      })
    );
    expect(suppressed).toEqual([]);

    const evaluated = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("10.00"),
        officialKm: d("10.01"), // > interval
      })
    );
    expect(codes(evaluated)).toEqual(["OFFICIAL_KM_EXCEEDS_INTERVAL"]);
  });

  it("items 9/11 never appear when any of items 1..8 is present, regardless of officialKm/amountOutOfRange", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        actualCost: null, // item 7 present
        officialKm: d("999999"), // would trivially exceed any interval
        amountOutOfRange: true,
      })
    );
    expect(codes(result)).toEqual(["ACTUAL_COST_REQUIRED"]);
  });
});

// ---------------------------------------------------------------------------
// AC-18 — 比例 > 100% 阻擋
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — AC-18 officialKm > intervalKm yields OFFICIAL_KM_EXCEEDS_INTERVAL", () => {
  it("officialKm == intervalKm (exactly 100%) is ACCEPTED", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("100.00"),
        officialKm: d("100.00"),
      })
    );
    expect(codes(result)).not.toContain("OFFICIAL_KM_EXCEEDS_INTERVAL");
  });

  it("officialKm = intervalKm + 0.01 is blocked", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("100.00"),
        officialKm: d("100.01"),
      })
    );
    expect(codes(result)).toEqual(["OFFICIAL_KM_EXCEEDS_INTERVAL"]);
  });

  it("the comparison uses raw Decimals, not the 6-decimal ratio (mutant kill case: intervalKm + 1e-7 must still be blocked)", () => {
    // 若誤以「取整後 ratio」比較（例如四捨五入至 6 位小數之比值或百分比），
    // O = I + 0.0000001 換算之 ratio 於 6 位小數會四捨五入為 1.000000（100%），
    // 誤判為合法而放行。正確實作須以 O、I 之 Decimal 直接比較，任何超出
    // （即使 1e-7 等極小超出）均須被擋。
    const interval = d("100.0000000");
    const official = d("100.0000001"); // intervalKm + 1e-7
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.0000000"),
        currentOdometerKm: interval,
        officialKm: official,
      })
    );
    expect(codes(result)).toEqual(["OFFICIAL_KM_EXCEEDS_INTERVAL"]);
  });
});

// ---------------------------------------------------------------------------
// NaN／非有限值防禦 — 不變式：非有限值輸入必產生至少一個 blocker
// ---------------------------------------------------------------------------

describe("computeMaintenanceBlockers — NaN/non-finite defense: invariant 'non-finite input ⇒ at least one blocker' (never silently passed through)", () => {
  it("currentOdometerKm = Decimal('NaN') (both present) yields ODOMETER_ORDER_INVALID, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("1000.00"),
        currentOdometerKm: new Prisma.Decimal(Number.NaN),
      })
    );
    expect(codes(result)).toContain("ODOMETER_ORDER_INVALID");
  });

  it("lastOdometerKm = Decimal('NaN') (both present) yields ODOMETER_ORDER_INVALID, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: new Prisma.Decimal(Number.NaN),
        currentOdometerKm: d("1000.01"),
      })
    );
    expect(codes(result)).toContain("ODOMETER_ORDER_INVALID");
  });

  it("actualCost = Decimal('NaN') yields ACTUAL_COST_INVALID, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({ actualCost: new Prisma.Decimal(Number.NaN) })
    );
    expect(codes(result)).toContain("ACTUAL_COST_INVALID");
  });

  it("currentMaintenanceDate = Invalid Date (both present) yields MAINTENANCE_DATE_ORDER_INVALID, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
        currentMaintenanceDate: new Date("not-a-date"),
      })
    );
    expect(codes(result)).toContain("MAINTENANCE_DATE_ORDER_INVALID");
  });

  it("lastMaintenanceDate = Invalid Date (both present) yields MAINTENANCE_DATE_ORDER_INVALID, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastMaintenanceDate: new Date("not-a-date"),
        currentMaintenanceDate: new Date("2026-01-01T00:00:00.000Z"),
      })
    );
    expect(codes(result)).toContain("MAINTENANCE_DATE_ORDER_INVALID");
  });

  it("officialKm = Decimal('NaN') in the second phase yields OFFICIAL_KM_EXCEEDS_INTERVAL, not silently accepted", () => {
    const result = computeMaintenanceBlockers(
      validInput({
        lastOdometerKm: d("0.00"),
        currentOdometerKm: d("100.00"),
        officialKm: new Prisma.Decimal(Number.NaN),
      })
    );
    expect(codes(result)).toContain("OFFICIAL_KM_EXCEEDS_INTERVAL");
  });

  it.each([
    {
      label: "current odometer NaN",
      overrides: { currentOdometerKm: new Prisma.Decimal(Number.NaN) },
    },
    { label: "last odometer NaN", overrides: { lastOdometerKm: new Prisma.Decimal(Number.NaN) } },
    { label: "actualCost NaN", overrides: { actualCost: new Prisma.Decimal(Number.NaN) } },
    {
      label: "current date invalid",
      overrides: { currentMaintenanceDate: new Date("not-a-date") },
    },
    { label: "last date invalid", overrides: { lastMaintenanceDate: new Date("not-a-date") } },
  ] as Array<{ label: string; overrides: Partial<ComputeMaintenanceBlockersInput> }>)(
    "invariant: calculable=false-equivalent non-finite input ($label) never yields zero blockers",
    ({ overrides }) => {
      const result = computeMaintenanceBlockers(validInput(overrides));
      expect(result.length).toBeGreaterThan(0);
    }
  );
});
