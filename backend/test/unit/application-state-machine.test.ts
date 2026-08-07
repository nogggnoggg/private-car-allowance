/**
 * Unit tests: PHASE-004-T2 — Application state machine (pure functions, no DB)
 * PHASE-009-T2（Spec §2 AC-02, AC-05(a)）extends this suite: `ALLOWED_TRANSITIONS`
 * 受控擴充 1→2 條（新增 COMPLETED→VOIDED），並新增 AC-05(a) 結構性掃描。
 *
 * Spec §2 群組 I（AC-55~59）、AC-06、§8.5（D13 已完成拒改 403 FORBIDDEN）、
 * §17.1 D2（狀態集合）/D13（錯誤碼與文案定案）；PHASE-009 §2 AC-02／AC-05(a)
 *
 * TDD: written BEFORE the module exists; first run must be RED
 * (Cannot find module '../../src/applications/application-state-machine.js').
 *
 * Engines under test:
 *   - assertTransition(from, to)   — 3×3（資料驅動：ALL_STATUSES × ALL_STATUSES）
 *       僅允許 DRAFT→COMPLETED 與 COMPLETED→VOIDED；其餘一律拋 AppError，
 *       且逐格斷言 code/httpStatus：
 *         from ≠ DRAFT 且非「COMPLETED→VOIDED」（來源已是終態）→ 403 FORBIDDEN
 *         from = DRAFT 但 to ≠ COMPLETED（本 Phase 不支援的目的狀態）→ 400 VALIDATION_ERROR
 *   - isMutable(status)            — 純謂詞，僅 DRAFT 為 true
 *   - assertApplicationMutable(status) — DRAFT 通過；COMPLETED/VOIDED 拋 403 FORBIDDEN，
 *       訊息逐字等於 D13 定案文案「已完成的申請不可修改，請建立修正版」
 *
 * 鑑別力：
 *   - ALLOWED_TRANSITIONS.length === 2 → 若實作偷偷放寬（例如多允許一組轉換），此斷言轉紅
 *   - 矩陣以 Object.values(ApplicationStatus) 產生（非手刻平行清單）→ 若 schema 未來新增
 *     enum 值，本測試檔會自動涵蓋新值組成的所有格子，不需人工補測試
 *   - 逐格斷言 code／httpStatus，而非只斷言「有拋」→ 若把 from≠DRAFT 誤標成
 *     VALIDATION_ERROR，或把 from=DRAFT/to≠COMPLETED 誤標成 FORBIDDEN，會被抓到
 *   - AC-05(a)：`backend/src/**` 全域掃描 `status: "COMPLETED"`／`status: "DRAFT"`
 *     之程式碼出現位置，逐一比對白名單，白名單外必紅（防未經審查的新寫入路徑）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("ALLOWED_TRANSITIONS — 本 Phase 可達轉換集合（D2, PHASE-009-T2 依 AC-02 受控擴充）", () => {
  it("AC-02: ALLOWED_TRANSITIONS 恰兩條（DRAFT→COMPLETED、COMPLETED→VOIDED）", () => {
    expect(ALLOWED_TRANSITIONS.length).toBe(2);
  });

  it("兩元素逐字為 [DRAFT, COMPLETED] 與 [COMPLETED, VOIDED]（全等比對，防偷加第三條或改動內容）", () => {
    expect(ALLOWED_TRANSITIONS).toEqual([
      ["DRAFT", "COMPLETED"],
      ["COMPLETED", "VOIDED"],
    ]);
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
            // SF-1（T2R-LITE，reviewer M6）：COMPLETED 與 VOIDED 兩種來源必須共用
            // 同一 D13 文案，逐字釘樁——防止「VOIDED 來源專屬訊息」偏離統一文案的 mutant。
            expect(err.userMessage).toBe(ALREADY_FINAL_MESSAGE);
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

  it("DRAFT→COMPLETED 與 COMPLETED→VOIDED 是僅有的兩個不拋格子（矩陣鑑別力總結，AC-02）", () => {
    const passing: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        try {
          assertTransition(from, to);
          passing.push(`${from}->${to}`);
        } catch {
          // expected for all but two cells
        }
      }
    }
    expect(passing).toEqual(["DRAFT->COMPLETED", "COMPLETED->VOIDED"]);
  });
});

// ─── AC-02 逐字驗收 — 四種非法轉換逐一（錯誤碼分流不變） ────────────────────────

describe("AC-02 逐字驗收 — 四種非法轉換逐一（錯誤碼分流不變）", () => {
  it("AC-02: VOIDED→COMPLETED／VOIDED→DRAFT／DRAFT→VOIDED／COMPLETED→DRAFT 逐一被拒且錯誤碼分流不變", () => {
    const illegal: Array<
      [ApplicationStatus, ApplicationStatus, "FORBIDDEN" | "VALIDATION_ERROR", 403 | 400]
    > = [
      ["VOIDED", "COMPLETED", "FORBIDDEN", 403],
      ["VOIDED", "DRAFT", "FORBIDDEN", 403],
      ["DRAFT", "VOIDED", "VALIDATION_ERROR", 400],
      ["COMPLETED", "DRAFT", "FORBIDDEN", 403],
    ];

    for (const [from, to, expectedCode, expectedHttpStatus] of illegal) {
      let caught: unknown;
      try {
        assertTransition(from, to);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AppError);
      const err = caught as AppError;
      expect(err.code).toBe(expectedCode);
      expect(err.httpStatus).toBe(expectedHttpStatus);
      if (expectedCode === "FORBIDDEN") {
        // SF-1（T2R-LITE，reviewer M6）：VOIDED→COMPLETED／VOIDED→DRAFT／COMPLETED→DRAFT
        // 三者皆屬「來源已鎖定」族，逐字釘樁同一 D13 文案（含 VOIDED 來源）。
        expect(err.userMessage).toBe(ALREADY_FINAL_MESSAGE);
      }
      assertUserReadableZhTwMessage(err.userMessage);
    }
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

// ─── AC-05(a) 結構性守門：backend/src 全域零 VOIDED→COMPLETED／DRAFT 寫入路徑 ──
//
// 比照既有先例 backend/test/unit/infra001-structural.test.ts 的做法：直接掃
// 原始碼文字，而非靠推論或型別系統。掃描 `status: "COMPLETED"`／
// `status: "DRAFT"` 之程式碼出現位置（跳過 JSDoc／行註解），逐一比對白名單；
// 白名單外必紅，強制人工複核任何新出現的寫入位置是否真的守住了
// VOIDED→COMPLETED／VOIDED→DRAFT（AC-05(a)）。
//
// SF-2（T2R-LITE，reviewer P6/P7）：原版 pattern 只認字串字面值且逐行掃描，
// 對兩種等價寫法視而不見——(P6) enum 成員形式 `status: ApplicationStatus.COMPLETED`
// （無引號）；(P7) `status:` 與值分寫兩行（跨行）。兩者現已納入偵測範圍：
// pattern 同時涵蓋字串字面值與 enum 成員形式；掃描改為先去除註解（保留換行以
// 維持行號正確）後對「整檔內容」以全域 regex 比對（`\s` 本就跨行，故涵蓋 P7）。
// P8（變數間接形式，例如 `status: someVar`，值僅在執行期決定）非文字掃描可
// 觸及——這是靜態掃描的本質限制，非本次修補範圍；由 `assertTransition` 單一
// 事實來源（本檔前段矩陣）與 AC-05(b) 端點層（PHASE-009-T4）之執行期守門承接。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

function listTsFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFilesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 涵蓋字串字面值（`status: "COMPLETED"`）與 enum 成員形式
 * （`status: ApplicationStatus.COMPLETED`）；`\s*` 本就匹配換行，故單一
 * pattern 對整檔內容比對時天然涵蓋跨行寫法（SF-2, P6/P7）。 */
const STATUS_LITERAL_PATTERN =
  /status:\s*(?:["'](COMPLETED|DRAFT)["']|ApplicationStatus\.(COMPLETED|DRAFT))/g;

/** 去除區塊註解（`/* … *\/`）與行註解（`//…`），以等長空白取代——保留所有
 * 換行字元的位置，使去除註解後的內容仍可用「換行數」精確還原行號。 */
function stripComments(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** 掃描 `backend/src/**\/*.ts`（`root` 可覆寫，供測試以 fixture 目錄自證），
 * 回傳 `status: "COMPLETED"`／`status: "DRAFT"`／`status: ApplicationStatus.*`
 * 之程式碼出現位置（`相對路徑:行號:值`，已排除 JSDoc／行註解、已排除跨行
 * 盲點），已排序。 */
function listStatusLiteralOccurrences(root: string = SRC_ROOT): string[] {
  const occurrences: string[] = [];
  for (const file of listTsFilesRecursive(root)) {
    const relPath = path.relative(root, file).split(path.sep).join("/");
    const cleaned = stripComments(fs.readFileSync(file, "utf8"));
    const pattern = new RegExp(STATUS_LITERAL_PATTERN.source, "g");
    let match: RegExpExecArray | null = pattern.exec(cleaned);
    while (match !== null) {
      const value = match[1] ?? match[2];
      const lineNumber = cleaned.slice(0, match.index).split("\n").length;
      occurrences.push(`${relPath}:${lineNumber}:${value}`);
      match = pattern.exec(cleaned);
    }
  }
  return occurrences.sort();
}

/**
 * AC-05(a) 白名單——`backend/src/**` 目前所有 `status: "COMPLETED"`／
 * `status: "DRAFT"` 之程式碼出現位置（註解行已排除），逐一標註為何不構成
 * VOIDED→COMPLETED／VOIDED→DRAFT 寫入路徑：
 *
 *   - `applications/*-service.ts` 的 `status: "DRAFT"` 三處均在
 *     `tx.application.create()` 內——建立全新列，沒有既有 status 可供轉換，
 *     恆安全。
 *   - `applications/*-service.ts` 的 `status: "COMPLETED"` 三處均在
 *     `tx.application.update()` 內，且緊接在同一函式先前的
 *     `assertTransition(existing.status, "COMPLETED")` 呼叫之後——該呼叫在
 *     `existing.status !== "DRAFT"`（含 VOIDED）時已拋 403，此 update 因而
 *     不可能在 VOIDED 來源下執行到（見下方鄰近測試對此的自證）。
 *   - `mileage/mileage-range.ts:117`、`parameters/reference-guard.ts:114`／
 *     `132` 的 `status: "COMPLETED"` 均在 `where:` 查詢過濾條件內，是讀取
 *     而非寫入（D8(a)，本 Phase `mileage-range.ts` 零 diff）。
 *
 * 任何新出現的位置都不在此白名單內，測試即轉紅，強制人工複核並更新此
 * 清單——這就是「白名單外必紅」。
 */
const AC05A_WHITELIST = [
  "applications/depreciation-service.ts:179:DRAFT",
  "applications/depreciation-service.ts:1421:COMPLETED",
  "applications/maintenance-service.ts:194:DRAFT",
  "applications/maintenance-service.ts:1188:COMPLETED",
  "applications/travel-service.ts:247:DRAFT",
  "applications/travel-service.ts:1393:COMPLETED",
  "mileage/mileage-range.ts:117:COMPLETED",
  "parameters/reference-guard.ts:114:COMPLETED",
  "parameters/reference-guard.ts:132:COMPLETED",
].sort();

describe("AC-05(a) 結構性守門 — backend/src 全域零 VOIDED→COMPLETED／DRAFT 寫入路徑", () => {
  it("至少掃到一些 src 檔案（確保這個測試本身沒有因為路徑算錯而空跑）", () => {
    expect(listTsFilesRecursive(SRC_ROOT).length).toBeGreaterThan(10);
  });

  it("status: COMPLETED／DRAFT 之程式碼出現位置逐一比對白名單，白名單外必紅", () => {
    expect(listStatusLiteralOccurrences()).toEqual(AC05A_WHITELIST);
  });

  it("鑑別力自證（SF-3, T2R-LITE：真實 fixture 目錄實跑，非恆真式）：listStatusLiteralOccurrences 對 scratchpad fixture 目錄實際掃描，涵蓋字串字面值／enum 成員／跨行三種寫入形式，且正確排除行註解與 JSDoc", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac05a-fixture-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "nested"), { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, "nested", "probe.ts"),
        [
          'export const a = { status: "COMPLETED" }; // 字串字面值（既有形式）',
          "export const b = {",
          "  status:",
          '    "DRAFT",', // 跨行（SF-2, P7）——值另起一行
          "};",
          "export const c = { status: ApplicationStatus.COMPLETED }; // enum 成員（SF-2, P6）",
          '// export const d = { status: "DRAFT" }; — 行註解內，不應被抓到',
          "/**",
          ' * status: "COMPLETED" — JSDoc 內，不應被抓到',
          " */",
        ].join("\n")
      );

      // 真實呼叫待測函式（非手造陣列比對）——這才是「非恆真」的關鍵：斷言的是
      // listStatusLiteralOccurrences 這條真實掃描路徑的實際輸出，而非另行手刻
      // 一個「理應不同」的假陣列。
      const result = listStatusLiteralOccurrences(fixtureRoot);

      expect(result).toEqual([
        "nested/probe.ts:1:COMPLETED",
        "nested/probe.ts:3:DRAFT",
        "nested/probe.ts:6:COMPLETED",
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('三筆 COMPLETED 寫入（travel／maintenance／depreciation）皆含同函式的 assertTransition(existing.status, "COMPLETED") 呼叫（VOIDED 來源必先 403，不可能執行到該 update）', () => {
    const guardedFiles = ["travel-service.ts", "maintenance-service.ts", "depreciation-service.ts"];
    for (const file of guardedFiles) {
      const content = fs.readFileSync(path.join(SRC_ROOT, "applications", file), "utf8");
      expect(content).toMatch(/assertTransition\(existing\.status, "COMPLETED"\)/);
    }
  });
});
