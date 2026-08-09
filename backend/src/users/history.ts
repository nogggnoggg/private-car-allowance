/**
 * userHasHistory — 使用者永久刪除之前置守門（AD-US-04②）。
 *
 * 沿革：PHASE-002-T9 建立可擴充判斷點（當時無資料表，恆回 false）→
 * PHASE-004-T15 接上 `Application`（AC-92）→ PHASE-005a-T1 加入
 * `UserFuelConsumptionVersion`（§8.2）→ **PHASE-010-T5**（本次）依 Spec
 * `docs/specs/PHASE-010.md` §16 **D5=(c)** 之人類裁定，將守門面擴至**指向
 * `User` 之全部 `ON DELETE RESTRICT` 外鍵**。
 *
 * ---------------------------------------------------------------------------
 * 為什麼是「全部 RESTRICT FK」而不是「申請與油耗兩表」
 * ---------------------------------------------------------------------------
 * `prisma.user.delete()` 只要撞上任何一條 `ON DELETE RESTRICT` 外鍵就會拋
 * P2003；該例外若未被守門攔在前面，會落到 `platform/error-handler.ts` 的未預期
 * 例外分支而回 **`500 INTERNAL_ERROR`**——與 AD-US-04② 逐字要求的「拒絕並提供
 * 停用選項」（`409` ＋ 停用文案）不符。故守門所查之欄位集合必須與 DB 實際的
 * RESTRICT 外鍵集合**一一對應**：少一條就是一條 500 的缺口。
 *
 * 該對應關係不是靠註解維持，而是由 `USER_RESTRICT_FK_GUARDS` 這份宣告 ＋
 * `backend/test/integration/phase10-user-delete-regression.test.ts` 之
 * **機械相符斷言**（以 `information_schema` 列舉 DB 實際 FK 與本宣告逐一比對，
 * AC-14(a)）共同保證：日後任何人在 schema 新增一條指向 `User` 的 RESTRICT
 * 外鍵而未同步在此登記，該測試即紅。
 *
 * ---------------------------------------------------------------------------
 * 使用者可見後果（Spec §16 D5「併記」，人類 leonchih 2026-08-09 明示接受）
 * ---------------------------------------------------------------------------
 * 凡曾建立過帳號／改過全域參數／上傳過附件／被記過任何稽核（即成為
 * `AuditLog.actorId`）之管理員，**永久不可刪除，只能停用**。這正是 AD-US-04②
 * 的設計意圖（有歷史即拒刪、改用停用），而非缺陷。
 *
 * ---------------------------------------------------------------------------
 * 刻意**不**納入之兩條路徑（勿誤讀為漏列）
 * ---------------------------------------------------------------------------
 *   · `Session.userId` —— `ON DELETE CASCADE`：刪除使用者時 session 隨之消滅，
 *     本就不阻擋刪除（`admin-users.test.ts` 之 cascade 測試即其守門）。
 *   · `AuditLog.targetId` —— `ON DELETE SET NULL`：**被操作過的人可刪、操作過
 *     的人不可刪**。刪除後該欄轉為 `null`、`targetLabel` 仍留 loginName 快照，
 *     這是 AD-US-04③「留下不含敏感資料的管理操作紀錄」之既有設計（AC-13(b)）。
 *     兩語意分野切勿混同（PHASE-010 T2／T3 即審 FW-4）。
 *
 * ---------------------------------------------------------------------------
 * 查詢成本（誠實揭露；取代 PHASE-004 版註解中「一律 index scan」之陳述）
 * ---------------------------------------------------------------------------
 * 六條查詢皆為單欄存在性 `count`，並行送出（`Promise.all`），任一 > 0 即足以
 * 判定拒刪（OR 語意，不需知道是哪一張表命中）。其中
 * `Application.ownerId`（`[ownerId, status, primaryDate]` 前導欄）、
 * `Attachment.ownerId`、`AuditLog.actorId`、
 * `UserFuelConsumptionVersion.userId`（`[userId, effectiveFrom]` 前導欄）四條
 * 有索引可用；`Application.createdById` 與 `Attachment.uploaderId` **無對應索
 * 引**（`schema.prisma` 實查），於大表上為 seq scan。本 Task 不得變更 schema
 * （Packet Forbidden），故此處僅據實記載：刪除帳號為低頻管理操作，其成本可
 * 接受；若日後兩表成長為大表，正解是補索引而非縮小守門面。
 *
 * ---------------------------------------------------------------------------
 * 可注入設計（Spec §9）
 * ---------------------------------------------------------------------------
 *   · `userHasHistory(prisma, userId)` —— 生產預設實例。
 *   · `makeUserHasHistory(checker)` —— 工廠，測試可注入 stub
 *     （`admin-users.test.ts` 以 `hasHistory: async () => true` 驗證 409 分支；
 *     `phase10-user-delete-regression.test.ts` 以 `async () => false` **刻意
 *     打開守門**，驗證 `admin/routes.ts` 之 P2003 兜底縱深，AC-14(d)）。
 */

import type { PrismaClient } from "@prisma/client";

/**
 * The shape of a pluggable history checker.
 * Given a userId and PrismaClient, returns true if the user has history.
 */
export type HistoryChecker = (prisma: PrismaClient, userId: string) => Promise<boolean>;

/**
 * 一條「指向 `User` 且 `ON DELETE RESTRICT`」之外鍵，與其對應的存在性查詢。
 *
 * `table`／`column` 是**對外可機械比對的宣告**（AC-14(a) 之斷言對象），`count`
 * 是該欄位的實際查詢——刻意一條 FK 一個項目、每個 `count` 只查自己那一欄，
 * 使宣告與查詢之間沒有「一個 lambda 涵蓋多欄」的漂移空間。
 */
export interface UserRestrictFkGuard {
  /** 引用端資料表名（與 `information_schema` 之 `table_name` 逐字相同）。 */
  readonly table: string;
  /** 引用端欄位名（與 `information_schema` 之 `column_name` 逐字相同）。 */
  readonly column: string;
  /** 該欄位指向此 userId 之列數（存在性判定用）。 */
  readonly count: (prisma: PrismaClient, userId: string) => Promise<number>;
}

/**
 * 守門清單 —— 與 DB 實際 RESTRICT 外鍵集合之相符性由 AC-14(a) 機械斷言保證。
 *
 * 新增指向 `User` 的 RESTRICT 外鍵時，必須同步在此加一項，否則
 * `phase10-user-delete-regression.test.ts` 之相符斷言必紅。
 */
export const USER_RESTRICT_FK_GUARDS: readonly UserRestrictFkGuard[] = [
  {
    table: "Application",
    column: "ownerId",
    count: (prisma, userId) => prisma.application.count({ where: { ownerId: userId } }),
  },
  {
    table: "Application",
    column: "createdById",
    count: (prisma, userId) => prisma.application.count({ where: { createdById: userId } }),
  },
  {
    table: "Attachment",
    column: "uploaderId",
    count: (prisma, userId) => prisma.attachment.count({ where: { uploaderId: userId } }),
  },
  {
    table: "Attachment",
    column: "ownerId",
    count: (prisma, userId) => prisma.attachment.count({ where: { ownerId: userId } }),
  },
  {
    table: "AuditLog",
    column: "actorId",
    count: (prisma, userId) => prisma.auditLog.count({ where: { actorId: userId } }),
  },
  {
    table: "UserFuelConsumptionVersion",
    column: "userId",
    count: (prisma, userId) => prisma.userFuelConsumptionVersion.count({ where: { userId } }),
  },
];

/**
 * 生產判定：任一 RESTRICT 外鍵路徑有列 → 有歷史 → 拒刪。
 *
 * 「有無歷史」只看**當下的列**，沒有「曾經有過」的概念——外部清理掉那些列之
 * 後，該使用者即重新可刪（既有語意，未變）。
 */
const productionHistoryChecker: HistoryChecker = async (
  prisma: PrismaClient,
  userId: string
): Promise<boolean> => {
  const counts = await Promise.all(
    USER_RESTRICT_FK_GUARDS.map((guard) => guard.count(prisma, userId))
  );
  return counts.some((count) => count > 0);
};

/**
 * Factory: create a `userHasHistory` function backed by a custom checker.
 * Used in tests to inject a stub that returns true for the "has history" branch.
 */
export function makeUserHasHistory(
  checker: HistoryChecker = productionHistoryChecker
): (prisma: PrismaClient, userId: string) => Promise<boolean> {
  return (prisma, userId) => checker(prisma, userId);
}

/**
 * Default production instance.
 * Admin routes use this directly; tests use makeUserHasHistory() with a stub.
 */
export const userHasHistory = makeUserHasHistory(productionHistoryChecker);
