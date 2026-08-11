/**
 * PHASE-011-T2 — E2E 共享參數軸播種日單調性機械守門格（AC-02，依 §16 D2=(a)）
 *
 * ---------------------------------------------------------------------------
 * D2=(a)：本檔刻意讀 workspace 外之 `e2e/`（理由與射程）
 * ---------------------------------------------------------------------------
 * `e2e/` 屬 root workspace（非 `backend`／`frontend`），本檔以 Node 內建
 * `fs`／`path` 直讀 `../../../e2e/*.spec.ts`（相對 `backend/test/unit`），
 * 沿既有掃描器形狀（`phase10-error-handler-leak.test.ts` 掃 `backend/src`）
 * 僅改讀取根目錄之 `e2e/`。零新增依賴、零新增 CI 步驟、零 DB／瀏覽器依賴，
 * 隨 `npm run test --workspace=backend` 自動執行（見 Spec §16 D2 選項 (a)）。
 * `e2e/` 若整批搬移路徑會導致本檔紅燈——此為刻意行為（見下方涵蓋自證）。
 *
 * ---------------------------------------------------------------------------
 * 涵蓋（AC-02 六子項逐字，`docs/specs/PHASE-011.md` :190-197）
 * ---------------------------------------------------------------------------
 *   (a) 掃描 `e2e/**\/*.spec.ts` 之全部參數版本播種日字面（油價
 *       `FuelPriceVersion.effectiveFrom`、ETC、折舊、使用者油耗），對每一條
 *       共享時間軸（以「參數類別（＋油種）」為鍵）建立播種日全序清單。
 *   (b) 下界不變式（硬）：任一播種日不得 ≤ `1999-05-05`（＝
 *       `travel-application.spec.ts` :62 `NO_PARAM_TRIP_DATE`）。
 *   (c) 哨兵不變式：`audit-log.spec.ts` 之 `FUEL_PRICE_EFFECTIVE_FROM`
 *       （`fuelPrice:DIESEL` 軸）須嚴格早於同軸其他任一檔之播種日。
 *   (d) 鑑別力自證（三型 mutant，測試內合成字串，不改真實檔）。
 *   (e) 掃描器之涵蓋自證：全 `e2e/` 現行檔案清單 ＝ 掃描器實際解析到的清單。
 *   (f) 錯誤訊息逐字含修法指引。
 *
 * ---------------------------------------------------------------------------
 * 擷取器設計與誠實已知限制（沿本專案既有掃描器「據實記載」慣例）
 * ---------------------------------------------------------------------------
 * 本檔不做完整 TS/AST 解析，改以「已知端點 ＋ 已知 UI 選取器前綴 ＋ 一層常數
 * 別名鏈 ＋ 一層函式參數→呼叫端引數回溯」之機械規則，涵蓋現行 13 個 e2e 檔
 * 之全部播種寫法（已逐檔實查）：
 *   ① `page.request.post(...)` 打 4 個已知端點（`/parameters/fuel-price`／
 *      `/parameters/etc`／`/parameters/depreciation`／`/fuel-consumption`），
 *      自其 `data: {...}` 物件字面擷取 `effectiveFrom`／`fuelType`（冒號式或
 *      簡寫式皆支援）。
 *   ② `fuel-model.spec.ts` 情境1 之 UI 表單填寫（`#fuel-effectiveFrom`／
 *      `#fuel-fuelType`、`#fc-effectiveFrom`／`#fc-fuelType`）另立一組比對式；
 *      其中情境1 之 `fuelType` 來自 `for (const [fuelType, price] of
 *      Object.entries(FUEL_PRICE_BY_TYPE))` 迴圈鍵變數——本檔識別此唯一迴圈
 *      型樣，展開為該 Record 之全部鍵（各自一條軸）。
 *   ③ 識別字解析：先查是否為模組層 `const NAME = "字面"` 或 `const NAME =
 *      OTHER_NAME`（鏈式別名，遞迴解析）；查無則查是否為「當前程式位置所在
 *      函式」之參數名——若是，掃描該函式在檔內之呼叫處，取同位引數（僅解析
 *      引數本身為字面或可鏈式解析之識別字；引數為函式呼叫或運算式者視為
 *      「動態」而略過，因 AC-02(a) 之射程限定「播種日字面」）。一次函式參數
 *      回溯已足以涵蓋現行全部 13 檔（已逐檔核對）。
 *   ④ 已知不可及（誠實記載，非本 Task 射程）：任意巢狀／型別解構之參數位、
 *      非本檔識別之其他迴圈型樣、跨兩層以上之參數轉呼叫鏈。今日全 e2e/ 無此
 *      用法（逐檔核對），新增此類寫法若同時引入危險播種日，本掃描器可能
 *      漏報——與既有 `phase10-error-handler-leak.test.ts` L2「保守超集,非
 *      不可漏報」之誠實表述同調。
 *
 * ---------------------------------------------------------------------------
 * 真實檔案逐檔核對結果（實作前人工核對，記入 Handoff）
 * ---------------------------------------------------------------------------
 * 全 13 檔之參數播種日字面經人工逐檔核對，現行最早值為 `audit-log.spec.ts`
 * 之哨兵 `2010-01-01`（`fuelPrice:DIESEL` 軸），其餘全數 ≥ `2020-01-01`；
 * 零筆 ≤ `1999-05-05`。故本檔之「真實掃描」測試組（AC-02(b)(c)）預期為
 * 綠燈——若非如此即代表現行 e2e 檔違規（見 Packet Stop Condition (c)）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.join(__dirname, "../../../e2e");

// ---------------------------------------------------------------------------
// 不變式常數
// ---------------------------------------------------------------------------

/** AC-02(b)：下界（硬）。＝ `travel-application.spec.ts` :62
 * `NO_PARAM_TRIP_DATE`——不得再往前調（見該檔 :38-39 之全 e2e/ 共同不變式）。 */
const LOWER_BOUND = "1999-05-05";

/** AC-02(c)：哨兵播種者宣告（現行恰一）。 */
const SENTINEL = {
  file: "audit-log.spec.ts",
  axis: "fuelPrice:DIESEL",
  constName: "FUEL_PRICE_EFFECTIVE_FROM",
} as const;

/** AC-02(f)：修法指引逐字（守門錯誤訊息須包含）。 */
const FIX_GUIDANCE = "請改用晚於哨兵日之播種日，或於本守門之軸註冊表新增一條軸並說明";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 通用文字工具（stripComments 沿 phase10-error-handler-leak.test.ts 同型，
// 刻意複製而非 import，沿既有慣例）
// ---------------------------------------------------------------------------

function stripComments(content: string): string {
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** 取 `braceIdx`（指向 `{`）起之平衡大括號子字串。 */
function extractBalancedObjectAfter(
  content: string,
  braceIdx: number
): { text: string; startIdx: number; endIdx: number } | null {
  let depth = 0;
  for (let i = braceIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0)
        return { text: content.slice(braceIdx, i + 1), startIdx: braceIdx, endIdx: i };
    }
  }
  return null;
}

/** 依頂層逗號切分引數文字（忽略括號／字串內之逗號）。 */
function splitTopLevelArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === inString && text[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args.map((a) => a.trim());
}

// ---------------------------------------------------------------------------
// 模組層常數別名鏈
// ---------------------------------------------------------------------------

const CONST_DECL_RE =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\s*;/g;

interface ConstEntry {
  rhs: string;
  isLiteral: boolean;
}

function parseConsts(content: string): Map<string, ConstEntry> {
  const map = new Map<string, ConstEntry>();
  const re = new RegExp(CONST_DECL_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const name = m[1];
    const rhsRaw = m[2];
    const isLiteral = rhsRaw.startsWith('"');
    const rhs = isLiteral ? rhsRaw.slice(1, -1) : rhsRaw;
    if (!map.has(name)) map.set(name, { rhs, isLiteral });
    m = re.exec(content);
  }
  return map;
}

function resolveConstChain(
  name: string,
  consts: Map<string, ConstEntry>,
  seen: Set<string> = new Set()
): string | null {
  if (seen.has(name)) return null;
  seen.add(name);
  const entry = consts.get(name);
  if (!entry) return null;
  if (entry.isLiteral) return entry.rhs;
  return resolveConstChain(entry.rhs, consts, seen);
}

// ---------------------------------------------------------------------------
// 函式定義（參數列 ＋ 本體行範圍）與呼叫處引數擷取
// ---------------------------------------------------------------------------

const FUNC_DECL_RE = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;

interface FuncInfo {
  name: string;
  params: string[];
  declLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
}

function parseFunctions(content: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const re = new RegExp(FUNC_DECL_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const name = m[1];
    const params = m[2]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split(":")[0].trim());
    const declLine = lineOf(content, m.index);
    const openBraceIdx = content.indexOf("{", m.index + m[0].length);
    if (openBraceIdx !== -1) {
      const obj = extractBalancedObjectAfter(content, openBraceIdx);
      if (obj) {
        funcs.push({
          name,
          params,
          declLine,
          bodyStartLine: lineOf(content, obj.startIdx),
          bodyEndLine: lineOf(content, obj.endIdx),
        });
      }
    }
    m = re.exec(content);
  }
  return funcs;
}

/** 掃描 `funcName` 於檔內之全部呼叫處（排除宣告本身那一行），回傳各呼叫之
 * 引數文字陣列（依頂層逗號切分）。 */
function findCallSites(content: string, funcName: string, declLine: number): string[][] {
  const callRe = new RegExp(`\\b${funcName}\\s*\\(`, "g");
  const results: string[][] = [];
  let m: RegExpExecArray | null = callRe.exec(content);
  while (m !== null) {
    const line = lineOf(content, m.index);
    if (line !== declLine) {
      const openIdx = m.index + m[0].length - 1;
      let depth = 0;
      let endIdx = -1;
      for (let i = openIdx; i < content.length; i++) {
        if (content[i] === "(") depth++;
        else if (content[i] === ")") {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (endIdx !== -1) {
        results.push(splitTopLevelArgs(content.slice(openIdx + 1, endIdx)));
      }
    }
    m = callRe.exec(content);
  }
  return results;
}

// ---------------------------------------------------------------------------
// `for (const [K, V] of Object.entries(RECORD))` 迴圈（唯一支援之迴圈型樣，
// `fuel-model.spec.ts` 情境1 專用形狀）
// ---------------------------------------------------------------------------

const FOR_OF_ENTRIES_RE =
  /for\s*\(\s*const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s+of\s+Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;

interface ForLoopInfo {
  keyVar: string;
  recordName: string;
  bodyStartLine: number;
  bodyEndLine: number;
}

function parseForOfEntriesLoops(content: string): ForLoopInfo[] {
  const loops: ForLoopInfo[] = [];
  const re = new RegExp(FOR_OF_ENTRIES_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const openBraceIdx = content.indexOf("{", m.index + m[0].length);
    if (openBraceIdx !== -1) {
      const obj = extractBalancedObjectAfter(content, openBraceIdx);
      if (obj) {
        loops.push({
          keyVar: m[1],
          recordName: m[3],
          bodyStartLine: lineOf(content, obj.startIdx),
          bodyEndLine: lineOf(content, obj.endIdx),
        });
      }
    }
    m = re.exec(content);
  }
  return loops;
}

/** 擷取 `const NAME: Record<...> = { KEY: "值", ... };` 之全部鍵。 */
function extractRecordKeys(content: string, recordName: string): string[] {
  const declRe = new RegExp(`\\bconst\\s+${recordName}\\s*:\\s*Record<[^>]*>\\s*=\\s*\\{`);
  const m = declRe.exec(content);
  if (!m) return [];
  const openIdx = content.indexOf("{", m.index);
  const obj = extractBalancedObjectAfter(content, openIdx);
  if (!obj) return [];
  const keys: string[] = [];
  const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
  let km: RegExpExecArray | null = keyRe.exec(obj.text);
  while (km !== null) {
    keys.push(km[1]);
    km = keyRe.exec(obj.text);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// 識別字解析（常數別名鏈 → 函式參數一層回溯 → for-of Object.entries 迴圈鍵）
// ---------------------------------------------------------------------------

interface FileModel {
  content: string;
  consts: Map<string, ConstEntry>;
  functions: FuncInfo[];
  forLoops: ForLoopInfo[];
}

function buildFileModel(content: string): FileModel {
  return {
    content,
    consts: parseConsts(content),
    functions: parseFunctions(content),
    forLoops: parseForOfEntriesLoops(content),
  };
}

/** 解析識別字 `ident`（於 `line` 所在位置）為可能之字面值集合（去重）。
 * 無法解析（動態運算式／超出射程之型樣）回傳空陣列。 */
function resolveAt(model: FileModel, ident: string, line: number, depth = 0): string[] {
  if (depth > 4) return [];

  for (const loop of model.forLoops) {
    if (loop.keyVar === ident && line >= loop.bodyStartLine && line <= loop.bodyEndLine) {
      return extractRecordKeys(model.content, loop.recordName);
    }
  }

  const direct = resolveConstChain(ident, model.consts);
  if (direct !== null) return [direct];

  const fn = model.functions.find((f) => line >= f.bodyStartLine && line <= f.bodyEndLine);
  if (fn) {
    const idx = fn.params.indexOf(ident);
    if (idx !== -1) {
      const callSites = findCallSites(model.content, fn.name, fn.declLine);
      const vals = new Set<string>();
      for (const args of callSites) {
        const argExpr = args[idx];
        if (!argExpr) continue;
        if (/^"[^"]*"$/.test(argExpr)) {
          vals.add(argExpr.slice(1, -1));
        } else if (/^[A-Za-z_$][\w$]*$/.test(argExpr)) {
          for (const v of resolveAt(model, argExpr, line, depth + 1)) vals.add(v);
        }
        // 其餘（函式呼叫／運算式）視為動態，略過——AC-02(a) 射程限定「字面」。
      }
      return [...vals];
    }
  }

  return [];
}

function resolveRawValue(model: FileModel, raw: string, line: number): string[] {
  if (raw.startsWith('"')) return [raw.slice(1, -1)];
  return resolveAt(model, raw, line);
}

// ---------------------------------------------------------------------------
// 欄位擷取（`effectiveFrom`／`fuelType`：冒號式或簡寫式）
// ---------------------------------------------------------------------------

const EFFECTIVE_FROM_COLON_RE = /\beffectiveFrom\s*:\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)/;
const EFFECTIVE_FROM_SHORTHAND_RE = /\beffectiveFrom\b\s*(?=[,}])/;
const FUEL_TYPE_COLON_RE = /\bfuelType\s*:\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)/;
const FUEL_TYPE_SHORTHAND_RE = /\bfuelType\b\s*(?=[,}])/;

function captureEffectiveFrom(objText: string): string | null {
  const m = EFFECTIVE_FROM_COLON_RE.exec(objText);
  if (m) return m[1];
  if (EFFECTIVE_FROM_SHORTHAND_RE.test(objText)) return "effectiveFrom";
  return null;
}

function captureFuelType(objText: string): string | null {
  const m = FUEL_TYPE_COLON_RE.exec(objText);
  if (m) return m[1];
  if (FUEL_TYPE_SHORTHAND_RE.test(objText)) return "fuelType";
  return null;
}

// ---------------------------------------------------------------------------
// 4 類參數軸之端點／UI 選取器登記表（AC-02(a) 之「軸註冊表」）
// ---------------------------------------------------------------------------

interface CategorySpec {
  category: string;
  hasFuelType: boolean;
  postRe: RegExp;
  fillEffectiveRe?: RegExp;
  fillFuelTypeRe?: RegExp;
}

const CATEGORIES: CategorySpec[] = [
  {
    category: "fuelPrice",
    hasFuelType: true,
    postRe: /\.post\(\s*`\$\{API_BASE\}\/parameters\/fuel-price`/g,
    fillEffectiveRe: /\.fill\(\s*"#fuel-effectiveFrom"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
    fillFuelTypeRe: /\.selectOption\(\s*"#fuel-fuelType"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
  },
  {
    category: "etc",
    hasFuelType: false,
    postRe: /\.post\(\s*`\$\{API_BASE\}\/parameters\/etc`/g,
  },
  {
    category: "depreciation",
    hasFuelType: false,
    postRe: /\.post\(\s*`\$\{API_BASE\}\/parameters\/depreciation`/g,
  },
  {
    category: "fuelConsumption",
    hasFuelType: true,
    postRe: /\.post\(\s*`\$\{API_BASE\}\/users\/\$\{[^}]+\}\/fuel-consumption`/g,
    fillEffectiveRe: /\.fill\(\s*"#fc-effectiveFrom"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
    fillFuelTypeRe: /\.selectOption\(\s*"#fc-fuelType"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
  },
];

// ---------------------------------------------------------------------------
// 主擷取器
// ---------------------------------------------------------------------------

interface SeedEntry {
  file: string;
  axis: string;
  date: string;
  line: number;
}

function extractSeedEntries(fileName: string, rawContent: string): SeedEntry[] {
  const content = stripComments(rawContent);
  const model = buildFileModel(content);
  const entries: SeedEntry[] = [];

  for (const spec of CATEGORIES) {
    // -- API POST 型樣 --
    const postRe = new RegExp(spec.postRe.source, "g");
    let pm: RegExpExecArray | null = postRe.exec(content);
    while (pm !== null) {
      const braceIdx = content.indexOf("{", pm.index + pm[0].length);
      if (braceIdx !== -1) {
        const obj = extractBalancedObjectAfter(content, braceIdx);
        if (obj) {
          const objLine = lineOf(content, obj.startIdx);
          const effRaw = captureEffectiveFrom(obj.text);
          if (effRaw) {
            const effValues = resolveRawValue(model, effRaw, objLine);
            let fuelValues: string[] = [];
            if (spec.hasFuelType) {
              const fuelRaw = captureFuelType(obj.text);
              fuelValues = fuelRaw ? resolveRawValue(model, fuelRaw, objLine) : [];
            }
            for (const date of effValues) {
              if (!ISO_DATE_RE.test(date)) continue;
              if (spec.hasFuelType) {
                for (const fuelType of fuelValues) {
                  entries.push({
                    file: fileName,
                    axis: `${spec.category}:${fuelType}`,
                    date,
                    line: objLine,
                  });
                }
              } else {
                entries.push({ file: fileName, axis: spec.category, date, line: objLine });
              }
            }
          }
        }
      }
      pm = postRe.exec(content);
    }

    // -- UI 表單填寫型樣（`fuel-model.spec.ts` 專用形狀）--
    if (spec.fillEffectiveRe && spec.fillFuelTypeRe) {
      const effRe = new RegExp(spec.fillEffectiveRe.source, "g");
      const fuelRe = new RegExp(spec.fillFuelTypeRe.source, "g");
      const fuelMatches = [...content.matchAll(fuelRe)];
      let em: RegExpExecArray | null = effRe.exec(content);
      while (em !== null) {
        const line = lineOf(content, em.index);
        const effValues = resolveAt(model, em[1], line);
        let nearest: RegExpMatchArray | undefined;
        let nearestDist = Number.POSITIVE_INFINITY;
        for (const fm of fuelMatches) {
          const dist = Math.abs((fm.index ?? 0) - em.index);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = fm;
          }
        }
        const fuelValues = nearest && nearestDist <= 400 ? resolveAt(model, nearest[1], line) : [];
        for (const date of effValues) {
          if (!ISO_DATE_RE.test(date)) continue;
          for (const fuelType of fuelValues) {
            entries.push({ file: fileName, axis: `${spec.category}:${fuelType}`, date, line });
          }
        }
        em = effRe.exec(content);
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// 檔案列舉與真實掃描
// ---------------------------------------------------------------------------

function listE2eSpecFiles(): string[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

function scanAllRealFiles(): { entries: SeedEntry[]; filesScanned: string[] } {
  const entries: SeedEntry[] = [];
  const filesScanned: string[] = [];
  for (const file of listE2eSpecFiles()) {
    const content = fs.readFileSync(path.join(E2E_DIR, file), "utf8");
    filesScanned.push(file);
    entries.push(...extractSeedEntries(file, content));
  }
  return { entries, filesScanned };
}

// ---------------------------------------------------------------------------
// 不變式檢查（純函式）與錯誤訊息（AC-02(f)）
// ---------------------------------------------------------------------------

interface Violation extends SeedEntry {
  reason: "lowerBound" | "sentinel";
}

function checkLowerBound(entries: SeedEntry[]): Violation[] {
  return entries
    .filter((e) => e.date <= LOWER_BOUND)
    .map((e) => ({ ...e, reason: "lowerBound" as const }));
}

function checkSentinel(entries: SeedEntry[]): Violation[] {
  const sentinelEntries = entries.filter(
    (e) => e.file === SENTINEL.file && e.axis === SENTINEL.axis
  );
  if (sentinelEntries.length === 0) return [];
  const sentinelDate = sentinelEntries.reduce(
    (min, e) => (e.date < min ? e.date : min),
    sentinelEntries[0].date
  );
  return entries
    .filter((e) => e.axis === SENTINEL.axis && e.file !== SENTINEL.file && e.date <= sentinelDate)
    .map((e) => ({ ...e, reason: "sentinel" as const }));
}

function formatViolation(v: Violation): string {
  if (v.reason === "lowerBound") {
    return `${v.file}:${v.line} 播種日 ${v.date} 違反下界不變式（不得 ≤ ${LOWER_BOUND}）。${FIX_GUIDANCE}。`;
  }
  return (
    `${v.file}:${v.line}（軸 ${v.axis}）播種日 ${v.date} 未嚴格早於哨兵` +
    `（${SENTINEL.file} 之 ${SENTINEL.constName}）,違反哨兵不變式。${FIX_GUIDANCE}。`
  );
}

// ---------------------------------------------------------------------------
// 測試
// ---------------------------------------------------------------------------

const { entries: realEntries, filesScanned: realFilesScanned } = scanAllRealFiles();

describe("AC-02(e): 掃描器涵蓋自證", () => {
  it("掃描器實際解析到的檔案清單 ＝ 全 e2e/ 現行 .spec.ts 檔案清單", () => {
    const expected = fs
      .readdirSync(E2E_DIR)
      .filter((f) => f.endsWith(".spec.ts"))
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect([...realFilesScanned].sort()).toEqual(expected);
  });
});

describe("AC-02(b)(c): 真實掃描——下界與哨兵不變式", () => {
  it("AC-02(b): 全 e2e/ 之任一參數播種日皆晚於下界 1999-05-05", () => {
    const violations = checkLowerBound(realEntries);
    expect(violations, violations.map(formatViolation).join("\n")).toEqual([]);
  });

  it("AC-02(c): 哨兵（audit-log.spec.ts 之 FUEL_PRICE_EFFECTIVE_FROM）於 fuelPrice:DIESEL 軸嚴格早於同軸其他任一檔", () => {
    // 自證前提：哨兵自身之播種確實被掃到（否則下方檢查恆真但無意義）。
    const sentinelSeen = realEntries.some(
      (e) => e.file === SENTINEL.file && e.axis === SENTINEL.axis
    );
    expect(sentinelSeen, "哨兵播種未被掃描器掃到——擷取器可能對 audit-log.spec.ts 失效").toBe(true);

    const violations = checkSentinel(realEntries);
    expect(violations, violations.map(formatViolation).join("\n")).toEqual([]);
  });
});

describe("AC-02(d): 鑑別力自證（三型 mutant，測試內合成字串，不改真實檔）", () => {
  it("①下界 mutant：注入 1990-01-01 之合成播種 → (b) 必紅", () => {
    const mutantContent = [
      'const MUTANT_LOWER_EFFECTIVE_FROM = "1990-01-01";',
      "async function seedMutantLower(page: Page): Promise<void> {",
      "  await page.request.post(`${API_BASE}/parameters/etc`, {",
      "    data: { unitPrice: 1.0, effectiveFrom: MUTANT_LOWER_EFFECTIVE_FROM },",
      "  });",
      "}",
    ].join("\n");

    const mutantEntries = extractSeedEntries("mutant-lowerbound.spec.ts", mutantContent);
    expect(mutantEntries.length).toBe(1);
    expect(mutantEntries[0].date).toBe("1990-01-01");
    expect(mutantEntries[0].axis).toBe("etc");

    const violations = checkLowerBound([...realEntries, ...mutantEntries]);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe("mutant-lowerbound.spec.ts");
    expect(violations[0].date).toBe("1990-01-01");
  });

  it("②哨兵 mutant：注入與哨兵同軸（fuelPrice:DIESEL）且更早之合成播種 → (c) 必紅", () => {
    const mutantContent = [
      'const MUTANT_EARLY_DIESEL_EFFECTIVE_FROM = "2005-01-01";',
      "async function seedMutantEarlyDiesel(page: Page): Promise<void> {",
      "  await page.request.post(`${API_BASE}/parameters/fuel-price`, {",
      '    data: { fuelType: "DIESEL", pricePerLiter: 1.0, effectiveFrom: MUTANT_EARLY_DIESEL_EFFECTIVE_FROM },',
      "  });",
      "}",
    ].join("\n");

    const mutantEntries = extractSeedEntries("mutant-sentinel-early.spec.ts", mutantContent);
    expect(mutantEntries.length).toBe(1);
    expect(mutantEntries[0].axis).toBe("fuelPrice:DIESEL");
    expect(mutantEntries[0].date).toBe("2005-01-01");

    // (b) 不受影響（2005-01-01 > 1999-05-05）。
    expect(checkLowerBound([...realEntries, ...mutantEntries])).toEqual([]);

    const violations = checkSentinel([...realEntries, ...mutantEntries]);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe("mutant-sentinel-early.spec.ts");
    expect(violations[0].date).toBe("2005-01-01");
  });

  it("③防過寬 mutant：注入同軸（fuelPrice:DIESEL）但晚於哨兵之合成播種 → (b)(c) 兩式皆綠", () => {
    const mutantContent = [
      'const MUTANT_LATE_DIESEL_EFFECTIVE_FROM = "2015-01-01";',
      "async function seedMutantLateDiesel(page: Page): Promise<void> {",
      "  await page.request.post(`${API_BASE}/parameters/fuel-price`, {",
      '    data: { fuelType: "DIESEL", pricePerLiter: 1.0, effectiveFrom: MUTANT_LATE_DIESEL_EFFECTIVE_FROM },',
      "  });",
      "}",
    ].join("\n");

    const mutantEntries = extractSeedEntries("mutant-late-diesel.spec.ts", mutantContent);
    expect(mutantEntries.length).toBe(1);
    expect(mutantEntries[0].axis).toBe("fuelPrice:DIESEL");
    expect(mutantEntries[0].date).toBe("2015-01-01");

    const combined = [...realEntries, ...mutantEntries];
    expect(checkLowerBound(combined)).toEqual([]);
    expect(checkSentinel(combined)).toEqual([]);
  });
});

describe("AC-02(f): 錯誤訊息四要素（肇事檔／行號／日期／不變式名稱）與修法指引逐字", () => {
  it("下界違規訊息含四要素與修法指引逐字", () => {
    const mutantContent = [
      'const MUTANT_MSG_EFFECTIVE_FROM = "1990-06-01";',
      "async function seedMutantMsgLower(page: Page): Promise<void> {",
      "  await page.request.post(`${API_BASE}/parameters/etc`, {",
      "    data: { unitPrice: 1.0, effectiveFrom: MUTANT_MSG_EFFECTIVE_FROM },",
      "  });",
      "}",
    ].join("\n");
    const mutantEntries = extractSeedEntries("mutant-msg-lower.spec.ts", mutantContent);
    const violations = checkLowerBound(mutantEntries);
    expect(violations.length).toBe(1);
    const message = formatViolation(violations[0]);

    expect(message).toContain("mutant-msg-lower.spec.ts"); // 肇事檔
    expect(message).toContain(String(violations[0].line)); // 行號
    expect(message).toContain("1990-06-01"); // 該日期
    expect(message).toContain("下界不變式"); // 被破壞之不變式名稱
    expect(message).toContain(FIX_GUIDANCE); // 修法指引逐字
  });

  it("哨兵違規訊息含四要素與修法指引逐字", () => {
    const mutantContent = [
      'const MUTANT_MSG_SENTINEL_EFFECTIVE_FROM = "2003-01-01";',
      "async function seedMutantMsgSentinel(page: Page): Promise<void> {",
      "  await page.request.post(`${API_BASE}/parameters/fuel-price`, {",
      '    data: { fuelType: "DIESEL", pricePerLiter: 1.0, effectiveFrom: MUTANT_MSG_SENTINEL_EFFECTIVE_FROM },',
      "  });",
      "}",
    ].join("\n");
    const mutantEntries = extractSeedEntries("mutant-msg-sentinel.spec.ts", mutantContent);
    const violations = checkSentinel([...realEntries, ...mutantEntries]);
    expect(violations.length).toBe(1);
    const message = formatViolation(violations[0]);

    expect(message).toContain("mutant-msg-sentinel.spec.ts"); // 肇事檔
    expect(message).toContain(String(violations[0].line)); // 行號
    expect(message).toContain("2003-01-01"); // 該日期
    expect(message).toContain("哨兵不變式"); // 被破壞之不變式名稱
    expect(message).toContain(FIX_GUIDANCE); // 修法指引逐字
  });
});
