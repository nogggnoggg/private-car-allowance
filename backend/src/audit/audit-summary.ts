/**
 * PHASE-010-T1 — `AuditLog.summary`（`Json?`）→ `changes[]` 之扁平化純函式
 * （**PHASE-010-T-MG1-BE1** 依 2026-08-09 Mock Gate MG-1 裁定修訂形狀分派為
 * 四層 (b-0)~(b-3)：巢狀前後版本逐子欄拆列 ＋ `{from,to}` 拆兩欄）
 *
 * Spec `docs/specs/PHASE-010.md` §2.B AC-06、§5 B-11／B-12／B-26／B-27／B-28、
 * §7.2 `AuditChangeDto`、
 * §16 D3 裁定（(c)：後端以**單一通用扁平化函式**產生 `changes: [{field, before,
 * after}]`，不輸出原始 `summary`；中文欄名對照屬前端 T6，本模組一律輸出英文
 * 頂層鍵名）。
 *
 * ---------------------------------------------------------------------------
 * 為什麼是「單一通用函式」而非「依 action 逐值投影」
 * ---------------------------------------------------------------------------
 * D3 之三選項比較已載於 Spec：逐值投影（10 份）之失效模式是「新增 action 時漏
 * 投影 → 靜默輸出空白」；通用扁平化對未知 `action` 天然可用，代價則是「扁平化
 * 若有 bug，管理員看到的與 DB 存的不同」。後者之緩解手段即本模組的三條硬性
 * 不變式：
 *
 *   1. **鍵守恆**（AC-06(d)，MG-1 修訂後之封閉基準）：輸出之 `field` 集合**恰
 *      等於** `( summary 頂層鍵集合 − { 觸發 (b-0) 之 before／after 兩鍵 } ) ∪
 *      ( 該兩物件之子鍵聯集 )`，鍵名逐字沿用。未觸發 (b-0) 時退化為「每一個頂層
 *      鍵恰產生一列」，與修訂前語意相容。本模組**不做任何過濾**——值為 `null`／
 *      `""`／`false`／`0` 的鍵一律保留（稽核面上「欄位被清空」本身就是要看的
 *      事實，falsy 過濾等同竄改稽核內容）；子鍵聯集亦**不得**取成交集或只取
 *      單側（三類漏鍵實作由單元測試之刪子鍵 mutant 守門）。
 *   2. **零 `"[object Object]"`**（AC-06(f)）：任何非純量值一律以
 *      `JSON.stringify` 字串化，**絕不**經 `String(value)`／樣板字串／字串
 *      串接等會觸發 `Object.prototype.toString` 的路徑。這是 PHASE-007 T11
 *      即審 FW 明示過的坑（`summary.applicationYear` 同鍵異型），也是本 Phase
 *      AC-06(f) 的守門對象。
 *   3. **純函式**（AC-06(e)）：本檔**零 import**、零 DB、零時鐘、零 I/O、零副
 *      作用（不改寫輸入）；同輸入恆同輸出。零 import 這件事本身由
 *      `test/unit/audit-summary-flatten.test.ts` 之結構斷言守住。
 *
 * ---------------------------------------------------------------------------
 * 形狀分派（AC-06(b)）——四層，逐字對應 Spec（2026-08-09 Mock Gate MG-1 裁定
 * 「智能攤平」之修訂版，`SPEC-REV-010-GATE`）
 * ---------------------------------------------------------------------------
 * 自上而下：先 `summary` **級**預檢 (b-0)，再逐頂層鍵分派 (b-1)/(b-2)。
 *
 *   (b-0) **巢狀前後版本之逐子欄拆列**：`summary` 為物件且**同時含 `before` 與
 *        `after` 兩個頂層鍵**，且兩者之值**至少一為物件**、另一為物件或 `null`
 *        → 該兩個頂層鍵**不各自成列**，改以兩物件之**子鍵聯集**逐子鍵拆列：
 *        每一子鍵恰一列 `{ field: <子鍵>, before: <before[子鍵] 之字串化；該側
 *        為 `null` 或無此子鍵時為 `null`>, after: <同上> }`。
 *        子鍵順序＝`before` 物件之鍵序，再接 `after` 中未出現於 `before` 者
 *        （`before` 為 `null` 時即 `after` 之鍵序）；子鍵列插入於 `before` 頂層
 *        鍵之**原位置**。其餘頂層鍵（如 `basisNote`）照 (b-1)/(b-2) 各自一列，
 *        位置沿其原插入序。
 *        唯一真實觸發者＝`USER_FUEL_CONSUMPTION_VERSION_CREATED` 之
 *        `{ before: {...} | null, after: {...}, basisNote }`（實查
 *        `users/fuel-consumption-routes.ts` 之 summary 區塊）。**一側為 `null`**
 *        （油耗**首版**）之涵蓋為 Spec 明載之既有語意擴張（AC-06(b-0) 來源標記）。
 *        「至少一為物件」是字面條件：兩側皆 `null`、或一側為純量／陣列者皆**不**
 *        觸發，退回逐頂層鍵之 (b-1)/(b-2)——否則會憑空捏造子鍵或吞掉純量值。
 *   (b-1) `v` 為物件且**恰含 `before`／`after` 兩鍵** → 拆為該兩欄：
 *        `{ field, before: str(v.before), after: str(v.after) }`；
 *        `v` 為物件且**恰含 `from`／`to` 兩鍵** → 拆為
 *        `{ field, before: str(v.from), after: str(v.to) }`（**與
 *        `{before,after}` 同等待遇**；MG-1 裁定逐字：「`{from,to}` 拆進改前／改後
 *        兩欄」。實查唯一來源＝`USER_DEACTIVATED`／`USER_ACTIVATED` 之
 *        `{ isActive: { from, to } }`，`admin/routes.ts` 之 `writeAudit` 呼叫端）。
 *        「恰兩鍵」是字面條件：`{before, after, extra}`（三鍵）與 `{before}`
 *        （一鍵）皆**不**走此分支，改走 (b-2)——否則會憑空捏造或吞掉資訊。
 *        鍵序不影響判定（`{after, before}`／`{to, from}` 同樣成立）。
 *   (b-2) 其餘一切值（純量、陣列、任意其他物件形狀）→
 *        `{ field, before: null, after: str(v) }`；非純量由 `JSON.stringify`
 *        承接，鍵守恆與可讀性同時成立。
 *   (b-3) `summary` 本身為 `null`／`undefined`／非物件 → `[]`（B-11）。
 *        `{}` 亦自然得 `[]`（零頂層鍵）。
 *
 * **揭露面**（AC-06(b) 註記）：(b-0)(b-1) 之拆欄**不擴大揭露面**——輸出內容仍恰
 * 為同一 `summary` 之既有值，僅呈現形式改變（原以 `JSON.stringify` 整包呈現者
 * 改為逐子欄呈現）；本模組**不新增任何來源之資料**。
 *
 * 值之字串化 `str(v)`（回傳 `string | null`，對齊 §7.2 之 `AuditChangeDto`）：
 *   · `null`／`undefined` → `null`（**不**字串化為 `"null"`——`AuditChangeDto`
 *     的兩欄本就允許 `null`，而 `{before,after}` 分支中「該端為 null」與
 *     「該端為字串 'null'」在稽核判讀上是不同的事實）。
 *   · `string` → 原值（不 trim、不截斷、不跳脫——跳脫是前端呈現層的責任，
 *     AC-18(a)）。
 *   · `number`／`boolean`／`bigint` → `String(v)`（此三型不可能產生
 *     `"[object Object]"`）。
 *   · 其餘（物件、陣列、…）→ `JSON.stringify(v)`；`JSON.stringify` 對
 *     `undefined`／函式等回 `undefined`，此時回 `null` 兜底。
 *
 * 輸出順序：沿 `Object.entries` 之插入序，即 `summary` JSON 的頂層鍵順序；觸發
 * (b-0) 時，`before`／`after` 兩頂層鍵之位置由子鍵列取代（插於 `before` 之原
 * 位置，子鍵序見 (b-0)）。
 */

/** §7.2 `AuditChangeDto`：扁平化後之單列（欄位／改前／改後）。 */
export interface AuditChangeDto {
  /**
   * `summary` 之頂層鍵，或觸發 (b-0) 時之**子鍵**（英文鍵名；中文標籤對照屬
   * 前端 T6）。
   */
  field: string;
  /** 走 (b-2)（純量與其餘形狀）時恆 `null`；(b-0)(b-1) 則為改前側之值。 */
  before: string | null;
  after: string | null;
}

/** 物件且非陣列、非 null（`typeof null === "object"` 故須顯式排除）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AC-06(b-1)：**恰含** `k1`／`k2` 兩鍵之物件（鍵序不拘）。
 * `{before,after}` 與 `{from,to}` 共用本判別（MG-1 之「同等待遇」）。
 */
function isExactTwoKeyPair(
  value: unknown,
  k1: string,
  k2: string
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, k1) && Object.hasOwn(value, k2);
}

/**
 * AC-06(b-0) 之 `summary` 級預檢：同時含 `before`／`after` 兩個頂層鍵，且兩者之
 * 值**至少一為物件**、另一為物件或 `null`。
 */
function isNestedVersionPair(summary: Record<string, unknown>): boolean {
  if (!Object.hasOwn(summary, "before") || !Object.hasOwn(summary, "after")) return false;
  const before = summary.before;
  const after = summary.after;
  const sideOk = (v: unknown) => isPlainRecord(v) || v === null;
  return sideOk(before) && sideOk(after) && (isPlainRecord(before) || isPlainRecord(after));
}

/**
 * AC-06(b-0) 之子鍵聯集拆列：子鍵序＝`before` 鍵序後接 `after` 獨有鍵；缺側之欄
 * 為 `null`（該側為 `null`、或該側無此子鍵）。
 */
function flattenNestedVersionPair(before: unknown, after: unknown): AuditChangeDto[] {
  const beforeRecord = isPlainRecord(before) ? before : {};
  const afterRecord = isPlainRecord(after) ? after : {};
  const subKeys = [
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord).filter((key) => !Object.hasOwn(beforeRecord, key)),
  ];
  return subKeys.map((key) => ({
    field: key,
    before: Object.hasOwn(beforeRecord, key) ? stringifyValue(beforeRecord[key]) : null,
    after: Object.hasOwn(afterRecord, key) ? stringifyValue(afterRecord[key]) : null,
  }));
}

/**
 * AC-06(f)：值之字串化。**唯一**的字串化路徑，任何非純量一律走
 * `JSON.stringify`——本函式外不得再有第二處把 `summary` 的值轉字串。
 */
function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : serialized;
}

/**
 * AC-06：`AuditLog.summary` → `changes[]`。
 *
 * 純函式（AC-06(e)）：零 DB、零時鐘、零 I/O、不改寫輸入；同輸入恆同輸出。
 * 輸入刻意宣告為 `unknown`（而非 Prisma 之 `JsonValue`）——本模組不依賴任何
 * Prisma 型別，呼叫端（T2）直接把 `AuditLog.summary` 傳入即可。
 */
export function flattenAuditSummary(summary: unknown): AuditChangeDto[] {
  // (b-3) null／undefined／非物件 → 無頂層鍵可攤平（B-11：不拋錯）
  if (summary === null || typeof summary !== "object") {
    return [];
  }

  const record = summary as Record<string, unknown>;
  // (b-0) summary 級預檢：巢狀前後版本 → 兩頂層鍵合併為子鍵聯集之逐子鍵列
  const nested = isNestedVersionPair(record);

  const changes: AuditChangeDto[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (nested && field === "before") {
      // 子鍵列插入於 `before` 頂層鍵之原位置
      changes.push(...flattenNestedVersionPair(record.before, record.after));
      continue;
    }
    if (nested && field === "after") {
      // 已於 `before` 之位置一併拆列（AC-06(d)：兩頂層鍵不各自成列）
      continue;
    }
    if (isExactTwoKeyPair(value, "before", "after")) {
      // (b-1) 恰兩鍵 {before, after} → 拆為兩欄
      changes.push({
        field,
        before: stringifyValue(value.before),
        after: stringifyValue(value.after),
      });
    } else if (isExactTwoKeyPair(value, "from", "to")) {
      // (b-1) 恰兩鍵 {from, to} → 同等待遇（from → 改前、to → 改後）
      changes.push({
        field,
        before: stringifyValue(value.from),
        after: stringifyValue(value.to),
      });
    } else {
      // (b-2) 其餘一切 → before 恆 null，after 為值之字串化
      changes.push({ field, before: null, after: stringifyValue(value) });
    }
  }
  return changes;
}
