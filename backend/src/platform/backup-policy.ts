/**
 * 備份政策之純函式 ＋ 供 `scripts/backup.sh` 呼叫之最小 CLI — PHASE-011-T12
 *
 * `docs/specs/PHASE-011.md` **AC-20**（保留期）／**AC-21**（目的地路徑樹守門）；
 * §16 **D11-1**=(a)（`docker exec` ＋ `pg_dump -Fc`）、**D11-2**=(a)（不加密）、
 * **D12**=(a)（只做路徑樹守門）。
 *
 * ---------------------------------------------------------------------------
 * 為什麼判準在 TypeScript 而不在那支 bash 腳本裡
 * ---------------------------------------------------------------------------
 * 備份腳本必須做兩個**會出錯就出大事**的判斷：「這個目的地可不可以寫」與「哪幾
 * 份備份可以刪」。兩者都是純運算，且都需要邊界格與 mutant 才能證明它承重
 * （AC-20(e)、AC-21(c)）。bash 裡的字串前綴比對無法被 vitest 以同一組 fixture
 * 反覆逼問，所以判準集中在本檔，腳本只負責**執行**本檔的結論：
 *
 *   · `scripts/backup.sh` → `… backup-policy check-destination` → 非零即拒跑
 *   · `scripts/backup.sh` → `… backup-policy plan-retention`   → 逐行讀「該刪誰」
 *
 * 這條分工沿 PHASE-011-T3／T4 的「判定與執行切開」裁定（`cleanup-cli.ts` 檔頭）：
 * 判準與執行合寫時，「預覽看起來安全但實跑走了另一條分支」永遠可能發生。腳本
 * **不自行判斷該刪誰**，此點由 `phase11-backup-restore.test.ts` 之結構斷言釘死。
 *
 * ---------------------------------------------------------------------------
 * 設定值一律走**標準輸入**（`KEY=VALUE` 逐行），零命令列參數、零環境讀取
 * ---------------------------------------------------------------------------
 * 三個理由，依重要性排列：
 *   ① **AC-11(d) 之封閉性**：`backend/src` 的環境讀取站點是一份封閉白名單
 *      （`phase11-env-secrets.test.ts` 之兩面掃描）。本檔是一支被 shell 呼叫的
 *      工具，它的輸入來源本來就該由呼叫端明確交付，而不是自己去翻環境——順著
 *      這條紀律走，本檔連一個環境讀取站點都不需要新增。
 *   ② **AC-22(c) 同源紀律**：命令列參數會出現在主機行程表。本檔不碰憑證，但同
 *      一支腳本裡兩套傳參慣例，容易讓人日後把連線字串塞進 argv。stdin 兩者皆無。
 *   ③ **AC-21(b)**：拒絕訊息不得含完整路徑值；路徑若走 argv，等於在行程表裡把
 *      它公告一次，繞過該紀律。
 * 只有**子命令名**走 argv。
 *
 * ---------------------------------------------------------------------------
 * D12=(a) 之射程限制（**不得被誤讀**，Spec §17.1 逐字）
 * ---------------------------------------------------------------------------
 * 本檔機械保證的只有「備份不落在正式資料之**路徑樹**內」。**「不同主機／不同磁
 * 碟」系統不驗證**——那是部署時之人工設定 ＋ Runbook 檢核（AC-21(e)、AC-25(b)）。
 * 同一顆磁碟上的兩個獨立目錄會通過本檔全部檢查；`evaluateDestination` 回 `true`
 * **不等於** NFR-US-12⑤ 已滿足。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ===========================================================================
// 變數名常數（訊息只印變數名，不印值——AC-21(b)）
// ===========================================================================

export const DESTINATION_ENV = "BACKUP_DEST_ROOT";
export const RETENTION_DAYS_ENV = "BACKUP_RETENTION_DAYS";
export const ATTACHMENT_ROOT_ENV = "ATTACHMENT_STORAGE_ROOT";
export const REPORT_ROOT_ENV = "REPORT_STORAGE_ROOT";
/**
 * PostgreSQL data 目錄（AC-21(a) 之第三個受保護根）。
 *
 * **選用**：本專案之 PG data 位於 docker named volume（`docker-compose.yml`
 * :8 `pgdata:/var/lib/postgresql/data`），主機上沒有一個「正式資料目錄」路徑可
 * 比；受管 DB 更是沒有。設定了就納入比對，沒設定就**據實少一個受保護根**——
 * `check-destination` 會把此事印在輸出裡，不假裝已經檢查過（Spec §8.2 未列此變
 * 數，故列入 Handoff 之移交清單）。
 */
export const PGDATA_PATH_ENV = "BACKUP_PGDATA_PATH";

// ===========================================================================
// AC-20 — 保留期
// ===========================================================================

/** US NFR-US-12③ 逐字之硬性下限；設定值低於此一律拒絕（AC-20(c)）。 */
export const MIN_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackupEntry {
  /** 備份目錄名（＝`BACKUP_ID_PATTERN` 之時間戳 id）。 */
  readonly id: string;
  /** 該備份之建立時刻（epoch ms）。 */
  readonly createdAtMs: number;
}

export interface RetentionPlan {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
}

/**
 * 解析並驗證 `BACKUP_RETENTION_DAYS`（AC-20(a)(c)）。
 *
 * 未設定 → 預設 `MIN_RETENTION_DAYS`；非整數、或 `< 14` → 拋錯，訊息**只含變數名
 * 與下限數字**（不回印使用者給的值——沿「錯值訊息零值洩漏」紀律，AC-11(a)）。
 */
export function parseRetentionDays(raw: string | undefined): number {
  const result = checkRetentionDays(raw);
  if (!result.ok) throw new Error(result.message);
  return result.days;
}

/**
 * `parseRetentionDays` 之**不拋版**，供 CLI 使用。
 *
 * 為什麼要兩個：CLI 若以 `catch (err) { … err.message }` 取訊息，就會踩到本專案
 * 的「全域錯誤訊息取值」封閉白名單（`phase10-error-handler-leak.test.ts` L2）
 * ——而那條紀律是對的：`catch` 到的未必是我們自己丟的錯，`fs`／執行期例外的訊息
 * 逐字含絕對路徑。**判斷結果用回傳值表達，例外只留給真正的意外**。
 */
export function checkRetentionDays(
  raw: string | undefined
): { readonly ok: true; readonly days: number } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true, days: MIN_RETENTION_DAYS };
  const trimmed = raw.trim();
  // `Number("")` 是 0、`Number("1e2")` 是 100——兩者都不是「十進位整數字面」，
  // 故先以正則卡死形狀，再交給 Number。
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `${RETENTION_DAYS_ENV} must be an integer of at least ${MIN_RETENTION_DAYS}`,
    };
  }
  const days = Number(trimmed);
  if (days < MIN_RETENTION_DAYS) {
    return {
      ok: false,
      message: `${RETENTION_DAYS_ENV} must be at least ${MIN_RETENTION_DAYS} (US NFR-US-12 hard lower bound)`,
    };
  }
  return { ok: true, days };
}

/**
 * 「給定今日與備份清單 → 應刪清單」（AC-20(a)(b)(d)）。
 *
 * 規則恰三條：
 *   1. **零份或僅一份 → 一律不刪**（AC-20(d)／B-18；防「清理把唯一備份刪掉」）。
 *   2. 其餘：`now − createdAt` **嚴格大於** `retentionDays` 天者才刪（AC-20(b)；
 *      與 AC-05(b)③ 之附件 TTL 同一取邊界紀律，Spec §18 第 5 列明載此對齊為刻
 *      意）。恰 N 天 → 保留。
 *   3. 回傳之 `keep`／`remove` 保持輸入順序，且兩者為輸入之無交集分割。
 *
 * **已知殘留風險（據實記載，非本 Task 逕自處置）**：若備份中斷超過 N 天，清單裡
 * 每一份都過期時，本規則會把它們全刪（只留下「≤1 份」那條保護）。AC-20(d) 逐字
 * 只保護「目錄為空或僅有一份」，故此處不自行加碼「永遠保留最新一份」——那會與
 * AC-20(a) 之「保留最近 N 天內之全部備份，超過者才刪」相衝突，屬產品語意變更，
 * 已列 Handoff 移交人類裁定。
 */
export function planRetention(args: {
  readonly nowMs: number;
  readonly retentionDays: number;
  readonly entries: readonly BackupEntry[];
}): RetentionPlan {
  const { nowMs, retentionDays, entries } = args;

  if (entries.length <= 1) {
    return { keep: entries.map((e) => e.id), remove: [] };
  }

  const cutoffMs = retentionDays * DAY_MS;
  const keep: string[] = [];
  const remove: string[] = [];
  for (const entry of entries) {
    if (nowMs - entry.createdAtMs > cutoffMs) remove.push(entry.id);
    else keep.push(entry.id);
  }
  return { keep, remove };
}

/** 備份目錄名之唯一格式：UTC `YYYYMMDDTHHMMSSZ`（腳本產生，非使用者輸入）。 */
export const BACKUP_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * 由備份目錄名取其建立時刻；不符格式回 `null`。
 *
 * 刻意**不用檔案 mtime**：mtime 會被複製、rsync、防毒掃描改動，而目錄名是備份自
 * 己寫下的事實。不符格式者一律回 `null`，呼叫端據此**跳過**（不刪）——未知目錄
 * 在一個刪除工具裡只能是「不碰」。
 */
export function parseBackupId(name: string): number | null {
  const m = BACKUP_ID_PATTERN.exec(name);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(ms) ? null : ms;
}

// ===========================================================================
// AC-21 — 目的地路徑樹守門
// ===========================================================================

export interface ProtectedRoot {
  /** 該根之**環境變數名**（訊息只印這個，不印路徑值）。 */
  readonly envName: string;
  readonly path: string;
}

export type DestinationRelation = "same-path" | "descendant-of-protected" | "ancestor-of-protected";

export interface DestinationViolation {
  readonly envName: string;
  readonly relation: DestinationRelation;
}

export interface DestinationVerdict {
  readonly allowed: boolean;
  readonly violations: readonly DestinationViolation[];
}

/**
 * 比較用正規化：絕對化 ＋ **去尾分隔符** ＋（Windows）大小寫折疊。
 *
 * Windows 之檔案系統對大小寫不敏感，若逐字比對，`C:\Data\att` 與 `c:\data\att`
 * 會被判成兩個不同的樹——那是**漏報**方向的錯，在一個「不准寫進正式資料樹」的
 * 守門上不可接受。POSIX 側維持大小寫敏感（那裡確實是兩個不同目錄）。
 *
 * **去尾分隔符為 T12R SF-3 之修法**：`path.resolve()` 對一般路徑不留尾分隔符，
 * **唯獨磁碟根例外**——`path.resolve("C:\\")` ＝ `"C:\"`、`path.resolve("/")` ＝
 * `"/"`，兩者都自帶尾分隔符。下方祖先判定式 `protected.startsWith(dest + sep)`
 * 於是變成 `startsWith("C:\\\\")` 而比不中，**「把備份目的地設成整顆磁碟根」這個
 * 最極端的違規反而被放行**（reviewer 實測：`e:\` vs `e:\data\storage\att` 判定為
 * false）。正規化後根變成 `"C:"`／`""`，`startsWith("C:\")`／`startsWith("/")`
 * 即正確命中。此處補一格「目的地＝磁碟根」之邊界斷言釘死。
 */
function normalizeForComparison(p: string): string {
  const resolved = path.resolve(p);
  const folded = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  // 只去尾分隔符，不去其他字元。**POSIX 之根 `/` 會變成空字串，那正是要的**：
  // 祖先判定 `protected.startsWith("" + "/")` 才會命中；留成 `/` 則變 `//` 而失效
  // （與 Windows 的 `C:\\` 同一個坑，只是另一種寫法）。
  return folded !== "" && folded.endsWith(path.sep) ? folded.slice(0, -1) : folded;
}

/**
 * 目的地與受保護根之關係判定（**純比較**，不碰檔案系統）。
 *
 * 呼叫端有義務先把兩側都換成**正規化真實路徑**（`realPathOfNearestExisting`）——
 * B-16（目的地是 symlink，真身在 storage 樹內）就是靠那一步擋下的，本函式看到的
 * 若還是 symlink 路徑，它會（正確地）認為兩者無關。此分界刻意留在型別之外：測試
 * 以 B-16 一格把兩者串起來實跑，證明「正規化」不是宣稱。
 *
 * 後裔判定一律比到**路徑分隔符**（`root + sep`），否則 `…/att-backup` 會被誤判為
 * `…/att` 的後裔（誤擋方向；有專屬 mutant 格）。
 */
export function evaluateDestination(args: {
  readonly destination: string;
  readonly protectedRoots: readonly ProtectedRoot[];
}): DestinationVerdict {
  const dest = normalizeForComparison(args.destination);
  const violations: DestinationViolation[] = [];

  for (const root of args.protectedRoots) {
    const protectedPath = normalizeForComparison(root.path);
    if (dest === protectedPath) {
      violations.push({ envName: root.envName, relation: "same-path" });
    } else if (dest.startsWith(`${protectedPath}${path.sep}`)) {
      violations.push({ envName: root.envName, relation: "descendant-of-protected" });
    } else if (protectedPath.startsWith(`${dest}${path.sep}`)) {
      violations.push({ envName: root.envName, relation: "ancestor-of-protected" });
    }
  }

  return { allowed: violations.length === 0, violations };
}

/**
 * 拒絕訊息（AC-21(b)）：**指名變數與關係，零路徑值**。
 *
 * 「`BACKUP_DEST_ROOT` 是 `ATTACHMENT_STORAGE_ROOT` 的後裔」對維運人員已足以定位
 * 問題（兩個值都在他自己的設定檔裡）；把絕對路徑印出來則會讓 volume 路徑進入
 * 排程器日誌與告警信箱，正是七類禁字的第五類（`DATA_FLOW.md` :565③）。
 */
export function formatDestinationRejection(violations: readonly DestinationViolation[]): string {
  const detail = violations.map((v) => `${v.relation} of ${v.envName}`).join("; ");
  return `${DESTINATION_ENV} rejected by path-tree guard (AC-21): ${detail}`;
}

/**
 * 取「正規化真實路徑」，容許路徑**尚不存在**（第一次備份時目的地目錄還沒建）。
 *
 * 作法：從目的地往上找到**最近的既有祖先**，對它做 `realpathSync`（解析 symlink
 * ／Windows junction），再把剩下的路徑段接回去。這是本模組**唯一**碰檔案系統的
 * 函式，刻意與純比較切開。
 */
export function realPathOfNearestExisting(target: string): string {
  const absolute = path.resolve(target);
  const trailing: string[] = [];
  let current = absolute;

  for (;;) {
    if (fs.existsSync(current)) {
      const real = fs.realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    }
    const parent = path.dirname(current);
    // 已到根（`dirname` 不動了）：無既有祖先可解析，原樣回傳絕對路徑。
    if (parent === current) return absolute;
    trailing.push(path.basename(current));
    current = parent;
  }
}

/**
 * 組出本次執行之受保護根清單（AC-21(a) 三個來源，PG data 為選用）。
 *
 * 兩個 storage root **缺一即拒**：守門若在「變數沒設」時靜默縮小射程，就會出現
 * 「掃了但沒掃到」的假綠——沿 T10／T10R MF-1 之「可用性與結論分離」教訓。
 *
 * **回結果而不拋**（同 `checkRetentionDays`）：錯誤訊息一律由本函式自己組出，
 * 只含變數名；`realpathSync` 之 I/O 例外**不讀其訊息**（那逐字含絕對路徑），
 * 只轉為一句固定敘述。
 */
export function collectProtectedRoots(settings: Readonly<Record<string, string | undefined>>):
  | {
      readonly ok: true;
      readonly roots: readonly ProtectedRoot[];
      /** 未設定而被略過之受保護根變數名（據實回報，供輸出揭露）。 */
      readonly skipped: readonly string[];
    }
  | { readonly ok: false; readonly message: string } {
  const roots: ProtectedRoot[] = [];
  const skipped: string[] = [];

  const resolve = (envName: string, value: string): boolean => {
    try {
      roots.push({ envName, path: realPathOfNearestExisting(value) });
      return true;
    } catch {
      // 刻意**不繫結**例外物件：`fs` 的訊息逐字含絕對路徑（`ENOENT … 'C:\…'`），
      // 讀它就等於把 volume 路徑印進排程器日誌（七類禁字第五類）。
      return false;
    }
  };

  for (const envName of [ATTACHMENT_ROOT_ENV, REPORT_ROOT_ENV]) {
    const value = settings[envName];
    if (value === undefined || value.trim() === "") {
      return {
        ok: false,
        message: `${envName} is required for the ${DESTINATION_ENV} path-tree guard (AC-21)`,
      };
    }
    if (!resolve(envName, value)) {
      return { ok: false, message: `${envName} cannot be resolved to a real path` };
    }
  }

  const pgdata = settings[PGDATA_PATH_ENV];
  if (pgdata !== undefined && pgdata.trim() !== "") {
    if (!resolve(PGDATA_PATH_ENV, pgdata)) {
      return { ok: false, message: `${PGDATA_PATH_ENV} cannot be resolved to a real path` };
    }
  } else {
    skipped.push(PGDATA_PATH_ENV);
  }

  return { ok: true, roots, skipped };
}

// ===========================================================================
// CLI（僅 `scripts/backup.sh` 使用；被測試匯入時不執行）
// ===========================================================================

export const POLICY_EXIT_OK = 0;
export const POLICY_EXIT_REJECTED = 1;
export const POLICY_EXIT_USAGE = 2;

/**
 * 設定值一律由**標準輸入**以 `KEY=VALUE` 逐行餵入（見上方檔頭之理由）。
 *
 * 空值視同未設定（與 shell 之慣用語意一致，也讓 `FOO=${FOO:-}` 這種展開不會把
 * 「沒設定」變成「設定成空字串」）。已知限制：值不得含換行——本模組吃的五個值
 * 都是路徑或整數，不會有。
 */
export function parseSettingsLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const value = trimmed.slice(eq + 1);
    if (value === "") continue;
    out[trimmed.slice(0, eq)] = value;
  }
  return out;
}

/**
 * 子命令恰兩個，輸入一律取自 `settings`，輸出一律走回傳值（不自己
 * `process.exit`，使其可被測試直接呼叫——沿 `cleanup-cli.ts` :404 之慣例）。
 *
 *   · `check-destination` → 0＝可寫；1＝被守門拒絕（`stderr` 為拒絕訊息）
 *   · `plan-retention`    → 0；`stdout` 逐行印出**應刪除之備份目錄名**（可能零行）
 */
export function runBackupPolicyCli(
  argv: readonly string[],
  settings: Readonly<Record<string, string | undefined>>
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const command = argv[0];

  const destRaw = settings[DESTINATION_ENV];
  if (destRaw === undefined || destRaw.trim() === "") {
    return {
      code: POLICY_EXIT_USAGE,
      stdout: "",
      stderr: `${DESTINATION_ENV} is required`,
    };
  }

  if (command === "check-destination") {
    const roots = collectProtectedRoots(settings);
    if (!roots.ok) {
      return { code: POLICY_EXIT_USAGE, stdout: "", stderr: roots.message };
    }
    // 保留天數之驗證刻意也在這裡：本子命令是腳本的**前置**檢查，而
    // `BACKUP_RETENTION_DAYS=13` 這種設定必須在 dump 開跑**之前**就擋下來
    // （AC-20(c) fail-fast），不能等到最後清理階段才發現。
    const retention = checkRetentionDays(settings[RETENTION_DAYS_ENV]);
    if (!retention.ok) {
      return { code: POLICY_EXIT_USAGE, stdout: "", stderr: retention.message };
    }

    const verdict = evaluateDestination({
      destination: realPathOfNearestExisting(destRaw),
      protectedRoots: roots.roots,
    });
    if (!verdict.allowed) {
      return {
        code: POLICY_EXIT_REJECTED,
        stdout: "",
        stderr: formatDestinationRejection(verdict.violations),
      };
    }
    const checked = roots.roots.map((r) => r.envName).join(",");
    const skipped = roots.skipped.length === 0 ? "none" : roots.skipped.join(",");
    return {
      code: POLICY_EXIT_OK,
      stdout: `destination-ok checked=${checked} unset-and-skipped=${skipped} retention-days=${retention.days}\n`,
      stderr: "",
    };
  }

  if (command === "plan-retention") {
    const retention = checkRetentionDays(settings[RETENTION_DAYS_ENV]);
    if (!retention.ok) {
      return { code: POLICY_EXIT_USAGE, stdout: "", stderr: retention.message };
    }
    const retentionDays = retention.days;

    const destRoot = realPathOfNearestExisting(destRaw);
    const entries: BackupEntry[] = [];
    if (fs.existsSync(destRoot)) {
      for (const dirent of fs.readdirSync(destRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const createdAtMs = parseBackupId(dirent.name);
        // 不符命名格式者一律跳過（＝不刪）：刪除工具面對未知目錄只能是「不碰」。
        if (createdAtMs === null) continue;
        entries.push({ id: dirent.name, createdAtMs });
      }
    }
    entries.sort((a, b) => b.createdAtMs - a.createdAtMs);

    const plan = planRetention({ nowMs: Date.now(), retentionDays, entries });
    return {
      code: POLICY_EXIT_OK,
      stdout: plan.remove.length === 0 ? "" : `${plan.remove.join("\n")}\n`,
      stderr: "",
    };
  }

  return {
    code: POLICY_EXIT_USAGE,
    stdout: "",
    stderr: "usage: backup-policy <check-destination|plan-retention> (settings via stdin)",
  };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("backup-policy.ts") || process.argv[1].endsWith("backup-policy.js"));

if (isMain) {
  // fd 0 ＝ 標準輸入。同步讀取：本 CLI 是一次性的判斷工具，沒有串流需求。
  const result = runBackupPolicyCli(
    process.argv.slice(2),
    parseSettingsLines(fs.readFileSync(0, "utf8"))
  );
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(`${result.stderr}\n`);
  process.exit(result.code);
}
