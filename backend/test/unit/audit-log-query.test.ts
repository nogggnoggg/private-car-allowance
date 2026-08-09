/**
 * PHASE-010-T1 — `parseAuditLogQuery`（稽核查詢之篩選與分頁解析純函式）單元測試
 *
 * 對象：`backend/src/audit/audit-query.ts`（純函式，零 DB／零時鐘／零 Prisma 型別）。
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-010.md`，Gate 通過版逐字）
 * ---------------------------------------------------------------------------
 * §2.A AC-02 — 篩選與分頁解析
 *   (a) 支援 query 參數（維度集合依 D2 裁定＝(b) 四維度）：
 *       `action`／`actorId`／`targetId`／`dateFrom`／`dateTo`／`page`／`pageSize`。
 *   (b) `page` 預設 `1`；非正整數或 `< 1` → `400 VALIDATION_ERROR` ＋
 *       `fields[{field:"page"}]`，零查詢。
 *   (c) `pageSize` 預設 `20`、上限 `100`（超過即 clamp 不報錯）；`<= 0` 或非正
 *       整數 → `400` ＋ `fields[{field:"pageSize"}]`。**逐字沿 PHASE-004
 *       `application-query.ts` 之既有語意**（`PAGE_SIZE_DEFAULT=20`／
 *       `PAGE_SIZE_MAX=100`）。
 *   (d) `action` 非 `AuditAction` 之合法值 → `400` ＋ `fields[{field:"action"}]`
 *       （不得靜默忽略而回全集）。
 *   (e) **【2026-08-09 Mock Gate MG-2 裁定「以台灣日曆日為準」修訂；`SPEC-REV-010-GATE`】**
 *       `dateFrom > dateTo` → `400` ＋ `fields[]`；區間起訖日均含當日
 *       （`CLAUDE.md` 工程規則），且此處之「日」逐字為**台灣（UTC+8）日曆日**：
 *         · `createdAtFrom`        ＝ `dateFrom` 台北時 `00:00:00.000`
 *                                  ＝ **前一日 `16:00:00.000Z`**
 *         · `createdAtToExclusive` ＝ `dateTo` 次日之台北時 `00:00:00.000`
 *                                  ＝ **`dateTo` 當日 `16:00:00.000Z`**
 *       偏移為**固定 ＋8 小時**（台灣自 1979 年起無 DST → 零新增依賴，N-6）。
 *   (f) 解析為純函式（不碰 DB、不碰 Prisma 型別），可單獨單元測試。
 * §5 邊界條件 B-01 ~ B-09（本檔逐格覆蓋；B-04／B-06／B-09 之「DB 命中結果」面
 *   屬 T2 整合測試，本檔只證解析層不擋、不報錯、不改值）＋ **B-29**（MG-2 新增：
 *   台北日界之雙向釘死——以 UTC 日界實作之 mutant 必紅）。
 * §12 映射表：本檔兩列 —— `AC-02: parseAuditLogQuery 參數矩陣（B-01~B-09）`／
 *   `AC-02(f): 解析為純函式 — 零 DB／零 Prisma 型別相依`（describe 名逐字對應）。
 *
 * ---------------------------------------------------------------------------
 * 實查依據（本檔撰寫當下之 grep／read，非轉述 Packet）
 * ---------------------------------------------------------------------------
 * · `backend/src/applications/application-query.ts` :57-58
 *     `export const PAGE_SIZE_DEFAULT = 20;` / `export const PAGE_SIZE_MAX = 100;`
 *   同檔 :255-285 之 `page`／`pageSize` 分支（正整數正則 → `<1`／`<=0` → clamp）。
 *   本檔以「同輸入下兩個 parser 的 page／pageSize 輸出與欄位錯誤逐字全等」之
 *   機械斷言守住 AC-02(c) 的「逐字沿用」，而非僅以人工比對宣稱。
 * · `backend/prisma/schema.prisma` :30-41 `enum AuditAction` 共 10 值。
 *   本檔以 `@prisma/client` 之 `AuditAction` 執行期列舉與 `AUDIT_ACTIONS` 全等
 *   斷言守門（schema 新增／刪除值而未同步本地清單者必紅）。
 * · `backend/src/mileage/mileage-range.ts`（PHASE-005-T1）為「純函式查詢解析
 *   模組沿用 `parameter-service.ts:parseUtcDate`」之既有先例，AC-02(f) 之結構
 *   斷言因而針對**本模組自身原始碼**是否出現 Prisma／DB／時鐘相依，而非傳遞
 *   相依。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計
 * ---------------------------------------------------------------------------
 * 1. B-03 clamp 與 B-02 400 的分野以「同一參數名、相鄰輸入」成對斷言
 *    （`0` → 400、`1` → 1、`100` → 100、`101` → clamp 100）——把 clamp 誤寫成
 *    400、或把 `<=0` 誤寫成 clamp 的 mutant 皆必紅。
 * 2. B-05 除了斷言有 `action` 欄位錯誤，另斷言 `result.action === null`——
 *    「靜默忽略而回全集」之 mutant（不報錯且 action 留 null）僅靠錯誤斷言即紅，
 *    但兩者並存可分辨「報錯卻仍把非法值放行」這一種更隱蔽的失敗。
 * 3. B-07 之「起訖含當日」不以「不報錯」交差，而是斷言解析後的半開區間
 *    `[createdAtFrom, createdAtToExclusive)` 實際涵蓋該**台北日**之末毫秒
 *    （`dateTo` 當日 `15:59:59.999Z`）：把上界誤寫成當日 `00:00:00`（即以
 *    `lte dateTo` 之日粒度收尾）之 mutant 必紅。
 * 4. 錯誤時「零查詢」以「所有篩選欄位一律回 null」守門——上游不得誤用半驗證值。
 * 5. **B-29（MG-2）之雙向釘死**：兩端點以**逐字 UTC 字面**斷言，故
 *    (i) 偏移歸零（退回 UTC 日界）與 (ii) 偏移方向相反（−8h）兩種 mutant 皆必紅；
 *    另以「台北 D 日 00:00 必命中 ∧ UTC D 日 23:59 必不命中」之區間內外對照
 *    在語意層再釘一次。
 * 6. 「日界借位」之跨月／跨年／閏日鑑別力：平移後上界為 `dateTo` **當日**
 *    `16:00Z`（不再進位），故進位／借位改由**下界**承載
 *    （`dateFrom=2028-03-01` → `2028-02-29T16:00:00.000Z`），以成對之 `it.each`
 *    同時覆蓋兩端，避免 MG-2 後遺失原有之閏日覆蓋。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditAction } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE_DEFAULT as APPLICATION_PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX as APPLICATION_PAGE_SIZE_MAX,
  parseApplicationListQuery,
} from "../../src/applications/application-query.js";
import {
  AUDIT_ACTIONS,
  PAGE_DEFAULT,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type ParsedAuditLogQuery,
  parseAuditLogQuery,
} from "../../src/audit/audit-query.js";

/** 解析結果之「全部篩選欄位皆空、分頁為預設」基準（用於 toEqual 封閉斷言）。 */
const EMPTY_RESULT: ParsedAuditLogQuery = {
  errors: [],
  action: null,
  actorId: null,
  targetId: null,
  createdAtFrom: null,
  createdAtToExclusive: null,
  page: 1,
  pageSize: 20,
};

function fieldsOf(result: ParsedAuditLogQuery): string[] {
  return result.errors.map((e) => e.field);
}

describe("AC-02: parseAuditLogQuery 參數矩陣（B-01~B-09）", () => {
  // ─────────────────────────────────────────────────────────────────────
  // AC-02(a)：維度集合（D2(b) 四維度 ＋ 分頁兩參數）
  // ─────────────────────────────────────────────────────────────────────
  describe("AC-02(a) 支援之 query 參數集合", () => {
    it("零參數 → 全部篩選為 null、page=1、pageSize=20、零錯誤（結果鍵集封閉）", () => {
      expect(parseAuditLogQuery({})).toEqual(EMPTY_RESULT);
    });

    it("七個參數同時合法 → 逐欄正規化後回傳（結果鍵集封閉，多一鍵必紅）", () => {
      const result = parseAuditLogQuery({
        action: "APPLICATION_VOIDED",
        actorId: "cku111actor",
        targetId: "cku222target",
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
        page: "3",
        pageSize: "50",
      });
      expect(result).toEqual({
        errors: [],
        action: "APPLICATION_VOIDED",
        actorId: "cku111actor",
        targetId: "cku222target",
        // AC-02(e)／MG-2：台北日界——`dateFrom` 前一日 16:00Z、`dateTo` 當日 16:00Z。
        createdAtFrom: new Date("2026-07-31T16:00:00.000Z"),
        createdAtToExclusive: new Date("2026-08-31T16:00:00.000Z"),
        page: 3,
        pageSize: 50,
      });
    });

    it("未知參數一律忽略（不影響解析結果、不報錯）", () => {
      expect(parseAuditLogQuery({ keyword: "x", ownerId: "y" } as Record<string, unknown>)).toEqual(
        EMPTY_RESULT
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-01：page 缺省／""／0／-1／1.5／abc
  // ─────────────────────────────────────────────────────────────────────
  describe("B-01 page（缺省與 '' → 預設 1；其餘 → 400 ＋ fields[{field:'page'}]，零查詢）", () => {
    it("缺省 → page = 1（＝ PAGE_DEFAULT）", () => {
      const result = parseAuditLogQuery({});
      expect(result.errors).toEqual([]);
      expect(result.page).toBe(1);
      expect(PAGE_DEFAULT).toBe(1);
    });

    it("'' → page = 1、零錯誤", () => {
      const result = parseAuditLogQuery({ page: "" });
      expect(result.errors).toEqual([]);
      expect(result.page).toBe(1);
    });

    it("'1' → page = 1（正向對照，證明上方預設值非恆真）", () => {
      const result = parseAuditLogQuery({ page: "1" });
      expect(result.errors).toEqual([]);
      expect(result.page).toBe(1);
    });

    it.each(["0", "-1", "1.5", "abc"])("'%s' → 400 ＋ fields[{field:'page'}]", (raw) => {
      const result = parseAuditLogQuery({ page: raw });
      expect(fieldsOf(result)).toContain("page");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("page 違規時所有篩選欄位一律回 null（零查詢：上游不得誤用半驗證值）", () => {
      const result = parseAuditLogQuery({
        page: "0",
        action: "USER_CREATED",
        actorId: "a1",
        targetId: "t1",
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
      });
      expect(fieldsOf(result)).toContain("page");
      expect(result.action).toBeNull();
      expect(result.actorId).toBeNull();
      expect(result.targetId).toBeNull();
      expect(result.createdAtFrom).toBeNull();
      expect(result.createdAtToExclusive).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-02：pageSize = 0／-5／abc → 400 ＋ fields[{field:'pageSize'}]
  // ─────────────────────────────────────────────────────────────────────
  describe("B-02 pageSize（0／-5／abc → 400 ＋ fields[{field:'pageSize'}]）", () => {
    it.each(["0", "-5", "abc"])("'%s' → 400 ＋ fields[{field:'pageSize'}]", (raw) => {
      const result = parseAuditLogQuery({ pageSize: raw });
      expect(fieldsOf(result)).toContain("pageSize");
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("'' 與缺省 → pageSize = 20（＝ PAGE_SIZE_DEFAULT），零錯誤", () => {
      expect(parseAuditLogQuery({ pageSize: "" }).pageSize).toBe(20);
      expect(parseAuditLogQuery({}).pageSize).toBe(20);
      expect(PAGE_SIZE_DEFAULT).toBe(20);
    });

    it("'1' → 1（下界正向對照：證明 '0' 之 400 不是把所有小值都擋掉）", () => {
      const result = parseAuditLogQuery({ pageSize: "1" });
      expect(result.errors).toEqual([]);
      expect(result.pageSize).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-03：pageSize = 101／10000 → clamp 為 100（200，不報錯）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-03 pageSize 超過上限 → clamp 為 100（不報錯）", () => {
    it.each(["101", "10000"])("'%s' → pageSize = 100 且零錯誤（clamp，非 400）", (raw) => {
      const result = parseAuditLogQuery({ pageSize: raw });
      expect(result.errors).toEqual([]);
      expect(result.pageSize).toBe(100);
    });

    it("'100' → 100（上界本身不 clamp、不報錯）", () => {
      const result = parseAuditLogQuery({ pageSize: "100" });
      expect(result.errors).toEqual([]);
      expect(result.pageSize).toBe(100);
    });

    it("上限常數為 100（＝ PAGE_SIZE_MAX）", () => {
      expect(PAGE_SIZE_MAX).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // AC-02(c)「逐字沿 PHASE-004 application-query.ts 之既有語意」之機械守門
  // ─────────────────────────────────────────────────────────────────────
  describe("AC-02(c) 逐字沿用 PHASE-004 既有分頁語意（與 parseApplicationListQuery 機械對照）", () => {
    const NOW = new Date("2026-08-09T00:00:00.000Z");

    it("PAGE_SIZE_DEFAULT／PAGE_SIZE_MAX 與 application-query.ts 全等", () => {
      expect(PAGE_SIZE_DEFAULT).toBe(APPLICATION_PAGE_SIZE_DEFAULT);
      expect(PAGE_SIZE_MAX).toBe(APPLICATION_PAGE_SIZE_MAX);
    });

    it.each(["", "0", "-1", "1.5", "abc", "1", "2", "999"])(
      "page='%s'：page 值與 page 欄位錯誤與 PHASE-004 逐字全等",
      (raw) => {
        const mine = parseAuditLogQuery({ page: raw });
        const theirs = parseApplicationListQuery({ page: raw }, NOW);
        expect(mine.page).toBe(theirs.page);
        expect(mine.errors.filter((e) => e.field === "page")).toEqual(
          theirs.errors.filter((e) => e.field === "page")
        );
      }
    );

    it.each(["", "0", "-5", "abc", "1", "20", "100", "101", "10000"])(
      "pageSize='%s'：pageSize 值與 pageSize 欄位錯誤與 PHASE-004 逐字全等",
      (raw) => {
        const mine = parseAuditLogQuery({ pageSize: raw });
        const theirs = parseApplicationListQuery({ pageSize: raw }, NOW);
        expect(mine.pageSize).toBe(theirs.pageSize);
        expect(mine.errors.filter((e) => e.field === "pageSize")).toEqual(
          theirs.errors.filter((e) => e.field === "pageSize")
        );
      }
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-04：page 大於總頁數 → 解析層放行（空集合由 DB 層自然產生，非 404）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-04 page 大於總頁數（解析層不擋，交由 DB 自然回空集合）", () => {
    it("page='999999' → 零錯誤且原值放行（解析層無總頁數概念，不得預先擋下）", () => {
      const result = parseAuditLogQuery({ page: "999999" });
      expect(result.errors).toEqual([]);
      expect(result.page).toBe(999999);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-05：action = "BOGUS_ACTION" → 400 ＋ fields[{field:'action'}]
  // ─────────────────────────────────────────────────────────────────────
  describe("B-05 action 非合法值 → 400 ＋ fields[{field:'action'}]（不得靜默回全集）", () => {
    it.each(["BOGUS_ACTION", "user_created", "USER_CREATED ", "", " "])(
      "'%s' → action 欄位錯誤且 action 不被放行",
      (raw) => {
        // 註：`""` 與 `" "` 亦列入——空字串在既有慣例中視同未提供（不報錯），
        // 純空白則為非法值。以下分流斷言把兩者的期望分開，避免「一律報錯」或
        // 「一律忽略」兩種 mutant 同時通過。
        const result = parseAuditLogQuery({ action: raw });
        if (raw === "") {
          expect(result.errors).toEqual([]);
          expect(result.action).toBeNull();
        } else {
          expect(fieldsOf(result)).toContain("action");
          expect(result.action).toBeNull();
        }
      }
    );

    it("非法 action 不得靜默忽略：必有錯誤（回全集之 mutant 必紅）", () => {
      const result = parseAuditLogQuery({ action: "BOGUS_ACTION" });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(fieldsOf(result)).toContain("action");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-06：action 為合法值 → 逐值放行（零命中之空集合屬 DB 層）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-06 action 為合法值（10 值逐一放行）", () => {
    it.each([...AUDIT_ACTIONS])("'%s' → 零錯誤且原值放行", (value) => {
      const result = parseAuditLogQuery({ action: value });
      expect(result.errors).toEqual([]);
      expect(result.action).toBe(value);
    });

    it("AUDIT_ACTIONS 與 @prisma/client 之 AuditAction 值集合全等（schema 漂移必紅）", () => {
      expect(new Set<string>(AUDIT_ACTIONS)).toEqual(new Set<string>(Object.values(AuditAction)));
      expect(AUDIT_ACTIONS.length).toBe(Object.values(AuditAction).length);
      expect(AUDIT_ACTIONS.length).toBe(10);
    });

    it("AUDIT_ACTIONS 零重複值", () => {
      expect(new Set<string>(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-07／AC-02(e)：dateFrom == dateTo → 該台北日全數命中（起訖含當日）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-07 dateFrom == dateTo（起訖日均含當日；MG-2 後之「日」＝台北日）", () => {
    it("同一日 → 零錯誤，半開區間為 [前一日 16:00:00.000Z, 當日 16:00:00.000Z)", () => {
      const result = parseAuditLogQuery({ dateFrom: "2026-08-09", dateTo: "2026-08-09" });
      expect(result.errors).toEqual([]);
      expect(result.createdAtFrom).toEqual(new Date("2026-08-08T16:00:00.000Z"));
      expect(result.createdAtToExclusive).toEqual(new Date("2026-08-09T16:00:00.000Z"));
    });

    it("該台北日全部時刻皆落在 [from, toExclusive) 內（上界寫成當日 00:00 之 mutant 必紅）", () => {
      const result = parseAuditLogQuery({ dateFrom: "2026-08-09", dateTo: "2026-08-09" });
      const from = result.createdAtFrom;
      const toExclusive = result.createdAtToExclusive;
      expect(from).not.toBeNull();
      expect(toExclusive).not.toBeNull();
      if (from === null || toExclusive === null) throw new Error("unreachable");

      // 台北 2026-08-09 之 00:00:00.000／08:30:00.000／23:59:59.999 三個時刻。
      for (const instant of [
        "2026-08-08T16:00:00.000Z",
        "2026-08-09T00:30:00.000Z",
        "2026-08-09T15:59:59.999Z",
      ]) {
        const t = new Date(instant).getTime();
        expect(t).toBeGreaterThanOrEqual(from.getTime());
        expect(t).toBeLessThan(toExclusive.getTime());
      }

      // 區間外之相鄰時刻（負向對照，證明上方非恆真）：台北 08-08 23:59:59.999
      // 與台北 08-10 00:00:00.000。
      expect(new Date("2026-08-08T15:59:59.999Z").getTime()).toBeLessThan(from.getTime());
      expect(new Date("2026-08-09T16:00:00.000Z").getTime()).toBeGreaterThanOrEqual(
        toExclusive.getTime()
      );
    });

    it.each([
      ["2026-08-31", "2026-08-31T16:00:00.000Z"],
      ["2026-12-31", "2026-12-31T16:00:00.000Z"],
      ["2028-02-29", "2028-02-29T16:00:00.000Z"],
    ])("dateTo='%s' 之台北次日上界為 %s（月末／年末／閏日皆正確）", (dateTo, expected) => {
      const result = parseAuditLogQuery({ dateTo });
      expect(result.errors).toEqual([]);
      expect(result.createdAtToExclusive).toEqual(new Date(expected));
    });

    it.each([
      ["2026-09-01", "2026-08-31T16:00:00.000Z"],
      ["2027-01-01", "2026-12-31T16:00:00.000Z"],
      ["2028-03-01", "2028-02-29T16:00:00.000Z"],
    ])("dateFrom='%s' 之台北日起點為 %s（跨月／跨年／閏日之借位皆正確）", (dateFrom, expected) => {
      // MG-2 平移後，進位／借位改由**下界**承載（上界恆為 dateTo 當日 16:00Z），
      // 故原 `dateTo` 之跨月／跨年／閏日覆蓋以本格對稱補回，零覆蓋淨損。
      const result = parseAuditLogQuery({ dateFrom });
      expect(result.errors).toEqual([]);
      expect(result.createdAtFrom).toEqual(new Date(expected));
    });

    it("只給 dateFrom → 上界為 null（不設上界）；只給 dateTo → 下界為 null", () => {
      const onlyFrom = parseAuditLogQuery({ dateFrom: "2026-08-01" });
      expect(onlyFrom.errors).toEqual([]);
      expect(onlyFrom.createdAtFrom).toEqual(new Date("2026-07-31T16:00:00.000Z"));
      expect(onlyFrom.createdAtToExclusive).toBeNull();

      const onlyTo = parseAuditLogQuery({ dateTo: "2026-08-31" });
      expect(onlyTo.errors).toEqual([]);
      expect(onlyTo.createdAtFrom).toBeNull();
      expect(onlyTo.createdAtToExclusive).toEqual(new Date("2026-08-31T16:00:00.000Z"));
    });

    it.each([
      ["dateFrom", "2026-8-9"],
      ["dateFrom", "2026/08/09"],
      ["dateFrom", "2026-02-30"],
      ["dateFrom", "abc"],
      ["dateTo", "2026-13-01"],
      ["dateTo", "20260809"],
    ])("%s='%s' 格式非法 → 該欄位錯誤", (field, raw) => {
      const result = parseAuditLogQuery({ [field]: raw });
      expect(fieldsOf(result)).toContain(field);
    });

    it("dateFrom／dateTo 為 '' 視同未提供（零錯誤、兩界皆 null）", () => {
      const result = parseAuditLogQuery({ dateFrom: "", dateTo: "" });
      expect(result.errors).toEqual([]);
      expect(result.createdAtFrom).toBeNull();
      expect(result.createdAtToExclusive).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-29／AC-02(e)：台北（UTC+8）日界之雙向釘死（MG-2）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-29 台北（UTC+8）日界雙向釘死（MG-2；UTC 日界之 mutant 必紅）", () => {
    /** 篩選日 D（裁定原文之例：「篩 8/7~8/8 就是台灣時間的 8/7 00:00~8/8 23:59」）。 */
    const D = "2026-08-07";

    it("dateFrom=dateTo=D：台北 D 日 00:00:00（＝D−1 16:00Z）必命中；UTC D 日 23:59（＝台北 D+1 07:59）必不命中", () => {
      const result = parseAuditLogQuery({ dateFrom: D, dateTo: D });
      expect(result.errors).toEqual([]);
      const from = result.createdAtFrom;
      const toExclusive = result.createdAtToExclusive;
      if (from === null || toExclusive === null) throw new Error("unreachable");

      // 台北 2026-08-07 00:00:00.000 ＝ 2026-08-06T16:00:00.000Z → 必命中
      const taipeiDayStart = new Date("2026-08-06T16:00:00.000Z").getTime();
      expect(taipeiDayStart).toBeGreaterThanOrEqual(from.getTime());
      expect(taipeiDayStart).toBeLessThan(toExclusive.getTime());

      // UTC 2026-08-07 23:59:00.000Z ＝ 台北 2026-08-08 07:59 → 必不命中
      const utcDayLate = new Date("2026-08-07T23:59:00.000Z").getTime();
      expect(utcDayLate).toBeGreaterThanOrEqual(toExclusive.getTime());
    });

    it("兩端點之逐字 UTC 字面：偏移歸零（UTC 日界）與偏移方向相反（−8h→+8h）兩種 mutant 皆必紅", () => {
      const result = parseAuditLogQuery({ dateFrom: "2026-08-07", dateTo: "2026-08-08" });
      expect(result.errors).toEqual([]);
      expect(result.createdAtFrom).toEqual(new Date("2026-08-06T16:00:00.000Z"));
      expect(result.createdAtToExclusive).toEqual(new Date("2026-08-08T16:00:00.000Z"));

      // 明示排除兩種 mutant 之輸出（偏移歸零／方向相反），使失敗訊息自帶診斷。
      expect(result.createdAtFrom).not.toEqual(new Date("2026-08-07T00:00:00.000Z"));
      expect(result.createdAtToExclusive).not.toEqual(new Date("2026-08-09T00:00:00.000Z"));
      expect(result.createdAtFrom).not.toEqual(new Date("2026-08-07T08:00:00.000Z"));
      expect(result.createdAtToExclusive).not.toEqual(new Date("2026-08-09T08:00:00.000Z"));
    });

    it("偏移量恰為 −8 小時（固定 +8h 時區；區間長度仍為整日數）", () => {
      const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
      const result = parseAuditLogQuery({ dateFrom: "2026-08-07", dateTo: "2026-08-08" });
      const from = result.createdAtFrom;
      const toExclusive = result.createdAtToExclusive;
      if (from === null || toExclusive === null) throw new Error("unreachable");

      expect(from.getTime()).toBe(Date.UTC(2026, 7, 7) - EIGHT_HOURS_MS);
      expect(toExclusive.getTime()).toBe(Date.UTC(2026, 7, 9) - EIGHT_HOURS_MS);
      // 兩日之區間長度恰 48 小時（平移不改變區間長度）。
      expect(toExclusive.getTime() - from.getTime()).toBe(2 * 24 * 60 * 60 * 1000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-08：dateFrom > dateTo → 400 ＋ fields[]
  // ─────────────────────────────────────────────────────────────────────
  describe("B-08 dateFrom > dateTo → 400 ＋ fields[]", () => {
    it("最小 1 日倒置（dateFrom = dateTo + 1 day）→ dateRange 欄位錯誤", () => {
      const result = parseAuditLogQuery({ dateFrom: "2026-08-10", dateTo: "2026-08-09" });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(fieldsOf(result)).toContain("dateRange");
      expect(result.createdAtFrom).toBeNull();
      expect(result.createdAtToExclusive).toBeNull();
    });

    it("dateFrom == dateTo 不視為倒置（與 B-07 成對，'>=' 誤寫之 mutant 必紅）", () => {
      const result = parseAuditLogQuery({ dateFrom: "2026-08-09", dateTo: "2026-08-09" });
      expect(fieldsOf(result)).not.toContain("dateRange");
      expect(result.errors).toEqual([]);
    });

    it("僅一端可解析時不做倒置比較（不產生誤導性的 dateRange 錯誤）", () => {
      const result = parseAuditLogQuery({ dateFrom: "abc", dateTo: "2026-08-01" });
      expect(fieldsOf(result)).toContain("dateFrom");
      expect(fieldsOf(result)).not.toContain("dateRange");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B-09：actorId／targetId 為不存在之 id → 解析層放行（不洩漏存在性）
  // ─────────────────────────────────────────────────────────────────────
  describe("B-09 actorId／targetId（解析層不驗證存在性，不洩漏使用者存在性）", () => {
    it("任意字串一律原樣放行、零錯誤（不做 cuid 格式驗證，避免以 400 洩漏 id 形狀）", () => {
      const result = parseAuditLogQuery({
        actorId: "does-not-exist-0000",
        targetId: "neither-does-this",
      });
      expect(result.errors).toEqual([]);
      expect(result.actorId).toBe("does-not-exist-0000");
      expect(result.targetId).toBe("neither-does-this");
    });

    it("'' 視同未提供 → null、零錯誤", () => {
      const result = parseAuditLogQuery({ actorId: "", targetId: "" });
      expect(result.errors).toEqual([]);
      expect(result.actorId).toBeNull();
      expect(result.targetId).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 型別防禦：重複 query key（Fastify 執行期給 string[]）不得穿透到 DB 層
  // （沿 PHASE-005 T6-AR-1／application-query.ts B-35 之既有紀律）
  // ─────────────────────────────────────────────────────────────────────
  describe("重複 query key（string[]）之型別防禦", () => {
    it.each(["action", "actorId", "targetId", "dateFrom", "dateTo", "page", "pageSize"])(
      "%s 帶入陣列 → 該欄位錯誤且不放行（不得穿透為 Prisma where 值）",
      (field) => {
        const result = parseAuditLogQuery({ [field]: ["a", "b"] });
        expect(fieldsOf(result)).toContain(field);
        expect(result.action).toBeNull();
        expect(result.actorId).toBeNull();
        expect(result.targetId).toBeNull();
        expect(result.createdAtFrom).toBeNull();
        expect(result.createdAtToExclusive).toBeNull();
      }
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 一次回報全部欄位錯誤（沿既有 VALIDATION_ERROR 慣例）
  // ─────────────────────────────────────────────────────────────────────
  describe("多欄同時違規 → 一次回報全部欄位錯誤（非只回第一項）", () => {
    it("action／page／pageSize／dateFrom 四欄同時違規 → 四個欄位錯誤齊備", () => {
      const result = parseAuditLogQuery({
        action: "NOPE",
        page: "0",
        pageSize: "-1",
        dateFrom: "not-a-date",
      });
      const fields = fieldsOf(result);
      expect(fields).toContain("action");
      expect(fields).toContain("page");
      expect(fields).toContain("pageSize");
      expect(fields).toContain("dateFrom");
    });

    it("每個欄位錯誤皆有非空 reason（供前端定位）", () => {
      const result = parseAuditLogQuery({ action: "NOPE", page: "0" });
      for (const err of result.errors) {
        expect(typeof err.reason).toBe("string");
        expect(err.reason.length).toBeGreaterThan(0);
        expect(Object.keys(err).sort()).toEqual(["field", "reason"]);
      }
    });
  });
});

describe("AC-02(f): 解析為純函式 — 零 DB／零 Prisma 型別相依", () => {
  const SRC_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/audit/audit-query.ts"
  );

  /** 去除註解（保留字串字面，因 import 路徑本身即字串）。 */
  function stripComments(src: string): string {
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  const source = stripComments(readFileSync(SRC_PATH, "utf8"));

  it("本模組原始碼零 @prisma/client 匯入、零 Prisma 型別引用", () => {
    expect(source).not.toContain("@prisma/client");
    expect(source).not.toContain("PrismaClient");
    expect(source).not.toMatch(/\bPrisma\./);
  });

  it("本模組原始碼零 DB 存取（無 prisma client 呼叫、無 $transaction／findMany 等）", () => {
    expect(source).not.toMatch(/\bprisma\b/);
    expect(source).not.toContain("findMany");
    expect(source).not.toContain("$transaction");
    expect(source).not.toContain("auditLog.");
  });

  it("本模組原始碼零時鐘、零 I/O（無 new Date()／Date.now()／fs／fetch）", () => {
    expect(source).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("fetch(");
  });

  it("同步函式：回傳值非 thenable（不得為 async）", () => {
    const result: unknown = parseAuditLogQuery({});
    expect(result).not.toBeNull();
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });

  it("同輸入恆同輸出（決定性；toEqual 可比）", () => {
    const raw = {
      action: "USER_CREATED",
      actorId: "a1",
      targetId: "t1",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      page: "2",
      pageSize: "101",
    };
    expect(parseAuditLogQuery({ ...raw })).toEqual(parseAuditLogQuery({ ...raw }));
  });

  it("不改寫輸入物件（零副作用）", () => {
    const raw = { action: "USER_CREATED", page: "2", pageSize: "101" };
    const snapshot = { ...raw };
    parseAuditLogQuery(raw);
    expect(raw).toEqual(snapshot);
  });
});
