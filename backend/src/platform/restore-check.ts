/**
 * 還原驗證之判準純函式 ＋ 供 `scripts/verify-restore.sh` 呼叫之最小 CLI —
 * PHASE-011-T13
 *
 * `docs/specs/PHASE-011.md` **AC-23**（三項確認）／**AC-24**（驗證紀錄）；
 * §16 **D13**=(a)+(b) **併用**、§5 **B-19**（還原目標三元組）／**B-20**（損毀
 * 備份必然失敗）／**B-21**（抽樣時 storage 鍵缺失）。
 *
 * ---------------------------------------------------------------------------
 * D13=(a)+(b) 併用在本檔的具體形狀
 * ---------------------------------------------------------------------------
 * `FIXED_RELATION_CHECKS` 是 AC-23(c) 逐字的**七項固定清單**（Runbook 可逐項
 * 對照的那張表）；`buildRelationalIntegritySql` 產生的查詢則以
 * `information_schema` **動態列舉**目標 schema 內的全部外鍵並逐一數孤兒。
 * `evaluateRelationalIntegrity` 把兩者接起來：
 *
 *   · **完整性守門**（動態 → 固定）：七項所宣告的每一條外鍵邊都必須出現在動態
 *     列舉結果裡。新增資料表時動態列舉自動涵蓋；固定清單過時（宣告了一條已不
 *     存在的邊）即紅。這是 D13 選 (b) 的唯一理由——解掉 (a) 的老化問題。
 *   · **可讀對照**（固定 → Runbook）：`fixed-list=N/7` 逐項回報，維運人員看得懂
 *     哪一項在證什麼。
 *
 * **鑑別力不由本檔承擔**。外鍵孤兒由 DB 自己保證，還原後理論上恆為 0——這件事
 * D13 已明言。整個還原驗證非恆真的證明是 AC-23(e)：損毀備份必然失敗。本檔只多
 * 做一件 DB 保證不了的事：第⑤項（`Attachment.refType`／`refId` 之 `LINKED` 列其
 * 容器存在）是**弱引用**（`schema.prisma` :171 D1「no FK to non-existent tables」），
 * 沒有任何外鍵在守它，故它是七項中唯一真的可能抓到東西的一項。
 *
 * ---------------------------------------------------------------------------
 * 走廊條款（T10R FW-2，Done When 寫死）：可用性與結論分離
 * ---------------------------------------------------------------------------
 * 「查不到東西」不得與「查過都對」同結局。本檔兩處各自 fail-closed：
 *   · 動態列舉回**零列** → `relation-enumeration-empty`，**不是**「無孤兒」；
 *   · 抽樣湊不出「≥3 且含 thumb 且含修正版副本」→ `attachment-sample-unavailable`，
 *     **不是**「抽樣通過」。後者可由維運人員以 `RESTORE_ALLOW_INCOMPLETE_SAMPLE=1`
 *     明示承認而放行，但該次驗證紀錄必帶 `sample-incomplete` 降級標記——沿
 *     `backup.sh` T12R SF-1（`BACKUP_ALLOW_EMPTY`）之同一形狀：放行可以，
 *     **產物長得一樣不行**。
 *
 * ---------------------------------------------------------------------------
 * 證據等級之單一判準（T12 交接 M-6+M-8）
 * ---------------------------------------------------------------------------
 * 備份之 `coverage.allowEmpty === true`，**或** `manifest.tools.script` 早於
 * `PHASE-011-T12/2`（涵蓋自檢 fail-closed 之前的版本）→ 該備份的「涵蓋完整」
 * 前提**沒有機械背書**。`assessCoverageEvidence` 把這件事化為
 * `coverage-unverified` 標記寫進驗證紀錄。**還原成功 ≠ 涵蓋完整**：對這類備份，
 * 本驗證能證明的只有「備份裡的東西還原得回來」，不能反推「該備的都備到了」。
 *
 * ---------------------------------------------------------------------------
 * 設定值一律走**標準輸入**，零命令列參數、零環境讀取（同 `backup-policy.ts`）
 * ---------------------------------------------------------------------------
 * 三個理由與 `backup-policy.ts` 檔頭逐字相同（AC-11(d) 封閉集合／AC-22(c) 行程表
 * ／AC-21(b) 路徑值）。本檔更嚴一級：它吃的是**兩條連線字串**，走 argv 等於把
 * 密碼公告在主機行程表。只有子命令名走 argv。
 *
 * 需要餵資料（psql 輸出）的子命令，其標準輸入為「設定行 ＋ `PAYLOAD_SEPARATOR`
 * 單獨一行 ＋ 原始資料」。
 *
 * ---------------------------------------------------------------------------
 * 訊息紀律（AC-22(b)／AC-24(a)(d)）
 * ---------------------------------------------------------------------------
 * 失敗摘要一律取自 `SUMMARY_CODES` 這個**封閉集合**，不是自由文字。這不是風格
 * 偏好：紀錄檔會被排程器寄出、被貼進工單，自由文字遲早會把 storage key 或連線
 * 字串帶出去。封閉集合讓「零敏感內容」成為結構保證而非紀律要求。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BACKUP_ID_PATTERN, parseBackupId } from "./backup-policy.js";

// ===========================================================================
// 變數名常數（訊息只印變數名，不印值）
// ===========================================================================

export const SOURCE_URL_ENV = "DATABASE_URL";
export const TARGET_URL_ENV = "RESTORE_TARGET_DATABASE_URL";
export const DEST_ROOT_ENV = "BACKUP_DEST_ROOT";
export const BACKUP_ID_ENV = "RESTORE_BACKUP_ID";
export const VERIFY_SCHEMA_ENV = "RESTORE_VERIFY_SCHEMA";

/** 設定行與原始資料之分界（見檔頭）。 */
export const PAYLOAD_SEPARATOR = "--payload--";

// ===========================================================================
// AC-24 — 驗證紀錄之封閉詞彙
// ===========================================================================

/** 失敗階段：AC-23 之 (a)/(b)/(c)，加上三項開始之前的前置守門與成功時之 `none`。 */
export const RECORD_STAGES = ["guard", "a", "b", "c", "none"] as const;
export type RecordStage = (typeof RECORD_STAGES)[number];

/** AC-24(a) 之「失敗摘要」封閉集合（見檔頭訊息紀律）。 */
export const SUMMARY_CODES = [
  "all-three-confirmations-passed",
  "restore-target-equals-source",
  "restore-target-unusable",
  "restore-target-database-exists",
  "backup-not-found",
  "backup-manifest-unreadable",
  "db-dump-hash-mismatch",
  "create-database-failed",
  "pg-restore-failed",
  "restored-database-unreachable",
  "migration-tail-missing",
  "migration-tail-differs-from-source",
  "archive-hash-mismatch",
  "archive-extract-failed",
  "attachment-sample-unavailable",
  "attachment-object-missing",
  "relation-query-failed",
  "relation-enumeration-empty",
  "relation-list-stale",
  "relation-orphans-found",
  "relation-unsupported-composite-fk",
  "verification-interrupted",
] as const;
export type SummaryCode = (typeof SUMMARY_CODES)[number];

/** 證據降級標記（可並存；皆無 → `full`）。 */
export const EVIDENCE_TOKENS = ["coverage-unverified", "sample-incomplete"] as const;
export const EVIDENCE_FULL = "full";

/** AC-24(a) 逐字之五欄 ＋ 第六欄之證據等級（M-6+M-8；見檔頭）。 */
export const RECORD_REQUIRED_FIELDS = [
  "timestamp",
  "backupId",
  "stage",
  "summary",
  "exitCode",
] as const;
export const RECORD_FIELDS = [...RECORD_REQUIRED_FIELDS, "evidence"] as const;

export interface VerificationRecordInput {
  readonly timestamp: string;
  readonly backupId: string;
  readonly stage: string;
  readonly summary: string;
  readonly exitCode: number;
  readonly evidence: string;
}

/**
 * 組出一筆驗證紀錄（AC-24(a)(c)(d)）。
 *
 * 每一欄都先驗形狀再輸出，任何一欄不合格即**拒絕產生紀錄**（回 `ok:false`）而
 * 不是「盡力寫一筆」。理由：一筆格式壞掉的紀錄比沒有紀錄更糟——它會讓日後的
 * 判讀誤以為「那個月跑過了」。
 */
export function formatVerificationRecord(
  input: VerificationRecordInput
): { readonly ok: true; readonly line: string } | { readonly ok: false; readonly message: string } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.timestamp)) {
    return { ok: false, message: "record timestamp must be UTC YYYY-MM-DDThh:mm:ssZ" };
  }
  if (input.backupId !== "unknown" && !BACKUP_ID_PATTERN.test(input.backupId)) {
    return {
      ok: false,
      message: "record backupId must match the backup id pattern or be 'unknown'",
    };
  }
  if (!(RECORD_STAGES as readonly string[]).includes(input.stage)) {
    return { ok: false, message: `record stage must be one of: ${RECORD_STAGES.join("|")}` };
  }
  if (!(SUMMARY_CODES as readonly string[]).includes(input.summary)) {
    return { ok: false, message: "record summary must be one of the closed summary codes" };
  }
  if (!Number.isInteger(input.exitCode)) {
    return { ok: false, message: "record exitCode must be an integer" };
  }
  const tokens = input.evidence.split(",").filter((t) => t !== "");
  const known = tokens.every(
    (t) => t === EVIDENCE_FULL || (EVIDENCE_TOKENS as readonly string[]).includes(t)
  );
  if (tokens.length === 0 || !known) {
    return { ok: false, message: "record evidence must be 'full' or known degradation tokens" };
  }
  // 欄位順序固定：紀錄檔是給人讀的，欄序漂移會讓 `diff` 與目視對照全部失效。
  return {
    ok: true,
    line: JSON.stringify({
      timestamp: input.timestamp,
      backupId: input.backupId,
      stage: input.stage,
      summary: input.summary,
      exitCode: input.exitCode,
      evidence: input.evidence,
    }),
  };
}

// ===========================================================================
// AC-23(d)／B-19 — 還原目標三元組守門
// ===========================================================================

export interface ConnectionParts {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
  readonly schema: string;
}

/**
 * 解析連線字串；**密碼段解析出來後即丟棄**，永不回傳、永不輸出。
 *
 * 解析失敗一律回 `null`，呼叫端據此拒跑（fail-closed）——一個「不知道自己要連
 * 去哪裡」的還原工具沒有安全的下一步。
 */
export function parseConnection(raw: string): ConnectionParts | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 刻意不繫結例外：其訊息會逐字回印整條連線字串（含密碼）。
    return null;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") return null;
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === "" ? "5432" : url.port,
    user: decodeURIComponent(url.username),
    database,
    schema: url.searchParams.get("schema") ?? "public",
  };
}

/** PostgreSQL 識別字之保守形狀（本工具會把它嵌進 DDL，故不容許任何跳脫需求）。 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export type TargetRejection = "restore-target-equals-source" | "restore-target-unusable";

/**
 * B-19：還原目標**絕不得**為正式。
 *
 * 判準依 Spec §5 B-19 逐字——「連線字串之 **host＋db＋schema** 三元組比對」。
 * **刻意不把 port 納入三元組**：納入會讓「同一台主機、同一個庫名、只有 port
 * 不同」被判為不同而放行，那是**放寬**方向；本守門的每一個誤判都必須落在
 * 「誤擋」那一側。（Packet 轉述為 `host,port,db`，與 Spec 原文不同，依治理以
 * Spec 為準——差異已記入 Handoff。）
 *
 * 另有兩道與三元組無關但同等必要的形狀守門：目標之資料庫名與 schema 名須為安全
 * 識別字（本工具要把它嵌進 `CREATE DATABASE`／`DROP DATABASE`），任一條不合即
 * `restore-target-unusable`。
 */
export function evaluateRestoreTarget(args: {
  readonly sourceUrl: string;
  readonly targetUrl: string;
}):
  | { readonly ok: true; readonly source: ConnectionParts; readonly target: ConnectionParts }
  | { readonly ok: false; readonly code: TargetRejection; readonly message: string } {
  const source = parseConnection(args.sourceUrl);
  const target = parseConnection(args.targetUrl);
  if (source === null) {
    return {
      ok: false,
      code: "restore-target-unusable",
      message: `${SOURCE_URL_ENV} is not a usable PostgreSQL connection string`,
    };
  }
  if (target === null) {
    return {
      ok: false,
      code: "restore-target-unusable",
      message: `${TARGET_URL_ENV} is not a usable PostgreSQL connection string`,
    };
  }
  if (
    source.host === target.host &&
    source.database === target.database &&
    source.schema === target.schema
  ) {
    return {
      ok: false,
      code: "restore-target-equals-source",
      message: `${TARGET_URL_ENV} has the same host+database+schema triple as ${SOURCE_URL_ENV} (B-19): refusing to restore onto production`,
    };
  }
  if (!SAFE_IDENTIFIER.test(target.database) || !SAFE_IDENTIFIER.test(target.schema)) {
    return {
      ok: false,
      code: "restore-target-unusable",
      message: `${TARGET_URL_ENV} database/schema name is not a plain lower-case identifier`,
    };
  }
  return { ok: true, source, target };
}

// ===========================================================================
// AC-23(c) — 關聯完整性：七項固定清單（D13(a)）
// ===========================================================================

export interface FixedRelationCheck {
  /** AC-23(c) 逐字之項次。 */
  readonly item: string;
  readonly label: string;
  /** 該項所依賴之外鍵邊（`<表>.<欄>`）；非外鍵支撐者為空陣列。 */
  readonly edges: readonly string[];
  readonly fkBacked: boolean;
}

/** 第⑤項之識別字（弱引用，無外鍵可依；見檔頭）。 */
export const NON_FK_CHECK_ID = "Attachment.refId(LINKED)";

export const FIXED_RELATION_CHECKS: readonly FixedRelationCheck[] = [
  {
    item: "①",
    label: "Application ↔ 差旅／保養／折舊三種子表 1:1 無孤兒",
    edges: [
      "TravelApplication.applicationId",
      "MaintenanceApplication.applicationId",
      "DepreciationApplication.applicationId",
    ],
    fkBacked: true,
  },
  {
    item: "②",
    label: "TripSegment → TravelApplication 無孤兒",
    edges: ["TripSegment.travelApplicationId"],
    fkBacked: true,
  },
  {
    item: "③",
    label: "Report → Application 無孤兒",
    edges: ["Report.applicationId"],
    fkBacked: true,
  },
  {
    item: "④",
    label: "VoidedReportFile → Report 無孤兒",
    edges: ["VoidedReportFile.reportId"],
    fkBacked: true,
  },
  {
    item: "⑤",
    label: "Attachment 之 LINKED 列其容器存在（弱引用，無外鍵）",
    edges: [],
    fkBacked: false,
  },
  {
    item: "⑥",
    label: "AuditLog.actorId 指向存在之 User",
    edges: ["AuditLog.actorId"],
    fkBacked: true,
  },
  { item: "⑦", label: "Session.userId 指向存在之 User", edges: ["Session.userId"], fkBacked: true },
];

/** SQL 字面之 schema 名嵌入前一律過此關（本模組不接受需要跳脫的識別字）。 */
function requireSafeSchema(schema: string): string {
  if (!SAFE_IDENTIFIER.test(schema)) {
    throw new Error(`${VERIFY_SCHEMA_ENV} must be a plain lower-case identifier`);
  }
  return schema;
}

/**
 * AC-23(c) 之單一查詢：動態列舉全外鍵並逐一數孤兒，外加第⑤項之弱引用檢查。
 *
 * 動態部分沿 `phase10-user-delete-regression.test.ts` :163-179 之三方 join，
 * 差別在於 (i) schema 以參數侷限（該檔用 `current_schema()`，本工具連的是還原
 * 目標，`search_path` 不由我們決定）(ii) 每一條邊再以 `query_to_xml` 就地跑一次
 * `NOT EXISTS` 計數——這讓「列舉」與「數孤兒」在**同一個交易快照**內完成，不必
 * 為了組第二段 SQL 而多跑一趟。
 *
 * 已知限制（據實記載）：複合外鍵會在 `key_column_usage`／`constraint_column_usage`
 * 兩側各展開多列而形成交叉積。本 schema 今日**沒有**複合外鍵；真的出現時，
 * `evaluateRelationalIntegrity` 會偵測到同名約束出現多列而**拒絕給出結論**
 * （`relation-unsupported-composite-fk`），不會默默算錯。
 */
export function buildRelationalIntegritySql(rawSchema: string): string {
  const s = requireSafeSchema(rawSchema);
  return `
WITH fks AS (
  SELECT rc.constraint_name AS cn, kcu.table_name AS ct, kcu.column_name AS cc,
         ccu.table_name AS pt, ccu.column_name AS pc
  FROM information_schema.referential_constraints rc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = rc.constraint_name
   AND kcu.constraint_schema = rc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = rc.unique_constraint_name
   AND ccu.constraint_schema = rc.unique_constraint_schema
  WHERE rc.constraint_schema = '${s}'
)
SELECT 'fk' AS kind, cn, ct || '.' || cc AS id, pt || '.' || pc AS target,
       (xpath('/row/c/text()', query_to_xml(
          format('SELECT count(*) AS c FROM %I.%I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I.%I p WHERE p.%I = x.%I)',
                 '${s}', ct, cc, '${s}', pt, pc, cc), false, true, '')))[1]::text::bigint AS orphans
FROM fks
UNION ALL
SELECT 'fixed', 'weak-reference', '${NON_FK_CHECK_ID}', 'TripSegment+MaintenanceApplication+DepreciationApplication',
       (SELECT count(*) FROM "${s}"."Attachment" a
          LEFT JOIN "${s}"."TripSegment" ts
            ON a."refType"::text = 'TRIP_SEGMENT' AND ts."id" = a."refId"
          LEFT JOIN "${s}"."MaintenanceApplication" m
            ON a."refType"::text = 'MAINTENANCE' AND m."applicationId" = a."refId"
          LEFT JOIN "${s}"."DepreciationApplication" d
            ON a."refType"::text = 'DEPRECIATION' AND d."applicationId" = a."refId"
        WHERE a."status"::text = 'LINKED'
          AND ts."id" IS NULL AND m."applicationId" IS NULL AND d."applicationId" IS NULL)
ORDER BY 1, 3
`.trim();
}

/** AC-23(a)：還原目標之 `_prisma_migrations` 尾筆（同一段 SQL 也用來讀來源）。 */
export function buildMigrationTailSql(rawSchema: string): string {
  const s = requireSafeSchema(rawSchema);
  return `SELECT "migration_name" FROM "${s}"."_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "finished_at" DESC, "migration_name" DESC LIMIT 1`;
}

/**
 * AC-23(b)：還原目標內之附件物件清單（`LINKED` 列），附「是否為修正版副本」。
 *
 * 「修正版副本」之機械定義：該附件之**容器所屬申請** `supersedesId` 非空——即
 * `Application` 為某一筆已完成申請之修正版（`schema.prisma` :298 PHASE-009 D7）。
 * 容器經 `refType` 分流：`TRIP_SEGMENT` 走 `TripSegment.travelApplicationId`，
 * 保養／折舊之 `refId` 本身即 `applicationId`（兩子表之主鍵）。
 */
export function buildAttachmentObjectSql(rawSchema: string): string {
  const s = requireSafeSchema(rawSchema);
  return `
WITH att AS (
  SELECT a."storageKey" AS okey, a."thumbnailKey" AS tkey,
         COALESCE(app."supersedesId" IS NOT NULL, false) AS revision
  FROM "${s}"."Attachment" a
  LEFT JOIN "${s}"."TripSegment" ts
    ON a."refType"::text = 'TRIP_SEGMENT' AND ts."id" = a."refId"
  LEFT JOIN "${s}"."Application" app
    ON app."id" = COALESCE(ts."travelApplicationId",
         CASE WHEN a."refType"::text IN ('MAINTENANCE', 'DEPRECIATION') THEN a."refId" END)
  WHERE a."status"::text = 'LINKED'
)
SELECT okey AS key, 'original' AS kind, revision FROM att WHERE okey IS NOT NULL
UNION ALL
SELECT tkey, 'thumb', revision FROM att WHERE tkey IS NOT NULL
ORDER BY 1
`.trim();
}

// ===========================================================================
// 判準（純函式）
// ===========================================================================

export interface RelationRow {
  readonly kind: string;
  readonly constraintName: string;
  readonly id: string;
  readonly target: string;
  readonly orphans: number;
}

/** psql `-tAF'|'` 之輸出逐行解析；欄數不符即整批拒收（不猜、不補）。 */
export function parseRelationRows(raw: string): RelationRow[] | null {
  const rows: RelationRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("|");
    if (parts.length !== 5) return null;
    const orphans = Number(parts[4]);
    if (!Number.isInteger(orphans) || orphans < 0) return null;
    rows.push({
      kind: parts[0] as string,
      constraintName: parts[1] as string,
      id: parts[2] as string,
      target: parts[3] as string,
      orphans,
    });
  }
  return rows;
}

export interface RelationVerdict {
  readonly ok: boolean;
  readonly code: SummaryCode | null;
  readonly fkCount: number;
  readonly fixedCount: number;
  readonly orphanTotal: number;
  /** 七項固定清單中，其宣告已被本次列舉結果證實在場的項數。 */
  readonly satisfiedFixedItems: number;
}

export function evaluateRelationalIntegrity(rows: readonly RelationRow[]): RelationVerdict {
  const fk = rows.filter((r) => r.kind === "fk");
  const fixed = rows.filter((r) => r.kind === "fixed");
  const orphanTotal = rows.reduce((sum, r) => sum + r.orphans, 0);
  const base = {
    fkCount: fk.length,
    fixedCount: fixed.length,
    orphanTotal,
    satisfiedFixedItems: 0,
  };

  // 走廊條款：列舉不到任何外鍵 ＝ 沒有東西可驗，**不是**「無孤兒」。
  if (fk.length === 0) {
    return { ...base, ok: false, code: "relation-enumeration-empty" };
  }
  // 複合外鍵之交叉積（見 `buildRelationalIntegritySql` 之已知限制）：拒絕給結論。
  const seen = new Set<string>();
  for (const row of fk) {
    if (seen.has(row.constraintName)) {
      return { ...base, ok: false, code: "relation-unsupported-composite-fk" };
    }
    seen.add(row.constraintName);
  }

  const enumerated = new Set(fk.map((r) => r.id));
  const fixedIds = new Set(fixed.map((r) => r.id));
  let satisfied = 0;
  for (const check of FIXED_RELATION_CHECKS) {
    if (check.fkBacked) {
      if (check.edges.every((edge) => enumerated.has(edge))) satisfied += 1;
    } else if (fixedIds.has(NON_FK_CHECK_ID) && !enumerated.has("Attachment.refId")) {
      // 雙向釘死：第⑤項既要真的被查了（在 `fixed` 列裡），也要真的**沒有**外鍵在守
      // 它——哪天有人替 `Attachment.refId` 補上外鍵，這一項的「唯一非恆真」地位就
      // 變了，清單必須有人重新判斷，不該靜默沿用。
      satisfied += 1;
    }
  }
  if (satisfied !== FIXED_RELATION_CHECKS.length) {
    return { ...base, ok: false, code: "relation-list-stale", satisfiedFixedItems: satisfied };
  }
  if (orphanTotal > 0) {
    return {
      ...base,
      ok: false,
      code: "relation-orphans-found",
      satisfiedFixedItems: satisfied,
    };
  }
  return { ...base, ok: true, code: null, satisfiedFixedItems: satisfied };
}

export interface AttachmentObject {
  readonly key: string;
  readonly kind: "original" | "thumb";
  readonly revision: boolean;
}

export function parseAttachmentObjects(raw: string): AttachmentObject[] | null {
  const rows: AttachmentObject[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("|");
    if (parts.length !== 3) return null;
    const kind = parts[1];
    if (kind !== "original" && kind !== "thumb") return null;
    rows.push({ key: parts[0] as string, kind, revision: parts[2] === "t" });
  }
  return rows;
}

/** AC-23(b) 之抽樣下限。 */
export const MIN_SAMPLE_SIZE = 3;

export interface SampleVerdict {
  readonly ok: boolean;
  readonly sample: readonly string[];
  readonly thumbCount: number;
  readonly revisionCount: number;
}

/**
 * AC-23(b) 抽樣：**≥3 個、含至少一個 `thumb`、含至少一個修正版副本**。
 *
 * 刻意**不隨機**（D13(c) 之代價欄逐字：「隨機性使失敗不可重現」）：先照鍵名排序，
 * 取第一個 thumb、第一個修正版副本，再依序補到 3 個為止。同一份備份每次抽到的
 * 樣本恆相同，失敗因而可重播。
 */
export function selectAttachmentSample(objects: readonly AttachmentObject[]): SampleVerdict {
  const sorted = [...objects].sort((a, b) => a.key.localeCompare(b.key));
  const picked: AttachmentObject[] = [];
  const take = (candidate: AttachmentObject | undefined) => {
    if (candidate !== undefined && !picked.some((p) => p.key === candidate.key)) {
      picked.push(candidate);
    }
  };
  const firstThumb = sorted.find((o) => o.kind === "thumb");
  const firstRevision = sorted.find((o) => o.revision);
  take(firstThumb);
  take(firstRevision);
  for (const candidate of sorted) {
    if (picked.length >= MIN_SAMPLE_SIZE) break;
    take(candidate);
  }

  const thumbCount = picked.filter((o) => o.kind === "thumb").length;
  const revisionCount = picked.filter((o) => o.revision).length;
  return {
    ok: picked.length >= MIN_SAMPLE_SIZE && thumbCount >= 1 && revisionCount >= 1,
    sample: picked.map((o) => o.key),
    thumbCount,
    revisionCount,
  };
}

// ===========================================================================
// 證據等級（M-6+M-8 合併判準；見檔頭）
// ===========================================================================

/** 涵蓋自檢 fail-closed 上線的那一版；早於它的備份無機械背書。 */
export const COVERAGE_VERIFIED_SCRIPT_REVISION = 2;

export interface BackupManifestShape {
  readonly coverage?: { readonly allowEmpty?: unknown };
  readonly tools?: { readonly script?: unknown };
  readonly parts?: ReadonlyArray<{ readonly file?: unknown; readonly sha256?: unknown }>;
}

/** `PHASE-011-T12/2` → 2；`PHASE-011-T12` → 1；無法判讀 → `null`（視同無背書）。 */
export function parseScriptRevision(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^PHASE-011-T12(?:\/(\d+))?$/.exec(raw.trim());
  if (m === null) return null;
  return m[1] === undefined ? 1 : Number(m[1]);
}

export function assessCoverageEvidence(manifest: BackupManifestShape): readonly string[] {
  const revision = parseScriptRevision(manifest.tools?.script);
  const unverified =
    manifest.coverage?.allowEmpty === true ||
    revision === null ||
    revision < COVERAGE_VERIFIED_SCRIPT_REVISION;
  return unverified ? ["coverage-unverified"] : [];
}

export function formatEvidence(tokens: readonly string[]): string {
  return tokens.length === 0 ? EVIDENCE_FULL : [...tokens].join(",");
}

// ===========================================================================
// CLI（僅 `scripts/verify-restore.sh` 使用；被測試匯入時不執行）
// ===========================================================================

export const CHECK_EXIT_OK = 0;
export const CHECK_EXIT_REJECTED = 1;
export const CHECK_EXIT_USAGE = 2;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 設定行（`KEY=VALUE`）＋ `PAYLOAD_SEPARATOR` ＋ 原始資料。 */
export function parseCliInput(raw: string): {
  readonly settings: Record<string, string>;
  readonly payload: string;
} {
  const lines = raw.split("\n");
  const settings: Record<string, string> = {};
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = (lines[index] as string).replace(/\r$/, "");
    if (line === PAYLOAD_SEPARATOR) {
      index += 1;
      break;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1);
    if (value === "") continue;
    settings[line.slice(0, eq)] = value;
  }
  return { settings, payload: lines.slice(index).join("\n") };
}

/** 失敗一律以 `summary=<code>` 開頭，供腳本原樣取用（見檔頭訊息紀律）。 */
function reject(code: SummaryCode, detail: string): CliResult {
  return { code: CHECK_EXIT_REJECTED, stdout: "", stderr: `summary=${code} ${detail}` };
}

function pickBackup(settings: Readonly<Record<string, string | undefined>>): CliResult {
  const destRoot = settings[DEST_ROOT_ENV];
  if (destRoot === undefined || destRoot.trim() === "") {
    return { code: CHECK_EXIT_USAGE, stdout: "", stderr: `${DEST_ROOT_ENV} is required` };
  }
  const explicit = settings[BACKUP_ID_ENV];
  let chosen: string | null = null;
  if (explicit !== undefined && explicit.trim() !== "") {
    chosen = parseBackupId(explicit.trim()) === null ? null : explicit.trim();
    if (chosen === null) {
      return reject("backup-not-found", `${BACKUP_ID_ENV} is not a valid backup id`);
    }
  } else {
    let newest = -1;
    if (fs.existsSync(destRoot)) {
      for (const dirent of fs.readdirSync(destRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        // 目錄名即事實（T12 交接：**不得**用 mtime——複製／rsync／防毒都會改它）
        const createdAtMs = parseBackupId(dirent.name);
        if (createdAtMs === null || createdAtMs <= newest) continue;
        newest = createdAtMs;
        chosen = dirent.name;
      }
    }
    if (chosen === null) {
      return reject("backup-not-found", `no backup directory found under ${DEST_ROOT_ENV}`);
    }
  }

  const dir = path.join(destRoot, chosen);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    return reject("backup-not-found", "the chosen backup has no manifest");
  }
  let manifest: BackupManifestShape;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    // 不繫結例外：`fs`／JSON 之訊息會逐字帶出絕對路徑。
    return reject("backup-manifest-unreadable", "the manifest could not be parsed");
  }
  const parts = manifest.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return reject("backup-manifest-unreadable", "the manifest declares no parts");
  }
  const shaFields: string[] = [];
  for (const file of ["db.dump", "attachments.tar", "reports.tar"]) {
    const part = parts.find((p) => p.file === file);
    if (
      part === undefined ||
      typeof part.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(part.sha256)
    ) {
      return reject("backup-manifest-unreadable", "the manifest is missing a part hash");
    }
    shaFields.push(`sha.${file}=${part.sha256}`);
  }
  const evidence = formatEvidence(assessCoverageEvidence(manifest));
  return {
    code: CHECK_EXIT_OK,
    stdout: `backup-id=${chosen} evidence=${evidence} ${shaFields.join(" ")}\n`,
    stderr: "",
  };
}

export function runRestoreCheckCli(
  argv: readonly string[],
  settings: Readonly<Record<string, string | undefined>>,
  payload: string
): CliResult {
  const command = argv[0];

  if (command === "check-target") {
    const verdict = evaluateRestoreTarget({
      sourceUrl: settings[SOURCE_URL_ENV] ?? "",
      targetUrl: settings[TARGET_URL_ENV] ?? "",
    });
    if (!verdict.ok) return reject(verdict.code, verdict.message);
    const { source, target } = verdict;
    return {
      code: CHECK_EXIT_OK,
      stdout: `target-ok src.host=${source.host} src.port=${source.port} src.user=${source.user} src.db=${source.database} src.schema=${source.schema} tgt.host=${target.host} tgt.port=${target.port} tgt.user=${target.user} tgt.db=${target.database}\n`,
      stderr: "",
    };
  }

  if (command === "pick-backup") return pickBackup(settings);

  if (
    command === "sql-relations" ||
    command === "sql-objects" ||
    command === "sql-migration-tail"
  ) {
    const schema = settings[VERIFY_SCHEMA_ENV];
    if (schema === undefined || !SAFE_IDENTIFIER.test(schema)) {
      return { code: CHECK_EXIT_USAGE, stdout: "", stderr: `${VERIFY_SCHEMA_ENV} is required` };
    }
    const sql =
      command === "sql-relations"
        ? buildRelationalIntegritySql(schema)
        : command === "sql-objects"
          ? buildAttachmentObjectSql(schema)
          : buildMigrationTailSql(schema);
    return { code: CHECK_EXIT_OK, stdout: `${sql}\n`, stderr: "" };
  }

  if (command === "check-relations") {
    const rows = parseRelationRows(payload);
    if (rows === null) return reject("relation-query-failed", "unparsable relation query output");
    const verdict = evaluateRelationalIntegrity(rows);
    if (!verdict.ok) {
      return reject(
        verdict.code as SummaryCode,
        `fk=${verdict.fkCount} fixed=${verdict.fixedCount} orphans=${verdict.orphanTotal} fixed-list=${verdict.satisfiedFixedItems}/${FIXED_RELATION_CHECKS.length}`
      );
    }
    return {
      code: CHECK_EXIT_OK,
      stdout: `relations checked=${rows.length} fk=${verdict.fkCount} fixed=${verdict.fixedCount} orphans=${verdict.orphanTotal} fixed-list=${verdict.satisfiedFixedItems}/${FIXED_RELATION_CHECKS.length}\n`,
      stderr: "",
    };
  }

  if (command === "check-sample") {
    const objects = parseAttachmentObjects(payload);
    if (objects === null) {
      return reject("attachment-sample-unavailable", "unparsable object query output");
    }
    const verdict = selectAttachmentSample(objects);
    if (!verdict.ok) {
      // 「抽不到」與「抽到了都對」異結局（走廊條款）；計數不含任何鍵值。
      return reject(
        "attachment-sample-unavailable",
        `n=${verdict.sample.length} thumb=${verdict.thumbCount} revision=${verdict.revisionCount} required>=${MIN_SAMPLE_SIZE}`
      );
    }
    return {
      code: CHECK_EXIT_OK,
      stdout: `sample n=${verdict.sample.length} thumb=${verdict.thumbCount} revision=${verdict.revisionCount}\n${verdict.sample.join("\n")}\n`,
      stderr: "",
    };
  }

  if (command === "record") {
    const result = formatVerificationRecord({
      timestamp: settings.RECORD_TIMESTAMP ?? "",
      backupId: settings.RECORD_BACKUP_ID ?? "unknown",
      stage: settings.RECORD_STAGE ?? "",
      summary: settings.RECORD_SUMMARY ?? "",
      exitCode: Number(settings.RECORD_EXIT_CODE ?? "not-a-number"),
      evidence: settings.RECORD_EVIDENCE ?? EVIDENCE_FULL,
    });
    if (!result.ok) return { code: CHECK_EXIT_USAGE, stdout: "", stderr: result.message };
    return { code: CHECK_EXIT_OK, stdout: `${result.line}\n`, stderr: "" };
  }

  return {
    code: CHECK_EXIT_USAGE,
    stdout: "",
    stderr:
      "usage: restore-check <check-target|pick-backup|sql-relations|sql-objects|sql-migration-tail|check-relations|check-sample|record> (settings via stdin)",
  };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("restore-check.ts") || process.argv[1].endsWith("restore-check.js"));

if (isMain) {
  const input = parseCliInput(fs.readFileSync(0, "utf8"));
  const result = runRestoreCheckCli(process.argv.slice(2), input.settings, input.payload);
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(`${result.stderr}\n`);
  process.exit(result.code);
}
