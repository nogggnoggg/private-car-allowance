/**
 * 綜合紀錄查詢（`GET /applications`）— PHASE-004-T9
 *
 * Spec §8.1 `ApplicationListItemDto`/`ApplicationListResponse`、§8.2
 * `GET /applications`、§9「綜合查詢」、§10.2 NFR-US-14、D9（`primaryDate`）、
 * D10（分頁形狀／上限／關鍵字比對範圍）。AC-60~71、74、84、91。
 *
 * 職責切分（比照既有 travel-service.ts/travel-parameters.ts 的 routes.ts 薄
 * 層 + service 純函式/DB 層分工）：
 *   - `resolveOwnerId`         純函式：AC-74/84 授權判定（一般使用者強制自己、
 *                              自帶他人 → 403；管理員可指定任一 ownerId，未指定
 *                              預設自己，D10）。
 *   - `parseApplicationListQuery` 純函式：所有 query string 欄位的格式驗證與
 *                              正規化（日期含當日邊界、AC-62 起訖倒置、AC-65
 *                              分頁 clamp/400、AC-64 關鍵字空白正規化）——不碰
 *                              DB、不知道「今天」是什麼（`now` 由呼叫端注入，
 *                              利於測試）。
 *   - `buildApplicationWhere` 純函式：正規化後的篩選條件 → Prisma
 *                              `ApplicationWhereInput`（AC-91 走索引的查詢形狀，
 *                              見下方函式文件註解）。
 *   - `queryApplications`     DB 層：`findMany`（`skip`/`take`）+ `count`
 *                              併行，**不**在應用層做任何切片（AC-91 硬性約束）。
 *   - `toApplicationListItemDto` 純函式：DB row → DTO（AC-68 不適用欄位回
 *                              `null`）。
 *
 * AC-91（不得應用層分頁）具體落實：`queryApplications` 唯一的資料存取路徑是
 * `prisma.application.findMany({ where, orderBy, skip, take })` +
 * `prisma.application.count({ where })`——分頁完全交給 Prisma/PostgreSQL，
 * 本模組任何函式都不會把整張表（或整個 where 命中集合）讀進 Node 記憶體後再
 * `.slice()`。
 *
 * 索引使用（C3 硬性約束，複核 `prisma/schema.prisma` `Application` 模型）：
 *   - `where` 恆含 `ownerId`（單一使用者）與 `primaryDate` 區間（AC-60/61 兩者
 *     必有，無論是否使用者顯式提供——未提供時套用 D9(iii) 預設）。
 *   - 未帶 `status` 篩選時：走 `@@index([ownerId, primaryDate])`。
 *   - 帶 `status` 篩選時：走 `@@index([ownerId, status, primaryDate])`（複合
 *     索引前綴涵蓋 `ownerId`/`status` 兩個等值條件 + `primaryDate` 範圍，是
 *     PostgreSQL B-tree 索引可完整利用範圍掃描的形狀）。
 *   - `type`/`keyword` 條件不在任何複合索引內，由 PostgreSQL 在上述索引掃描
 *     命中的列上做進一步過濾（資料量級小，Spec §10.2 已評估）；`orderBy`
 *     `primaryDate DESC` 與 `@@index([ownerId, primaryDate])`/
 *     `@@index([ownerId, status, primaryDate])` 的欄位順序一致，索引本身即
 *     可提供排序，無需額外 sort 節點處理 `primaryDate` 這一階。
 */

import type { ApplicationStatus, ApplicationType, Prisma, PrismaClient } from "@prisma/client";
import { formatUtcDate, parseUtcDate } from "../parameters/parameter-service.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";
import { utcDateOnly } from "./travel-service.js";

// ---------------------------------------------------------------------------
// Constants (D10)
// ---------------------------------------------------------------------------

/** D10：`pageSize` 預設 20、上限 100（超過 clamp，`<=0` → 400）。 */
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/** D9(iii)：預設 `dateFrom = 今日 − 1 年`（含當日）、`dateTo` 不設上界。 */
export const DEFAULT_LOOKBACK_YEARS = 1;

const APPLICATION_TYPES: readonly ApplicationType[] = ["TRAVEL", "MAINTENANCE", "DEPRECIATION"];
const APPLICATION_STATUSES: readonly ApplicationStatus[] = ["DRAFT", "COMPLETED", "VOIDED"];

function isApplicationType(value: string): value is ApplicationType {
  return (APPLICATION_TYPES as readonly string[]).includes(value);
}

function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// escapeLikePattern — B-23：SQL LIKE/ILIKE 萬用字元跳脫（純函式）
// ---------------------------------------------------------------------------

/**
 * B-23（Spec §5、§11.5）：Prisma 的 `contains`/`startsWith`/`endsWith` 於
 * PostgreSQL 上一律編譯為參數化的 `ILIKE`/`LIKE`，值以單一 bound parameter
 * 傳遞——**已無 SQL 注入風險**，但 Prisma 不會跳脫值內容裡的 `%`／`_`：這兩
 * 個字元在 LIKE pattern 語意中本身就是萬用字元（`%` 比對任意長度字元序列、
 * `_` 比對任一單一字元），PostgreSQL 對沒有顯式 `ESCAPE` 子句的 LIKE/ILIKE
 * 仍套用預設跳脫字元 `\`（backslash）。因此只要在送進 `contains` 前，把使用
 * 者輸入裡的 `\`、`%`、`_` 都加上 `\` 前綴，PostgreSQL 收到的 pattern 就會把
 * 這三者當成字面字元比對，而非萬用字元。
 *
 * 刻意不改用 `$queryRaw` 或自訂 `ESCAPE` 子句——維持 Prisma 產生的
 * `column ILIKE $1`／`mode: "insensitive"` 語意與既有索引利用方式完全不變
 * （見檔頭「索引使用」註解），只有 bound parameter 的字串內容不同，查詢計畫
 * 不受影響。
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (metachar) => `\\${metachar}`);
}

// ---------------------------------------------------------------------------
// resolveOwnerId — AC-74/84 授权（純函式）
// ---------------------------------------------------------------------------

/**
 * §6.1 授權矩陣「`GET /applications`」列 + AC-74/84：
 *   - 未提供 `ownerId`，或 `ownerId === actor.id` → 回傳 `actor.id`（一般使用者
 *     與管理員皆同——管理員未指定時「預設自己」，D10）。
 *   - `ownerId` 指向他人：
 *       - `actor.role !== "ADMIN"` → 403 `FORBIDDEN`（AC-74：不得靜默降級為
 *         自己資料，亦不得回他人資料——本函式直接拋錯，呼叫端無法誤用）。
 *       - `actor.role === "ADMIN"` → 回傳該 `ownerId`（AC-84：管理員可指定任一
 *         使用者）。
 *
 * 刻意不查 DB 驗證目標使用者是否存在——Spec AC-84 只要求「只回 U 的紀錄」，
 * 不存在的 `ownerId` 自然查無資料（`items: []`），無需額外一次使用者查詢。
 */
export function resolveOwnerId(
  actor: { id: string; role: string },
  rawOwnerId: string | undefined
): string {
  if (rawOwnerId === undefined || rawOwnerId === "" || rawOwnerId === actor.id) {
    return actor.id;
  }
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", 403, "無權查詢他人之申請紀錄");
  }
  return rawOwnerId;
}

// ---------------------------------------------------------------------------
// parseApplicationListQuery — 格式驗證 + 正規化（純函式）
// ---------------------------------------------------------------------------

export interface RawApplicationListQuery {
  dateFrom?: string;
  dateTo?: string;
  type?: string;
  status?: string;
  keyword?: string;
  page?: string;
  pageSize?: string;
}

export interface ParsedApplicationListQuery {
  errors: FieldError[];
  /** 已套用 D9(iii) 預設值（未提供 → 今日−1年，含當日）；恆有值。 */
  dateFrom: Date;
  /** `null` = 不設上界（D9(iii) 預設，或使用者未提供）。 */
  dateTo: Date | null;
  type: ApplicationType | null;
  status: ApplicationStatus | null;
  /** 已 trim；空字串／純空白視同未提供（AC-64），一律回 `null`。 */
  keyword: string | null;
  page: number;
  pageSize: number;
}

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

/** D9(iii)：`今日 − 1 年`（含當日），以 `now` 的 UTC 日粒度為準。 */
export function defaultDateFrom(now: Date): Date {
  const today = utcDateOnly(now);
  return new Date(
    Date.UTC(
      today.getUTCFullYear() - DEFAULT_LOOKBACK_YEARS,
      today.getUTCMonth(),
      today.getUTCDate()
    )
  );
}

/**
 * 解析並驗證 `GET /applications` 的 query string（不含 `ownerId`——授權判定
 * 由 `resolveOwnerId` 獨立處理，因為它需要 `actor`，本函式刻意保持與授權無關
 * 的純格式/範圍驗證，兩者關注點分離）。
 *
 * 回傳所有欄位錯誤（非只回第一項），呼叫端（routes.ts）於 `errors.length > 0`
 * 時統一拋出 `VALIDATION_ERROR`（比照 PUT /applications/travel/:id 既有慣例）。
 */
export function parseApplicationListQuery(
  raw: RawApplicationListQuery,
  now: Date
): ParsedApplicationListQuery {
  const errors: FieldError[] = [];

  // ── dateFrom / dateTo（AC-61 含當日；AC-62 起訖倒置）──────────────────
  let explicitDateFrom: Date | null = null;
  if (raw.dateFrom !== undefined && raw.dateFrom !== "") {
    const parsed = parseUtcDate(raw.dateFrom);
    if (!parsed) {
      errors.push({ field: "dateFrom", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      explicitDateFrom = parsed;
    }
  }

  let dateTo: Date | null = null;
  if (raw.dateTo !== undefined && raw.dateTo !== "") {
    const parsed = parseUtcDate(raw.dateTo);
    if (!parsed) {
      errors.push({ field: "dateTo", reason: "日期格式錯誤（必須為 YYYY-MM-DD）" });
    } else {
      dateTo = parsed;
    }
  }

  // AC-60: 未提供 dateFrom → 套用 D9(iii) 預設（今日−1年，含當日）。
  const dateFrom = explicitDateFrom ?? defaultDateFrom(now);

  // AC-62: dateFrom > dateTo → 400（僅在 dateTo 有值時比較；dateTo 未提供=
  // 不設上界，不存在「倒置」的可能）。
  if (dateTo !== null && dateFrom.getTime() > dateTo.getTime()) {
    errors.push({ field: "dateRange", reason: "起日（dateFrom）不可晚於迄日（dateTo）" });
  }

  // ── type ─────────────────────────────────────────────────────────────
  let type: ApplicationType | null = null;
  if (raw.type !== undefined && raw.type !== "") {
    if (!isApplicationType(raw.type)) {
      errors.push({ field: "type", reason: "申請類型不合法" });
    } else {
      type = raw.type;
    }
  }

  // ── status ───────────────────────────────────────────────────────────
  let status: ApplicationStatus | null = null;
  if (raw.status !== undefined && raw.status !== "") {
    if (!isApplicationStatus(raw.status)) {
      errors.push({ field: "status", reason: "申請狀態不合法" });
    } else {
      status = raw.status;
    }
  }

  // ── keyword（AC-64：空字串／純空白視同未提供）──────────────────────────
  let keyword: string | null = null;
  if (raw.keyword !== undefined) {
    const trimmed = raw.keyword.trim();
    if (trimmed.length > 0) {
      keyword = trimmed;
    }
  }

  // ── page（AC-65：< 1 或非整數 → 400；預設 1）────────────────────────────
  let page = 1;
  if (raw.page !== undefined && raw.page !== "") {
    if (!POSITIVE_INTEGER_PATTERN.test(raw.page)) {
      errors.push({ field: "page", reason: "頁次必須為正整數" });
    } else {
      const parsedPage = Number.parseInt(raw.page, 10);
      if (parsedPage < 1) {
        errors.push({ field: "page", reason: "頁次必須大於等於 1" });
      } else {
        page = parsedPage;
      }
    }
  }

  // ── pageSize（AC-65：<=0 → 400；> 上限 → clamp 不報錯；預設 20）─────────
  let pageSize = PAGE_SIZE_DEFAULT;
  if (raw.pageSize !== undefined && raw.pageSize !== "") {
    if (!POSITIVE_INTEGER_PATTERN.test(raw.pageSize)) {
      errors.push({ field: "pageSize", reason: "每頁筆數必須為正整數" });
    } else {
      const parsedPageSize = Number.parseInt(raw.pageSize, 10);
      if (parsedPageSize <= 0) {
        errors.push({ field: "pageSize", reason: "每頁筆數必須大於 0" });
      } else {
        pageSize = Math.min(parsedPageSize, PAGE_SIZE_MAX);
      }
    }
  }

  return { errors, dateFrom, dateTo, type, status, keyword, page, pageSize };
}

// ---------------------------------------------------------------------------
// buildApplicationWhere — Prisma where 建構（純函式，AC-91 索引形狀見檔頭）
// ---------------------------------------------------------------------------

export interface ApplicationListFilters {
  ownerId: string;
  dateFrom: Date;
  dateTo: Date | null;
  type: ApplicationType | null;
  status: ApplicationStatus | null;
  keyword: string | null;
  page: number;
  pageSize: number;
}

export function buildApplicationWhere(
  filters: Pick<
    ApplicationListFilters,
    "ownerId" | "dateFrom" | "dateTo" | "type" | "status" | "keyword"
  >
): Prisma.ApplicationWhereInput {
  const where: Prisma.ApplicationWhereInput = {
    ownerId: filters.ownerId,
    primaryDate:
      filters.dateTo !== null
        ? { gte: filters.dateFrom, lte: filters.dateTo }
        : { gte: filters.dateFrom },
  };
  if (filters.type !== null) {
    where.type = filters.type;
  }
  if (filters.status !== null) {
    where.status = filters.status;
  }
  // AC-64/D10: 本 Phase 僅比對 TravelApplication.purpose（不分大小寫、部分比對）。
  // MAINTENANCE/DEPRECIATION 尚無子表可比對——帶 keyword 時這兩型天然查無結果，
  // 與 AC-71「相容行為」不衝突（AC-71 本身不涉及 keyword 組合）。
  // B-23: keyword 先跳脫 LIKE 萬用字元（`%`/`_`/`\`），使其在 ILIKE pattern
  // 中成為字面字元，見 `escapeLikePattern` 文件註解。
  if (filters.keyword !== null) {
    where.travel = {
      purpose: { contains: escapeLikePattern(filters.keyword), mode: "insensitive" },
    };
  }
  return where;
}

// ---------------------------------------------------------------------------
// queryApplications — DB 層分頁（AC-67 全序排序、AC-91 skip/take + count）
// ---------------------------------------------------------------------------

const applicationListInclude = {
  owner: { select: { displayName: true } },
  travel: {
    select: {
      tripDate: true,
      purpose: true,
      snapshotTotalKm: true,
      _count: { select: { segments: true } },
    },
  },
} satisfies Prisma.ApplicationInclude;

type ApplicationListRow = Prisma.ApplicationGetPayload<{ include: typeof applicationListInclude }>;

export interface ApplicationListQueryResult {
  items: ApplicationListRow[];
  total: number;
}

/**
 * AC-67：排序為全序 `primaryDate DESC, createdAt DESC, id DESC`——只用
 * `primaryDate` 排序在同日多筆時，跨頁 `skip`/`take` 的結果集邊界不確定
 * （PostgreSQL 對相同排序鍵的列之間沒有穩定順序保證），會造成同一列同時出現
 * 在兩頁（重複）或完全不出現（遺漏）。三層排序鍵中 `id`（cuid，主鍵）保證
 * 最終全序，是這裡的鑑別力核心。
 *
 * AC-91：分頁與計數皆由 Prisma/PostgreSQL 於 DB 層完成（`skip`/`take` +
 * 獨立 `count`），本函式不會把 `where` 命中的整個集合讀進記憶體。
 */
export async function queryApplications(
  prisma: PrismaClient,
  filters: ApplicationListFilters
): Promise<ApplicationListQueryResult> {
  const where = buildApplicationWhere(filters);

  const [items, total] = await Promise.all([
    prisma.application.findMany({
      where,
      include: applicationListInclude,
      orderBy: [{ primaryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.application.count({ where }),
  ]);

  return { items, total };
}

// ---------------------------------------------------------------------------
// toApplicationListItemDto — DB row → DTO（AC-68 不適用欄位回 null）
// ---------------------------------------------------------------------------

export interface ApplicationListItemDto {
  id: string;
  type: ApplicationType;
  status: ApplicationStatus;
  primaryDate: string;
  tripDate: string | null;
  title: string | null;
  totalKm: string | null;
  totalAmount: number | null;
  segmentCount: number | null;
  ownerId: string;
  ownerDisplayName: string;
  onBehalf: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toApplicationListItemDto(app: ApplicationListRow): ApplicationListItemDto {
  const isTravel = app.type === "TRAVEL";
  const travel = app.travel;

  return {
    id: app.id,
    type: app.type,
    status: app.status,
    primaryDate: formatUtcDate(app.primaryDate),
    // AC-68: 非差旅類型（尚無子表，PHASE-006/007 前）一律 null，前端顯示「—」。
    tripDate: isTravel && travel?.tripDate ? formatUtcDate(travel.tripDate) : null,
    title: isTravel ? (travel?.purpose ?? null) : null,
    // 差旅已完成才有里程快照；草稿或非差旅一律 null。
    totalKm:
      isTravel && app.status === "COMPLETED" && travel?.snapshotTotalKm != null
        ? travel.snapshotTotalKm.toFixed(2)
        : null,
    totalAmount: app.totalAmount,
    segmentCount: isTravel ? (travel?._count.segments ?? 0) : null,
    ownerId: app.ownerId,
    ownerDisplayName: app.owner.displayName,
    onBehalf: app.createdById !== app.ownerId,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}
