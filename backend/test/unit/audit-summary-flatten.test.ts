/**
 * PHASE-010-T1 — `flattenAuditSummary`（`AuditLog.summary` → `changes[]` 扁平化）單元測試
 * （**PHASE-010-T-MG1-BE1** 依 2026-08-09 Mock Gate MG-1 裁定重寫期望輸出：
 * (b-0) 巢狀逐子欄拆列／(b-1) `{from,to}` 拆兩欄／(d) 鍵守恆改集合相等）
 *
 * 對象：`backend/src/audit/audit-summary.ts`（純函式：零 DB、零時鐘、零 I/O）。
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-010.md`，`SPEC-REV-010-GATE` 修訂版逐字）
 * ---------------------------------------------------------------------------
 * §2.B AC-06 — `changes[]` 之扁平化契約【依 §16 D3；(b)(c)(d) 依 2026-08-09
 *   Mock Gate MG-1 裁定「智能攤平」修訂（`SPEC-REV-010-GATE`）】
 *   (a) 每列輸出 `changes: Array<{ field: string; before: string | null;
 *       after: string | null }>`，由 `AuditLog.summary`（`Json?`）經**單一純函式**
 *       扁平化而得。
 *   (b) 形狀分派（自上而下：先 `summary` 級預檢 (b-0)，再逐頂層鍵 (b-1)/(b-2)）：
 *       **(b-0)** `summary` 為物件且**同時含 `before` 與 `after` 兩個頂層鍵**，且
 *             兩者之值**至少一為物件**、另一為物件或 `null` → 該兩個頂層鍵**不各
 *             自成列**，改以兩物件之**子鍵聯集**逐子鍵拆列：每一子鍵恰一列
 *             `{ field: <子鍵>, before: <before[子鍵] 之字串化；該側為 null 或無
 *             此子鍵時為 null>, after: <同上> }`。子鍵順序＝`before` 物件之鍵序，
 *             再接 `after` 中未出現於 `before` 者（`before` 為 `null` 時即 `after`
 *             之鍵序）；子鍵列插入於 `before` 頂層鍵之**原位置**。**其餘頂層鍵**
 *             （如 `basisNote`）照 (b-1)/(b-2) 各自一列，位置沿其原插入序。
 *       **(b-1)** 值為物件且**恰含 `before`／`after` 兩鍵** → 拆為該兩欄；值為物件
 *             且**恰含 `from`／`to` 兩鍵** → 拆為 `before: from 之字串化`／
 *             `after: to 之字串化`（**與 `{before,after}` 同等待遇**；MG-1 裁定
 *             逐字：「`{from,to}` 拆進改前／改後兩欄」）。鍵序不拘；「**恰兩鍵**」
 *             為字面條件（`{before,after,extra}` 三鍵或一鍵皆**不**走此分支）。
 *       **(b-2)** 其餘一切值 → `before: null` ＋ `after: 值之字串化`。
 *       **(b-3)** `summary` 為 `null`／非物件／`{}` → `changes: []`。
 *       揭露面註記：(b-0)(b-1) 之拆欄**不擴大揭露面**——輸出內容仍恰為同一
 *       `summary` 之既有值，僅呈現形式改變。
 *   (c) 同一 `action` 之異形 `summary` 皆須成立（四種真實形狀，見下方 FIXTURES；
 *       案例依 MG-1 修訂後之期望輸出重寫）。
 *   (d) **鍵守恆（子欄拆列後之封閉基準）**：輸出之 `field` 集合**恰等於**
 *       `( summary 頂層鍵集合 − { 觸發 (b-0) 之 before／after 兩鍵 } ) ∪ ( 該兩
 *       物件之子鍵聯集 )`——以 `toEqual` 之**集合相等**（非僅 `⊆`）封閉斷言守門：
 *       **刪任一頂層鍵之 mutant 必紅**，且**刪任一子鍵之 mutant 亦必紅**（防
 *       「聯集取成交集」「只取 `after` 側子鍵」「漏 `before` 獨有子鍵」三類）。
 *   (e) 純函式：零 DB、零時鐘、零 I/O；同輸入恆同輸出（`toEqual` 可比）。
 *   (f) 值之字串化不得產生 `"[object Object]"`——(c) 之巢狀混合形為最高密度
 *       案例；正向斷言 ＋ 全 `changes` 之 `not.toContain("[object Object]")`
 *       負向掃描並存。
 * §5 邊界條件 B-11（`summary` 為 `null` → `changes: []`，不拋錯）、
 *   B-12（巢狀混合形 → 走 (b-0)：恰 4 列＝三子鍵 ＋ `basisNote`，頂層 `before`／
 *   `after` 不各自成列，且零 `"[object Object]"`）、
 *   B-26（`{isActive: {from,to}}` → 走 (b-1)：一列 `before:"true"`／`after:"false"`，
 *   輸出 `'{"from":true,"to":false}'` 之 mutant 必紅）、
 *   B-27（巢狀首版 `before` 為 `null` → 同 4 列，三子鍵列之 `before` 皆為 `null`），
 *   B-28（兩側子鍵不對稱 → 以**聯集**拆列，取成交集之 mutant 必紅）。
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
 *       之最高密度案例**（天真 `String(value)` 會產生兩個 `"[object Object]"`），
 *       亦為 MG-1 修訂後 AC-06(b-0) 之唯一真實觸發者（→ 恰 4 列）。
 *   · `parameters/routes.ts` :211／:285／:383  `PARAMETER_VERSION_CREATED`（全純量）。
 *   · `audit/audit.ts` :45（`writeAudit` 之唯一 `auditLog.create`）之五個帳號類
 *       呼叫端（`admin/routes.ts` :225／:272／:308／:368／:426；各自之 `detail:`
 *       酬載在 :231／:278／:314／:374／:432）：
 *       `USER_CREATED` `{role, employeeNumber?}`／
 *       `USER_DEACTIVATED`／`USER_ACTIVATED` `{isActive: {from, to}}`
 *       ——**兩鍵物件但鍵名為 `from`／`to`（非 `before`／`after`）**；MG-1 修訂後
 *       走 AC-06(b-1) 之 `{from,to}` 分支（與 `{before,after}` **同等待遇**，拆進
 *       改前／改後兩欄），修訂前則整包 `JSON.stringify` 落於改後欄／
 *       `USER_PASSWORD_RESET` `{mustChangePassword: true}`（布林純量）／
 *       `USER_DELETED` `{deletedLoginName, deletedDisplayName}`。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力設計
 * ---------------------------------------------------------------------------
 * 1. AC-06(d) 鍵守恆以 `expectKeyConservation` 對**全部** fixture 逐一執行，斷言
 *    為 AC-06(d) 封閉式之**集合相等**（期望集合由 Spec 之公式在測試側獨立算出，
 *    不呼叫受測模組的任何內部判別）——「刪一頂層鍵」「刪一子鍵」「聯集取成交集」
 *    「捏造一鍵」四種 mutant 皆必紅。刪鍵 mutant 之紅燈實錄見 Task Handoff。
 * 2. AC-06(f) 之負向掃描（`not.toContain("[object Object]")`）與正向值斷言並存：
 *    只有負向掃描時，「一律回空陣列」的 mutant 會恆綠——鍵守恆與逐值正向斷言
 *    即為其鑑別力來源。
 * 3. AC-06(b-1) 之分支以「相鄰輸入」成對釘死：`{before, after}`（恰兩鍵，拆欄）
 *    ／`{from, to}`（恰兩鍵、鍵名不同，**同樣拆欄**——MG-1 新語意）
 *    ／`{before, after, extra}`（三鍵，不拆）／`{before}`（一鍵，不拆）
 *    ／`{from, to, extra}`（三鍵，不拆）。
 * 4. AC-06(b-0) 之預檢以「相鄰輸入」成對釘死：兩側皆物件（拆）／一側 `null`
 *    另一側物件（拆——**既有語意擴張半邊**）／一側純量（**不**拆，兩頂層鍵各自
 *    一列）／兩側皆 `null`（**不**拆）／頂層無 `before`／`after`（不觸發，見
 *    `APPLICATION_UPDATED_ON_BEHALF` 形）。
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
 * AC-06(d) 之期望 `field` 集合——**在測試側依 Spec 公式獨立算出**，不呼叫受測
 * 模組之任何內部判別（否則「實作與期望同步走偏」之 mutant 會恆綠）：
 *
 * `( summary 頂層鍵集合 − { 觸發 (b-0) 之 before／after 兩鍵 } ) ∪ ( 該兩物件之子鍵聯集 )`
 *
 * 未觸發 (b-0) 時退化為「頂層鍵集合」，與 MG-1 修訂前語意相容。
 */
function expectedFieldSet(summary: Record<string, unknown>): Set<string> {
  const topKeys = Object.keys(summary);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  const hasBothKeys = Object.hasOwn(summary, "before") && Object.hasOwn(summary, "after");
  const before = summary.before;
  const after = summary.after;
  const sideOk = (v: unknown) => isRecord(v) || v === null;
  const triggersNested =
    hasBothKeys && sideOk(before) && sideOk(after) && (isRecord(before) || isRecord(after));

  if (!triggersNested) return new Set(topKeys);

  return new Set([
    ...topKeys.filter((k) => k !== "before" && k !== "after"),
    ...(isRecord(before) ? Object.keys(before) : []),
    ...(isRecord(after) ? Object.keys(after) : []),
  ]);
}

/**
 * AC-06(d) 鍵守恆之封閉斷言（集合相等，非僅 `⊆`）：
 *   · 期望集合之每一鍵皆在輸出（刪頂層鍵／刪子鍵／聯集取成交集之 mutant 必紅）
 *   · 輸出 `field` 集合恰等於期望集合，且無重複（捏造鍵／重複鍵 mutant 必紅）
 */
function expectKeyConservation(summary: Record<string, unknown>): AuditChangeDto[] {
  const changes = flattenAuditSummary(summary);
  const expectedFields = expectedFieldSet(summary);
  const outputFields = changes.map((c) => c.field);

  for (const key of expectedFields) {
    expect(outputFields, `AC-06(d)：期望 field ${key} 於 changes 遺失`).toContain(key);
  }
  expect(new Set(outputFields)).toEqual(expectedFields);
  expect(outputFields.length).toBe(expectedFields.size);

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

/**
 * ④' 同形之 `before: null` 變體（首版建立時 `beforeRow` 為 null，實查同站點）
 * ——B-27／AC-06(b-0) 之「一側為 `null`」半邊（既有語意擴張，§0.2 獨立列出）。
 */
const FUEL_CONSUMPTION_NESTED_FIRST_VERSION = {
  before: null,
  after: { fuelType: "GASOLINE_95", kmPerLiter: "12.3400", effectiveFrom: "2026-01-01" },
  basisNote: "首版（合成資料）",
} satisfies Record<string, unknown>;

/**
 * ④" 巢狀兩側**子鍵不對稱**（B-28）：`before` 有 `fuelType`／`kmPerLiter`，
 * `after` 有 `fuelType`／`effectiveFrom` → 以**聯集**拆列（3 列），缺側為 `null`。
 * （非既有寫入站點之形狀，為 AC-06(d) 「聯集不得取成交集」之守門用合成輸入。）
 */
const FUEL_CONSUMPTION_NESTED_ASYMMETRIC = {
  before: { fuelType: "GASOLINE_92", kmPerLiter: "10.0000" },
  after: { fuelType: "GASOLINE_95", effectiveFrom: "2026-08-01" },
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
  describe("AC-06(b-3) summary 為 null／{} → changes: []（B-11：不拋錯）", () => {
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

  describe("AC-06(b-2) 純量值 → before: null ＋ after: 值之字串化", () => {
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

  describe("AC-06(b-1) 值為物件且恰含 before／after（或 from／to）兩鍵 → 拆為該兩欄", () => {
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

    it("{from, to} 兩鍵物件 → 拆為改前／改後兩欄（AC-06(b-1)：與 {before,after} 同等待遇；B-26）", () => {
      const changes = flattenAuditSummary({ isActive: { from: true, to: false } });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.field).toBe("isActive");
      expect(changes[0]?.before).toBe("true");
      expect(changes[0]?.after).toBe("false");
      expect(changes[0]?.after).not.toContain("[object Object]");
      // B-26 之 mutant 守門：輸出 `'{"from":true,"to":false}'` 者必紅。
      expect(changes[0]?.after).not.toContain("from");
      expect(changes[0]?.after).not.toContain("to");
    });

    it("{to, from} 鍵序顛倒亦視為同一形（拆欄，不因鍵序而異）", () => {
      expect(flattenAuditSummary({ isActive: { to: false, from: true } })).toEqual([
        { field: "isActive", before: "true", after: "false" },
      ]);
    });

    it("{from, to} 之一端為 null → 該端為 null（不得字串化為 'null'）", () => {
      expect(flattenAuditSummary({ isActive: { from: null, to: true } })).toEqual([
        { field: "isActive", before: null, after: "true" },
      ]);
    });

    it("三鍵 {from, to, extra} → 不拆欄（恰兩鍵之條件），整體字串化且非 [object Object]", () => {
      const changes = flattenAuditSummary({ f: { from: 1, to: 2, extra: 3 } });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.before).toBeNull();
      expect(changes[0]?.after).not.toContain("[object Object]");
      expect(changes[0]?.after).toContain("extra");
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

  describe("AC-06(b-0) summary 級預檢：巢狀前後版本以子鍵聯集逐子鍵拆列", () => {
    it("兩側皆物件 → 子鍵逐一成列，頂層 before／after 不各自成列（B-12）", () => {
      expect(
        flattenAuditSummary({
          before: { fuelType: "GASOLINE_92", kmPerLiter: "10.0000" },
          after: { fuelType: "GASOLINE_95", kmPerLiter: "12.3400" },
        })
      ).toEqual([
        { field: "fuelType", before: "GASOLINE_92", after: "GASOLINE_95" },
        { field: "kmPerLiter", before: "10.0000", after: "12.3400" },
      ]);
    });

    it("子鍵順序＝before 鍵序後接 after 獨有鍵；子鍵列插於 before 之原位置，其餘頂層鍵沿原插入序", () => {
      const changes = flattenAuditSummary({
        head: "H",
        before: { b1: 1, shared: "s0" },
        after: { shared: "s1", a1: 2 },
        tail: "T",
      });
      expect(changes.map((c) => c.field)).toEqual(["head", "b1", "shared", "a1", "tail"]);
      expect(changes).toEqual([
        { field: "head", before: null, after: "H" },
        { field: "b1", before: "1", after: null },
        { field: "shared", before: "s0", after: "s1" },
        { field: "a1", before: null, after: "2" },
        { field: "tail", before: null, after: "T" },
      ]);
    });

    it("after 頂層鍵在前、before 在後時，子鍵列仍插於 before 之原位置", () => {
      const changes = flattenAuditSummary({
        after: { x: 2 },
        basisNote: "n",
        before: { x: 1 },
      });
      expect(changes).toEqual([
        { field: "basisNote", before: null, after: "n" },
        { field: "x", before: "1", after: "2" },
      ]);
    });

    it("一側為 null、另一側為物件 → 仍拆子鍵，缺側為 null（B-27；既有語意擴張半邊）", () => {
      expect(flattenAuditSummary({ before: null, after: { fuelType: "GASOLINE_95" } })).toEqual([
        { field: "fuelType", before: null, after: "GASOLINE_95" },
      ]);
      expect(flattenAuditSummary({ before: { fuelType: "GASOLINE_95" }, after: null })).toEqual([
        { field: "fuelType", before: "GASOLINE_95", after: null },
      ]);
    });

    it("相鄰輸入：一側為純量 → 預檢不成立，兩頂層鍵各自一列（走 (b-2)）", () => {
      expect(flattenAuditSummary({ before: { x: 1 }, after: 5 })).toEqual([
        { field: "before", before: null, after: '{"x":1}' },
        { field: "after", before: null, after: "5" },
      ]);
    });

    it("相鄰輸入：兩側皆 null → 預檢不成立（至少一為物件），兩頂層鍵各自一列", () => {
      expect(flattenAuditSummary({ before: null, after: null })).toEqual([
        { field: "before", before: null, after: null },
        { field: "after", before: null, after: null },
      ]);
    });

    it("相鄰輸入：只有 before 一個頂層鍵 → 預檢不成立（須兩鍵同時在場）", () => {
      expect(flattenAuditSummary({ before: { x: 1 } })).toEqual([
        { field: "before", before: null, after: '{"x":1}' },
      ]);
    });

    it("相鄰輸入：頂層不含 before／after 鍵 → 不觸發預檢（APPLICATION_UPDATED_ON_BEHALF 形）", () => {
      expect(
        flattenAuditSummary({ tripDate: { before: "2026-08-01", after: "2026-08-02" } })
      ).toEqual([{ field: "tripDate", before: "2026-08-01", after: "2026-08-02" }]);
    });

    it("子鍵值為巢狀物件 → 該欄以 JSON 字串化，仍零 [object Object]", () => {
      const changes = flattenAuditSummary({
        before: { seg: { a: 1 } },
        after: { seg: { a: 2 } },
      });
      expect(changes).toEqual([{ field: "seg", before: '{"a":1}', after: '{"a":2}' }]);
      expectNoObjectObject(changes);
    });
  });

  describe("AC-06(a) 每列鍵集封閉：恰 field／before／after 三鍵", () => {
    it.each(ALL_REAL_FIXTURES)("%s", (_label, summary) => {
      expectChangeDtoShape(flattenAuditSummary(summary));
    });
  });

  describe("AC-06(d) 鍵守恆：輸出 field 集合恰等於（頂層鍵 − 觸發 (b-0) 之 before／after）∪ 子鍵聯集（刪頂層鍵／刪子鍵 mutant 皆必紅）", () => {
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

  it("④ USER_FUEL_CONSUMPTION_VERSION_CREATED（巢狀混合形）：恰 4 列＝三子鍵 ＋ basisNote（B-12／AC-06(b-0)）", () => {
    const changes = expectKeyConservation(FUEL_CONSUMPTION_NESTED);
    expect(changes.map((c) => c.field)).toEqual([
      "fuelType",
      "kmPerLiter",
      "effectiveFrom",
      "basisNote",
    ]);
    // 頂層 `before`／`after` **不**各自成列（MG-1 裁定之核心）。
    expect(changes.map((c) => c.field)).not.toContain("before");
    expect(changes.map((c) => c.field)).not.toContain("after");
  });

  it("④ 巢狀混合形之逐欄值：每一子鍵之改前→改後兩欄對得上，零 [object Object]（AC-06(f) 最高密度案例）", () => {
    const changes = flattenAuditSummary(FUEL_CONSUMPTION_NESTED);
    expectNoObjectObject(changes);

    const byField = new Map(changes.map((c) => [c.field, c]));

    // 「油種：改前 92 無鉛 → 改後 95 無鉛」之後端面（值中文化屬前端 AC-18(d)）
    expect(byField.get("fuelType")).toEqual({
      field: "fuelType",
      before: "GASOLINE_95",
      after: "GASOLINE_98",
    });
    expect(byField.get("kmPerLiter")).toEqual({
      field: "kmPerLiter",
      before: "12.3400",
      after: "13.5000",
    });
    expect(byField.get("effectiveFrom")).toEqual({
      field: "effectiveFrom",
      before: "2026-01-01",
      after: "2026-08-01",
    });

    const basisNoteRow = byField.get("basisNote");
    expect(basisNoteRow).toEqual({
      field: "basisNote",
      before: null,
      after: "原廠油耗數據（合成資料）",
    });
  });

  it("④' 巢狀混合形之 before: null 變體（首版）：同 4 列，三子鍵列之 before 皆為 null（B-27）", () => {
    const changes = expectKeyConservation(FUEL_CONSUMPTION_NESTED_FIRST_VERSION);
    expect(changes.map((c) => c.field)).toEqual([
      "fuelType",
      "kmPerLiter",
      "effectiveFrom",
      "basisNote",
    ]);
    expect(changes).toEqual([
      { field: "fuelType", before: null, after: "GASOLINE_95" },
      { field: "kmPerLiter", before: null, after: "12.3400" },
      { field: "effectiveFrom", before: null, after: "2026-01-01" },
      { field: "basisNote", before: null, after: "首版（合成資料）" },
    ]);
    // **不得**退化為「`after` 整包 JSON 一列」（B-27 之 mutant 守門）
    expect(changes.map((c) => c.field)).not.toContain("after");
    expectNoObjectObject(changes);
  });

  it('④" 巢狀兩側子鍵不對稱：以聯集拆列（3 列），缺側之欄為 null（B-28；取成交集之 mutant 必紅）', () => {
    const changes = expectKeyConservation(FUEL_CONSUMPTION_NESTED_ASYMMETRIC);
    expect(changes).toEqual([
      { field: "fuelType", before: "GASOLINE_92", after: "GASOLINE_95" },
      { field: "kmPerLiter", before: "10.0000", after: null },
      { field: "effectiveFrom", before: null, after: "2026-08-01" },
    ]);
    expect(changes).toHaveLength(3);
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

  it("⑥ USER_DEACTIVATED（{from,to} 兩鍵物件）：拆為一列兩欄，零 [object Object]（B-26）", () => {
    const changes = expectKeyConservation(USER_DEACTIVATED);
    expectNoObjectObject(changes);
    expect(changes).toEqual([{ field: "isActive", before: "true", after: "false" }]);
    // 修訂前之 `{before:null, after:'{"from":true,"to":false}'}` 於此必紅。
    expect(changes[0]?.after).not.toContain("from");
    expect(changes[0]?.before).toBe("true");
    expect(changes[0]?.after).toBe("false");
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
