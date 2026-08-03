/**
 * Unit tests: PHASE-004-T7 — assertParametersAvailable（travel-parameters.ts）
 * PHASE-005a-T7 改造：`MissingParameter` 由 `"FUEL"|"ETC"` 更名為
 * `"FUEL_PRICE"|"FUEL_CONSUMPTION"|"ETC"`（§16 D5(a) 已批之破壞性更名，本檔
 * 斷言依 Spec 逐字更新，非弱化——見 Packet PHASE-005a-T7）。
 *
 * Spec §2 群組 A/D（AC-04、AC-21/22/23）、§5 邊界 B-09~B-12、§8.5 新增
 * ErrorCode `PARAMETER_NOT_AVAILABLE`（409, details.missing / details.tripDate）、
 * §16 D4(a)/D5(a)（草稿/預覽 computed 不含單價 — 本檔不直接測 D6，見整合測試）。
 *
 * Pure function under test — no DB, no prisma instance (assertParametersAvailable
 * takes an already-resolved `ResolvedParameters` object, mirroring
 * `application-state-machine.ts`/`completion-blockers.ts`'s zero-IO pattern).
 * `resolveTravelParameters` 本身會觸及 DB（findMany），由整合測試
 * `backend/test/integration/phase5a-resolve.test.ts` 涵蓋（AC-04/21/22/23 之
 * 鑑別力需要真實 UserFuelConsumptionVersion/FuelPriceVersion/EtcParameterVersion
 * 資料列）。
 *
 * TDD: written BEFORE `travel-parameters.ts` existed（PHASE-004-T7）；本次
 * PHASE-005a-T7 改造前先確認舊斷言（"FUEL"）因型別/語意改變而失敗，再更新為
 * 新斷言（"FUEL_PRICE"/"FUEL_CONSUMPTION"）。見 Task Handoff 之 RED/GREEN 證據。
 */
import { describe, expect, it } from "vitest";
import {
  type ResolvedParameters,
  assertParametersAvailable,
} from "../../src/applications/travel-parameters.js";
import { AppError } from "../../src/platform/errors.js";

function resolved(overrides: Partial<ResolvedParameters> = {}): ResolvedParameters {
  return {
    fuelUnitPrice: null,
    etcUnitPrice: null,
    fuelPriceVersionId: null,
    fuelConsumptionVersionId: null,
    etcVersionId: null,
    snapshotFuelType: null,
    snapshotFuelPricePerLiter: null,
    snapshotFuelConsumption: null,
    fuelUnitPriceOutOfRange: false,
    missing: [],
    ...overrides,
  };
}

describe("assertParametersAvailable — PHASE-004-T7 / PHASE-005a-T7", () => {
  it("皆有（missing=[]）→ 不拋出（正常返回）", () => {
    expect(() =>
      assertParametersAvailable(resolved({ missing: [] }), new Date("2026-02-28"))
    ).not.toThrow();
  });

  it("缺 FUEL_PRICE → 拋出 AppError，code=PARAMETER_NOT_AVAILABLE, httpStatus=409, details.missing=['FUEL_PRICE']，訊息為「請聯絡管理員設定參數」", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL_PRICE"] }), new Date("2026-02-28"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(err.httpStatus).toBe(409);
    expect(err.details?.missing).toEqual(["FUEL_PRICE"]);
    expect(err.details?.tripDate).toBe("2026-02-28");
    expect(err.userMessage).toBe("請聯絡管理員設定參數");
  });

  it("缺 FUEL_CONSUMPTION → details.missing=['FUEL_CONSUMPTION']，訊息為「請聯絡管理員建立油耗資料」（AC-21，與缺油價訊息逐字不同）", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(
        resolved({ missing: ["FUEL_CONSUMPTION"] }),
        new Date("2026-02-28")
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(err.details?.missing).toEqual(["FUEL_CONSUMPTION"]);
    expect(err.userMessage).toBe("請聯絡管理員建立油耗資料");
    expect(err.userMessage).not.toBe("請聯絡管理員設定參數");
  });

  it("缺 ETC → details.missing=['ETC']", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["ETC"] }), new Date("2026-03-01"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(err.details?.missing).toEqual(["ETC"]);
    expect(err.details?.tripDate).toBe("2026-03-01");
  });

  it("三者皆缺 → details.missing=['FUEL_CONSUMPTION','FUEL_PRICE','ETC']（順序穩定），訊息採油耗優先", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(
        resolved({ missing: ["FUEL_CONSUMPTION", "FUEL_PRICE", "ETC"] }),
        new Date("2025-12-31")
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.details?.missing).toEqual(["FUEL_CONSUMPTION", "FUEL_PRICE", "ETC"]);
    expect(err.details?.tripDate).toBe("2025-12-31");
    expect(err.userMessage).toBe("請聯絡管理員建立油耗資料");
  });

  it("tripDate=null（B-07 相關：missing 已由呼叫端算好；本函式只負責格式化 details.tripDate）→ details.tripDate=null", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(
        resolved({ missing: ["FUEL_CONSUMPTION", "FUEL_PRICE", "ETC"] }),
        null
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.details?.tripDate).toBeNull();
  });

  it("message 為 zh-TW（AC-21/22 明文要求）", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL_PRICE"] }), new Date("2026-01-01"));
    } catch (err) {
      caught = err;
    }
    const err = caught as AppError;
    expect(err.userMessage).toMatch(/[一-鿿]/);
  });

  // ── D4(a)：推導單價超出容量／資料毀損之防護（T2 複審 AR-D 義務） ──────────
  describe("fuelUnitPriceOutOfRange（D4(a)、T2 AR-D 義務）", () => {
    it("missing=[] 但 fuelUnitPriceOutOfRange=true → 仍拋出 409，details.missing 追加 FUEL_UNIT_PRICE_OUT_OF_RANGE，非 500", () => {
      let caught: unknown;
      try {
        assertParametersAvailable(
          resolved({ missing: [], fuelUnitPriceOutOfRange: true }),
          new Date("2026-04-01")
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      const err = caught as AppError;
      expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(err.httpStatus).toBe(409);
      expect(err.details?.missing).toEqual(["FUEL_UNIT_PRICE_OUT_OF_RANGE"]);
      expect(err.userMessage).toContain("超出可計算範圍");
    });

    it("fuelUnitPriceOutOfRange=true 與其他缺項同時存在 → details.missing 為既有缺項 + 追加代碼（非取代）", () => {
      let caught: unknown;
      try {
        assertParametersAvailable(
          resolved({ missing: ["ETC"], fuelUnitPriceOutOfRange: true }),
          new Date("2026-04-02")
        );
      } catch (err) {
        caught = err;
      }
      const err = caught as AppError;
      expect(err.details?.missing).toEqual(["ETC", "FUEL_UNIT_PRICE_OUT_OF_RANGE"]);
    });
  });
});
