/**
 * INFRA-001-T1 — 結構性斷言（AC-18）：`backend/src/**` 不得引用測試隔離設施。
 *
 * 目的：確保新增的 `TEST_DB_ISOLATION` 環境變數與 `backend/test/setup/**`
 * 模組只被測試層讀取／import，永不洩漏進生產路徑（Spec §1.2 非目標 #6、
 * §5.1、AC-18）。比照既有結構性斷言先例
 * `frontend/test/api-no-body-mutations.test.ts` 的做法：直接掃原始碼文字，
 * 而非靠推論或型別系統。
 *
 * 鑑別力：若有人不小心在 `src/**` 任何檔案 import 了 `test/setup/*`（例如為
 * 了方便重用某個 helper）、或讀取了 `process.env.TEST_DB_ISOLATION`，本檔
 * 立刻失敗並報出違規檔案路徑。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("INFRA-001-T1 — AC-18 結構性斷言：src/** 不引用測試隔離設施", () => {
  const srcFiles = listFilesRecursive(SRC_ROOT);

  it("至少掃到一些 src 檔案（確保這個測試本身沒有因為路徑算錯而空跑）", () => {
    expect(srcFiles.length).toBeGreaterThan(10);
  });

  it("backend/src/** 沒有任何檔案引用 test/setup", () => {
    const offenders = srcFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return /test\/setup/.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it("backend/src/** 沒有任何檔案提及 TEST_DB_ISOLATION", () => {
    const offenders = srcFiles.filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return content.includes("TEST_DB_ISOLATION");
    });
    expect(offenders).toEqual([]);
  });

  it("鑑別力自證：若某檔案內容確實含有這些字樣，掃描邏輯必須抓到（證明上面兩條不是恆真）", () => {
    const fakeContent = 'import { x } from "../test/setup/db-isolation.js"; // TEST_DB_ISOLATION';
    expect(/test\/setup/.test(fakeContent)).toBe(true);
    expect(fakeContent.includes("TEST_DB_ISOLATION")).toBe(true);
  });
});
