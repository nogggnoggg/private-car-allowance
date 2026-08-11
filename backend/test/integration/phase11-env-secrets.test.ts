/**
 * PHASE-011-T8 — env／secrets 硬化與三具機械守門
 *
 * 涵蓋（`docs/specs/PHASE-011.md` §2 D 段逐字）：
 *   · AC-11(c) production fail-fast 清單完整性 — 以機械斷言列出「production 下
 *     缺少即拒絕啟動」之變數集合，並與一份常數清單 `toEqual`。〔核銷
 *     `KNOWN_ISSUES.md` :41 O-3〕
 *   · AC-11(d) 搬遷不改業務邏輯之結構性證據 — 全 `backend/src` 之 `process.env`
 *     直接取值站點之封閉性；其餘模組一律經 `AppConfig`。
 *   · AC-11(e) `docker-compose.yml` 之 `environment:` 鍵集合 ⊇ production 必要清單。
 *   · AC-12(a)~(d) 零寫死正式敏感資訊（掃描 ＋ 逐筆理由白名單 ＋ 合成陽性自證
 *     ＋ `.gitignore` 涵蓋 `.env`）。
 *   · AC-16(c) DB 服務可替換之結構性證據（記載型 `it`，不實跑外部服務）。
 *
 * 另承載三項上游移交之機械核銷（Task Packet 之「機械連動預授權」）：
 *   · T7 FW-1 — `auth/middleware.ts` :51 直讀 `process.env.SESSION_COOKIE_NAME`
 *     之例外白名單化（大總管預裁處置 (i)）；見 `PROCESS_ENV_DIRECT_READS`。
 *   · T7 FW-2 — env schema **零** `forceSecureCookies`／`trustProxy` 綁定之負向斷言。
 *   · T7 FW-3 — 全 `backend/src` 之 `setCookie`／`clearCookie` 呼叫點白名單。
 *   · T4R — `invalidNumericEnvKeys`（cleanup-cli）與 env schema `int > 0` 規則之
 *     逐值一致性格（含一項刻意例外）。
 *
 * ---------------------------------------------------------------------------
 * 零 DB 依賴、零磁碟寫入
 * ---------------------------------------------------------------------------
 * 本檔不建立 Fastify 實例、不連 DB（沿 `phase10-error-handler-leak.test.ts` 之
 * 純結構掃描形狀）。所有突變自證都在**記憶體字串**上施行，並以「磁碟原檔位元
 * 組全等」之 it 收尾——刻意不寫回磁碟，以免平行測試或中途失敗把被改壞的原始碼
 * 留在工作樹裡。
 *
 * ---------------------------------------------------------------------------
 * 掃描器之涵蓋面 — 據實敘述，不過度宣稱（T5 FW-1 紀律）
 * ---------------------------------------------------------------------------
 * 本檔的 source-regex 掃描（`process.env` 站點、fail-fast 區塊、cookie 呼叫點、
 * secrets 樣式）**擋得住的是今日倉庫裡的慣用寫法**，不是「任何可能的寫法」。
 * 具體地說，下列繞法本掃描**看不到**，此處逐項列出而非含糊帶過：
 *   ① 以字串組合取用（`process["e"+"nv"]`、`Reflect.get(process, "env")`）；
 *   ② 把 `process.env` 先賦值給別名再取屬性（`const e = process.env; e.FOO`）
 *      ——別名之屬性取值不含 `process.env` 字面；但**賦值那一行**會被
 *      「整個物件流出」那一組抓到並落在白名單外，故此型仍有一半可見；
 *   ③ 由第三方套件於執行期自行讀取 env（如 `dotenv`、Prisma 自身的
 *      `DATABASE_URL` 解析）——那不是 `backend/src` 的取值站點；
 *   ④ secrets 以非字面形式出現（base64 再編碼、拆成多段字串相接）。
 * 承重的是「封閉集合 ＋ 突變自證」：每一組掃描都配一條突變格，證明它對**慣用
 * 寫法之新增**確實會翻紅；繞法之防護則靠 code review 與 §17 移交，不由本檔宣稱。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA_KEYS, PRODUCTION_REQUIRED_ENV_KEYS, parseEnv } from "../../src/config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, "../../src");
/** 倉庫根（`backend/test/integration` → 上溯三層）。 */
const REPO_ROOT = path.resolve(__dirname, "../../..");

const SERVER_TS = path.join(SRC_ROOT, "server.ts");
const CLEANUP_CLI_TS = path.join(SRC_ROOT, "attachment/cleanup-cli.ts");
const COMPOSE_PATH = path.join(REPO_ROOT, "docker-compose.yml");
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

// ---------------------------------------------------------------------------
// 檔案走訪
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "test-results",
  "playwright-report",
]);

/** 二進位副檔名（今日掃描射程內為零，留作防禦——多一個圖檔不該讓掃描器噴亂碼）。 */
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".woff", ".woff2"]);

function listFilesRecursive(dir: string, filter?: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listFilesRecursive(path.join(dir, entry.name), filter));
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      if (filter && !filter(full)) continue;
      out.push(full);
    }
  }
  return out;
}

/** 倉庫根相對路徑，一律以 `/` 分隔（Windows／POSIX 之比對結果須一致）。 */
function repoRel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** `backend/src` 相對路徑（沿 `phase10-error-handler-leak.test.ts` 之白名單口徑）。 */
function srcRel(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

const SRC_TS_FILES = listFilesRecursive(SRC_ROOT, (f) => f.endsWith(".ts"));

// ===========================================================================
// AC-11(c) — production fail-fast 清單完整性
// ===========================================================================

/**
 * 一份「production 形狀完整」的 env：17 個 schema 鍵全給合法值。探針的作法是
 * 從這份完整 env **逐一拿掉一個鍵**再丟給 `parseEnv`，看它會不會拒絕——拒絕者
 * 即「schema 層必填」。
 *
 * 注意：`NODE_ENV: "production"` 只是這個**純物件**裡的一個欄位，不是
 * `process.env.NODE_ENV`。Spec §11.0 #5 逐字禁止的是「設定 `NODE_ENV=production`」
 * （會撞 `global-setup.ts` :304 護欄）；此處全程參數注入，行程環境零變動。
 */
const COMPLETE_PRODUCTION_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgresql://u:p@db:5432/appdb",
  NODE_ENV: "production",
  PORT: "3000",
  LOG_LEVEL: "info",
  STORAGE_PATH: "/data/storage",
  SESSION_ABSOLUTE_TTL_HOURS: "8",
  SESSION_COOKIE_NAME: "sid",
  LOGIN_MAX_FAILURES: "5",
  LOGIN_LOCK_MINUTES: "15",
  ATTACHMENT_STORAGE_ROOT: "/data/storage/attachments",
  ATTACHMENT_MAX_BYTES: "10485760",
  ATTACHMENT_TEMP_TTL_HOURS: "24",
  ATTACHMENT_THUMBNAIL_MAX_PX: "512",
  ATTACHMENT_CLEANUP_BATCH_LIMIT: "500",
  REPORT_STORAGE_ROOT: "/data/storage/pdf",
  REPORT_PDF_TIMEOUT_MS: "30000",
  REPORT_IMAGE_MAX_PX: "1600",
};

/** 完整 env **去掉指定鍵**之副本（刻意建新物件，不改動 COMPLETE_PRODUCTION_ENV）。 */
function envWithout(key: string): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(COMPLETE_PRODUCTION_ENV).filter(([k]) => k !== key));
}

/**
 * 來源 A（**行為導出**）：schema 層必填鍵 = 「從完整 env 拿掉它就 `parseEnv`
 * 拋出」的鍵。真的呼叫 `parseEnv`，不是讀原始碼。
 */
function deriveSchemaRequiredKeys(): string[] {
  const required: string[] = [];
  for (const key of ENV_SCHEMA_KEYS) {
    try {
      parseEnv(envWithout(key));
    } catch {
      required.push(key);
    }
  }
  return required.sort();
}

/**
 * 來源 B（**結構導出**，對 `server.ts` 原始碼）：production 專屬 fail-fast 之
 * 變數名。`server.ts` 的兩個 fail-fast 分支不經 zod（那兩個變數在 schema 裡是
 * `.optional()`，缺了 `parseEnv` 不會拋），而是在解析完 storage root 之後才
 * 判斷 `appEnv.NODE_ENV === "production"` 才拒絕啟動——**行為導出抓不到它們**，
 * 故必須有這一路。
 *
 * 承重方式（誠實界定）：這是 source-regex，它擋住的是**今日這個慣用寫法**
 * （`appEnv.NODE_ENV === "production"` 之分支 ＋ `Server startup failed — X is
 * not set.` 之訊息）。以另一種寫法新增的 fail-fast 它看不到。它不是「不可漏
 * 報」的證明；它的價值在於：既有兩處被刪、被改名或被加第三處時，下方的
 * `toEqual` 會立刻翻紅（突變格已實證）。且兩個計數（分支數 vs 訊息數）互為
 * 對照，其中一半被改動也會被抓到。
 */
const PRODUCTION_BRANCH_MARKER = 'appEnv.NODE_ENV === "production"';
const FAIL_FAST_MESSAGE_RE = /Server startup failed — ([A-Z][A-Z0-9_]*) is not set/g;

function deriveServerFailFastKeys(serverSource: string): string[] {
  const keys = new Set<string>();
  for (const match of serverSource.matchAll(FAIL_FAST_MESSAGE_RE)) {
    keys.add(match[1] as string);
  }
  return [...keys].sort();
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SERVER_SOURCE = fs.readFileSync(SERVER_TS, "utf8");

describe("PHASE-011-T8 — AC-11(c): production 必要 env 清單完整性（核銷 O-3）", () => {
  it("行為導出（parseEnv 探針）之 schema 層必填鍵恰為 DATABASE_URL", () => {
    expect(deriveSchemaRequiredKeys()).toEqual(["DATABASE_URL"]);
  });

  it("結構導出（server.ts）之 production fail-fast 鍵恰為兩個 storage root", () => {
    expect(deriveServerFailFastKeys(SERVER_SOURCE)).toEqual([
      "ATTACHMENT_STORAGE_ROOT",
      "REPORT_STORAGE_ROOT",
    ]);
  });

  it("fail-fast 之『production 分支數』與『具名訊息數』相等（兩路互為對照）", () => {
    const branches = countOccurrences(SERVER_SOURCE, PRODUCTION_BRANCH_MARKER);
    const messages = [...SERVER_SOURCE.matchAll(FAIL_FAST_MESSAGE_RE)].length;
    expect(branches).toBe(2);
    expect(messages).toBe(branches);
  });

  it("兩路聯集 toEqual PRODUCTION_REQUIRED_ENV_KEYS（AC-11(c) 之常數比對）", () => {
    const derived = [
      ...new Set([...deriveSchemaRequiredKeys(), ...deriveServerFailFastKeys(SERVER_SOURCE)]),
    ].sort();
    expect(derived).toEqual([...PRODUCTION_REQUIRED_ENV_KEYS].sort());
  });

  describe("鑑別力自證（記憶體突變，零磁碟寫入）", () => {
    it("mutant：server.ts 少一個 fail-fast → 聯集少一鍵 → 比對必紅", () => {
      const mutated = SERVER_SOURCE.replace(
        "Server startup failed — REPORT_STORAGE_ROOT is not set.",
        "Report storage root missing."
      );
      expect(mutated).not.toBe(SERVER_SOURCE);
      const derived = [
        ...new Set([...deriveSchemaRequiredKeys(), ...deriveServerFailFastKeys(mutated)]),
      ].sort();
      expect(derived).not.toEqual([...PRODUCTION_REQUIRED_ENV_KEYS].sort());
      expect(derived).toEqual(["ATTACHMENT_STORAGE_ROOT", "DATABASE_URL"]);
    });

    it("mutant：server.ts 多一個 fail-fast → 聯集多一鍵 → 比對必紅", () => {
      const mutated = `${SERVER_SOURCE}\n// "Server startup failed — BACKUP_DEST_ROOT is not set."\n`;
      const derived = [
        ...new Set([...deriveSchemaRequiredKeys(), ...deriveServerFailFastKeys(mutated)]),
      ].sort();
      expect(derived).not.toEqual([...PRODUCTION_REQUIRED_ENV_KEYS].sort());
      expect(derived).toContain("BACKUP_DEST_ROOT");
    });

    it("鑑別力：拿掉非必要鍵（PORT）不會被判為必填（防『全部都必填』之假綠）", () => {
      expect(() => parseEnv(envWithout("PORT"))).not.toThrow();
    });

    it("還原自證：server.ts 磁碟位元組全等（零污染工作樹）", () => {
      expect(fs.readFileSync(SERVER_TS, "utf8")).toBe(SERVER_SOURCE);
    });
  });
});

// ===========================================================================
// AC-11(d) ＋ T7 FW-1 — `process.env` 站點之封閉性
// ===========================================================================

/**
 * **AC-11(d) 之兩個判別面**（Spec 原文：「全 `backend/src` 之 `process.env`
 * 直接取值恰限於 `config/env.ts`（＋ `index.ts` 啟動期）——其餘模組一律經
 * `AppConfig`」）：
 *
 *   面一「**直接取值**」= `process.env.<KEY>` 之屬性取值。這是 AC 真正要禁的
 *        事——模組自己去認一個 env 鍵名，搬遷時就得改程式。
 *   面二「整個物件流出」= 把 `process.env` **整包**交給設定層
 *        （`parseEnv(process.env)`／`getEnvOrTestDefaults(process.env)`／函式
 *        預設參數）。這**正是** AC 要的「經 `AppConfig`」，不是違規。
 *
 * **實查結果與 Packet 轉述之差異（據實登記，Handoff 已逐項回報）**：Packet 依
 * Spec §15 T8 轉述之預期為「站點恰二 ＝ `config/env.ts` ＋ `index.ts`」。實查
 * 後兩者**皆不在面一**——`config/env.ts` 與 `index.ts` 都只把整包 `process.env`
 * 往下傳，一次屬性取值都沒有。面一今日恰有**兩處**，但是另外兩處（見下方常數）。
 * 「恰二」這個數字成立，內容不同。
 */
const PROCESS_ENV_DIRECT_READS: ReadonlyArray<{
  readonly file: string;
  readonly key: string;
  readonly reason: string;
}> = [
  {
    file: "auth/middleware.ts",
    key: "SESSION_COOKIE_NAME",
    reason:
      '【T7 FW-1 移交，大總管預裁處置 (i) 例外白名單】:51 `process.env.SESSION_COOKIE_NAME ?? "sid"`。' +
      "本檔屬 auth High 域，不在 T8 檔案欄，故本輪以白名單記錄而非改碼。" +
      "隱患本體：同一個 cookie 名有**兩條**取得路徑——寫入面（auth/routes.ts）走 " +
      "`AppConfig`，讀取面（本處）走 `process.env`；兩路的 fallback 又各自硬編 " +
      '"sid"（env.ts :99 之 catch 分支、本行之 ?? 右側）。分歧只在 `parseEnv` ' +
      "失敗時才會顯現，而 production 走 `parseEnv` fail-fast 不可達（缺 " +
      "DATABASE_URL 即 exit 1），故今日僅測試環境之 fallback 路徑可達、無 " +
      "production 影響。收斂（改為經 AppConfig 取得、消滅雙份 fallback）歸後續 " +
      "auth 域工作項，**待登記** PHASE-011 §17.2——T8 之 Spec Change Permission " +
      "僅及於 §12 回填，故該登記由大總管於結案時寫入（T8 Handoff 已列為移交項）。",
  },
  {
    file: "server.ts",
    key: "LOG_LEVEL",
    reason:
      "【T8 實查新發現，非 Packet 預期；同以處置 (i) 例外白名單記錄】:63 " +
      '`options.logLevel ?? process.env.LOG_LEVEL ?? "info"`。此行早於 ' +
      ":134 之 `getEnvOrTestDefaults(process.env)`——logger 必須在 Fastify 實例" +
      "建立時就位，而設定層的解析結果在該時點尚未取得，故形成一個先於 " +
      "`AppConfig` 的取值點。`server.ts` 不在 T8 檔案欄（Files Forbidden），" +
      '本輪零觸碰。影響面：`LOG_LEVEL` 有 schema 預設（"info"）且非 production ' +
      "必要鍵，錯值不會使啟動失敗，只會讓日誌等級退回 pino 預設——非安全面。" +
      "收斂歸後續工作項，**待登記** PHASE-011 §17.2（同上，登記權限不在 T8）。",
  },
];

/**
 * 面二之允許集合：檔案內出現 `process.env` 字面**但不是屬性取值**者——把整包
 * `process.env` 交給設定層（`parseEnv(process.env)`／`getEnvOrTestDefaults(
 * process.env)`）、作為函式預設參數，或**僅在註解裡提到這個名字**。
 *
 * 註解刻意**不剝除**（沿 `phase10-error-handler-leak.test.ts` 之「誤報方向為
 * 多抓，由維護者具名加入白名單即可；漏報才是不可接受的方向」紀律）：多寫一個
 * 註解剝除器就多一段自己會有 bug 的解析邏輯，而它出錯的方向是**漏報**。代價是
 * 名單裡會有純註解命中，逐筆標注如下：
 *
 *   · `reports/pdf-renderer.ts` — **註解字面，非取值站點**。:40 的檔頭寫的正是
 *     「本檔零 `process.env` 讀取，維持純粹、易於零 env 注入測試」——一句宣告
 *     自己不讀 env 的話，被掃描器抓進「提到 process.env 的檔案」清單裡。留著
 *     它比為它寫一個註解剝除器安全。
 *
 * 其餘七檔皆為真實的整包交付站點。
 */
const PROCESS_ENV_OBJECT_HANDOFF_FILES = [
  "attachment/cleanup-cli.ts",
  "attachment/routes.ts",
  "auth/routes.ts",
  "config/env.ts",
  "index.ts",
  "reports/pdf-renderer.ts",
  "seed/seed-admin.ts",
  "server.ts",
];

/** `process.env.<IDENT>` 與 `process.env["IDENT"]` 兩式。 */
const DIRECT_READ_RE =
  /process\.env\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*["']([^"']+)["']\s*\])/g;
/** 任何 `process.env` 字面（含註解——刻意不剝除，見檔頭涵蓋面說明）。 */
const ANY_PROCESS_ENV_RE = /process\.env/g;

function scanDirectReads(source: string): string[] {
  return [...source.matchAll(DIRECT_READ_RE)].map((m) => (m[1] ?? m[2]) as string);
}

describe("PHASE-011-T8 — AC-11(d)／T7 FW-1: process.env 站點之封閉性", () => {
  it("面一：`process.env.<KEY>` 直接取值之（檔案, 鍵）集合恰等於白名單", () => {
    const found: Array<{ file: string; key: string }> = [];
    for (const file of SRC_TS_FILES) {
      for (const key of scanDirectReads(fs.readFileSync(file, "utf8"))) {
        found.push({ file: srcRel(file), key });
      }
    }
    const actual = found.map((f) => `${f.file}::${f.key}`).sort();
    const expected = PROCESS_ENV_DIRECT_READS.map((w) => `${w.file}::${w.key}`).sort();
    expect(actual).toEqual(expected);
  });

  it("面一之站點數恰二（Spec §15 T8 Done When 之『恰二』；內容見白名單理由）", () => {
    expect(PROCESS_ENV_DIRECT_READS).toHaveLength(2);
  });

  it("白名單每一筆都有非空理由，且理由指名其檔案（AC-12(b) 同型之逐筆理由紀律）", () => {
    for (const entry of PROCESS_ENV_DIRECT_READS) {
      expect(entry.reason.length, `${entry.file}::${entry.key} 之理由`).toBeGreaterThan(80);
      expect(entry.reason).toContain("§17.2");
    }
  });

  it("面二：出現 process.env 字面但非屬性取值之檔案集合恰等於允許集合", () => {
    const files: string[] = [];
    for (const file of SRC_TS_FILES) {
      const source = fs.readFileSync(file, "utf8");
      const total = [...source.matchAll(ANY_PROCESS_ENV_RE)].length;
      const direct = scanDirectReads(source).length;
      if (total - direct > 0) files.push(srcRel(file));
    }
    expect(files.sort()).toEqual([...PROCESS_ENV_OBJECT_HANDOFF_FILES].sort());
  });

  it("`parseEnv` 之消費端恰二（index.ts 啟動期 ＋ cleanup-cli.ts；T4R 關閉確認）", () => {
    // 「`process.env` 站點」與「`parseEnv` 消費端」是**兩個不同的斷言面**：
    // 前者問「誰自己去讀環境」，後者問「誰做嚴格驗證」。`getEnvOrTestDefaults`
    // 的消費端另有三處（server.ts／auth/routes.ts／attachment/routes.ts），
    // 那三處走的是「驗證失敗即回退預設」的寬鬆路徑——刻意不併入本格計數，
    // 否則「嚴格驗證恰二處」這件事會被稀釋掉。
    const files: string[] = [];
    for (const file of SRC_TS_FILES) {
      if (/\bparseEnv\s*\(/.test(fs.readFileSync(file, "utf8"))) files.push(srcRel(file));
    }
    expect(files.sort()).toEqual(["attachment/cleanup-cli.ts", "config/env.ts", "index.ts"]);
  });

  it("mutant：他檔新增一處 `process.env.FOO` → 面一必紅", () => {
    const mutated = 'const foo = process.env.FOO ?? "bar";';
    expect(scanDirectReads(mutated)).toEqual(["FOO"]);
    const expected = PROCESS_ENV_DIRECT_READS.map((w) => `${w.file}::${w.key}`).sort();
    expect(["applications/routes.ts::FOO", ...expected].sort()).not.toEqual(expected);
  });

  it('mutant：bracket 式 `process.env["FOO"]` 亦被面一偵測（防以另一語法繞過）', () => {
    expect(scanDirectReads('const foo = process.env["FOO"];')).toEqual(["FOO"]);
  });
});

// ===========================================================================
// AC-11(e) ＋ 三向一致性 — docker-compose.yml
// ===========================================================================

const COMPOSE_SOURCE = fs.readFileSync(COMPOSE_PATH, "utf8");

/**
 * 取出 `docker-compose.yml` 之 `backend` 服務底下 `environment:` 區塊的鍵名。
 *
 * 以縮排逐行解析而非引入 YAML 套件：本檔只需要「一個已知服務的一個已知區塊之
 * 鍵名」，多引一個相依只為讀七行縮排並不划算；且解析失敗的方向是**讀到空集**，
 * 而空集會讓下方 ⊇ 斷言立刻翻紅（不會靜默放行）。
 */
function composeBackendEnvKeys(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const keys: string[] = [];
  let inBackend = false;
  let inEnvironment = false;
  for (const line of lines) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      inBackend = line.trim() === "backend:";
      inEnvironment = false;
      continue;
    }
    if (!inBackend) continue;
    if (/^ {4}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      inEnvironment = line.trim() === "environment:";
      continue;
    }
    if (!inEnvironment) continue;
    const match = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match) keys.push(match[1] as string);
  }
  return keys;
}

function envExampleKeys(): string[] {
  const keys: string[] = [];
  for (const rawLine of fs.readFileSync(ENV_EXAMPLE_PATH, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) keys.push(match[1] as string);
  }
  return keys;
}

/**
 * **轉發例外**（T8R 即審 SF-1）：`.env.example` 列了、屬於 env schema、但**刻意
 * 不由 compose 轉發**的鍵。每一筆都必須說明「為什麼部署者在 `.env` 設它是合理
 * 地無效的」。
 *
 * **今日為空集**，而且空集才是正確的狀態：範本裡的每一個 schema 鍵，compose
 * 都真的把它交進容器。若日後有人以「這個鍵只在本機開發用」為由不轉發，他必須
 * 在這裡具名並寫下理由——而不是讓範本繼續做出 compose 不兌現的承諾。
 */
const COMPOSE_FORWARDING_EXCEPTIONS: ReadonlyArray<{
  readonly key: string;
  readonly reason: string;
}> = [];

describe("PHASE-011-T8 — AC-11(e): docker-compose 與 env 之三向一致性", () => {
  it("compose backend 之 environment 鍵集非空（解析器自身之活性檢查）", () => {
    expect(composeBackendEnvKeys(COMPOSE_SOURCE).length).toBeGreaterThan(5);
  });

  it("compose backend 之 environment 鍵集 ⊇ production 必要清單", () => {
    const composeKeys = new Set(composeBackendEnvKeys(COMPOSE_SOURCE));
    const missing = PRODUCTION_REQUIRED_ENV_KEYS.filter((key) => !composeKeys.has(key));
    expect(missing).toEqual([]);
  });

  it("compose backend 之 environment 鍵集 ⊆ envSchema（零 schema 未知之鍵）", () => {
    const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
    const unknown = composeBackendEnvKeys(COMPOSE_SOURCE).filter((key) => !schemaKeys.has(key));
    expect(unknown).toEqual([]);
  });

  it("三向：compose 之每個鍵都在 `.env.example` 有對應列（部署者查得到）", () => {
    const templateKeys = new Set(envExampleKeys());
    const missing = composeBackendEnvKeys(COMPOSE_SOURCE).filter((key) => !templateKeys.has(key));
    expect(missing).toEqual([]);
  });

  // ── T8R 即審 SF-1：消滅「假可調性」 ────────────────────────────────────
  //
  // T8 首版把四個 session／lockout 鍵補進 `.env.example` 卻沒補進 compose，
  // 造成一個比「範本沒寫」更糟的狀態：範本**明示**它可調，但 compose 不轉發
  // ——沒有 `env_file`、Dockerfile 無 `ENV`、entrypoint 不 source `.env`、
  // `.dockerignore` 排除 `.env`——部署者照著範本設 `LOGIN_MAX_FAILURES=3` 再
  // `docker compose up`，容器裡**看不到這個變數**，鎖定門檻仍是 5，且**零錯誤
  // 訊息**。範本沒寫至少會讓人去查原始碼；範本寫了而不生效只會讓人相信自己
  // 調過了。本格把「範本承諾」與「compose 兌現」釘成同一件事。
  it("SF-1：範本中屬 schema 之鍵，皆由 compose backend 轉發（例外須具名附理由）", () => {
    const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
    const composeKeys = new Set(composeBackendEnvKeys(COMPOSE_SOURCE));
    const notForwarded = envExampleKeys()
      .filter((key) => schemaKeys.has(key) && !composeKeys.has(key))
      .sort();
    const excepted = COMPOSE_FORWARDING_EXCEPTIONS.map((e) => e.key).sort();
    expect(notForwarded).toEqual(excepted);
  });

  it("SF-1：轉發例外清單逐筆有理由（今日為空集——空集本身即最強的狀態）", () => {
    for (const entry of COMPOSE_FORWARDING_EXCEPTIONS) {
      expect(entry.reason.length, entry.key).toBeGreaterThan(40);
      expect(ENV_SCHEMA_KEYS, entry.key).toContain(entry.key);
    }
  });

  it("mutant：compose 少一個必要鍵 → ⊇ 斷言必紅", () => {
    const mutated = COMPOSE_SOURCE.split(/\r?\n/)
      .filter((line) => !/^ {6}REPORT_STORAGE_ROOT:/.test(line))
      .join("\n");
    expect(mutated).not.toBe(COMPOSE_SOURCE);
    const composeKeys = new Set(composeBackendEnvKeys(mutated));
    const missing = PRODUCTION_REQUIRED_ENV_KEYS.filter((key) => !composeKeys.has(key));
    expect(missing).toEqual(["REPORT_STORAGE_ROOT"]);
  });

  it("mutant：compose 刪掉一個**非必要**新鍵（LOGIN_MAX_FAILURES）→ SF-1 格必紅", () => {
    // 這一格證明 SF-1 的守門面**大於**「production 必要清單」那一格：
    // `LOGIN_MAX_FAILURES` 有 schema 預設、不在必要清單內，上面的 ⊇ 斷言對它
    // 完全無感——它正是 T8 首版漏掉四個鍵而全綠的原因。
    const mutated = COMPOSE_SOURCE.split(/\r?\n/)
      .filter((line) => !/^ {6}LOGIN_MAX_FAILURES:/.test(line))
      .join("\n");
    expect(mutated).not.toBe(COMPOSE_SOURCE);

    const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
    const composeKeys = new Set(composeBackendEnvKeys(mutated));
    const notForwarded = envExampleKeys()
      .filter((key) => schemaKeys.has(key) && !composeKeys.has(key))
      .sort();
    expect(notForwarded).toEqual(["LOGIN_MAX_FAILURES"]);

    // 對照：必要清單那一格在同一個突變下仍是綠的（故非重複斷言）。
    expect(PRODUCTION_REQUIRED_ENV_KEYS.filter((key) => !composeKeys.has(key))).toEqual([]);
  });

  it("還原自證：docker-compose.yml 磁碟位元組全等", () => {
    expect(fs.readFileSync(COMPOSE_PATH, "utf8")).toBe(COMPOSE_SOURCE);
  });
});

// ===========================================================================
// AC-12 — 零寫死正式敏感資訊
// ===========================================================================

/**
 * AC-12(a) 之四類樣式，逐條對應 Spec 原文：
 *
 *   `conn-string`  ← 「`postgres(ql)?://<user>:<非空密碼>@`」
 *   `private-key`  ← 「`-----BEGIN * PRIVATE KEY-----`」
 *   `argon2-hash`  ← 「`$argon2` 雜湊字面」
 *   `long-secret`  ← 「長度 ≥32 之 base64／hex 且鍵名含 `secret|token|key|password`」
 *
 * `argon2-hash` 刻意要求**完整自描述字面**（六段 ＋ salt ≥16 ＋ hash ≥22 之
 * base64 字元），而不是只認 `$argon2` 前綴。理由：本倉庫的文件裡有大量「以
 * `$argon2` 前綴為掃描對象」的**敘述**（`DATA_FLOW.md`、`PHASE-002/010.md`），
 * 只認前綴會讓白名單膨脹成「把四個 docs 檔整個放行」，那反而讓真正貼進這些檔
 * 案的雜湊被放過。認完整形狀則只有真正的雜湊字面會命中。
 */
type SecretPattern = { readonly id: string; readonly regex: RegExp };

const SECRET_PATTERNS: readonly SecretPattern[] = [
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

/** AC-12(a) 逐字之受控範圍（目錄面）。 */
const SCAN_DIRS = ["backend/src", "frontend/src", "e2e", ".github/workflows", "docs"];

/**
 * AC-12(a) 之**glob 型**射程逐字為 `docker-compose*.yml` 與 `*\/Dockerfile`。
 *
 * **T8R 即審 SF-2 之修法**：T8 首版把它們寫死成三個檔名。那是**漏報方向**的
 * 缺陷，且恰好破了本檔自陳的紀律（「漏報才是不可接受的方向」）——新增一個
 * `docker-compose.override.yml`（compose 的標準覆寫檔，正是放環境專屬設定與
 * 憑證的地方）或一個新服務的 `*\/Dockerfile`，會**靜默**落在射程外，掃描照樣
 * 全綠。改為**實查 glob** 之後，新增同型檔會立刻進入掃描（而非等人記得補），
 * 同時下方 `射程完整性` 一格會紅，逼維護者確認它是該納入還是該具名豁免。
 */
function discoverGlobScanFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /^docker-compose.*\.ya?ml$/.test(entry.name)) {
      found.push(entry.name);
      continue;
    }
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      // `*/Dockerfile` 為**一層**子目錄（AC-12(a) 逐字之 glob 深度），不遞迴。
      if (fs.existsSync(path.join(root, entry.name, "Dockerfile"))) {
        found.push(`${entry.name}/Dockerfile`);
      }
    }
  }
  return found.sort();
}

/**
 * 今日 glob 實查應得之集合。這份常數**不參與掃描**（掃描吃的是實查結果），
 * 它只負責讓「射程長出新成員」這件事被看見。
 */
const DECLARED_GLOB_SCAN_FILES = [
  "backend/Dockerfile",
  "docker-compose.yml",
  "frontend/Dockerfile",
];

/** glob 實查 ＋ `.env.example`（AC-12(b)／AC-13(c) 明文要求其入掃描，非 glob 來源）。 */
const SCAN_FILES = [...discoverGlobScanFiles(REPO_ROOT), ".env.example"];

type SecretHit = { readonly file: string; readonly patternId: string; readonly literal: string };

function scanForSecrets(): SecretHit[] {
  const targets: string[] = [];
  for (const dir of SCAN_DIRS) targets.push(...listFilesRecursive(path.join(REPO_ROOT, dir)));
  for (const file of SCAN_FILES) {
    const full = path.join(REPO_ROOT, file);
    if (fs.existsSync(full)) targets.push(full);
  }
  const hits: SecretHit[] = [];
  for (const file of targets) {
    const content = fs.readFileSync(file, "utf8");
    hits.push(...scanContent(content).map((h) => ({ ...h, file: repoRel(file) })));
  }
  return hits;
}

function scanContent(content: string): Array<{ patternId: string; literal: string; file: string }> {
  const out: Array<{ patternId: string; literal: string; file: string }> = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of content.matchAll(pattern.regex)) {
      out.push({ patternId: pattern.id, literal: match[0], file: "" });
    }
  }
  return out;
}

/**
 * AC-12(b) — 白名單以常數**逐筆宣告 ＋ 逐筆理由**（沿
 * `phase10-error-handler-leak.test.ts` :383／:403 之形狀，但比它更細一級：
 * 那份是**檔案**白名單，這份是 **(檔案, 樣式, 字面)** 三元組白名單）。
 *
 * 為何要細到字面：`docs/` 有 41 個檔、2.7 MB。若以檔案為單位放行，等於宣告
 * 「這個 md 裡任何連線字串都不看」——日後有人把正式憑證貼進同一個檔就完全
 * 掃不到。以三元組為單位，同一個檔裡出現**新的**憑證字面仍會翻紅。
 *
 * 命中之字面在 `conn-string` 樣式下**止於 `@`**（正規表示式不吃主機與資料庫
 * 名），故同一組帳密對不同 port 的兩個本機測試庫只算一筆——敏感的是帳密本身。
 */
const SECRET_SCAN_WHITELIST: ReadonlyArray<{
  readonly file: string;
  readonly patternId: string;
  readonly literal: string;
  readonly reason: string;
}> = [
  {
    file: ".env.example",
    patternId: "conn-string",
    literal: "postgresql://USER:PASSWORD@",
    reason:
      "註解行 `# Format: postgresql://USER:PASSWORD@HOST:PORT/DB` — 全大寫的欄位名佔位，" +
      "教部署者連線字串長什麼樣。它連「像憑證」都算不上，但掃描器刻意不剝註解（誤報方向安全，" +
      "見 PROCESS_ENV_OBJECT_HANDOFF_FILES 之同一紀律說明），故逐筆列出。",
  },
  {
    file: ".env.example",
    patternId: "conn-string",
    literal: "postgresql://appuser:changeme@",
    reason:
      "AC-12(b) 逐字列名之佔位值。`changeme` 是自我揭露式佔位詞，部署者一眼看得出必須替換；" +
      "同一字面另受 `env-example-sync.test.ts` 之 CREDENTIAL_PLACEHOLDER_CONTRACT 逐字釘死，" +
      "故「它仍是佔位詞」這件事本身也有機械守門，不是靠人記得。",
  },
  {
    file: "backend/src/auth/password.ts",
    patternId: "argon2-hash",
    literal:
      "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2Fs$oFaEAqYlhNqTe6X7YlH+qRiRG0BFSbSMMqnGEBSB3Rs",
    reason:
      "`DUMMY_HASH`（:60）— 對**隨機內部字串**取的 argon2id 雜湊，用途是帳號不存在時做等時假驗證" +
      "（D3/4.5.1 時序側通道防護）。它必須是真實形狀才有等時效果，故不能改寫成假字串；" +
      "它不對應任何真實帳號的密碼，`verifyPassword` 對它恆回 false。salt 為 " +
      "`c2FsdHNhbHRzYWx0c2Fs`（base64 之 `saltsaltsaltsal`），本身即自證為合成值。",
  },
  {
    file: "backend/src/platform/log-sanitize.ts",
    patternId: "conn-string",
    literal: "postgresql://secret:pass@",
    reason:
      "JSDoc :25 之遮蔽前後對照範例（說明本模組會把連線字串的帳密遮掉）。合成字面，非任何真實環境。",
  },
  {
    file: "backend/src/platform/log-sanitize.ts",
    patternId: "conn-string",
    literal: "postgresql://user:pass@",
    reason:
      '行內註解 :53 說明 regex 之匹配片段形狀（`match is e.g. "postgresql://user:pass@"`）。合成字面。',
  },
  {
    file: "e2e/attachments-demo.spec.ts",
    patternId: "conn-string",
    literal: "postgresql://testuser:test@",
    reason:
      "檔頭註解記載本機 E2E 測試庫之連線字串（`testuser`／`test`）。**本機開發用合成憑證**，" +
      "資料庫只含合成種子資料，且該執行個體不對外開放；正式環境之 DATABASE_URL 一律由 env 提供。",
  },
  {
    file: "e2e/depreciation-allowance.spec.ts",
    patternId: "conn-string",
    literal: "postgresql://testuser:test@",
    reason: "同 `attachments-demo.spec.ts`：檔頭註解記載本機 E2E 測試庫連線字串，本機合成憑證。",
  },
  {
    file: ".github/workflows/ci.yml",
    patternId: "conn-string",
    literal: "postgresql://postgres:postgres@",
    reason:
      ":74 指向 CI service container（`postgres:16`）之連線字串。該容器隨 job 建立、隨 job 銷毀、" +
      "只在 runner 的網路命名空間內可達，帳密為 postgres 映像檔預設值——**CI 專用合成憑證**，" +
      "非真實 secret（`docs/specs/PHASE-001.md` :501 已逐字如此登記）。",
  },
  {
    file: "docs/specs/INFRA-001.md",
    patternId: "conn-string",
    literal: "postgresql://testuser:test@",
    reason:
      "Spec 內引述本機測試庫連線字串（:62／:179／:535）以說明 schema 隔離之實測條件。合成憑證。",
  },
  {
    file: "docs/specs/INFRA-001.md",
    patternId: "conn-string",
    literal: "postgresql://postgres:postgres@",
    reason: "Spec :168 引述 CI workflow 之 DATABASE_URL 行以說明 CI 環境。CI 合成憑證。",
  },
  {
    file: "docs/specs/PHASE-001.md",
    patternId: "conn-string",
    literal: "postgresql://user:pass@",
    reason:
      "Spec :453 之 env 變數表以 `postgresql://user:pass@host:5432/db` 說明格式。純格式範例。",
  },
  {
    file: "docs/specs/PHASE-001.md",
    patternId: "conn-string",
    literal: "postgresql://postgres:postgres@",
    reason:
      "Spec :501 說明 CI 之 Postgres service container，並於同句逐字註明「CI 專用合成憑證，非真實 secret」。",
  },
  {
    file: "docs/specs/PHASE-011.md",
    patternId: "conn-string",
    literal: "postgresql://appuser:changeme@",
    reason:
      "AC-12(b) 條文本身引述 `.env.example` :18 之佔位值以指名它必須入白名單。條文引述，非憑證。",
  },
];

const SECRET_HITS = scanForSecrets();

function hitKey(hit: { file: string; patternId: string; literal: string }): string {
  return `${hit.file} :: ${hit.patternId} :: ${hit.literal}`;
}

describe("PHASE-011-T8 — AC-12: 零寫死正式敏感資訊", () => {
  it("(a) 受控範圍全掃：命中集合恰等於白名單（多一筆或少一筆都必紅）", () => {
    const actual = [...new Set(SECRET_HITS.map(hitKey))].sort();
    const expected = [...new Set(SECRET_SCAN_WHITELIST.map(hitKey))].sort();
    expect(actual).toEqual(expected);
  });

  // ── T8R 即審 SF-2：射程完整性（防靜默漏掃） ──────────────────────────
  it("(a) 射程完整性：glob 實查之檔案集合恰等於宣告清單（新增同型檔必紅）", () => {
    expect(discoverGlobScanFiles(REPO_ROOT)).toEqual(DECLARED_GLOB_SCAN_FILES);
  });

  it("(a) 射程完整性：實際掃描目標確實包含 glob 實查結果 ＋ .env.example", () => {
    expect(SCAN_FILES).toEqual([...DECLARED_GLOB_SCAN_FILES, ".env.example"]);
  });

  it("(a) 射程完整性之鑑別力：override 檔與新服務 Dockerfile 皆會被 glob 拾起", () => {
    // 在 **os.tmpdir() 之下**建合成目錄樹做實驗，刻意不在倉庫內建臨時檔——
    // 平行測試或中途失敗都可能把一個假的 `docker-compose.override.yml` 留在
    // 工作樹裡，那正是本檔其他突變格一律走「記憶體 ＋ 位元組還原」的理由。
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t8r-globscope-"));
    try {
      fs.writeFileSync(path.join(fixture, "docker-compose.yml"), "services: {}\n");
      fs.writeFileSync(path.join(fixture, "docker-compose.override.yml"), "services: {}\n");
      fs.writeFileSync(path.join(fixture, "docker-compose.prod.yaml"), "services: {}\n");
      fs.mkdirSync(path.join(fixture, "worker"));
      fs.writeFileSync(path.join(fixture, "worker/Dockerfile"), "FROM node:20\n");
      fs.mkdirSync(path.join(fixture, "node_modules"));
      fs.writeFileSync(path.join(fixture, "node_modules/Dockerfile"), "FROM node:20\n");

      expect(discoverGlobScanFiles(fixture)).toEqual([
        "docker-compose.override.yml",
        "docker-compose.prod.yaml",
        "docker-compose.yml",
        "worker/Dockerfile",
      ]);
      // 三項一起證明：①`*.override.yml`／`.yaml` 副檔名兩式都拾得起
      // ②新服務目錄之 Dockerfile 拾得起 ③`node_modules` 之 Dockerfile 不誤入
      // （SKIP_DIRS 生效——否則相依套件裡的 Dockerfile 會把射程灌爆）。
      expect(discoverGlobScanFiles(fixture)).not.toContain("node_modules/Dockerfile");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("(a) 射程完整性之還原自證：實驗後倉庫根零殘留同型檔", () => {
    expect(discoverGlobScanFiles(REPO_ROOT)).toEqual(DECLARED_GLOB_SCAN_FILES);
  });

  it("(b) 白名單逐筆有理由，且理由長度足以說明『為何它不是真憑證』", () => {
    for (const entry of SECRET_SCAN_WHITELIST) {
      expect(entry.reason.length, hitKey(entry)).toBeGreaterThan(40);
      expect(SECRET_PATTERNS.map((p) => p.id)).toContain(entry.patternId);
    }
  });

  it("(b) 白名單零冗餘：每一筆都對應到實際命中（陳年條目不得留著遮蔽新命中）", () => {
    const actualKeys = new Set(SECRET_HITS.map(hitKey));
    const stale = SECRET_SCAN_WHITELIST.filter((e) => !actualKeys.has(hitKey(e))).map(hitKey);
    expect(stale).toEqual([]);
  });

  it("(c) 合成陽性：四類樣式之真實形狀字串必被命中", () => {
    const synthetic = [
      "postgresql://produser:Sup3rS3cretPw@prod-db.internal:5432/appdb",
      "postgres://admin:hunter2@10.0.0.5:5432/live",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "$argon2id$v=19$m=65536,t=3,p=4$YWFhYWFhYWFhYWFhYWFhYQ$3lTZ0kQx8vNqPzR7wYmLkJhGfDsAqWeRtYuIoP1234A",
      'apiSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
      'ACCESS_TOKEN="0123456789abcdef0123456789abcdef01234567"',
    ];
    for (const sample of synthetic) {
      expect(
        scanContent(sample).length,
        `合成陽性未被命中：${sample.slice(0, 40)}`
      ).toBeGreaterThan(0);
    }
  });

  it("(c) 不誤報：說明性註解、空值、以及未帶密碼之連線字串", () => {
    const benign = [
      "// 本模組會把連線字串裡的 password 遮掉後才寫入日誌",
      "# Set DATABASE_URL to your own Postgres instance before starting",
      "POSTGRES_PASSWORD=",
      'const token = "";',
      "SESSION_COOKIE_NAME=sid",
      "postgresql://localhost/test",
      "postgresql://db:5432/appdb",
      "* `$argon2` 雜湊前綴之掃描（僅前綴，非完整雜湊字面）",
      "`$argon2id$v=19$m=...,t=...,p=...$salt$hash`",
    ];
    for (const sample of benign) {
      expect(scanContent(sample), `誤報：${sample.slice(0, 50)}`).toEqual([]);
    }
  });

  it("(c) 鑑別力：把合成憑證塞進受控範圍內之檔案內容 → 落在白名單外", () => {
    const realSource = fs.readFileSync(path.join(SRC_ROOT, "config/env.ts"), "utf8");
    const mutated = `${realSource}\nconst leaked = "postgresql://produser:R3alPassw0rd@prod:5432/appdb";\n`;
    const hits = scanContent(mutated).map(
      (h) => `backend/src/config/env.ts :: ${h.patternId} :: ${h.literal}`
    );
    const whitelisted = new Set(SECRET_SCAN_WHITELIST.map(hitKey));
    expect(hits.filter((h) => !whitelisted.has(h))).toEqual([
      "backend/src/config/env.ts :: conn-string :: postgresql://produser:R3alPassw0rd@",
    ]);
  });

  it("(d) `.gitignore` 涵蓋 `.env` 且明示豁免 `.env.example`", () => {
    const lines = fs
      .readFileSync(GITIGNORE_PATH, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
  });

  it("(d) `.env`（未追蹤）確實不在 git 索引內（防『掃描很乾淨但 .env 其實被提交』）", () => {
    // `.gitignore` 有寫不等於檔案沒被提交過——`.gitignore` 對**已追蹤**的檔案
    // 無效。故除了規則面之外，再查一次實際狀態：倉庫根與 backend/ 之 `.env`
    // 皆不得出現在工作樹的追蹤清單裡。
    const tracked = listFilesRecursive(REPO_ROOT, (f) => path.basename(f) === ".env").map(repoRel);
    // 本機開發者**會**有 .env（那是刻意的、且被 ignore）；本格斷言的是它們
    // 沒有被 git 追蹤，而非它們不存在。
    const gitIndexed = tracked.filter((rel) => isTrackedByGit(rel));
    expect(gitIndexed).toEqual([]);
  });

  it("(e)【記載型】git 歷史不在本 Phase 射程，已據實登記於 §17.1 #7", () => {
    const spec = fs.readFileSync(path.join(REPO_ROOT, "docs/specs/PHASE-011.md"), "utf8");
    expect(spec).toContain("git 歷史之 secrets 掃描不在射程");
    // 本格刻意不掃 git 歷史：歷史掃描屬獨立工程（需 rewrite 能力與憑證輪替
    // 程序配套）。這一格的作用是讓「限制被寫在 Spec 裡」這件事本身可機械查核，
    // 使日後有人刪掉那句話時，這個限制不會靜默消失。
  });
});

/**
 * 以 `git ls-files --error-unmatch` 判定單一路徑是否被追蹤。
 * 失敗（非零結束碼／git 不可用）一律視為「未追蹤」——本函式只用於一條
 * **加強**斷言，規則面之保證由上一格的 `.gitignore` 內容比對承擔，故此處
 * 之降級不會讓 AC-12(d) 失去守門。
 */
function isTrackedByGit(relPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// AC-16(c) — DB 服務可替換之結構性證據
// ===========================================================================

describe("PHASE-011-T8 — AC-16(c): DB 服務可替換（記載型 ＋ 結構斷言）", () => {
  it("`new PrismaClient` 之站點集合恰等於封閉清單", () => {
    const files: string[] = [];
    for (const file of SRC_TS_FILES) {
      if (/new PrismaClient\s*\(/.test(fs.readFileSync(file, "utf8"))) files.push(srcRel(file));
    }
    expect(files.sort()).toEqual([
      "attachment/cleanup-cli.ts",
      "db/prisma.ts",
      "seed/seed-admin.ts",
    ]);
  });

  it("三個站點皆不含連線字串字面（連線設定之唯一來源是 DATABASE_URL）", () => {
    // AC-12(a) 之全域掃描已保證 `backend/src` 零非白名單連線字串，且白名單裡
    // 唯二的 `backend/src` 條目是 `log-sanitize.ts` 之註解與 `password.ts` 之
    // 雜湊——都不是這三個檔。本格把該結論在這三個檔上再釘一次，使 AC-16(c)
    // 不必回頭依賴讀者自己去做這個推論。
    for (const rel of ["attachment/cleanup-cli.ts", "db/prisma.ts", "seed/seed-admin.ts"]) {
      const hits = scanContent(fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"));
      expect(
        hits.filter((h) => h.patternId === "conn-string"),
        `${rel} 之連線字串字面`
      ).toEqual([]);
    }
  });

  it("【記載型】改用其他 PostgreSQL 服務為純設定變更，不實跑外部服務", () => {
    // Spec AC-16(c) 逐字：「後端對 DB 之取用恰經 `DATABASE_URL` 一處（AC-11(d)
    // 已涵蓋），故『改用其他 PostgreSQL 服務』為純設定變更——以記載型 `it`
    // 明示，**不實跑外部服務**。」
    //
    // 本格所依據之三項機械事實（皆由本檔其他格實測）：
    //   ① `backend/src` 零非白名單連線字串字面（AC-12(a)）；
    //   ② Prisma 用戶端之建立恰三處，皆不帶連線字串字面；
    //   ③ `DATABASE_URL` 是 schema 唯一必填鍵（AC-11(c) 行為導出）。
    // 三者合起來的意思是：換一台 Postgres＝換一個 env 值，`backend/src` 零行改動。
    //
    // **本格不宣稱**的事（誠實界定）：不宣稱任何 Postgres 都能跑（Prisma
    // migration 需 PostgreSQL 16 之語法相容性）、不宣稱連線池／TLS 參數不需
    // 調整（那些是 `DATABASE_URL` 的 query string，仍屬設定面但需人工確認）。
    expect(PRODUCTION_REQUIRED_ENV_KEYS).toContain("DATABASE_URL");
    expect(ENV_SCHEMA_KEYS).toContain("DATABASE_URL");
  });
});

// ===========================================================================
// T7 FW-2／FW-3／FW-7 — 上游移交之順帶守門
// ===========================================================================

describe("PHASE-011-T8 — T7 FW-2: env schema 零 cookie／proxy 綁定（負向斷言）", () => {
  it("schema 鍵集不含任何 proxy／secure-cookie 語意之鍵", () => {
    // D8=(a) 之「不信任代理」與 AC-09 之「production 才 Secure」，其安全性建立
    // 在**沒有一條可達路徑**能從外部把它們關掉。一旦有人加了 `TRUST_PROXY` 或
    // `FORCE_SECURE_COOKIES` 這類 env 鍵，單向加嚴就變成雙向可調——本格讓那個
    // 動作在 commit 之前就必紅。（Spec §8.2 草案表確實列有 `TRUST_PROXY`；
    // D8=(a) 裁定不信任代理之後它不再需要，故本 Phase **未新增**，本格釘住此決定。）
    const forbidden = /(TRUST_?PROXY|X_FORWARDED|SECURE_COOKIE|FORCE_SECURE|PROXY_TRUST)/i;
    expect(ENV_SCHEMA_KEYS.filter((key) => forbidden.test(key))).toEqual([]);
  });

  it("`trustProxy` 與 `forceSecureCookies` 之賦值皆不來自 env／AppConfig", () => {
    const offenders: string[] = [];
    for (const file of SRC_TS_FILES) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(trustProxy|forceSecureCookies)\s*:\s*([^,\n]+)/g)) {
        const value = (match[2] as string).trim();
        if (/\b(env|appEnv|config|cfg|process)\b/.test(value)) {
          offenders.push(`${srcRel(file)} :: ${match[1]}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mutant：把 trustProxy 接上 env → 上一格必紅", () => {
    const mutated = '  trustProxy: appEnv.TRUST_PROXY === "true",';
    const offenders: string[] = [];
    for (const match of mutated.matchAll(/(trustProxy|forceSecureCookies)\s*:\s*([^,\n]+)/g)) {
      const value = (match[2] as string).trim();
      if (/\b(env|appEnv|config|cfg|process)\b/.test(value)) offenders.push(value);
    }
    expect(offenders).toHaveLength(1);
  });
});

describe("PHASE-011-T8 — T7 FW-3: cookie 寫入／清除之呼叫點白名單", () => {
  it("`reply.setCookie`／`reply.clearCookie` 之（檔案, 方法）集合恰等於現況白名單", () => {
    // 本格**不改任何程式**，只把今日的形狀釘住：session cookie 的寫入面恰一
    // 處（登入）、清除面恰三處（登出 ＋ middleware 之兩條失效路徑）。新增一個
    // 寫 cookie 的地方必紅，使「有人在別處寫了一個沒有 HttpOnly/Secure 的
    // cookie」不會靜默通過 code review。
    const found: string[] = [];
    for (const file of SRC_TS_FILES) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/\.(setCookie|clearCookie)\s*\(/g)) {
        found.push(`${srcRel(file)} :: ${match[1]}`);
      }
    }
    expect(found.sort()).toEqual([
      "auth/middleware.ts :: clearCookie",
      "auth/middleware.ts :: clearCookie",
      "auth/routes.ts :: clearCookie",
      "auth/routes.ts :: setCookie",
    ]);
  });
});

describe("PHASE-011-T8 — T7 FW-7: 測試用合成密碼常數不撞 AC-12 樣式（確認）", () => {
  it("合成測試密碼不落入四類樣式（故無須為它們建類別白名單）", () => {
    // Packet 移交項 7 之確認。這些字面短且含標點，不符「≥32 之連續 base64／
    // hex」，也不是連線字串／私鑰／雜湊，故 AC-12 的掃描本來就不會碰它們——
    // AC-12(b) 條文所預期的「backend/test 合成密碼常數需入白名單」在實作後
    // 證實**不需要**（且 `backend/test` 本就不在 AC-12(a) 之受控範圍內）。
    for (const sample of ["E2eAdmin@456!", "T7CookieWire99!", "Admin@1234", "ChangeMe#2026"]) {
      expect(scanContent(sample), sample).toEqual([]);
    }
  });
});

// ===========================================================================
// T4R 移交 — `invalidNumericEnvKeys` 與 env schema `int > 0` 之逐值一致性
// ===========================================================================

const CLEANUP_CLI_SOURCE = fs.readFileSync(CLEANUP_CLI_TS, "utf8");

/**
 * `attachment/cleanup-cli.ts` 之 `invalidNumericEnvKeys` 函式體逐字錨點。
 *
 * **為何是錨點而不是直接 import**：該函式與 `CLEANUP_NUMERIC_ENV_KEYS` 皆未
 * `export`，而 `cleanup-cli.ts` 屬本 Task 之 Files Forbidden（唯讀 import 才
 * 允許，加 `export` 是修改）。故下方以「原始碼逐字比對 ＋ 本檔內的鏡像實作」
 * 成對運作：錨點保證鏡像與真實實作同義，鏡像才能拿來跑逐值比對。
 *
 * 錨點失效（有人改了那個函式）時，本格會以明確訊息紅燈，提示維護者同步更新
 * 鏡像並重新確認一致性——這正是我們要的行為，不是誤報。
 */
const INVALID_NUMERIC_ENV_KEYS_ANCHOR = `function invalidNumericEnvKeys(env: Record<string, string | undefined>): string[] {
  return CLEANUP_NUMERIC_ENV_KEYS.filter((key) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return false;
    const value = Number(raw);
    return !Number.isInteger(value) || value <= 0;
  });
}`;

const CLEANUP_NUMERIC_ENV_KEYS_ANCHOR =
  'const CLEANUP_NUMERIC_ENV_KEYS = ["ATTACHMENT_TEMP_TTL_HOURS", "ATTACHMENT_CLEANUP_BATCH_LIMIT"];';

/** 上述錨點之鏡像（逐字同義）。 */
function cliRejects(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  const value = Number(raw);
  return !Number.isInteger(value) || value <= 0;
}

function schemaRejects(key: string, raw: string): boolean {
  try {
    parseEnv({ ...COMPLETE_PRODUCTION_ENV, [key]: raw });
    return false;
  } catch {
    return true;
  }
}

describe("PHASE-011-T8 — T4R 移交: cleanup-cli 具名檢查與 env schema int>0 之一致性", () => {
  it("錨點：`invalidNumericEnvKeys` 與其鍵清單之原始碼逐字未變", () => {
    expect(CLEANUP_CLI_SOURCE).toContain(CLEANUP_NUMERIC_ENV_KEYS_ANCHOR);
    expect(CLEANUP_CLI_SOURCE).toContain(INVALID_NUMERIC_ENV_KEYS_ANCHOR);
  });

  it("CLI 具名檢查之鍵集 ⊆ envSchema，且皆為 int>0 之數值鍵", () => {
    const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
    for (const key of ["ATTACHMENT_TEMP_TTL_HOURS", "ATTACHMENT_CLEANUP_BATCH_LIMIT"]) {
      expect(schemaKeys.has(key), key).toBe(true);
      expect(schemaRejects(key, "0"), `${key} 之 schema int>0 規則`).toBe(true);
    }
  });

  it.each([
    ["24", false, false, "合法值：兩路皆接受"],
    ["0", true, true, "零：兩路皆拒"],
    ["-1", true, true, "負數：兩路皆拒"],
    ["1.5", true, true, "非整數：兩路皆拒"],
    ["abc", true, true, "非數值：兩路皆拒"],
  ])("逐值一致（%s）：schema 拒=%s，CLI 具名拒=%s — %s", (raw, schemaExpected, cliExpected) => {
    expect(schemaRejects("ATTACHMENT_CLEANUP_BATCH_LIMIT", raw as string)).toBe(schemaExpected);
    expect(cliRejects(raw as string)).toBe(cliExpected);
  });

  it("刻意例外（空字串）：schema 拒、CLI 具名放行 — 行為仍 fail-closed，僅解析度較低", () => {
    // T4R-DOC／NF-2 已據實記載於 `cleanup-cli.ts` 之 JSDoc：`""` 會被
    // `invalidNumericEnvKeys` **放行**（`raw.trim() === ""` 分支），但它並不會
    // 拿到 schema 預設值——`z.coerce.number()` 把 `""` 轉成 `0`，`.positive()`
    // 隨即拒絕。故 CLI 最終仍硬失敗（走下游 `parseEnv` 的 catch），只是日誌是
    // 通用的 `ENV_VALIDATION_FAILED` 而非具名。
    //
    // 本格把這個**已知且刻意**的不一致釘成明示斷言，理由：它若哪天「被修好」
    // （CLI 也具名拒空字串），本格會紅並提示更新——這比讓不一致靜默存在好；
    // 而它若朝**危險方向**變化（schema 改成接受空字串 → 不可逆刪除可能拿到
    // 預設值偷跑），第一行 `toBe(true)` 會立刻紅。
    expect(schemaRejects("ATTACHMENT_CLEANUP_BATCH_LIMIT", "")).toBe(true);
    expect(cliRejects("")).toBe(false);
    expect(CLEANUP_CLI_SOURCE).toContain("空字串");
  });

  it("還原自證：cleanup-cli.ts 磁碟位元組全等（本檔只讀不寫）", () => {
    expect(fs.readFileSync(CLEANUP_CLI_TS, "utf8")).toBe(CLEANUP_CLI_SOURCE);
  });
});
