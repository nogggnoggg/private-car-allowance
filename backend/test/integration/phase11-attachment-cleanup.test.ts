/**
 * Integration test: PHASE-011 附件清理 — 判定／dry-run（T3）＋ 執行／批次／觸發
 * （T4）（`docs/specs/PHASE-011.md` **AC-03**～**AC-06**；§16 **D3**=(c)、
 * **D4**=(a)、**D6-1·2·3**=(a)）
 *
 * 本檔由**兩個並列的頂層 `describe`** 組成，各自播種、各自清理：
 *   · `PHASE-011-T3 …（AC-03／AC-04）`——引用判定之封閉來源集與 dry-run 唯讀；
 *   · `PHASE-011-T4 …（AC-05／AC-06）`——實際刪除、批次上限、部分失敗語意、
 *     CLI 觸發與可觀測性（**本專案唯一的不可逆刪除**；含常設之「守門缺席會誤刪」
 *     紅燈物證格與三型 mutant 自證）。T4 段之檔頭另有 **AR-1 保護強度據實記載**。
 *
 * ---------------------------------------------------------------------------
 * T3 段涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-03(a)** 封閉來源集常數 `ATTACHMENT_REFERENCE_SOURCES` ⇔ 實作所查
 *     Prisma model 集合之機械相等（含合成 mutant 之鑑別力自證）；
 *   · **AC-03(b)** 完整性守門：以 **Prisma DMMF** 列舉「今日資料層任何可能指向
 *     `Attachment` 之欄位」，與 `ATTACHMENT_INBOUND_REFERENCE_FIELDS` 逐項比對，
 *     並以 `information_schema`（外鍵面）＋ `schema.prisma` 文字（宣告面）兩式
 *     交叉覆核；三型合成 mutant 證明「新增指向附件之欄位而未入清單即必紅」且
 *     「反向關聯不得被誤擋」；
 *   · **AC-03(c)** `AuditLog.summary` 面之處置（D4=(a)：**刻意不含稽核面**）之
 *     負向記載型 `it` ＋ 稽核寫入站點清單之機械背書；
 *   · **AC-03(d)** 判定模組零副作用（結構面零寫入方法 ＋ 執行期前後全表快照）；
 *   · **AC-04(a)~(d)** dry-run 唯讀（DB 全表逐欄快照全等 ＋ storage 鍵集全等）、
 *     候選清單欄位封閉且零禁字、與實跑共用同一判定函式之結構斷言、冪等。
 *
 * ---------------------------------------------------------------------------
 * T3R（即審 REQUEST_CHANGES 之兩項 SF；本輪僅動本測試檔，`backend/src` 零 diff）
 * ---------------------------------------------------------------------------
 *   · **SF-1 — 第四把鑰匙無鑑別力**：reviewer 將 `depreciationContainerExists`
 *     整段消融為 `false`，原 29 格**全綠存活**（對照：TRIP_SEGMENT 消融 3 紅、
 *     MAINTENANCE 消融 4 紅）。根因是種子與 `subjects` 型別皆無 DEPRECIATION，
 *     且 AC-03(a) 之機械斷言以 **prismaModel 粒度**比對——MAINTENANCE 與
 *     DEPRECIATION 收斂為同一個 `application` delegate，結構上分辨不出第四把
 *     鑰匙有沒有被真的轉動。修法：新增種子 `tempDeprecRef`（指向**獨立的**
 *     DEPRECIATION Application）＋ 一格與 MAINTENANCE 對稱之鑑別力斷言。
 *   · **SF-2 — 寫入掃描器兩類可規避面**：`createManyAndReturn`（delegate 寫入，
 *     名字不在清單）與 `$queryRawUnsafe("DELETE …")`（raw 面，原正則只認
 *     `$executeRaw*`）皆零紅存活。後者尤其要緊：`$queryRaw*` 能執行
 *     `DELETE … RETURNING`，而「本模組零寫入」正是 T4 不可逆刪除的結構性前提。
 *     修法：`PRISMA_WRITE_METHODS` 補 `*AndReturn` 兩式；raw 正則改涵蓋任何
 *     `$…Raw…`。兩型並各留一則常設合成 mutant 斷言，防掃描器自身退化。
 *
 * ---------------------------------------------------------------------------
 * 首步 spike 結論（Spec §11.6 #3；Packet Done When 第一項）
 * ---------------------------------------------------------------------------
 * **可行，採用 Prisma DMMF 路徑**，不需退回「純文字掃描」替代方案。
 * `Prisma.dmmf.datamodel.models` 於本專案（`@prisma/client` 執行期）**可直接
 * 讀取**：實跑列出 17 個 model，其中「型別為 `Attachment` 之欄位」恰 2 條——
 * `User.attachmentsAsUploader` 與 `User.attachmentsAsOwner`，兩者
 * `relationFromFields` 皆為 `[]`（＝**不持有外鍵**，是 `Attachment.uploaderId`／
 * `ownerId` 的反向端），故「指向 `Attachment` 之欄位」today 為**空集**，與 Spec
 * AC-03(b) 之實查基線逐字相符（本 Task 已獨立覆核，見下「D4 實查」段）。
 * DMMF 之 `relationFromFields` 正是分辨「持有 FK 的那一側」與「反向端」的欄位，
 * 這使列舉不需要任何 SQL、不需要 DB 連線，且對「新增一條真的指向附件的欄位」
 * 具備結構性鑑別力（本檔三型合成 mutant 即證）。
 * 純文字掃描仍以**交叉覆核**身分保留（`schema.prisma` 型別欄位掃描），
 * 不是替代路徑而是第三道獨立證據。
 *
 * ---------------------------------------------------------------------------
 * D4 之「條件式升級授權」實查結果（Spec §19 `SPEC-011-GATE` 逐字：「T3 首步實查
 * `AuditLog.summary` 曾寫入 attachment id 即自動升 (b)，免回 Gate」）
 * ---------------------------------------------------------------------------
 * **實查結論：未觸發升級——維持 D4=(a)（不查稽核面）。** 兩路證據：
 *   ① **靜態全站點列舉**：`backend/src` 全樹之稽核寫入站點恰 **18** 處
 *      （13 處 `auditLog.create(` ＋ 5 處 `writeAudit({`），其中 `audit/audit.ts`
 *      之 1 處為共用寫入器（`summary` 由呼叫端提供），故**組裝 `summary` 內容
 *      之站點恰 17 處**。逐處實讀其 `summary`／`detail` 物件字面，鍵集合為：
 *      `role`／`employeeNumber`／`isActive`／`mustChangePassword`／
 *      `deletedLoginName`／`deletedDisplayName`／`applicationId`／`type`／
 *      `tripDate`／`purpose`／`segmentsCount`／`lastMaintenanceDate`／
 *      `currentMaintenanceDate`／`lastOdometerKm`／`currentOdometerKm`／
 *      `actualCost`／`applicationYear`／`annualTotalKm`／`reason`／`voidedAt`／
 *      `revisionOf`／`parameterType`／`fuelType`／`pricePerLiter`／`unitPrice`／
 *      `vehiclePrice`／`usefulLifeYears`／`effectiveFrom`／`before`／`after`／
 *      `basisNote`——**無任何一處寫入 attachment id**（附件 id 從不進入稽核；
 *      `targetLabel` 亦僅為 `loginName`／`loginName#applicationId` 形式）。
 *   ② **jsonb 抽查佐證**（Packet 授權之佐證手段）：**測試庫 `app_test`**
 *      （`backend/.env` 之 `DATABASE_URL` 所指，t1-pg:55432）136 筆 `AuditLog`
 *      × 97 筆 `Attachment`，以 `summary::text` 對全部現存 attachment id 逐一
 *      比對，命中數 **0**；抽出之 `summary` 頂層鍵集合亦與 ① 相符、零附件相關鍵。
 *
 * **證據等級（PHASE-011-T4R-DOC／NF-1 正名）**：① 之**靜態全站點查證才是決定性
 * 證據**，② 之資料快照僅為佐證。且該快照取自**測試庫 `app_test`**，**不是**
 * compose 的 dev DB `oilexpense`（後者實為 8 筆 `AuditLog`／1 筆 `Attachment`／
 * 0 筆 TEMP）——T3 與 T4 兩輪原記為「dev DB」，屬記載失準，於此正名。實質判斷
 * 不受影響（靜態查證與資料庫身分無關），但人工 Gate 引用數字時必須說對是哪個庫。
 * 故依 AC-03(c) 後半段，本檔以**負向記載型 `it`** 明示「本判定刻意不含稽核面」
 * 並載明理由（沿 `phase10-error-handler-leak.test.ts` 之「已知不可及」記載型
 * 格），另附一則**機械背書**：稽核寫入站點清單一旦變動（新增站點）即紅，
 * 強制下一位開發者重新回答「這個新 summary 是否寫入 attachment id」。
 *
 * ---------------------------------------------------------------------------
 * 判定面之實查基線（AC-03(b) 之 Spec 給定基線，本 Task 獨立覆核結果）
 * ---------------------------------------------------------------------------
 *   ① `schema.prisma` 全案**無任何 FK 指向 `Attachment`**（DMMF ＋
 *      `information_schema` ＋ 文字三式一致）；引用為**弱引用且方向相反**
 *      （`Attachment.refType`／`refId` → 容器）。
 *   ② `Report`／`VoidedReportFile` **零 `attachmentId` 欄位**（PDF 內嵌位元組
 *      而非引用），故結構性不構成引用——此判斷寫入
 *      `ATTACHMENT_INBOUND_REFERENCE_FIELDS` 之註解，並由本檔 (b) 之列舉守門
 *      背書：任一表日後新增指向附件之欄位，列舉即非空、清單比對即紅。
 *   ③ 故實際判定面恰四項＝`ATTACHMENT_REFERENCE_SOURCES`：status（`LINKED`
 *      恆保護）＋ 三型 `refType` 之容器存在性。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（§11.0／`CLAUDE.md`）
 * ---------------------------------------------------------------------------
 *   · 全程合成資料（虛構帳號／檔名／密碼雜湊）；零真實個資／secrets。
 *   · `loginName` 前綴 `p11t3`（不含 `_`／`%`）＋ 每次執行之隨機 `RUN_ID`。
 *   · 清理一律以本檔前綴／id 精確比對；**禁用**全域 `deleteMany({})`。
 *   · 全部 mutant 皆以**合成內容**於測試內執行，**不改真實檔**（`schema.prisma`
 *     為本 Task 之 Forbidden 檔，實檔 mutant 在此不可行；合成 mutant 反而是
 *     常設守門——每次 CI 都重跑，比一次性手改更強）。
 *   · 本檔**不觸碰** `phase10-user-delete-regression.test.ts`（其
 *     `information_schema` 三方 join 手法為**複製沿用**，非 import）。
 *
 * ---------------------------------------------------------------------------
 * 射程邊界
 * ---------------------------------------------------------------------------
 * storage 孤兒盤點（§16 D5=(c)）不在本檔（屬 T6）。
 * **AC-04(c) 之未竟義務已於 PHASE-011-T4 結清**：T3 當時只釘住 dry-run 側
 * （「dry-run 不自帶判定，只委派 `planCleanup`」），另一半「實跑執行器亦呼叫
 * `planCleanup`」現由 T4 段之 `AC-04(c) 另一半：實跑亦走同一判定路徑` describe
 * 承載（結構斷言 ＋ 執行期「實刪集合 ≡ 候選集合」各一格）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type CleanupLogEvent,
  type CleanupLogger,
  type CleanupRunOptions,
  type CleanupRunResult,
  runCleanup,
  runCleanupCli,
} from "../../src/attachment/cleanup-cli.js";
import {
  ATTACHMENT_INBOUND_REFERENCE_FIELDS,
  ATTACHMENT_REFERENCE_SOURCES,
  type AttachmentInboundField,
  type CleanupCandidate,
  DEFAULT_CLEANUP_BATCH_LIMIT,
  createHasReferenceQuery,
  dryRunCleanup,
  evaluateAttachmentReference,
  planCleanup,
} from "../../src/attachment/cleanup-service.js";
import { detachAttachmentsByIdsTx } from "../../src/attachment/lifecycle-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { getEnvOrTestDefaults, parseEnv } from "../../src/config/env.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";
import type { Storage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 刻意不含 `_`／`%`：可安全用於 Prisma `startsWith`（編譯為 SQL LIKE）。 */
const LOGIN_PREFIX = "p11t3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "../..");
const SRC_ROOT = path.join(BACKEND_ROOT, "src");
const CLEANUP_SERVICE_PATH = path.join(SRC_ROOT, "attachment/cleanup-service.ts");
const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma/schema.prisma");

// ---------------------------------------------------------------------------
// 靜態掃描核心（純函式：對「內容字串」操作，使真實檔掃描與合成 mutant 自證
// 共用同一份實作——沿 `phase10-audit-structure.test.ts` 之設計）
// ---------------------------------------------------------------------------

/** 去除區塊註解與行註解，以等長空白取代（保留換行位置，行號可還原）。 */
function stripComments(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** 遞迴列出 `dir` 下所有 `.ts` 檔（排除 `.test.ts`）。 */
function listTsFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFilesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Prisma delegate 之讀取方法（AC-03(a) 之「查詢」定義）。 */
const PRISMA_READ_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

/**
 * Prisma delegate 之寫入方法（AC-03(d) 之「副作用」定義，逐字取自 AC，
 * ＋ Prisma 之 `*AndReturn` 變體）。
 *
 * **T3R（即審 SF-2）**：原清單只列 AC 逐字的七個方法，reviewer 實證
 * `attachment.createManyAndReturn(...)` 可零紅存活——它是**真正的寫入**，只是
 * 名字不在清單裡。長者在前（`createManyAndReturn` 先於 `createMany` 先於
 * `create`）純為可讀性；正則交替本身會回溯，順序不影響正確性。
 */
const PRISMA_WRITE_METHODS = [
  "createManyAndReturn",
  "updateManyAndReturn",
  "createMany",
  "updateMany",
  "deleteMany",
  "create",
  "update",
  "delete",
  "upsert",
] as const;

/** DMMF model 名之 delegate 形式（首字小寫），如 `Attachment` → `attachment`。 */
const PRISMA_DELEGATE_NAMES: readonly string[] = Prisma.dmmf.datamodel.models.map(
  (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1)
);

function buildDelegateCallPattern(methods: readonly string[]): RegExp {
  return new RegExp(String.raw`\.\s*(\w+)\s*\.\s*(${methods.join("|")})\s*\(`, "g");
}

/**
 * 掃描內容中「對 Prisma delegate 之查詢」，回傳所觸及之 model delegate 名集合
 * （已排序去重）。`\s*` 天然涵蓋跨行寫法；非 model 名之同形呼叫（如
 * `array.find(...)`）因 delegate 名白名單而被排除。
 */
function scanQueriedPrismaModels(content: string): string[] {
  const cleaned = stripComments(content);
  const found = new Set<string>();
  const pattern = buildDelegateCallPattern([...PRISMA_READ_METHODS, ...PRISMA_WRITE_METHODS]);
  for (const match of cleaned.matchAll(pattern)) {
    if (PRISMA_DELEGATE_NAMES.includes(match[1])) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * 掃描內容中「對 Prisma delegate 之寫入」＋ **全部 raw 面**（任何 `$…Raw…`
 * 呼叫：`$executeRaw`／`$executeRawUnsafe`／`$queryRaw`／`$queryRawUnsafe`／
 * `$runCommandRaw`…），回傳 `model.method`／`$rawMethod` 形式之命中清單。
 *
 * **T3R（即審 SF-2）**：原正則只認 `$executeRaw(Unsafe)?`，reviewer 實證
 * `$queryRawUnsafe("DELETE …")` 可零紅存活——Postgres 的 `DELETE … RETURNING`
 * 是合法查詢，`$queryRaw*` 因此具備**完整刪除能力**，把它排除在「零寫入」宣稱之外
 * 是實質漏洞（且與本函式原註解自稱「涵蓋 raw 執行面」內部矛盾）。改為涵蓋任何
 * `$…Raw…`：本模組今日零 raw 呼叫，故此擴張零偽陽性，只是把宣稱做實。
 */
function scanPrismaWriteCalls(content: string): string[] {
  const cleaned = stripComments(content);
  const hits: string[] = [];
  const pattern = buildDelegateCallPattern(PRISMA_WRITE_METHODS);
  for (const match of cleaned.matchAll(pattern)) {
    if (PRISMA_DELEGATE_NAMES.includes(match[1])) hits.push(`${match[1]}.${match[2]}`);
  }
  for (const match of cleaned.matchAll(/\$\w*Raw\w*\s*[(`]/g)) {
    hits.push(match[0].replace(/\s*[(`]$/, ""));
  }
  return hits.sort();
}

/**
 * 取出 `export async function <name>(...)` 之函式主體（大括號配對）。
 * 本檔之被掃描目標（`cleanup-service.ts`）刻意不使用參數解構，故簽章內不會
 * 出現大括號，配對從簽章後第一個 `{` 起算即正確。
 */
function extractFunctionBody(content: string, name: string): string {
  const cleaned = stripComments(content);
  const signature = new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\s*\(`);
  const start = cleaned.search(signature);
  if (start < 0) throw new Error(`extractFunctionBody: 找不到 export function ${name}`);
  const bodyStart = cleaned.indexOf("{", cleaned.indexOf(")", start));
  let depth = 0;
  for (let i = bodyStart; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`extractFunctionBody: ${name} 之大括號未配對`);
}

/** 計算「函式宣告」出現次數（`function <name>(`）。 */
function countDefinitions(content: string, identifier: string): number {
  const cleaned = stripComments(content);
  const pattern = new RegExp(String.raw`\bfunction\s+${identifier}\s*\(`, "g");
  return [...cleaned.matchAll(pattern)].length;
}

/** 計算「呼叫站點」出現次數（已扣除函式宣告本身）。 */
function countCallSites(content: string, identifier: string): number {
  const cleaned = stripComments(content).replace(
    new RegExp(String.raw`\bfunction\s+${identifier}\s*\(`, "g"),
    " "
  );
  const pattern = new RegExp(String.raw`\b${identifier}\s*\(`, "g");
  return [...cleaned.matchAll(pattern)].length;
}

// ---------------------------------------------------------------------------
// AC-03(b) — DMMF 列舉核心（純函式，供真實 datamodel 與合成 mutant 共用）
// ---------------------------------------------------------------------------

interface DmmfLikeField {
  readonly name: string;
  readonly type: string;
  readonly kind: string;
  readonly relationFromFields?: readonly string[] | null;
}

interface DmmfLikeModel {
  readonly name: string;
  readonly fields: readonly DmmfLikeField[];
}

/**
 * 列舉「今日資料層中任何**可能指向 `Attachment`** 之欄位」（AC-03(b) 逐字）。
 *
 * 兩式互補（Spec §11.6 #3 逐字：「型別為 `Attachment` 之關聯」與「欄名含
 * `attachment`」兩式互補）：
 *   ① **關聯式**：欄位型別為 `Attachment` **且** `relationFromFields` 非空
 *      ——`relationFromFields` 非空代表**這一側持有外鍵**，即真正的「指向」；
 *      反向端（如 `User.attachmentsAsUploader`，`relationFromFields` 為 `[]`）
 *      是 `Attachment` 指向 `User`，方向相反，**不得**誤入清單（否則守門會被
 *      永久性的偽陽性淹沒而失去意義）。
 *   ② **命名式**：`Attachment` 以外之 model 上、欄名含 `attachment`（不分大小
 *      寫）之 **scalar** 欄位——涵蓋「有欄位但未宣告 relation」之弱引用型
 *      （如日後在 `Report` 上加一個裸的 `attachmentId String?`）。
 *
 * `Attachment` model 自身排除：其 `refType`／`refId` 是**反方向**的弱引用
 * （附件 → 容器），屬 `ATTACHMENT_REFERENCE_SOURCES` 之判定面，不是「指向附件」。
 *
 * 偏保守（可能偽陽性，如將來出現名為 `attachmentNote` 的純文字欄）是**刻意**
 * 的：偽陽性只會強迫一次人工宣告，偽陰性則會讓誤刪成真。
 */
function enumerateAttachmentInboundFields(
  models: readonly DmmfLikeModel[]
): AttachmentInboundField[] {
  const found: AttachmentInboundField[] = [];
  for (const model of models) {
    if (model.name === "Attachment") continue;
    for (const field of model.fields) {
      const holdsForeignKeyToAttachment =
        field.type === "Attachment" && (field.relationFromFields?.length ?? 0) > 0;
      const attachmentNamedScalar = field.kind === "scalar" && /attachment/i.test(field.name);
      if (holdsForeignKeyToAttachment || attachmentNamedScalar) {
        found.push({ model: model.name, field: field.name });
      }
    }
  }
  return found.sort((a, b) => `${a.model}.${a.field}`.localeCompare(`${b.model}.${b.field}`));
}

/** 真實 DMMF → 本檔之最小結構（避免與 Prisma 之 ReadonlyDeep 型別糾纏）。 */
function realDatamodelModels(): DmmfLikeModel[] {
  return Prisma.dmmf.datamodel.models.map((model) => ({
    name: model.name,
    fields: model.fields.map((field) => ({
      name: field.name,
      type: String(field.type),
      kind: String(field.kind),
      relationFromFields: field.relationFromFields ?? null,
    })),
  }));
}

// ---------------------------------------------------------------------------
// AC-03(b) — schema.prisma 文字交叉覆核（第三道獨立證據）
// ---------------------------------------------------------------------------

/**
 * 以純文字掃描 `schema.prisma`，回傳「型別為 `Attachment` 之欄位」之
 * `Model.field` 清單（`Attachment` model 自身除外）。
 */
function scanSchemaTextForAttachmentTypedFields(schemaText: string): string[] {
  const lines = schemaText.split("\n");
  const found: string[] = [];
  let currentModel: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const modelStart = line.match(/^model\s+(\w+)\s*\{/);
    if (modelStart) {
      currentModel = modelStart[1];
      continue;
    }
    if (line === "}") {
      currentModel = null;
      continue;
    }
    if (!currentModel || currentModel === "Attachment") continue;
    const field = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?/);
    if (field && field[2] === "Attachment") found.push(`${currentModel}.${field[1]}`);
  }
  return found.sort();
}

/**
 * 以純文字掃描 `schema.prisma`，回傳「欄名含 `attachment`（不分大小寫）」之
 * `Model.field` 清單（`Attachment` model 自身除外）——涵蓋 `Report`／
 * `VoidedReportFile` 之「零 `attachmentId` 欄位」實查基線。
 */
function scanSchemaTextForAttachmentNamedFields(schemaText: string): string[] {
  const lines = schemaText.split("\n");
  const found: string[] = [];
  let currentModel: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const modelStart = line.match(/^model\s+(\w+)\s*\{/);
    if (modelStart) {
      currentModel = modelStart[1];
      continue;
    }
    if (line === "}") {
      currentModel = null;
      continue;
    }
    if (!currentModel || currentModel === "Attachment") continue;
    const field = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?/);
    if (field && /attachment/i.test(field[1])) found.push(`${currentModel}.${field[1]}`);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// AC-03(b) — information_schema 交叉覆核（外鍵面；手法沿
// `phase10-user-delete-regression.test.ts` :163 之三方 join，複製非 import）
// ---------------------------------------------------------------------------

/**
 * 列舉本 worker schema 內「指向 `Attachment`」之全部外鍵。
 * 一律以 `constraint_schema = current_schema()` 侷限於本 worker 自己的 schema
 * ——`information_schema` 是 cluster 範圍的視圖，不侷限即會把其他 worker
 * schema 的同名約束一併聚合進來。
 */
const ATTACHMENT_FK_SQL = `
  SELECT
    rc.constraint_name AS constraint_name,
    kcu.table_name     AS referencing_table,
    kcu.column_name    AS referencing_column,
    rc.delete_rule     AS delete_rule
  FROM information_schema.referential_constraints rc
  JOIN information_schema.key_column_usage kcu
    ON  kcu.constraint_name   = rc.constraint_name
    AND kcu.constraint_schema = rc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON  ccu.constraint_name   = rc.unique_constraint_name
    AND ccu.constraint_schema = rc.unique_constraint_schema
  WHERE rc.constraint_schema = current_schema()
    AND ccu.table_name = 'Attachment'
  ORDER BY kcu.table_name, kcu.column_name
`;

interface FkRow {
  constraint_name: string;
  referencing_table: string;
  referencing_column: string;
  delete_rule: string;
}

// ---------------------------------------------------------------------------
// AC-03(c) — 稽核寫入站點之機械背書（D4 條件式升級條款之常設哨兵）
// ---------------------------------------------------------------------------

/**
 * `backend/src` 全樹之稽核寫入站點清單（檔案 → 站點數）。
 *
 * 站點數 ＝ `auditLog.create(` ＋ `writeAudit({` 之命中數（去註解後）。
 * 本清單是 **D4 條件式升級條款**（Spec §19 `SPEC-011-GATE`：「T3 首步實查
 * `AuditLog.summary` 曾寫入 attachment id 即自動升 (b)」）的常設哨兵：T3 已逐處
 * 實讀全部站點之 `summary`／`detail` 物件字面，確認**無任一處寫入 attachment
 * id**；日後任何人新增稽核寫入站點，本斷言即紅，強迫他重新回答同一個問題。
 */
const DECLARED_AUDIT_WRITE_SITES: Readonly<Record<string, number>> = {
  "admin/routes.ts": 8,
  "applications/routes.ts": 5,
  "audit/audit.ts": 1,
  "parameters/routes.ts": 3,
  "users/fuel-consumption-routes.ts": 1,
};

function scanAuditWriteSites(root: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of listTsFilesRecursive(root)) {
    const cleaned = stripComments(fs.readFileSync(file, "utf8"));
    const creates = [...cleaned.matchAll(/\bauditLog\s*\.\s*create\s*\(/g)].length;
    const writes = [...cleaned.matchAll(/\bwriteAudit\s*\(\s*\{/g)].length;
    if (creates + writes > 0) {
      result[path.relative(root, file).split(path.sep).join("/")] = creates + writes;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 合成資料 helpers
// ---------------------------------------------------------------------------

const TTL_HOURS = 24;
/** 固定注入之「現在」——使 `overdueHours` 與冪等比對完全決定性。 */
const NOW = new Date("2031-03-05T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

/** storage root 下之全部相對檔案鍵（排序）——AC-04(a) 之「物件鍵集合」。 */
function listStorageKeys(root: string): string[] {
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
    return out;
  };
  return walk(root).sort();
}

describeWithDb("PHASE-011-T3 — 附件清理之引用判定與 dry-run（AC-03／AC-04）", () => {
  let prisma: PrismaClient;
  let storageRoot: string;

  let ownerId: string;
  /** 存在之 MAINTENANCE 容器（`Application.id` 即 `refId`）。 */
  let maintenanceApplicationId: string;
  /**
   * 存在之 DEPRECIATION 容器（T3R／即審 SF-1）。
   * **刻意與 `maintenanceApplicationId` 為不同列**：兩型 refType 都查同一個
   * `application` delegate，共用同一列會讓「DEPRECIATION 分支是否真的有跑」
   * 無法分辨（誤把 MAINTENANCE 分支的命中當成 DEPRECIATION 的證據）。
   */
  let depreciationApplicationId: string;
  /** 存在之 TRIP_SEGMENT 容器。 */
  let tripSegmentId: string;
  let travelApplicationId: string;

  const attachmentIds: Record<string, string> = {};
  /** 判定用之附件欄位快照（供 `evaluateAttachmentReference` 直接呼叫）。 */
  const subjects: Record<
    string,
    {
      id: string;
      status: string;
      refType: "TRIP_SEGMENT" | "MAINTENANCE" | "DEPRECIATION" | null;
      refId: string | null;
    }
  > = {};

  const cleanupServiceSource = fs.readFileSync(CLEANUP_SERVICE_PATH, "utf8");
  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");

  beforeAll(async () => {
    prisma = new PrismaClient();

    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner${RUN_ID}`,
        displayName: "清理判定測試用人員",
        passwordHash: await hashPassword("Nq6-Lantern-Fennel-7"),
        role: "USER",
      },
    });
    ownerId = owner.id;

    const maintenanceApp = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-01-05T00:00:00.000Z"),
      },
    });
    maintenanceApplicationId = maintenanceApp.id;

    // T3R（即審 SF-1）：DEPRECIATION 分支專屬容器，與保養容器分屬不同列。
    const depreciationApp = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-01-07T00:00:00.000Z"),
      },
    });
    depreciationApplicationId = depreciationApp.id;

    const travelApp = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-01-06T00:00:00.000Z"),
        travel: { create: { tripDate: new Date("2031-01-06T00:00:00.000Z") } },
      },
    });
    travelApplicationId = travelApp.id;

    const segment = await prisma.tripSegment.create({
      data: { travelApplicationId, sortOrder: 0, origin: "甲地", destination: "乙地" },
    });
    tripSegmentId = segment.id;

    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t3-${RUN_ID}-`));
    const storage = new LocalVolumeStorage(storageRoot);

    /**
     * 七筆附件（合成）：
     *   tempExpired         TEMP，逾期 → 候選
     *   tempFresh           TEMP，未逾期 → 非候選
     *   tempBoundary        TEMP，恰在 TTL 邊界（`elapsed = TTL`）→ 非候選
     *   linkedAncient       LINKED（MAINTENANCE 容器在場）→ 恆非候選、有引用
     *   tempDanglingRef     TEMP、逾期、`refId` 指向已不存在之容器（B-04）→ 候選
     *   tempReferencedRef   TEMP、逾期、`refId` 指向**存在**之 TripSegment → 有引用、非候選
     *   tempDeprecRef       TEMP、逾期、`refId` 指向**存在**之 DEPRECIATION 容器
     *                       → 有引用、非候選（**T3R／即審 SF-1**：補上第四把鑰匙的
     *                       鑑別力——在此之前把 `depreciationContainerExists` 整段
     *                       消融為 `false`，29 格可全綠存活）
     */
    const seeds: Array<{
      key: string;
      status: "TEMP" | "LINKED";
      createdAt: Date;
      refType: "TRIP_SEGMENT" | "MAINTENANCE" | "DEPRECIATION" | null;
      refId: string | null;
    }> = [
      { key: "tempExpired", status: "TEMP", createdAt: hoursAgo(25), refType: null, refId: null },
      { key: "tempFresh", status: "TEMP", createdAt: hoursAgo(1), refType: null, refId: null },
      { key: "tempBoundary", status: "TEMP", createdAt: hoursAgo(24), refType: null, refId: null },
      {
        key: "linkedAncient",
        status: "LINKED",
        createdAt: hoursAgo(9000),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      },
      {
        key: "tempDanglingRef",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "TRIP_SEGMENT",
        refId: `${RUN_ID}-no-such-segment`,
      },
      {
        key: "tempReferencedRef",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "TRIP_SEGMENT",
        refId: tripSegmentId,
      },
      {
        key: "tempDeprecRef",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "DEPRECIATION",
        refId: depreciationApplicationId,
      },
    ];

    for (const seed of seeds) {
      const created = await prisma.attachment.create({
        data: {
          status: seed.status,
          storageKey: `att/${RUN_ID}-${seed.key}/original`,
          thumbnailKey: `att/${RUN_ID}-${seed.key}/thumb`,
          mimeType: "image/jpeg",
          byteSize: 128,
          originalFilename: `合成收據-${seed.key}.jpg`,
          uploaderId: ownerId,
          ownerId,
          refType: seed.refType,
          refId: seed.refId,
          createdAt: seed.createdAt,
          linkedAt: seed.status === "LINKED" ? seed.createdAt : null,
        },
      });
      attachmentIds[seed.key] = created.id;
      subjects[seed.key] = {
        id: created.id,
        status: seed.status,
        refType: seed.refType,
        refId: seed.refId,
      };
      await storage.put(created.storageKey, Buffer.alloc(128, 0xaa), "image/jpeg");
    }
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.attachment.deleteMany({ where: { id: { in: Object.values(attachmentIds) } } });
      await prisma.tripSegment.deleteMany({ where: { travelApplicationId } });
      await prisma.application.deleteMany({
        where: {
          id: { in: [maintenanceApplicationId, depreciationApplicationId, travelApplicationId] },
        },
      });
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
    if (storageRoot && fs.existsSync(storageRoot)) {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // AC-03(a) 封閉來源集
  // =========================================================================

  describe("AC-03: 引用判定之封閉來源集", () => {
    it("(a) 實作所查來源集恰等於宣告常數", () => {
      const declared = [...new Set(ATTACHMENT_REFERENCE_SOURCES.map((s) => s.prismaModel))].sort();
      const actual = scanQueriedPrismaModels(cleanupServiceSource);
      expect(actual).toEqual(declared);
    });

    it("(a) 宣告常數本身為封閉集：鍵唯一、非空、且每一鍵皆為判定輸出之逐項依據", async () => {
      const keys = ATTACHMENT_REFERENCE_SOURCES.map((s) => s.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);

      const verdict = await evaluateAttachmentReference(prisma, subjects.tempExpired);
      expect(verdict.checks.map((c) => c.source)).toEqual(keys);
    });

    it("(a) 鑑別力：實作多查一個未宣告之來源即必紅（合成內容 mutant）", () => {
      const declared = [...new Set(ATTACHMENT_REFERENCE_SOURCES.map((s) => s.prismaModel))].sort();
      const mutated = `${cleanupServiceSource}\nasync function leak(p: PrismaTxLike) { return p.report.findMany({}); }\n`;
      const mutatedModels = scanQueriedPrismaModels(mutated);
      expect(mutatedModels).toContain("report");
      expect(mutatedModels).not.toEqual(declared);
    });

    // =======================================================================
    // AC-03(b) 完整性守門
    // =======================================================================

    it("(b) 列舉任何可能指向 Attachment 之欄位並與清單全等（DMMF）", () => {
      const enumerated = enumerateAttachmentInboundFields(realDatamodelModels());
      expect(enumerated).toEqual([...ATTACHMENT_INBOUND_REFERENCE_FIELDS]);
    });

    it("(b) 鑑別力①：新增裸 attachmentId 欄位而未入清單即必紅", () => {
      const mutant: DmmfLikeModel[] = [
        ...realDatamodelModels(),
        {
          name: "SyntheticReport",
          fields: [
            { name: "attachmentId", type: "String", kind: "scalar", relationFromFields: null },
          ],
        },
      ];
      const enumerated = enumerateAttachmentInboundFields(mutant);
      expect(enumerated).toContainEqual({ model: "SyntheticReport", field: "attachmentId" });
      expect(enumerated).not.toEqual([...ATTACHMENT_INBOUND_REFERENCE_FIELDS]);
    });

    it("(b) 鑑別力②：新增持有外鍵之 Attachment 關聯欄位而未入清單即必紅", () => {
      const mutant: DmmfLikeModel[] = [
        ...realDatamodelModels(),
        {
          name: "SyntheticReport",
          fields: [
            { name: "proof", type: "Attachment", kind: "object", relationFromFields: ["proofId"] },
          ],
        },
      ];
      const enumerated = enumerateAttachmentInboundFields(mutant);
      expect(enumerated).toContainEqual({ model: "SyntheticReport", field: "proof" });
      expect(enumerated).not.toEqual([...ATTACHMENT_INBOUND_REFERENCE_FIELDS]);
    });

    it("(b) 防過寬：反向關聯（不持有外鍵之 Attachment[]）不得被誤列入", () => {
      const benign: DmmfLikeModel[] = [
        ...realDatamodelModels(),
        {
          name: "SyntheticHolder",
          fields: [
            { name: "attachments", type: "Attachment", kind: "object", relationFromFields: [] },
          ],
        },
      ];
      expect(enumerateAttachmentInboundFields(benign)).toEqual([
        ...ATTACHMENT_INBOUND_REFERENCE_FIELDS,
      ]);
    });

    it("(b) 交叉覆核①：information_schema 列舉指向 Attachment 之外鍵為空集", async () => {
      const rows = await prisma.$queryRawUnsafe<FkRow[]>(ATTACHMENT_FK_SQL);
      expect(rows).toEqual([]);
    });

    it("(b) 交叉覆核②：schema.prisma 文字面之 Attachment 型別欄位恰為 User 之兩條反向關聯", () => {
      expect(scanSchemaTextForAttachmentTypedFields(schemaText)).toEqual([
        "User.attachmentsAsOwner",
        "User.attachmentsAsUploader",
      ]);
    });

    it("(b) 交叉覆核③：Report／VoidedReportFile 零 attachmentId 欄位（欄名文字面）", () => {
      const named = scanSchemaTextForAttachmentNamedFields(schemaText);
      expect(named.filter((f) => f.startsWith("Report."))).toEqual([]);
      expect(named.filter((f) => f.startsWith("VoidedReportFile."))).toEqual([]);
      expect(named).toEqual(["User.attachmentsAsOwner", "User.attachmentsAsUploader"]);
    });

    // =======================================================================
    // AC-03(c) 稽核面之處置（D4=(a)：刻意不含）
    // =======================================================================

    it("(c) 本判定刻意不含稽核面（D4=(a) 記載型；理由見下）", () => {
      // 【記載型 `it`，沿 `phase10-error-handler-leak.test.ts` 之「已知不可及」格】
      //
      // BE-US-25⑥ 逐字含「報表或稽核資料引用」，但**現行資料層無對應形式**：
      //   · 報表面：`Report`／`VoidedReportFile` 零 `attachmentId` 欄位（PDF 內嵌
      //     位元組而非引用）——已由本 describe 之 (b) 交叉覆核③ 機械背書；
      //   · 稽核面：`AuditLog.summary` 之 17 處組裝站點逐處實讀，無任一處寫入
      //     attachment id（決定性證據）；**測試庫 `app_test`**（非 compose 之
      //     dev DB `oilexpense`——T4R-DOC／NF-1 正名）136 筆 × 97 附件之 jsonb
      //     抽查命中 0，屬佐證（檔頭「D4 之條件式升級授權實查結果」段有完整證據）。
      // 故 D4 之條件式升級**未觸發**，判定維持 (a)：不查稽核面。
      // 若日後有人讓 attachment id 進入 `summary`，下一則斷言（站點清單）會先紅。
      const auditSources = ATTACHMENT_REFERENCE_SOURCES.filter((s) => s.key.includes("AUDIT"));
      expect(auditSources).toEqual([]);
      expect(scanQueriedPrismaModels(cleanupServiceSource)).not.toContain("auditLog");
    });

    it("(c) 機械背書：稽核寫入站點清單零變動（新增站點即紅，強制重新判定 D4）", () => {
      expect(scanAuditWriteSites(SRC_ROOT)).toEqual(DECLARED_AUDIT_WRITE_SITES);
    });

    // =======================================================================
    // AC-03(d) 零副作用
    // =======================================================================

    it("(d) 判定模組零副作用 — 零 create/update/delete/deleteMany/upsert 之結構斷言", () => {
      expect(scanPrismaWriteCalls(cleanupServiceSource)).toEqual([]);
    });

    it("(d) 鑑別力：模組內任一寫入呼叫即必紅（合成內容 mutant，含 AndReturn 與 raw 兩型規避）", () => {
      const mutated = `${cleanupServiceSource}\nasync function wipe(p: PrismaTxLike) { await p.attachment.deleteMany({}); }\n`;
      expect(scanPrismaWriteCalls(mutated)).toEqual(["attachment.deleteMany"]);

      // T3R（即審 SF-2）：兩型「名字不在清單裡的真寫入」——修法前皆零紅存活。
      const andReturnMutant = `${cleanupServiceSource}\nasync function bulk(p: PrismaTxLike) { await p.attachment.createManyAndReturn({ data: [] }); }\n`;
      expect(scanPrismaWriteCalls(andReturnMutant)).toEqual(["attachment.createManyAndReturn"]);

      // `$queryRawUnsafe` 具完整刪除能力（`DELETE … RETURNING` 是合法查詢）。
      const rawMutant = `${cleanupServiceSource}\nasync function rawWipe(p: PrismaTxLike) { await p.$queryRawUnsafe('DELETE FROM "Attachment" RETURNING id'); }\n`;
      expect(scanPrismaWriteCalls(rawMutant)).toEqual(["$queryRawUnsafe"]);
    });

    it("(d) 執行期零寫入：逐筆判定前後之 Attachment 全表逐欄快照全等", async () => {
      const before = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
      for (const subject of Object.values(subjects)) {
        await evaluateAttachmentReference(prisma, subject);
      }
      const query = createHasReferenceQuery(prisma);
      for (const id of Object.values(attachmentIds)) {
        await query.hasReference(id);
      }
      const after = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
      expect(after).toEqual(before);
    });

    // =======================================================================
    // 判定行為（各來源之鑑別力；AC-03(a) 之「逐項結果」語意）
    // =======================================================================

    it("判定：status=LINKED 恆有引用（不論多舊）", async () => {
      const verdict = await evaluateAttachmentReference(prisma, subjects.linkedAncient);
      expect(verdict.hasReference).toBe(true);
      expect(verdict.checks).toContainEqual({
        source: "ATTACHMENT_STATUS_LINKED",
        referenced: true,
      });
    });

    it("判定：TEMP 且 refId 指向存在之 TRIP_SEGMENT 容器 → 有引用", async () => {
      const verdict = await evaluateAttachmentReference(prisma, subjects.tempReferencedRef);
      expect(verdict.hasReference).toBe(true);
      expect(verdict.checks).toContainEqual({ source: "TRIP_SEGMENT_CONTAINER", referenced: true });
      expect(verdict.checks).toContainEqual({
        source: "ATTACHMENT_STATUS_LINKED",
        referenced: false,
      });
    });

    it("判定：MAINTENANCE 容器存在性來源具鑑別力（容器在場 → 有引用）", async () => {
      // 【T3R 關閉確認之取捨註記，PHASE-011-T4 補記】本格用的是 **inline subject**
      // （借 `tempExpired` 的 id ＋ 就地指定 refType/refId），下一格 DEPRECIATION
      // 則用**真實種子** `tempDeprecRef`。兩形制刻意並存：inline 便宜、可任意組合
      // 欄位，但它繞過 DB 真值，證不了「這個組合真的存在於表裡」；種子形制較貴，
      // 但 SF-1 那類「第四把鑰匙沒轉動也全綠」的漏洞只有種子形制擋得住（因為
      // 消融後真實查詢會落空）。判準：**要證來源分支被真的走過就用種子；只證欄位
      // 組合之邏輯就用 inline。**
      const verdict = await evaluateAttachmentReference(prisma, {
        id: attachmentIds.tempExpired,
        status: "TEMP",
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });
      expect(verdict.hasReference).toBe(true);
      expect(verdict.checks).toContainEqual({
        source: "MAINTENANCE_APPLICATION_CONTAINER",
        referenced: true,
      });
    });

    it("判定：DEPRECIATION 容器存在性來源具鑑別力（容器在場 → 有引用）", async () => {
      // T3R（即審 SF-1）：與上一格對稱，但刻意指向**另一列** Application
      // （`depreciationApplicationId` ≠ `maintenanceApplicationId`），使本格只能
      // 由 DEPRECIATION 分支通過——把 `depreciationContainerExists` 消融為 false
      // 時本格必紅（SF-1 前的 29 格對該消融全數存活）。
      const verdict = await evaluateAttachmentReference(prisma, subjects.tempDeprecRef);
      expect(verdict.hasReference).toBe(true);
      expect(verdict.checks).toContainEqual({
        source: "DEPRECIATION_APPLICATION_CONTAINER",
        referenced: true,
      });
      expect(verdict.checks).toContainEqual({
        source: "MAINTENANCE_APPLICATION_CONTAINER",
        referenced: false,
      });
      expect(verdict.checks).toContainEqual({
        source: "TRIP_SEGMENT_CONTAINER",
        referenced: false,
      });
    });

    it("判定：B-04 孤兒弱引用（容器已不存在）視為無引用", async () => {
      const verdict = await evaluateAttachmentReference(prisma, subjects.tempDanglingRef);
      expect(verdict.hasReference).toBe(false);
      expect(verdict.checks.every((c) => c.referenced === false)).toBe(true);
    });

    it("判定：TEMP 無 ref → 全來源皆 false", async () => {
      const verdict = await evaluateAttachmentReference(prisma, subjects.tempExpired);
      expect(verdict.hasReference).toBe(false);
    });

    it("createHasReferenceQuery 符合 HasReferenceQuery 契約（含不存在 id → false）", async () => {
      const query = createHasReferenceQuery(prisma);
      expect(await query.hasReference(attachmentIds.linkedAncient)).toBe(true);
      expect(await query.hasReference(attachmentIds.tempExpired)).toBe(false);
      expect(await query.hasReference(`${RUN_ID}-no-such-attachment`)).toBe(false);
    });
  });

  // =========================================================================
  // AC-04 dry-run 唯讀模式
  // =========================================================================

  describe("AC-04: dry-run 唯讀模式", () => {
    it("(a) DB 全表逐欄快照全等 ＋ storage 鍵集全等", async () => {
      const dbBefore = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
      const storageBefore = listStorageKeys(storageRoot);

      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });

      const dbAfter = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
      const storageAfter = listStorageKeys(storageRoot);

      expect(dbAfter).toEqual(dbBefore);
      expect(storageAfter).toEqual(storageBefore);
      expect(storageAfter.length).toBe(7); // T3R：seed 由 6 筆增為 7 筆（SF-1）
      expect(report.dryRun).toBe(true);
    });

    it("(a) 候選集合恰為「TEMP ∧ 無引用 ∧ 嚴格逾期」者", async () => {
      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      const ids = report.candidates.map((c) => c.id).sort();
      expect(ids).toEqual([attachmentIds.tempExpired, attachmentIds.tempDanglingRef].sort());
      expect(report.scannedCount).toBe(6); // 七筆中的六筆 TEMP（LINKED 不入掃描；T3R 增 tempDeprecRef）
      expect(report.candidateCount).toBe(2);
    });

    it("(b) 候選清單欄位封閉（逐筆鍵集合 toEqual）", async () => {
      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(report.candidates.length).toBeGreaterThan(0);
      for (const candidate of report.candidates) {
        expect(Object.keys(candidate).sort()).toEqual([
          "createdAt",
          "id",
          "overdueHours",
          "referenceChecks",
          "status",
        ]);
        expect(candidate.status).toBe("TEMP");
        expect(candidate.overdueHours).toBeGreaterThan(0);
        expect(candidate.referenceChecks.map((c) => c.source)).toEqual(
          ATTACHMENT_REFERENCE_SOURCES.map((s) => s.key)
        );
        expect(candidate.referenceChecks.every((c) => c.referenced === false)).toBe(true);
      }
    });

    it("(b) 候選清單零禁字：storageKey／originalFilename／ownerId／uploaderId 皆不外露", async () => {
      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      const serialized = JSON.stringify(report);
      const rows = await prisma.attachment.findMany({
        where: { id: { in: Object.values(attachmentIds) } },
      });
      for (const row of rows) {
        expect(serialized).not.toContain(row.storageKey);
        expect(serialized).not.toContain(row.originalFilename);
        if (row.thumbnailKey) expect(serialized).not.toContain(row.thumbnailKey);
      }
      expect(serialized).not.toContain(ownerId);
      expect(serialized).not.toMatch(/storageKey|thumbnailKey|originalFilename|ownerId|uploaderId/);
    });

    it("(c) dry-run 與實跑共用同一判定函式之結構斷言", () => {
      // ① 模組內「判定」只有一份實作：引用判定與候選規劃各恰一處宣告，
      //    TTL 判定則一律委派既有純函式（恰一處呼叫，本檔零自製時間判斷）
      expect(countDefinitions(cleanupServiceSource, "evaluateAttachmentReference")).toBe(1);
      expect(countDefinitions(cleanupServiceSource, "planCleanup")).toBe(1);
      expect(countDefinitions(cleanupServiceSource, "dryRunCleanup")).toBe(1);
      expect(countCallSites(cleanupServiceSource, "isEligibleForCleanup")).toBe(1);
      // ② dry-run 不自帶判定：其函式體只委派 `planCleanup`，零 Prisma 查詢
      const dryRunBody = extractFunctionBody(cleanupServiceSource, "dryRunCleanup");
      expect(dryRunBody).toContain("planCleanup(");
      expect(scanQueriedPrismaModels(dryRunBody)).toEqual([]);
      expect(dryRunBody).not.toContain("evaluateAttachmentReference");
      expect(dryRunBody).not.toContain("isEligibleForCleanup");
      // ③ 執行期：dry-run 之候選與直接呼叫共用判定路徑之結果逐欄全等（下一格）
      // ④ 另一半（「實跑執行器亦呼叫 `planCleanup`」）已由 PHASE-011-T4 落地，
      //    見本檔 T4 段之 `AC-04(c) 另一半：實跑亦走同一判定路徑`——此處不再是
      //    未竟義務。
    });

    it("(c) 執行期：dry-run 候選 ≡ planCleanup 候選（非兩份複本）", async () => {
      const plan = await planCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(report.candidates).toEqual(plan.candidates);
      expect(report.scannedCount).toBe(plan.scannedCount);
      expect(report.candidateCount).toBe(plan.candidates.length);
    });

    it("(d) 連跑兩次輸出全等（冪等）", async () => {
      const first = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      const second = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(second).toEqual(first);
    });

    it("(d) 邊界：elapsed 恰等於 TTL 不入候選（嚴格大於，沿 isEligibleForCleanup :352）", async () => {
      const report = await dryRunCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      const ids = report.candidates.map((c: CleanupCandidate) => c.id);
      expect(ids).not.toContain(attachmentIds.tempBoundary);
      expect(ids).not.toContain(attachmentIds.tempFresh);
      expect(ids).not.toContain(attachmentIds.linkedAncient);
      expect(ids).not.toContain(attachmentIds.tempReferencedRef);
      expect(ids).not.toContain(attachmentIds.tempDeprecRef); // T3R（SF-1）
    });
  });
});

// ===========================================================================
// PHASE-011-T4 — 清理之執行、批次、觸發與可觀測性（AC-05／AC-06）
// ===========================================================================
//
// 本段與上方 T3 段共用同一個檔案（Spec §15 T4 檔案欄逐字：就地擴充），但**自帶
// 完整的種子與清理**：T3 之 `afterAll` 會在本段之 `beforeAll` 之前跑完並清空其
// 七筆附件，故本段起始時 `Attachment` 表為空（per-file TRUNCATE ＋ 同檔序列執
// 行）。這一點很要緊——`planCleanup` 掃的是**全表** `status=TEMP`，沒有 owner
// 過濾，所以每一格都必須自己控制全表內容。故本段：
//   · 每格自行播種、`afterEach` 精確清除（含 storage 目錄），格與格之間零殘留；
//   · 不觸碰 T3 之任何一格（T3／T3R 之 30 格一字不弱化）。
//
// ---------------------------------------------------------------------------
// 【AR-1／FW-3：保護強度之據實記載——人類將據此批准不可逆刪除】
// ---------------------------------------------------------------------------
// T3 即審已查明：**現行寫入路徑下，`status=TEMP` 之附件其 `refType`／`refId`
// 恆為 `null`**（上傳不帶 ref；`detachFieldSet` 於 detach 時一併清空並重設
// `createdAt`）。**決定性證據為靜態查證**——`status: "TEMP"` 之寫入站點恰二處，
// 兩處皆不留 ref；資料快照僅為佐證，且取自**測試庫 `app_test`** 而非 compose 之
// dev DB `oilexpense`（T4R-DOC／NF-1 正名，詳見本檔檔頭 ② 段）。
// 因此**今日實際生效之清理判準只有**：
//
//        status = TEMP  ∧  now − createdAt  嚴格大於  TTL
//
// 下方 `AC-05(b)②` 之三格（TRIP_SEGMENT／MAINTENANCE／DEPRECIATION 容器存在性）
// 所用的資料**刻意違反上述不變式**（TEMP 卻帶 refId），因為在合乎不變式的資料
// 上這三條來源恆為 false、無從測起。它們是**防禦縱深**（日後若有人寫出「TEMP
// 仍保留 ref」的路徑，保護立即生效），**不是今天擋在最前面的那道防線**。
// 每格內另有逐格標注，避免日後有人把「三型有引用保護」誤讀為日常防線。
// 今天真正在擋的是：①`LINKED` 一律不進掃描 ②TTL 嚴格大於 ③實刪路徑之**條件式
// 刪除**（`deleteCandidate` 之 `{ id, status:"TEMP", createdAt }` 三條件）。

const CLEANUP_CLI_PATH = path.join(SRC_ROOT, "attachment/cleanup-cli.ts");
const LIFECYCLE_SERVICE_PATH = path.join(SRC_ROOT, "attachment/lifecycle-service.ts");
const SERVER_PATH = path.join(SRC_ROOT, "server.ts");
const PACKAGE_JSON_PATH = path.join(BACKEND_ROOT, "package.json");
/** 刻意不含 `_`／`%`（同 T3），且與 `p11t3` 不同前綴，兩段互不清到對方。 */
const LOGIN_PREFIX_T4 = "p11t4";

/** 收集 `CleanupLogger` 事件，供「日誌零禁字」與階段順序斷言使用。 */
function makeLogCollector(): { events: CleanupLogEvent[]; logger: CleanupLogger } {
  const events: CleanupLogEvent[] = [];
  return { events, logger: { log: (event) => events.push(event) } };
}

interface SpyStorageOptions {
  /** 對這些 key 之 `delete` 拋出合成錯誤（錯誤訊息**刻意含 key**，用以檢驗日誌不外洩）。 */
  readonly failKeys?: readonly string[];
  /** 每次 `delete` 之前呼叫——用來在「storage 刪除當下」觀察 DB 列是否已消失。 */
  readonly onDelete?: (key: string) => Promise<void> | void;
}

/** 包一層 `Storage`，記錄刪除呼叫並可注入失敗（AC-05(c)／AC-06(d)）。 */
function makeSpyStorage(
  inner: Storage,
  options: SpyStorageOptions = {}
): { storage: Storage; deletedKeys: string[] } {
  const deletedKeys: string[] = [];
  const storage: Storage = {
    put: (key, bytes, contentType) => inner.put(key, bytes, contentType),
    get: (key) => inner.get(key),
    exists: (key) => inner.exists(key),
    delete: async (key) => {
      deletedKeys.push(key);
      if (options.onDelete) await options.onDelete(key);
      if (options.failKeys?.includes(key)) {
        // 訊息刻意逐字含 storage key（`LocalVolumeStorage`／`fs` 之真實錯誤即
        // 如此），故「日誌零 storageKey」之斷言若靠 `err.message` 就會紅。
        throw new Error(`合成 storage 刪除失敗：${key}`);
      }
      await inner.delete(key);
    },
  };
  return { storage, deletedKeys };
}

describeWithDb("PHASE-011-T4 — 附件清理之執行、批次、觸發與可觀測性（AC-05／AC-06）", () => {
  let prisma: PrismaClient;
  let storageRoot: string;
  let realStorage: Storage;

  let ownerId: string;
  let maintenanceApplicationId: string;
  let depreciationApplicationId: string;
  let travelApplicationId: string;
  let tripSegmentId: string;

  /** 本段所建立之全部附件 id（`afterEach` 逐一清除）。 */
  let createdAttachmentIds: string[] = [];

  const cleanupServiceSource = fs.readFileSync(CLEANUP_SERVICE_PATH, "utf8");
  const cleanupCliSource = fs.readFileSync(CLEANUP_CLI_PATH, "utf8");
  const lifecycleSource = fs.readFileSync(LIFECYCLE_SERVICE_PATH, "utf8");

  interface SeedSpec {
    readonly key: string;
    readonly status: "TEMP" | "LINKED";
    readonly createdAt: Date;
    readonly refType?: "TRIP_SEGMENT" | "MAINTENANCE" | "DEPRECIATION" | null;
    readonly refId?: string | null;
    /** 預設 `true`；`false` 用於 B-05（縮圖曾降級失敗）。 */
    readonly withThumb?: boolean;
    /** 預設 `true`；`false` 用於 B-06（DB 列在但位元組已不存在）。 */
    readonly withBytes?: boolean;
  }

  interface SeededAttachment {
    readonly id: string;
    readonly storageKey: string;
    readonly thumbnailKey: string | null;
  }

  async function seedAttachment(spec: SeedSpec): Promise<SeededAttachment> {
    const suffix = `${RUN_ID}-t4-${spec.key}-${createdAttachmentIds.length}`;
    const storageKey = `att/${suffix}/original`;
    const thumbnailKey = spec.withThumb === false ? null : `att/${suffix}/thumb`;
    const created = await prisma.attachment.create({
      data: {
        status: spec.status,
        storageKey,
        thumbnailKey,
        mimeType: "image/jpeg",
        byteSize: 128,
        originalFilename: `合成收據-${spec.key}.jpg`,
        uploaderId: ownerId,
        ownerId,
        refType: spec.refType ?? null,
        refId: spec.refId ?? null,
        createdAt: spec.createdAt,
        linkedAt: spec.status === "LINKED" ? spec.createdAt : null,
      },
    });
    createdAttachmentIds.push(created.id);
    if (spec.withBytes !== false) {
      await realStorage.put(storageKey, Buffer.alloc(128, 0xbb), "image/jpeg");
      if (thumbnailKey) await realStorage.put(thumbnailKey, Buffer.alloc(32, 0xcc), "image/jpeg");
    }
    return { id: created.id, storageKey, thumbnailKey };
  }

  /** 真實執行器之標準呼叫（實跑、批次上限給大值、注入決定性 `now`）。 */
  async function runReal(
    storage: Storage,
    overrides: Partial<CleanupRunOptions> = {}
  ): Promise<{ result: CleanupRunResult; events: CleanupLogEvent[] }> {
    const collector = makeLogCollector();
    const result = await runCleanup(prisma, storage, {
      now: NOW,
      ttlHours: TTL_HOURS,
      limit: 500,
      dryRun: false,
      logger: collector.logger,
      ...overrides,
    });
    return { result, events: collector.events };
  }

  async function rowExists(id: string): Promise<boolean> {
    return (await prisma.attachment.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();

    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX_T4}owner${RUN_ID}`,
        displayName: "清理執行測試用人員",
        passwordHash: await hashPassword("Kx4-Harbor-Juniper-2"),
        role: "USER",
      },
    });
    ownerId = owner.id;

    const maintenanceApp = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-02-05T00:00:00.000Z"),
      },
    });
    maintenanceApplicationId = maintenanceApp.id;

    const depreciationApp = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-02-07T00:00:00.000Z"),
      },
    });
    depreciationApplicationId = depreciationApp.id;

    const travelApp = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2031-02-06T00:00:00.000Z"),
        travel: { create: { tripDate: new Date("2031-02-06T00:00:00.000Z") } },
      },
    });
    travelApplicationId = travelApp.id;

    const segment = await prisma.tripSegment.create({
      data: { travelApplicationId, sortOrder: 0, origin: "丙地", destination: "丁地" },
    });
    tripSegmentId = segment.id;

    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p11t4-${RUN_ID}-`));
    realStorage = new LocalVolumeStorage(storageRoot);

    // 本段之全表前提：T3 段已於其 `afterAll` 清空其種子。若此處非空，代表同檔
    // 執行順序或清理紀律出了問題，讓它當場紅比讓後續格子詭異地失敗好。
    expect(await prisma.attachment.count()).toBe(0);
  }, 60_000);

  afterEach(async () => {
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      createdAttachmentIds = [];
    }
    // storage 亦逐格歸零（`att/` 是本專案唯一的附件前綴）。
    fs.rmSync(path.join(storageRoot, "att"), { recursive: true, force: true });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.tripSegment.deleteMany({ where: { travelApplicationId } });
      await prisma.application.deleteMany({
        where: {
          id: { in: [maintenanceApplicationId, depreciationApplicationId, travelApplicationId] },
        },
      });
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX_T4 } } });
      await prisma.$disconnect();
    }
    if (storageRoot && fs.existsSync(storageRoot)) {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // AC-05(a) 可刪
  // =========================================================================

  describe("AC-05(a): 可刪", () => {
    it("TEMP ∧ 無引用 ∧ 逾期 → DB 列與 original/thumb 位元組皆不存在", async () => {
      const seeded = await seedAttachment({
        key: "expired",
        status: "TEMP",
        createdAt: hoursAgo(25),
      });
      expect(await realStorage.exists(seeded.storageKey)).toBe(true);

      const { result } = await runReal(realStorage);

      expect(result.summary.deletedCount).toBe(1);
      expect(result.summary.failedCount).toBe(0);
      expect(result.summary.skippedCount).toBe(0);
      expect(await rowExists(seeded.id)).toBe(false);
      expect(await realStorage.exists(seeded.storageKey)).toBe(false);
      if (seeded.thumbnailKey) {
        expect(await realStorage.exists(seeded.thumbnailKey)).toBe(false);
      }
      expect(listStorageKeys(storageRoot)).toEqual([]);
    });

    it("AC-05(a)／§5-5: 以修正版草稿刪除後之複本構造亦可刪", async () => {
      // `KNOWN_ISSUES.md` :100 §5-5 之情境：修正版草稿被刪除後，PHASE-009-T6 複製
      // 出來的那份附件複本會留在系統裡。它的形狀不是本測試自己編的——這裡用**真實
      // 的 detach 路徑**（`detachAttachmentsByIdsTx`，即 `deleteApplication` 刪草稿
      // 時走的同一個函式）把 LINKED 複本轉成該形狀，再把 `createdAt`（＝ TTL 基準，
      // detach 會重設它）往回撥到逾期——「時間旅行」是唯一的合成成分。
      const copy = await seedAttachment({
        key: "revision-copy",
        status: "LINKED",
        createdAt: hoursAgo(200),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });
      expect(await detachAttachmentsByIdsTx(prisma, [copy.id])).toBe(1);
      await prisma.attachment.update({
        where: { id: copy.id },
        data: { createdAt: hoursAgo(25) },
      });

      const detached = await prisma.attachment.findUniqueOrThrow({ where: { id: copy.id } });
      expect(detached.status).toBe("TEMP");
      expect(detached.refType).toBeNull();
      expect(detached.refId).toBeNull();

      const { result } = await runReal(realStorage);

      expect(result.summary.deletedCount).toBe(1);
      expect(await rowExists(copy.id)).toBe(false);
      expect(await realStorage.exists(copy.storageKey)).toBe(false);
    });

    it("AC-05(a)／B-04: 孤兒弱引用（refId 指向已不存在之容器）為可刪而非不得刪", async () => {
      // B-04 是**唯一一條**「refId 非 null 卻仍會被真刪」的路徑（判定於 T3 定案：
      // 容器不存在＝沒有活體實體會再用到它，與 `deriveContainerState` 對同一情境
      // 之既有處置一致）。它同時是本 Phase 最需要人眼看過的一條——故 Spec §15.4
      // 之「清理啟用前人工 Gate」以真實 dry-run 候選清單為準，本格只保證語意。
      const orphan = await seedAttachment({
        key: "orphan",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "TRIP_SEGMENT",
        refId: `${RUN_ID}-no-such-segment`,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.candidateCount).toBe(1);
      expect(result.summary.deletedCount).toBe(1);
      expect(await rowExists(orphan.id)).toBe(false);
    });

    it("B-05／B-06: 縮圖從缺與位元組已不存在皆為 no-op，不計失敗", async () => {
      const noThumb = await seedAttachment({
        key: "no-thumb",
        status: "TEMP",
        createdAt: hoursAgo(30),
        withThumb: false,
      });
      const noBytes = await seedAttachment({
        key: "no-bytes",
        status: "TEMP",
        createdAt: hoursAgo(31),
        withBytes: false,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.deletedCount).toBe(2);
      expect(result.summary.failedCount).toBe(0);
      expect(await rowExists(noThumb.id)).toBe(false);
      expect(await rowExists(noBytes.id)).toBe(false);
      expect(listStorageKeys(storageRoot)).toEqual([]);
    });
  });

  // =========================================================================
  // AC-05(b) 不得刪三型
  // =========================================================================

  describe("AC-05(b): 不得刪三型", () => {
    it("①LINKED 不論多舊", async () => {
      const linked = await seedAttachment({
        key: "linked-ancient",
        status: "LINKED",
        createdAt: hoursAgo(9000),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.scannedCount).toBe(0); // LINKED 連掃描都不進入
      expect(result.summary.deletedCount).toBe(0);
      expect(await rowExists(linked.id)).toBe(true);
      expect(await realStorage.exists(linked.storageKey)).toBe(true);
    });

    it("②TEMP 有引用 — TRIP_SEGMENT 容器在場", async () => {
      // 【AR-1】此列 TEMP 卻帶 refId，**刻意違反現行不變式**（見本段檔頭）：今日
      // 寫入路徑不會產生這種列，本格測的是防禦縱深而非日常防線。
      const referenced = await seedAttachment({
        key: "ref-trip",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "TRIP_SEGMENT",
        refId: tripSegmentId,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.scannedCount).toBe(1);
      expect(result.summary.candidateCount).toBe(0);
      expect(await rowExists(referenced.id)).toBe(true);
      expect(await realStorage.exists(referenced.storageKey)).toBe(true);
    });

    it("②TEMP 有引用 — MAINTENANCE 容器在場", async () => {
      // 【AR-1】同上：合成之違反不變式資料。
      const referenced = await seedAttachment({
        key: "ref-maintenance",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.candidateCount).toBe(0);
      expect(await rowExists(referenced.id)).toBe(true);
    });

    it("②TEMP 有引用 — DEPRECIATION 容器在場", async () => {
      // 【AR-1】同上；另沿 T3R／即審 SF-1：DEPRECIATION 容器刻意與 MAINTENANCE
      // 分屬不同列，否則第四把鑰匙有沒有轉動分辨不出來。
      const referenced = await seedAttachment({
        key: "ref-depreciation",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "DEPRECIATION",
        refId: depreciationApplicationId,
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.candidateCount).toBe(0);
      expect(await rowExists(referenced.id)).toBe(true);
    });

    it("③B-01 恰在 TTL 邊界不刪（elapsed = TTL，嚴格大於）", async () => {
      const boundary = await seedAttachment({
        key: "boundary",
        status: "TEMP",
        createdAt: hoursAgo(TTL_HOURS),
      });
      const justOver = await seedAttachment({
        key: "just-over",
        status: "TEMP",
        createdAt: new Date(NOW.getTime() - TTL_HOURS * 60 * 60 * 1000 - 1), // B-02：差 1 ms
      });

      const { result } = await runReal(realStorage);

      expect(result.summary.deletedCount).toBe(1);
      expect(await rowExists(boundary.id)).toBe(true);
      expect(await realStorage.exists(boundary.storageKey)).toBe(true);
      expect(await rowExists(justOver.id)).toBe(false); // B-02 對照：差 1 ms 即刪
    });
  });

  // =========================================================================
  // AC-05(c) 刪除順序與失敗語意
  // =========================================================================

  describe("AC-05(c): 刪除順序與失敗語意", () => {
    it("DB 先 storage 後：storage.delete 當下 DB 列已不存在", async () => {
      const seeded = await seedAttachment({
        key: "order",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      const observed: boolean[] = [];
      const spy = makeSpyStorage(realStorage, {
        onDelete: async () => {
          observed.push(await rowExists(seeded.id));
        },
      });

      const { result } = await runReal(spy.storage);

      expect(result.summary.deletedCount).toBe(1);
      expect(spy.deletedKeys).toEqual([seeded.storageKey, seeded.thumbnailKey]);
      // 每一次 storage 刪除發生時，DB 列都必須已經不在（DB 先、storage 後）。
      expect(observed).toEqual([false, false]);
    });

    it("storage 失敗不回滾 DB 刪除、計入失敗計數，且日誌零 storageKey／零例外原文", async () => {
      const seeded = await seedAttachment({
        key: "sfail",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      const spy = makeSpyStorage(realStorage, { failKeys: [seeded.storageKey] });

      const { result, events } = await runReal(spy.storage);

      // 不回滾：DB 列確實已刪（該檔此時已不可達）
      expect(await rowExists(seeded.id)).toBe(false);
      expect(result.summary.deletedCount).toBe(1);
      expect(result.summary.failedCount).toBe(1);

      const failureEvents = events.filter((e) => e.stage === "storage-delete-failed");
      expect(failureEvents).toEqual([
        { stage: "storage-delete-failed", attachmentId: seeded.id, errName: "Error" },
      ]);

      // 日誌零禁字：storage key、縮圖 key、檔名、擁有人、以及例外訊息原文
      // （合成錯誤之訊息刻意含 key，故若有人改記 err.message 本格必紅）。
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(seeded.storageKey);
      if (seeded.thumbnailKey) expect(serialized).not.toContain(seeded.thumbnailKey);
      expect(serialized).not.toContain("合成 storage 刪除失敗");
      expect(serialized).not.toContain(ownerId);
      expect(serialized).not.toMatch(/storageKey|thumbnailKey|originalFilename|ownerId|uploaderId/);
    });

    it("結構：實刪路徑不記 err.message（只記 errorLabel 之零內容標籤）", () => {
      const cleaned = stripComments(cleanupCliSource);
      expect(cleaned).not.toMatch(/\.\s*message\b/);
      expect(cleaned).toContain("errorLabel(");
    });
  });

  // =========================================================================
  // AC-05(d) 鑑別力自證（mutant）
  // =========================================================================
  //
  // 三型 mutant 皆以**合成判定**在測試內執行，不改真實檔（沿 T3 之紀律）：把
  // `planCleanup` 的守門逐一拔掉，看受保護的那一列會不會掉進候選集合。
  // 【FW-5】①型（`>` → `>=`）之鑑別力另有 T3 `(d) 邊界` 格與即審 S3 之實證
  // 3 紅背書，本處是同一結論在執行器層的重述，不是重建同型。

  describe("AC-05(d): mutant 自證", () => {
    /** 合成候選規劃：可逐一拔掉守門，回傳候選 id（排序）。 */
    async function planWithMutatedGuards(options: {
      /** `true` ＝ 連 LINKED 一起列舉（拔掉「LINKED 不進掃描」）。 */
      includeLinked?: boolean;
      /** `true` ＝ 引用查詢恆回 false（拔掉引用保護）。 */
      forceNoReference?: boolean;
      /** `true` ＝ TTL 比較改為大於等於（拔掉嚴格大於）。 */
      useGteBoundary?: boolean;
      /** `true` ＝ 拔掉 `isEligibleForCleanup` 之 `LINKED → false` 分支。 */
      dropEligibilityLinkedBranch?: boolean;
      /** `true` ＝ 拔掉 `ATTACHMENT_STATUS_LINKED` 這條引用來源。 */
      dropStatusLinkedSource?: boolean;
    }): Promise<string[]> {
      const rows = await prisma.attachment.findMany({
        where: options.includeLinked ? {} : { status: "TEMP" },
        select: { id: true, status: true, createdAt: true, refType: true, refId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const ids: string[] = [];
      for (const row of rows) {
        const checks = options.forceNoReference
          ? []
          : (await evaluateAttachmentReference(prisma, row)).checks.filter(
              (check) =>
                !(options.dropStatusLinkedSource && check.source === "ATTACHMENT_STATUS_LINKED")
            );
        const hasReference = checks.some((check) => check.referenced);
        if (!options.dropEligibilityLinkedBranch && row.status === "LINKED") continue;
        if (hasReference) continue;
        const elapsedMs = NOW.getTime() - row.createdAt.getTime();
        const ttlMs = TTL_HOURS * 60 * 60 * 1000;
        const overdue = options.useGteBoundary ? elapsedMs >= ttlMs : elapsedMs > ttlMs;
        if (overdue) ids.push(row.id);
      }
      return ids.sort();
    }

    it("①把「嚴格大於」改為「大於等於」→ 邊界列即落入候選（真實判定不落）", async () => {
      const boundary = await seedAttachment({
        key: "mut-boundary",
        status: "TEMP",
        createdAt: hoursAgo(TTL_HOURS),
      });

      const real = await planCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(real.candidates.map((c) => c.id)).toEqual([]);

      const mutated = await planWithMutatedGuards({ useGteBoundary: true });
      expect(mutated).toEqual([boundary.id]);
    });

    it("②移除 LINKED 保護 → 上古 LINKED 附件即落入候選（真實判定不落）", async () => {
      // 容器刻意指向**不存在**之 Application：把「容器存在性」這個混淆因子拿掉，
      // 本格才測得到純粹的 LINKED 保護（否則是容器來源在擋，看不出 LINKED 有沒有
      // 在工作）。
      const linked = await seedAttachment({
        key: "mut-linked",
        status: "LINKED",
        createdAt: hoursAgo(9000),
        refType: "MAINTENANCE",
        refId: `${RUN_ID}-no-such-application`,
      });

      const real = await planCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(real.candidates.map((c) => c.id)).toEqual([]);

      // 逐級拔除證明 LINKED 保護是**三重**承載，缺一仍擋得住（撰寫本格時的實測
      // 發現：原以為是雙重，拔到第二道仍回空集，追下去才看到第三道）：
      //   ① `planCleanup` 之 `where: { status: "TEMP" }`——LINKED 連掃描都不進；
      //   ② `isEligibleForCleanup` 之 `LINKED → false` 分支；
      //   ③ `ATTACHMENT_STATUS_LINKED` 這條引用來源（status=LINKED ⇒ 有引用）。
      expect(await planWithMutatedGuards({ includeLinked: true })).toEqual([]);
      expect(
        await planWithMutatedGuards({ includeLinked: true, dropEligibilityLinkedBranch: true })
      ).toEqual([]);
      expect(
        await planWithMutatedGuards({
          includeLinked: true,
          dropEligibilityLinkedBranch: true,
          dropStatusLinkedSource: true,
        })
      ).toEqual([linked.id]);
    });

    it("③引用查詢恆回 false → 三型有引用列全數落入候選（真實判定全不落）", async () => {
      // 【AR-1】三列皆為刻意違反不變式之合成資料（TEMP 帶 refId）。
      const trip = await seedAttachment({
        key: "mut-ref-trip",
        status: "TEMP",
        createdAt: hoursAgo(48),
        refType: "TRIP_SEGMENT",
        refId: tripSegmentId,
      });
      const maintenance = await seedAttachment({
        key: "mut-ref-maintenance",
        status: "TEMP",
        createdAt: hoursAgo(49),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });
      const depreciation = await seedAttachment({
        key: "mut-ref-depreciation",
        status: "TEMP",
        createdAt: hoursAgo(50),
        refType: "DEPRECIATION",
        refId: depreciationApplicationId,
      });

      const real = await planCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS });
      expect(real.candidates.map((c) => c.id)).toEqual([]);

      const mutated = await planWithMutatedGuards({ forceNoReference: true });
      expect(mutated).toEqual([trip.id, maintenance.id, depreciation.id].sort());
    });

    it("紅燈物證（常設）：守門缺席之執行器會誤刪受保護三型；真實執行器全數保住", async () => {
      // 這一格是 Packet Done When 之「守門缺席之合成情境會誤刪」的**常設化**：
      // A 段用一個「不呼叫 `planCleanup`、直接列舉全表就刪」的合成執行器，實際
      // 把三型受保護附件刪掉（真的刪，不是模擬）；B 段用真實執行器對同一組重播，
      // 三型全數存活。兩段的差別只有「有沒有經過判定」這一件事。
      const seedProtectedTrio = async (tag: string) => ({
        linked: await seedAttachment({
          key: `${tag}-linked`,
          status: "LINKED",
          createdAt: hoursAgo(9000),
          refType: "MAINTENANCE",
          refId: maintenanceApplicationId,
        }),
        referenced: await seedAttachment({
          key: `${tag}-referenced`,
          status: "TEMP",
          createdAt: hoursAgo(48),
          refType: "TRIP_SEGMENT",
          refId: tripSegmentId, // 【AR-1】合成之違反不變式資料
        }),
        boundary: await seedAttachment({
          key: `${tag}-boundary`,
          status: "TEMP",
          createdAt: hoursAgo(TTL_HOURS),
        }),
      });

      // ── A：守門缺席 ────────────────────────────────────────────────────
      // 【T4R／SF-3】原寫法先 `findMany()` 全表再依 id 刪——雖不是字面上的
      // `deleteMany({})`，實質等價，違反本檔檔頭「清理一律以本檔前綴／id 精確
      // 比對」之紀律；且在 `TEST_DB_ISOLATION=off` 回退模式（INFRA-001 明文保留
      // 之一鍵回滾，該分支不註冊 TRUNCATE）下會跨檔誤刪其他測試檔的附件。
      // 改為只刪本格自己播的三筆——鑑別力不減反增：被刪的必定是這三筆，
      // 不會被「反正全表都刪光了」稀釋。
      const a = await seedProtectedTrio("guardless");
      await prisma.attachment.deleteMany({
        where: { id: { in: [a.linked.id, a.referenced.id, a.boundary.id] } },
      });
      expect(await rowExists(a.linked.id)).toBe(false);
      expect(await rowExists(a.referenced.id)).toBe(false);
      expect(await rowExists(a.boundary.id)).toBe(false);

      // ── B：真實執行器 ──────────────────────────────────────────────────
      const b = await seedProtectedTrio("guarded");
      const { result } = await runReal(realStorage);
      expect(result.summary.deletedCount).toBe(0);
      expect(await rowExists(b.linked.id)).toBe(true);
      expect(await rowExists(b.referenced.id)).toBe(true);
      expect(await rowExists(b.boundary.id)).toBe(true);
    });
  });

  // =========================================================================
  // AC-05(e) 零弱化守門
  // =========================================================================

  describe("AC-05(e): 零弱化", () => {
    it("isEligibleForCleanup 之嚴格大於與 LINKED 分支未被改動，且執行器不自帶第二套時間判斷", () => {
      const body = extractFunctionBody(lifecycleSource, "isEligibleForCleanup");
      expect(body).toContain("elapsedMs > ttlMs");
      expect(body).not.toContain(">=");
      expect(body).toContain('attachment.status === "LINKED"');

      // 執行器零時間判斷、零引用判定——它只消費 `planCleanup` 的輸出。
      const cliCleaned = stripComments(cleanupCliSource);
      expect(countCallSites(cleanupCliSource, "isEligibleForCleanup")).toBe(0);
      expect(countCallSites(cleanupCliSource, "evaluateAttachmentReference")).toBe(0);
      expect(cliCleaned).not.toContain("ttlMs");
      expect(cliCleaned).not.toContain("getTime()");
    });
  });

  // =========================================================================
  // AC-04(c) 之另一半（T3 之未竟義務；本 Task 落地）
  // =========================================================================

  describe("AC-04(c) 另一半：實跑亦走同一判定路徑", () => {
    it("結構：實跑執行器恰呼叫一次 planCleanup，且不自建第二條列舉／判定路徑", () => {
      const runBody = extractFunctionBody(cleanupCliSource, "runCleanup");
      expect(runBody).toContain("planCleanup(");

      // 全檔恰一處呼叫、零第二份實作
      expect(countCallSites(cleanupCliSource, "planCleanup")).toBe(1);
      expect(countDefinitions(cleanupCliSource, "planCleanup")).toBe(0);

      // 執行器對 `Attachment` 的讀取只有「依 id 取 storage key」這一種，零
      // `findMany`——候選來源因此不可能有第二條。
      const cliCleaned = stripComments(cleanupCliSource);
      expect(cliCleaned).not.toMatch(/attachment\s*\.\s*findMany/);
      expect(cliCleaned).not.toMatch(/attachment\s*\.\s*findFirst/);

      // 判定模組本身仍零寫入（FW-2=(i)：實刪只在 CLI 檔，判定檔界線不變）。
      expect(scanPrismaWriteCalls(cleanupServiceSource)).toEqual([]);
      expect(scanPrismaWriteCalls(cleanupCliSource)).toEqual(["attachment.deleteMany"]);
    });

    it("執行期：實刪集合恰等於同一組參數下 planCleanup 之候選集合", async () => {
      const deletable = await seedAttachment({
        key: "same-path-deletable",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      await seedAttachment({ key: "same-path-fresh", status: "TEMP", createdAt: hoursAgo(1) });
      await seedAttachment({
        key: "same-path-linked",
        status: "LINKED",
        createdAt: hoursAgo(9000),
        refType: "MAINTENANCE",
        refId: maintenanceApplicationId,
      });

      const plan = await planCleanup(prisma, { now: NOW, ttlHours: TTL_HOURS, limit: 500 });
      const { result, events } = await runReal(realStorage);

      expect(plan.candidates.map((c) => c.id)).toEqual([deletable.id]);
      expect(result.candidates).toEqual(plan.candidates);
      const deletedIds = events.filter((e) => e.stage === "deleted").map((e) => e.attachmentId);
      expect(deletedIds).toEqual(plan.candidates.map((c) => c.id));
    });
  });

  // =========================================================================
  // AC-06 觸發、批次與可觀測性
  // =========================================================================

  describe("AC-06: 觸發、批次與可觀測性", () => {
    it("(a) 觸發路徑恰一條之結構斷言", () => {
      // ① 全 `backend/src` 零檔案 import 本模組（不進 server 組裝、不被任何服務
      //    路徑拉進去）——註解提及不算，只認真正的 import／require。
      const importers = listTsFilesRecursive(SRC_ROOT)
        .filter((file) => {
          const cleaned = stripComments(fs.readFileSync(file, "utf8"));
          return /(?:from|require\s*\(|import\s*\()\s*["'][^"']*cleanup-cli[^"']*["']/.test(
            cleaned
          );
        })
        .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join("/"));
      expect(importers).toEqual([]);

      // ② `server.ts` 全檔零提及（含註解）——連「順手掛上去」的痕跡都不允許。
      expect(fs.readFileSync(SERVER_PATH, "utf8")).not.toContain("cleanup");

      // ③ 零排程原語、零路由註冊（防「腳本 ＋ 忘了關的 interval」雙跑）。
      const cliCleaned = stripComments(cleanupCliSource);
      const serviceCleaned = stripComments(cleanupServiceSource);
      for (const cleaned of [cliCleaned, serviceCleaned]) {
        expect(cleaned).not.toMatch(
          /\bsetInterval\s*\(|\bsetTimeout\s*\(|\bcron\b|\bschedule\s*\(/
        );
        expect(cleaned).not.toMatch(/\bfastify\b|\.\s*register\s*\(|\.\s*route\s*\(/);
        expect(cleaned).not.toMatch(/\.\s*(?:get|post|put|patch|delete)\s*\(\s*["'`]\//);
      }

      // ④ package.json 中引用本模組之 script 恰兩條，且指向**同一個**模組
      //    （`dist` 與 `tsx` 兩式是同一條路徑的編譯前後，不是兩條觸發路徑）。
      const scripts = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).scripts as Record<
        string,
        string
      >;
      const cleanupScripts = Object.entries(scripts).filter(([, cmd]) =>
        cmd.includes("cleanup-cli")
      );
      expect(cleanupScripts.map(([name]) => name).sort()).toEqual([
        "cleanup:attachments",
        "cleanup:attachments:dev",
      ]);
      expect(cleanupScripts.map(([, cmd]) => cmd)).toEqual([
        "node dist/attachment/cleanup-cli.js",
        "tsx src/attachment/cleanup-cli.ts",
      ]);

      // ⑤ 進入點守衛恰一處（`isMain`），且不在 import 時執行。
      expect(cliCleaned.match(/\bisMain\b/g)?.length).toBe(2); // 宣告 ＋ if 判斷
    });

    it("(b)／B-07 批次上限：超量候選留待下次，且 take 在場（§10 N-1）", async () => {
      const older = await seedAttachment({
        key: "batch-1",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const middle = await seedAttachment({
        key: "batch-2",
        status: "TEMP",
        createdAt: hoursAgo(50),
      });
      const newer = await seedAttachment({
        key: "batch-3",
        status: "TEMP",
        createdAt: hoursAgo(40),
      });

      const first = await runReal(realStorage, { limit: 2 });
      expect(first.result.summary.scannedCount).toBe(2);
      expect(first.result.summary.candidateCount).toBe(2);
      expect(first.result.summary.deletedCount).toBe(2);
      expect(first.result.summary.hasMore).toBe(true); // 摘要載明「尚有剩餘」
      expect(await rowExists(older.id)).toBe(false); // 最舊者優先
      expect(await rowExists(middle.id)).toBe(false);
      expect(await rowExists(newer.id)).toBe(true); // 其餘留待下次

      const second = await runReal(realStorage, { limit: 2 });
      expect(second.result.summary.deletedCount).toBe(1);
      expect(second.result.summary.hasMore).toBe(false);
      expect(await rowExists(newer.id)).toBe(false);

      // 結構：`take` 在 `planCleanup` 內（唯一列舉路徑），且該函式恰一次 findMany。
      const planBody = extractFunctionBody(cleanupServiceSource, "planCleanup");
      expect(planBody).toContain("take");
      expect(planBody.match(/findMany\s*\(/g)?.length).toBe(1);
    });

    it("(b) 批次上限之 env 預設與模組常數為同一個數", () => {
      expect(
        parseEnv({ DATABASE_URL: "postgresql://localhost/x" }).ATTACHMENT_CLEANUP_BATCH_LIMIT
      ).toBe(DEFAULT_CLEANUP_BATCH_LIMIT);
      expect(getEnvOrTestDefaults({}).ATTACHMENT_CLEANUP_BATCH_LIMIT).toBe(
        DEFAULT_CLEANUP_BATCH_LIMIT
      );
      expect(DEFAULT_CLEANUP_BATCH_LIMIT).toBe(500); // Spec §8.2 給定值
    });

    it("(c) 摘要五欄且零敏感內容", async () => {
      const seeded = await seedAttachment({
        key: "summary",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      await seedAttachment({ key: "summary-fresh", status: "TEMP", createdAt: hoursAgo(2) });

      const { result, events } = await runReal(realStorage);
      const summary = result.summary;

      // AC-06(c) 逐字五欄：掃描筆數／候選筆數／實刪筆數／失敗筆數／耗時
      expect(summary.scannedCount).toBe(2);
      expect(summary.candidateCount).toBe(1);
      expect(summary.deletedCount).toBe(1);
      expect(summary.failedCount).toBe(0);
      expect(typeof summary.durationMs).toBe("number");
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);

      // 欄位封閉（五欄 ＋ 模式 ＋ 剩餘量 ＋ 略過數；多一欄即紅）
      expect(Object.keys(summary).sort()).toEqual([
        "candidateCount",
        "deletedCount",
        "dryRun",
        "durationMs",
        "failedCount",
        "hasMore",
        "scannedCount",
        "skippedCount",
      ]);

      // 摘要與全部日誌零個資、零 storage key
      const serialized = JSON.stringify({ summary, events });
      const rows = await prisma.attachment.findMany({ where: { ownerId } });
      for (const row of rows) {
        expect(serialized).not.toContain(row.storageKey);
        expect(serialized).not.toContain(row.originalFilename);
      }
      expect(serialized).not.toContain(seeded.storageKey);
      expect(serialized).not.toContain(ownerId);
      expect(serialized).not.toMatch(/storageKey|thumbnailKey|originalFilename|ownerId|uploaderId/);

      // 摘要恰在日誌尾端出現一次（可觀測性之單一收斂點）
      const summaryEvents = events.filter((e) => e.stage === "summary");
      expect(summaryEvents.length).toBe(1);
      expect(events[0].stage).toBe("start");
      expect(events[events.length - 1].stage).toBe("summary");
    });

    it("(d) 部分失敗不中止，且結束碼依 D6-2=(a)（有失敗即非零）", async () => {
      const failing = await seedAttachment({
        key: "d-fail",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const okOne = await seedAttachment({
        key: "d-ok-1",
        status: "TEMP",
        createdAt: hoursAgo(50),
      });
      const okTwo = await seedAttachment({
        key: "d-ok-2",
        status: "TEMP",
        createdAt: hoursAgo(40),
      });
      const spy = makeSpyStorage(realStorage, { failKeys: [failing.storageKey] });

      // ① 執行器層：第一筆失敗，其餘照常處理
      const { result } = await runReal(spy.storage);
      expect(result.summary.candidateCount).toBe(3);
      expect(result.summary.deletedCount).toBe(3);
      expect(result.summary.failedCount).toBe(1);
      expect(await rowExists(okOne.id)).toBe(false);
      expect(await rowExists(okTwo.id)).toBe(false);

      // ② CLI 層：有失敗 → 結束碼非零（排程告警之唯一介面）
      const again = await seedAttachment({
        key: "d-fail-2",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const spy2 = makeSpyStorage(realStorage, { failKeys: [again.storageKey] });
      const collector = makeLogCollector();
      const failCode = await runCleanupCli([], cliEnv(), {
        prisma,
        storage: spy2.storage,
        logger: collector.logger,
        now: NOW,
      });
      expect(failCode).toBe(1);

      // ③ 零失敗（含零候選）→ 結束碼 0
      const okCollector = makeLogCollector();
      const okCode = await runCleanupCli([], cliEnv(), {
        prisma,
        storage: realStorage,
        logger: okCollector.logger,
        now: NOW,
      });
      expect(okCode).toBe(0);
    });

    it("(e)／B-08: 強制交錯之兩份執行——後到者對已刪列為 no-op，恆不拋", async () => {
      // 【誠實揭露：本格以**強制延遲注入**取得決定性，沿 T3 即審 B-08 先例】
      // 純 `Promise.all` 的兩份執行，其 `planCleanup` 是否真的都在對方刪除之前完
      // 成，取決於連線池排隊順序——實測會出現「後者只看到 2 筆」的合法但不決定性
      // 結果（撰寫本格時的第一版即因此紅：expected 2 to be 4）。故本格改以
      // storage spy 的 `onDelete` 當作**屏障**：左路刪完第一筆的 DB 列、正要刪其
      // 位元組時，整個右路在此點跑完。於是右路必然看見「第一筆已消失、其餘三筆
      // 還在」，把那三筆刪掉；控制權回到左路後，左路對那三筆的條件式刪除必然
      // 落空——這正是 B-08 要證的「重複刪除為 no-op 而非拋錯」，且完全決定性。
      const seeded = [
        await seedAttachment({ key: "conc-1", status: "TEMP", createdAt: hoursAgo(60) }),
        await seedAttachment({ key: "conc-2", status: "TEMP", createdAt: hoursAgo(59) }),
        await seedAttachment({ key: "conc-3", status: "TEMP", createdAt: hoursAgo(58) }),
        await seedAttachment({ key: "conc-4", status: "TEMP", createdAt: hoursAgo(57) }),
      ];

      let rightResult: CleanupRunResult | null = null;
      const barrier = makeSpyStorage(realStorage, {
        onDelete: async () => {
          if (rightResult !== null) return; // 只在第一次刪除時開閘
          rightResult = (await runReal(realStorage)).result;
        },
      });

      const left = await runReal(barrier.storage);

      expect(left.result.summary.candidateCount).toBe(4);
      expect(left.result.summary.deletedCount).toBe(1);
      expect(left.result.summary.skippedCount).toBe(3); // 三筆已被右路刪走 → no-op
      expect(left.result.summary.failedCount).toBe(0);

      const right = rightResult as CleanupRunResult | null;
      expect(right?.summary.candidateCount).toBe(3);
      expect(right?.summary.deletedCount).toBe(3);
      expect(right?.summary.failedCount).toBe(0);

      for (const item of seeded) {
        expect(await rowExists(item.id)).toBe(false);
      }
      expect(listStorageKeys(storageRoot)).toEqual([]);
    });

    it("(e)／B-08: 真實併行（Promise.all）之兩份執行恆不拋，且每列恰刪一次", async () => {
      // 上一格是強制交錯（決定性）；本格是**未強制**的真實併行，只斷言與排程順序
      // 無關的不變式——刻意不斷言「兩份都看到 4 筆候選」，因為那取決於連線池排隊
      // 順序，寫死它就是把不決定性寫進測試。
      const seeded = [
        await seedAttachment({ key: "par-1", status: "TEMP", createdAt: hoursAgo(60) }),
        await seedAttachment({ key: "par-2", status: "TEMP", createdAt: hoursAgo(59) }),
        await seedAttachment({ key: "par-3", status: "TEMP", createdAt: hoursAgo(58) }),
        await seedAttachment({ key: "par-4", status: "TEMP", createdAt: hoursAgo(57) }),
      ];

      const [left, right] = await Promise.all([runReal(realStorage), runReal(realStorage)]);

      // 每一列恰由其中一份刪成功；沒有任何一份因「刪不到」而失敗或拋錯。
      expect(left.result.summary.deletedCount + right.result.summary.deletedCount).toBe(4);
      expect(left.result.summary.failedCount).toBe(0);
      expect(right.result.summary.failedCount).toBe(0);
      for (const run of [left.result.summary, right.result.summary]) {
        expect(run.deletedCount + run.skippedCount).toBe(run.candidateCount);
      }

      for (const item of seeded) {
        expect(await rowExists(item.id)).toBe(false);
        expect(await realStorage.exists(item.storageKey)).toBe(false);
      }
      expect(listStorageKeys(storageRoot)).toEqual([]);
    });

    // =======================================================================
    // 條件式刪除之三條件（T4R／SF-1）
    // =======================================================================
    //
    // `deleteCandidate` 的 `where: { id, status:"TEMP", createdAt }` 有三個條件，
    // 檔頭也鄭重宣稱它們各自擋住什麼；但即審實證：拔掉 `status`（S1）、拔掉
    // `createdAt`（S2）、乃至只留 `id`（S10），原 59 格**全綠存活**——三道被寫在
    // 註解裡的安全機制，實際上沒有任何一格守著（T3R SF-1「宣稱有、測試無」之同型
    // 復發）。以下兩格把「判定之後、刪除之前」這段時間差關起來：用 storage spy 的
    // `onDelete` 當屏障，在**第一筆已進刪除迴圈**時去改動**後面那筆**的狀態，
    // 模擬另一個請求在這段空窗插進來。

    /**
     * 播三筆逾期候選，並在執行器刪掉第一筆（storage 階段）時對第三筆做 `mutate`。
     * 回傳三筆與本次執行結果。
     */
    async function runWithMidFlightMutation(
      tag: string,
      mutate: (victimId: string) => Promise<void>
    ) {
      const first = await seedAttachment({
        key: `${tag}-1`,
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const second = await seedAttachment({
        key: `${tag}-2`,
        status: "TEMP",
        createdAt: hoursAgo(59),
      });
      const victim = await seedAttachment({
        key: `${tag}-3`,
        status: "TEMP",
        createdAt: hoursAgo(58),
      });

      let opened = false;
      const barrier = makeSpyStorage(realStorage, {
        onDelete: async () => {
          if (opened) return;
          opened = true;
          await mutate(victim.id);
        },
      });

      const { result } = await runReal(barrier.storage);
      return { first, second, victim, summary: result.summary };
    }

    it("(e)／SF-1: 判定後被 link 到容器者不刪（條件式刪除之 status 條件）", async () => {
      const { first, second, victim, summary } = await runWithMidFlightMutation(
        "toctou-link",
        async (victimId) => {
          // 另一個請求在空窗期把它 link 到容器上（`linkAttachment` 之寫入形狀）。
          await prisma.attachment.update({
            where: { id: victimId },
            data: {
              status: "LINKED",
              refType: "MAINTENANCE",
              refId: maintenanceApplicationId,
              linkedAt: NOW,
            },
          });
        }
      );

      expect(summary.candidateCount).toBe(3);
      expect(summary.deletedCount).toBe(2); // 前兩筆照刪
      expect(summary.skippedCount).toBe(1); // 第三筆落空
      expect(summary.failedCount).toBe(0);
      expect(await rowExists(first.id)).toBe(false);
      expect(await rowExists(second.id)).toBe(false);
      // 關鍵：它已經是別人的附件了，不能因為「判定當時它還是 TEMP」就刪掉。
      expect(await rowExists(victim.id)).toBe(true);
      expect(await realStorage.exists(victim.storageKey)).toBe(true);
    });

    it("(e)／SF-1: 判定後 TTL 基準被重設者不刪（條件式刪除之 createdAt 條件）", async () => {
      const { first, second, victim, summary } = await runWithMidFlightMutation(
        "toctou-detach",
        async (victimId) => {
          // detach（LINKED → TEMP）會把 `createdAt` 重設為當下＝TTL 基準重新起算
          // （`lifecycle-service.ts` 之 `detachFieldSet`）。此時它已「不逾期」，
          // 但我們手上的候選是舊版那一列。
          await prisma.attachment.update({
            where: { id: victimId },
            data: { createdAt: NOW },
          });
        }
      );

      expect(summary.candidateCount).toBe(3);
      expect(summary.deletedCount).toBe(2);
      expect(summary.skippedCount).toBe(1);
      expect(summary.failedCount).toBe(0);
      expect(await rowExists(first.id)).toBe(false);
      expect(await rowExists(second.id)).toBe(false);
      // 關鍵：TTL 基準已重新起算，這筆現在是「新的暫存檔」，不得刪。
      expect(await rowExists(victim.id)).toBe(true);
      expect(await realStorage.exists(victim.storageKey)).toBe(true);
    });
  });

  // =========================================================================
  // CLI 介面（D3=(c)）
  // =========================================================================

  /** CLI 之合成 env（不讀真實 `process.env` 的清理設定，使每格決定性）。 */
  function cliEnv(overrides: Record<string, string | undefined> = {}) {
    return {
      DATABASE_URL: "postgresql://localhost/synthetic",
      ATTACHMENT_STORAGE_ROOT: storageRoot,
      ATTACHMENT_TEMP_TTL_HOURS: String(TTL_HOURS),
      ATTACHMENT_CLEANUP_BATCH_LIMIT: "500",
      ...overrides,
    };
  }

  describe("CLI（D3=(c)）", () => {
    it("--dry-run：DB 全表逐欄快照全等 ＋ storage 鍵集全等，結束碼 0，且列出候選", async () => {
      const deletable = await seedAttachment({
        key: "cli-dry",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      const dbBefore = await prisma.attachment.findMany({ orderBy: { id: "asc" } });
      const storageBefore = listStorageKeys(storageRoot);

      const collector = makeLogCollector();
      // 刻意**不注入** storage：dry-run 路徑手上根本沒有刪除工具（結構性唯讀）。
      const code = await runCleanupCli(["--dry-run"], cliEnv(), {
        prisma,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(0);
      expect(await prisma.attachment.findMany({ orderBy: { id: "asc" } })).toEqual(dbBefore);
      expect(listStorageKeys(storageRoot)).toEqual(storageBefore);
      expect(await rowExists(deletable.id)).toBe(true);

      const summaryEvent = collector.events.find((e) => e.stage === "summary");
      expect(summaryEvent?.summary?.dryRun).toBe(true);
      expect(summaryEvent?.summary?.candidateCount).toBe(1);
      expect(summaryEvent?.summary?.deletedCount).toBe(0);
      expect(collector.events.some((e) => e.stage === "deleted")).toBe(false);

      // AC-04(b)：dry-run 的產出是**候選清單**本身（人工 Gate 要看的就是這個），
      // 不是只有一行摘要。逐筆欄位封閉且零禁字。
      const candidateEvents = collector.events.filter((e) => e.stage === "candidate");
      expect(candidateEvents.length).toBe(1);
      expect(candidateEvents[0].attachmentId).toBe(deletable.id);
      const listed = candidateEvents[0].candidate;
      expect(listed && Object.keys(listed).sort()).toEqual([
        "createdAt",
        "id",
        "overdueHours",
        "referenceChecks",
        "status",
      ]);
      expect(listed?.overdueHours).toBe(6); // 30h − 24h TTL
      expect(listed?.referenceChecks.map((c) => c.source)).toEqual(
        ATTACHMENT_REFERENCE_SOURCES.map((s) => s.key)
      );
      const serialized = JSON.stringify(collector.events);
      expect(serialized).not.toContain(deletable.storageKey);
      expect(serialized).not.toContain(ownerId);
      expect(serialized).not.toMatch(/storageKey|thumbnailKey|originalFilename|ownerId|uploaderId/);
    });

    it("未知旗標 → 非零結束碼且零刪除（不可逆工具不猜參數）", async () => {
      const seeded = await seedAttachment({
        key: "cli-bad",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      const collector = makeLogCollector();

      const code = await runCleanupCli(["--force"], cliEnv(), {
        prisma,
        storage: realStorage,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(1);
      expect(collector.events).toEqual([{ stage: "invalid-argument", detail: "--force" }]);
      expect(await rowExists(seeded.id)).toBe(true);
    });

    it("實跑但 ATTACHMENT_STORAGE_ROOT 未設 → 非零結束碼、零刪除、日誌只有鍵名", async () => {
      const seeded = await seedAttachment({
        key: "cli-noroot",
        status: "TEMP",
        createdAt: hoursAgo(30),
      });
      const collector = makeLogCollector();

      const code = await runCleanupCli([], cliEnv({ ATTACHMENT_STORAGE_ROOT: undefined }), {
        prisma,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(1);
      expect(collector.events).toEqual([
        { stage: "config-error", detail: "ATTACHMENT_STORAGE_ROOT" },
      ]);
      expect(await rowExists(seeded.id)).toBe(true);
    });

    // =======================================================================
    // env → 執行器之接線（T4R／SF-2）
    // =======================================================================
    //
    // 即審實證：把 CLI 內的 `config.ATTACHMENT_TEMP_TTL_HOURS`／
    // `ATTACHMENT_CLEANUP_BATCH_LIMIT` 換成硬編的 24／500（S7），原 59 格全綠——
    // 因為 `cliEnv()` 給的就是與預設相同的值，結構上分辨不出「有沒有真的讀 env」。
    // AC-06(b) 逐字要求「批次上限**可由 env 設定**」，那就得用**非預設值**來證。

    it("SF-2: ATTACHMENT_CLEANUP_BATCH_LIMIT 之非預設值確實傳達到執行器", async () => {
      await seedAttachment({ key: "wire-limit-1", status: "TEMP", createdAt: hoursAgo(60) });
      await seedAttachment({ key: "wire-limit-2", status: "TEMP", createdAt: hoursAgo(59) });
      const third = await seedAttachment({
        key: "wire-limit-3",
        status: "TEMP",
        createdAt: hoursAgo(58),
      });
      const collector = makeLogCollector();

      const code = await runCleanupCli([], cliEnv({ ATTACHMENT_CLEANUP_BATCH_LIMIT: "2" }), {
        prisma,
        storage: realStorage,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(0);
      const summary = collector.events.find((e) => e.stage === "summary")?.summary;
      // 硬編 500 會讓 scanned/candidate/deleted 皆為 3、hasMore 為 false。
      expect(summary?.scannedCount).toBe(2);
      expect(summary?.candidateCount).toBe(2);
      expect(summary?.deletedCount).toBe(2);
      expect(summary?.hasMore).toBe(true);
      expect(await rowExists(third.id)).toBe(true); // 最新的一筆留待下次
    });

    it("SF-2: ATTACHMENT_TEMP_TTL_HOURS 之非預設值確實傳達到執行器", async () => {
      const withinLongerTtl = await seedAttachment({
        key: "wire-ttl-30h",
        status: "TEMP",
        createdAt: hoursAgo(30), // 逾 24h 但未逾 48h
      });
      const beyondLongerTtl = await seedAttachment({
        key: "wire-ttl-60h",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const collector = makeLogCollector();

      const code = await runCleanupCli([], cliEnv({ ATTACHMENT_TEMP_TTL_HOURS: "48" }), {
        prisma,
        storage: realStorage,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(0);
      const summary = collector.events.find((e) => e.stage === "summary")?.summary;
      // 硬編 24 會讓兩筆都成為候選並被刪。
      expect(summary?.candidateCount).toBe(1);
      expect(summary?.deletedCount).toBe(1);
      expect(await rowExists(beyondLongerTtl.id)).toBe(false);
      expect(await rowExists(withinLongerTtl.id)).toBe(true);
    });

    // =======================================================================
    // env 驗證失敗一律硬失敗（T4R／MF-1）
    // =======================================================================

    it("MF-1: 無關變數無效（PORT）→ 非零結束碼、零刪除，不得靜默回退預設值", async () => {
      // 即審 probe：改法前 `getEnvOrTestDefaults` 會吞掉這個錯、回退 TTL=24，
      // 然後**照樣執行不可逆刪除**，零訊息零非零結束碼。
      const seeded = await seedAttachment({
        key: "cli-badenv",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });
      const collector = makeLogCollector();

      const code = await runCleanupCli([], cliEnv({ PORT: "not-a-number" }), {
        prisma,
        storage: realStorage,
        logger: collector.logger,
        now: NOW,
      });

      expect(code).toBe(1);
      expect(collector.events).toEqual([
        { stage: "config-error", detail: "ENV_VALIDATION_FAILED" },
      ]);
      expect(await rowExists(seeded.id)).toBe(true);
      expect(await realStorage.exists(seeded.storageKey)).toBe(true);
    });

    it("MF-1: 批次上限非法值（0／負數／非整數）→ 具名 config-error、零刪除", async () => {
      const seeded = await seedAttachment({
        key: "cli-badlimit",
        status: "TEMP",
        createdAt: hoursAgo(60),
      });

      for (const bad of ["0", "-1", "1.5", "abc"]) {
        const collector = makeLogCollector();
        const code = await runCleanupCli([], cliEnv({ ATTACHMENT_CLEANUP_BATCH_LIMIT: bad }), {
          prisma,
          storage: realStorage,
          logger: collector.logger,
          now: NOW,
        });
        expect(code).toBe(1);
        // 具名到變數（不含值）——Spec §8.2 之 `int > 0` 在唯一消費端確實生效。
        expect(collector.events).toEqual([
          { stage: "config-error", detail: "ATTACHMENT_CLEANUP_BATCH_LIMIT" },
        ]);
        expect(JSON.stringify(collector.events)).not.toContain(bad === "abc" ? "abc" : `"${bad}"`);
        expect(await rowExists(seeded.id)).toBe(true);
      }

      // TTL 亦同（同一具名檢查涵蓋兩鍵）
      const collector = makeLogCollector();
      const code = await runCleanupCli([], cliEnv({ ATTACHMENT_TEMP_TTL_HOURS: "0" }), {
        prisma,
        storage: realStorage,
        logger: collector.logger,
        now: NOW,
      });
      expect(code).toBe(1);
      expect(collector.events).toEqual([
        { stage: "config-error", detail: "ATTACHMENT_TEMP_TTL_HOURS" },
      ]);
      expect(await rowExists(seeded.id)).toBe(true);
    });
  });
});
