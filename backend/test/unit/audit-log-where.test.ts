/**
 * PHASE-010-T2R-LITE — `buildAuditLogWhere`（Prisma `where` 建構純函式）單元測試
 *
 * 對象：`backend/src/audit/routes.ts` 之 `buildAuditLogWhere`（純函式：零 DB、
 * 零時鐘、零 I/O、不改寫輸入）。
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-010.md`，Gate 通過版逐字）
 * ---------------------------------------------------------------------------
 * §11.1 單元（Vitest，不需 DB）第三列逐字：「`buildAuditLogWhere`：純函式
 *   `toEqual`」——本檔即該列之落點（T2 交付時因 Files Allowed 不含 `test/unit/`
 *   而未建，記於 T2 Handoff W-5，本 Lite Task 補齊）。
 * §2.A AC-02(a)／§16 **D2(b)**：篩選維度恰四個——`action`／`actorId`／`targetId`
 *   ＋ `dateFrom`／`dateTo`（不含 `keyword`）。
 * §2.A AC-02(e)：區間**起訖日均含當日**。T1（`audit-query.ts`）將其表達為
 *   **半開區間** `[createdAtFrom, createdAtToExclusive)`，故 `where` 必為
 *   `gte` ＋ **`lt`**（誤用 `lte` 會使 `dateTo` 當日多撈一整天）。
 * §5 邊界：B-06（合法 `action` 零命中）／B-09（`actorId`／`targetId` 不驗存在性）
 *   之「不應在 `where` 層被特殊處理」面；B-07（單日查詢）之區間形狀面。
 * §2.A AC-02(b)：`errors` 非空時 T1 之 parser 把四個篩選欄位一律歸 `null`
 *   —— 本檔以「該情形下 `where` 退化為 `{}`（全表）」明文釘住該危險語意，
 *   使 `routes.ts` 之「先 400 再建 `where`」順序不得被日後改動反轉。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計（本檔存在的理由：即審 SF-1／reviewer M14）
 * ---------------------------------------------------------------------------
 * 1. **單端日期分支（M14 之 kill 格）**：`routes.ts` 之
 *      `if (createdAtFrom !== null || createdAtToExclusive !== null)`
 *    中的 `||` 若被改成 `&&`，「只帶 `dateFrom`」與「只帶 `dateTo`」兩種查詢會
 *    **靜默退化為不設任何時間界**（回傳全期間資料）——這是稽核檢視頁上最不易
 *    察覺的失真：畫面有資料、無錯誤、筆數卻不對。T2 的 40 格整合測試全部同時
 *    帶 `dateFrom` ＋ `dateTo`，故該 mutant 於 40 格全綠下存活。本檔的
 *    「僅 `dateFrom`」與「僅 `dateTo`」兩格即為其 kill 格。
 * 2. **`toStrictEqual` 而非 `toEqual`**：`toEqual` 會忽略值為 `undefined` 的鍵，
 *    因此無法分辨 `{ gte: D }` 與 `{ gte: D, lt: undefined }`。後者雖然在 Prisma
 *    執行期多半等價，卻代表實作改用了「恆展開兩鍵」的寫法，日後極易演變成把
 *    `undefined` 換成實際值的錯誤上界。改用 `toStrictEqual` 讓鍵集本身封閉，
 *    另以 `Object.keys` 對 `createdAt` 子物件再確認一次。
 * 3. **四維度逐一單開**：每個維度各有一格「只有它非 null」，故任一維度被漏寫
 *    （或被寫進錯誤的 `where` 欄）皆必紅；另有一格四維度全開之 `toStrictEqual`
 *    封閉斷言，使「多寫一個 `where` 欄」（如把 `page` 洩漏進 `where`）必紅。
 * 4. **不改寫輸入 ＋ 同輸入恆同輸出**：純函式性質以「呼叫前後輸入物件
 *    `toStrictEqual` 不變」與「兩次呼叫結果 `toStrictEqual` 相等且非同一參照」
 *    守門。
 *
 * 測試紀律：合成資料；零 DB；零時鐘（所有 `Date` 皆為字面常數）。
 */

import { describe, expect, it } from "vitest";
import type { ParsedAuditLogQuery } from "../../src/audit/audit-query.js";
import { buildAuditLogWhere } from "../../src/audit/routes.js";

// ---------------------------------------------------------------------------
// 固定裝置
// ---------------------------------------------------------------------------

/** 半開區間之兩端（本檔專屬年份 2049，與其他測試檔零重疊）。 */
const FROM = new Date("2049-07-10T00:00:00.000Z");
/** `dateTo=2049-07-12` 之次日 00:00:00.000Z（T1 輸出之 exclusive 上界）。 */
const TO_EXCLUSIVE = new Date("2049-07-13T00:00:00.000Z");

const ACTOR_ID = "p10t2w-actor-id";
const TARGET_ID = "p10t2w-target-id";

/**
 * 「全部篩選欄位皆空、分頁為預設」之基準輸入。
 *
 * `page`／`pageSize` 刻意給**非預設**值（3／50）：`buildAuditLogWhere` 不得
 * 讀取這兩個欄位，若實作誤把分頁參數寫進 `where`，全開那一格的封閉斷言必紅。
 */
function parsed(overrides: Partial<ParsedAuditLogQuery> = {}): ParsedAuditLogQuery {
  return {
    errors: [],
    action: null,
    actorId: null,
    targetId: null,
    createdAtFrom: null,
    createdAtToExclusive: null,
    page: 3,
    pageSize: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("PHASE-010-T2R-LITE — buildAuditLogWhere（where 建構純函式；Spec §11.1）", () => {
  describe("四維度 × null／非 null 逐一單開", () => {
    it("四維度皆 null → where 為空物件（不得寫入任何欄，尤不得寫 `{ action: null }`）", () => {
      // `{ action: null }` 在 Prisma 是「該欄等於 null」，與「不依此維度篩選」
      // 語意完全不同——前者會讓 `action` 篩選在未指定時反而過濾掉全部列。
      expect(buildAuditLogWhere(parsed())).toStrictEqual({});
    });

    it("僅 action → { action }", () => {
      expect(buildAuditLogWhere(parsed({ action: "APPLICATION_VOIDED" }))).toStrictEqual({
        action: "APPLICATION_VOIDED",
      });
    });

    it("僅 actorId → { actorId }（B-09：不驗存在性，原值直接進 where）", () => {
      expect(buildAuditLogWhere(parsed({ actorId: ACTOR_ID }))).toStrictEqual({
        actorId: ACTOR_ID,
      });
    });

    it("僅 targetId → { targetId }（B-09）", () => {
      expect(buildAuditLogWhere(parsed({ targetId: TARGET_ID }))).toStrictEqual({
        targetId: TARGET_ID,
      });
    });

    it("★M14 kill 格：僅 dateFrom → { createdAt: { gte } }（不得因缺上界而整段不設時間界）", () => {
      const where = buildAuditLogWhere(parsed({ createdAtFrom: FROM }));
      expect(where).toStrictEqual({ createdAt: { gte: FROM } });
      // 鍵集封閉：不得出現 `lt`（即使值為 undefined）
      expect(Object.keys(where.createdAt as object)).toEqual(["gte"]);
    });

    it("★M14 kill 格：僅 dateTo → { createdAt: { lt } }（半開上界；誤用 lte 會多撈一整天）", () => {
      const where = buildAuditLogWhere(parsed({ createdAtToExclusive: TO_EXCLUSIVE }));
      expect(where).toStrictEqual({ createdAt: { lt: TO_EXCLUSIVE } });
      expect(Object.keys(where.createdAt as object)).toEqual(["lt"]);
    });

    it("兩端皆有 → { createdAt: { gte, lt } }（AC-02(e) 之半開區間）", () => {
      const where = buildAuditLogWhere(
        parsed({ createdAtFrom: FROM, createdAtToExclusive: TO_EXCLUSIVE })
      );
      expect(where).toStrictEqual({ createdAt: { gte: FROM, lt: TO_EXCLUSIVE } });
      expect(Object.keys(where.createdAt as object).sort()).toEqual(["gte", "lt"]);
    });

    it("B-07 單日（dateFrom ＝ dateTo）→ 上界仍為次日 00:00Z 之 lt，可涵蓋該日 23:59:59.999Z", () => {
      const where = buildAuditLogWhere(
        parsed({
          createdAtFrom: new Date("2049-07-12T00:00:00.000Z"),
          createdAtToExclusive: new Date("2049-07-13T00:00:00.000Z"),
        })
      );
      expect(where).toStrictEqual({
        createdAt: {
          gte: new Date("2049-07-12T00:00:00.000Z"),
          lt: new Date("2049-07-13T00:00:00.000Z"),
        },
      });
      // 語意自證：該日最後一毫秒確實落在 [gte, lt) 內。
      const lastMs = new Date("2049-07-12T23:59:59.999Z").getTime();
      const range = where.createdAt as { gte: Date; lt: Date };
      expect(lastMs).toBeGreaterThanOrEqual(range.gte.getTime());
      expect(lastMs).toBeLessThan(range.lt.getTime());
    });
  });

  describe("組合與封閉性", () => {
    it("四維度全開 → 鍵集恰為四欄（分頁參數不得洩漏進 where）", () => {
      const where = buildAuditLogWhere(
        parsed({
          action: "USER_PASSWORD_RESET",
          actorId: ACTOR_ID,
          targetId: TARGET_ID,
          createdAtFrom: FROM,
          createdAtToExclusive: TO_EXCLUSIVE,
        })
      );
      expect(where).toStrictEqual({
        action: "USER_PASSWORD_RESET",
        actorId: ACTOR_ID,
        targetId: TARGET_ID,
        createdAt: { gte: FROM, lt: TO_EXCLUSIVE },
      });
      expect(Object.keys(where).sort()).toEqual(["action", "actorId", "createdAt", "targetId"]);
    });

    it("AC-02(b) 危險語意釘死：errors 非空時 T1 把篩選欄位全歸 null → where 退化為全表 {}", () => {
      // 這正是 `routes.ts` 必須「先 `errors.length > 0` → 400、再建 `where`」的
      // 理由：順序一旦反轉，畸形查詢會靜默回傳全表稽核資料而非 400。
      const where = buildAuditLogWhere(
        parsed({ errors: [{ field: "action", reason: "操作類型不合法" }] })
      );
      expect(where).toStrictEqual({});
    });
  });

  describe("純函式性質", () => {
    it("不改寫輸入", () => {
      const input = parsed({ action: "USER_CREATED", createdAtFrom: FROM });
      const snapshot = parsed({ action: "USER_CREATED", createdAtFrom: FROM });
      buildAuditLogWhere(input);
      expect(input).toStrictEqual(snapshot);
    });

    it("同輸入恆同輸出，且每次回傳新物件（呼叫端修改結果不得污染下一次查詢）", () => {
      const input = parsed({ actorId: ACTOR_ID, createdAtToExclusive: TO_EXCLUSIVE });
      const first = buildAuditLogWhere(input);
      const second = buildAuditLogWhere(input);
      expect(first).toStrictEqual(second);
      expect(first).not.toBe(second);
    });
  });
});
