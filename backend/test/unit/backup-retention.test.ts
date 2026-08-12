/**
 * PHASE-011-T12 — 備份保留期之純函式（`docs/specs/PHASE-011.md` **AC-20**）
 *
 * 涵蓋（AC-20 五子項逐字，Spec :351-357）：
 *   · **(a)** 保留策略以 env 參數表達（預設 14），清理邏輯為「保留最近 N 天內之
 *     全部備份，超過者才刪」；
 *   · **(b)** 邊界：恰 N 天之備份**保留**（嚴格大於才刪——與 AC-05(b)③ 同一取邊
 *     界紀律，Spec §18 對照表第 5 列明載此對齊為刻意而非巧合）；
 *   · **(c)** 保護下限：`N < 14` 之設定值須拒絕（fail-fast，訊息含變數名）；
 *   · **(d)** 零備份時不誤刪：目錄為空或僅有一份備份時，清理不得刪除任何檔案；
 *   · **(e)** 鑑別力（mutant）：把「嚴格大於」改為「大於等於」→ (b) 必紅；把下限
 *     守門移除 → (c) 必紅。
 *
 * ---------------------------------------------------------------------------
 * 本檔的斷言對象是「刪誰」，不是「有沒有刪成功」
 * ---------------------------------------------------------------------------
 * `planRetention` 對檔案系統零接觸——它收「一份備份清單 ＋ 現在時刻 ＋ 保留天
 * 數」，回一份 `{ keep, remove }`。真正的 `rm` 由 `scripts/backup.sh` 執行，而
 * 腳本**不自行判斷該刪誰**（結構斷言見 `phase11-backup-restore.test.ts`）。這條
 * 分工沿 PHASE-011-T3／T4 之「判定與執行切開」裁定：判準與刪除合寫時，「預覽看
 * 起來安全但實跑走了另一條分支」永遠可能發生。
 *
 * ---------------------------------------------------------------------------
 * mutant 之寫法（沿本專案既有形狀）
 * ---------------------------------------------------------------------------
 * 不改真實原始碼。每個 mutant 在測試內以**局部變體實作**重跑同一組 fixture，並
 * 斷言其結論與真實實作**不同**——證明上面那一格若沒有這行守門就會翻紅，即該格
 * 具備鑑別力（防恆真，Spec §11.0 #6）。
 */

import { describe, expect, it } from "vitest";
import {
  type BackupEntry,
  MIN_RETENTION_DAYS,
  RETENTION_DAYS_ENV,
  parseRetentionDays,
  planRetention,
} from "../../src/platform/backup-policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 固定「現在」：所有 fixture 以此為基準往前推，避免測試隨時鐘漂移。 */
const NOW_MS = Date.UTC(2026, 7, 12, 4, 0, 0);

/** 建一筆「距今 `ageDays` 天」之備份（`ageDays` 可為小數）。 */
function entryAged(id: string, ageDays: number): BackupEntry {
  return { id, createdAtMs: NOW_MS - Math.round(ageDays * DAY_MS) };
}

describe("PHASE-011-T12 — AC-20: 保留期", () => {
  it("(a) 保留最近 N 天內之全部備份，超過者才刪", () => {
    const entries = [
      entryAged("20260812T040000Z", 0),
      entryAged("20260805T040000Z", 7),
      entryAged("20260729T040000Z", 14 - 0.5),
      entryAged("20260722T040000Z", 20),
      entryAged("20260701T040000Z", 42),
    ];

    const plan = planRetention({ nowMs: NOW_MS, retentionDays: 14, entries });

    expect(plan.keep).toEqual(["20260812T040000Z", "20260805T040000Z", "20260729T040000Z"]);
    expect(plan.remove).toEqual(["20260722T040000Z", "20260701T040000Z"]);
  });

  it("(b) 恰 N 天之備份保留（嚴格大於才刪）", () => {
    const exactlyN = entryAged("20260729T040000Z", 14);
    const oneMsOlder: BackupEntry = {
      id: "20260729T035959Z",
      createdAtMs: exactlyN.createdAtMs - 1,
    };

    const plan = planRetention({
      nowMs: NOW_MS,
      retentionDays: 14,
      // 另附一筆最新備份，使 (d) 之「僅有一份不刪」保護不會蓋掉本格的判準
      entries: [entryAged("20260812T040000Z", 0), exactlyN, oneMsOlder],
    });

    expect(plan.keep).toContain(exactlyN.id);
    expect(plan.remove).not.toContain(exactlyN.id);
    // 差 1 ms 就過界 → 刪；證明邊界不是「差一天才算」的粗顆粒
    expect(plan.remove).toEqual([oneMsOlder.id]);
  });

  it("(d)／B-18 零份與單份備份一律不刪（含該單份已遠超保留期之情形）", () => {
    const empty = planRetention({ nowMs: NOW_MS, retentionDays: 14, entries: [] });
    expect(empty.remove).toEqual([]);
    expect(empty.keep).toEqual([]);

    const soleAndExpired = entryAged("20250101T000000Z", 365);
    const single = planRetention({
      nowMs: NOW_MS,
      retentionDays: 14,
      entries: [soleAndExpired],
    });
    expect(single.remove).toEqual([]);
    expect(single.keep).toEqual([soleAndExpired.id]);
  });

  it("(c)／B-17 `BACKUP_RETENTION_DAYS` < 14 → 拒絕，訊息含變數名且不含其他內容", () => {
    expect(MIN_RETENTION_DAYS).toBe(14);

    for (const bad of ["13", "0", "-1"]) {
      expect(() => parseRetentionDays(bad)).toThrowError(new RegExp(RETENTION_DAYS_ENV));
      expect(() => parseRetentionDays(bad)).toThrowError(/14/);
    }
    // 非整數／空值同樣拒絕（型別面），訊息一樣指名變數
    for (const bad of ["", "14.5", "abc", "1e2"]) {
      expect(() => parseRetentionDays(bad)).toThrowError(new RegExp(RETENTION_DAYS_ENV));
    }

    // 下限本身與其以上放行；未設定時取預設 14（AC-20(a) 之「預設 14」）
    expect(parseRetentionDays("14")).toBe(14);
    expect(parseRetentionDays("30")).toBe(30);
    expect(parseRetentionDays(undefined)).toBe(MIN_RETENTION_DAYS);
  });

  // =========================================================================
  // AC-20(e) — 鑑別力（兩個 mutant）
  // =========================================================================

  it("(e)① mutant：把「嚴格大於」改為「大於等於」→ 上面的 (b) 格必紅", () => {
    const exactlyN = entryAged("20260729T040000Z", 14);
    const entries = [entryAged("20260812T040000Z", 0), exactlyN];

    /** 唯一差異：`>` 改為 `>=`。其餘與真實實作同構。 */
    function planRetentionMutant(nowMs: number, retentionDays: number, list: BackupEntry[]) {
      if (list.length <= 1) return { keep: list.map((e) => e.id), remove: [] as string[] };
      const cutoff = retentionDays * DAY_MS;
      const remove = list.filter((e) => nowMs - e.createdAtMs >= cutoff).map((e) => e.id);
      return { keep: list.filter((e) => !remove.includes(e.id)).map((e) => e.id), remove };
    }

    const real = planRetention({ nowMs: NOW_MS, retentionDays: 14, entries });
    const mutant = planRetentionMutant(NOW_MS, 14, entries);

    expect(real.remove).toEqual([]);
    expect(mutant.remove).toEqual([exactlyN.id]); // ← (b) 之斷言在 mutant 下必紅
    expect(mutant.remove).not.toEqual(real.remove);
  });

  it("(e)② mutant：移除下限守門 → 上面的 (c) 格必紅", () => {
    /** 唯一差異：不檢查 `< MIN_RETENTION_DAYS`。 */
    function parseRetentionDaysMutant(raw: string | undefined): number {
      if (raw === undefined) return MIN_RETENTION_DAYS;
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`${RETENTION_DAYS_ENV} must be an integer`);
      return n;
    }

    expect(() => parseRetentionDays("13")).toThrowError();
    expect(parseRetentionDaysMutant("13")).toBe(13); // ← (c) 之斷言在 mutant 下必紅
  });
});
