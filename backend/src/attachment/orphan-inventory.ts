/**
 * Storage 孤兒盤點 — PHASE-011-T6（`docs/specs/PHASE-011.md` **AC-08**；§16
 * **D5**=(c)：**只盤點、只報告，不刪除**）
 *
 * ---------------------------------------------------------------------------
 * 本模組的一句話定位
 * ---------------------------------------------------------------------------
 * 找出「storage 有檔、DB 無對應列」的物件（`KNOWN_ISSUES.md` :97 §5-2 之孤兒／
 * in-doubt 殘留），**只讀、只報告，零刪除**——D5=(c) 之推薦理由是「孤兒規模今日
 * 未知，先量測再決定刪除策略」，故本模組**沒有任何刪除能力**：全檔零呼叫
 * `storage.delete`／`storage.put`／任一 Prisma 寫入方法（`create`／`update`／
 * `delete`／`upsert`／`*Many`／`*AndReturn`），這不是靠自律，而是本模組的函式
 * 簽章只收 `Storage`（讀方法）與 Prisma 之查詢，結構上沒有拿到刪除工具
 * （沿 `cleanup-service.ts` 之 `dryRunCleanup` 同一紀律：唯讀不是自律而是結構）。
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

import type { Storage, StorageListEntry } from "../storage/storage.js";
import type { PrismaTxLike } from "./lifecycle-service.js";

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
 * 「誤刪」代價，只會讓極少數剛好卡在窗內的真孤兒暫緩一輪才被計入
 * `confirmedOrphanCount`——下一次盤點會自然趕上。
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
  /** 不合 `ORPHAN_OBJECT_TYPES` 任一型之鍵數（今日應恆為 0；非零代表新型物件出現而未入宣告）。 */
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
 * 執行一次孤兒盤點。**唯讀**：只呼叫 `storage.list()`（讀）與 Prisma
 * `findMany`（讀），零 `storage.delete`／`storage.put`、零 Prisma 寫入方法。
 *
 * `attStorage`／`rptStorage` 須支援 `list()`（`Storage` 介面之選用方法；
 * `LocalVolumeStorage` 已實作，PHASE-011-T6）——未支援者本函式直接拋錯，不
 * 靜默略過（靜默略過會讓「掃不到東西」與「零孤兒」在輸出上無法分辨，違反
 * MF-1 走廊）。
 */
export async function inventoryOrphans(
  prisma: PrismaTxLike,
  attStorage: Storage,
  rptStorage: Storage,
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
