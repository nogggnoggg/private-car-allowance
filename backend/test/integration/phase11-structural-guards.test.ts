/**
 * PHASE-011-T17 — 結構守門批次（AC-29(d)／D16-1／D-10）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-011.md`，逐字引用）
 * ---------------------------------------------------------------------------
 * AC-29(d)（:437）：「**errorLabel 反退化守門格**（D-10）：全 `backend/src` 之
 *   `function errorLabel` 定義**恰一處**之結構性掃描；**mutant**：於他檔新增
 *   一份私有 `errorLabel` → 必紅。沿 `phase9-void-report.test.ts` §D-0 之同型
 *   形狀。」
 *
 * `KNOWN_ISSUES.md` :55 D-10：「`platform/error-label.ts` 為單一葉節點
 *   （PHASE-010-T10／AC-22(b) 收斂），但**無任何斷言**阻止日後有人在他檔再寫
 *   一份私有 `function errorLabel`——退化不會使測試變紅。」
 *
 * ---------------------------------------------------------------------------
 * 掃描器之涵蓋面 — 據實敘述，不過度宣稱
 * ---------------------------------------------------------------------------
 * 本掃描為 source-regex 型（比對 `function errorLabel(` 之文字形狀），與
 * `phase9-void-report.test.ts` §D-0 之既有結構掃描同型。**本格擋得住的是
 * 「他檔以具名 `function` 語法再寫一份」**這一今日慣用寫法，不是任何可能繞
 * 法——例如以 `const errorLabel = (err) => …` 箭頭函式、動態組字（如
 * `globalThis["errorLabel"] = …`）或改名後再 re-export 之寫法可繞過本掃描
 * （`phase11-env-secrets.test.ts` §32-40「掃描器之涵蓋面」＋ T5 AR-1 已實證
 * 之同族繞法）。本格僅為**慣用寫法之反退化守門**，非全繞法證明。
 *
 * ---------------------------------------------------------------------------
 * TDD 紅燈實錄
 * ---------------------------------------------------------------------------
 * 先以「合成第二定義」之 mutant 案例驗證掃描器邏輯本身具鑑別力（若邏輯有誤、
 * 恆回報 1 筆，mutant 案例會先失敗於「不等於 2」）；確認 mutant 案例綠燈
 * （掃描器正確回報 2 筆）後，才回頭確認真實 `backend/src` 目前恰一處（1 筆，
 * 即 `platform/error-label.ts`）。兩者皆綠即完整覆蓋本 AC 之正負兩面。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC_DIR = path.resolve(__dirname, "../../src");

type SourceFile = { readonly relPath: string; readonly content: string };

/** 遞迴列出 `dir` 之下所有 `.ts` 檔（相對 `BACKEND_SRC_DIR` 之相對路徑）。 */
function listSrcFiles(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSrcFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push({
        relPath: path.relative(BACKEND_SRC_DIR, full).split(path.sep).join("/"),
        content: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

/** 具名 `function errorLabel(` 定義之逐檔命中數（不含 `.` 存取或呼叫端 `errorLabel(err)`）。 */
const ERROR_LABEL_DEF_RE = /\bfunction\s+errorLabel\s*\(/g;

type ErrorLabelHit = { readonly relPath: string; readonly count: number };

function scanErrorLabelDefinitions(files: readonly SourceFile[]): ErrorLabelHit[] {
  const hits: ErrorLabelHit[] = [];
  for (const file of files) {
    const matches = file.content.match(ERROR_LABEL_DEF_RE);
    if (matches && matches.length > 0) {
      hits.push({ relPath: file.relPath, count: matches.length });
    }
  }
  return hits;
}

function totalDefCount(hits: readonly ErrorLabelHit[]): number {
  return hits.reduce((sum, h) => sum + h.count, 0);
}

describe("PHASE-011-T17 §D-10 — errorLabel 反退化守門格（AC-29(d)）", () => {
  it("mutant（先紅驗證）：他檔新增一份私有 errorLabel → 掃描器回報恰 2 筆定義（正確偵測，非恆真 1）", () => {
    const real = listSrcFiles(BACKEND_SRC_DIR);
    const mutantFile: SourceFile = {
      relPath: "attachment/mutant-private-error-label.ts",
      content: [
        "// 合成 mutant：他檔再寫一份私有 errorLabel（測試內合成字串，不改真實檔）。",
        "function errorLabel(err: unknown): string {",
        '  return err instanceof Error ? err.constructor.name : "UnknownError";',
        "}",
        "",
        "export { errorLabel as duplicatedErrorLabel };",
      ].join("\n"),
    };
    const hits = scanErrorLabelDefinitions([...real, mutantFile]);
    expect(totalDefCount(hits)).toBe(2);
    const mutantHit = hits.find((h) => h.relPath === mutantFile.relPath);
    expect(mutantHit?.count).toBe(1);
  });

  it("真實 backend/src：function errorLabel 定義恰一處（platform/error-label.ts），多一處或少一處必紅", () => {
    const hits = scanErrorLabelDefinitions(listSrcFiles(BACKEND_SRC_DIR));
    expect(totalDefCount(hits)).toBe(1);
    expect(hits).toEqual([{ relPath: "platform/error-label.ts", count: 1 }]);
  });

  it("涵蓋自證：掃描器實際走訪之檔案數與 fs 直接遞迴計數一致（防射程窄化）", () => {
    function countTsFiles(dir: string): number {
      let n = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) n += countTsFiles(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) n += 1;
      }
      return n;
    }
    expect(listSrcFiles(BACKEND_SRC_DIR).length).toBe(countTsFiles(BACKEND_SRC_DIR));
    expect(listSrcFiles(BACKEND_SRC_DIR).length).toBeGreaterThan(0);
  });
});
