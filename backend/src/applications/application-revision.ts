/**
 * Application revision (修正版) copy service — PHASE-009-T5
 *
 * Spec §2 AC-09/AC-10/AC-11、§3.2「建立修正版」、§7.4「修正版欄位複製對照表
 * （**唯一事實來源**）」、§8.1（`supersedesId @unique` 自關聯）。
 *
 * 職責邊界（本 Task 之 Files Allowed 明示）：
 *   · **本檔**：三型業務欄位之逐欄複製（純函式建構器）＋ 單一交易之建立流程
 *     ＋ 版本關聯（`supersedesId`）寫入 ＋ 原申請零改動。
 *   · **T6**（Files Forbidden）：附件位元組複製（§3.2 步驟 6d）——接點見下方
 *     `OnApplicationRevisionCreated` 之文件註解。
 *   · **T7**（Files Forbidden）：`POST /applications/:id/revision` 端點、
 *     授權（401/403/404）、代操作稽核（AC-26(b)）、AC-12 之雙向版本關聯
 *     DTO、AC-13 之三種 409 端點回應形狀。
 *   · **T9/T12**（Files Forbidden）：修正版之報表編號與 PDF。
 *
 * ── 為何「逐欄複製」寫成三個純函式建構器 ────────────────────────────────
 * §7.4 是唯一事實來源，AC-10 要求「複製鍵集與禁複製鍵集 `toEqual` 封閉（多
 * 複製一欄必紅）」。把「哪些欄位被複製」收斂成三個零 DB、零時鐘的純函式，
 * 使該封閉性可在 unit 層（`test/unit/revision-copy.test.ts`）以鍵集斷言直接
 * 鑑別，而不必倚賴 DB 往返；`createApplicationRevision` 只負責讀取來源、開
 * 交易、把建構器的輸出交給 Prisma。禁複製欄位不是「寫入後再清成 null」——
 * 建構結果裡**根本沒有那些鍵**，故新列之對應欄位由 schema 預設保持 `NULL`。
 *
 * ── 既有 `create*Draft` 零改變（T5 Done When 明文）──────────────────────
 * 本檔**不**呼叫也**不**修改 `createTravelDraft`／`createMaintenanceDraft`／
 * `createDepreciationDraft`：那三者的入參是「使用者提交之草稿欄位」，而修正
 * 版的入參是「另一筆已完成申請之現有列」，且修正版必須在**同一交易**內一併
 * 寫入 `supersedesId` 與（差旅）多段 `TripSegment`——三個既有函式皆無此形
 * 狀。硬要複用會被迫改動它們的簽章，恰為 Done When 所禁止。本檔**複用**的
 * 是三型 `primaryDate` 推導之既有純函式（`derivePrimaryDate`／
 * `deriveDepreciationPrimaryDate`），AC-09 之「依既有 `derive*PrimaryDate`
 * 規則推導」由此逐字成立，不另寫第二套日期規則。因此
 * `travel-service.ts`／`maintenance-service.ts`／`depreciation-service.ts`
 * 三檔於本 Task **零 diff**（雖列於 Files Allowed，實查不需擴充）。
 *
 * ── 併發與鎖（Packet FW-4，B-08 同族）──────────────────────────────────
 * 交易第一個陳述式為對**原申請**列之 `SELECT ... FOR UPDATE`（沿
 * `application-void.ts`／`updateTravelDraft` 既有慣例）。原申請本身**零寫
 * 入**——`FOR UPDATE` 取的是列鎖，不修改任何欄位、不觸發 `@updatedAt`，故
 * AC-11(a)「原列不得被 touch」不受影響（已由 AC-11(a) 之 `updatedAt` 毫秒級
 * 斷言實證）。取鎖的理由有二，皆為讀取後判斷之競態，不是為了寫原列：
 *   1. **重複修正版**（D7／B-19）：`supersededBy` 之「是否已存在」為讀後
 *      寫，兩個併發呼叫若無鎖會雙雙讀到「無修正版」而各建一筆，最後由
 *      `supersedesId @unique` 讓後手拋 P2002——一個 DB 層唯一鍵違反，其
 *      HTTP 語意（應為 409 ＋ `details.existingRevisionId`）需在端點層另行
 *      辨識。取鎖後後手必見到前手已提交之修正版，確定性地走本檔既有的 409
 *      分支，`@unique` 退居最後防線。
 *   2. **複製期間原申請被作廢**（狀態競態）：`voidApplication` 亦以
 *      `FOR UPDATE` 鎖同一列，兩者因而互斥——不會出現「以 COMPLETED 讀出、
 *      複製到一半原申請變成 VOIDED」的中間態。
 * **不**使用 SERIALIZABLE（沿 `application-void.ts` 之同一裁量）：本交易只
 * 讀單一原申請列、寫入全新的列，READ COMMITTED 下的列鎖加上鎖後新鮮讀取即
 * 為收斂點，無讀後寫的跨列不變式需要謂詞鎖，也就沒有重試迴圈的必要。
 */
import type { ApplicationStatus, ApplicationType, PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { AppError } from "../platform/errors.js";
import { deriveDepreciationPrimaryDate } from "./depreciation-service.js";
import { derivePrimaryDate } from "./travel-service.js";

// ---------------------------------------------------------------------------
// 來源形狀（只列建構器實際讀取之欄位——「沒讀到的欄位不可能被複製」）
// ---------------------------------------------------------------------------

/** 三型共通之來源欄位：§7.4「共通 `Application`」列之複製來源。 */
interface RevisionSourceCommon {
  /** 原申請 id —— 寫入新列之 `supersedesId`（§7.4：非「複製而來」，是關聯）。 */
  id: string;
  /** 原申請之擁有人 —— 管理員代建時亦沿用（AC-09 明文）。 */
  ownerId: string;
}

/** §7.4「差旅」列之複製來源（含每段之五個業務欄位）。 */
export interface TravelRevisionSource extends RevisionSourceCommon {
  tripDate: Date | null;
  purpose: string | null;
  /** 呼叫端須以 `orderBy: { sortOrder: "asc" }` 讀取（Postgres 不保證順序）。 */
  segments: Array<{
    sortOrder: number;
    origin: string | null;
    destination: string | null;
    totalKm: Prisma.Decimal | null;
    highwayKm: Prisma.Decimal | null;
  }>;
}

/** §7.4「保養」列之複製來源。 */
export interface MaintenanceRevisionSource extends RevisionSourceCommon {
  lastMaintenanceDate: Date | null;
  currentMaintenanceDate: Date | null;
  lastOdometerKm: Prisma.Decimal | null;
  currentOdometerKm: Prisma.Decimal | null;
  actualCost: Prisma.Decimal | null;
}

/** §7.4「折舊」列之複製來源。 */
export interface DepreciationRevisionSource extends RevisionSourceCommon {
  applicationYear: number | null;
  annualTotalKm: Prisma.Decimal | null;
}

// ---------------------------------------------------------------------------
// 建構結果形狀
// ---------------------------------------------------------------------------

/**
 * 三型共通之 `Application` 層建構結果。鍵集恰六個——`totalAmount`／
 * `completedAt`／`voidReason`／`voidedAt`／`voidedById` **不在其中**（AC-09：
 * 恆 `NULL`，由 schema 預設達成，非寫入後再清空）。
 */
interface ApplicationRevisionCommonData {
  type: ApplicationType;
  status: "DRAFT";
  ownerId: string;
  /** §7.4：＝**操作者**，非原建立者。 */
  createdById: string;
  /** §7.4：**重新推導**（不直接複製原 `primaryDate`）。 */
  primaryDate: Date;
  /** §7.4：＝原申請 id（非複製而來）。 */
  supersedesId: string;
}

/** 段建構結果——鍵集恰五個，四個段快照欄不在其中（AC-10：新段恆 `NULL`）。 */
export interface TripSegmentRevisionData {
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  totalKm: Prisma.Decimal | null;
  highwayKm: Prisma.Decimal | null;
}

export interface TravelRevisionData extends ApplicationRevisionCommonData {
  travel: {
    create: {
      tripDate: Date | null;
      purpose: string | null;
      segments: { create: TripSegmentRevisionData[] };
    };
  };
}

export interface MaintenanceRevisionData extends ApplicationRevisionCommonData {
  maintenance: {
    create: {
      lastMaintenanceDate: Date | null;
      currentMaintenanceDate: Date | null;
      lastOdometerKm: Prisma.Decimal | null;
      currentOdometerKm: Prisma.Decimal | null;
      actualCost: Prisma.Decimal | null;
    };
  };
}

export interface DepreciationRevisionData extends ApplicationRevisionCommonData {
  depreciation: {
    create: {
      applicationYear: number | null;
      annualTotalKm: Prisma.Decimal | null;
    };
  };
}

// ---------------------------------------------------------------------------
// 純函式建構器（AC-10 之鍵集封閉性在此收斂；零 DB、零時鐘）
// ---------------------------------------------------------------------------

function buildCommonData(
  type: ApplicationType,
  source: RevisionSourceCommon,
  actorId: string,
  primaryDate: Date
): ApplicationRevisionCommonData {
  return {
    type,
    status: "DRAFT",
    ownerId: source.ownerId,
    createdById: actorId,
    primaryDate,
    supersedesId: source.id,
  };
}

/**
 * 差旅修正版之建立資料（§7.4「差旅」列）。
 *
 * @param now `primaryDate` 之 fallback 基準（`tripDate` 為 `null` 時取其 UTC
 *   日粒度，沿 `derivePrimaryDate` 既有規則）。由呼叫端注入以維持純函式性。
 */
export function buildTravelRevisionData(
  source: TravelRevisionSource,
  actorId: string,
  now: Date
): TravelRevisionData {
  return {
    ...buildCommonData("TRAVEL", source, actorId, derivePrimaryDate(source.tripDate, now)),
    travel: {
      create: {
        tripDate: source.tripDate,
        purpose: source.purpose,
        segments: {
          // 原序保存：`sortOrder` 原樣複製（呼叫端已以 sortOrder asc 讀取，
          // 故陣列順序亦與原序一致——兩者皆保序，不倚賴其中單一者）。
          create: source.segments.map((segment) => ({
            sortOrder: segment.sortOrder,
            origin: segment.origin,
            destination: segment.destination,
            totalKm: segment.totalKm,
            highwayKm: segment.highwayKm,
          })),
        },
      },
    },
  };
}

/** 保養修正版之建立資料（§7.4「保養」列）。 */
export function buildMaintenanceRevisionData(
  source: MaintenanceRevisionSource,
  actorId: string,
  now: Date
): MaintenanceRevisionData {
  return {
    ...buildCommonData(
      "MAINTENANCE",
      source,
      actorId,
      // 保養之 `primaryDate` 權威為 `currentMaintenanceDate`（沿
      // `createMaintenanceDraft`／`updateMaintenanceDraft` 既有呼叫形狀）。
      derivePrimaryDate(source.currentMaintenanceDate, now)
    ),
    maintenance: {
      create: {
        lastMaintenanceDate: source.lastMaintenanceDate,
        currentMaintenanceDate: source.currentMaintenanceDate,
        lastOdometerKm: source.lastOdometerKm,
        currentOdometerKm: source.currentOdometerKm,
        actualCost: source.actualCost,
      },
    },
  };
}

/** 折舊修正版之建立資料（§7.4「折舊」列）。 */
export function buildDepreciationRevisionData(
  source: DepreciationRevisionSource,
  actorId: string,
  now: Date
): DepreciationRevisionData {
  return {
    ...buildCommonData(
      "DEPRECIATION",
      source,
      actorId,
      deriveDepreciationPrimaryDate(source.applicationYear, now)
    ),
    depreciation: {
      create: {
        applicationYear: source.applicationYear,
        annualTotalKm: source.annualTotalKm,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// createApplicationRevision（§3.2 步驟 4~6）
// ---------------------------------------------------------------------------

/**
 * PHASE-009-T6（沿 PHASE-008 T8R2 MF-2 之先例與推導方式）：Prisma 互動式交易
 * 不明寫 `timeout`／`maxWait` 時套用套件預設（`timeout` 5000ms、`maxWait`
 * 2000ms）。T5 當時交易內只有三次毫秒級 DB 往返，預設綽綽有餘；T6 之後
 * `onCreated` hook 於**同一交易內**執行附件位元組複製（§3.2 步驟 6d），交易
 * 時長改由 storage I/O 主導：
 *
 *   最壞情形 ＝ 段數 × 每段附件上限（差旅 3／保養 5／折舊 5）× 每檔
 *   `ATTACHMENT_MAX_BYTES`（預設 10 MiB）× 2（原檔 ＋ 縮圖）× 2（讀 ＋ 寫）。
 *   例：10 段 × 3 張 ＝ 30 檔 → 最壞約 1.2 GiB 之循序 I/O，於 50 MiB/s 之
 *   受管磁碟約 24 秒——遠超 5000ms 預設，會在複製中途被 Prisma 自身之交易逾
 *   時搶先中止（P2028），使一個「其實只是慢」的正常請求變成 500。
 *
 * 故此處明寫兩值。**不新增 env 變數**（沿 T8R2 之同一裁量：交易裕度不對外
 * 開放調整），亦不由 `ATTACHMENT_MAX_BYTES` 推導——位元組數換算成時間需先假
 * 定一個吞吐率常數，那個常數本身同樣是拍板值，多一層推導只是把同一個裁量藏
 * 起來。`maxWait` 僅涵蓋「取得連線、交易正式開始前」之排隊等待，與複製量無
 * 關，故取較小值。
 *
 * 逾時仍發生時之語意不變：交易回滾，已寫入之新 storage key 由
 * `attachment-copy.ts` 之補償刪除回收（AC-14(e) 之零殘留對此路徑同樣成立）。
 */
const REVISION_TX_TIMEOUT_MS = 60_000;
const REVISION_TX_MAX_WAIT_MS = 10_000;

/** 修正版建立後之最小列——僅本函式實際寫入之欄位，供呼叫端（T7）組回應與稽核摘要。 */
export interface ApplicationRevisionRow {
  id: string;
  type: ApplicationType;
  status: ApplicationStatus;
  ownerId: string;
  createdById: string;
  primaryDate: Date;
  supersedesId: string;
}

/**
 * 修正版建立後（新列已寫入、尚未提交）之 hook，於**同一交易**內執行——沿
 * `OnTravelDraftCreated`／`OnApplicationVoided` 既有形狀。hook 拋錯會使整筆
 * 交易（含新 `Application`／子列／段落）一併回滾。省略時為 no-op。
 *
 * 兩個後續 Task 之接點（皆為 Files Forbidden，本 Task 不實作）：
 *   · **T6**（AC-14，§3.2 步驟 6d）：附件位元組複製須在同一交易內、於本 hook
 *     之前或以本 hook 掛入；storage 補償刪除之責任在 T6。
 *   · **T7**（AC-26(b)，§3.2 步驟 6e）：管理員代建時寫入
 *     `AuditLog(APPLICATION_CREATED_ON_BEHALF, summary.revisionOf)`；本人建
 *     立時**不**傳入 hook，天生零稽核（AC-26(c)）。
 */
export type OnApplicationRevisionCreated = (
  tx: Prisma.TransactionClient,
  source: { id: string; type: ApplicationType; ownerId: string; ownerLoginName: string },
  revision: ApplicationRevisionRow
) => Promise<void>;

const revisionSourceSelect = {
  id: true,
  type: true,
  status: true,
  ownerId: true,
  owner: { select: { loginName: true } },
  supersededBy: { select: { id: true } },
  travel: {
    select: {
      tripDate: true,
      purpose: true,
      segments: {
        // FW-1①：Postgres 不保證列順序，段序必須顯式指定（≥2 段時缺此即偶紅）。
        orderBy: { sortOrder: "asc" as const },
        select: {
          sortOrder: true,
          origin: true,
          destination: true,
          totalKm: true,
          highwayKm: true,
        },
      },
    },
  },
  maintenance: {
    select: {
      lastMaintenanceDate: true,
      currentMaintenanceDate: true,
      lastOdometerKm: true,
      currentOdometerKm: true,
      actualCost: true,
    },
  },
  depreciation: {
    select: { applicationYear: true, annualTotalKm: true },
  },
} satisfies Prisma.ApplicationSelect;

/**
 * 對一筆**已完成**申請建立修正版（AC-09/AC-10/AC-11）。
 *
 * @param prisma 頂層 `PrismaClient`（本函式自行開交易，沿
 *   `voidApplication`／`completeTravelApplication` 之既有分工）。
 * @param sourceId 原申請 id。不存在時由 `findUniqueOrThrow` 拋出——404 之轉譯
 *   與存在性預檢是 `routes.ts`（T7）的責任。
 * @param actorId 實際操作者 id（本人或代建之管理員）——寫入新列之
 *   `createdById`。本函式**不做任何授權判斷**（呼叫端已完成）。
 * @param onCreated 選填 hook，見 `OnApplicationRevisionCreated`（T6／T7 用）。
 *
 * 原申請**零寫入**：本函式對原申請只有一次 `FOR UPDATE` 列鎖與一次
 * `findUniqueOrThrow` 讀取，程式碼中沒有任何以原申請 id 為目標的 `update`／
 * `delete` 路徑——AC-11 由此天然成立，非靠額外的「不要動它」判斷。
 */
export async function createApplicationRevision(
  prisma: PrismaClient,
  sourceId: string,
  actorId: string,
  onCreated?: OnApplicationRevisionCreated
): Promise<ApplicationRevisionRow> {
  return prisma.$transaction(
    async (tx) => {
      // §3.2 步驟 6 之交易；第一個陳述式為列鎖（見檔頭「併發與鎖」）。
      await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${sourceId} FOR UPDATE`;

      const source = await tx.application.findUniqueOrThrow({
        where: { id: sourceId },
        select: revisionSourceSelect,
      });

      // §3.2 步驟 4：狀態守門（DRAFT／VOIDED 皆拒）。AC-13(a)(b) 之端點層回應
      // 斷言歸 T7，本檔僅確立 service 層之錯誤形狀。
      if (source.status !== "COMPLETED") {
        throw new AppError("CONFLICT", 409, "僅已完成之申請可建立修正版", undefined, {
          status: source.status,
        });
      }

      // §3.2 步驟 5：既有修正版守門〔D7：0..1〕。AC-13(c) 同上歸 T7。
      if (source.supersededBy) {
        throw new AppError("CONFLICT", 409, "此申請已有修正版", undefined, {
          existingRevisionId: source.supersededBy.id,
        });
      }

      // §3.2 步驟 6b/6c：依 type 建構逐欄複製資料（§7.4）並建立新列；
      // `supersedesId` 由建構器一併帶入，與子列同屬單一 `create`（同交易）。
      const now = new Date();
      const data = buildRevisionData(source, actorId, now);

      const created = await tx.application.create({
        data,
        select: {
          id: true,
          type: true,
          status: true,
          ownerId: true,
          createdById: true,
          primaryDate: true,
          supersedesId: true,
        },
      });

      const revision: ApplicationRevisionRow = {
        id: created.id,
        type: created.type,
        status: created.status,
        ownerId: created.ownerId,
        createdById: created.createdById,
        primaryDate: created.primaryDate,
        // `supersedesId` 於建構資料中恆為 `sourceId`；此處以非空斷言換成
        // `string`（回傳型別語意上必非 null），值本身仍取自 DB 回讀。
        supersedesId: created.supersedesId ?? sourceId,
      };

      // §3.2 步驟 6d（T6 附件複製）／6e（T7 代操作稽核）之接點。
      if (onCreated) {
        await onCreated(
          tx,
          {
            id: source.id,
            type: source.type,
            ownerId: source.ownerId,
            ownerLoginName: source.owner.loginName,
          },
          revision
        );
      }

      return revision;
    },
    {
      timeout: REVISION_TX_TIMEOUT_MS,
      maxWait: REVISION_TX_MAX_WAIT_MS,
    }
  );
}

type RevisionSourceRow = Prisma.ApplicationGetPayload<{ select: typeof revisionSourceSelect }>;

/**
 * 依 `type` 分派至三個建構器。子列缺席（資料損毀，理論上不可達——三型建立流
 * 程皆以巢狀 `create` 保證 1:1）時拋 500 而非靜默建立空白修正版：修正版之正
 * 確性屬歷史不可變面，寧可失敗也不得產出殘缺複本。
 */
function buildRevisionData(
  source: RevisionSourceRow,
  actorId: string,
  now: Date
): TravelRevisionData | MaintenanceRevisionData | DepreciationRevisionData {
  const common = { id: source.id, ownerId: source.ownerId };

  switch (source.type) {
    case "TRAVEL": {
      if (!source.travel) throw missingChildRow();
      return buildTravelRevisionData({ ...common, ...source.travel }, actorId, now);
    }
    case "MAINTENANCE": {
      if (!source.maintenance) throw missingChildRow();
      return buildMaintenanceRevisionData({ ...common, ...source.maintenance }, actorId, now);
    }
    case "DEPRECIATION": {
      if (!source.depreciation) throw missingChildRow();
      return buildDepreciationRevisionData({ ...common, ...source.depreciation }, actorId, now);
    }
  }
}

function missingChildRow(): AppError {
  // 訊息不含 id／型別／DB 結構（§7.5「日誌零 storage key」之同型紀律）。
  return new AppError("INTERNAL_ERROR", 500, "系統發生錯誤，請稍後再試。");
}
