/**
 * PHASE-010-T1 — `flattenAuditSummary`（`AuditLog.summary` → `changes[]` 扁平化）單元測試
 *
 * 對象：`backend/src/audit/audit-summary.ts`（純函式：零 DB、零時鐘、零 I/O）。
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-010.md`，Gate 通過版逐字）
 * ---------------------------------------------------------------------------
 * §2.B AC-06 — `changes[]` 之扁平化契約（依 §16 D3 裁定＝(c)：後端攤平三欄）
 *   (a) 每列輸出 `changes: Array<{ field: string; before: string | null;
 *       after: string | null }>`，由 `AuditLog.summary`（`Json?`）經**單一純函式**
 *       扁平化而得。
 *   (b) 形狀分派：`summary` 之值為物件且**恰含 `before`／`after` 兩鍵**者 → 拆為
 *       該兩欄；為純量（`string`／`number`／`boolean`／`null`）者 →
 *       `before: null` ＋ `after: 值之字串化`；`summary` 為 `null`／`{}` →
 *       `changes: []`。
 *   (c) 同一 `action` 之異形 `summary` 皆須成立（四種真實形狀，見下方 FIXTURES）。
 *   (d) 鍵守恆：扁平化不得遺失任何 `summary` 頂層鍵——以「輸入頂層鍵集合 ⊆ 輸出
 *       `field` 集合」之封閉斷言守門，刪一鍵之 mutant 必紅。
 *   (e) 純函式：零 DB、零時鐘、零 I/O；同輸入恆同輸出（`toEqual` 可比）。
 *   (f) 值之字串化不得產生 `"[object Object]"`——(c) 之巢狀混合形為最高密度
 *       案例；正向斷言 ＋ 全 `changes` 之 `not.toContain("[object Object]")`
 *       負向掃描並存。
 * §5 邊界條件 B-11（`summary` 為 `null` → `changes: []`，不拋錯）、
 *   B-12（巢狀混合形：三個頂層鍵皆現身且零 `"[object Object]"`）。
 * §12 映射表：本檔兩列 —— `AC-06: flattenAuditSummary 形狀分派與鍵守恆（刪鍵
 *   mutant 必紅）`／`AC-06(c)(f): 四種真實 summary 形狀皆成立且零 [object Object]`
 *   （describe 名逐字對應）。
 *
 * ---------------------------------------------------------------------------
 * 真實 `summary` 形狀之實查依據（本檔撰寫當下之 grep／read，非轉述 Packet）
 * ---------------------------------------------------------------------------
 * 全 13 個 `auditLog.create(`／`writeAudit` 寫入站點逐一實查所得之 `summary`
 * 形狀（行號為本次 grep 值，僅供定位）：
 *   · `admin/routes.ts` :508／:593／:697   `APPLICATION_CREATED_ON_BEHALF`
 *       一般代建立三型：全為純量（`applicationId`／`type`／各型日期與金額字串）。
 *   · `applications/routes.ts` :1736       `APPLICATION_CREATED_ON_BEHALF`
 *       修正版形：`{applicationId, type, revisionOf}`（全純量）。
 *   · `applications/routes.ts` :888／:1089／:1298  `APPLICATION_UPDATED_ON_BEHALF`
 *       `{before, after}` 形：頂層**混合**純量（`applicationId`／`type`）與
 *       `{before, after}` 兩鍵物件（`tripDate`／`purpose`／`segmentsCount` 等）。
 *   · `applications/routes.ts` :1518       `APPLICATION_VOIDED`
 *       封閉四鍵 `{applicationId, type, reason, voidedAt}`（全純量，含使用者自由文字）。
 *   · `users/fuel-consumption-routes.ts` :251-259
 *       `USER_FUEL_CONSUMPTION_VERSION_CREATED` **巢狀混合形**：
 *       `{ before: {...} | null, after: {...}, basisNote }`——`before`／`after`
 *       各自為**物件**（而非純量），且與純量 `basisNote` 並存。**此為 AC-06(f)
 *       之最高密度案例**（天真 `String(value)` 會產生兩個 `"[object Object]"`）。
 *   · `parameters/routes.ts` :211／:285／:383  `PARAMETER_VERSION_CREATED`（全純量）。
 *   · `audit/audit.ts` :45（`writeAudit` 之唯一 `auditLog.create`）之五個帳號類
 *       呼叫端（`admin/routes.ts` :225／:272／:308／:368／:426；各自之 `detail:`
 *       酬載在 :231／:278／:314／:374／:432）：
 *       `USER_CREATED` `{role, employeeNumber?}`／
 *       `USER_DEACTIVATED`／`USER_ACTIVATED` `{isActive: {from, to}}`
 *       ——**兩鍵物件但鍵名為 `from`／`to`（非 `before`／`after`）**，屬 AC-06(b)
 *       之「非 before/after 兩鍵物件」分支，是 `[object Object]` 的第二個真實
 *       高風險點／
 *       `USER_PASSWORD_RESET` `{mustChangePassword: true}`（布林純量）／
 *       `USER_DELETED` `{deletedLoginName, deletedDisplayName}`。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計
 * ---------------------------------------------------------------------------
 * 1. AC-06(d) 鍵守恆以 `expectKeyConservation` 對**全部** fixture 逐一執行，且
 *    斷言為雙向封閉（輸入鍵集 ⊆ 輸出 field 集，且輸出 field 集 ⊆ 輸入鍵集、
 *    長度相等）——「刪一鍵」與「捏造一鍵」兩種 mutant 皆必紅。
 *    刪鍵 mutant 之紅燈實錄見 Task Handoff。
 * 2. AC-06(f) 之負向掃描（`not.toContain("[object Object]")`）與正向值斷言並存：
 *    只有負向掃描時，「一律回空陣列」的 mutant 會恆綠——鍵守恆與逐值正向斷言
 *    即為其鑑別力來源。
 * 3. AC-06(b) 之三分支以「相鄰輸入」成對釘死：`{before, after}`（恰兩鍵，拆欄）
 *    ／`{before, after, extra}`（三鍵，不拆）／`{before}`（一鍵，不拆）
 *    ／`{from, to}`（兩鍵但鍵名不同，不拆）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AuditChangeDto, flattenAuditSummary } from "../../src/audit/audit-summary.js";

// ---------------------------------------------------------------------------
// 共用斷言助手
// ---------------------------------------------------------------------------

/**
 * AC-06(d) 鍵守恆之封閉斷言（雙向）：
 *   · 輸入頂層鍵集合 ⊆ 輸出 `field` 集合（刪鍵 mutant 必紅）
 *   · 輸出 `field` 集合 ⊆ 輸入頂層鍵集合，且長度相等（捏造鍵／重複鍵 mutant 必紅）
 */
function expectKeyConservation(summary: Record<string, unknown>): AuditChangeDto[] {
  const changes = flattenAuditSummary(summary);
  const inputKeys = Object.keys(summary);
  const outputFields = changes.map((c) => c.field);

  for (const key of inputKeys) {
    expect(outputFields).toContain(key);
  }
  expect(new Set(outputFields)).toEqual(new Set(inputKeys));
  expect(outputFields.length).toBe(inputKeys.length);

  return changes;
}

/** AC-06(f)：全 `changes` 之 `"[object Object]"` 負向掃描。 */
function expectNoObjectObject(changes: AuditChangeDto[]): void {
  expect(JSON.stringify(changes)).not.toContain("[object Object]");
  for (const change of changes) {
    if (change.before !== null) expect(change.before).not.toContain("[object Object]");
    if (change.after !== null) expect(change.after).not.toContain("[object Object]");
  }
}

/** AC-06(a)：每列恰三鍵、`field` 為字串、`before`／`after` 為 `string | null`。 */
function expectChangeDtoShape(changes: AuditChangeDto[]): void {
  for (const change of changes) {
    expect(Object.keys(change).sort()).toEqual(["after", "before", "field"]);
    expect(typeof change.field).toBe("string");
    for (const value of [change.before, change.after]) {
      expect(value === null || typeof value === "string").toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// 真實 summary fixture（形狀逐一取自實查之寫入站點；值為合成資料）
// ---------------------------------------------------------------------------

/** ① `APPLICATION_CREATED_ON_BEHALF` — 一般代建立（純量集；admin/routes.ts :508 形） */
const CREATED_ON_BEHALF_PLAIN = {
  applicationId: "clapp0000000000000000001",
  type: "TRAVEL",
  tripDate: "2026-08-01",
  purpose: "拜訪客戶（合成資料）",
} satisfies Record<string, unknown>;

/** ② `APPLICATION_CREATED_ON_BEHALF` — 修正版（applications/routes.ts :1736 形） */
const CREATED_ON_BEHALF_REVISION = {
  applicationId: "clapp0000000000000000002",
  type: "TRAVEL",
  revisionOf: "clapp0000000000000000001",
} satisfies Record<string, unknown>;

/** ③ `APPLICATION_UPDATED_ON_BEHALF` — `{before, after}` 形（applications/routes.ts :888 形） */
const UPDATED_ON_BEHALF = {
  applicationId: "clapp0000000000000000001",
  type: "TRAVEL",
  tripDate: { before: "2026-08-01", after: "2026-08-02" },
  purpose: { before: "拜訪客戶（合成資料）", after: "教育訓練（合成資料）" },
  segmentsCount: { before: 2, after: 3 },
} satisfies Record<string, unknown>;

/**
 * ④ `USER_FUEL_CONSUMPTION_VERSION_CREATED` — **巢狀混合形**
 * （users/fuel-consumption-routes.ts :251-259 形；AC-06(c) 第四形、AC-06(f) 最高密度案例）
 */
const FUEL_CONSUMPTION_NESTED = {
  before: { fuelType: "GASOLINE_95", kmPerLiter: "12.3400", effectiveFrom: "2026-01-01" },
  after: { fuelType: "GASOLINE_98", kmPerLiter: "13.5000", effectiveFrom: "2026-08-01" },
  basisNote: "原廠油耗數據（合成資料）",
} satisfies Record<string, unknown>;

/** ④' 同形之 `before: null` 變體（首版建立時 `beforeRow` 為 null，實查同站點） */
const FUEL_CONSUMPTION_NESTED_FIRST_VERSION = {
  before: null,
  after: { fuelType: "GASOLINE_95", kmPerLiter: "12.3400", effectiveFrom: "2026-01-01" },
  basisNote: "首版（合成資料）",
} satisfies Record<string, unknown>;

/** ⑤ `APPLICATION_VOIDED` — 封閉四鍵（applications/routes.ts :1518 形；含使用者自由文字） */
const VOIDED = {
  applicationId: "clapp0000000000000000003",
  type: "MAINTENANCE",
  reason: "金額填錯，重新申請（合成資料）",
  voidedAt: "2026-08-09T03:21:00.000Z",
} satisfies Record<string, unknown>;

/** ⑥ `USER_DEACTIVATED` — `{isActive: {from, to}}`（audit.ts writeAudit；admin/routes.ts :278 形） */
const USER_DEACTIVATED = {
  isActive: { from: true, to: false },
} satisfies Record<string, unknown>;

/** ⑦ `PARAMETER_VERSION_CREATED`（parameters/routes.ts :211 形） */
const PARAMETER_VERSION_CREATED = {
  parameterType: "FUEL_PRICE",
  fuelType: "GASOLINE_95",
  pricePerLiter: "31.5000",
  effectiveFrom: "2026-08-01",
} satisfies Record<string, unknown>;

/** ⑧ `USER_PASSWORD_RESET` — 封閉單鍵布林（admin/routes.ts :374 形） */
const USER_PASSWORD_RESET = {
  mustChangePassword: true,
} satisfies Record<string, unknown>;

/** ⑨ `USER_CREATED`（admin/routes.ts :231 形） */
const USER_CREATED = {
  role: "USER",
  employeeNumber: "E0001",
} satisfies Record<string, unknown>;

/** ⑩ `USER_DELETED`（admin/routes.ts :432 形） */
const USER_DELETED = {
  deletedLoginName: "synthetic.user",
  deletedDisplayName: "合成使用者",
} satisfies Record<string, unknown>;

const ALL_REAL_FIXTURES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["APPLICATION_CREATED_ON_BEHALF（一般代建立）", CREATED_ON_BEHALF_PLAIN],
  ["APPLICATION_CREATED_ON_BEHALF（修正版）", CREATED_ON_BEHALF_REVISION],
  ["APPLICATION_UPDATED_ON_BEHALF（{before,after} 形）", UPDATED_ON_BEHALF],
  ["USER_FUEL_CONSUMPTION_VERSION_CREATED（巢狀混合形）", FUEL_CONSUMPTION_NESTED],
  [
    "USER_FUEL_CONSUMPTION_VERSION_CREATED（巢狀混合形／before 為 null）",
    FUEL_CONSUMPTION_NESTED_FIRST_VERSION,
  ],
  ["APPLICATION_VOIDED", VOIDED],
  ["USER_DEACTIVATED（{from,to} 兩鍵物件）", USER_DEACTIVATED],
  ["PARAMETER_VERSION_CREATED", PARAMETER_VERSION_CREATED],
  ["USER_PASSWORD_RESET", USER_PASSWORD_RESET],
  ["USER_CREATED", USER_CREATED],
  ["USER_DELETED", USER_DELETED],
];

// ---------------------------------------------------------------------------
// AC-06(a)(b)(d)(e)
// ---------------------------------------------------------------------------

describe("AC-06: flattenAuditSummary 形狀分派與鍵守恆（刪鍵 mutant 必紅）", () => {
  describe("AC-06(b) summary 為 null／{} → changes: []（B-11：不拋錯）", () => {
    it("null → []", () => {
      expect(flattenAuditSummary(null)).toEqual([]);
    });

    it("undefined → []", () => {
      expect(flattenAuditSummary(undefined)).toEqual([]);
    });

    it("{} → []", () => {
      expect(flattenAuditSummary({})).toEqual([]);
    });
  });

  describe("AC-06(b) 純量值 → before: null ＋ after: 值之字串化", () => {
    it.each([
      ["string", "abc", "abc"],
      ["number（整數）", 42, "42"],
      ["number（小數）", 12.34, "12.34"],
      ["number（0）", 0, "0"],
      ["boolean true", true, "true"],
      ["boolean false", false, "false"],
      ["空字串", "", ""],
    ])("%s：%o → after = '%s'", (_label, value, expected) => {
      expect(flattenAuditSummary({ f: value })).toEqual([
        { field: "f", before: null, after: expected },
      ]);
    });

    it("值為 null → before: null ＋ after: null（鍵仍守恆，不得消失）", () => {
      expect(flattenAuditSummary({ f: null })).toEqual([{ field: "f", before: null, after: null }]);
    });

    it("多個純量鍵：逐鍵一列，順序沿輸入頂層鍵順序", () => {
      const changes = flattenAuditSummary({ a: 1, b: "two", c: false });
      expect(changes).toEqual([
        { field: "a", before: null, after: "1" },
        { field: "b", before: null, after: "two" },
        { field: "c", before: null, after: "false" },
      ]);
    });
  });

  describe("AC-06(b) 值為物件且恰含 before／after 兩鍵 → 拆為該兩欄", () => {
    it("{before, after} 純量對 → 拆欄", () => {
      expect(flattenAuditSummary({ purpose: { before: "舊", after: "新" } })).toEqual([
        { field: "purpose", before: "舊", after: "新" },
      ]);
    });

    it("{before, after} 之一端為 null → 該端為 null（不得字串化為 'null'）", () => {
      expect(flattenAuditSummary({ purpose: { before: null, after: "新" } })).toEqual([
        { field: "purpose", before: null, after: "新" },
      ]);
      expect(flattenAuditSummary({ purpose: { before: "舊", after: null } })).toEqual([
        { field: "purpose", before: "舊", after: null },
      ]);
    });

    it("{before, after} 之數值端字串化", () => {
      expect(flattenAuditSummary({ segmentsCount: { before: 2, after: 3 } })).toEqual([
        { field: "segmentsCount", before: "2", after: "3" },
      ]);
    });

    it("鍵序顛倒的 {after, before} 亦視為同一形（拆欄，不因鍵序而異）", () => {
      expect(flattenAuditSummary({ purpose: { after: "新", before: "舊" } })).toEqual([
        { field: "purpose", before: "舊", after: "新" },
      ]);
    });

    it("三鍵 {before, after, extra} → 不拆欄（恰兩鍵之條件），整體字串化且非 [object Object]", () => {
      const changes = flattenAuditSummary({ f: { before: "舊", after: "新", extra: 1 } });
      expect(changes).toHaveLength(1);
      const [only] = changes;
      expect(only?.field).toBe("f");
      expect(only?.before).toBeNull();
      expect(only?.after).not.toBeNull();
      expect(only?.after).not.toContain("[object Object]");
      expect(only?.after).toContain("extra");
    });

    it("單鍵 {before} → 不拆欄（恰兩鍵之條件），整體字串化", () => {
      const changes = flattenAuditSummary({ f: { before: "舊" } });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.before).toBeNull();
      expect(changes[0]?.after).not.toContain("[object Object]");
    });

    it("{from, to} 兩鍵但鍵名非 before／after → 不拆欄，整體字串化且非 [object Object]", () => {
      const changes = flattenAuditSummary({ isActive: { from: true, to: false } });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.field).toBe("isActive");
      expect(changes[0]?.before).toBeNull();
      expect(changes[0]?.after).not.toContain("[object Object]");
      expect(changes[0]?.after).toContain("from");
      expect(changes[0]?.after).toContain("to");
    });

    it("陣列值 → 不拆欄，字串化且非 [object Object]", () => {
      const changes = flattenAuditSummary({ tags: ["a", "b"] });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.field).toBe("tags");
      expect(changes[0]?.after).not.toContain("[object Object]");
      expect(changes[0]?.after).toContain("a");
      expect(changes[0]?.after).toContain("b");
    });
  });

  describe("AC-06(a) 每列鍵集封閉：恰 field／before／after 三鍵", () => {
    it.each(ALL_REAL_FIXTURES)("%s", (_label, summary) => {
      expectChangeDtoShape(flattenAuditSummary(summary));
    });
  });

  describe("AC-06(d) 鍵守恆：輸入頂層鍵集合 ⊆ 輸出 field 集合（刪鍵 mutant 必紅）", () => {
    it.each(ALL_REAL_FIXTURES)("%s", (_label, summary) => {
      expectKeyConservation(summary);
    });

    it("寬度壓力：20 個頂層鍵逐一守恆（刪任一鍵之 mutant 必紅）", () => {
      const summary: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) {
        summary[`field${i}`] = i % 2 === 0 ? `v${i}` : { before: i, after: i + 1 };
      }
      const changes = expectKeyConservation(summary);
      expect(changes).toHaveLength(20);
    });

    it("值為 null／空字串／false 之鍵亦不得被過濾掉（falsy 過濾 mutant 必紅）", () => {
      const changes = expectKeyConservation({ a: null, b: "", c: false, d: 0 });
      expect(changes.map((c) => c.field)).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("AC-06(e) 純函式：零 DB／零時鐘／零 I/O、同輸入恆同輸出", () => {
    const SRC_PATH = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/audit/audit-summary.ts"
    );

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

    it("原始碼零 import（零 DB／零 Prisma／零 I/O 相依）", () => {
      expect(source).not.toMatch(/^\s*import\s/m);
      expect(source).not.toContain("@prisma/client");
      expect(source).not.toMatch(/\bprisma\b/);
      expect(source).not.toContain("node:fs");
    });

    it("原始碼零時鐘（無 new Date()／Date.now()）", () => {
      expect(source).not.toMatch(/new\s+Date\s*\(/);
      expect(source).not.toMatch(/Date\.now\s*\(/);
    });

    it("同輸入恆同輸出（toEqual 可比）", () => {
      expect(flattenAuditSummary(FUEL_CONSUMPTION_NESTED)).toEqual(
        flattenAuditSummary(FUEL_CONSUMPTION_NESTED)
      );
    });

    it("不改寫輸入物件（零副作用）", () => {
      const input = structuredClone(UPDATED_ON_BEHALF) as Record<string, unknown>;
      const snapshot = structuredClone(input);
      flattenAuditSummary(input);
      expect(input).toEqual(snapshot);
    });

    it("同步函式：回傳陣列而非 Promise", () => {
      const result: unknown = flattenAuditSummary({ a: 1 });
      expect(Array.isArray(result)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-06(c)(f)
// ---------------------------------------------------------------------------

describe("AC-06(c)(f): 四種真實 summary 形狀皆成立且零 [object Object]", () => {
  it("① APPLICATION_CREATED_ON_BEHALF（一般代建立，純量集）逐欄正確", () => {
    const changes = expectKeyConservation(CREATED_ON_BEHALF_PLAIN);
    expect(changes).toEqual([
      { field: "applicationId", before: null, after: "clapp0000000000000000001" },
      { field: "type", before: null, after: "TRAVEL" },
      { field: "tripDate", before: null, after: "2026-08-01" },
      { field: "purpose", before: null, after: "拜訪客戶（合成資料）" },
    ]);
    expectNoObjectObject(changes);
  });

  it("② APPLICATION_CREATED_ON_BEHALF（修正版，含 revisionOf）逐欄正確", () => {
    const changes = expectKeyConservation(CREATED_ON_BEHALF_REVISION);
    expect(changes).toEqual([
      { field: "applicationId", before: null, after: "clapp0000000000000000002" },
      { field: "type", before: null, after: "TRAVEL" },
      { field: "revisionOf", before: null, after: "clapp0000000000000000001" },
    ]);
    expectNoObjectObject(changes);
  });

  it("③ APPLICATION_UPDATED_ON_BEHALF（頂層混合純量與 {before,after} 物件）逐欄正確", () => {
    const changes = expectKeyConservation(UPDATED_ON_BEHALF);
    expect(changes).toEqual([
      { field: "applicationId", before: null, after: "clapp0000000000000000001" },
      { field: "type", before: null, after: "TRAVEL" },
      { field: "tripDate", before: "2026-08-01", after: "2026-08-02" },
      { field: "purpose", before: "拜訪客戶（合成資料）", after: "教育訓練（合成資料）" },
      { field: "segmentsCount", before: "2", after: "3" },
    ]);
    expectNoObjectObject(changes);
  });

  it("④ USER_FUEL_CONSUMPTION_VERSION_CREATED（巢狀混合形）：三個頂層鍵皆現身（B-12）", () => {
    const changes = expectKeyConservation(FUEL_CONSUMPTION_NESTED);
    expect(changes.map((c) => c.field)).toEqual(["before", "after", "basisNote"]);
  });

  it("④ 巢狀混合形之逐欄值：before／after 兩物件皆完整可讀，零 [object Object]（AC-06(f) 最高密度案例）", () => {
    const changes = flattenAuditSummary(FUEL_CONSUMPTION_NESTED);
    expectNoObjectObject(changes);

    const byField = new Map(changes.map((c) => [c.field, c]));

    const beforeRow = byField.get("before");
    expect(beforeRow?.before).toBeNull();
    // 巢狀物件之內容必須逐項可讀（非 "[object Object]"、非空字串）
    for (const token of ["fuelType", "GASOLINE_95", "kmPerLiter", "12.3400", "2026-01-01"]) {
      expect(beforeRow?.after).toContain(token);
    }

    const afterRow = byField.get("after");
    expect(afterRow?.before).toBeNull();
    for (const token of ["GASOLINE_98", "13.5000", "2026-08-01"]) {
      expect(afterRow?.after).toContain(token);
    }

    const basisNoteRow = byField.get("basisNote");
    expect(basisNoteRow).toEqual({
      field: "basisNote",
      before: null,
      after: "原廠油耗數據（合成資料）",
    });
  });

  it("④' 巢狀混合形之 before: null 變體：before 鍵仍在且值為 null", () => {
    const changes = expectKeyConservation(FUEL_CONSUMPTION_NESTED_FIRST_VERSION);
    expect(changes.map((c) => c.field)).toEqual(["before", "after", "basisNote"]);
    expect(changes[0]).toEqual({ field: "before", before: null, after: null });
    expectNoObjectObject(changes);
  });

  it("⑤ APPLICATION_VOIDED：作廢原因逐字可見（BE-US-31② 之終點）", () => {
    const changes = expectKeyConservation(VOIDED);
    expect(changes).toContainEqual({
      field: "reason",
      before: null,
      after: "金額填錯，重新申請（合成資料）",
    });
    expectNoObjectObject(changes);
  });

  it("⑥ USER_DEACTIVATED（{from,to} 兩鍵物件）：內容逐項可讀，零 [object Object]", () => {
    const changes = expectKeyConservation(USER_DEACTIVATED);
    expectNoObjectObject(changes);
    expect(changes[0]?.after).toContain("from");
    expect(changes[0]?.after).toContain("true");
    expect(changes[0]?.after).toContain("false");
  });

  it("⑦⑧⑨⑩ 其餘真實形狀逐欄正確", () => {
    expect(flattenAuditSummary(PARAMETER_VERSION_CREATED)).toEqual([
      { field: "parameterType", before: null, after: "FUEL_PRICE" },
      { field: "fuelType", before: null, after: "GASOLINE_95" },
      { field: "pricePerLiter", before: null, after: "31.5000" },
      { field: "effectiveFrom", before: null, after: "2026-08-01" },
    ]);
    expect(flattenAuditSummary(USER_PASSWORD_RESET)).toEqual([
      { field: "mustChangePassword", before: null, after: "true" },
    ]);
    expect(flattenAuditSummary(USER_CREATED)).toEqual([
      { field: "role", before: null, after: "USER" },
      { field: "employeeNumber", before: null, after: "E0001" },
    ]);
    expect(flattenAuditSummary(USER_DELETED)).toEqual([
      { field: "deletedLoginName", before: null, after: "synthetic.user" },
      { field: "deletedDisplayName", before: null, after: "合成使用者" },
    ]);
  });

  describe("AC-06(f) 全 fixture 之 [object Object] 負向掃描", () => {
    it.each(ALL_REAL_FIXTURES)("%s", (_label, summary) => {
      expectNoObjectObject(flattenAuditSummary(summary));
    });

    it("深層巢狀（三層）亦零 [object Object]", () => {
      const changes = flattenAuditSummary({
        deep: { a: { b: { c: "leaf" } } },
        pair: { before: { x: 1 }, after: { x: 2 } },
      });
      expectNoObjectObject(changes);
      expect(changes.map((c) => c.field)).toEqual(["deep", "pair"]);
      expect(changes[0]?.after).toContain("leaf");
      expect(changes[1]?.before).toContain("1");
      expect(changes[1]?.after).toContain("2");
    });
  });
});
