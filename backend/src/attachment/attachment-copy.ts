/**
 * Revision attachment copy — PHASE-009-T6
 *
 * Spec `docs/specs/PHASE-009.md`：AC-14（§2 :189）、§3.2 步驟 6d、§7.4「附件」
 * 列、§9.2、§16 **D6=(c)（複製位元組）**。
 *
 * 職責邊界：
 *   · **本檔**：把一筆已完成申請之全部 `LINKED` 附件，於修正版之對應容器複製
 *     成「新列 ＋ 新 `storageKey` ＋ 新縮圖 key」，位元組逐位元組相同；失敗時
 *     補償刪除已寫入之新 key 並讓整筆修正版交易回滾。
 *   · **`application-revision.ts`（T5）**：修正版本體（業務欄位逐欄複製、
 *     `supersedesId`、單一交易與 `FOR UPDATE` 列鎖）。本檔以其既有 hook
 *     `OnApplicationRevisionCreated` 掛入，**不**另開第二個交易。
 *   · **T7**：端點、授權、代操作稽核。本檔之
 *     {@link createApplicationRevisionWithAttachments} 預留 `onCreated` 參數，
 *     讓 T7 之稽核 hook 於**同一交易**內、附件複製**之後**執行。
 *
 * ── 為何新檔而非擴充 `attachment-service.ts`（§15 T6 之兩個選項）────────────
 * `attachment-service.ts` 之 `createAttachment` 只收頂層 `PrismaClient`，而
 * 本流程必須在 T5 交易之 `Prisma.TransactionClient` 上寫入（AC-14(e)「整筆修
 * 正版交易回滾」唯有同一交易成立）；改其簽章會波及 PHASE-003 起的既有呼叫
 * 端。故本檔於交易客戶端上直接 `create`，並就地保有 `LINKED` 不變式
 * （`refType`／`refId` 必給——見 `buildCopyData`，兩者恆由容器對位提供）。
 *
 * ── 為何「先 put 後 insert」而非相反 ──────────────────────────────────────
 * 沿 `upload-service.ts` 之既有順序（§4.4 步驟 6→9）：DB 列一旦存在就必須有
 * 對應位元組，反序會出現「列指向尚未寫成的 key」之中間態。put 失敗時本檔以
 * 補償刪除回收已寫之新 key，DB 則由交易回滾天然清空——兩側零殘留
 * （AC-14(e)）。
 *
 * ── 日誌紀律（AC-14(e)「日誌零 storage key」）─────────────────────────────
 * 本檔**永不**把 `err.message` 寫進日誌：`LocalVolumeStorage` 之錯誤訊息逐字
 * 含 key（例如 `Storage key not found: "att/…/original"`），而
 * `sanitizeForLog` 只遮蔽連線字串與 `password=` 形式之憑證，**不會**遮蔽
 * storage key。故失敗時只記錄「錯誤類別名稱」這類零內容之標籤，並一律改拋
 * 訊息固定之 `AppError("INTERNAL_ERROR", 500, …)`，使原始訊息不會沿著
 * error-handler 之未預期錯誤路徑被記錄或外洩。
 */
import type { AttachmentRefType, PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type {
  ApplicationRevisionRow,
  OnApplicationRevisionCreated,
} from "../applications/application-revision.js";
import { createApplicationRevision } from "../applications/application-revision.js";
import { AppError } from "../platform/errors.js";
import type { Storage } from "../storage/index.js";
import { generateStorageId, generateStorageKeys } from "./upload-service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RevisionAttachmentCopyDeps {
  /** 附件位元組儲存（`att/` 前綴之實例）。 */
  storage: Storage;
  /** 選填日誌接收端；省略時為 no-op（本檔只寫零內容之 warn，見檔頭日誌紀律）。 */
  log?: { warn: (msg: string) => void };
}

/**
 * 附件複製器：一次修正版建立之生命週期物件（**不可重用**——`written` 記錄
 * 的是「本次交易已寫入 storage 的新 key」）。
 */
export interface RevisionAttachmentCopier {
  /** 掛入 `createApplicationRevision` 之 hook，於同一交易內執行。 */
  onRevisionCreated: OnApplicationRevisionCreated;
  /**
   * 補償刪除本次已寫入之全部新 key。冪等：刪除後即自清單移除，重複呼叫為
   * no-op（hook 自身失敗時已自動呼叫過一次，見 `onRevisionCreated`）。
   */
  compensate: () => Promise<void>;
}

/** 原容器 → 新容器之一對一對位（差旅為逐段，保養／折舊為單一容器）。 */
interface ContainerPair {
  refType: AttachmentRefType;
  sourceRefId: string;
  targetRefId: string;
}

// ---------------------------------------------------------------------------
// Copier
// ---------------------------------------------------------------------------

/**
 * 建立一次性的附件複製器。
 *
 * @param actorId 實際操作者 id —— 新列之 `uploaderId`（§7.4「附件」列：
 *   `uploaderId` **不複製**，恆為操作者）。新列之 `ownerId` 則**沿用原附件之
 *   `ownerId`**（AC-14(a)「＝原擁有人」；管理員代建時授權面零變化）。
 */
export function createRevisionAttachmentCopier(
  actorId: string,
  deps: RevisionAttachmentCopyDeps
): RevisionAttachmentCopier {
  const written: string[] = [];

  async function compensate(): Promise<void> {
    // 逐一刪除並自清單移除——即使中途某個 delete 失敗，其餘仍會被嘗試，且
    // 已成功者不會被重複刪除（`LocalVolumeStorage.delete` 本身亦為冪等）。
    while (written.length > 0) {
      const key = written.pop() as string;
      try {
        await deps.storage.delete(key);
      } catch (err) {
        // 不遮蔽原始失敗、也不記錄 key 或錯誤訊息（見檔頭日誌紀律）。
        deps.log?.warn(`修正版附件複製之補償刪除失敗（log-safe）：${errorLabel(err)}`);
      }
    }
  }

  const onRevisionCreated: OnApplicationRevisionCreated = async (tx, source, revision) => {
    try {
      for (const pair of await resolveContainerPairs(tx, source, revision)) {
        await copyContainer(tx, pair, actorId, deps, written);
      }
    } catch (err) {
      // AC-14(e)：先補償刪除已寫之新 key，再讓錯誤往上拋使交易回滾。即使
      // 呼叫端忘了呼叫 `compensate()`，複製自身失敗之路徑仍零殘留。
      await compensate();
      throw toInternalError(err, deps);
    }
  };

  return { onRevisionCreated, compensate };
}

/**
 * 建立修正版並複製其證明附件——production 之單一入口（§9.2 全流程）。
 *
 * 交易語意：附件複製在 `createApplicationRevision` 的**同一個**交易內（經
 * hook），故任一步失敗即整筆回滾；本函式再於外層 catch 補償刪除已寫入之新
 * storage key——涵蓋「複製本身失敗」以外的失敗路徑（`onCreated` 稽核寫入失
 * 敗、commit 失敗），使 §9.2「失敗：回滾 ＋ 新 storage key 補償刪除」對**任
 * 一**失敗路徑成立，而非只對複製步驟成立。
 *
 * @param onCreated 選填之後續 hook（T7 之代操作稽核），於附件複製**之後**、
 *   同一交易內執行。
 */
export async function createApplicationRevisionWithAttachments(
  prisma: PrismaClient,
  sourceId: string,
  actorId: string,
  deps: RevisionAttachmentCopyDeps,
  onCreated?: OnApplicationRevisionCreated
): Promise<ApplicationRevisionRow> {
  const copier = createRevisionAttachmentCopier(actorId, deps);
  try {
    return await createApplicationRevision(prisma, sourceId, actorId, async (tx, src, rev) => {
      await copier.onRevisionCreated(tx, src, rev);
      if (onCreated) await onCreated(tx, src, rev);
    });
  } catch (err) {
    await copier.compensate();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 容器對位（AC-14(c)）
// ---------------------------------------------------------------------------

/**
 * 解析「原容器 → 新容器」之對位清單。
 *
 * 差旅（AC-14(c)）：附件容器是**段**，故兩側各自以
 * `orderBy: { sortOrder: "asc" }` 重查後逐位置配對——`sortOrder` 是段序之唯一
 * 事實來源，Postgres 不保證列的自然順序，缺此排序即可能跨段錯置。兩側段數必
 * 相等（T5 逐段原樣複製 `sortOrder`）；不等即為資料損毀，寧可整筆失敗也不得
 * 把證明附件掛到錯誤的段上。
 *
 * 保養／折舊（§16 D2(a)）：容器即 `Application` 本身（`refId = Application.id`），
 * 對位為單一組。
 */
async function resolveContainerPairs(
  tx: Prisma.TransactionClient,
  source: { id: string; type: string },
  revision: ApplicationRevisionRow
): Promise<ContainerPair[]> {
  if (source.type === "MAINTENANCE" || source.type === "DEPRECIATION") {
    return [{ refType: source.type, sourceRefId: source.id, targetRefId: revision.id }];
  }

  const sourceSegments = await tx.tripSegment.findMany({
    where: { travelApplicationId: source.id },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  const targetSegments = await tx.tripSegment.findMany({
    where: { travelApplicationId: revision.id },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });

  if (sourceSegments.length !== targetSegments.length) {
    throw new AppError("INTERNAL_ERROR", 500, "系統發生錯誤，請稍後再試。");
  }

  return sourceSegments.map((segment, index) => {
    const target = targetSegments[index];
    // 長度已相等，此分支不可達；保留以滿足索引存取之型別安全（不以非空斷言
    // 掩蓋，錯置寧可失敗）。
    if (!target) throw new AppError("INTERNAL_ERROR", 500, "系統發生錯誤，請稍後再試。");
    return {
      refType: "TRIP_SEGMENT" as const,
      sourceRefId: segment.id,
      targetRefId: target.id,
    };
  });
}

// ---------------------------------------------------------------------------
// 單一容器之複製（AC-14(a)(b)(d)）
// ---------------------------------------------------------------------------

/**
 * 複製單一容器之全部 `LINKED` 附件。
 *
 * AC-14(d)（上限仍成立）**無須**額外守門：目標容器是本交易剛建立的全新列
 * （零既有附件），複製為嚴格一對一，故複製後之計數恆等於來源容器之計數，而
 * 來源是一筆已完成申請——其計數在完成時即已通過 `linkAttachmentTx` 之上限檢
 * 查。加一道會拋錯的檢查只會在資料本已違規時把「無法建立修正版」變成新的失
 * 敗模式，不會讓上限更成立；此性質由測試逐型別實證。
 */
async function copyContainer(
  tx: Prisma.TransactionClient,
  pair: ContainerPair,
  actorId: string,
  deps: RevisionAttachmentCopyDeps,
  written: string[]
): Promise<void> {
  const sourceAttachments = await tx.attachment.findMany({
    where: { status: "LINKED", refType: pair.refType, refId: pair.sourceRefId },
    // 決定性順序（同一來源恆產生同一順序之複本），與對位無關但利於除錯。
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      storageKey: true,
      thumbnailKey: true,
      mimeType: true,
      byteSize: true,
      originalFilename: true,
      ownerId: true,
    },
  });

  for (const attachment of sourceAttachments) {
    // 新 key 一律系統產生（與上傳流程同一產生器，故格式與 storage 之 key 白
    // 名單相容），與原 key 結構上互異（AC-14(b)）。
    const { originalKey, thumbKey } = generateStorageKeys(generateStorageId());

    const bytes = await readBytes(deps.storage, attachment.storageKey);
    await deps.storage.put(originalKey, bytes, attachment.mimeType);
    written.push(originalKey);

    let newThumbnailKey: string | null = null;
    if (attachment.thumbnailKey) {
      const thumbBytes = await readBytes(deps.storage, attachment.thumbnailKey);
      await deps.storage.put(thumbKey, thumbBytes, attachment.mimeType);
      written.push(thumbKey);
      newThumbnailKey = thumbKey;
    }

    await tx.attachment.create({
      data: {
        status: "LINKED",
        storageKey: originalKey,
        thumbnailKey: newThumbnailKey,
        // §7.4「附件」列之複製欄位。`byteSize` 取自來源列（記錄面之複製），
        // 其與實際位元組之一致性由來源之上傳流程保證，本檔不重新計算。
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        originalFilename: attachment.originalFilename,
        // AC-14(a)：擁有人沿用原附件（授權面零變化）；上傳者＝實際操作者。
        ownerId: attachment.ownerId,
        uploaderId: actorId,
        refType: pair.refType,
        refId: pair.targetRefId,
        linkedAt: new Date(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `Storage.get` 允許回傳 Buffer 或串流；統一收斂為 Buffer 以便逐位元組複製。 */
async function readBytes(storage: Storage, key: string): Promise<Buffer> {
  const result = await storage.get(key);
  if (Buffer.isBuffer(result)) return result;

  const chunks: Buffer[] = [];
  for await (const chunk of result as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * 零內容之錯誤標籤——只取錯誤的類別名稱，**不含**訊息（storage 錯誤訊息逐字
 * 含 key）。這是本檔唯一允許進入日誌的錯誤資訊。
 */
function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return "UnknownError";
}

/**
 * 把複製過程之任何底層錯誤轉為訊息固定之 500，避免含 storage key 的原始訊息
 * 沿 error-handler 之未預期錯誤路徑被記錄（AC-14(e)「日誌零 storage key」）。
 * 已是 `AppError` 者（本檔自拋之對位不一致）原樣傳遞——其訊息本就固定。
 */
function toInternalError(err: unknown, deps: RevisionAttachmentCopyDeps): AppError {
  if (err instanceof AppError) return err;
  deps.log?.warn(`修正版附件複製失敗（log-safe）：${errorLabel(err)}`);
  return new AppError("INTERNAL_ERROR", 500, "系統發生錯誤，請稍後再試。");
}
