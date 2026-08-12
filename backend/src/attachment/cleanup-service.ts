/**
 * Attachment cleanup service — PHASE-011-T3（批次上限 `take` 由 T4 加入）
 *
 * 附件暫存清理之**引用判定**與 **dry-run 唯讀模式**（`docs/specs/PHASE-011.md`
 * **AC-03**／**AC-04**；§16 **D4** = (a)）。
 *
 * ---------------------------------------------------------------------------
 * 本模組的一句話定位
 * ---------------------------------------------------------------------------
 * 這裡是「哪些附件**可以被刪**」的**唯一判準來源**。實際刪除（T4 之
 * `cleanup-cli.ts`）不重新判斷，只消費 `planCleanup` 的輸出——判準與執行分離，
 * 是為了讓「dry-run 說安全、實跑刪錯」在結構上不可能發生（AC-04(c)）。
 *
 * 本模組對 DB **只讀**：全檔零 `create`／`update`／`delete`／`deleteMany`／
 * `upsert`／任何 `$…Raw…`（AC-03(d)，由 `phase11-attachment-cleanup.test.ts`
 * 之結構斷言守住）。**PHASE-011-T4（FW-2=(i)）維持此界線不變**：不可逆刪除
 * 一律落在 `cleanup-cli.ts`，本檔本輪只擴充**讀路徑**（`planCleanup` 之批次
 * 上限 `take`），零寫入斷言之射程不縮、不弱化。
 * 本模組亦**零日誌、零稽核寫入**（§16 D6-3=(a)：清理不寫稽核）。
 *
 * ---------------------------------------------------------------------------
 * 為什麼「引用」是這四項而不是 BE-US-25⑥ 字面的四類（D4=(a) 之依據）
 * ---------------------------------------------------------------------------
 * BE-US-25⑥ 逐字為「被草稿、已完成申請、報表或稽核資料引用 → 不得刪除」，但
 * **現行資料層的形式與該敘述不對應**（T3 三式獨立實查：Prisma DMMF ＋
 * `information_schema` ＋ `schema.prisma` 文字）：
 *
 *   · `schema.prisma` 全案**無任何外鍵指向 `Attachment`**。引用是**弱引用且
 *     方向相反**——`Attachment.refType`／`refId` 指向容器，不是容器指向附件。
 *     故「草稿／已完成申請引用附件」在資料層的實際形式，就是本檔的
 *     `status` ＋ `refType`／`refId` 容器存在性兩面。
 *   · `Report`／`VoidedReportFile` **零 `attachmentId` 欄位**——報表 PDF 是把
 *     影像**位元組內嵌**進檔案，不保留對附件列的引用。故「報表引用附件」在資料
 *     層**不存在**，結構性不構成引用。此判斷不是靠人記得，而是由 AC-03(b) 的
 *     列舉守門背書：任一表日後新增指向附件的欄位，守門即紅。
 *   · 「稽核資料引用」只可能以 `AuditLog.summary` 的 JSON 內容形式存在。T3 首步
 *     實查全部 17 處 `summary` 組裝站點，**無任一處寫入 attachment id**（此為
 *     決定性證據）；**測試庫 `app_test`**（非 compose 之 dev DB `oilexpense`；
 *     T4R-DOC／NF-1 正名）136 筆稽核 × 97 筆附件之 jsonb 抽查命中 0，屬佐證。
 *     故 §19 `SPEC-011-GATE` 的
 *     **D4 條件式升級授權未觸發**，判定維持 (a)：不查稽核面（記載型 `it` 與
 *     稽核站點清單哨兵見測試檔）。
 *
 * ---------------------------------------------------------------------------
 * 孤兒弱引用（B-04）
 * ---------------------------------------------------------------------------
 * `refType`／`refId` 非 null 但容器已不存在者，**視為無引用**（可刪）——與
 * `lifecycle-service.ts` 之 `deriveContainerState` 對同一情境的既有處置一致
 * （該處 log 後視為 draft）。容器不存在＝沒有任何活體實體會再用到這個附件。
 */

import type { AttachmentRefType } from "@prisma/client";
import type { HasReferenceQuery, PrismaTxLike } from "./lifecycle-service.js";
import { isEligibleForCleanup } from "./lifecycle-service.js";

// ---------------------------------------------------------------------------
// AC-03(a) — 封閉來源集宣告
// ---------------------------------------------------------------------------

/** 引用來源之穩定鍵。新增一種來源＝同批更新此聯集型別與下方常數。 */
export type ReferenceSourceKey =
  | "ATTACHMENT_STATUS_LINKED"
  | "TRIP_SEGMENT_CONTAINER"
  | "MAINTENANCE_APPLICATION_CONTAINER"
  | "DEPRECIATION_APPLICATION_CONTAINER";

export interface ReferenceSourceDeclaration {
  /** 判定輸出（`ReferenceCheck.source`）所用之穩定鍵。 */
  readonly key: ReferenceSourceKey;
  /**
   * 本來源實際查詢之 Prisma delegate 名。
   * 這一欄是 AC-03(a) 機械斷言的比對基礎：測試會掃描本檔實際觸及的 delegate
   * 集合，與本常數宣告的集合做 `toEqual`——實作偷查第五個來源即紅。
   */
  readonly prismaModel: "attachment" | "tripSegment" | "application";
  readonly description: string;
}

/**
 * **封閉宣告清單**（AC-03(a)）：`hasReference` 判定所查詢的引用來源，恰為以下
 * 四項，不多不少。
 *
 * 完整性由 AC-03(b) 的資料層列舉守門背書（`ATTACHMENT_INBOUND_REFERENCE_FIELDS`
 * 之註解說明其形狀）；順序即判定輸出 `checks[]` 的順序（實作以 `map` 於本常數
 * 之上產生 `checks`，故兩者恆同序、不可能漂移）。
 */
export const ATTACHMENT_REFERENCE_SOURCES: readonly ReferenceSourceDeclaration[] = [
  {
    key: "ATTACHMENT_STATUS_LINKED",
    prismaModel: "attachment",
    description:
      "附件自身狀態：status=LINKED 代表已被容器持有，恆受保護（不論多舊）。" +
      "候選列舉本身即以 status 為條件，故此面之查詢與列舉共用同一個 delegate。",
  },
  {
    key: "TRIP_SEGMENT_CONTAINER",
    prismaModel: "tripSegment",
    description:
      "refType=TRIP_SEGMENT 時，refId 所指 TripSegment 之存在性（差旅草稿／" +
      "已完成申請之附件容器）。不存在＝孤兒弱引用（B-04），視為無引用。",
  },
  {
    key: "MAINTENANCE_APPLICATION_CONTAINER",
    prismaModel: "application",
    description:
      "refType=MAINTENANCE 時，refId 即 Application.id（§16 D2(a)：保養容器不經" +
      "子表 id 中轉），查其存在性。",
  },
  {
    key: "DEPRECIATION_APPLICATION_CONTAINER",
    prismaModel: "application",
    description:
      "refType=DEPRECIATION 時，refId 即 Application.id（同上，折舊容器亦以" +
      "Application.id 為 refId），查其存在性。",
  },
];

// ---------------------------------------------------------------------------
// AC-03(b) — 資料層「指向附件之欄位」封閉宣告
// ---------------------------------------------------------------------------

export interface AttachmentInboundField {
  readonly model: string;
  readonly field: string;
}

/**
 * **今日資料層中「指向 `Attachment`」之欄位清單——實查為空集**。
 *
 * 「指向」的定義（與測試之列舉器逐字一致）：①型別為 `Attachment` **且持有外鍵**
 * 的關聯欄位（DMMF `relationFromFields` 非空）②`Attachment` 以外之 model 上、
 * 欄名含 `attachment` 的 scalar 欄位。
 *
 * 空集之三式實證（PHASE-011-T3）：
 *   · **DMMF**：全 17 個 model 中型別為 `Attachment` 的欄位恰 2 條
 *     （`User.attachmentsAsUploader`／`User.attachmentsAsOwner`），兩條
 *     `relationFromFields` 皆為 `[]`＝**反向端**（真正持有外鍵的是
 *     `Attachment.uploaderId`／`ownerId`，方向是附件→使用者）；
 *   · **`information_schema`**：指向 `Attachment` 表的外鍵列舉為空；
 *   · **`schema.prisma` 文字**：`Report`／`VoidedReportFile` 零 `attachmentId`
 *     欄位（報表 PDF 內嵌位元組，不保留引用）。
 *
 * 這份清單為空，正是 `ATTACHMENT_REFERENCE_SOURCES` 只需查「附件自身狀態 ＋
 * 容器存在性」的理由。**日後任一表新增指向附件的欄位而未同批更新本清單，
 * AC-03(b) 之列舉守門即紅**——這是防止「宣告封閉但事實不封閉」的機械保險。
 */
export const ATTACHMENT_INBOUND_REFERENCE_FIELDS: readonly AttachmentInboundField[] = [];

// ---------------------------------------------------------------------------
// 判定：evaluateAttachmentReference（AC-03(a)(d)）
// ---------------------------------------------------------------------------

export interface ReferenceCheck {
  readonly source: ReferenceSourceKey;
  readonly referenced: boolean;
}

export interface ReferenceVerdict {
  /** 任一來源為 true 即為 true（保護優先）。 */
  readonly hasReference: boolean;
  /** 逐項結果，順序恆等於 `ATTACHMENT_REFERENCE_SOURCES`（AC-04(b) 之「依據」）。 */
  readonly checks: readonly ReferenceCheck[];
}

/** 判定所需之附件欄位（刻意只取這四欄：不讀 storageKey／檔名／擁有人）。 */
export interface ReferenceSubject {
  readonly id: string;
  readonly status: string;
  readonly refType: AttachmentRefType | null;
  readonly refId: string | null;
}

/**
 * 判定單一附件是否被任何活體實體引用（AC-03）。
 *
 * **對 DB 只讀**。回傳逐項結果而不只是布林值——dry-run 的候選清單要能讓維運
 * 人員看見「為什麼判定為可刪」（AC-04(b)），而不是要他相信一個布林值。
 */
export async function evaluateAttachmentReference(
  prisma: PrismaTxLike,
  subject: ReferenceSubject
): Promise<ReferenceVerdict> {
  const linkedByStatus = subject.status === "LINKED";

  const tripSegmentContainerExists =
    subject.refType === "TRIP_SEGMENT" && subject.refId !== null
      ? (await prisma.tripSegment.findUnique({
          where: { id: subject.refId },
          select: { id: true },
        })) !== null
      : false;

  const maintenanceContainerExists =
    subject.refType === "MAINTENANCE" && subject.refId !== null
      ? (await prisma.application.findUnique({
          where: { id: subject.refId },
          select: { id: true },
        })) !== null
      : false;

  const depreciationContainerExists =
    subject.refType === "DEPRECIATION" && subject.refId !== null
      ? (await prisma.application.findUnique({
          where: { id: subject.refId },
          select: { id: true },
        })) !== null
      : false;

  // 逐項結果以 `map` 生成於封閉常數之上：來源集合、順序與判定輸出因此是同一份
  // 事實，不可能出現「常數宣告四項但實作只回三項」的漂移（AC-03(a)）。
  const referencedBySource: Readonly<Record<ReferenceSourceKey, boolean>> = {
    ATTACHMENT_STATUS_LINKED: linkedByStatus,
    TRIP_SEGMENT_CONTAINER: tripSegmentContainerExists,
    MAINTENANCE_APPLICATION_CONTAINER: maintenanceContainerExists,
    DEPRECIATION_APPLICATION_CONTAINER: depreciationContainerExists,
  };
  const checks: ReferenceCheck[] = ATTACHMENT_REFERENCE_SOURCES.map((source) => ({
    source: source.key,
    referenced: referencedBySource[source.key],
  }));

  return { hasReference: checks.some((check) => check.referenced), checks };
}

/**
 * `HasReferenceQuery`（`lifecycle-service.ts` :134 之介面契約）之具體實作。
 *
 * 該介面只收 `attachmentId`，故本實作先讀回判定所需的四個欄位再委派給
 * `evaluateAttachmentReference`——判定邏輯只有一份。
 *
 * 附件列已不存在 → `false`：沒有列就沒有東西被引用（呼叫端據此判定「無引用」，
 * 而 `isEligibleForCleanup` 仍會以 status／TTL 決定是否可刪）。
 */
export function createHasReferenceQuery(prisma: PrismaTxLike): HasReferenceQuery {
  return {
    hasReference: async (attachmentId: string): Promise<boolean> => {
      const row = await prisma.attachment.findUnique({
        where: { id: attachmentId },
        select: { id: true, status: true, refType: true, refId: true },
      });
      if (row === null) return false;
      const verdict = await evaluateAttachmentReference(prisma, row);
      return verdict.hasReference;
    },
  };
}

// ---------------------------------------------------------------------------
// 清理候選：planCleanup（AC-04(c) 之「同一判定路徑」）／dryRunCleanup（AC-04）
// ---------------------------------------------------------------------------

/**
 * 一筆清理候選。**欄位刻意封閉**（AC-04(b)）：不含 `storageKey`／
 * `thumbnailKey`／`originalFilename`／`ownerId`／`uploaderId`——候選清單會被
 * 印到維運終端與排程日誌，沿 `DATA_FLOW.md` :565③ 之日誌禁字紀律，這些值一律
 * 不外露（T4 的實刪路徑自己去讀 storage key，不經由這份清單）。
 */
export interface CleanupCandidate {
  readonly id: string;
  readonly status: string;
  readonly createdAt: Date;
  /** 已逾期時數 ＝（now − createdAt）之小時數 − TTL；四捨五入至小數 2 位。 */
  readonly overdueHours: number;
  /** 判定為「無引用」之逐項依據（AC-04(b)）。 */
  readonly referenceChecks: readonly ReferenceCheck[];
}

export interface CleanupPlanOptions {
  /** 注入之「現在」——注入而非 `new Date()`，使判定與輸出完全決定性。 */
  readonly now: Date;
  /** TTL 門檻（小時），來自 env `ATTACHMENT_TEMP_TTL_HOURS`（預設 24）。 */
  readonly ttlHours: number;
  /**
   * 單次批次上限（AC-06(b)／§16 **D6-1**=(a)），來自 env
   * `ATTACHMENT_CLEANUP_BATCH_LIMIT`（預設 {@link DEFAULT_CLEANUP_BATCH_LIMIT}）。
   * 省略時仍套用預設值——**本模組沒有「無上限」模式**（§10 N-1：清理程序不得
   * 將全表讀入記憶體）。
   */
  readonly limit?: number;
}

export interface CleanupPlan {
  /**
   * 本次**掃描筆數**＝實際讀入的 `status=TEMP` 列數（受批次上限封頂，故此值
   * 恆 ≤ `limit`；不是全表 TEMP 總數）。
   */
  readonly scannedCount: number;
  /**
   * 掃描量已達批次上限 ⇒ **可能**仍有未掃描之 TEMP 列留待下次執行
   * （AC-06(b)／B-07 之「尚有剩餘」）。恰好等於上限而其實已無剩餘時本旗標仍
   * 為 `true`——刻意偏保守：多跑一次的成本遠低於漏掉一批。
   */
  readonly hasMore: boolean;
  readonly candidates: readonly CleanupCandidate[];
}

/**
 * 批次上限之預設值（§8.2：env `ATTACHMENT_CLEANUP_BATCH_LIMIT` 預設 `500`）。
 *
 * 與 `config/env.ts` 之 `.default(500)` 是同一個數，兩處由
 * `phase11-attachment-cleanup.test.ts` 之機械斷言釘在一起（其一改動而另一未改
 * 即紅），故此處刻意不 import env——本模組維持零設定相依的純判定定位。
 */
export const DEFAULT_CLEANUP_BATCH_LIMIT = 500;

function computeOverdueHours(createdAt: Date, now: Date, ttlHours: number): number {
  const elapsedHours = (now.getTime() - createdAt.getTime()) / (60 * 60 * 1000);
  return Math.round((elapsedHours - ttlHours) * 100) / 100;
}

/**
 * 產生清理候選清單——**dry-run 與 T4 實跑共用的唯一判定路徑**（AC-04(c)）。
 *
 * 只讀。`LINKED` 附件連掃描都不進入（`where: { status: "TEMP" }`），其保護另由
 * `isEligibleForCleanup` 的 `LINKED → false` 分支與本檔 `ATTACHMENT_STATUS_LINKED`
 * 來源雙重承載。TTL 比較一律委派既有純函式 `isEligibleForCleanup`（**嚴格大於**，
 * `lifecycle-service.ts` :352），本檔不自行實作第二套時間判斷。
 *
 * 排序 `createdAt` → `id`：最舊者優先，且在時間相同時仍全序，使輸出冪等
 * （AC-04(d)）。
 *
 * **批次上限（PHASE-011-T4；T3 交接①）**：`take` 加在**這裡**，不另建第二條
 * 列舉路徑——否則 AC-04(c)「dry-run 與實跑共用同一判定路徑」的結構前提就破了
 * （實跑會有自己的一份 `where`／`orderBy`，兩份遲早漂移）。因為排序已是
 * `createdAt, id` 全序，加上 `take` 後**冪等仍成立**（AC-04(d)）：同一份資料
 * 與同一個 `now` 恆取到同一批列、同一個順序。
 */
export async function planCleanup(
  prisma: PrismaTxLike,
  options: CleanupPlanOptions
): Promise<CleanupPlan> {
  const take = options.limit ?? DEFAULT_CLEANUP_BATCH_LIMIT;
  const rows = await prisma.attachment.findMany({
    where: { status: "TEMP" },
    select: { id: true, status: true, createdAt: true, refType: true, refId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
  });

  const candidates: CleanupCandidate[] = [];
  for (const row of rows) {
    const verdict = await evaluateAttachmentReference(prisma, row);
    if (!isEligibleForCleanup(row, options.now, verdict.hasReference, options.ttlHours)) {
      continue;
    }
    candidates.push({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      overdueHours: computeOverdueHours(row.createdAt, options.now, options.ttlHours),
      referenceChecks: verdict.checks,
    });
  }

  return { scannedCount: rows.length, hasMore: rows.length >= take, candidates };
}

export interface CleanupDryRunReport {
  /** 恆為 `true`——這份報表的產生路徑不具備任何寫入能力。 */
  readonly dryRun: true;
  readonly scannedCount: number;
  readonly candidateCount: number;
  readonly candidates: readonly CleanupCandidate[];
}

/**
 * Dry-run：列出候選但**不刪任何東西**（AC-04(a)）。
 *
 * 本函式刻意**不自帶任何判定**——整段主體只是委派 `planCleanup` 再包一層計數。
 * 它連 `Storage` 都不收：storage 零刪除不是靠自律，而是這條路徑根本沒有拿到
 * storage 控制代碼（AC-04(a) 之 storage 面因此是結構性成立，測試的前後鍵集
 * 全等只是把它再釘一次）。
 */
export async function dryRunCleanup(
  prisma: PrismaTxLike,
  options: CleanupPlanOptions
): Promise<CleanupDryRunReport> {
  const plan = await planCleanup(prisma, options);
  return {
    dryRun: true,
    scannedCount: plan.scannedCount,
    candidateCount: plan.candidates.length,
    candidates: plan.candidates,
  };
}
