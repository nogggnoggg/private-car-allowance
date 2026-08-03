/**
 * PHASE-005-T4 — 統計端點 `GET /statistics/mileage`
 *
 * 依 Gate 定案 D4(a)：**單一端點 + `ownerId` 參數**（不採管理員專用路徑），
 * 授權判定唯一化為 `application-query.ts:resolveOwnerId`——與 PHASE-004
 * `GET /applications` 完全同一個函式、同一組 403 語意（AC-23／PHASE-004 §6.1），
 * 本檔**不重寫**任何授權判定。
 *
 * 本 route 為薄層編排，只做四件事：
 *   1. `requireAuth` + `requirePasswordChanged` 自始掛載（Spec §6.1 授權矩陣；
 *      未登入 401、強制改密 403 由既有中介負責，本檔不新造授權機制）。
 *   2. `resolveOwnerId(actor, query.ownerId)` → 一般使用者自帶他人 → 403
 *      `FORBIDDEN`，**不靜默降級**（AC-23）。
 *   3. `parseMileageRange(query)` → 缺漏／格式／起>迄 → 400 `VALIDATION_ERROR`
 *      並附可定位 `fields`（AC-15/16/17）。驗證邏輯全在 T1 之純函式內，
 *      本檔不重寫。
 *   4. `sumOfficialMileage(prisma, {...})`（T2/T3 引擎）→ DTO 序列化。
 *
 * **判定順序（B-26 定案）**：授權（403）**先於**格式驗證（400）——與
 * PHASE-004 `GET /applications` 之既有 route 慣例一致（見 `applications/
 * routes.ts` 的 `GET /applications` 註解）。理由是避免以 400／403 的差異洩漏
 * 「日期格式有效與否」這條側信道給無權查詢他人資料的呼叫者。
 *
 * **回應鍵為封閉白名單**（AC-26，正式驗證屬 T6）：`totalKm`、
 * `applicationCount`、`appliedFilters.{dateFrom,dateTo,ownerId}`（D7(a)）；
 * 不得新增任何欄位，尤其不得洩漏單價、金額、出差目的、地點、附件或他人
 * `displayName`／`loginName`。
 *
 * **錯誤協定**沿用 `platform/errors.ts` 既有 `ErrorCode` 聯集，本 Phase
 * 不新增任何錯誤碼（AC-20）。
 *
 * Spec: docs/specs/PHASE-005.md §5 B-26、§6.1、§7.1、§7.2、§9、
 *       AC-09(HTTP)/14/15/16/17/23
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { resolveOwnerId } from "../applications/application-query.js";
import { requireAuth, requirePasswordChanged } from "../auth/middleware.js";
import { formatUtcDate } from "../parameters/parameter-service.js";
import { AppError, type FieldError } from "../platform/errors.js";
import { sumOfficialMileage } from "./mileage-engine.js";
import { parseMileageRange } from "./mileage-range.js";

/**
 * T6-AR-1（複審移交）：`request.query` 的實際執行期型別**不是**
 * `Record<string, string | undefined>`——Fastify 對重複 query 鍵（如
 * `?ownerId=x&ownerId=y`）會解析為 `string[]`。舊實作把 query 直接當字串
 * 傳入 `resolveOwnerId`／`parseMileageRange`，當 ADMIN 帶重複 `ownerId` 時，
 * 陣列值未經檢查即流入 `buildOfficialMileageWhere` 的 Prisma `where.ownerId`
 * （Prisma 只接受純量），觸發 `PrismaClientValidationError` → 未預期例外
 * → 500（log 洩漏查詢結構與絕對路徑）。
 *
 * 依 AC-19「不得因夾帶欄位而報 500」，本函式在**任何授權／格式驗證之前**
 * 對 `ownerId`／`dateFrom`／`dateTo` 三個本端點實際使用的 query 鍵做型別
 * 收斂：非字串（陣列，或未來 querystring parser 可能產生的其他型別）一律
 * 400 `VALIDATION_ERROR`。
 *
 * 刻意選擇「拒絕」而非「取首值」：取首值會讓「多帶一個同名參數」被靜默接受
 * 並產生不可預期的行為（例如 ADMIN 取到陣列第一個 ownerId，呼叫者不易得知
 * 究竟命中哪一個值）；400 明確告知「這不是本端點支援的輸入形狀」，較誠實
 * （Task Packet 明確要求「擇一並說理」）。
 *
 * 此檢查與 B-26（403 優先於日期格式 400）並不衝突——B-26 針對的是「日期字串
 * 內容是否合法」這個業務規則，本檢查針對的是「query 值是否為單一字串」這個
 * 更底層的結構前提；沒有這個前提，`resolveOwnerId` 甚至無法對 `ownerId`
 * 做出有意義的字串比較，因此必須先於授權判定執行。
 */
function assertScalarQueryParams(query: Record<string, unknown>): void {
  const scalarFields: Array<"ownerId" | "dateFrom" | "dateTo"> = ["ownerId", "dateFrom", "dateTo"];
  const fields: FieldError[] = [];
  for (const field of scalarFields) {
    const value = query[field];
    if (value !== undefined && typeof value !== "string") {
      fields.push({ field, reason: "僅接受單一字串值，不得重複帶入此參數" });
    }
  }
  if (fields.length > 0) {
    throw new AppError("VALIDATION_ERROR", 400, "查詢參數有誤，請檢查標示欄位。", fields);
  }
}

interface MileagePluginOptions {
  prisma: PrismaClient;
}

/**
 * D3(a)：里程一律以**字串**傳輸、**固定 2 位小數**、**不取整**。
 *
 * 刻意不使用 `Decimal.prototype.toString()`——`decimal.js`（Prisma `Decimal`
 * 的底層）會去除小數尾端的 0，`new Prisma.Decimal("10.00").toString()` 得
 * `"10"`、`"30.1"` 得 `"30.1"`，都不是固定 2 位小數的表示。改用 `toFixed(2)`，
 * 與 `applications/application-query.ts:411`（`snapshotTotalKm.toFixed(2)`）
 * 的既有 DTO 慣例逐字一致。
 *
 * `toFixed` 為 `decimal.js` 的十進位運算，全程不經 IEEE754 double（§10.5
 * 精度紀律 1）；本 Phase 之來源皆為 `Decimal(_,2)`，故此處不會發生實際的
 * 位數捨去（B-24）。
 */
export function formatMileageKm(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export const mileagePlugin: FastifyPluginAsync<MileagePluginOptions> = async (
  fastify: FastifyInstance,
  options: MileagePluginOptions
) => {
  const { prisma } = options;

  const authPreHandlers = [requireAuth(prisma), requirePasswordChanged];

  fastify.get(
    "/statistics/mileage",
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // T6-AR-1：query 的執行期型別可能是 `string[]`（重複鍵）——見上方
      // `assertScalarQueryParams` 註解。先做結構層的型別收斂，再視為
      // `Record<string, string | undefined>` 使用。
      const rawQuery = request.query as Record<string, unknown>;
      assertScalarQueryParams(rawQuery);
      const query = rawQuery as Record<string, string | undefined>;
      const actor = request.currentUser;

      // B-26：授權判定先行。一般使用者自帶他人 `ownerId` 一律 403，且不看其餘
      // query 參數是否合法——403 與 400 的先後不得因日期格式而變。
      const ownerId = resolveOwnerId(actor, query.ownerId);

      const parsed = parseMileageRange(query);
      if (parsed.errors.length > 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          400,
          "查詢參數有誤，請檢查標示欄位。",
          parsed.errors
        );
      }

      // `parseMileageRange` 於零錯誤時保證兩者皆非 null（見該函式契約）；此處
      // 的非空斷言僅為型別收斂，不是新的執行期假設。
      const dateFrom = parsed.dateFrom as Date;
      const dateTo = parsed.dateTo as Date;

      const { totalKm, applicationCount } = await sumOfficialMileage(prisma, {
        ownerId,
        dateFrom,
        dateTo,
      });

      // AC-09（HTTP 層）：無命中時引擎回 `Decimal(0)` → `"0.00"`，仍為 200，
      // 不是 404、不是 `null`、不是空字串。
      return reply.status(200).send({
        totalKm: formatMileageKm(totalKm),
        applicationCount,
        appliedFilters: {
          dateFrom: formatUtcDate(dateFrom),
          dateTo: formatUtcDate(dateTo),
          ownerId,
        },
      });
    }
  );
};
