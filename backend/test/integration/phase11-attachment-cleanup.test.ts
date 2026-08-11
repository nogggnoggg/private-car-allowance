/**
 * Integration test: PHASE-011-T3 — 附件清理之「無引用」判定與 dry-run
 * （`docs/specs/PHASE-011.md` **AC-03**／**AC-04**；§16 **D4**=(a)）
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
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
 *   ② **dev DB jsonb 抽查佐證**（Packet 授權之佐證手段）：dev 資料庫 136 筆
 *      `AuditLog` × 97 筆 `Attachment`，以 `summary::text` 對全部現存 attachment
 *      id 逐一比對，命中數 **0**；抽出之 `summary` 頂層鍵集合亦與 ① 相符、
 *      零附件相關鍵。
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
 * 射程邊界（Out of Scope，屬 T4）
 * ---------------------------------------------------------------------------
 * 實際刪除、批次上限、觸發形式（CLI）、storage 孤兒盤點皆不在本檔。本檔之
 * `planCleanup` 即 T4 實跑將呼叫的**同一個**判定路徑（AC-04(c)），T4 落地後
 * 須把「實跑亦呼叫此函式」之另一半結構斷言補上。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTACHMENT_INBOUND_REFERENCE_FIELDS,
  ATTACHMENT_REFERENCE_SOURCES,
  type AttachmentInboundField,
  type CleanupCandidate,
  createHasReferenceQuery,
  dryRunCleanup,
  evaluateAttachmentReference,
  planCleanup,
} from "../../src/attachment/cleanup-service.js";
import { hashPassword } from "../../src/auth/password.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

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
      //     attachment id；dev DB 136 筆 × 97 附件之 jsonb 抽查命中 0（檔頭
      //     「D4 之條件式升級授權實查結果」段有完整證據）。
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
      // ③ 執行期：dry-run 之候選與直接呼叫共用判定路徑之結果逐欄全等
      //    （T4 之實跑亦呼叫 `planCleanup`，屆時補上另一半結構斷言）
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
