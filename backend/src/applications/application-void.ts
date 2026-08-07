/**
 * Application void (作廢) service — PHASE-009-T3
 *
 * Spec §2 AC-03/04/06/07/08、§3.1「作廢已完成申請」、§7.2 `VoidInfoDto`、
 * §8.1（`voidReason`/`voidedAt`/`voidedById` 三欄同生共死）、§16 D3(a)。
 *
 * Owns the type-agnostic core of the void flow: reason validation → status
 * gate → single transaction (row lock → four-column write) → returns the
 * updated generic `Application` row. Mirrors the existing
 * `completeTravelApplication`/`deleteApplication` split (travel-service.ts):
 * this file has NO knowledge of `Application.type`（TRAVEL/MAINTENANCE/
 * DEPRECIATION）because voiding only ever touches the shared `Application`
 * row — none of the three child tables carry a void-related column
 * (§8.1：四欄皆在 `Application`本身). Authorization (owner/admin, 401/403)
 * and the HTTP route itself are `routes.ts`'s responsibility — **T4, Files
 * Forbidden for this Task** — this module is called AFTER auth already
 * passed, exactly like `completeTravelApplication`'s own doc comment
 * ("D17: this function has NO owner/admin distinction").
 *
 * ── 判定順序（§3.1 步驟 4 早於步驟 5，兩步驟在本實作合併為交易內單一序列）──
 * Spec 的流程描述把「狀態守門（409）」列為交易外的步驟 4、「reason 驗證
 * （400）」列為步驟 5，兩者之後才進入步驟 7 的交易（內含步驟 7b 對狀態機的
 * 再次確認）。本實作把步驟 4/5/7a/7b 全部收斂到**同一個交易**內、依 4 → 7a
 * （鎖列）→ 7b（狀態守門，含競態下的新鮮讀取）→ 5（reason 驗證）→ 7c（四欄
 * 寫入）的順序執行——理由：
 *   1. 步驟 4 若真的獨立於交易外執行，仍必須在步驟 7 交易內以鎖列後的新鮮
 *      讀取「重新驗證」一次（否則無法防禦 B-08 之併發雙作廢），等於同一個
 *      判斷寫兩遍；既然如此，直接把唯一一次判斷放在鎖列之後，行為完全等價
 *      且不重複程式碼。
 *   2. Spec 步驟 6（D4(b1) 作廢版 PDF 之交易外組裝）需要「狀態與 reason 皆已
 *      確認合法」才能開始，但**該步驟屬 T12（Files Forbidden，本 Task 不實
 *      作）**——本檔刻意不在交易外重複一次「僅為了給步驟 6 用」的檢查，避免
 *      為未實作的步驟預先做半套。T12 銜接時，若需要交易外的先行檢查，可在
 *      呼叫本函式前自行以 `getApplicationForAuth`（travel-service.ts 既有
 *      匯出）等既有查詢做一次唯讀確認——不影響本函式的正確性或介面。
 *   3. 「狀態守門在 reason 驗證之前」之相對順序仍逐字保留（見下方
 *      `voidApplication` 本體：status 檢查在 `validateVoidReason` 呼叫之
 *      前）——對「草稿 + 空原因」等雙重違規的請求，回應恆為 409（狀態），非
 *      400（原因），與 Spec 步驟編號的相對順序一致。
 *
 * ── 併發（B-08）──
 * `SELECT ... FOR UPDATE` 為交易第一個陳述式（沿 `updateTravelDraft`/
 * `deleteApplication` 既有慣例，Postgres 表名於既有 schema 無 `@@map`，故沿
 * 用既有寫法加引號）。與 update/complete/delete 三者不同，本函式**不**使用
 * SERIALIZABLE + 重試迴圈——本函式的交易只讀寫單一 `Application` 列、不涉及
 * 任何子表或多列寫入，READ COMMITTED 下的列鎖已足以正確序列化：兩個併發
 * `voidApplication` 呼叫會在 `FOR UPDATE` 排隊，先提交者之後，後手鎖定同一
 * 列並以**新鮮讀取**看見 `status="VOIDED"`，因而確定性地在狀態守門處拋
 * 409——不是「靠重試碰運氣收斂」，前手不會被中止、後手也不會遭遇序列化失
 * 敗，沒有重試的必要（沿 `reports/report-service.ts` 之顧問鎖 + READ
 * COMMITTED 先例：鎖 + 單語句新鮮讀取本身就是收斂點，無需 SERIALIZABLE）。
 */
import type { ApplicationStatus, ApplicationType, PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { PrismaLike } from "../mileage/mileage-engine.js";
import { AppError } from "../platform/errors.js";
import { assertTransition } from "./application-state-machine.js";
import { validateVoidReason } from "./void-reason.js";

// ---------------------------------------------------------------------------
// VoidInfoDto (§7.2) — shared by all three type DTOs (travel/maintenance/
// depreciation service files, this Task's Files Allowed).
// ---------------------------------------------------------------------------

/** 作廢資訊；未作廢恆為 `null`（Empty 態不渲染之依據，§7.2 明文）。 */
export interface VoidInfoDto {
  reason: string;
  voidedAt: string; // ISO8601
  voidedByDisplayName: string; // 解析失敗時 "—"；恆不含 voidedById（§8.3）
}

/**
 * 由 `Application` 列組裝 `VoidInfoDto`。三欄（`voidReason`/`voidedAt`/
 * `voidedById`）同生共死（§8.1 註解）——任一為 `null` 即視為未作廢，回傳
 * `null`。`voidedById` 無 FK（§8.3：沿 `Report.generatedById` 慣例），故以
 * 獨立查詢解析顯示名稱；查無該使用者（帳號已被刪除等情形）時以 `"—"`
 * 呈現、**不**拋錯、**不**外洩 `voidedById`（AC-19(c) 之同型紀律，本 Task
 * 之三型 DTO 版本）。
 *
 * 呼叫端紀律（沿 `maintenance-service.ts`/`depreciation-service.ts` 之既有
 * 「DTO builder 不得偷查 DB」分工）：本函式本身即為「會查 DB 的那一層」，
 * 應由 `build*ApplicationDto`（或 `toTravelApplicationDto`，該檔本就是
 * async/DB-touching）呼叫，其純函式 `to*ApplicationDto` 只接收已解析好的
 * 結果。
 */
export async function resolveVoidInfo(
  db: PrismaLike,
  application: {
    voidReason: string | null;
    voidedAt: Date | null;
    voidedById: string | null;
  }
): Promise<VoidInfoDto | null> {
  if (
    application.voidReason === null ||
    application.voidedAt === null ||
    application.voidedById === null
  ) {
    return null;
  }

  const voidedBy = await db.user.findUnique({
    where: { id: application.voidedById },
    select: { displayName: true },
  });

  return {
    reason: application.voidReason,
    voidedAt: application.voidedAt.toISOString(),
    voidedByDisplayName: voidedBy?.displayName ?? "—",
  };
}

// ---------------------------------------------------------------------------
// voidApplication (§3.1, AC-03/04/06/07)
// ---------------------------------------------------------------------------

/** 作廢後之最小列——僅本函式實際讀寫之欄位，供呼叫端（T4）組裝稽核摘要用。 */
export interface VoidedApplicationRow {
  id: string;
  type: ApplicationType;
  status: ApplicationStatus;
  ownerId: string;
  voidReason: string;
  voidedAt: Date;
  voidedById: string;
}

/**
 * 四欄寫入 (7c) 之後、稽核寫入之前所需的上下文——供 `onVoided` hook（T4）組
 * 稽核摘要（AC-24：`{ applicationId, type, reason, voidedAt }`）與
 * `targetLabel`（`{loginName}#{applicationId}` 形狀）用，於**同一交易**內
 * 新鮮讀取（沿 `TravelDraftUpdateAuditContext` 既有模式）。
 */
export interface VoidApplicationContext {
  ownerId: string;
  ownerLoginName: string;
  type: ApplicationType;
}

/**
 * 作廢成功後（四欄已寫入、尚未提交）之 hook，於**同一交易**內執行——
 * T4（作廢端點）用此掛入 `AuditLog(APPLICATION_VOIDED)` 寫入（AC-24：同交易
 * 自證），hook 拋錯會使整筆交易（含四欄寫入）一併回滾，與
 * `OnTravelDraftUpdated` 同型（travel-service.ts 既有模式）。省略時為
 * no-op——本 Task（T3）自身的測試不傳入 hook，天生零稽核寫入。
 *
 * 〔D4(b1)，T12，Files Forbidden，本 Task 不實作〕作廢版 PDF 產生（§3.1 步驟
 * 7d）之接點：須插入於四欄寫入（7c，已完成）之後、本 hook（7e，稽核）之前
 * ——即在 `voidApplication` 呼叫 `onVoided` 之前，多一個型別為
 * `(tx, application) => Promise<void>` 的「PDF 產生」步驟。本 Task 刻意不
 * 新增第二個 hook 參數（避免為未實作的步驟預先做半套 API），T12 落地時於此
 * 檔案就地擴充。
 */
export type OnApplicationVoided = (
  tx: Prisma.TransactionClient,
  context: VoidApplicationContext,
  application: VoidedApplicationRow
) => Promise<void>;

/**
 * 作廢一筆已完成申請（AC-03/04/06/07；型別無關——只讀寫 `Application` 共用
 * 欄位）。
 *
 * @param prisma 頂層 `PrismaClient`（本函式自行開交易，不接受呼叫端傳入的
 *   `tx`——與 `completeTravelApplication`/`deleteApplication` 同型）。
 * @param id 目標申請 id。不存在時交由 Prisma 的 `findUniqueOrThrow` 拋出
 *   `NotFoundError`——404 轉譯與存在性之預先確認是 `routes.ts`（T4）的責
 *   任，本函式的呼叫端（含本 Task 自身的整合測試）預期已確認過該 id 存在
 *   （沿 `completeTravelApplication` 之既有分工："this function has NO
 *   owner/admin distinction" 同理延伸至存在性）。
 * @param rawReason 未經驗證的原始 `reason`（例如 HTTP body 的
 *   `request.body.reason`，型別為 `unknown`）——本函式內部呼叫
 *   `validateVoidReason`，400 時整筆拒絕、零寫入。
 * @param actorId 實際操作者 id（本人或代操作之管理員）——寫入 `voidedById`，
 *   不做任何授權判斷（呼叫端已完成）。
 * @param onVoided 選填 hook，見 `OnApplicationVoided` 文件註解（T4 用）。
 */
export async function voidApplication(
  prisma: PrismaClient,
  id: string,
  rawReason: unknown,
  actorId: string,
  onVoided?: OnApplicationVoided
): Promise<VoidedApplicationRow> {
  return prisma.$transaction(async (tx) => {
    // §3.1 步驟 7a：行鎖，防雙作廢競態（B-08）——交易第一個陳述式。
    await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${id} FOR UPDATE`;

    const existing = await tx.application.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        ownerId: true,
        type: true,
        owner: { select: { loginName: true } },
      },
    });

    // §3.1 步驟 4（狀態守門，409）＋ 步驟 7b（狀態機再次確認）之合併實作，
    // 見檔頭文件註解「判定順序」。非 COMPLETED（含 DRAFT、已是 VOIDED 之
    // AC-06/07）一律 409 CONFLICT + details.status——這是本函式對外可見的
    // 錯誤碼，**不**倚賴 `assertTransition` 自身的 403（那是給
    // `/complete`／PUT／DELETE 等其他端點用的既有語意，AC-05(b)）。
    if (existing.status !== "COMPLETED") {
      throw new AppError("CONFLICT", 409, "僅已完成之申請可作廢", undefined, {
        status: existing.status,
      });
    }

    // 狀態機單一事實來源（§3.1 步驟 7b 之字面要求）——上方守門已保證
    // `existing.status === "COMPLETED"`，故本呼叫在此處恆落入
    // `COMPLETED → VOIDED` 之合法分支、恆不拋錯；保留此呼叫是為了不讓
    // `application-state-machine.ts` 以外的任何程式碼片段自行決定「哪些轉
    // 換合法」——即使在這個已經確定合法的位置也一律經過它。
    assertTransition(existing.status, "VOIDED");

    // §3.1 步驟 5：reason 驗證（400），見檔頭「判定順序」說明——置於狀態
    // 守門之後，故草稿／已作廢申請即使原因也不合法，回應仍為 409（狀態）
    // 而非 400（原因）。
    const reasonResult = validateVoidReason(rawReason);
    if (!reasonResult.ok) {
      throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
        reasonResult.error,
      ]);
    }

    const voidedAt = new Date();

    // §3.1 步驟 7c：單一交易內四欄寫入（status／voidReason／voidedById／
    // voidedAt）——快照相關欄位（totalAmount／completedAt／三型子表
    // snapshot*）本函式從未讀取也從未寫入，AC-04 之「快照零改寫」由此天然
    // 成立（不是靠額外的「不要動它」判斷，而是程式碼裡根本沒有觸碰的路徑）。
    const updated = await tx.application.update({
      where: { id },
      data: {
        status: "VOIDED",
        voidReason: reasonResult.value,
        voidedAt,
        voidedById: actorId,
      },
      select: { id: true, type: true, status: true, ownerId: true },
    });

    // 〔D4(b1)，T12，Files Forbidden〕作廢版 PDF 產生之接點——見上方
    // `OnApplicationVoided` 文件註解「接點」段落：須插入於此處（7c 之後、
    // 下方 7e 稽核 hook 之前）。本 Task 不實作。

    const row: VoidedApplicationRow = {
      id: updated.id,
      type: updated.type,
      status: updated.status,
      ownerId: updated.ownerId,
      voidReason: reasonResult.value,
      voidedAt,
      voidedById: actorId,
    };

    // §3.1 步驟 7e：稽核 hook（T4 用；省略時 no-op，見 `OnApplicationVoided`
    // 文件註解）。
    if (onVoided) {
      await onVoided(
        tx,
        {
          ownerId: existing.ownerId,
          ownerLoginName: existing.owner.loginName,
          type: existing.type,
        },
        row
      );
    }

    return row;
  });
}
