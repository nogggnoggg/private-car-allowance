/**
 * Unit tests: PHASE-004-T7 — assertParametersAvailable（travel-parameters.ts）
 *
 * Spec §2 群組 G（AC-45~48）、§5 邊界 B-09~B-12、§8.5 新增 ErrorCode
 * `PARAMETER_NOT_AVAILABLE`（409, details.missing / details.tripDate）、
 * §17.1 D6（草稿/預覽 computed 不含單價 — 本檔不直接測 D6，見整合測試）。
 *
 * Pure function under test — no DB, no prisma instance (assertParametersAvailable
 * takes an already-resolved `ResolvedParameters` object, mirroring
 * `application-state-machine.ts`/`completion-blockers.ts`'s zero-IO pattern).
 * `resolveTravelParameters` itself DOES touch the DB (findMany) and is exercised
 * by the integration test `phase4-travel-preview.test.ts` instead (AC-45 含當日
 * 邊界鑑別力 — that needs real FuelParameterVersion/EtcParameterVersion rows).
 *
 * TDD: written BEFORE `travel-parameters.ts` exists — first run must be RED
 * (module not found). See Task Handoff for the captured first-run RED output.
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
    fuelVersionId: null,
    etcVersionId: null,
    missing: [],
    ...overrides,
  };
}

describe("assertParametersAvailable — PHASE-004-T7", () => {
  it("皆有（missing=[]）→ 不拋出（正常返回）", () => {
    expect(() =>
      assertParametersAvailable(resolved({ missing: [] }), new Date("2026-02-28"))
    ).not.toThrow();
  });

  it("缺 FUEL → 拋出 AppError，code=PARAMETER_NOT_AVAILABLE, httpStatus=409, details.missing=['FUEL']", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL"] }), new Date("2026-02-28"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("PARAMETER_NOT_AVAILABLE");
    expect(err.httpStatus).toBe(409);
    expect(err.details?.missing).toEqual(["FUEL"]);
    expect(err.details?.tripDate).toBe("2026-02-28");
    expect(err.userMessage).toContain("聯絡管理員");
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

  it("兩者皆缺 → details.missing=['FUEL','ETC']（順序穩定）", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL", "ETC"] }), new Date("2025-12-31"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.details?.missing).toEqual(["FUEL", "ETC"]);
    expect(err.details?.tripDate).toBe("2025-12-31");
  });

  it("tripDate=null（B-12 相關：missing 已由呼叫端算好；本函式只負責格式化 details.tripDate）→ details.tripDate=null", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL", "ETC"] }), null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.details?.tripDate).toBeNull();
  });

  it("message 為 zh-TW（AC-47 明文要求）", () => {
    let caught: unknown;
    try {
      assertParametersAvailable(resolved({ missing: ["FUEL"] }), new Date("2026-01-01"));
    } catch (err) {
      caught = err;
    }
    const err = caught as AppError;
    expect(err.userMessage).toMatch(/[一-鿿]/);
  });
});
