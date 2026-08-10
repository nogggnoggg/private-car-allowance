/**
 * Structural regression test: PHASE-010-T4 — 稽核寫入站點白名單 ＋ enum 對照
 * 封閉 ＋ 標籤表涵蓋 ＋ 不可變性掃描（AC-10／AC-11）
 *
 * 涵蓋（`docs/specs/PHASE-010.md` §2）：
 *   · AC-10(a) `backend/src/**` 全域 `auditLog.create(` 站點白名單（5 檔／13
 *     呼叫；新增或移除檔案皆必紅）
 *   · AC-10(b) `AuditAction` enum 值集合封閉（`schema.prisma` 10 值）
 *   · AC-10(c) 前端稽核頁 `AUDIT_ACTION_LABELS` 標籤表涵蓋全 10 值（字面掃描；
 *     不做跨 workspace import——理由見下方「取得方式」段）＋第三份複本
 *     （`frontend/src/types/api.ts` 之 `AuditAction` union）三方一致
 *   · AC-10(d) 記載面實查：`enumLabels("AuditAction")` 既有連動 4 處 ＋
 *     `phase9-migration-safety.test.ts` (e) 一處現況核對（D8=(a) 零新增，
 *     本 Task 零機械連動義務）
 *   · AC-11(a)(b) `backend/src` 全域 `auditLog.update／updateMany／delete／
 *     deleteMany／upsert` 零命中 ＋ 掃描器鑑別力自證（三型規避探針）
 *   · 附帶（FW-9 納入）：AC-18(d) 之 `AuditChangesList.tsx` 四張值映射表
 *     （`TYPE_/FUEL_TYPE_/ROLE_/PARAMETER_TYPE_VALUE_LABELS`）非空互異守門
 *     （字面掃描）
 *
 * 本檔為純測試 Task（依賴 T2／T7 已完成）：`backend/src`／`frontend/src` 零
 * diff——全部斷言皆為唯讀之原始碼字面掃描與純函式自證，零 DB／零 server 依賴，
 * 故不使用 `describeWithDb` 之既有慣例，全套件恆跑。
 *
 * ---------------------------------------------------------------------------
 * AUDIT_ACTION_LABELS 取得方式（大總管裁定：字面掃描，非跨 workspace import）
 * ---------------------------------------------------------------------------
 * 理由：backend 測試對 frontend 原始碼之 runtime import 相依為額外耦合，且
 * backend `tsconfig.json`（`exclude: ["test"]`）使 `backend/test/**` 內任何
 * import 皆零 typecheck 覆蓋——import 進來的型別安全感是假的。改以與
 * AC-10(a) 白名單掃描同型手法之「原始碼字面字串掃描」（`extractLabelEntries`
 * 等純函式）直接解析 `.tsx`／`.ts` 原始碼文字，不執行、不 import 任何前端
 * 模組（期中複審 #2 FW 兩方案擇一之裁定）。
 *
 * ---------------------------------------------------------------------------
 * 三型規避探針（PHASE-009 T2 SF-2 教訓；沿
 * `backend/test/unit/application-state-machine.test.ts` 之 P6／P7／P8 同型
 * 設計）
 * ---------------------------------------------------------------------------
 * 單行字面掃描對「跨行呼叫」「以 bracket／computed 存取成員」兩型天然有規避
 * 面——下方 `buildAuditLogCallPattern` 之 `\s*`（天然涵蓋跨行）與 bracket
 * 分支已收斂此二型（AC-11(b) 測試以 fixture 逐一自證）。「變數間接」形式
 * （如 `const m = tx.auditLog; m.update(...)`）為靜態文字掃描之本質限制
 * （同型於 P8 教訓：「值僅在執行期決定」），本檔刻意不追求偵測——由
 * AC-11(a) 之全域零命中守門 ＋ code review 承接，非本次掃描器之修補範圍；
 * AC-11(b) 測試內以反向對照明示記載此限制。
 *
 * ---------------------------------------------------------------------------
 * AC-10(d) 記載面實查併記（FW-2／FW-4；非新增斷言義務，僅供未來維護者查閱）
 * ---------------------------------------------------------------------------
 * 除 Spec 條列之「`enumLabels("AuditAction")` 4 處 ＋ phase9(e) 1 處」共 5 處
 * 機械連動基線外，本 Task 派工期間即審實查另有 2 處未列入 Spec 該 5 處基線
 * 之 `AuditAction` 連動（`phase10-audit-completeness.test.ts`）：`:382`
 * `Record<AuditAction, number>` 之編譯期封閉宣告、`:383-392` 逐值計數表。此
 * 二處屬 T3 交付、非本 Task 射程，不另立斷言，僅於此併記供 AC-10(d) 未來
 * 複核時查閱。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "../..");
const SRC_ROOT = path.join(BACKEND_ROOT, "src");
const TEST_INTEGRATION_ROOT = path.join(BACKEND_ROOT, "test/integration");
const FRONTEND_ROOT = path.resolve(BACKEND_ROOT, "../frontend");

// ---------------------------------------------------------------------------
// 共用掃描核心（純函式：對「內容字串」操作，供真實檔案掃描與 fixture 自證
// 兩種呼叫端共用——AC-11(b) 之鑑別力自證即靠此設計做到零磁碟寫入）
// ---------------------------------------------------------------------------

/** 去除區塊註解（`/* … *\/`）與行註解（`//…`），以等長空白取代——保留所有
 * 換行字元位置，使去除註解後的內容仍可用「換行數」精確還原行號（沿
 * `application-state-machine.test.ts` 之既有 `stripComments` 同型設計）。 */
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

/** 建立「`auditLog.<method>(`」形式（涵蓋跨行、與 bracket／computed 存取兩型
 * 規避探針）之比對 pattern；`\s*` 天然涵蓋跨行寫法。 */
function buildAuditLogCallPattern(methods: readonly string[]): RegExp {
  const alt = methods.join("|");
  return new RegExp(
    `\\bauditLog\\s*(?:\\.\\s*(?:${alt})|\\[\\s*["'](?:${alt})["']\\s*\\])\\s*\\(`,
    "g"
  );
}

/** 對單一內容字串掃描，回傳每個命中之行號（已去除註解／JSDoc，已排除跨行
 * 盲點）。 */
function scanContentForAuditLogCalls(content: string, methods: readonly string[]): number[] {
  const cleaned = stripComments(content);
  const pattern = buildAuditLogCallPattern(methods);
  const lines: number[] = [];
  let match: RegExpExecArray | null = pattern.exec(cleaned);
  while (match !== null) {
    lines.push(cleaned.slice(0, match.index).split("\n").length);
    match = pattern.exec(cleaned);
  }
  return lines;
}

/** 掃描 `root` 下所有 `.ts` 檔（排除 `.test.ts`），回傳「相對路徑（`/` 分隔）
 * → 命中行號陣列」之 Map（零命中之檔案不入 Map，故 Map 之鍵集合即「檔案集
 * 合」）。 */
function scanDirForAuditLogCalls(root: string, methods: readonly string[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const file of listTsFilesRecursive(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const content = fs.readFileSync(file, "utf8");
    const lines = scanContentForAuditLogCalls(content, methods);
    if (lines.length > 0) result.set(rel, lines);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 前端原始碼字面掃描（AC-10(c)／AC-18(d)；不 import，見檔頭「取得方式」段）
// ---------------------------------------------------------------------------

/** 擷取 `export const NAME: Record<...> = { KEY: "value", ... };` 形式之鍵值
 * 對（保留原始出現順序；已去除註解）。 */
function extractLabelEntries(content: string, constName: string): Array<[string, string]> {
  const blockRe = new RegExp(`export const ${constName}:[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`);
  const blockMatch = content.match(blockRe);
  if (!blockMatch) {
    throw new Error(`${constName} 區塊未於原始碼中找到——字面掃描比對式可能已隨改版過期`);
  }
  const cleaned = stripComments(blockMatch[1]);
  const entries: Array<[string, string]> = [];
  for (const m of cleaned.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*"((?:[^"\\]|\\.)*)"/gm)) {
    entries.push([m[1], m[2]]);
  }
  return entries;
}

/** 擷取 `export type NAME = | "A" | "B" | ...;` 形式之字面成員（已排序）。 */
function extractUnionTypeMembers(content: string, typeName: string): string[] {
  const typeRe = new RegExp(`export type ${typeName} =([\\s\\S]*?);`);
  const typeMatch = content.match(typeRe);
  if (!typeMatch) {
    throw new Error(`type ${typeName} 未於原始碼中找到——字面掃描比對式可能已隨改版過期`);
  }
  const cleaned = stripComments(typeMatch[1]);
  return [...cleaned.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]).sort();
}

/** 擷取 `enum NAME { ... }`（`schema.prisma`）之成員（已排序）。 */
function extractPrismaEnumMembers(schemaContent: string, enumName: string): string[] {
  const enumRe = new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\}`);
  const enumMatch = schemaContent.match(enumRe);
  if (!enumMatch) {
    throw new Error(`enum ${enumName} 未於 schema.prisma 中找到`);
  }
  return enumMatch[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------
// 基線常數（實查依據見 Packet「結構性引用實查」段；與 Spec §2 AC-10/AC-11
// 原文逐字相符——實查若與 Spec 基線不符，須據實以實查為準並於 Handoff 列差
// 異，本次實查相符，見 Handoff）
// ---------------------------------------------------------------------------

/** AC-10(b) 基線：`schema.prisma` :30-41 之 `AuditAction` enum 10 值（已排
 * 序）。 */
const AUDIT_ACTION_BASELINE = [
  "APPLICATION_CREATED_ON_BEHALF",
  "APPLICATION_UPDATED_ON_BEHALF",
  "APPLICATION_VOIDED",
  "PARAMETER_VERSION_CREATED",
  "USER_ACTIVATED",
  "USER_CREATED",
  "USER_DEACTIVATED",
  "USER_DELETED",
  "USER_FUEL_CONSUMPTION_VERSION_CREATED",
  "USER_PASSWORD_RESET",
].sort();

/** AC-10(a) 基線：5 檔／13 呼叫（Spec §2 AC-10(a) 逐字）。 */
const AUDIT_CREATE_SITE_BASELINE: Record<string, number> = {
  "admin/routes.ts": 3,
  "applications/routes.ts": 5,
  "audit/audit.ts": 1,
  "parameters/routes.ts": 3,
  "users/fuel-consumption-routes.ts": 1,
};

/** AC-11(a) 掃描之方法白名單（Spec §2 AC-11(a) 逐字）。 */
const AUDIT_LOG_MUTATION_METHODS = [
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
] as const;

// ---------------------------------------------------------------------------
// 讀入一次的原始碼內容（純讀取，零寫入）
// ---------------------------------------------------------------------------

const schemaPrismaContent = fs.readFileSync(
  path.join(BACKEND_ROOT, "prisma/schema.prisma"),
  "utf8"
);
const auditLogPageContent = fs.readFileSync(
  path.join(FRONTEND_ROOT, "src/pages/AuditLogPage.tsx"),
  "utf8"
);
const apiTypesContent = fs.readFileSync(path.join(FRONTEND_ROOT, "src/types/api.ts"), "utf8");
const auditChangesListContent = fs.readFileSync(
  path.join(FRONTEND_ROOT, "src/components/AuditChangesList.tsx"),
  "utf8"
);

// ===========================================================================
// AC-10 — 稽核寫入站點白名單掃描 ＋ enum 對照封閉
// ===========================================================================

describe("PHASE-010-T4 — AC-10: 稽核寫入站點白名單掃描 ＋ enum 對照封閉", () => {
  it("至少掃到一些 src 檔案（確保本測試沒有因路徑算錯而空跑）", () => {
    expect(listTsFilesRecursive(SRC_ROOT).length).toBeGreaterThan(10);
  });

  it("AC-10(a): backend/src 全域 auditLog.create( 站點白名單 — 恰 5 檔／13 呼叫，逐檔次數符合基線；新增或移除檔案皆必紅", () => {
    const hits = scanDirForAuditLogCalls(SRC_ROOT, ["create"]);
    const perFileCounts = Object.fromEntries(
      [...hits.entries()].map(([file, lines]) => [file, lines.length])
    );
    expect(perFileCounts).toEqual(AUDIT_CREATE_SITE_BASELINE);
    const totalCalls = [...hits.values()].reduce((sum, lines) => sum + lines.length, 0);
    expect(totalCalls).toBe(13);
  });

  it("AC-10(a) FW-1: fuel-consumption-routes.ts 之 auditLog.create( 恰 1 處（:242），:203 註解內同字面不誤判為第 2 處", () => {
    const content = fs.readFileSync(
      path.join(SRC_ROOT, "users/fuel-consumption-routes.ts"),
      "utf8"
    );
    // 正向對照：註解剝除前該檔確實含兩處字面（真實命中 ＋ 註解內誤導字面）。
    expect((content.match(/auditLog\.create\(/g) ?? []).length).toBe(2);
    // 註解剝除後，掃描器僅回報真實命中之單一行號。
    expect(scanContentForAuditLogCalls(content, ["create"])).toEqual([242]);
  });

  it("AC-10(a) FW-3／FW-6: 掃描射程嚴格限 backend/src — audit/routes.ts 雖同目錄但零 auditLog.create( 命中，不誤入白名單", () => {
    const hits = scanDirForAuditLogCalls(SRC_ROOT, ["create"]);
    expect(hits.has("audit/routes.ts")).toBe(false);
    const content = fs.readFileSync(path.join(SRC_ROOT, "audit/routes.ts"), "utf8");
    expect(scanContentForAuditLogCalls(content, ["create"])).toEqual([]);
  });

  it("AC-10(b): AuditAction enum 值集合恰等於基線 10 值（schema.prisma :30-41）；新增值必紅", () => {
    const members = extractPrismaEnumMembers(schemaPrismaContent, "AuditAction");
    expect(members).toEqual(AUDIT_ACTION_BASELINE);
    // 正向對照：確實抓到十個成員（非因正則失配而空陣列恆真）。
    expect(members.length).toBe(10);
  });

  it("AC-10(c): AUDIT_ACTION_LABELS 鍵集合（字面掃描）⊇ AuditAction 10 值封閉，值全部非空且互異；漏一值必紅", () => {
    const entries = extractLabelEntries(auditLogPageContent, "AUDIT_ACTION_LABELS");
    const keys = entries.map(([k]) => k).sort();
    expect(keys).toEqual(AUDIT_ACTION_BASELINE);
    const values = entries.map(([, v]) => v);
    // FW-7（期中 #2 FW＋FE 複審 FW 標籤斷言強化）：值非空且互異，非僅鍵集涵蓋。
    expect(values.every((v) => v.length > 0)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it("AC-10(c) 鑑別力自證: AUDIT_ACTION_LABELS 標籤表刪一值必紅（字面掃描側，in-memory 突變，零磁碟寫入）", () => {
    const entries = extractLabelEntries(auditLogPageContent, "AUDIT_ACTION_LABELS");
    const [victimKey, victimValue] = entries[0];
    const victimLine = `${victimKey}: "${victimValue}",`;
    expect(auditLogPageContent).toContain(victimLine); // 正向對照：突變目標確實在場
    const mutated = auditLogPageContent.replace(victimLine, "");
    expect(mutated).not.toEqual(auditLogPageContent); // 正向對照：突變確實生效

    const mutatedKeys = extractLabelEntries(mutated, "AUDIT_ACTION_LABELS")
      .map(([k]) => k)
      .sort();
    expect(mutatedKeys).not.toEqual(AUDIT_ACTION_BASELINE);
    expect(mutatedKeys).not.toContain(victimKey);
    expect(mutatedKeys.length).toBe(9);
  });

  it("AC-10(c) 第三份複本: frontend/src/types/api.ts 之 AuditAction union 字面亦恰為基線 10 值（schema↔前端型別↔標籤表三方一致，FW-9）", () => {
    const members = extractUnionTypeMembers(apiTypesContent, "AuditAction");
    expect(members).toEqual(AUDIT_ACTION_BASELINE);
  });

  it('AC-10(d) 記載面實查: enumLabels("AuditAction") 閉集斷言基線 4 處 ＋ phase9(e) 一處聯集全等現況核對（D8=(a) 零新增，本 Task 零機械連動義務）', () => {
    const migrationSafetyFiles = [
      "phase6-migration-safety.test.ts",
      "phase7-migration-safety.test.ts",
      "phase8-migration-safety.test.ts",
    ];
    let enumLabelsCallCount = 0;
    for (const file of migrationSafetyFiles) {
      const content = fs.readFileSync(path.join(TEST_INTEGRATION_ROOT, file), "utf8");
      enumLabelsCallCount += (content.match(/enumLabels\("AuditAction"\)/g) ?? []).length;
    }
    expect(enumLabelsCallCount).toBe(4);
    const phase9Content = fs.readFileSync(
      path.join(TEST_INTEGRATION_ROOT, "phase9-migration-safety.test.ts"),
      "utf8"
    );
    expect(phase9Content).toMatch(/AC-01\(e\): AuditAction 恰新增 APPLICATION_VOIDED/);
  });

  it("AC-18(d) 附加（FW-9 納入）: AuditChangesList.tsx 四張值映射表逐表值非空且互異（字面掃描）", () => {
    const tableNames = [
      "TYPE_VALUE_LABELS",
      "FUEL_TYPE_VALUE_LABELS",
      "ROLE_VALUE_LABELS",
      "PARAMETER_TYPE_VALUE_LABELS",
    ];
    for (const tableName of tableNames) {
      const entries = extractLabelEntries(auditChangesListContent, tableName);
      // 正向對照：表確實非空（非因正則失配而空陣列恆真通過）。
      expect(entries.length).toBeGreaterThan(0);
      const values = entries.map(([, v]) => v);
      expect(values.every((v) => v.length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

// ===========================================================================
// AC-11 — 稽核不可變性結構守門
// ===========================================================================

describe("PHASE-010-T4 — AC-11: 稽核不可變性結構守門", () => {
  it("AC-11(a): backend/src 全域 auditLog.update／updateMany／delete／deleteMany／upsert 零命中", () => {
    const hits = scanDirForAuditLogCalls(SRC_ROOT, AUDIT_LOG_MUTATION_METHODS);
    expect([...hits.entries()]).toEqual([]);
  });

  it("AC-11(a) 附加負控制: history.ts 之 .auditLog.count( 為合法讀取，正確不落入零命中守門射程（FW-1／FW-3）", () => {
    const content = fs.readFileSync(path.join(SRC_ROOT, "users/history.ts"), "utf8");
    expect(content).toMatch(/\.auditLog\.count\(/); // 正向對照：count( 確實在場
    expect(scanContentForAuditLogCalls(content, AUDIT_LOG_MUTATION_METHODS)).toEqual([]);
  });

  it("AC-11(b): 掃描器鑑別力自證 — 直接呼叫／跨行呼叫／bracket 存取三型皆必紅命中；行註解／JSDoc 零誤判；變數間接為已知靜態掃描限制（不誤稱已覆蓋）", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac11b-fixture-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "nested"), { recursive: true });
      fs.writeFileSync(
        path.join(fixtureRoot, "nested", "probe.ts"),
        [
          'await tx.auditLog.update({ where: { id: "x" } }); // 直接呼叫',
          "await tx.auditLog",
          '  .delete({ where: { id: "y" } }); // 跨行呼叫（SF-2, P7 類比）',
          'await tx.auditLog["upsert"]({ where: { id: "z" }, create: {}, update: {} }); // bracket 存取（SF-2, P6 類比）',
          "// await tx.auditLog.updateMany({}); — 行註解內，不應被抓到",
          "/**",
          " * auditLog.deleteMany({}) — JSDoc 內，不應被抓到",
          " */",
          "const auditModel = tx.auditLog;",
          "await auditModel.update({ where: { id: 'w' } }); // 變數間接（SF-2, P8 類比）— 靜態掃描本質限制，刻意不被抓到",
        ].join("\n")
      );

      const hits = scanDirForAuditLogCalls(fixtureRoot, AUDIT_LOG_MUTATION_METHODS);
      const flatHits = [...hits.entries()]
        .flatMap(([file, lines]) => lines.map((l) => `${file}:${l}`))
        .sort();

      // 三型皆被真實呼叫待測函式（非手造陣列比對）抓到：直接呼叫（行 1）／
      // 跨行呼叫（行 2，match 起點在 `auditLog` 字面處）／bracket 存取（行 4）。
      expect(flatHits).toEqual(["nested/probe.ts:1", "nested/probe.ts:2", "nested/probe.ts:4"]);

      // 反向對照：變數間接形式（第 10 行 `auditModel.update(`）未被計入——這是
      // 靜態文字掃描的本質限制（PHASE-009 T2 SF-2 之 P8 教訓同型），非本次
      // 掃描器修補範圍；此限制由 AC-11(a) 之全域零命中守門 ＋ code review 承
      // 接，記於 Handoff Known Issues。
      expect(flatHits.length).toBe(3);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("AC-11(c) 記載: 本 Task 為純測試守門，本檔以外之 backend/src 讀取皆唯讀（fs.readFileSync），零 fs.writeFileSync／fs.appendFileSync 命中真實 src 路徑", () => {
    const selfContent = fs.readFileSync(
      path.join(TEST_INTEGRATION_ROOT, "phase10-audit-structure.test.ts"),
      "utf8"
    );
    // 本檔內唯一的 fs.writeFileSync／fs.mkdirSync／fs.rmSync 命中皆落於
    // AC-11(b) 之 os.tmpdir() fixture（非 backend/src／frontend/src），下列
    // 正則核對「寫入類 fs API 呼叫」之路徑引數皆不含 SRC_ROOT／FRONTEND_ROOT
    // 變數字面（即皆為 fixtureRoot 或 tmpdir 路徑）。
    const writeCalls = [
      ...selfContent.matchAll(/fs\.(writeFileSync|appendFileSync|mkdirSync|rmSync)\(\s*([^,)]+)/g),
    ];
    expect(writeCalls.length).toBeGreaterThan(0); // 正向對照：確實有寫入呼叫（fixture 建置）
    for (const [, , firstArg] of writeCalls) {
      expect(firstArg).not.toMatch(/SRC_ROOT|FRONTEND_ROOT|BACKEND_ROOT/);
    }
  });
});
