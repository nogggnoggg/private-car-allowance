/**
 * Unit tests: PHASE-004-T2 — Application state machine (pure functions, no DB)
 *
 * Spec §2 群組 I（AC-55~59）、AC-06、§8.5（D13 已完成拒改 403 FORBIDDEN）、
 * §17.1 D2（狀態集合）/D13（錯誤碼與文案定案）
 *
 * TDD: written BEFORE the module exists; first run must be RED
 * (Cannot find module '../../src/applications/application-state-machine.js').
 *
 * Engines under test:
 *   - assertTransition(from, to)   — 3×3（資料驅動：ALL_STATUSES × ALL_STATUSES）
 *       唯一允許 DRAFT→COMPLETED；其餘一律拋 AppError，且逐格斷言 code/httpStatus：
 *         from ≠ DRAFT（來源已是終態）→ 403 FORBIDDEN
 *         from = DRAFT 但 to ≠ COMPLETED（本 Phase 不支援的目的狀態）→ 400 VALIDATION_ERROR
 *   - isMutable(status)            — 純謂詞，僅 DRAFT 為 true
 *   - assertApplicationMutable(status) — DRAFT 通過；COMPLETED/VOIDED 拋 403 FORBIDDEN，
 *       訊息逐字等於 D13 定案文案「已完成的申請不可修改，請建立修正版」
 *
 * 鑑別力：
 *   - ALLOWED_TRANSITIONS.length === 1 → 若實作偷偷放寬（例如多允許一組轉換），此斷言轉紅
 *   - 矩陣以 Object.values(ApplicationStatus) 產生（非手刻平行清單）→ 若 schema 未來新增
 *     enum 值，本測試檔會自動涵蓋新值組成的所有格子，不需人工補測試
 *   - 逐格斷言 code／httpStatus，而非只斷言「有拋」→ 若把 from≠DRAFT 誤標成
 *     VALIDATION_ERROR，或把 from=DRAFT/to≠COMPLETED 誤標成 FORBIDDEN，會被抓到
 */

import { ApplicationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  assertApplicationMutable,
  assertTransition,
  isMutable,
} from "../../src/applications/application-state-machine.js";
import { AppError } from "../../src/platform/errors.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** 全部狀態值，直接取自 Prisma 產生的 enum（非本檔手刻的平行清單）。 */
const ALL_STATUSES = Object.values(ApplicationStatus);

function isAllowedByFixture(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** D13 逐字定案文案 */
const ALREADY_FINAL_MESSAGE = "已完成的申請不可修改，請建立修正版";

/** 訊息不得洩漏堆疊／DB 結構／內部路徑／常見英文技術術語（zh-TW 使用者可讀）。 */
function assertUserReadableZhTwMessage(message: string): void {
  const bannedSubstrings = [
    "Error:",
    "error:",
    "stack",
    "Stack",
    "at ",
    "Exception",
    "exception",
    "undefined",
    "null",
    "Prisma",
    "prisma",
    "SQL",
    "sql",
    "TypeError",
  ];
  for (const banned of bannedSubstrings) {
    expect(message).not.toContain(banned);
  }
  // 必須含中文字元（避免整條訊息只是英文技術字串）
  expect(message).toMatch(/[一-鿿]/);
}

// ─── ALLOWED_TRANSITIONS 鑑別力 ─────────────────────────────────────────────────

describe("ALLOWED_TRANSITIONS — 本 Phase 可達轉換集合（D2）", () => {
  it("長度恆為 1（唯一 DRAFT→COMPLETED；防止偷偷放寬）", () => {
    expect(ALLOWED_TRANSITIONS.length).toBe(1);
  });

  it("唯一元素為 [DRAFT, COMPLETED]", () => {
    expect(ALLOWED_TRANSITIONS[0]).toEqual(["DRAFT", "COMPLETED"]);
  });
});

// ─── assertTransition — 完整矩陣，資料驅動 ──────────────────────────────────────

describe("assertTransition — 狀態轉換矩陣（資料驅動，取自 enum 全部值）(AC-55~58)", () => {
  it("ALL_STATUSES 至少涵蓋 DRAFT/COMPLETED/VOIDED 三態（矩陣前提；若 schema 增減值本測試會提示）", () => {
    expect(ALL_STATUSES).toEqual(expect.arrayContaining(["DRAFT", "COMPLETED", "VOIDED"]));
    expect(ALL_STATUSES.length).toBe(3);
  });

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const allowed = isAllowedByFixture(from, to);

      if (allowed) {
        it(`${from} → ${to}：允許（不拋）`, () => {
          expect(() => assertTransition(from, to)).not.toThrow();
        });
      } else {
        it(`${from} → ${to}：拒絕，且 code/httpStatus 符合定案`, () => {
          let caught: unknown;
          try {
            assertTransition(from, to);
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(AppError);
          const err = caught as AppError;

          if (from !== "DRAFT") {
            // 來源已是終態（COMPLETED 或 VOIDED）→ 403 FORBIDDEN（D13 比照）
            expect(err.code).toBe("FORBIDDEN");
            expect(err.httpStatus).toBe(403);
          } else {
            // from = DRAFT 但 to 不是本 Phase 支援的目的狀態（DRAFT 或 VOIDED）
            expect(err.code).toBe("VALIDATION_ERROR");
            expect(err.httpStatus).toBe(400);
          }

          assertUserReadableZhTwMessage(err.userMessage);
        });
      }
    }
  }

  it("DRAFT→COMPLETED 是唯一不拋的格子（矩陣鑑別力總結）", () => {
    const passing: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        try {
          assertTransition(from, to);
          passing.push(`${from}->${to}`);
        } catch {
          // expected for all but one cell
        }
      }
    }
    expect(passing).toEqual(["DRAFT->COMPLETED"]);
  });
});

// ─── isMutable ────────────────────────────────────────────────────────────────

describe("isMutable — 純謂詞（僅 DRAFT 可變更業務欄位）", () => {
  it("DRAFT → true", () => {
    expect(isMutable("DRAFT")).toBe(true);
  });

  it("COMPLETED → false", () => {
    expect(isMutable("COMPLETED")).toBe(false);
  });

  it("VOIDED → false", () => {
    expect(isMutable("VOIDED")).toBe(false);
  });
});

// ─── assertApplicationMutable ──────────────────────────────────────────────────

describe("assertApplicationMutable — 可變性守門 (AC-06/56/59, D13)", () => {
  it("DRAFT → 不拋", () => {
    expect(() => assertApplicationMutable("DRAFT")).not.toThrow();
  });

  it("COMPLETED → 拋 403 FORBIDDEN，訊息逐字等於 D13 定案文案", () => {
    let caught: unknown;
    try {
      assertApplicationMutable("COMPLETED");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("FORBIDDEN");
    expect(err.httpStatus).toBe(403);
    expect(err.userMessage).toBe(ALREADY_FINAL_MESSAGE);
    assertUserReadableZhTwMessage(err.userMessage);
  });

  it("VOIDED → 拋 403 FORBIDDEN，訊息逐字等於 D13 定案文案", () => {
    let caught: unknown;
    try {
      assertApplicationMutable("VOIDED");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("FORBIDDEN");
    expect(err.httpStatus).toBe(403);
    expect(err.userMessage).toBe(ALREADY_FINAL_MESSAGE);
  });
});
