/**
 * PHASE-011-T14 — RUNBOOK 必載小節之機械守門（Spec AC-25）
 *
 * 涵蓋（`docs/specs/PHASE-011.md` §2 J 段 AC-25 逐字）：
 *   · AC-25(a)~(h) — `docs/RUNBOOK.md` 必須逐項載明八項必載小節，且以機械斷言
 *     確認各小節之標題在場（防「寫了但漏一節」）。
 *   · AC-25(c) — `REPORT_PDF_TIMEOUT_MS` ≤ 60 s 硬約束與「變更該 env 時須同批
 *     檢視 `VOID_TX_TIMEOUT_MS`／`VOID_TX_MAX_WAIT_MS` 二常數」（`KNOWN_ISSUES.md`
 *     O-1 逐字）。
 *   · AC-25(d) — dev 環境 `ATTACHMENT_STORAGE_ROOT`／`REPORT_STORAGE_ROOT` 常設
 *     化與「後續 session 重建 dev 環境必沿 `.env` 既有 ROOT」（`KNOWN_ISSUES.md`
 *     O-2 逐字）。
 *   · AC-25(e) — 「500 兜底不再記錄例外原文」之診斷取捨（`KNOWN_ISSUES.md`
 *     §5-11 逐字）。
 *
 * ---------------------------------------------------------------------------
 * 零 DB、零網路、零磁碟寫入
 * ---------------------------------------------------------------------------
 * 本檔只**讀取**倉庫內的 `docs/RUNBOOK.md`，所有「缺一必紅」與「逐字約束若被
 * 改寫即翻紅」之自證，皆在**記憶體字串**上以 `.split(...).join("")`／
 * `.replace(...)` 施作，不寫回磁碟——沿 `env-example-sync.test.ts`／
 * `phase10-error-handler-leak.test.ts` 之既有紀律，避免平行測試或中途失敗把
 * 被改壞的文件留在工作樹裡。收尾另有一格「磁碟原檔位元組全等」自證未污染。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 倉庫根（`backend/test/unit` → 上溯三層）。 */
const REPO_ROOT = path.resolve(__dirname, "../../..");
const RUNBOOK_PATH = path.join(REPO_ROOT, "docs/RUNBOOK.md");

const runbookRaw = fs.readFileSync(RUNBOOK_PATH, "utf8");

// ---------------------------------------------------------------------------
// AC-25(a)~(h) — 八項必載小節之標題（逐字比對；用於「缺一必紅」判定）
// ---------------------------------------------------------------------------

interface RequiredSection {
  readonly ac: string;
  readonly heading: string;
}

const REQUIRED_SECTIONS: readonly RequiredSection[] = [
  { ac: "AC-25(a)", heading: "## (a) 部署硬化" },
  { ac: "AC-25(b)", heading: "## (b) 備份與還原驗證" },
  { ac: "AC-25(c)", heading: "## (c) REPORT_PDF_TIMEOUT_MS ≤ 60 秒硬約束" },
  { ac: "AC-25(d)", heading: "## (d) dev 環境 Storage Root 常設化" },
  { ac: "AC-25(e)", heading: "## (e) 500 兜底之診斷取捨" },
  { ac: "AC-25(f)", heading: "## (f) Phase 邊界維運" },
  { ac: "AC-25(g)", heading: "## (g) 清理排程之啟用前置" },
  { ac: "AC-25(h)", heading: "## (h) 故障處置" },
];

/** 移除單一標題後的內容——mutant 自證用，純記憶體操作，不動磁碟原檔。 */
function withHeadingRemoved(content: string, heading: string): string {
  return content.split(heading).join("");
}

describe("AC-25: RUNBOOK 必載小節在場（八項逐項；缺一必紅）", () => {
  for (const { ac, heading } of REQUIRED_SECTIONS) {
    it(`${ac}: 標題「${heading}」在 docs/RUNBOOK.md 中在場`, () => {
      expect(runbookRaw).toContain(heading);
    });
  }

  it("合成陽性自證：移除任一小節標題後，僅該項轉紅、其餘七項仍在場（掃描器有牙）", () => {
    for (const target of REQUIRED_SECTIONS) {
      const mutated = withHeadingRemoved(runbookRaw, target.heading);

      // 被移除的那一項——若沿用同一組斷言重跑，這一格必翻紅。
      expect(mutated).not.toContain(target.heading);

      // 其餘七項不受影響（證明這是精準的單節缺失偵測，不是全域破壞式判定）。
      const others = REQUIRED_SECTIONS.filter((s) => s.heading !== target.heading);
      for (const other of others) {
        expect(mutated).toContain(other.heading);
      }
    }
  });

  it("八項標題互不重疊（任兩個標題字串不互為子字串），確保逐項移除之鑑別力不被稀釋", () => {
    for (const a of REQUIRED_SECTIONS) {
      for (const b of REQUIRED_SECTIONS) {
        if (a.heading === b.heading) continue;
        expect(a.heading.includes(b.heading)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 三處逐字約束（AC-25(c)／(d)／(e) 括號內指名之 O-1／O-2／§5-11）
// ---------------------------------------------------------------------------

interface RequiredLiteral {
  readonly id: string;
  readonly source: string;
  readonly literal: string;
}

const REQUIRED_LITERALS: readonly RequiredLiteral[] = [
  {
    id: "O-1",
    source: "KNOWN_ISSUES.md O-1（Spec AC-25(c) 逐字引用）",
    literal: "變更該 env 時須同批檢視 `VOID_TX_TIMEOUT_MS`／`VOID_TX_MAX_WAIT_MS` 二常數",
  },
  {
    id: "O-2",
    source: "KNOWN_ISSUES.md O-2（Spec AC-25(d) 逐字引用）",
    literal: "後續 session 重建 dev 環境必沿 `.env` 既有 ROOT",
  },
  {
    id: "§5-11",
    source: "KNOWN_ISSUES.md §5-11（Spec AC-25(e) 逐字引用）",
    literal: "「500 兜底不再記錄例外原文」",
  },
];

describe("AC-25(c)/(d)/(e): 三處逐字約束（O-1／O-2／§5-11）之字面比對", () => {
  for (const { id, source, literal } of REQUIRED_LITERALS) {
    it(`${id}: 「${literal}」逐字出現於 docs/RUNBOOK.md（來源：${source}）`, () => {
      expect(runbookRaw).toContain(literal);
    });
  }

  it("合成陽性自證：拿掉任一逐字約束後，該格比對即翻紅（純記憶體操作）", () => {
    for (const { literal } of REQUIRED_LITERALS) {
      expect(runbookRaw).toContain(literal); // 先確認今日確實在場（非恆真前提）
      const mutated = runbookRaw.split(literal).join("");
      expect(mutated).not.toContain(literal);
    }
  });
});

// ---------------------------------------------------------------------------
// 磁碟原檔零污染自證（沿 env-example-sync.test.ts 之既有紀律）
// ---------------------------------------------------------------------------

describe("零污染自證", () => {
  it("上述所有 mutant 操作皆為記憶體字串處理，磁碟原檔於本檔執行前後位元組全等", () => {
    const rereadAfter = fs.readFileSync(RUNBOOK_PATH, "utf8");
    expect(rereadAfter).toBe(runbookRaw);
  });
});
