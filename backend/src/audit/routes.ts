/**
 * PHASE-010-T2 — 稽核查詢端點 `GET /admin/audit-logs`（唯讀）
 *
 * Spec `docs/specs/PHASE-010.md` §2.A AC-01／AC-03／AC-04／AC-05、§5 B-01~B-13
 * ／B-19~B-24、§6.1 授權矩陣（5 格）、§6.3 敏感資料、§7 API contract、
 * §16 **D1(b)**（新檔 `audit/routes.ts` ＋ 新 `auditPlugin`，於 `server.ts` 註冊）
 * ／**D4(a)**（管理員 only）／**D9(a)**（後端回 ISO 8601 UTC，在地化屬前端）。
 *
 * ---------------------------------------------------------------------------
 * 本檔的職責邊界（薄層編排，四件事）
 * ---------------------------------------------------------------------------
 *   1. 授權：`requireAuth` → `requirePasswordChanged` → `requireAdmin` 三段既有
 *      中介，**本檔不新造任何授權機制**。三者皆為 `preHandler`，故 `401`／`403`
 *      恆**早於** handler 內的參數解析與任何 DB 查詢（AC-05(b)；B-20 側信道之
 *      結構性保證即在此——畸形 `page` 對非管理員得 `403` 而非 `400`）。
 *   2. 參數解析：`parseAuditLogQuery`（PHASE-010-T1 純函式，**本檔不重寫**）。
 *   3. `where` 建構 ＋ 全序排序 ＋ DB 層分頁（`skip`／`take` ＋ 獨立 `count`）。
 *   4. DTO 投影（`toAuditLogListItemDto`），`changes` 由 `flattenAuditSummary`
 *      （T1 純函式）產生。
 *
 * ---------------------------------------------------------------------------
 * 半開區間（T1 契約，**誤用即多撈一整天**）
 * ---------------------------------------------------------------------------
 * `parseAuditLogQuery` 之日期輸出刻意命名為 `createdAtFrom`（含）與
 * `createdAtToExclusive`（**不含**，＝`dateTo` 次日 00:00:00.000Z）。`where`
 * 因而必須是 `gte` ＋ **`lt`**；寫成 `lte` 會讓 `dateTo` 當日整整多撈一天的列
 * （該日 23:59:59.999Z 與次日 00:00:00.000Z 之間的分野消失）。整合測試以
 * 「當日 23:59:59.999Z 必命中 ∧ 次日 00:00:00.000Z 必不命中」雙向釘死。
 *
 * ---------------------------------------------------------------------------
 * `page` 無上界 → `skip` 溢位（B-04 之守門責任在本層）
 * ---------------------------------------------------------------------------
 * `parseAuditLogQuery` 對 `page` 僅驗 `^\d+$`（逐字沿 PHASE-004 之既有語意，
 * 不得為本 Task 而更動）且**無上界**，故 `page=1000000000000000000000` 是
 * **合法輸入**，`(page - 1) * pageSize` 隨之無上界。
 *
 * **實測（本 Task 對 `@prisma/client` 5.22.0 ＋ PostgreSQL 16 之直接量測）**：
 *   · `skip` ＝ 2^31-1／2^31／1.9999999998e10／`Number.MAX_SAFE_INTEGER`／1e17
 *     → **皆正常回 0 列**（Prisma 並未如其型別文件之 `Int` 字面那樣在 2^31
 *     設限，實際上界接近 64 位元整數）；
 *   · `skip` ＝ 2e21／1e30／`Number.MAX_VALUE`
 *     → **拋 `PrismaClientValidationError`** → 未預期例外 → `500`。
 * 亦即溢位確實存在，只是門檻遠高於「2^31-1」這個轉述值——`page` 只要是 21 位
 * 以上的十進位數字就會踩到，而那是 parser 合法接受的輸入。`500` 違反 B-04
 * 「`page` 大於總頁數 → `200` ＋ `items: []` ＋ 正確之 `total`」。
 *
 * 故本層在 `skip` 超界時**略過 `findMany`、直接回空集**，`total` 仍由同一個
 * `where` 的獨立 `count` 取得——語意與「頁次超出結果集」完全相同（超界的 skip
 * 在任何情況下都不可能命中任何列），不是把錯誤吞掉。門檻取保守的 2^31-1
 * （Prisma `skip` 之型別文件字面）而非實測門檻：實測門檻是**當前版本的實作
 * 細節**，而 2^31-1 是契約字面，取契約側可在未來 Prisma 收緊時仍然安全，且
 * 對真實使用零影響（該值等於「第 1.07 億頁」）。
 *
 * 刻意不改 T1 的 parser：其 `page`／`pageSize` 分支受 AC-02(c) 之「與
 * `application-query.ts` 機械對照」斷言鎖死，在其中加上界會使兩側語意分歧。
 *
 * ---------------------------------------------------------------------------
 * 敏感資料紀律（§6.3）
 * ---------------------------------------------------------------------------
 *   · `AuditLogListItemDto` **不輸出** `actorId`／`targetId`（內部識別值不外露，
 *     沿 PHASE-009 §6.3）；操作者以 `actorDisplayName`、對象以 `targetLabel`
 *     ＋ `targetDisplayName` 呈現。
 *   · `changes` 承載使用者自由文字（作廢原因、油耗依據備註、出差目的），
 *     **不得寫入任何日誌行**——本檔因而零 `log` 呼叫、零主控台輸出。
 *   · `summary` 一律以 **DB 原值**直接傳入 `flattenAuditSummary`；不得先手工
 *     組裝中介物件（該函式對 `bigint`／循環參照會拋錯，手工組裝只會憑空引入
 *     這兩類風險）。
 */

import type { AuditAction, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { AppError } from "../platform/errors.js";
import type { ParsedAuditLogQuery, RawAuditLogQuery } from "./audit-query.js";
import { parseAuditLogQuery } from "./audit-query.js";
import type { AuditChangeDto } from "./audit-summary.js";
import { flattenAuditSummary } from "./audit-summary.js";

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/**
 * `skip` 之保守上界＝Prisma 型別文件所載之 `Int` 上限；超過即不下查而回空集
 * （見檔頭「`page` 無上界 → `skip` 溢位」一節之實測與取值理由）。
 */
const PRISMA_MAX_SKIP = 2_147_483_647;

/**
 * 列表所需之關聯投影。刻意用 `select` 只取 `displayName`——`actor`／`target`
 * 是完整的 `User`，整列 include 會把 `passwordHash`／`loginName` 等一併載入
 * 記憶體，徒增誤外露的機會（§6.3）。
 */
const auditLogListInclude = {
  actor: { select: { displayName: true } },
  target: { select: { displayName: true } },
} satisfies Prisma.AuditLogInclude;

type AuditLogListRow = Prisma.AuditLogGetPayload<{ include: typeof auditLogListInclude }>;

// ---------------------------------------------------------------------------
// DTO（§7.2）
// ---------------------------------------------------------------------------

/** §7.2／AC-04(a)：鍵集封閉為七鍵，多一鍵必紅。 */
export interface AuditLogListItemDto {
  id: string;
  action: AuditAction;
  /** ISO 8601 UTC 字串（D9(a)）；在地化屬前端呈現層。 */
  createdAt: string;
  actorDisplayName: string;
  targetLabel: string;
  /** `target` 已被刪除（FK `ON DELETE SET NULL`）時為 `null`（AC-04(c)／B-13）。 */
  targetDisplayName: string | null;
  changes: AuditChangeDto[];
}

/** §7.2／AC-01(b)：鍵集封閉為四鍵，多一鍵必紅。 */
export interface AuditLogListResponse {
  items: AuditLogListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// buildAuditLogWhere — 純函式（§11.1）
// ---------------------------------------------------------------------------

/**
 * 由已驗證之查詢參數建構 Prisma `where`。
 *
 * 四個篩選維度皆為 optional：`null` 即「不依該維度篩選」，一律**不寫入
 * `where`**（寫成 `{ action: null }` 會被 Prisma 解讀為「欄位等於 null」，
 * 語意完全不同）。日期為半開區間 `gte` ＋ `lt`（見檔頭）。
 *
 * 呼叫端須先確認 `parsed.errors` 為空——錯誤非空時 T1 之 parser 會把四個篩選
 * 欄位一律歸 `null`，此時建出的 `where` 是「全表」而非「使用者要的子集」。
 */
export function buildAuditLogWhere(parsed: ParsedAuditLogQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (parsed.action !== null) where.action = parsed.action;
  if (parsed.actorId !== null) where.actorId = parsed.actorId;
  if (parsed.targetId !== null) where.targetId = parsed.targetId;

  if (parsed.createdAtFrom !== null || parsed.createdAtToExclusive !== null) {
    where.createdAt = {
      ...(parsed.createdAtFrom !== null ? { gte: parsed.createdAtFrom } : {}),
      ...(parsed.createdAtToExclusive !== null ? { lt: parsed.createdAtToExclusive } : {}),
    };
  }

  return where;
}

// ---------------------------------------------------------------------------
// toAuditLogListItemDto — DB 列 → DTO（AC-04）
// ---------------------------------------------------------------------------

export function toAuditLogListItemDto(row: AuditLogListRow): AuditLogListItemDto {
  return {
    id: row.id,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
    actorDisplayName: row.actor.displayName,
    targetLabel: row.targetLabel,
    targetDisplayName: row.target?.displayName ?? null,
    // FW-9：直接傳 DB 原值，不手工組裝中介物件。
    changes: flattenAuditSummary(row.summary),
  };
}

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

interface AuditPluginOptions {
  prisma: PrismaClient;
}

export const auditPlugin: FastifyPluginAsync<AuditPluginOptions> = async (
  fastify: FastifyInstance,
  options: AuditPluginOptions
) => {
  const { prisma } = options;

  fastify.get(
    "/admin/audit-logs",
    { preHandler: [requireAuth(prisma), requirePasswordChanged, requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseAuditLogQuery(request.query as RawAuditLogQuery);

      // AC-02(b)：`errors` 非空即 `400` 且**零查詢**。判準只有這一條——不得改
      // 用「某個欄位是否為 null」，因為 parser 於錯誤時仍會回傳解析出的
      // `page`／`pageSize`（與 PHASE-004 之既有行為逐字一致）。
      if (parsed.errors.length > 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          400,
          "查詢參數有誤，請檢查標示欄位。",
          parsed.errors
        );
      }

      const where = buildAuditLogWhere(parsed);
      const skip = (parsed.page - 1) * parsed.pageSize;

      // AC-03(a)：兩層全序 `createdAt DESC, id DESC`。只用 `createdAt` 排序時，
      // 同時刻的多列在 PostgreSQL 沒有穩定順序保證，跨頁 `skip`/`take` 的邊界
      // 會漂移，同一列可能同時出現在兩頁或完全消失（AC-03(b) 之守門對象）；
      // `id` 為 cuid 主鍵，是這裡的最終全序保證。
      // AC-03(c)：分頁與計數皆於 DB 層完成，不把命中集合整份讀入記憶體。
      const [rows, total] = await Promise.all([
        skip > PRISMA_MAX_SKIP
          ? Promise.resolve<AuditLogListRow[]>([])
          : prisma.auditLog.findMany({
              where,
              include: auditLogListInclude,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              skip,
              take: parsed.pageSize,
            }),
        prisma.auditLog.count({ where }),
      ]);

      // AC-01(c)：零命中時仍為 `200` ＋ `items: []` ＋ `total: 0`（非 404）。
      const body: AuditLogListResponse = {
        items: rows.map(toAuditLogListItemDto),
        total,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
      return reply.status(200).send(body);
    }
  );
};
