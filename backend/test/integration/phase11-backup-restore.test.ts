/**
 * Integration test: PHASE-011 備份（T12）＋ 還原驗證（T13）—
 * `scripts/backup.sh` 與 `scripts/verify-restore.sh` 之實跑驗證
 * （`docs/specs/PHASE-011.md` **AC-19**／**AC-22**／**AC-23**／**AC-24**；
 * §16 **D11-1**=(a) `docker exec` ＋ `pg_dump -Fc`、**D11-2**=(a) 不加密、
 * **D12**=(a) 路徑樹守門、**D13**=(a)+(b) 併用）
 *
 * 本檔由 T12 建立、**T13 就地擴充**，故檔名為 `backup-restore` 而非 `backup`。
 * 兩段各自獨立（`describeWithDb` 兩個）：**不共用臨時樹、不共用 `PrismaClient`、
 * 不共用備份**。分開的理由是 T12 之 AC-19(f) 以「整份 DB 快照前後全等」為斷言，
 * T13 的播種若落在它的射程內就會把它弄紅。T13 段之總覽見該段開頭之區塊註解。
 *
 * ---------------------------------------------------------------------------
 * §11.6 spike #1 之實測結論（T12 首步，三件事逐一實跑；逐字輸出見 Handoff）
 * ---------------------------------------------------------------------------
 *   (i)  **dev 之 `docker exec pg_dump` 可行** —— compose 之 db 容器內
 *        `pg_dump 16.14` 與伺服器**同一個容器**，版本必然相容；`-Fc` 產物以
 *        `PGDMP` magic 開頭，經 stdout 導出至主機**位元組全等**（Git Bash 之
 *        重導向不會壞二進位，已以 sha256 兩側比對確認）。**採用路徑 = D11-1(a)，
 *        零退層。**
 *   (ii) **CI 之 service container 形狀已以等價物實測** —— CI 的 Postgres 是
 *        「無 compose label、以 published port 對外」的獨立容器；dev 上的
 *        `t1-pg`（:55432，本專案測試庫）**正是同一形狀**，本檔採用的
 *        `docker ps --filter publish=<port>` 探索法在它上面實跑成功並取得可用
 *        產物。**唯一未實測者**：GitHub runner 之 docker CLI 對 service
 *        container 的可達性（需真的跑一次 CI 才算數，本 Task 無 push 權限）。
 *        該殘留風險以下方 `spike #1 環境能力` 一格承擔——**不可用即紅，不靜默
 *        跳過**（T10／T10R MF-1：「取不到」不得與「相等」同結局）。
 *   (iii)**還原至隔離目標可行** —— `-Fc` 產物經 `pg_restore` 還原至**同一實例
 *        上的另一個資料庫**，列數與來源全等（`User` 66／`Application` 1653／
 *        `AuditLog` 146，含 `summary` jsonb 全數非空），`_prisma_migrations`
 *        尾筆可讀；還原前後來源庫列數不變。詳細形狀由 T13 落地。
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-19(a)** DB 全庫（以產物之 TOC 確認 `AuditLog`／`_prisma_migrations`
 *     在場——`AuditLog.summary` 為該表之 `jsonb` 欄，隨表資料涵蓋）；
 *   · **AC-19(b)(c)** `att/`（含 `thumb`、含修正版複製之副本）與 `rpt/`（含
 *     `VoidedReportFile` 之 `void` 物件）全物件；
 *   · **AC-19(d)** 四來源鍵集聯集逐鍵在產物內，**缺一必紅**（以「拿掉一個位元組
 *     物件後重跑腳本必然非零結束」之紅燈物證證明守門承重，非恆真）；
 *   · **AC-19(e)** manifest 六欄（AC-19(e) 逐字之六項：時間戳／涵蓋範圍／各部分
 *     ／位元組數／雜湊／工具版本）＋ 鍵集封閉；
 *   · **AC-19(f)** 執行前後正式面 DB 與 storage 逐項全等（唯讀證明）；
 *   · **AC-22(a)(b)(c)** 產物零命中、日誌七類禁字零命中、憑證不經命令列。
 *
 * **T13 段（下半檔）另涵蓋**：
 *   · **AC-23(a)(b)(c)** 三項確認之端到端實跑（對本段自己以 `backup.sh` 產出的
 *     真備份）；(d) 三元組守門與正式面前後全等；(e) **防恆真**兩型 mutant
 *     （截斷／改位元組）＋ 一則深層對照（連 manifest 雜湊一起改寫，證明 (a) 不是
 *     單純的雜湊比對）；
 *   · **AC-24(a)~(d)** 驗證紀錄之五欄／追加／成功亦留／掃描器零命中；
 *   · **走廊條款兩則**（T10R FW-2）與**判準 mutant 自證六則**（D13 之完整性守門、
 *     抽樣三條件、B-19、M-6+M-8 證據等級、紀錄摘要封閉集合）。
 *
 * ---------------------------------------------------------------------------
 * 「正式面」在本檔指的是什麼（射程據實記載）
 * ---------------------------------------------------------------------------
 * 本檔在 **per-worker schema**（INFRA-001）內播種自己的資料，備份的 DB 目標是
 * **測試庫 `app_test`**（`backend/.env` 之 `DATABASE_URL`，t1-pg:55432），**不是**
 * compose 的 dev DB。`pg_dump` 是**唯讀**操作，涵蓋全庫（含 `public` 與其他 worker
 * schema）——這不違反 §11.0 #5，因為本檔**不曾改連 `public`**：所有讀寫一律經
 * 本 worker 的 schema，全庫 dump 只是「讀」的射程較寬。AC-19(f) 之「前後全等」
 * 亦以本 worker schema 之資料 ＋ 本檔自己的 storage 臨時樹為對象。
 */

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// T13：判準模組之純函式直接入格（mutant 自證）——CLI 之實跑面則由腳本端到端承擔。
import {
  FIXED_RELATION_CHECKS,
  NON_FK_CHECK_ID,
  type RelationRow,
  assessCoverageEvidence,
  evaluateRelationalIntegrity,
  evaluateRestoreTarget,
  formatVerificationRecord,
  selectAttachmentSample,
} from "../../src/platform/restore-check.js";
import { LocalVolumeStorage } from "../../src/storage/index.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BACKUP_SCRIPT = path.join(REPO_ROOT, "scripts", "backup.sh");
const ENV_SECRETS_TEST = path.join(__dirname, "phase11-env-secrets.test.ts");

const RUN_ID = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// ---------------------------------------------------------------------------
// 臨時樹（正式面之替身）：storage 兩根 ＋ 備份目的地（刻意互為獨立路徑）
// ---------------------------------------------------------------------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "t12-backup-"));
const ATT_ROOT = path.join(TMP_ROOT, "live", "att");
const RPT_ROOT = path.join(TMP_ROOT, "live", "rpt");
const DEST_ROOT = path.join(TMP_ROOT, "backups");

/** 本檔播種之四來源鍵（AC-19(d) 之聯集，逐鍵在下方斷言）。 */
const keys = {
  attOriginal: "",
  attThumb: "",
  attCopyOriginal: "",
  attCopyThumb: "",
  reportPdf: "",
  reportVoid: "",
};

let prisma: PrismaClient;
let backupId = "";
let backupDir = "";
let firstRunStdout = "";

/**
 * T12R SF-1 專用之**空 schema**：四張來源表都在、但一列都沒有。
 *
 * 刻意不借用某個 `vitest_w<N>`（那是別的 worker 的地盤，它有沒有列不由本檔決定，
 * 借來當「空」的前提隨時會失效）。命名刻意落在 `WORKER_SCHEMA_PATTERN`
 * （`^vitest_w[0-9]+$`）之外，避免撞上 INFRA-001 的孤兒清理正則——沿
 * `infra002-schema-drift.test.ts` 之 scratch-schema 紀律。
 */
const EMPTY_SCHEMA = `t12r_empty_${RUN_ID}`;

// ---------------------------------------------------------------------------
// 腳本執行 helper
// ---------------------------------------------------------------------------

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 跑一次 `scripts/backup.sh`。
 *
 * env **明列**（不繼承整個 `process.env` 之外再偷塞）：腳本讀什麼在這裡一目了然，
 * 也讓「憑證從哪來」這件事可稽核——本 helper 從不設定 `PGPASSWORD`，容器內之
 * local socket 認證即足夠（AC-22(c)）。
 */
function runBackup(overrides: Record<string, string> = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKUP_DEST_ROOT: DEST_ROOT,
    ATTACHMENT_STORAGE_ROOT: ATT_ROOT,
    REPORT_STORAGE_ROOT: RPT_ROOT,
    ...overrides,
  };
  try {
    const stdout = execFileSync("bash", [BACKUP_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

/** 容器內執行一段 sh（唯讀用途：TOC 列表、能力探測）。 */
function dockerExecSh(container: string, script: string, input?: Buffer): string {
  return execFileSync("docker", ["exec", "-i", container, "sh", "-c", script], {
    input: input ?? Buffer.alloc(0),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 由 `DATABASE_URL` 找出承載它的容器（與腳本同一套探索法）。 */
function discoverPgContainer(): string {
  const url = new URL(DB_URL as string);
  const port = url.port === "" ? "5432" : url.port;
  const names = execFileSync(
    "docker",
    ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    }
  )
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  expect(names).toHaveLength(1);
  return names[0] as string;
}

// ---------------------------------------------------------------------------
// storage 樹之快照（AC-19(f)）
// ---------------------------------------------------------------------------

function snapshotStorage(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join("/");
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

async function snapshotDb() {
  const [attachments, reports, voided, applications, users] = await Promise.all([
    prisma.attachment.findMany({ orderBy: { id: "asc" } }),
    prisma.report.findMany({ orderBy: { id: "asc" } }),
    prisma.voidedReportFile.findMany({ orderBy: { id: "asc" } }),
    prisma.application.findMany({ orderBy: { id: "asc" } }),
    prisma.user.findMany({ orderBy: { id: "asc" } }),
  ]);
  return JSON.parse(JSON.stringify({ attachments, reports, voided, applications, users }));
}

// ===========================================================================
// AC-12 掃描器之樣式（AC-22(a) 要求「同一掃描器」）
// ===========================================================================

/**
 * 這四條與 `phase11-env-secrets.test.ts` 之 `SECRET_PATTERNS` **必須逐字相同**，
 * 下方有一格以讀取該檔原始碼的方式機械證明此事（該檔為既有測試，本 Task 不得
 * 修改，故以複製 ＋ 機械比對代替 import）。
 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly id: string; readonly regex: RegExp }> = [
  { id: "conn-string", regex: /postgres(?:ql)?:\/\/[^\s:/@'"`]+:[^\s@'"`]+@/g },
  { id: "private-key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    id: "argon2-hash",
    regex: /\$argon2(?:id|i|d)\$[^$\s]+\$[^$\s]+\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{22,}/g,
  },
  {
    id: "long-secret",
    regex: /(?:secret|token|key|password)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9+/=]{32,}/gi,
  },
];

function scanText(content: string): Array<{ patternId: string; literal: string }> {
  const hits: Array<{ patternId: string; literal: string }> = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of content.matchAll(pattern.regex)) {
      hits.push({ patternId: pattern.id, literal: match[0] });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 播種
// ---------------------------------------------------------------------------

async function seed() {
  const attStorage = new LocalVolumeStorage(ATT_ROOT, { prefixes: ["att"] });
  const rptStorage = new LocalVolumeStorage(RPT_ROOT, { prefixes: ["rpt"] });

  const user = await prisma.user.create({
    data: {
      loginName: `t12-owner-${RUN_ID}`,
      displayName: "T12 備份測試擁有人",
      // 合成佔位字串，刻意**不是** argon2 形狀：本檔不需要可驗證的密碼，也就不必
      // 讓自己的播種資料新增一筆雜湊字面。
      passwordHash: `synthetic-placeholder-${RUN_ID}`,
      role: "USER",
    },
  });

  const application = await prisma.application.create({
    data: {
      type: "TRAVEL",
      status: "COMPLETED",
      ownerId: user.id,
      createdById: user.id,
      primaryDate: new Date("2026-08-01T00:00:00Z"),
      totalAmount: 1234,
      completedAt: new Date("2026-08-02T00:00:00Z"),
    },
  });

  // ── att/：一份原始附件（original ＋ thumb）＋ 一份「修正版複製之副本」 ──────
  const attId = `a${RUN_ID}`;
  const copyId = `c${RUN_ID}`;
  keys.attOriginal = `att/${attId}/original`;
  keys.attThumb = `att/${attId}/thumb`;
  keys.attCopyOriginal = `att/${copyId}/original`;
  keys.attCopyThumb = `att/${copyId}/thumb`;

  for (const [key, body] of [
    [keys.attOriginal, `original-bytes-${RUN_ID}`],
    [keys.attThumb, `thumb-bytes-${RUN_ID}`],
    [keys.attCopyOriginal, `revision-copy-original-${RUN_ID}`],
    [keys.attCopyThumb, `revision-copy-thumb-${RUN_ID}`],
  ] as const) {
    await attStorage.put(key, Buffer.from(body, "utf8"), "image/png");
  }

  for (const [id, storageKey, thumbnailKey] of [
    [attId, keys.attOriginal, keys.attThumb],
    [copyId, keys.attCopyOriginal, keys.attCopyThumb],
  ] as const) {
    await prisma.attachment.create({
      data: {
        id,
        status: "LINKED",
        storageKey,
        thumbnailKey,
        mimeType: "image/png",
        byteSize: 32,
        originalFilename: "synthetic.png",
        uploaderId: user.id,
        ownerId: user.id,
        refType: "TRIP_SEGMENT",
        refId: `seg-${RUN_ID}`,
        linkedAt: new Date("2026-08-02T00:00:00Z"),
      },
    });
  }

  // ── rpt/：正式 PDF ＋ 作廢版（VoidedReportFile，KNOWN_ISSUES §5-1） ─────────
  keys.reportPdf = `rpt/r${RUN_ID}/pdf`;
  keys.reportVoid = `rpt/v${RUN_ID}/void`;
  await rptStorage.put(
    keys.reportPdf,
    Buffer.from(`pdf-bytes-${RUN_ID}`, "utf8"),
    "application/pdf"
  );
  await rptStorage.put(
    keys.reportVoid,
    Buffer.from(`void-bytes-${RUN_ID}`, "utf8"),
    "application/pdf"
  );

  const report = await prisma.report.create({
    data: {
      applicationId: application.id,
      reportNumber: `TRV-T12-${RUN_ID}`,
      numberPrefix: "TRV",
      numberPeriod: "202608",
      sequence: 1,
      storageKey: keys.reportPdf,
      fileName: "TRV-T12.pdf",
      byteSize: 24,
      contentHash: crypto.createHash("sha256").update("pdf").digest("hex"),
      generatedById: user.id,
    },
  });

  await prisma.voidedReportFile.create({
    data: {
      reportId: report.id,
      storageKey: keys.reportVoid,
      fileName: "TRV-T12.pdf",
      byteSize: 24,
      contentHash: crypto.createHash("sha256").update("void").digest("hex"),
      createdById: user.id,
    },
  });
}

/**
 * 建 T12R SF-1 之空 schema：只造涵蓋查詢會讀到的那幾個欄位，不複製整份 schema
 * ——本 fixture 的用途是「四來源鍵集為空」，不是模擬一個可用的資料庫。
 */
async function createEmptySchema() {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${EMPTY_SCHEMA}"`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${EMPTY_SCHEMA}"."Attachment" ("storageKey" text, "thumbnailKey" text)`
  );
  for (const table of ["Report", "VoidedReportFile"]) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${EMPTY_SCHEMA}"."${table}" ("storageKey" text)`
    );
  }
}

async function dropEmptySchema() {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${EMPTY_SCHEMA}" CASCADE`);
}

async function cleanupSeed() {
  await prisma.voidedReportFile.deleteMany({ where: { fileName: "TRV-T12.pdf" } });
  await prisma.report.deleteMany({ where: { reportNumber: `TRV-T12-${RUN_ID}` } });
  await prisma.attachment.deleteMany({ where: { refId: `seg-${RUN_ID}` } });
  await prisma.application.deleteMany({ where: { owner: { loginName: `t12-owner-${RUN_ID}` } } });
  await prisma.user.deleteMany({ where: { loginName: `t12-owner-${RUN_ID}` } });
}

// ===========================================================================

describeWithDb("PHASE-011-T12 — 備份腳本（AC-19／AC-22）", () => {
  let dbBefore: unknown;
  let attBefore: Record<string, string>;
  let rptBefore: Record<string, string>;

  beforeAll(async () => {
    fs.mkdirSync(ATT_ROOT, { recursive: true });
    fs.mkdirSync(RPT_ROOT, { recursive: true });
    fs.mkdirSync(DEST_ROOT, { recursive: true });
    prisma = new PrismaClient();
    await seed();
    await createEmptySchema();

    dbBefore = await snapshotDb();
    attBefore = snapshotStorage(ATT_ROOT);
    rptBefore = snapshotStorage(RPT_ROOT);

    const run = runBackup();
    firstRunStdout = `${run.stdout}${run.stderr}`;
    if (run.status !== 0) {
      throw new Error(
        `backup.sh exited ${run.status}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`
      );
    }
    const ids = fs
      .readdirSync(DEST_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(ids).toHaveLength(1);
    backupId = ids[0] as string;
    backupDir = path.join(DEST_ROOT, backupId);
  }, 240_000);

  afterAll(async () => {
    await cleanupSeed();
    await dropEmptySchema();
    await prisma.$disconnect();
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  // =========================================================================
  // spike #1 — 環境能力（不可用即紅，不得靜默跳過）
  // =========================================================================

  it("spike #1: 備份所需之外部能力在本執行環境可用（docker ＋ 承載 DATABASE_URL 之容器 ＋ 容器內 pg_dump）", () => {
    const container = discoverPgContainer();
    const version = dockerExecSh(container, "pg_dump --version").trim();
    expect(version).toMatch(/^pg_dump \(PostgreSQL\) \d+/);

    // 客戶端與伺服器同一容器 → 主版本必然相同（D11-1(a) 選 (a) 的整個理由）
    const server = dockerExecSh(container, "postgres --version").trim();
    const major = (s: string) => /(\d+)\./.exec(s)?.[1];
    expect(major(version)).toBe(major(server));
  });

  // =========================================================================
  // AC-19 — 涵蓋範圍
  // =========================================================================

  it("AC-19(a): DB 全庫（產物 TOC 含 AuditLog 與 _prisma_migrations，`summary` jsonb 隨表涵蓋）", () => {
    const dump = fs.readFileSync(path.join(backupDir, "db.dump"));
    expect(dump.subarray(0, 5).toString("latin1")).toBe("PGDMP");

    // 自訂格式之 TOC 需可 seek，故先把產物送進容器的暫存檔再列（讀完即刪）。
    const container = discoverPgContainer();
    const toc = dockerExecSh(
      container,
      'f=$(mktemp) && cat > "$f" && pg_restore -l "$f"; rc=$?; rm -f "$f"; exit $rc',
      dump
    );

    expect(toc).toContain("_prisma_migrations");
    expect(toc).toContain("AuditLog");
    expect(toc).toContain("User");
    expect(toc).toContain("Application");
    // `AuditLog.summary` 是該表的欄位，其涵蓋隨 TABLE DATA 而來（KNOWN_ISSUES §5-15①）
    expect(toc).toMatch(/TABLE DATA .*AuditLog/);
  });

  it("AC-19(b): att/ 全物件含 thumb 與修正版複製之副本", () => {
    const entries = tarEntries(path.join(backupDir, "attachments.tar"));
    for (const key of [keys.attOriginal, keys.attThumb, keys.attCopyOriginal, keys.attCopyThumb]) {
      expect(entries).toContain(key);
    }
  });

  it("AC-19(c): rpt/ 全物件含 VoidedReportFile 之 void 物件", () => {
    const entries = tarEntries(path.join(backupDir, "reports.tar"));
    expect(entries).toContain(keys.reportPdf);
    expect(entries).toContain(keys.reportVoid);
  });

  it("AC-19(d): 四來源鍵集聯集逐鍵在產物內，且腳本自檢之計數與之相符", () => {
    const entries = new Set([
      ...tarEntries(path.join(backupDir, "attachments.tar")),
      ...tarEntries(path.join(backupDir, "reports.tar")),
    ]);
    const union = Object.values(keys);
    expect(union).toHaveLength(6);
    for (const key of union) expect(entries.has(key)).toBe(true);

    const manifest = readManifest();
    expect(manifest.coverage.missing).toBe(0);
    // 自檢查到的鍵數 ≥ 本檔播種之 6（同一 worker schema 可能有其他測試的殘留列，
    // 故取「不小於」而非全等——但**缺一必紅**由下一格的紅燈物證承擔）
    expect(manifest.coverage.keys).toBeGreaterThanOrEqual(union.length);
    expect(manifest.coverage.present).toBe(manifest.coverage.keys);
    // 這一次確實驗過（非 T12R SF-1 之「無對象而放行」）
    expect(manifest.coverage.allowEmpty).toBe(false);
  });

  it("AC-19(d) 紅燈物證：storage 少一個物件 → 腳本自檢必然失敗且非零結束（守門非恆真）", () => {
    const victim = path.join(ATT_ROOT, ...keys.attThumb.split("/"));
    const saved = fs.readFileSync(victim);
    fs.rmSync(victim);
    try {
      const run = runBackup();
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/coverage/);
      expect(`${run.stdout}${run.stderr}`).toMatch(/missing=1/);
    } finally {
      fs.writeFileSync(victim, saved);
      // 失敗的那一次仍會留下半成品目錄，清掉以免污染後續保留期斷言
      for (const dirent of fs.readdirSync(DEST_ROOT, { withFileTypes: true })) {
        if (dirent.isDirectory() && dirent.name !== backupId) {
          fs.rmSync(path.join(DEST_ROOT, dirent.name), { recursive: true, force: true });
        }
      }
    }
  }, 240_000);

  it("AC-19(e): manifest 六欄在場（時間戳／涵蓋範圍／各部分／位元組數／雜湊／工具版本）＋ 鍵集封閉", () => {
    const manifest = readManifest();

    // 六欄逐項（AC-19(e) 逐字）
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); // ①時間戳
    expect(manifest.scope).toEqual(["postgresql-database", "attachment-storage", "report-storage"]); // ②涵蓋範圍
    expect(manifest.parts).toHaveLength(3); // ③各部分
    for (const part of manifest.parts) {
      expect(part.bytes).toBeGreaterThan(0); // ④位元組數
      expect(part.sha256).toMatch(/^[0-9a-f]{64}$/); // ⑤雜湊
      const actual = fs.readFileSync(path.join(backupDir, part.file));
      expect(actual.byteLength).toBe(part.bytes);
      expect(crypto.createHash("sha256").update(actual).digest("hex")).toBe(part.sha256);
    }
    expect(Object.keys(manifest.tools).sort()).toEqual(["pg_dump", "script", "tar"]); // ⑥工具版本
    expect(manifest.tools.pg_dump).toMatch(/\d+\.\d+/);

    // 鍵集封閉：新增欄位必須有人有意識地更新本格（防「悄悄多寫了一個欄位」）
    expect(Object.keys(manifest).sort()).toEqual([
      "backupId",
      "coverage",
      "createdAt",
      "parts",
      "retentionDays",
      "scope",
      "tools",
    ]);
    // `coverage` 之子鍵亦封閉（T12R SF-1 新增 `allowEmpty`——這種「證據強度」欄位
    // 悄悄消失比悄悄新增更危險，故一併釘死）
    expect(Object.keys(manifest.coverage).sort()).toEqual([
      "allowEmpty",
      "keys",
      "missing",
      "present",
    ]);
    expect(manifest.backupId).toBe(backupId);
    expect(manifest.retentionDays).toBeGreaterThanOrEqual(14);
  });

  it("AC-19(f): 執行前後正式面 DB 與 storage 逐項全等（備份為唯讀）", async () => {
    expect(await snapshotDb()).toEqual(dbBefore);
    expect(snapshotStorage(ATT_ROOT)).toEqual(attBefore);
    expect(snapshotStorage(RPT_ROOT)).toEqual(rptBefore);

    // 可用性與全等分離（T10／T10R MF-1）：快照若取不到（空物件）就不算證明
    expect(Object.keys(attBefore).length).toBeGreaterThan(0);
    expect(Object.keys(rptBefore).length).toBeGreaterThan(0);
  });

  // =========================================================================
  // AC-22 — 產物與日誌零明文 secrets
  // =========================================================================

  it("AC-22(a): 備份產物（含 manifest 與任何中繼檔）經 AC-12 掃描器零命中", () => {
    const hits: Array<{ file: string; patternId: string }> = [];
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const content = fs.readFileSync(path.join(backupDir, entry.name)).toString("latin1");
      for (const hit of scanText(content))
        hits.push({ file: entry.name, patternId: hit.patternId });
    }
    expect(hits).toEqual([]);
  });

  it("AC-22(a) 據實揭露：`db.dump` 為壓縮產物，文字掃描對其內容不具鑑別力", () => {
    // 反向探針：一個**確定寫進資料庫**的字面（本檔播種之 loginName）在壓縮產物裡
    // 找不到 → 證明上一格對 `db.dump` 的零命中是「掃不進去」而非「裡面很乾淨」。
    // 這一格存在的意義是不讓 AC-22(a) 的綠燈被誤讀（沿本專案「據實記載、不過度
    // 宣稱」紀律）。DB 內容之敏感面由 D11-2=(a) 之目的地存取控制 ＋ AC-21 路徑守門
    // ＋ Runbook 權限要求承擔，不由文字掃描承擔。
    const dump = fs.readFileSync(path.join(backupDir, "db.dump")).toString("latin1");
    expect(dump).not.toContain(`t12-owner-${RUN_ID}`);

    // 對照組：未壓縮的 tar 產物裡，同樣的字面**找得到** → 掃描器本身沒壞
    const tar = fs.readFileSync(path.join(backupDir, "attachments.tar")).toString("latin1");
    expect(tar).toContain(RUN_ID);
  });

  it("AC-22(a): 本檔之掃描樣式與 phase11-env-secrets.test.ts 逐字同一份（同一掃描器）", () => {
    const source = fs.readFileSync(ENV_SECRETS_TEST, "utf8");
    const declared = [
      ...source.matchAll(/regex:\s*(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/[gimsuy]*)/g),
    ].map((m) => m[1]);
    expect(declared).toEqual(SECRET_PATTERNS.map((p) => p.regex.toString()));
  });

  it("AC-22(b): 腳本日誌輸出七類禁字零命中（含目的地與 storage 絕對路徑、storageKey 完整值）", () => {
    expect(firstRunStdout.length).toBeGreaterThan(0);
    expect(scanText(firstRunStdout)).toEqual([]);

    for (const absolute of [ATT_ROOT, RPT_ROOT, DEST_ROOT, TMP_ROOT]) {
      expect(firstRunStdout).not.toContain(absolute);
      expect(firstRunStdout).not.toContain(absolute.split(path.sep).join("/"));
    }
    for (const key of Object.values(keys)) {
      expect(firstRunStdout).not.toContain(key);
    }
    expect(firstRunStdout).not.toMatch(/postgres(ql)?:\/\//);
    // 反向對照：輸出並非空殼——摘要該有的東西都在
    expect(firstRunStdout).toContain(backupId);
    expect(firstRunStdout).toMatch(/coverage/);
  });

  it("AC-22(c): 腳本取得 DB 憑證不經命令列參數（結構斷言）", () => {
    const script = fs.readFileSync(BACKUP_SCRIPT, "utf8");
    const code = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    // ①零密碼旗標；②不把 PGPASSWORD 塞進 `docker exec -e`（那會進主機行程表）；
    // ③零連線字串字面；④不以命令列傳遞任何 PG* 憑證變數之值。
    expect(code).not.toMatch(/--password/);
    expect(code).not.toMatch(/-W\b/);
    expect(code).not.toMatch(/-e\s+PGPASSWORD/);
    expect(code).not.toMatch(/--env\s+PGPASSWORD/);
    expect(code).not.toMatch(/PGPASSWORD=/);
    expect(code).not.toMatch(/postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/);
    expect(scanText(script)).toEqual([]);

    // 反向對照：腳本確實有在跑 pg_dump（否則以上禁令是空的）
    expect(code).toMatch(/pg_dump/);
  });

  // =========================================================================
  // 判定與執行之分工（腳本不自行判斷該刪誰／該不該寫）
  // =========================================================================

  it("腳本之保留期與目的地判準一律委由 backup-policy（腳本內零判準）", () => {
    const script = fs.readFileSync(BACKUP_SCRIPT, "utf8");
    const code = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(code).toContain("check-destination");
    expect(code).toContain("plan-retention");
    // 腳本內不得出現自己算天數／自己比路徑前綴的痕跡
    expect(code).not.toMatch(/RETENTION_DAYS\s*\*/);
    expect(code).not.toMatch(/86400/);
    expect(code).not.toMatch(/-mtime/);
  });

  // =========================================================================
  // AC-21 之腳本端到端（守門真的擋得住，不只是純函式會回 false）
  // =========================================================================

  it("AC-21: 目的地落在 storage 樹內 → 腳本拒跑、非零結束、零產物、訊息零路徑值", () => {
    const insideStorage = path.join(ATT_ROOT, "backups-oops");
    const attBeforeGuard = snapshotStorage(ATT_ROOT);

    const run = runBackup({ BACKUP_DEST_ROOT: insideStorage });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    expect(output).toContain("BACKUP_DEST_ROOT");
    expect(output).toContain("ATTACHMENT_STORAGE_ROOT");
    expect(output).toContain("descendant-of-protected");
    expect(output).not.toContain(ATT_ROOT);
    expect(output).not.toContain(ATT_ROOT.split(path.sep).join("/"));

    // 被拒的那一跑不得在正式資料樹裡留下任何東西（連空目錄都不行）
    expect(fs.existsSync(insideStorage)).toBe(false);
    expect(snapshotStorage(ATT_ROOT)).toEqual(attBeforeGuard);
  }, 240_000);

  // =========================================================================
  // AC-20 之腳本端到端 —— **不可逆刪除之物證**（Spec §11.0 #3）
  // =========================================================================

  it("AC-20: 保留期清理之實際刪除行為（過期者刪、保留期內者留、非備份目錄不碰）", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const idOf = (ms: number) =>
      `${new Date(ms)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z")}`;

    const now = Date.now();
    const expired = idOf(now - 15 * dayMs); // 15 天前 → 超過 14 → 刪
    // 13 天 23 小時：仍在保留期內。**刻意不取「恰 14 天整」**——腳本執行需要數秒，
    // 那幾秒會讓「恰 N 天」變成「N 天又幾秒」而正確地被刪掉。嚴格大於之**邊界**由
    // `backup-retention.test.ts` 以注入之 `now` 精準守住（那裡沒有時鐘漂移）；本格
    // 守的是腳本端「該刪的真的刪了、不該刪的一個都沒少」。
    const within = idOf(now - 14 * dayMs + 60 * 60 * 1000);
    const stranger = "not-a-backup-dir"; // 不符命名 → 一律不碰

    for (const name of [expired, within, stranger]) {
      fs.mkdirSync(path.join(DEST_ROOT, name), { recursive: true });
      fs.writeFileSync(path.join(DEST_ROOT, name, "marker.txt"), name);
    }

    const run = runBackup();
    expect(run.status).toBe(0);
    expect(`${run.stdout}`).toMatch(/retention: days=14 removed=1/);

    const remaining = fs
      .readdirSync(DEST_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(remaining).not.toContain(expired); // 刪了
    expect(remaining).toContain(within); // 保留期內留著（AC-20(a)）
    expect(remaining).toContain(stranger); // 陌生目錄不碰
    expect(remaining).toContain(backupId); // 先前那份仍在（未過期）
    // 這一跑剛做好的那份也必然還在：`plan-retention` 若把它列進來，腳本會硬失敗
    expect(remaining.length).toBeGreaterThanOrEqual(4);
    expect(fs.readFileSync(path.join(DEST_ROOT, stranger, "marker.txt"), "utf8")).toBe(stranger);
  }, 240_000);

  // =========================================================================
  // T12R 即審修法之回歸格（SF-1／SF-2／SF-4／AR-1／AR-2）
  // =========================================================================

  it("T12R SF-1: 四來源鍵集為空 → **拒跑**（涵蓋自檢不得在無對象時恆真）", () => {
    // 指向一個沒有任何附件／報表列的 schema：舊版會 keys=0／missing=0／exit 0，
    // 且日誌形狀與「真的驗過」那一次一模一樣——「沒東西可驗」與「驗過都在」同結局，
    // 正是 T10／T10R MF-1 明令禁止的走廊。
    const emptySchemaUrl = `${DB_URL as string}${(DB_URL as string).includes("?") ? "&" : "?"}schema=${EMPTY_SCHEMA}`;
    const before = listBackupDirs();

    const run = runBackup({ BACKUP_DATABASE_URL: emptySchemaUrl });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    expect(output).toMatch(/keys=0/);
    expect(output).toMatch(/nothing to verify/);
    expect(output).toContain("BACKUP_ALLOW_EMPTY=1"); // 訊息含承認旗標之用法
    expect(output).toContain("DATABASE_URL"); // 與 storage root 之排查指引
    // 拒跑之後不得留下半成品（它會被下次保留期清理當成一份真備份）
    expect(listBackupDirs()).toEqual(before);
  }, 240_000);

  it("T12R SF-1 反向：`BACKUP_ALLOW_EMPTY=1` → 放行，且日誌與 manifest 皆帶 allow-empty 標記", () => {
    const emptySchemaUrl = `${DB_URL as string}${(DB_URL as string).includes("?") ? "&" : "?"}schema=${EMPTY_SCHEMA}`;
    const before = listBackupDirs();

    const run = runBackup({ BACKUP_DATABASE_URL: emptySchemaUrl, BACKUP_ALLOW_EMPTY: "1" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/allow-empty=yes/);

    const created = listBackupDirs().filter((id) => !before.includes(id));
    expect(created).toHaveLength(1);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(DEST_ROOT, created[0] as string, "manifest.json"), "utf8")
    ) as Manifest;

    // 產物自身可辨識：一份「沒驗過涵蓋」的備份不得與「驗過都在」的長得一樣
    expect(manifest.coverage.allowEmpty).toBe(true);
    expect(manifest.coverage.keys).toBe(0);

    fs.rmSync(path.join(DEST_ROOT, created[0] as string), { recursive: true, force: true });
  }, 240_000);

  it("T12R SF-4: 失敗路徑之輸出零絕對路徑（外部工具 stderr 不得穿透）", () => {
    const missingRoot = path.join(TMP_ROOT, "live", "gone-missing");
    expect(fs.existsSync(missingRoot)).toBe(false);

    const run = runBackup({ ATTACHMENT_STORAGE_ROOT: missingRoot });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    expect(output).toContain("ATTACHMENT_STORAGE_ROOT"); // 以變數名回報
    // `tar: <絕對路徑>: Cannot open …` 之逐字穿透是本格要擋的東西
    expect(output).not.toContain(missingRoot);
    expect(output).not.toContain(missingRoot.split(path.sep).join("/"));
    expect(output).not.toContain(TMP_ROOT);
    expect(output).not.toContain(TMP_ROOT.split(path.sep).join("/"));
    expect(output).not.toMatch(/^tar:/m);

    // ── T12R-2 SF-4-R 子情境：**目的地不可建立** ──────────────────────────────
    // 前一輪關了三個外部工具卻漏掉 `mkdir`。掛載點權限／路徑打錯是備份最常見的失敗，
    // 也就是最常被排程器記進日誌的那一條：`mkdir: cannot create directory '<絕對路徑>'`。
    // 以「BACKUP_DEST_ROOT 指向某個**檔案**之子路徑」造出必然失敗且與權限無關的條件
    // （跨平台可重現，不需要唯讀掛載點）。
    const blockingFile = path.join(TMP_ROOT, "not-a-directory");
    fs.writeFileSync(blockingFile, "occupied");
    const unusableDest = path.join(blockingFile, "sub");

    const denied = runBackup({ BACKUP_DEST_ROOT: unusableDest });
    const deniedOutput = `${denied.stdout}${denied.stderr}`;

    expect(denied.status).not.toBe(0);
    expect(deniedOutput).toContain("BACKUP_DEST_ROOT"); // 以變數名回報
    expect(deniedOutput).not.toContain(blockingFile);
    expect(deniedOutput).not.toContain(blockingFile.split(path.sep).join("/"));
    expect(deniedOutput).not.toContain(TMP_ROOT);
    expect(deniedOutput).not.toContain(TMP_ROOT.split(path.sep).join("/"));
    expect(deniedOutput).not.toMatch(/^mkdir:/m);
  }, 240_000);

  it("T12R SF-2／AR-1／AR-2: 三處結構紀律（群組 pipeline／先驗證後刪除／訊號清理）", () => {
    const script = fs.readFileSync(BACKUP_SCRIPT, "utf8");
    const code = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    // SF-2：`{ …; …; } | … || die` 之群組形狀不得再出現（群組取最後一個命令之結束碼，
    // 第一個 tar 失敗時三道守門全不觸發）。改為逐個 archive 各自守門。
    expect(code).not.toMatch(/\}\s*\|\s*sed[^\n]*\|\|\s*die/);
    expect(code).toMatch(/for archive in attachments reports/);

    // AR-1：`rm -rf` 不得出現在讀取 policy 輸出的驗證迴圈裡（先全驗完才准刪）
    const validationLoop = /while IFS= read -r id;[\s\S]*?done <<< "\$REMOVE_LIST"/.exec(code);
    expect(validationLoop).not.toBeNull();
    expect((validationLoop as RegExpExecArray)[0]).not.toContain("rm -rf");
    expect((validationLoop as RegExpExecArray)[0]).toContain("VALIDATED_IDS+=");
    expect(code).toMatch(/nothing has been removed/);

    // AR-2：INT／TERM 亦須收斂到同一份 cleanup（半成品目錄不得因 Ctrl-C 而殘留）
    expect(code).toMatch(/trap cleanup EXIT/);
    expect(code).toMatch(/trap '[^']*' INT/);
    expect(code).toMatch(/trap '[^']*' TERM/);
  });
});

// ===========================================================================
// PHASE-011-T13 — 還原驗證流程 ＋ 失敗紀錄（AC-23／AC-24；§16 D13=(a)+(b) 併用）
// ===========================================================================
//
// 與上方 T12 段之關係：本段**不共用**臨時樹，也不共用 `prisma` 實例——它自己
// 播種、自己跑一次 `scripts/backup.sh` 取得一份**真備份**，再對那份備份跑
// `scripts/verify-restore.sh`。分開的理由是 T12 之 AC-19(f) 以「整份 DB 快照
// 前後全等」為斷言，本段的播種若落在它的射程內就會把它弄紅。
//
// 「正式面」在本段指的是：本 worker schema 之資料 ＋ 本段自己的 storage 臨時樹
// ＋ **來源資料庫本身**（`app_test`）。還原一律進到一個**本段建立、用畢即刪**的
// 獨立資料庫，故 AC-23(d) 之前後全等以此三者為對象。

const T13_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "t13-restore-"));
const T13_ATT = path.join(T13_TMP, "live", "att");
const T13_RPT = path.join(T13_TMP, "live", "rpt");
const T13_DEST = path.join(T13_TMP, "backups");
const T13_LOG = path.join(T13_TMP, "verify-restore.log");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "verify-restore.sh");

const T13_RUN = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
/** 不含 `-`／大寫：要當 PostgreSQL 資料庫名與 schema 名用。 */
const T13_TAG = `t13${T13_RUN.replace(/[^0-9a-z]/g, "")}`;
/**
 * 走廊條款專用之 scratch schema：五張**無外鍵、無資料**之樁表 ＋ 一列
 * `_prisma_migrations`。用途有二，皆為「可用性與結論分離」之負向對照：
 *   ①`Attachment` 零列 → 抽樣抽不到 → 不得與「抽樣通過」同結局；
 *   ②零外鍵 → 動態列舉回零列 → 不得與「無孤兒」同結局。
 * 命名刻意落在 `WORKER_SCHEMA_PATTERN`（`^vitest_w[0-9]+$`）之外。
 */
const T13_SCRATCH = `${T13_TAG}_scratch`;

let t13Prisma: PrismaClient;
let t13BackupId = "";
let t13TargetSeq = 0;
/** 修正版申請之 id ＋ 其 `supersedesId`（T13R SF-2 之降級 fixture 要暫時解開這條關係）。 */
let t13RevisionAppId = "";
let t13SupersedesId = "";

interface VerifyTarget {
  readonly db: string;
  readonly url: string;
}

/** 以來源之主機／憑證為底、指向另一個資料庫名的目標連線字串。 */
function targetUrlFor(db: string): VerifyTarget {
  const url = new URL(DB_URL as string);
  url.pathname = `/${db}`;
  url.search = "";
  return { db, url: url.toString() };
}

/** 每次執行取一個新的隔離目標名（同一名字重用會被「目標已存在」守門擋下）。 */
function nextVerifyTarget(): VerifyTarget {
  t13TargetSeq += 1;
  return targetUrlFor(`${T13_TAG}_r${t13TargetSeq}`);
}

/** 以來源連線字串為底、換掉 `schema=` 參數（走廊條款用）。 */
function sourceUrlWithSchema(schema: string): string {
  const url = new URL(DB_URL as string);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function runVerify(
  target: VerifyTarget,
  overrides: Record<string, string> = {},
  destRoot: string = T13_DEST
): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKUP_DEST_ROOT: destRoot,
    RESTORE_TARGET_DATABASE_URL: target.url,
    RESTORE_VERIFY_LOG: T13_LOG,
    ...overrides,
  };
  try {
    const stdout = execFileSync("bash", [VERIFY_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

/**
 * 起一次 `verify-restore.sh`，**等到指定日誌行出現的當下**送 `SIGTERM`（T13R2 NF-2）。
 *
 * 為什麼以日誌行而非固定秒數為觸發點：時間常數在別台機器上會漂移，而每一行日誌都
 * 恰好印在某個階段的邊界上，以它為觸發點，中斷落在哪個階段是**由腳本自己的進度決定
 * 的**，不是由計時器決定的。
 *
 * 訊號投遞有兩個坑，兩個都繞掉了：
 *   ①Node 於 Windows 之 `child.kill('SIGTERM')` 走 `TerminateProcess`（不是 POSIX
 *     訊號，bash 的 trap 收不到）→ 改由另一個 Git Bash 發 `kill -TERM`；
 *   ②`child.pid` 是 **Windows PID**，而 MSYS 的 `kill` 認的是 **MSYS PID**——直接拿
 *     前者去 kill 會得到 `No such process`（實測）。故以一層 `bash -c 'echo $$ >
 *     pidfile; exec bash script'` 把自己的 MSYS PID 寫出來；`exec` 不換行程，寫出來
 *     的就是腳本本身的 PID。
 * `SIGINT` 即使這樣繞也投不進去（T13R 已據實記載），故本格只驗 `SIGTERM`。
 */
function runVerifyThenTerm(
  target: VerifyTarget,
  marker: RegExp,
  overrides: Record<string, string> = {}
): Promise<{ readonly code: number | null; readonly output: string; readonly signalled: boolean }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BACKUP_DEST_ROOT: T13_DEST,
    RESTORE_TARGET_DATABASE_URL: target.url,
    RESTORE_VERIFY_LOG: T13_LOG,
    ...overrides,
  };
  const pidFile = path.join(T13_TMP, `term-${target.db}.pid`).split(path.sep).join("/");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", 'echo $$ > "$1"; exec bash "$2"', "sh", pidFile, VERIFY_SCRIPT],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    let signalled = false;
    const maybeKill = (chunk: Buffer) => {
      output += chunk.toString();
      if (!signalled && marker.test(output)) {
        signalled = true;
        const msysPid = fs.readFileSync(pidFile, "utf8").trim();
        execFileSync("bash", ["-c", `kill -TERM ${msysPid}`]);
      }
    };
    child.stdout.on("data", maybeKill);
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, signalled }));
  });
}

interface VerificationRecord {
  readonly timestamp: string;
  readonly backupId: string;
  readonly stage: string;
  readonly summary: string;
  readonly exitCode: number;
  readonly evidence: string;
}

function readRecords(): VerificationRecord[] {
  if (!fs.existsSync(T13_LOG)) return [];
  return fs
    .readFileSync(T13_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as VerificationRecord);
}

/** 目標資料庫是否存在（用畢零殘留之自證）。 */
function databaseExists(name: string): boolean {
  const out = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      discoverPgContainer(),
      "psql",
      "-U",
      new URL(DB_URL as string).username,
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
    ],
    { encoding: "utf8" }
  );
  return out.trim() === "1";
}

/** 複製一份備份到獨立目的地（防恆真 mutant 之工作區，不動原件）。 */
function cloneBackupTo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, t13BackupId);
  fs.cpSync(path.join(T13_DEST, t13BackupId), target, { recursive: true });
  return target;
}

/**
 * T13 播種：一組**含修正版關係**之真實形狀資料。
 *
 * AC-23(b) 要求抽樣須含「至少一個修正版副本」——本專案之「修正版」語意在
 * `Application.supersedesId`（PHASE-009 D7），附件則是**掛在修正版申請之
 * `TripSegment` 上的那一份**。T12 的播種沒有這條關係（它只需要「多一個物件」），
 * 故本段自行播種一組：原申請 A（含附件）＋ 修正版申請 B（`supersedesId = A`，
 * 含其自己的附件副本）＋ A 之正式報表與作廢版檔。
 */
async function seedT13() {
  const attStorage = new LocalVolumeStorage(T13_ATT, { prefixes: ["att"] });
  const rptStorage = new LocalVolumeStorage(T13_RPT, { prefixes: ["rpt"] });

  const user = await t13Prisma.user.create({
    data: {
      loginName: `t13-owner-${T13_RUN}`,
      displayName: "T13 還原驗證測試擁有人",
      passwordHash: `synthetic-placeholder-${T13_RUN}`,
      role: "USER",
    },
  });

  const makeTravel = async (suffix: string, supersedesId?: string) => {
    const app = await t13Prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: user.id,
        createdById: user.id,
        primaryDate: new Date("2026-08-01T00:00:00Z"),
        totalAmount: 999,
        completedAt: new Date("2026-08-02T00:00:00Z"),
        ...(supersedesId === undefined ? {} : { supersedesId }),
      },
    });
    await t13Prisma.travelApplication.create({
      data: { applicationId: app.id, tripDate: new Date("2026-08-01T00:00:00Z") },
    });
    const segment = await t13Prisma.tripSegment.create({
      data: { id: `seg-${suffix}-${T13_RUN}`, travelApplicationId: app.id, sortOrder: 0 },
    });
    return { app, segment };
  };

  const origin = await makeTravel("origin");
  const revision = await makeTravel("revision", origin.app.id);
  t13RevisionAppId = revision.app.id;
  t13SupersedesId = origin.app.id;

  const attach = async (label: string, segmentId: string) => {
    const id = `${label}${T13_RUN}`;
    const storageKey = `att/${id}/original`;
    const thumbnailKey = `att/${id}/thumb`;
    await attStorage.put(storageKey, Buffer.from(`orig-${label}-${T13_RUN}`, "utf8"), "image/png");
    await attStorage.put(
      thumbnailKey,
      Buffer.from(`thumb-${label}-${T13_RUN}`, "utf8"),
      "image/png"
    );
    await t13Prisma.attachment.create({
      data: {
        id,
        status: "LINKED",
        storageKey,
        thumbnailKey,
        mimeType: "image/png",
        byteSize: 32,
        originalFilename: "synthetic.png",
        uploaderId: user.id,
        ownerId: user.id,
        refType: "TRIP_SEGMENT",
        refId: segmentId,
        linkedAt: new Date("2026-08-02T00:00:00Z"),
      },
    });
  };

  await attach("o", origin.segment.id); // 原申請之附件（非修正版）
  await attach("v", revision.segment.id); // 修正版申請之附件副本（AC-23(b) 必含）

  const reportKey = `rpt/r13${T13_RUN}/pdf`;
  const voidKey = `rpt/v13${T13_RUN}/void`;
  await rptStorage.put(reportKey, Buffer.from(`pdf-${T13_RUN}`, "utf8"), "application/pdf");
  await rptStorage.put(voidKey, Buffer.from(`void-${T13_RUN}`, "utf8"), "application/pdf");

  const report = await t13Prisma.report.create({
    data: {
      applicationId: origin.app.id,
      reportNumber: `TRV-T13-${T13_RUN}`,
      numberPrefix: "TRV",
      numberPeriod: "202608",
      sequence: 2,
      storageKey: reportKey,
      fileName: "TRV-T13.pdf",
      byteSize: 24,
      contentHash: crypto.createHash("sha256").update("pdf13").digest("hex"),
      generatedById: user.id,
    },
  });
  await t13Prisma.voidedReportFile.create({
    data: {
      reportId: report.id,
      storageKey: voidKey,
      fileName: "TRV-T13.pdf",
      byteSize: 24,
      contentHash: crypto.createHash("sha256").update("void13").digest("hex"),
      createdById: user.id,
    },
  });
}

/** 走廊條款 fixture：零外鍵、零資料，但 `_prisma_migrations` 有尾筆（讓 (a) 過得去）。 */
async function createScratchSchema() {
  await t13Prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${T13_SCRATCH}"`);
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."_prisma_migrations" ("migration_name" text, "finished_at" timestamptz)`
  );
  await t13Prisma.$executeRawUnsafe(
    `INSERT INTO "${T13_SCRATCH}"."_prisma_migrations" VALUES ('scratch_only', now())`
  );
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."Attachment" ("storageKey" text, "thumbnailKey" text, "status" text, "refType" text, "refId" text)`
  );
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."TripSegment" ("id" text, "travelApplicationId" text)`
  );
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."Application" ("id" text, "supersedesId" text)`
  );
  for (const table of ["MaintenanceApplication", "DepreciationApplication"]) {
    await t13Prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."${table}" ("applicationId" text)`
    );
  }
  // `Report`／`VoidedReportFile` 要有列，否則備份腳本之涵蓋自檢會因「四來源皆空」
  // 而拒跑（T12R SF-1）——本 fixture 要證的是**還原驗證**的走廊，不是備份的。
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."Report" ("storageKey" text)`
  );
  await t13Prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${T13_SCRATCH}"."VoidedReportFile" ("storageKey" text)`
  );
}

describeWithDb("PHASE-011-T13 — 還原驗證流程（AC-23／AC-24）", () => {
  let mainRun: RunResult;
  let mainTarget: VerifyTarget;
  let dbBefore: unknown;
  let attBefore: Record<string, string>;
  let rptBefore: Record<string, string>;

  beforeAll(async () => {
    fs.mkdirSync(T13_ATT, { recursive: true });
    fs.mkdirSync(T13_RPT, { recursive: true });
    fs.mkdirSync(T13_DEST, { recursive: true });
    t13Prisma = new PrismaClient();
    await seedT13();
    await createScratchSchema();

    // 一份**真備份**（同一支 T12 腳本，非本段自製產物）
    const backup = execFileSync("bash", [BACKUP_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BACKUP_DEST_ROOT: T13_DEST,
        ATTACHMENT_STORAGE_ROOT: T13_ATT,
        REPORT_STORAGE_ROOT: T13_RPT,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
    });
    expect(backup).toMatch(/done id=/);
    const ids = fs
      .readdirSync(T13_DEST, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(ids).toHaveLength(1);
    t13BackupId = ids[0] as string;

    dbBefore = await snapshotT13Db();
    attBefore = snapshotStorage(T13_ATT);
    rptBefore = snapshotStorage(T13_RPT);

    mainTarget = nextVerifyTarget();
    mainRun = runVerify(mainTarget);
    if (mainRun.status !== 0) {
      throw new Error(
        `verify-restore.sh exited ${mainRun.status}\n--- stdout ---\n${mainRun.stdout}\n--- stderr ---\n${mainRun.stderr}`
      );
    }
  }, 300_000);

  afterAll(async () => {
    await t13Prisma.voidedReportFile.deleteMany({ where: { fileName: "TRV-T13.pdf" } });
    await t13Prisma.report.deleteMany({ where: { reportNumber: `TRV-T13-${T13_RUN}` } });
    await t13Prisma.attachment.deleteMany({
      where: { uploader: { loginName: `t13-owner-${T13_RUN}` } },
    });
    await t13Prisma.tripSegment.deleteMany({ where: { id: { contains: T13_RUN } } });
    await t13Prisma.travelApplication.deleteMany({
      where: { application: { owner: { loginName: `t13-owner-${T13_RUN}` } } },
    });
    await t13Prisma.application.deleteMany({
      where: { owner: { loginName: `t13-owner-${T13_RUN}` }, supersedesId: { not: null } },
    });
    await t13Prisma.application.deleteMany({
      where: { owner: { loginName: `t13-owner-${T13_RUN}` } },
    });
    await t13Prisma.user.deleteMany({ where: { loginName: `t13-owner-${T13_RUN}` } });
    await t13Prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${T13_SCRATCH}" CASCADE`);
    await t13Prisma.$disconnect();
    fs.rmSync(T13_TMP, { recursive: true, force: true });
  }, 60_000);

  // =========================================================================
  // AC-23 — 三項確認
  // =========================================================================

  describe("AC-23: 還原驗證三項", () => {
    it("(a) DB 可開啟 ＋ _prisma_migrations 尾筆相符", () => {
      expect(mainRun.status).toBe(0);
      expect(mainRun.stdout).toMatch(/\(a\) [^\n]*migration-tail=match/);
      expect(mainRun.stdout).toMatch(/target=created/);
    });

    it("(b) 附件抽樣 ≥3（含 thumb、含修正版副本）雜湊對 manifest 全等", () => {
      // 部件層：三份產物之 sha256 逐一對 manifest 全等（T12 交接：`parts[].sha256`）
      expect(mainRun.stdout).toMatch(/parts-verified=3/);
      // 物件層：抽樣自**還原之 storage**，樣本數 ≥3 且含 thumb、含修正版副本
      const sample = /sample n=(\d+) thumb=(\d+) revision=(\d+) readable=(\d+)/.exec(
        mainRun.stdout
      );
      expect(sample).not.toBeNull();
      const [, n, thumb, revision, readable] = sample as RegExpExecArray;
      expect(Number(n)).toBeGreaterThanOrEqual(3);
      expect(Number(thumb)).toBeGreaterThanOrEqual(1);
      expect(Number(revision)).toBeGreaterThanOrEqual(1);
      expect(Number(readable)).toBe(Number(n));
    });

    it("(c) 關聯完整性七項逐一無孤兒", () => {
      const line = /\(c\) relations checked=(\d+) fk=(\d+) fixed=(\d+) orphans=(\d+)/.exec(
        mainRun.stdout
      );
      expect(line).not.toBeNull();
      const [, checked, fk, fixed, orphans] = line as RegExpExecArray;
      expect(Number(orphans)).toBe(0);
      expect(Number(fixed)).toBe(1); // 七項中唯一之非外鍵項（Attachment.refId）
      expect(Number(fk)).toBeGreaterThanOrEqual(8); // 七項展開後之外鍵邊 ≥8
      expect(Number(checked)).toBe(Number(fk) + Number(fixed));
      // 七項固定清單 ⊆ 動態列舉（D13 之完整性守門）——清單過時即紅
      expect(mainRun.stdout).toMatch(/fixed-list=7\/7/);
    });
  });

  it("AC-23(d)／B-19: 還原目標與正式為同一三元組 → 拒絕；流程前後正式面逐項全等", async () => {
    const before = readRecords().length;
    const run = runVerify({ db: "unused", url: DB_URL as string });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    expect(output).toContain("RESTORE_TARGET_DATABASE_URL");
    expect(output).toMatch(/summary=restore-target-equals-source/);
    expect(output).not.toMatch(/postgres(ql)?:\/\//);
    const records = readRecords();
    expect(records).toHaveLength(before + 1);
    expect(records[records.length - 1]?.stage).toBe("guard");

    // 流程前後正式面逐項全等（AC-23(d)）：主跑 ＋ 本格之拒跑皆未觸及正式面
    expect(await snapshotT13Db()).toEqual(dbBefore);
    expect(snapshotStorage(T13_ATT)).toEqual(attBefore);
    expect(snapshotStorage(T13_RPT)).toEqual(rptBefore);
    expect(Object.keys(attBefore).length).toBeGreaterThan(0);
    expect(Object.keys(rptBefore).length).toBeGreaterThan(0);
  }, 300_000);

  it("AC-23(e)／B-20: 截斷／改位元組之備份 → 驗證必然失敗且被三項之一捕捉（防恆真）", () => {
    // ── 型①：截斷 tar → 部件雜湊不符 → 被 (b) 捕捉 ──────────────────────────
    const truncDest = path.join(T13_TMP, "mutant-truncate");
    const truncDir = cloneBackupTo(truncDest);
    const tarPath = path.join(truncDir, "attachments.tar");
    const original = fs.readFileSync(tarPath);
    fs.writeFileSync(tarPath, original.subarray(0, original.byteLength - 2048));

    const truncTarget = nextVerifyTarget();
    const trunc = runVerify(truncTarget, {}, truncDest);
    expect(trunc.status).not.toBe(0);
    expect(`${trunc.stdout}${trunc.stderr}`).toMatch(/stage=b summary=archive-hash-mismatch/);
    expect(databaseExists(truncTarget.db)).toBe(false); // 失敗路徑亦零殘留

    // ── 型②：改一位元組（db.dump）→ 被 (a) 捕捉 ────────────────────────────
    const flipDest = path.join(T13_TMP, "mutant-flip");
    const flipDir = cloneBackupTo(flipDest);
    const dumpPath = path.join(flipDir, "db.dump");
    const dump = fs.readFileSync(dumpPath);
    const victim = Math.floor(dump.byteLength / 2);
    dump[victim] = (dump[victim] as number) ^ 0xff;
    fs.writeFileSync(dumpPath, dump);

    const flipTarget = nextVerifyTarget();
    const flip = runVerify(flipTarget, {}, flipDest);
    expect(flip.status).not.toBe(0);
    expect(`${flip.stdout}${flip.stderr}`).toMatch(/stage=a summary=db-dump-hash-mismatch/);
    expect(databaseExists(flipTarget.db)).toBe(false);
  }, 600_000);

  it("AC-23(e) 深層: 改位元組**並同步改寫 manifest 雜湊** → pg_restore 自身仍必然失敗（證明 (a) 不只是雜湊比對）", () => {
    const deepDest = path.join(T13_TMP, "mutant-deep");
    const deepDir = cloneBackupTo(deepDest);
    const dumpPath = path.join(deepDir, "db.dump");
    const dump = fs.readFileSync(dumpPath);
    // 挑 dump 前段（TOC／資料區塊）動手，確保不是只改到尾端填充
    for (let i = 0; i < 4096; i += 1) {
      dump[600 + i] = (dump[600 + i] as number) ^ 0x5a;
    }
    fs.writeFileSync(dumpPath, dump);

    const manifestPath = path.join(deepDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      parts: Array<{ file: string; bytes: number; sha256: string }>;
    };
    for (const part of manifest.parts) {
      if (part.file === "db.dump") {
        part.sha256 = crypto.createHash("sha256").update(dump).digest("hex");
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const target = nextVerifyTarget();
    const run = runVerify(target, {}, deepDest);
    const output = `${run.stdout}${run.stderr}`;
    expect(run.status).not.toBe(0);
    // 雜湊那道已被繞過，故必須是還原本身失敗
    expect(output).not.toMatch(/db-dump-hash-mismatch/);
    expect(output).toMatch(/stage=a summary=(pg-restore-failed|restored-database-unreachable)/);
    expect(databaseExists(target.db)).toBe(false);
  }, 600_000);

  // =========================================================================
  // T10R FW-2 走廊條款（可用性斷言與結論斷言分離）
  // =========================================================================

  it("T10R FW-2 走廊條款①: 抽不到樣本 → 與「抽樣通過」異結局且可辨識", () => {
    const target = nextVerifyTarget();
    const run = runVerify(target, { DATABASE_URL: sourceUrlWithSchema(T13_SCRATCH) });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    expect(output).toMatch(/stage=b summary=attachment-sample-unavailable/);
    // 與成功跑之形狀明確不同（不得只是「數字剛好是 0」）
    expect(output).not.toMatch(/result=pass/);
    expect(databaseExists(target.db)).toBe(false);
  }, 600_000);

  it("T10R FW-2 走廊條款②: 關聯查詢回零列 → 與「無孤兒」異結局且可辨識", () => {
    const target = nextVerifyTarget();
    const run = runVerify(target, {
      DATABASE_URL: sourceUrlWithSchema(T13_SCRATCH),
      RESTORE_ALLOW_INCOMPLETE_SAMPLE: "1",
    });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status).not.toBe(0);
    // 抽樣以明示承認之降級通過，於是走到 (c)——那裡零外鍵，必須自己拒絕
    expect(output).toMatch(/stage=c summary=relation-enumeration-empty/);
    expect(output).not.toMatch(/result=pass/);
    // 降級標記必然出現在該次紀錄上（產物自身可辨識）
    const last = readRecords().at(-1) as VerificationRecord;
    expect(last.evidence).toContain("sample-incomplete");
    expect(databaseExists(target.db)).toBe(false);
  }, 600_000);

  // =========================================================================
  // AC-24 — 驗證紀錄
  // =========================================================================

  describe("AC-24: 驗證紀錄", () => {
    it("(a) 失敗紀錄五欄 ＋ 非零結束碼", () => {
      const failures = readRecords().filter((r) => r.exitCode !== 0);
      expect(failures.length).toBeGreaterThan(0);
      for (const record of failures) {
        // 五欄逐項（AC-24(a) 逐字）：時間戳／備份識別／失敗階段／失敗摘要／非零結束碼
        expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(record.backupId).toMatch(/^(\d{8}T\d{6}Z|unknown)$/);
        expect(["guard", "a", "b", "c"]).toContain(record.stage);
        expect(record.summary).toMatch(/^[a-z0-9-]+$/);
        expect(record.exitCode).not.toBe(0);
        // 第六欄（證據等級）為 M-6+M-8 之降級標記，非 AC-24(a) 五欄之一
        expect(Object.keys(record).sort()).toEqual([
          "backupId",
          "evidence",
          "exitCode",
          "stage",
          "summary",
          "timestamp",
        ]);
      }
    });

    it("(b) 追加不覆蓋", () => {
      const before = readRecords();
      expect(before.length).toBeGreaterThan(1);
      const target = nextVerifyTarget();
      runVerify(target, { DATABASE_URL: sourceUrlWithSchema(T13_SCRATCH) });
      const after = readRecords();
      expect(after).toHaveLength(before.length + 1);
      // 既有各筆逐字不變（追加語意，非覆蓋）
      expect(after.slice(0, before.length)).toEqual(before);
    }, 600_000);

    it("(c) 成功亦留紀錄", () => {
      const success = readRecords().filter((r) => r.exitCode === 0);
      expect(success.length).toBeGreaterThan(0);
      const first = success[0] as VerificationRecord;
      expect(first.stage).toBe("none");
      expect(first.summary).toBe("all-three-confirmations-passed");
      expect(first.backupId).toBe(t13BackupId);
      expect(first.evidence).toBe("full");
    });

    it("(d) 紀錄經 AC-12 掃描器零命中", () => {
      const raw = fs.readFileSync(T13_LOG, "utf8");
      expect(raw.length).toBeGreaterThan(0);
      expect(scanText(raw)).toEqual([]);
      for (const absolute of [T13_ATT, T13_RPT, T13_DEST, T13_TMP]) {
        expect(raw).not.toContain(absolute);
        expect(raw).not.toContain(absolute.split(path.sep).join("/"));
      }
      expect(raw).not.toMatch(/postgres(ql)?:\/\//);
      expect(raw).not.toMatch(/att\/|rpt\//);
    });
  });

  // =========================================================================
  // 隔離目標之守門與零殘留
  // =========================================================================

  it("AC-23(a): 隔離還原目標用畢即刪（零殘留），且既存資料庫一律拒絕覆寫", () => {
    // 主跑建立的那個目標已被刪除
    expect(databaseExists(mainTarget.db)).toBe(false);

    // 目標已存在 → 拒跑（不可逆動作之前置：絕不覆寫既有資料庫）
    const container = discoverPgContainer();
    const user = new URL(DB_URL as string).username;
    const occupied = `${T13_TAG}_occupied`;
    execFileSync("docker", [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      user,
      "-d",
      "postgres",
      "-tAc",
      `CREATE DATABASE "${occupied}"`,
    ]);
    try {
      const run = runVerify(targetUrlFor(occupied));
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toMatch(/summary=restore-target-database-exists/);
      expect(databaseExists(occupied)).toBe(true); // 未被刪：本次沒有建立它
    } finally {
      execFileSync("docker", [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-tAc",
        `DROP DATABASE IF EXISTS "${occupied}"`,
      ]);
    }
  }, 600_000);

  it("M-6+M-8: 涵蓋無機械背書之備份 → 驗證紀錄帶 coverage-unverified，且不得以還原成功反推涵蓋完整", () => {
    // `BACKUP_ALLOW_EMPTY=1` 產出的備份，其涵蓋自檢**沒有可驗證之對象**（T12R SF-1）。
    // 本格證明該事實一路傳到驗證紀錄上——否則一份「沒驗過涵蓋」的備份還原成功後，
    // 紀錄看起來與一份「驗過都在」的完全一樣。
    const dest = path.join(T13_TMP, "allow-empty-dest");
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("bash", [BACKUP_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BACKUP_DEST_ROOT: dest,
        ATTACHMENT_STORAGE_ROOT: T13_ATT,
        REPORT_STORAGE_ROOT: T13_RPT,
        BACKUP_DATABASE_URL: sourceUrlWithSchema(T13_SCRATCH),
        BACKUP_ALLOW_EMPTY: "1",
      },
      encoding: "utf8",
      timeout: 240_000,
    });

    const target = nextVerifyTarget();
    const run = runVerify(
      target,
      {
        DATABASE_URL: sourceUrlWithSchema(T13_SCRATCH),
        RESTORE_ALLOW_INCOMPLETE_SAMPLE: "1",
      },
      dest
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/evidence=coverage-unverified/);
    const last = readRecords().at(-1) as VerificationRecord;
    expect(last.evidence.split(",").sort()).toEqual(["coverage-unverified", "sample-incomplete"]);
    expect(databaseExists(target.db)).toBe(false);
  }, 600_000);

  // =========================================================================
  // T13R 即審修法（SF-1／SF-2／AR-2）
  // =========================================================================

  it("T13R SF-1: schema 形狀不合 → 在 CREATE DATABASE **之前**即拒（不可逆動作先全驗後執行）", () => {
    // 即審實測之缺口：形狀檢查原本落在 `sql-*` 子命令，跑在建庫與整份 pg_restore
    // 之後——`Bad-Schema` 會讓腳本先建庫、先還原完，才以 EXIT 2 收場，且紀錄之
    // 階段歸屬失真（stage=guard summary=verification-interrupted）。
    for (const [label, overrides] of [
      ["RESTORE_VERIFY_SCHEMA 覆寫值", { RESTORE_VERIFY_SCHEMA: "Bad-Schema" }],
      ["來源 URL 之 schema 參數", { DATABASE_URL: sourceUrlWithSchema("Bad-Schema") }],
    ] as const) {
      const target = nextVerifyTarget();
      const before = readRecords().length;
      const run = runVerify(target, overrides);
      const output = `${run.stdout}${run.stderr}`;

      expect(run.status, label).not.toBe(0);
      // **關鍵鑑別**：`databaseExists === false` 單獨不足（用畢刪除後也是 false）。
      // 「建庫之前就拒」的物證是：連 `target=created` 這行都不曾印出。
      expect(output, label).not.toMatch(/target=created/);
      expect(output, label).not.toMatch(/\(a\) db-opened/);
      expect(output, label).toMatch(/stage=guard summary=restore-target-unusable/);
      expect(databaseExists(target.db), label).toBe(false);

      // 階段歸屬正確：不再是 verification-interrupted
      const record = readRecords().at(-1) as VerificationRecord;
      expect(readRecords()).toHaveLength(before + 1);
      expect(record.stage, label).toBe("guard");
      expect(record.summary, label).toBe("restore-target-unusable");
      expect(record.exitCode, label).not.toBe(0);
    }

    // 不誤傷：合法之明示 schema 覆寫（＝來源同一個）仍走完整流程並通過
    const okTarget = nextVerifyTarget();
    const ok = runVerify(okTarget, {
      RESTORE_VERIFY_SCHEMA: new URL(DB_URL as string).searchParams.get("schema") as string,
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/target=created/);
    expect(ok.stdout).toMatch(/result=pass/);
    expect(databaseExists(okTarget.db)).toBe(false);
  }, 600_000);

  it("T13R SF-2: 降級綠燈路徑之摘要必換碼（(b) 未執行時不得宣稱三項全過）", async () => {
    // fixture：暫時解開「修正版」關係 → 抽樣湊不出修正版副本，但 (a)(c) 完全正常。
    // 這是旗標之綠燈路徑，即審指出它原本 EXIT 0 ＋ summary=all-three-confirmations-passed。
    //
    // ⚠ **本格之後不得再插入任何正式面 DB 快照斷言**（T13R2 順手註記）：`supersedesId`
    // 之來回更新已擾動該列的 `updatedAt`，`toEqual` 整份快照的格子若排在本格之後會
    // 因這個副作用而紅。既有的快照比對（`AC-23(d)／B-19`）宣告在本格之前，不受影響。
    await t13Prisma.application.update({
      where: { id: t13RevisionAppId },
      data: { supersedesId: null },
    });
    try {
      const dest = path.join(T13_TMP, "degraded-pass-dest");
      fs.mkdirSync(dest, { recursive: true });
      execFileSync("bash", [BACKUP_SCRIPT], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BACKUP_DEST_ROOT: dest,
          ATTACHMENT_STORAGE_ROOT: T13_ATT,
          REPORT_STORAGE_ROOT: T13_RPT,
        },
        encoding: "utf8",
        timeout: 240_000,
      });

      const target = nextVerifyTarget();
      const run = runVerify(target, { RESTORE_ALLOW_INCOMPLETE_SAMPLE: "1" }, dest);

      expect(run.status).toBe(0); // (a)(c) 過、(b) 以明示承認放行
      expect(run.stdout).toMatch(/allow-incomplete=yes/);
      expect(run.stdout).toMatch(/\(c\) relations/); // (c) 確實跑過
      expect(run.stdout).toMatch(/summary=confirmations-passed-with-degraded-evidence/);
      expect(run.stdout).not.toMatch(/summary=all-three-confirmations-passed/);

      const record = readRecords().at(-1) as VerificationRecord;
      expect(record.exitCode).toBe(0);
      expect(record.stage).toBe("none");
      // **單看 summary 一欄**就知道這次不是完整的三項（不必倚賴第六欄）
      expect(record.summary).toBe("confirmations-passed-with-degraded-evidence");
      expect(record.evidence).toBe("sample-incomplete");
      expect(databaseExists(target.db)).toBe(false);
    } finally {
      await t13Prisma.application.update({
        where: { id: t13RevisionAppId },
        data: { supersedesId: t13SupersedesId },
      });
    }
  }, 600_000);

  it("T13R2 NF-2／AR-2: SIGTERM 中斷 → 階段歸屬正確、exitCode=143、目標零殘留，且**紀錄必有一筆**", async () => {
    // 末項（紀錄必有一筆）即 NF-1 之守門：補救分支的判準只該是「這次有沒有留下
    // 紀錄」，不該再被一個「跑完沒」的旗標關掉。
    for (const [label, marker, expected] of [
      ["(b) 階段", /\(a\) db-opened/, "b"],
      ["(c) 階段", /\(b\) parts-verified/, "c"],
    ] as const) {
      const target = nextVerifyTarget();
      const before = readRecords().length;
      const run = await runVerifyThenTerm(target, marker);

      expect(run.signalled, label).toBe(true); // 觸發點確實出現過（可用性斷言）
      expect(run.code, label).toBe(143); // trap 'exit 143' TERM 走完 EXIT trap
      expect(run.output, label).not.toMatch(/result=pass/);

      const records = readRecords();
      expect(records, label).toHaveLength(before + 1); // ← NF-1：零紀錄不可接受
      const record = records[records.length - 1] as VerificationRecord;
      expect(record.summary, label).toBe("verification-interrupted");
      expect(record.exitCode, label).toBe(143); // AR-2：實際結束碼，非硬編 1
      expect(record.stage, label).toBe(expected); // AR-2：實際階段，非硬編 guard
      // 中斷路徑亦零殘留（訊號轉 exit → EXIT trap → drop_target）
      expect(databaseExists(target.db), label).toBe(false);
    }

    // ── NF-1 之**行為**探針：把中斷打在「三項都跑完、最後一筆紀錄還沒寫成」的窗口 ──
    // `(c) relations` 這行印在舊碼的 `COMPLETED=1` 正前方，也就是舊碼把補救分支關掉的
    // 那個區間。舊碼在此中斷 ＝ 該次演練**零紀錄**；新碼無論訊號落在 `record` 之前或
    // 之後，都必然**恰好多一筆**（前者為中斷紀錄，後者為已寫成的成功紀錄）。
    const lateTarget = nextVerifyTarget();
    const lateBefore = readRecords().length;
    const late = await runVerifyThenTerm(lateTarget, /\(c\) relations/);
    expect(late.signalled).toBe(true);
    expect(late.code).toBe(143);
    const lateRecords = readRecords();
    expect(lateRecords).toHaveLength(lateBefore + 1); // ← NF-1 之判準：不得零紀錄
    const lateRecord = lateRecords[lateRecords.length - 1] as VerificationRecord;
    expect(lateRecord.stage).toBe("none");
    expect(databaseExists(lateTarget.db)).toBe(false);
  }, 600_000);

  it("T13R SF-2 反向 ＋ AR-2: 完整證據仍用原碼；中斷紀錄之結束碼與階段取實際值（結構）", () => {
    // 反向：主跑之 evidence=full，摘要仍為原碼（新碼不得把原碼吃掉）
    expect(mainRun.stdout).toMatch(/summary=all-three-confirmations-passed/);
    const full = readRecords().find((r) => r.exitCode === 0 && r.evidence === "full");
    expect(full?.summary).toBe("all-three-confirmations-passed");

    // 兩碼之耦合由判準端雙向釘死（腳本選錯碼會寫不出紀錄，不會靜默通過）
    const base = {
      timestamp: "2026-08-12T00:00:00Z",
      backupId: "20260812T000000Z",
      stage: "none",
      exitCode: 0,
    };
    expect(
      formatVerificationRecord({
        ...base,
        summary: "all-three-confirmations-passed",
        evidence: "sample-incomplete",
      }).ok
    ).toBe(false);
    expect(
      formatVerificationRecord({
        ...base,
        summary: "confirmations-passed-with-degraded-evidence",
        evidence: "full",
      }).ok
    ).toBe(false);
    expect(
      formatVerificationRecord({
        ...base,
        summary: "confirmations-passed-with-degraded-evidence",
        evidence: "coverage-unverified,sample-incomplete",
      }).ok
    ).toBe(true);

    // AR-2 **結構斷言（據實：非行為格）**——SIGINT 在 Windows dev 上無法穩定投遞給
    // bash 子行程，故此處以結構釘死「cleanup 一進來就取 $?、並把它傳給 write_record」，
    // 不宣稱已以實跑中斷證明。
    const code = fs
      .readFileSync(VERIFY_SCRIPT, "utf8")
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const cleanupBody = /cleanup\(\) \{[\s\S]*?\n\}/.exec(code);
    expect(cleanupBody).not.toBeNull();
    const body = (cleanupBody as RegExpExecArray)[0];
    expect(body).toMatch(/^\s*local rc=\$\?/m); // 第一件事就取，之後每個命令都會覆寫它
    expect(body).toMatch(/write_record "\$CURRENT_STAGE" "verification-interrupted" "\$rc"/);
    expect(body).not.toMatch(/verification-interrupted" 1/); // 硬編 1 不得再出現
    // 階段隨流程推進（中斷時之歸屬才不會全部落在 guard）
    for (const stage of ['CURRENT_STAGE="a"', 'CURRENT_STAGE="b"', 'CURRENT_STAGE="c"']) {
      expect(code).toContain(stage);
    }
  });

  // =========================================================================
  // 判準之鑑別力（mutant 自證；D13 之完整性守門與走廊條款皆非恆真）
  // =========================================================================

  describe("判準 mutant 自證", () => {
    /** 主跑實際列舉到的形狀之最小重建（15 條外鍵邊 ＋ 第⑤項）。 */
    const healthyRows = (): RelationRow[] => [
      ...FIXED_RELATION_CHECKS.filter((c) => c.fkBacked).flatMap((c) =>
        c.edges.map((edge) => ({
          kind: "fk",
          constraintName: `${edge.replace(".", "_")}_fkey`,
          id: edge,
          target: "X.id",
          orphans: 0,
        }))
      ),
      {
        kind: "fixed",
        constraintName: "weak-reference",
        id: NON_FK_CHECK_ID,
        target: "container",
        orphans: 0,
      },
    ];

    it("mutant①: 動態列舉少掉一條七項所宣告之邊 → relation-list-stale（固定清單過時即紅）", () => {
      expect(evaluateRelationalIntegrity(healthyRows()).ok).toBe(true);
      const stale = healthyRows().filter((r) => r.id !== "Session.userId");
      const verdict = evaluateRelationalIntegrity(stale);
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe("relation-list-stale");
      expect(verdict.satisfiedFixedItems).toBe(FIXED_RELATION_CHECKS.length - 1);
    });

    it("mutant②: 第⑤項被外鍵化 → 亦必紅（雙向釘死「唯一非恆真項」之地位）", () => {
      const rows = [
        ...healthyRows(),
        {
          kind: "fk",
          constraintName: "Attachment_refId_fkey",
          id: "Attachment.refId",
          target: "TripSegment.id",
          orphans: 0,
        },
      ];
      expect(evaluateRelationalIntegrity(rows).code).toBe("relation-list-stale");
    });

    it("mutant③: 孤兒 ≥1／零列／複合外鍵交叉積 → 三種各自可辨識之非通過結局", () => {
      const withOrphan = healthyRows();
      (withOrphan[0] as { orphans: number }).orphans = 1;
      expect(evaluateRelationalIntegrity(withOrphan).code).toBe("relation-orphans-found");

      expect(evaluateRelationalIntegrity([]).code).toBe("relation-enumeration-empty");
      // 只有第⑤項而零外鍵，仍是「沒有東西可驗」——不得與「無孤兒」同結局
      expect(
        evaluateRelationalIntegrity(healthyRows().filter((r) => r.kind === "fixed")).code
      ).toBe("relation-enumeration-empty");

      const duplicated = [...healthyRows(), healthyRows()[0] as RelationRow];
      expect(evaluateRelationalIntegrity(duplicated).code).toBe(
        "relation-unsupported-composite-fk"
      );
    });

    it("mutant④: 抽樣三條件（≥3／含 thumb／含修正版副本）各自缺一皆不得通過", () => {
      const obj = (key: string, kind: "original" | "thumb", revision: boolean) => ({
        key,
        kind,
        revision,
      });
      const full = [
        obj("att/a/original", "original", false),
        obj("att/a/thumb", "thumb", false),
        obj("att/b/original", "original", true),
      ];
      const ok = selectAttachmentSample(full);
      expect(ok.ok).toBe(true);
      expect(ok.sample).toHaveLength(3);
      // 決定性：同一輸入恆抽到同一組（D13(c) 之「隨機使失敗不可重現」不適用於本實作）
      expect(selectAttachmentSample([...full].reverse()).sample).toEqual(ok.sample);

      expect(selectAttachmentSample(full.slice(0, 2)).ok).toBe(false); // 不足 3
      expect(selectAttachmentSample(full.filter((o) => o.kind !== "thumb")).ok).toBe(false);
      expect(selectAttachmentSample(full.map((o) => obj(o.key, o.kind, false))).ok).toBe(false);
    });

    it("mutant⑤／B-19: 三元組全同必拒（port 不同亦拒——刻意較嚴）；只有 db 不同則放行", () => {
      const src = "postgresql://localhost:5432/app?schema=public";
      expect(evaluateRestoreTarget({ sourceUrl: src, targetUrl: src }).ok).toBe(false);
      // Spec §5 B-19 之三元組為 host＋db＋schema，**不含 port**：port 不同仍判為同一目標
      const otherPort = "postgresql://localhost:6543/app?schema=public";
      const rejected = evaluateRestoreTarget({ sourceUrl: src, targetUrl: otherPort });
      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false && rejected.code).toBe("restore-target-equals-source");
      // 另一個庫名 → 放行（本 Task 之主跑走的就是這條）
      expect(
        evaluateRestoreTarget({
          sourceUrl: src,
          targetUrl: "postgresql://localhost:5432/scratch",
        }).ok
      ).toBe(true);
      // 庫名非單純識別字 → 拒（本工具會把它嵌進 CREATE/DROP DATABASE）
      expect(
        evaluateRestoreTarget({ sourceUrl: src, targetUrl: 'postgresql://localhost:5432/a"b' }).ok
      ).toBe(false);
    });

    it("mutant⑥: 證據等級之單一判準（allowEmpty／腳本版號）＋ 紀錄摘要之封閉集合", () => {
      const good = { coverage: { allowEmpty: false }, tools: { script: "PHASE-011-T12/2" } };
      expect(assessCoverageEvidence(good)).toEqual([]);
      expect(assessCoverageEvidence({ ...good, coverage: { allowEmpty: true } })).toEqual([
        "coverage-unverified",
      ]);
      // 涵蓋自檢 fail-closed 之前的版本 → 無機械背書
      expect(assessCoverageEvidence({ ...good, tools: { script: "PHASE-011-T12" } })).toEqual([
        "coverage-unverified",
      ]);
      expect(assessCoverageEvidence({})).toEqual(["coverage-unverified"]);

      // AC-24(d) 之結構保證：摘要不是自由文字，寫不進去就洩不出去
      const base = {
        timestamp: "2026-08-12T00:00:00Z",
        backupId: "20260812T000000Z",
        stage: "b",
        exitCode: 1,
        evidence: "full",
      };
      expect(formatVerificationRecord({ ...base, summary: "attachment-object-missing" }).ok).toBe(
        true
      );
      expect(
        formatVerificationRecord({ ...base, summary: "failed reading C:/data/att/x/original" }).ok
      ).toBe(false);
      expect(
        formatVerificationRecord({ ...base, stage: "z", summary: "pg-restore-failed" }).ok
      ).toBe(false);
    });
  });

  // =========================================================================
  // 結構紀律（沿 T12 之三條硬規則）
  // =========================================================================

  it("結構: 判準委由 restore-check、憑證零命令列、外部命令失敗路徑零絕對路徑", () => {
    const script = fs.readFileSync(VERIFY_SCRIPT, "utf8");
    const code = script
      // 續行先接起來：零路徑紀律是**每個命令**一條，不是每個實體行一條——
      // `docker exec … psql \` 換行後才接 `2>/dev/null` 的寫法是合規的。
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    // 判準不在腳本內（T12 分工裁定之延續）
    expect(code).toContain("check-target");
    expect(code).toContain("check-relations");
    expect(code).toContain("check-sample");
    expect(code).toContain("record");
    // 腳本不自己比三元組、不自己判孤兒
    expect(code).not.toMatch(/information_schema/);

    // 憑證零命令列（AC-22(c) 同源紀律）
    expect(code).not.toMatch(/--password/);
    expect(code).not.toMatch(/PGPASSWORD=/);
    expect(code).not.toMatch(/-e\s+PGPASSWORD/);
    expect(code).not.toMatch(/postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/);
    expect(scanText(script)).toEqual([]);

    // 硬規則③：失敗路徑零路徑紀律一次涵蓋**所有**外部命令（含 rm／mkdir——
    // T12 三輪逐一補漏之教訓，這裡一次列全）
    for (const tool of ["pg_restore ", "psql ", "tar -", "mkdir ", "rm -", "mktemp"]) {
      const uses = code.split("\n").filter((line) => line.includes(tool));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line).toMatch(/2>\/dev\/null|2>&1|>\/dev\/null/);
      }
    }

    // AR-2 同型：INT／TERM 亦收斂到同一份 cleanup（半途中斷不得留下隔離資料庫）
    expect(code).toMatch(/trap cleanup EXIT/);
    expect(code).toMatch(/trap '[^']*' INT/);
    expect(code).toMatch(/trap '[^']*' TERM/);
  });
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** T13 段之正式面 DB 快照（與 T12 段之 `snapshotDb` 同形，但用本段自己的 client）。 */
async function snapshotT13Db() {
  const [attachments, reports, voided, applications, users, segments] = await Promise.all([
    t13Prisma.attachment.findMany({ orderBy: { id: "asc" } }),
    t13Prisma.report.findMany({ orderBy: { id: "asc" } }),
    t13Prisma.voidedReportFile.findMany({ orderBy: { id: "asc" } }),
    t13Prisma.application.findMany({ orderBy: { id: "asc" } }),
    t13Prisma.user.findMany({ orderBy: { id: "asc" } }),
    t13Prisma.tripSegment.findMany({ orderBy: { id: "asc" } }),
  ]);
  return JSON.parse(
    JSON.stringify({ attachments, reports, voided, applications, users, segments })
  );
}

/** 目的地根下之備份目錄名（依名稱排序，供「這一跑新增了誰」之差集比對）。 */
function listBackupDirs(): string[] {
  return fs
    .readdirSync(DEST_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** tar 內之條目（去掉 `./` 前綴與目錄項），即「storage key」之集合。 */
function tarEntries(tarPath: string): string[] {
  const listing = execFileSync("tar", ["-tf", "-"], {
    input: fs.readFileSync(tarPath),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter((line) => line !== "" && !line.endsWith("/"));
}

interface Manifest {
  readonly backupId: string;
  readonly createdAt: string;
  readonly scope: readonly string[];
  readonly parts: ReadonlyArray<{
    readonly name: string;
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly tools: Readonly<Record<string, string>>;
  readonly coverage: {
    readonly keys: number;
    readonly present: number;
    readonly missing: number;
    /** T12R SF-1：`true` ＝涵蓋自檢無可驗證之對象，由維運人員明示承認而放行。 */
    readonly allowEmpty: boolean;
  };
  readonly retentionDays: number;
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as Manifest;
}
