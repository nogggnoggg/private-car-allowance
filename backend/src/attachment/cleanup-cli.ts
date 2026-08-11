/**
 * Attachment cleanup executor ＋ CLI 進入點 — PHASE-011-T4
 *
 * `docs/specs/PHASE-011.md` **AC-05**／**AC-06**；§16 **D3**=(c)（一次性 CLI）、
 * **D6-1**=(a)（批次上限 env 可設、預設 500）、**D6-2**=(a)（有失敗即非零結束
 * 碼）、**D6-3**=(a)（**不寫稽核**，只有結構化日誌 ＋ 摘要）。
 *
 * ---------------------------------------------------------------------------
 * 本檔的一句話定位：**這裡是本專案唯一的不可逆刪除執行器**
 * ---------------------------------------------------------------------------
 * 判準不在這裡。本檔**不重新判斷**任何一筆附件該不該刪，只呼叫
 * `cleanup-service.ts` 的 `planCleanup`（AC-04(c)：dry-run 與實跑共用同一判定
 * 路徑）。這條分工是 FW-2=(i) 的裁定：
 *
 *   · `cleanup-service.ts`＝**純判定、對 DB 零寫入**（其零寫入結構斷言涵蓋
 *     `create`/`update`/`delete`/`deleteMany`/`upsert`/`*AndReturn`/任何
 *     `$…Raw…`，本 Task 未弱化、未縮射程）；
 *   · **本檔**＝唯一持有 DB 寫入與 storage 刪除能力之處。
 *
 * 這樣切的理由不是美學：判準與執行合寫時，「dry-run 看起來安全但實跑走了另一
 * 條 where」永遠可能發生；切開之後，那件事在結構上不可能——實跑若不呼叫
 * `planCleanup` 就一筆候選都拿不到（測試以結構斷言釘住此點）。
 *
 * ---------------------------------------------------------------------------
 * 觸發形式：外部排程 → 一次性 CLI（D3=(c)），恰一條路徑
 * ---------------------------------------------------------------------------
 *   npm run cleanup:attachments -- --dry-run     # 唯讀預覽（啟用前必跑）
 *   npm run cleanup:attachments                   # 實跑（不可逆）
 *
 * 本檔**不被 `server.ts` 匯入、不註冊任何路由、不註冊任何計時器**——刪除能力
 * 因此不常駐於服務行程，也不暴露於 HTTP 面（D3=(c) 之三項理由：不可逆刪除不
 * 宜常駐、結束碼是排程告警的唯一自然介面、零新增授權面）。
 * 「恰一條觸發路徑」由測試的結構斷言守住：全 `backend/src` 中提及本模組的檔案
 * 恰為本檔自身；本檔零排程原語、零路由註冊。
 *
 * **結束碼**（D6-2=(a)，外部排程唯一能自動察覺異常的介面）：
 *   `0` ＝ 全數成功（含「零候選」與 dry-run）；
 *   `1` ＝ 任一筆失敗、設定錯誤、參數錯誤，或行程級致命錯誤。
 *
 * ---------------------------------------------------------------------------
 * 刪除順序與失敗語意（AC-05(c)）
 * ---------------------------------------------------------------------------
 * **DB 列先刪、storage 位元組後刪**，沿 `lifecycle-service.ts` :19-26 之既有
 * TEMP DELETE 語意，不另立第二套：DB 是事實來源，列一旦消失就沒有任何請求路徑
 * 能再取到那個檔；反序則會出現「檔已刪但列還在」的可讀取空洞。
 * storage 刪除失敗**不回滾** DB 刪除（該檔此時已不可達，回滾只會把不可達變成
 * 可達的壞列），但**計入失敗計數**並記一行零內容日誌。
 *
 * ---------------------------------------------------------------------------
 * 日誌紀律（AC-05(c)／AC-06(c)／§10 N-2；PHASE-010-T9 之診斷取捨）
 * ---------------------------------------------------------------------------
 * 每一行日誌只有 `{ stage, attachmentId?, errName? }` 這種**零內容標籤**：
 *   · **不記 `storageKey`／`thumbnailKey`／檔名／擁有人**——候選清單本身就刻意
 *     不含這些欄位，本檔讀 key 只為了呼叫 `storage.delete`，讀完不外流；
 *   · **不記 `err.message`**——`LocalVolumeStorage`／`fs` 的錯誤訊息逐字含
 *     storage key 與絕對路徑（`EPERM … unlink '<root>/att/…'`），而
 *     `sanitizeForLog` 不遮蔽這兩者。故一律只記 `errorLabel(err)`（錯誤類別
 *     名）。這正是 PHASE-010-T9 的裁定：兜底不記例外原文，正解是具名日誌零內容
 *     標籤。本檔因此**不在** `phase10-error-handler-leak.test.ts` 的兩層白名單
 *     內，且不應被加入。
 *
 * ---------------------------------------------------------------------------
 * 保護強度的據實揭露（FW-3／AR-1——人類將據此批准不可逆刪除）
 * ---------------------------------------------------------------------------
 * T3 即審已查明：**現行寫入路徑下，`status=TEMP` 的附件其 `refType`／`refId`
 * 恆為 `null`**（上傳時不帶 ref；detach 時 `detachFieldSet` 一併清空並重設
 * `createdAt`；dev DB 零反例）。因此**日常實際生效的判準只有兩條**：
 *
 *     status = TEMP  ∧  now − createdAt  嚴格大於  TTL
 *
 * `ATTACHMENT_REFERENCE_SOURCES` 的三條「容器存在性」來源在今日資料下**恆為
 * false**，它們是**防禦縱深**（日後若有人寫出「TEMP 仍保留 ref」的路徑，保護
 * 立即生效），不是今天擋在最前面的那道防線。測試中「TEMP 但有引用 → 不得刪」
 * 的逐型格，其資料**刻意違反上述不變式**（合成資料），這一點在測試檔內逐格標
 * 注——不標注就會讓人誤以為那三條來源每天都在擋東西。
 *
 * 真正每天在擋的是：①`status=LINKED` 一律不進掃描（`where: { status: "TEMP" }`）
 * ②TTL 嚴格大於 ③本檔的**條件式刪除**（見 `deleteCandidate`）——判定與刪除之間
 * 若有人把該附件 link 走或重設 TTL 基準，刪除就會落空而非誤刪。
 */

import { PrismaClient } from "@prisma/client";
import { getEnvOrTestDefaults } from "../config/env.js";
import { errorLabel } from "../platform/error-label.js";
import { LocalVolumeStorage } from "../storage/index.js";
import type { Storage } from "../storage/index.js";
import { type CleanupCandidate, planCleanup } from "./cleanup-service.js";
import type { PrismaTxLike } from "./lifecycle-service.js";

// ---------------------------------------------------------------------------
// 可觀測性：結構化日誌（AC-06(c)；D6-3=(a) 之「不寫稽核，只有日誌 ＋ 摘要」）
// ---------------------------------------------------------------------------

/** 日誌階段名（封閉集合——新增一個階段就要在這裡具名）。 */
export type CleanupLogStage =
  | "start"
  | "candidate"
  | "deleted"
  | "skipped"
  | "db-delete-failed"
  | "storage-delete-failed"
  | "config-error"
  | "invalid-argument"
  | "fatal"
  | "summary";

/**
 * 一行清理日誌。**欄位刻意封閉且零內容**：只有階段名、附件 id 與錯誤類別名。
 * 沒有 `storageKey`、沒有檔名、沒有擁有人、沒有 `err.message`（理由見檔頭）。
 */
export interface CleanupLogEvent {
  readonly stage: CleanupLogStage;
  readonly attachmentId?: string;
  /** `errorLabel(err)` ＝ 錯誤**類別名**，不含訊息內容。 */
  readonly errName?: string;
  /** 僅 `stage: "summary"` 使用。 */
  readonly summary?: CleanupSummary;
  /**
   * 僅 `stage: "candidate"`（dry-run）使用：候選清單之逐筆內容（AC-04(b)）。
   * `CleanupCandidate` 之欄位本身即封閉且零禁字——它刻意不含 `storageKey`／
   * 檔名／擁有人，故直接印出不違反日誌紀律。
   */
  readonly candidate?: CleanupCandidate;
  /** 僅 `stage: "config-error"`／`"invalid-argument"` 使用：缺漏之設定鍵名（不含值）。 */
  readonly detail?: string;
}

export interface CleanupLogger {
  log(event: CleanupLogEvent): void;
}

/** 預設輸出：每行一個 JSON 物件到 stdout（排程器／容器日誌可直接收斂）。 */
export const stdoutCleanupLogger: CleanupLogger = {
  log(event: CleanupLogEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
};

// ---------------------------------------------------------------------------
// 執行器（AC-05／AC-06(b)(c)(d)(e)）
// ---------------------------------------------------------------------------

export interface CleanupRunOptions {
  /** 注入之「現在」——注入而非 `new Date()`，使判定完全決定性（沿 T3）。 */
  readonly now: Date;
  /** TTL 門檻（小時），env `ATTACHMENT_TEMP_TTL_HOURS`。 */
  readonly ttlHours: number;
  /** 批次上限，env `ATTACHMENT_CLEANUP_BATCH_LIMIT`（AC-06(b)）。 */
  readonly limit: number;
  /** `true` ＝ 唯讀預覽：一筆都不刪（AC-04(a)）。 */
  readonly dryRun: boolean;
  readonly logger?: CleanupLogger;
}

/**
 * 單次執行摘要（AC-06(c) 逐字要求之五欄＝`scannedCount`／`candidateCount`／
 * `deletedCount`／`failedCount`／`durationMs`；另三欄為模式與剩餘量之必要語
 * 意）。**零個資、零 storage key**。
 *
 * 計數語意（刻意寫清楚——三者相加不必然等於 `candidateCount`）：
 *   · `deletedCount`：**DB 列實際被本次執行刪除**之筆數；
 *   · `failedCount`：任一階段失敗之筆數。**與 `deletedCount` 可交集**——
 *     「DB 列已刪、storage 刪除失敗」同時計入兩者（AC-05(c)：不回滾，但要算
 *     失敗）；
 *   · `skippedCount`：條件式刪除未命中之筆數（併發的另一份執行先處理掉了，
 *     或該列在判定與刪除之間被 link 走／TTL 基準被重設）——**不是失敗**。
 */
export interface CleanupSummary {
  readonly dryRun: boolean;
  readonly scannedCount: number;
  readonly candidateCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  /** 掃描量已達批次上限 ⇒ 可能尚有剩餘留待下次執行（B-07）。 */
  readonly hasMore: boolean;
  readonly durationMs: number;
}

export interface CleanupRunResult {
  readonly summary: CleanupSummary;
  /** 本次判定出的候選（欄位封閉、零禁字——`CleanupCandidate` 之契約）。 */
  readonly candidates: readonly CleanupCandidate[];
}

/** 單筆候選之處置結果。 */
interface CandidateOutcome {
  /** DB 列是否確實由本次執行刪除。 */
  readonly dbDeleted: boolean;
  /** 是否發生任一階段失敗（storage 刪除失敗亦算）。 */
  readonly failed: boolean;
}

/**
 * 刪除單一候選：讀 key → **條件式刪 DB 列** → 刪 storage 位元組。
 *
 * **條件式刪除**（AC-06(e)／B-08 之並行安全，同時是一道 TOCTOU 保險）：
 * `deleteMany({ where: { id, status: "TEMP", createdAt } })`——不是
 * `delete({ where: { id } })`。三個條件各有理由：
 *   · `deleteMany` 而非 `delete`：刪不到列時回傳 `count: 0` 而**不拋** `P2025`，
 *     故兩份併發執行時落後的那份只是「沒刪到」，不會炸掉整個行程；
 *   · `status: "TEMP"`：判定之後、刪除之前若有人把它 link 到容器上，就不刪；
 *   · `createdAt: candidate.createdAt`：TTL 基準（detach 會重設它，
 *     `lifecycle-service.ts` 之 `detachFieldSet`）若已改變，代表這已經不是我們
 *     判定過的那一版列，就不刪。
 * 三者合起來＝「只刪我判定過的那一版列」，這是把「判定與執行之間的時間差」關
 * 起來的最便宜作法（本專案無分散式鎖）。
 *
 * storage 刪除在 DB 交易之外、在列刪除**之後**（D16：storage IO 永不放進 DB
 * 交易內；AC-05(c)：DB 先、storage 後）。`Storage.delete` 契約為冪等
 * （`storage.ts` :44），故 B-05（縮圖從缺）與 B-06（位元組已不在）皆為 no-op、
 * 不計失敗。
 */
async function deleteCandidate(
  prisma: PrismaTxLike,
  storage: Storage,
  candidate: CleanupCandidate,
  logger: CleanupLogger
): Promise<CandidateOutcome> {
  let storageKey: string | null = null;
  let thumbnailKey: string | null = null;

  try {
    // 候選清單刻意不含 storage key（AC-04(b)），故實刪路徑自己去讀——讀到的值
    // 只交給 `storage.delete`，永不進日誌。
    const row = await prisma.attachment.findUnique({
      where: { id: candidate.id },
      select: { storageKey: true, thumbnailKey: true },
    });
    if (row === null) {
      logger.log({ stage: "skipped", attachmentId: candidate.id });
      return { dbDeleted: false, failed: false };
    }
    storageKey = row.storageKey;
    thumbnailKey = row.thumbnailKey;

    const result = await prisma.attachment.deleteMany({
      where: { id: candidate.id, status: "TEMP", createdAt: candidate.createdAt },
    });
    if (result.count === 0) {
      logger.log({ stage: "skipped", attachmentId: candidate.id });
      return { dbDeleted: false, failed: false };
    }
  } catch (err) {
    logger.log({ stage: "db-delete-failed", attachmentId: candidate.id, errName: errorLabel(err) });
    return { dbDeleted: false, failed: true };
  }

  let failed = false;
  for (const key of [storageKey, thumbnailKey]) {
    if (key === null || key.length === 0) continue;
    try {
      await storage.delete(key);
    } catch (err) {
      // 不回滾 DB 刪除（該檔已不可達），但計入失敗並記零內容日誌（AC-05(c)）。
      failed = true;
      logger.log({
        stage: "storage-delete-failed",
        attachmentId: candidate.id,
        errName: errorLabel(err),
      });
    }
  }

  logger.log({ stage: "deleted", attachmentId: candidate.id });
  return { dbDeleted: true, failed };
}

/**
 * 執行一次清理（AC-05／AC-06）。
 *
 * 判定**恰一次**、且**恰一條**：`planCleanup` 是本函式取得候選的唯一來源，
 * dry-run 與實跑走的是同一行呼叫（AC-04(c) 的另一半——T3 已釘住 dry-run 側，
 * 本函式釘住實跑側）。dry-run 只是「拿到候選之後不進刪除迴圈」，不是另一套查詢。
 *
 * **部分失敗不中止**（AC-06(d)）：逐筆的失敗只影響該筆的計數，迴圈照跑完。
 *
 * @param storage dry-run 時傳 `null`——**結構性**保證唯讀模式手上根本沒有
 *   storage 控制代碼（沿 T3 `dryRunCleanup` 連收都不收 storage 的同一紀律）。
 *   實跑傳 `null` 會立即拋錯，不會靜默跳過刪檔。
 */
export async function runCleanup(
  prisma: PrismaTxLike,
  storage: Storage | null,
  options: CleanupRunOptions
): Promise<CleanupRunResult> {
  const logger = options.logger ?? stdoutCleanupLogger;
  const startedAt = Date.now();
  logger.log({ stage: "start" });

  const plan = await planCleanup(prisma, {
    now: options.now,
    ttlHours: options.ttlHours,
    limit: options.limit,
  });

  let deletedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  if (options.dryRun) {
    // AC-04(b)：dry-run 的產出就是這份候選清單——「清理啟用前人工 Gate」
    // （Spec §15.4）要人眼看過的正是這幾行，只印摘要不足以判讀。
    for (const candidate of plan.candidates) {
      logger.log({ stage: "candidate", attachmentId: candidate.id, candidate });
    }
  }

  if (!options.dryRun) {
    if (storage === null) {
      throw new Error("runCleanup: 實跑模式必須提供 storage（dry-run 才允許 null）");
    }
    for (const candidate of plan.candidates) {
      const outcome = await deleteCandidate(prisma, storage, candidate, logger);
      if (outcome.dbDeleted) deletedCount++;
      else if (!outcome.failed) skippedCount++;
      if (outcome.failed) failedCount++;
    }
  }

  const summary: CleanupSummary = {
    dryRun: options.dryRun,
    scannedCount: plan.scannedCount,
    candidateCount: plan.candidates.length,
    deletedCount,
    failedCount,
    skippedCount,
    hasMore: plan.hasMore,
    durationMs: Date.now() - startedAt,
  };
  logger.log({ stage: "summary", summary });

  return { summary, candidates: plan.candidates };
}

// ---------------------------------------------------------------------------
// CLI 進入點（D3=(c)：外部排程之唯一介面）
// ---------------------------------------------------------------------------

/** 有失敗／設定錯誤／致命錯誤之結束碼（D6-2=(a)）。 */
export const CLEANUP_EXIT_FAILURE = 1;
/** 全數成功（含零候選、含 dry-run）之結束碼。 */
export const CLEANUP_EXIT_OK = 0;

/** 測試用注入點；正式執行一律省略（自行建立並持有 PrismaClient／Storage）。 */
export interface CleanupCliDeps {
  readonly prisma?: PrismaTxLike;
  readonly storage?: Storage;
  readonly logger?: CleanupLogger;
  /** 注入之「現在」；省略時取 `new Date()`。 */
  readonly now?: Date;
}

/**
 * CLI 主體：解析旗標 → 讀 env → 執行一次清理 → 回傳**結束碼**。
 *
 * 刻意回傳結束碼而不自己 `process.exit`，使它可被測試直接呼叫（`process.exit`
 * 只發生在下方的 `isMain` 區塊）。
 *
 * 旗標恰一個：`--dry-run`（唯讀預覽）。未知旗標一律拒絕並以非零結束——對一個
 * 不可逆刪除工具，「看不懂的參數」必須是硬失敗，不能猜。
 */
export async function runCleanupCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  deps: CleanupCliDeps = {}
): Promise<number> {
  const logger = deps.logger ?? stdoutCleanupLogger;

  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    logger.log({ stage: "invalid-argument", detail: arg });
    return CLEANUP_EXIT_FAILURE;
  }

  const config = getEnvOrTestDefaults(env);
  const storageRoot = config.ATTACHMENT_STORAGE_ROOT;

  // dry-run 不需要 storage（也刻意不建立一個）——唯讀模式手上沒有刪除工具。
  let storage: Storage | null = null;
  if (!dryRun) {
    if (deps.storage !== undefined) {
      storage = deps.storage;
    } else if (storageRoot === undefined || storageRoot.trim() === "") {
      logger.log({ stage: "config-error", detail: "ATTACHMENT_STORAGE_ROOT" });
      return CLEANUP_EXIT_FAILURE;
    } else {
      storage = new LocalVolumeStorage(storageRoot);
    }
  }

  let ownedClient: PrismaClient | undefined;
  let prisma: PrismaTxLike;
  if (deps.prisma) {
    prisma = deps.prisma;
  } else {
    ownedClient = new PrismaClient();
    prisma = ownedClient;
  }

  try {
    const result = await runCleanup(prisma, storage, {
      now: deps.now ?? new Date(),
      ttlHours: config.ATTACHMENT_TEMP_TTL_HOURS,
      limit: config.ATTACHMENT_CLEANUP_BATCH_LIMIT,
      dryRun,
      logger,
    });
    return result.summary.failedCount > 0 ? CLEANUP_EXIT_FAILURE : CLEANUP_EXIT_OK;
  } catch (err) {
    logger.log({ stage: "fatal", errName: errorLabel(err) });
    return CLEANUP_EXIT_FAILURE;
  } finally {
    if (ownedClient) await ownedClient.$disconnect();
  }
}

// 只在「本檔即進入點」時執行（被測試匯入時不執行）——沿 `seed/seed-admin.ts`
// 之既有慣例。本檔不被 `server.ts` 匯入，故正式服務行程永遠走不到這裡。
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cleanup-cli.ts") || process.argv[1].endsWith("cleanup-cli.js"));

if (isMain) {
  runCleanupCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      stdoutCleanupLogger.log({ stage: "fatal", errName: errorLabel(err) });
      process.exit(CLEANUP_EXIT_FAILURE);
    });
}
