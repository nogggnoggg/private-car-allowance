/**
 * PHASE-010-T1 — `AuditLog.summary`（`Json?`）→ `changes[]` 之扁平化純函式
 *
 * Spec `docs/specs/PHASE-010.md` §2.B AC-06、§5 B-11／B-12、§7.2 `AuditChangeDto`、
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
 *   1. **鍵守恆**（AC-06(d)）：輸入 `summary` 的每一個頂層鍵，恰產生一列
 *      `changes`，鍵名逐字沿用。本模組**不做任何過濾**——值為 `null`／`""`／
 *      `false`／`0` 的鍵一律保留（稽核面上「欄位被清空」本身就是要看的事實，
 *      falsy 過濾等同竄改稽核內容）。
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
 * 形狀分派（AC-06(b)）——三分支，逐字對應 Spec
 * ---------------------------------------------------------------------------
 * 對 `summary` 的**每個頂層鍵**之值 `v`：
 *
 *   (i)  `v` 為物件且**恰含 `before`／`after` 兩鍵** → 拆為該兩欄：
 *        `{ field, before: str(v.before), after: str(v.after) }`。
 *        「恰兩鍵」是字面條件：`{before, after, extra}`（三鍵）與 `{before}`
 *        （一鍵）皆**不**走此分支，改走 (ii)——否則會憑空捏造或吞掉資訊。
 *        鍵序不影響判定（`{after, before}` 同樣成立）。
 *   (ii) 其餘一切值（純量、陣列、任意其他物件形狀）→
 *        `{ field, before: null, after: str(v) }`。
 *        Spec (b) 只逐字列出「純量」一種，但實查之真實寫入站點另有兩類非
 *        `{before,after}` 的物件值必須落在此分支且**不得**變成
 *        `"[object Object]"`：
 *          · `USER_FUEL_CONSUMPTION_VERSION_CREATED` 之
 *            `{ before: {...}, after: {...}, basisNote }`——頂層 `before`／
 *            `after` 各自為**物件**（實查 `users/fuel-consumption-routes.ts`
 *            之 summary 區塊）；
 *          · `USER_DEACTIVATED`／`USER_ACTIVATED` 之
 *            `{ isActive: { from, to } }`——兩鍵物件但鍵名為 `from`／`to`
 *            （實查 `admin/routes.ts` 之 `writeAudit` 呼叫端）。
 *        兩者皆由 (ii) 之 `JSON.stringify` 承接，鍵守恆與可讀性同時成立。
 *   (iii) `summary` 本身為 `null`／`undefined`／非物件 → `[]`（B-11）。
 *        `{}` 亦自然得 `[]`（零頂層鍵）。
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
 * 輸出順序：沿 `Object.entries` 之插入序，即 `summary` JSON 的頂層鍵順序。
 */

/** §7.2 `AuditChangeDto`：扁平化後之單列（欄位／改前／改後）。 */
export interface AuditChangeDto {
  /** `summary` 之頂層鍵（英文鍵名；中文標籤對照屬前端 T6）。 */
  field: string;
  /** 純量與非 `{before,after}` 形時恆 `null`。 */
  before: string | null;
  after: string | null;
}

/** 物件且非陣列、非 null（`typeof null === "object"` 故須顯式排除）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** AC-06(b)(i)：**恰含** `before`／`after` 兩鍵之物件（鍵序不拘）。 */
function isBeforeAfterPair(value: unknown): value is { before: unknown; after: unknown } {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, "before") && Object.hasOwn(value, "after");
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
  // (iii) null／undefined／非物件 → 無頂層鍵可攤平（B-11：不拋錯）
  if (summary === null || typeof summary !== "object") {
    return [];
  }

  const changes: AuditChangeDto[] = [];
  for (const [field, value] of Object.entries(summary)) {
    if (isBeforeAfterPair(value)) {
      // (i) 恰兩鍵 {before, after} → 拆為兩欄
      changes.push({
        field,
        before: stringifyValue(value.before),
        after: stringifyValue(value.after),
      });
    } else {
      // (ii) 其餘一切 → before 恆 null，after 為值之字串化
      changes.push({ field, before: null, after: stringifyValue(value) });
    }
  }
  return changes;
}
