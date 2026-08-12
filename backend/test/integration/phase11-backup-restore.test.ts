/**
 * Integration test: PHASE-011 備份（T12）— `scripts/backup.sh` 之實跑驗證
 * （`docs/specs/PHASE-011.md` **AC-19**／**AC-22**；§16 **D11-1**=(a)
 * `docker exec` ＋ `pg_dump -Fc`、**D11-2**=(a) 不加密、**D12**=(a) 路徑樹守門）
 *
 * 本檔由 T12 建立，**T13 就地擴充**還原驗證（AC-23／AC-24）——故檔名為
 * `backup-restore` 而非 `backup`。今日本檔零還原斷言，那是 T13 的射程。
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

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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
  readonly coverage: { readonly keys: number; readonly present: number; readonly missing: number };
  readonly retentionDays: number;
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as Manifest;
}
