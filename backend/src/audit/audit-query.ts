/**
 * PHASE-010-T1 — 稽核查詢之 query string 解析純函式（`parseAuditLogQuery`）
 *
 * Spec `docs/specs/PHASE-010.md` §2.A AC-02、§5 B-01~B-09、§7.3 請求形狀、
 * §16 D2 裁定（(b)：`action` ＋ `actorId`／`targetId` ＋ `dateFrom`／`dateTo`
 * 四個篩選維度 ＋ `page`／`pageSize` 分頁兩參數；**不含** `keyword`）。
 *
 * ---------------------------------------------------------------------------
 * 職責邊界
 * ---------------------------------------------------------------------------
 * 本模組**只**做 query string 的格式驗證與正規化，AC-02(f)：不碰 DB、不引用任何
 * Prisma 型別、不讀時鐘。`where` 建構、排序、`skip`／`take`、投影、授權一律屬
 * T2（`audit/routes.ts`）。授權判定（`401`／`403`）在呼叫端**早於**本函式執行
 * （§6.1 判定紀律 1；B-20 側信道守門在 T2）。
 *
 * **AC-02(f) 之操作型定義**（即 `test/unit/audit-log-query.test.ts` 之結構斷言
 * 實際掃描的對象）：**本模組自身原始碼**零 `@prisma/client` 匯入、零
 * `PrismaClient`／`Prisma.` 引用、零 DB 呼叫、零時鐘。**傳遞相依不在射程**——
 * 本檔匯入的 `parseUtcDate` 其模組鏈上本就有 `@prisma/client` 的 value import
 * （`parameter-service.ts` → `depreciation-engine.ts`），故執行期載入 Prisma
 * 這件事本模組並未、也無意避免；沿 `mileage/mileage-range.ts`（PHASE-005-T1）
 * 之既有先例，該檔同樣自稱純函式、同樣沿用 `parseUtcDate`，且其自身還有
 * `import type { Prisma }`。複用 `parseUtcDate` 而不重寫日期解析亦是既有紀律
 * （`applications/routes.ts` 對此有明文）。
 *
 * ---------------------------------------------------------------------------
 * AC-02(c)「逐字沿 PHASE-004 `application-query.ts` 之既有語意」
 * ---------------------------------------------------------------------------
 * `page`／`pageSize` 之分支與常數逐字沿用 `applications/application-query.ts`
 * （實查該檔：`export const PAGE_SIZE_DEFAULT = 20;`／
 * `export const PAGE_SIZE_MAX = 100;`，以及其 `parseApplicationListQuery` 內
 * `page`／`pageSize` 兩段：正整數正則 → `< 1`／`<= 0` 拒絕 → 超過上限 clamp）。
 *
 * **為何是複製常數而非 import**（理由僅此一條，與 AC-02(f) 無關）：避免
 * `audit/` 對 `applications/` 這個**另一個 feature 模組**產生跨特性耦合——稽核
 * 檢視與申請查詢是兩個獨立子域，讓前者在編譯期綁住後者的模組圖，只為兩個數字，
 * 代價不成比例。
 *
 * **這裡刻意不主張的理由**：「import 會拉進 Prisma 相依而違反 AC-02(f)」**不成立**，
 * 不得作為本決定之依據——①`application-query.ts` 對 `@prisma/client` 是
 * `import type`（執行期抹除）；②本檔的 `parseUtcDate` 匯入鏈上本就有
 * `@prisma/client` 的 value import（見上「職責邊界」節）；③AC-02(f) 的操作型
 * 定義只掃描本模組自身原始碼，`import { PAGE_SIZE_DEFAULT } from
 * "../applications/application-query.js"` 同樣會通過該掃描。
 *
 * **複製之漂移風險如何守住**：以**測試層的雙向機械等值對照**——單元測試對同一組
 * 輸入同時呼叫兩個 parser，斷言 `page`／`pageSize` 之值與該欄位錯誤逐字全等；
 * 任一側日後改動語意即紅（即審之雙向 mutant 已實證兩個方向皆紅），複製不會
 * 靜默漂移。
 *
 * ---------------------------------------------------------------------------
 * 日期區間（AC-02(e)：起訖日均含當日，且「日」＝台灣（UTC+8）日曆日）
 * ---------------------------------------------------------------------------
 * `AuditLog.createdAt` 是**時刻**（`DateTime`）而非日期，因此「`dateTo` 含當日」
 * 不能以「`lte` 當日 00:00」表達（否則該日 00:00:00.001 以後的稽核列全數漏
 * 掉——B-07 之失效模式）。本函式因而輸出**半開區間**。
 *
 * **【2026-08-09 Mock Gate MG-2 人類裁定「以台灣日曆日為準」／`SPEC-REV-010-GATE`】**
 * 區間之「日」逐字為**台灣（UTC+8）日曆日**（裁定原文：「篩 8/7~8/8 就是台灣時間
 * 的 8/7 00:00~8/8 23:59，與畫面顯示一致；後端日界平移八小時」）：
 *   · `createdAtFrom`        ＝ `dateFrom` 之台北時 `00:00:00.000`（含）
 *                            ＝ **前一日 `16:00:00.000Z`**
 *                              （例：`dateFrom=2026-08-07` → `2026-08-06T16:00:00.000Z`）
 *   · `createdAtToExclusive` ＝ `dateTo` **次日**之台北時 `00:00:00.000`（不含）
 *                            ＝ **`dateTo` 當日 `16:00:00.000Z`**
 *                              （例：`dateTo=2026-08-08` → `2026-08-08T16:00:00.000Z`）
 * 偏移量為**固定 ＋8 小時**（台灣自 1979 年起無日光節約時間），故**不需時區資料庫、
 * 零新增 npm 依賴**（N-6）。欄位名與半開區間之用法**零變更**：呼叫端仍為
 * `gte: createdAtFrom` ＋ `lt: createdAtToExclusive`（`buildAuditLogWhere` 零程式
 * 變更，僅兩個 `Date` 之值改變），讓「誤用 `lte`」在命名層就顯而易見。任一端未
 * 提供即為 `null`（該端不設界）。
 *
 * 與 **AC-18(c)（前端沿瀏覽器時區顯示）之關係**：台灣時區之瀏覽器，篩選日與畫面
 * 顯示日恆一致（裁定之直接目的）；非台灣時區之瀏覽器，顯示為當地時間而篩選仍以
 * 台灣日為準——此不一致為**裁定當日明示接受之已知限制**（Spec §17.1 #11），
 * **非缺陷，不得改為瀏覽器時區日界**。
 *
 * ---------------------------------------------------------------------------
 * 錯誤語意
 * ---------------------------------------------------------------------------
 * · 回傳**全部**欄位錯誤（非第一項即中止），沿既有 `VALIDATION_ERROR` 慣例；
 *   呼叫端於 `errors.length > 0` 時拋 `400 VALIDATION_ERROR` ＋ `fields[]`，
 *   且**零查詢**（AC-02(b)）。
 * · 只要有任一錯誤，四個篩選欄位與兩個時間界一律回 `null`（沿
 *   `mileage-range.ts` 之既有紀律：上游不得誤用半驗證值）。`page`／`pageSize`
 *   維持其解析結果，以與 PHASE-004 之既有行為逐字一致。
 * · `actorId`／`targetId` **不做存在性或 cuid 格式驗證**（B-09）：不存在之 id
 *   應自然得到空集合而非 `400`／`404`，否則會以錯誤碼洩漏使用者存在性。
 * · 重複 query key 在 Fastify 執行期是 `string[]`（沿 PHASE-005 T6-AR-1／
 *   `application-query.ts` B-35 之既有教訓）：本函式對**每個**參數統一以
 *   `readScalarParam` 擋下非字串值，避免陣列一路穿透進 Prisma `where` 而在 DB
 *   層爆成 500。
 */

import { parseUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** AC-02(b)：`page` 預設 1。 */
export const PAGE_DEFAULT = 1;

/** AC-02(c)：逐字沿 PHASE-004 `application-query.ts`（`PAGE_SIZE_DEFAULT = 20`）。 */
export const PAGE_SIZE_DEFAULT = 20;

/** AC-02(c)：逐字沿 PHASE-004 `application-query.ts`（`PAGE_SIZE_MAX = 100`，超過即 clamp）。 */
export const PAGE_SIZE_MAX = 100;

/**
 * AC-02(d)：`action` 之合法值集合，逐字對應 `prisma/schema.prisma` 之
 * `enum AuditAction`（實查 10 值）。
 *
 * 刻意不從 `@prisma/client` 匯入（AC-02(f) 零 Prisma 型別相依）；漂移由
 * `test/unit/audit-log-query.test.ts` 之「本清單與 `@prisma/client` 之
 * `AuditAction` 值集合全等」斷言守住（schema 新增／刪除值而未同步者必紅），
 * 另有 T4／AC-10(b) 之 enum 封閉斷言為第二道。
 */
export const AUDIT_ACTIONS = [
  "USER_CREATED",
  "USER_DEACTIVATED",
  "USER_ACTIVATED",
  "USER_PASSWORD_RESET",
  "USER_DELETED",
  "PARAMETER_VERSION_CREATED",
  "APPLICATION_CREATED_ON_BEHALF",
  "APPLICATION_UPDATED_ON_BEHALF",
  "USER_FUEL_CONSUMPTION_VERSION_CREATED",
  "APPLICATION_VOIDED",
] as const;

export type AuditActionValue = (typeof AUDIT_ACTIONS)[number];

/** 逐字沿 PHASE-004 `application-query.ts` 之 `POSITIVE_INTEGER_PATTERN`。 */
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

function isAuditAction(value: string): value is AuditActionValue {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

/**
 * 原始 query（Fastify 之 `request.query`）。每欄刻意宣告為 `unknown`：執行期
 * 可能是 `string`、`string[]`（重複 key），型別層不得先假設為 `string`。
 */
export interface RawAuditLogQuery {
  action?: unknown;
  actorId?: unknown;
  targetId?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

export interface ParsedAuditLogQuery {
  /** 全部欄位錯誤；非空時呼叫端拋 `400 VALIDATION_ERROR` ＋ `fields[]` 且零查詢。 */
  errors: FieldError[];
  /** `null` ＝ 不依 action 篩選。 */
  action: AuditActionValue | null;
  /** `null` ＝ 不依操作者篩選；不驗證存在性（B-09）。 */
  actorId: string | null;
  /** `null` ＝ 不依對象篩選；不驗證存在性（B-09）。 */
  targetId: string | null;
  /** 半開區間下界（含）：`dateFrom` 台北日 `00:00`＝**前一日 `16:00:00.000Z`**；`null` ＝ 不設下界。 */
  createdAtFrom: Date | null;
  /** 半開區間上界（**不含**）：`dateTo` 台北次日 `00:00`＝**當日 `16:00:00.000Z`**；`null` ＝ 不設上界。 */
  createdAtToExclusive: Date | null;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// 內部助手
// ---------------------------------------------------------------------------

/**
 * 取單一字串值；`undefined` 與 `""` 一律視同未提供（沿既有慣例）。
 * 非字串（如重複 query key 造成的 `string[]`）即記欄位錯誤並回 `null`。
 */
function readScalarParam(value: unknown, field: string, errors: FieldError[]): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    errors.push({ field, reason: "僅接受單一字串值，不得重複帶入此參數" });
    return null;
  }
  return value;
}

/** UTC 日粒度之次日 `00:00:00.000Z`（跨月／跨年／閏日由 `Date.UTC` 自然進位）。 */
function nextUtcDay(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
}

/**
 * AC-02(e)／MG-2：台北時區（UTC+8）相對 UTC 之**固定**偏移量（毫秒）。
 * 台灣自 1979 年起無日光節約時間，故為常數——**不得**引入任何時區資料庫或
 * npm 套件（N-6 零新增依賴）。
 */
const TAIPEI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把「UTC 日曆日 `day` 之 `00:00:00.000Z`」平移為「**台北**日曆日之
 * `00:00:00.000`（台北時）」所對應之 UTC 時刻，即 `day 00:00Z − 8h`。
 * 例：`2026-08-07T00:00:00.000Z` → `2026-08-06T16:00:00.000Z`。
 */
function taipeiDayStartUtc(utcDayStart: Date): Date {
  return new Date(utcDayStart.getTime() - TAIPEI_UTC_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// parseAuditLogQuery
// ---------------------------------------------------------------------------

/**
 * AC-02：解析並驗證 `GET /admin/audit-logs` 之 query string（純函式）。
 * 邊界逐格見 Spec §5 B-01~B-09 與 `test/unit/audit-log-query.test.ts`。
 */
export function parseAuditLogQuery(raw: RawAuditLogQuery): ParsedAuditLogQuery {
  const errors: FieldError[] = [];

  // ── action（AC-02(d)／B-05／B-06）─────────────────────────────────────
  let action: AuditActionValue | null = null;
  const rawAction = readScalarParam(raw.action, "action", errors);
  if (rawAction !== null) {
    if (!isAuditAction(rawAction)) {
      // 不得靜默忽略而回全集——一律以欄位錯誤拒絕。
      errors.push({ field: "action", reason: "操作類型不合法" });
    } else {
      action = rawAction;
    }
  }

  // ── actorId／targetId（B-09：不驗證存在性，不洩漏使用者存在性）─────────
  const actorId = readScalarParam(raw.actorId, "actorId", errors);
  const targetId = readScalarParam(raw.targetId, "targetId", errors);

  // ── dateFrom／dateTo（AC-02(e)／B-07／B-08）───────────────────────────
  let dateFrom: Date | null = null;
  const rawDateFrom = readScalarParam(raw.dateFrom, "dateFrom", errors);
  if (rawDateFrom !== null) {
    const parsed = parseUtcDate(rawDateFrom);
    if (!parsed) {
      errors.push({ field: "dateFrom", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      dateFrom = parsed;
    }
  }

  let dateTo: Date | null = null;
  const rawDateTo = readScalarParam(raw.dateTo, "dateTo", errors);
  if (rawDateTo !== null) {
    const parsed = parseUtcDate(rawDateTo);
    if (!parsed) {
      errors.push({ field: "dateTo", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      dateTo = parsed;
    }
  }

  // 僅當兩端皆成功解析才比較起訖（單端格式錯誤時不再疊加誤導性的 dateRange 錯誤）。
  // `dateFrom === dateTo` 為合法（B-07 單日查詢），故用嚴格 `>`。
  if (dateFrom !== null && dateTo !== null && dateFrom.getTime() > dateTo.getTime()) {
    errors.push({ field: "dateRange", reason: "起日（dateFrom）不可晚於迄日（dateTo）" });
  }

  // ── page（AC-02(b)／B-01；逐字沿 PHASE-004）───────────────────────────
  let page = PAGE_DEFAULT;
  const rawPage = readScalarParam(raw.page, "page", errors);
  if (rawPage !== null) {
    if (!POSITIVE_INTEGER_PATTERN.test(rawPage)) {
      errors.push({ field: "page", reason: "頁次必須為正整數" });
    } else {
      const parsedPage = Number.parseInt(rawPage, 10);
      if (parsedPage < 1) {
        errors.push({ field: "page", reason: "頁次必須大於等於 1" });
      } else {
        page = parsedPage;
      }
    }
  }

  // ── pageSize（AC-02(c)／B-02／B-03；逐字沿 PHASE-004：<=0 → 400、超上限 → clamp）─
  let pageSize = PAGE_SIZE_DEFAULT;
  const rawPageSize = readScalarParam(raw.pageSize, "pageSize", errors);
  if (rawPageSize !== null) {
    if (!POSITIVE_INTEGER_PATTERN.test(rawPageSize)) {
      errors.push({ field: "pageSize", reason: "每頁筆數必須為正整數" });
    } else {
      const parsedPageSize = Number.parseInt(rawPageSize, 10);
      if (parsedPageSize <= 0) {
        errors.push({ field: "pageSize", reason: "每頁筆數必須大於 0" });
      } else {
        pageSize = Math.min(parsedPageSize, PAGE_SIZE_MAX);
      }
    }
  }

  // 任一錯誤 → 篩選欄位一律回 null（AC-02(b) 零查詢；上游不得誤用半驗證值）。
  if (errors.length > 0) {
    return {
      errors,
      action: null,
      actorId: null,
      targetId: null,
      createdAtFrom: null,
      createdAtToExclusive: null,
      page,
      pageSize,
    };
  }

  return {
    errors,
    action,
    actorId,
    targetId,
    // AC-02(e)／MG-2：兩端皆平移 −8h，使日界落在台北日曆日而非 UTC 日。
    createdAtFrom: dateFrom === null ? null : taipeiDayStartUtc(dateFrom),
    createdAtToExclusive: dateTo === null ? null : taipeiDayStartUtc(nextUtcDay(dateTo)),
    page,
    pageSize,
  };
}
