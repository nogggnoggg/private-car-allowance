/**
 * PHASE-011-T12 — 備份目的地路徑樹守門之純函式（`docs/specs/PHASE-011.md`
 * **AC-21**；§16 **D12**=(a)）
 *
 * 涵蓋（AC-21 逐字，Spec :359-365）：
 *   · **(a)** 目的地之**正規化真實路徑**不得是 `ATTACHMENT_STORAGE_ROOT`／
 *     `REPORT_STORAGE_ROOT`／PostgreSQL data 目錄之**任一祖先或後裔**；
 *   · **(b)** 拒絕訊息須指出違反之項目（**含變數名、不含完整路徑值**——沿七類日
 *     誌禁字紀律之「volume 絕對路徑」一類，`DATA_FLOW.md` :565③）；
 *   · **(c)** 三格：①目的地＝storage root 之子目錄 → 必拒 ②目的地＝storage root
 *     之父目錄 → 必拒（B-15）③目的地為獨立路徑 → 必受理；
 *   · **B-16** 目的地為 symlink 而其真實路徑落於 storage 樹內 → 拒絕。
 *
 * ---------------------------------------------------------------------------
 * D12=(a) 之射程限制（本檔不得被誤讀）
 * ---------------------------------------------------------------------------
 * 本檔證明的只有「備份不落在正式資料之**路徑樹**內」。**「不同主機／不同磁碟」
 * 完全不在本檔（也不在本 Phase）的機械保證範圍內**——那來自部署時之人工設定與
 * Runbook 檢核（Spec §17.1 逐字、D12 推薦理由）。同一顆磁碟上的兩個獨立目錄會
 * 通過本檔全部斷言，這是**已知且刻意**的射程，不是缺口。
 *
 * ---------------------------------------------------------------------------
 * 純函式與 I/O 之分界
 * ---------------------------------------------------------------------------
 * `evaluateDestination` 是純比較（吃字串、吐判決）；symlink 正規化由
 * `realPathOfNearestExisting` 這唯一一個碰檔案系統的函式承擔。B-16 一格刻意把兩
 * 者串起來跑（真的建一個 symlink／Windows junction），否則「正規化」只是宣稱。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTACHMENT_ROOT_ENV,
  DESTINATION_ENV,
  type ProtectedRoot,
  REPORT_ROOT_ENV,
  evaluateDestination,
  formatDestinationRejection,
  realPathOfNearestExisting,
} from "../../src/platform/backup-policy.js";

// ---------------------------------------------------------------------------
// 臨時樹：<tmp>/{storage/att, storage/rpt, backups}
// ---------------------------------------------------------------------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "t12-destguard-"));
const ATT_ROOT = path.join(TMP_ROOT, "storage", "att");
const RPT_ROOT = path.join(TMP_ROOT, "storage", "rpt");
const INDEPENDENT_DEST = path.join(TMP_ROOT, "backups");

fs.mkdirSync(ATT_ROOT, { recursive: true });
fs.mkdirSync(RPT_ROOT, { recursive: true });
fs.mkdirSync(INDEPENDENT_DEST, { recursive: true });

const PROTECTED: readonly ProtectedRoot[] = [
  { envName: ATTACHMENT_ROOT_ENV, path: ATT_ROOT },
  { envName: REPORT_ROOT_ENV, path: RPT_ROOT },
];

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("PHASE-011-T12 — AC-21: 目的地路徑樹守門", () => {
  it("(c)① 目的地為 storage root 之子目錄 → 必拒", () => {
    const verdict = evaluateDestination({
      destination: path.join(ATT_ROOT, "nightly"),
      protectedRoots: PROTECTED,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toEqual([
      { envName: ATTACHMENT_ROOT_ENV, relation: "descendant-of-protected" },
    ]);
  });

  it("(c)②／B-15 目的地為 storage root 之父目錄 → 必拒（祖先關係）", () => {
    const verdict = evaluateDestination({
      destination: path.join(TMP_ROOT, "storage"),
      protectedRoots: PROTECTED,
    });

    expect(verdict.allowed).toBe(false);
    // 父目錄同時是**兩個**受保護根的祖先——兩筆都要列出，不得只報第一筆
    expect(verdict.violations).toEqual([
      { envName: ATTACHMENT_ROOT_ENV, relation: "ancestor-of-protected" },
      { envName: REPORT_ROOT_ENV, relation: "ancestor-of-protected" },
    ]);
  });

  it("(c)③ 目的地為獨立路徑 → 受理", () => {
    const verdict = evaluateDestination({
      destination: INDEPENDENT_DEST,
      protectedRoots: PROTECTED,
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it("(a) 目的地恰等於受保護根本身 → 必拒（同一路徑）", () => {
    const verdict = evaluateDestination({ destination: RPT_ROOT, protectedRoots: PROTECTED });

    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toEqual([{ envName: REPORT_ROOT_ENV, relation: "same-path" }]);
  });

  it("(a) 名字前綴相同但不是後裔者不得誤擋（`att` vs `att-backup`）", () => {
    const verdict = evaluateDestination({
      destination: `${ATT_ROOT}-backup`,
      protectedRoots: PROTECTED,
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it("B-16 目的地為 symlink，其真實路徑落於 storage 樹內 → 拒絕（以正規化真實路徑判定）", () => {
    const linkPath = path.join(TMP_ROOT, "looks-independent");
    const target = path.join(ATT_ROOT, "hidden-dest");
    fs.mkdirSync(target, { recursive: true });
    // Windows 上 `junction` 不需提權，且 `realpathSync` 會解析它；POSIX 用 `dir`。
    fs.symlinkSync(target, linkPath, os.platform() === "win32" ? "junction" : "dir");

    // 未正規化就比較 → 看起來獨立（這正是 B-16 想擋的假象）
    expect(evaluateDestination({ destination: linkPath, protectedRoots: PROTECTED }).allowed).toBe(
      true
    );

    // 正規化後 → 落在 att 樹內，必拒
    const verdict = evaluateDestination({
      destination: realPathOfNearestExisting(linkPath),
      protectedRoots: PROTECTED.map((r) => ({
        envName: r.envName,
        path: realPathOfNearestExisting(r.path),
      })),
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toEqual([
      { envName: ATTACHMENT_ROOT_ENV, relation: "descendant-of-protected" },
    ]);
  });

  it("尚未存在之目的地以「最近的既有祖先」正規化（備份目錄第一次執行時不存在）", () => {
    const notYetCreated = path.join(INDEPENDENT_DEST, "2026", "08", "12");
    const resolved = realPathOfNearestExisting(notYetCreated);

    expect(fs.existsSync(notYetCreated)).toBe(false);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("2026", "08", "12"))).toBe(true);
    expect(evaluateDestination({ destination: resolved, protectedRoots: PROTECTED }).allowed).toBe(
      true
    );
  });

  // =========================================================================
  // AC-21(b) — 拒絕訊息
  // =========================================================================

  it("(b) 拒絕訊息含變數名與關係，且**不含**任何完整路徑值", () => {
    const verdict = evaluateDestination({
      destination: path.join(ATT_ROOT, "nightly"),
      protectedRoots: PROTECTED,
    });
    const message = formatDestinationRejection(verdict.violations);

    expect(message).toContain(DESTINATION_ENV);
    expect(message).toContain(ATTACHMENT_ROOT_ENV);
    expect(message).toContain("descendant-of-protected");

    // 零路徑值：三個根與臨時樹本身之字面都不得出現（含 POSIX／Windows 兩種分隔符寫法）
    for (const secretish of [TMP_ROOT, ATT_ROOT, RPT_ROOT, INDEPENDENT_DEST]) {
      expect(message).not.toContain(secretish);
      expect(message).not.toContain(secretish.split(path.sep).join("/"));
    }
  });

  // =========================================================================
  // 鑑別力（mutant）——證明兩個方向的判斷都在承重
  // =========================================================================

  it("mutant：只判「後裔」而不判「祖先」→ 上面的 (c)② 格必紅", () => {
    const destination = path.join(TMP_ROOT, "storage");

    /** 唯一差異：少了 ancestor 方向。 */
    function evaluateMutant(dest: string, roots: readonly ProtectedRoot[]) {
      const norm = (p: string) => path.resolve(p).toLowerCase();
      const violations = roots.filter((r) => norm(dest).startsWith(`${norm(r.path)}${path.sep}`));
      return { allowed: violations.length === 0 };
    }

    expect(evaluateDestination({ destination, protectedRoots: PROTECTED }).allowed).toBe(false);
    expect(evaluateMutant(destination, PROTECTED).allowed).toBe(true); // ← (c)② 在 mutant 下必紅
  });

  it("mutant：以字串前綴（不看路徑分隔符）判後裔 → 上面的「att-backup」格必紅", () => {
    const destination = `${ATT_ROOT}-backup`;

    /** 唯一差異：`startsWith(root)` 而非 `startsWith(root + sep)`。 */
    function evaluateMutant(dest: string, roots: readonly ProtectedRoot[]) {
      const norm = (p: string) => path.resolve(p).toLowerCase();
      const violations = roots.filter((r) => norm(dest).startsWith(norm(r.path)));
      return { allowed: violations.length === 0 };
    }

    expect(evaluateDestination({ destination, protectedRoots: PROTECTED }).allowed).toBe(true);
    expect(evaluateMutant(destination, PROTECTED).allowed).toBe(false); // ← 誤擋，該格必紅
  });
});
