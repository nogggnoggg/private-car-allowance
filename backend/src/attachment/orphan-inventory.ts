/**
 * Storage 孤兒盤點 — PHASE-011-T6（`docs/specs/PHASE-011.md` **AC-08**；§16
 * **D5**=(c)：**只盤點、只報告，不刪除**）
 *
 * ---------------------------------------------------------------------------
 * 本模組的一句話定位
 * ---------------------------------------------------------------------------
 * 找出「storage 有檔、DB 無對應列」的物件（`KNOWN_ISSUES.md` :97 §5-2 之孤兒／
 * in-doubt 殘留），**只讀、只報告，零刪除**——D5=(c) 之推薦理由是「孤兒規模今日
 * 未知，先量測再決定刪除策略」。
 *
 * **本模組沒有任何刪除能力，這是型別層級可驗證的事實，不是宣稱**（T6R 即審
 * SF-1 修法 (b)）：`inventoryOrphans` 之簽章只收 `OrphanListableStorage`
 * （僅 `list()`）與 `OrphanInventoryDb`（僅三個 delegate 之 `findMany()`）
 * 兩個**收斂過的結構型介面**，兩者皆不含任何寫入方法——TypeScript 在編譯期
 * 就會拒絕本模組呼叫任何未宣告於這兩型上的方法（含 `put`／`delete`／
 * `create`／`update`／`upsert`／`*Many`／`*AndReturn`）。真實的
 * `LocalVolumeStorage`／`PrismaClient` 具有遠多於此的方法（含完整刪除能
 * 力），但結構型別只看「傳入值是否具備介面要求的方法」，多出的方法不會被
 * 本模組拿到——呼叫端因此**零改動**（真實實例結構相容，沿
 * 本專案測試輔助層 `setup-file.ts` 之 `WorkerSchemaSqlExecutor` 同一慣例）。
 *
 * 【對照 `cleanup-service.ts` 之 `dryRunCleanup`，避免同型誤引第三次】
 * `dryRunCleanup` 先例的價值**恰在於區分**兩種不同強度的保證：storage 面是
 * 結構性的（`dryRunCleanup` 的簽章**完全不收** storage 參數，連控制代碼都
 * 沒有）；DB 面則是**測試性**的（`planCleanup` 仍收完整 `PrismaTxLike`，唯
 * 讀是由 `phase11-attachment-cleanup.test.ts` 的寫入方法掃描 ＋ 執行期快照
 * 全等斷言守住，不是型別擋下）。本檔先前的版本誤把這兩種保證混為一談、逕
 * 稱「結構上沒有拿到刪除工具」，但當時的簽章其實收的是完整 `Storage`（含
 * `put`／`delete`）與 `PrismaTxLike`（完整 client）——屬偽陳述，已由本次
 * 介面收斂修正。修正後，本模組在 storage 面與 DB 面**都**達到
 * `dryRunCleanup` 原本只在 storage 面達到的那種結構性保證。
 *
 * ---------------------------------------------------------------------------
 * 掃描範圍（四型物件；AC-08(a)）
 * ---------------------------------------------------------------------------
 * DB 側四來源（與 `scripts/backup.sh` 之「涵蓋完整性自檢」§304-314 同源查
 * 詢——鍵集定義本應只有一份，此處以 Prisma 查詢達成同一件事）：
 *   `Attachment.storageKey`／`Attachment.thumbnailKey`（非 null 者）／
 *   `Report.storageKey`／`VoidedReportFile.storageKey`。
 * storage 側對應恰四型（`ORPHAN_OBJECT_TYPES`，封閉宣告——新增一型即同批更新
 * 本常數，AC-03(a) 同款紀律）：`att/<id>/original`／`att/<id>/thumb`／
 * `rpt/<id>/pdf`／`rpt/<id>/void`。
 *
 * ---------------------------------------------------------------------------
 * 保護期（AC-08(c) 上游必讀 #6；D5(c) 節未給具體數值，取 D5(c-2) 之範例值同
 * 一數量級——理由見 `ORPHAN_PROTECTION_WINDOW_MS`）
 * ---------------------------------------------------------------------------
 * `upload-service.ts` 之寫入順序是 **storage 先寫、DB 後寫**（`processUpload`
 * 步驟 6→9）：兩步之間若行程崩潰，會留下「storage 有檔、DB 尚無列」的窗口，
 * 這正是本盤點若無保護期會誤判的情境——剛寫入、DB 交易尚未落地的正常物件不
 * 應被算成「孤兒」。故盤點把每個候選物件按其**最後寫入時間**（`lastModified`）
 * 分兩類：
 *   · **`confirmedOrphanCount`**：早於保護期閾值——才計入「孤兒」；
 *   · **`pendingCount`**：仍在保護期窗內——**不**計入孤兒，僅供可觀測性（正常
 *     的 in-doubt 窗，下一輪盤點若仍未消失才會轉為 confirmed）。
 * 本模組零刪除，故本分類**不是**刪除門檻（AC-08(c-2) 之保護期才是刪除門
 * 檻），而是**報告準確性**門檻——避免「今日孤兒規模」把正在寫入的正常流量算
 * 進去而失真。
 *
 * ---------------------------------------------------------------------------
 * 孤兒來源之一：清理之 storage 刪除失敗（T4 即審 FW-3）
 * ---------------------------------------------------------------------------
 * `cleanup-cli.ts` 之 `deleteCandidate`：DB 列先刪、storage 位元組後刪，且
 * **storage 刪除失敗不回滾 DB 刪除**（`failedCount` 計入但 DB 列已不存在）。
 * 這是孤兒的**穩定產生源**之一（另一來源是上一段的 in-doubt 窗）。本報告不
 * 區分兩種來源（結構上無法區分——孤兒物件本身不帶「為何孤兒」的標記），據實
 * 記載於此，供人工判讀時參考。
 *
 * ---------------------------------------------------------------------------
 * 「掃不到東西」≠「零孤兒」（T10R MF-1 走廊；沿 `scripts/backup.sh` 之涵蓋
 * 自檢 fail-closed 同一紀律）
 * ---------------------------------------------------------------------------
 * `attScannedKeyCount`／`rptScannedKeyCount`／`dbKeyCount` 三欄恆存在於輸出：
 * 「storage 空樹」（`attScannedKeyCount === 0`）與「storage 有檔但零孤兒」是
 * 兩個結構上可分辨的狀態，讀者不會把前者誤讀成「已驗證乾淨」。
 */

import type { StorageListEntry } from "../storage/storage.js";

// ---------------------------------------------------------------------------
// 依賴之結構型介面收斂（T6R／SF-1 修法 (b)）
// ---------------------------------------------------------------------------

/**
 * `inventoryOrphans` 之 storage 依賴——收斂為僅 `list()`（讀）。
 *
 * 真實 `LocalVolumeStorage` 結構相容，呼叫端零改；刻意不用完整 `Storage`
 * 介面（其含 `put`／`delete`），使「本模組拿不到刪除工具」成為型別事實。
 */
export interface OrphanListableStorage {
  list(): Promise<StorageListEntry[]>;
}

/**
 * `inventoryOrphans` 之 DB 依賴——收斂為僅三個 delegate 的 `findMany()`（讀）。
 *
 * 真實 `PrismaClient`／`Prisma.TransactionClient` 結構相容，呼叫端零改
 * （沿本專案測試輔助層 `setup-file.ts` 之 `WorkerSchemaSqlExecutor` 同一慣例）。
 * 刻意不用完整 `PrismaTxLike`（其含全部 model 的完整 CRUD delegate）。
 */
export interface OrphanInventoryDb {
  readonly attachment: {
    findMany(args: {
      select: { storageKey: true; thumbnailKey: true };
    }): Promise<Array<{ storageKey: string; thumbnailKey: string | null }>>;
  };
  readonly report: {
    findMany(args: { select: { storageKey: true } }): Promise<Array<{ storageKey: string }>>;
  };
  readonly voidedReportFile: {
    findMany(args: { select: { storageKey: true } }): Promise<Array<{ storageKey: string }>>;
  };
}

// ---------------------------------------------------------------------------
// 封閉宣告：四型物件（AC-08(a)）
// ---------------------------------------------------------------------------

export type OrphanObjectType = "ATT_ORIGINAL" | "ATT_THUMB" | "RPT_PDF" | "RPT_VOID";

export interface OrphanObjectTypeDeclaration {
  readonly type: OrphanObjectType;
  readonly prefix: "att" | "rpt";
  readonly suffix: string;
}

/**
 * **封閉宣告清單**：本盤點認得的物件型別，恰為以下四項，不多不少。順序即
 * `OrphanInventoryReport.groups` 之順序。新增一型（如未來的 `rpt/<id>/preview`）
 * 需同批更新本常數——遺漏即該型物件永遠落入 `unclassifiedKeyCount`，不會被
 * 靜默算進 `groups`（見 `classifyKey`）。
 */
export const ORPHAN_OBJECT_TYPES: readonly OrphanObjectTypeDeclaration[] = [
  { type: "ATT_ORIGINAL", prefix: "att", suffix: "original" },
  { type: "ATT_THUMB", prefix: "att", suffix: "thumb" },
  { type: "RPT_PDF", prefix: "rpt", suffix: "pdf" },
  { type: "RPT_VOID", prefix: "rpt", suffix: "void" },
];

/**
 * 依 key 之 `<prefix>/<id>/<suffix>` 形狀比對 `ORPHAN_OBJECT_TYPES`；不合任一
 * 宣告者回傳 `null`（計入 `unclassifiedKeyCount`，不計入任何 group）。
 */
function classifyKey(key: string): OrphanObjectType | null {
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const [prefix, , suffix] = parts;
  const decl = ORPHAN_OBJECT_TYPES.find((d) => d.prefix === prefix && d.suffix === suffix);
  return decl ? decl.type : null;
}

// ---------------------------------------------------------------------------
// 保護期
// ---------------------------------------------------------------------------

/**
 * 保護期預設值：24 小時。
 *
 * D5(c) 節本身未給只報告分支之具體數值（AC-08(c-2) 之「如 24 h」是**刪除**
 * 分支的範例）；本模組取同一數量級而非另立門檻，理由：①避免無依據地另編一個
 * 數字；②本模組零刪除，此值只影響報告分類，選用偏保守（較長）的窗口不會有
 * 「誤刪」代價。
 *
 * **`pendingCount` 之規模並非恆小**（T6R／SF-3 修正——原文「只會讓極少數…
 * 暫緩一輪」為未經驗證之臆測，已刪除）：低寫入頻率的正式環境下，
 * `pendingCount` 應僅佔少數；但**高寫入頻率環境下（如本專案共用之開發／
 * 測試 storage 根目錄）`pendingCount` 可遠大於 `confirmedOrphanCount`**——
 * T6 對 dev storage 之首次實測即為反例：`confirmedOrphanCount` 合計
 * 7,255，`pendingCount` 合計 14,357（約為前者兩倍）。**讀者取用本報告時，
 * `pendingCount` 必須與 `confirmedOrphanCount` 併讀，不得逕行忽略**——它
 * 不是「即將自動消失的雜訊」，在高寫入環境下可能是報告中量體最大的一格。
 */
export const ORPHAN_PROTECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 報告形狀
// ---------------------------------------------------------------------------

export interface OrphanGroupSummary {
  readonly type: OrphanObjectType;
  /** 早於保護期閾值之孤兒數——本模組唯一計入「孤兒規模」的口徑。 */
  readonly confirmedOrphanCount: number;
  /** 該型 confirmed 孤兒中最舊之寫入時間；無 confirmed 孤兒時為 `null`。 */
  readonly oldestConfirmedOrphanAt: Date | null;
  /** 仍在保護期窗內、暫不計入孤兒之筆數（見檔頭「保護期」段）。 */
  readonly pendingCount: number;
}

export interface OrphanInventoryReport {
  /** 恆為 `true`——本模組之產生路徑不具備任何寫入能力（結構性，非自律）。 */
  readonly readOnly: true;
  readonly generatedAt: Date;
  readonly protectionWindowMs: number;
  /** `attStorage.list()` 回傳之鍵數（掃描量，非孤兒數）。 */
  readonly attScannedKeyCount: number;
  /** `rptStorage.list()` 回傳之鍵數（掃描量，非孤兒數）。 */
  readonly rptScannedKeyCount: number;
  /** DB 四來源鍵集之聯集大小（去重後）。 */
  readonly dbKeyCount: number;
  /**
   * 不合 `ORPHAN_OBJECT_TYPES` 任一型、但仍通過 `list()` 之 key 白名單之鍵
   * 數（今日應恆為 0；非零代表新型物件出現而未入宣告）。
   *
   * **射程限定**（AR-1／T6R）：不合 `LocalVolumeStorage` 自身 key 格式（如
   * 亂放的 `stray.bin`）者，在 `list()` 這一層就已被過濾、本報告完全看不
   * 見——不出現在本欄，也不出現在 `attScannedKeyCount`／`rptScannedKeyCount`
   * 或任何 group 計數中。故本報告之各項數字皆為**下限**：真實孤兒數只會
   * **大於等於**報告所示，不會更小。
   */
  readonly unclassifiedKeyCount: number;
  readonly groups: readonly OrphanGroupSummary[];
  readonly totalConfirmedOrphanCount: number;
  readonly totalPendingCount: number;
}

export interface OrphanInventoryOptions {
  /** 注入之「現在」——注入而非 `new Date()`，使保護期判定完全決定性。 */
  readonly now: Date;
  /** 保護期（毫秒）；省略時取 {@link ORPHAN_PROTECTION_WINDOW_MS}。 */
  readonly protectionWindowMs?: number;
}

// ---------------------------------------------------------------------------
// 盤點（AC-08(a)(b)(c-1)）
// ---------------------------------------------------------------------------

/**
 * 執行一次孤兒盤點。**唯讀**——且自本輪（T6R／SF-1）起，這是型別層級的事
 * 實：`OrphanInventoryDb`／`OrphanListableStorage` 兩型結構上不含任何寫入
 * 方法（見檔頭）。只呼叫 `storage.list()`（讀）與 Prisma `findMany`（讀）。
 *
 * `attStorage`／`rptStorage` 之靜態型別已要求 `list()` 存在（非選用），但
 * 本函式**仍保留執行期守門**：真實世界可能有「型別上宣稱符合、執行期其實
 * 沒有」的情況（如透過 `as unknown as` 繞過型別檢查之呼叫端、或未來非
 * TypeScript 之呼叫路徑）——靜默略過會讓「掃不到東西」與「零孤兒」在輸出上
 * 無法分辨，違反 MF-1 走廊，故一律直接拋錯。
 */
export async function inventoryOrphans(
  prisma: OrphanInventoryDb,
  attStorage: OrphanListableStorage,
  rptStorage: OrphanListableStorage,
  options: OrphanInventoryOptions
): Promise<OrphanInventoryReport> {
  if (typeof attStorage.list !== "function") {
    throw new Error("inventoryOrphans: attStorage does not implement list()");
  }
  if (typeof rptStorage.list !== "function") {
    throw new Error("inventoryOrphans: rptStorage does not implement list()");
  }

  const protectionWindowMs = options.protectionWindowMs ?? ORPHAN_PROTECTION_WINDOW_MS;

  const [attEntries, rptEntries, attRows, reportRows, voidRows] = await Promise.all([
    attStorage.list(),
    rptStorage.list(),
    prisma.attachment.findMany({ select: { storageKey: true, thumbnailKey: true } }),
    prisma.report.findMany({ select: { storageKey: true } }),
    prisma.voidedReportFile.findMany({ select: { storageKey: true } }),
  ]);

  const dbKeys = new Set<string>();
  for (const row of attRows) {
    dbKeys.add(row.storageKey);
    if (row.thumbnailKey !== null) dbKeys.add(row.thumbnailKey);
  }
  for (const row of reportRows) dbKeys.add(row.storageKey);
  for (const row of voidRows) dbKeys.add(row.storageKey);

  const confirmedByType = new Map<OrphanObjectType, StorageListEntry[]>();
  const pendingCountByType = new Map<OrphanObjectType, number>();
  for (const decl of ORPHAN_OBJECT_TYPES) {
    confirmedByType.set(decl.type, []);
    pendingCountByType.set(decl.type, 0);
  }
  let unclassifiedKeyCount = 0;

  for (const entry of [...attEntries, ...rptEntries]) {
    if (dbKeys.has(entry.key)) continue; // 有對應 DB 列 → 不是孤兒（含 LINKED 附件）

    const type = classifyKey(entry.key);
    if (type === null) {
      unclassifiedKeyCount++;
      continue;
    }

    const ageMs = options.now.getTime() - entry.lastModified.getTime();
    if (ageMs < protectionWindowMs) {
      pendingCountByType.set(type, (pendingCountByType.get(type) ?? 0) + 1);
    } else {
      confirmedByType.get(type)?.push(entry);
    }
  }

  const groups: OrphanGroupSummary[] = ORPHAN_OBJECT_TYPES.map((decl) => {
    const confirmed = confirmedByType.get(decl.type) ?? [];
    const oldest = confirmed.reduce<Date | null>(
      (min, e) => (min === null || e.lastModified < min ? e.lastModified : min),
      null
    );
    return {
      type: decl.type,
      confirmedOrphanCount: confirmed.length,
      oldestConfirmedOrphanAt: oldest,
      pendingCount: pendingCountByType.get(decl.type) ?? 0,
    };
  });

  return {
    readOnly: true,
    generatedAt: options.now,
    protectionWindowMs,
    attScannedKeyCount: attEntries.length,
    rptScannedKeyCount: rptEntries.length,
    dbKeyCount: dbKeys.size,
    unclassifiedKeyCount,
    groups,
    totalConfirmedOrphanCount: groups.reduce((sum, g) => sum + g.confirmedOrphanCount, 0),
    totalPendingCount: groups.reduce((sum, g) => sum + g.pendingCount, 0),
  };
}
