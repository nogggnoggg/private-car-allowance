/**
 * PHASE-010-T9 — error-handler 兜底路徑之洩漏面收斂（AC-21）
 *
 * 涵蓋（`docs/specs/PHASE-010.md` §2 H 段 AC-21 四段逐字）：
 *   · AC-21(a) `error-handler.ts` 分支 4（未預期例外）之日誌**不再記錄
 *     `error.message` 原文**，改記固定分類標籤 ＋ `error.name`；`requestId`
 *     仍為關聯手段。
 *   · AC-21(b) 站點白名單掃描：全 `backend/src` 中「將 `err.message`／
 *     `error.message` 直接送入 `log.*` 或回應 `details`」之出現位置，其檔案
 *     集合恰等於白名單；新增站點必紅（本檔以 fixture 自證鑑別力）。
 *   · AC-21(c) 反向探針：注入訊息含絕對路徑之未預期例外，斷言 `logStream`
 *     之該筆錯誤紀錄零路徑分隔字面命中。
 *   · AC-21(d) wire 零變更：`500` 回應 body 逐位元組不變。
 *
 * 零 DB 依賴（沿 `error-handler.test.ts` 之 `noopDbProbe` 慣例），全套件恆跑。
 *
 * ---------------------------------------------------------------------------
 * AC-21(b) 之「站點」定義與兩層掃描（實作裁量，逐項記載）
 * ---------------------------------------------------------------------------
 * AC 原文之站點類別為「直接送入 `log.*` 或回應 `details`」。純字面掃描對
 * 「變數間接」一型天然有規避面（PHASE-009 T2 SF-2 教訓；T4
 * `phase10-audit-structure.test.ts` 檔頭亦明記此本質限制）——而
 * `attachment/upload-service.ts` :150-151 正是該型（`const msg =
 * sanitizeForLog(err.message)` 後於次行 `log.warn` 送出），若只做 AC 字面之
 * 直接掃描，這個**今日已知之受控站點**會落在白名單之外，掃描形同放行。
 *
 * 故本檔做**兩層**掃描，互補而非擇一：
 *   L1（AC 字面）：`log.*`／`console.*` 呼叫之引數文字內含 `err.message`，或
 *       `details:` 物件字面內含 `err.message` → 直接輸出站點。白名單
 *       `DIRECT_SINK_WHITELIST`。
 *   L2（保守超集）：`backend/src` 全域任何對錯誤識別字（`err`／`error`／`e`
 *       ／`ex`／`exception`／`cause`，容許前綴底線）之 `.message` 讀取 → 白名
 *       單 `MESSAGE_READ_WHITELIST`。此層涵蓋 L1 之全部命中，另補上變數間接
 *       型與非 `log.*` 之輸出面（`process.stderr.write`）。
 * 代價明示：L2 會把「讀了 `err.message` 但根本不輸出」之用法（如死結重試判別
 * 之 regex 比對）一併納入白名單，新增此類用法亦會紅。此為**刻意偏保守**——
 * 安全守門寧可誤報後由維護者具名加入白名單，不可漏報。
 *
 * 兩層皆以 fixture 內容字串自證鑑別力（零磁碟寫入），並以反向對照明示 L1 對
 * 變數間接型之盲點正是由 L2 承接。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, "../../src");

// ---------------------------------------------------------------------------
// 日誌擷取（沿 `log-security.test.ts` 之 makeLogCapture 同型）
// ---------------------------------------------------------------------------

function makeLogCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 遞迴收集物件中所有字串值（含巢狀物件／陣列）。 */
function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStringValues(item, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 反向探針之注入訊息（AC-21(c)）
// ---------------------------------------------------------------------------

/** 訊息中之獨特哨兵字串——用於「零字面命中」斷言，避免與日誌既有內容碰撞。
 * 刻意**不**讓路由路徑帶任何哨兵：`incoming request` 那筆日誌本就會記 `url`，
 * 若路由含哨兵則斷言恆紅且與兜底分支無關（初版即踩到，已修）。 */
const PROBE_SENTINELS = ["p10t9", "leak-probe", "ENOENT", "Users", "srv"] as const;

/** Windows 與 POSIX 兩型絕對路徑並列，兩種路徑分隔字元皆覆蓋。 */
const PROBE_MESSAGE =
  "ENOENT: no such file or directory, open 'C:\\Users\\p10t9\\app\\src\\leak-probe.ts' (fallback '/srv/p10t9/app/src/leak-probe.ts')";

const PROBE_ROUTE = "/test/boom-unexpected";

/** 兜底分支之 500 固定文案（`error-handler.ts` INTERNAL_ERROR_MESSAGE 逐字）。 */
const INTERNAL_ERROR_MESSAGE = "系統發生錯誤，請稍後再試";

describe("AC-21(a)(c)(d): 未預期例外兜底 — 日誌洩漏面與 wire 逐位元組", () => {
  let app: FastifyInstance;
  let logLines: string[];
  let response: Awaited<ReturnType<FastifyInstance["inject"]>>;

  beforeAll(async () => {
    const capture = makeLogCapture();
    logLines = capture.lines;

    app = await buildServer({
      dbProbeOverride: async () => {},
      logStream: capture.stream,
    });

    app.get(PROBE_ROUTE, {
      handler: async () => {
        throw new Error(PROBE_MESSAGE);
      },
    });

    await app.ready();
    response = await app.inject({ method: "GET", url: PROBE_ROUTE });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** 兜底分支所產生之 error-level（pino 50）紀錄。 */
  function unhandledEntries(): Record<string, unknown>[] {
    return logLines
      .map(parseLine)
      .filter((obj): obj is Record<string, unknown> => obj !== null && obj.level === 50);
  }

  // ── AC-21(a) ────────────────────────────────────────────────────────────
  it("AC-21(a): 兜底日誌仍存在且記錄 error.name 與固定分類標籤", () => {
    const entries = unhandledEntries();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry.errName).toBe("Error");
    expect(typeof entry.errClass).toBe("string");
    expect(entry.errClass).toBe("UNEXPECTED_EXCEPTION");
    expect(entry.msg).toBe("Unhandled exception");
  });

  it("AC-21(a): 兜底日誌不再帶 errMessage 欄位（不記 error.message 原文）", () => {
    const entries = unhandledEntries();
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain("errMessage");
    }
  });

  it("AC-21(a): requestId 仍為關聯手段（日誌與回應同一值）", () => {
    const entries = unhandledEntries();
    const entry = entries[0];
    expect(typeof entry.requestId).toBe("string");
    const body = response.json<{ error: { requestId: string } }>();
    expect(entry.requestId).toBe(body.error.requestId);
  });

  // ── AC-21(c) 反向探針 ───────────────────────────────────────────────────
  it("AC-21(c): 兜底日誌之字串值零路徑分隔字面命中（'/' 與 '\\' 皆零）", () => {
    const entries = unhandledEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // pino base 欄位（level/time/pid）為數值，hostname 為主機名（無路徑分隔），
      // 其餘字串值皆由兜底分支自身決定——全部納入斷言。
      for (const value of collectStringValues(entry)) {
        expect(value, `路徑分隔字面命中於日誌字串值: ${value}`).not.toMatch(/[/\\]/);
      }
    }
  });

  it("AC-21(c): 全日誌輸出零哨兵字面命中（注入之絕對路徑片段皆未落地）", () => {
    const combined = logLines.join("\n");
    for (const sentinel of PROBE_SENTINELS) {
      expect(combined, `哨兵字串命中日誌: ${sentinel}`).not.toContain(sentinel);
    }
    expect(combined).not.toContain("leak-probe.ts");
  });

  // ── AC-21(d) wire 零變更 ────────────────────────────────────────────────
  it("AC-21(d): 500 回應 body 逐位元組等於 INTERNAL_ERROR ＋ 固定文案 ＋ requestId", () => {
    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { requestId: string } }>();
    const expected = JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: INTERNAL_ERROR_MESSAGE,
        requestId: body.error.requestId,
      },
    });
    expect(response.body).toBe(expected);
  });

  it("AC-21(d): 500 回應 body 零哨兵字面命中（wire 面不洩漏例外訊息）", () => {
    for (const sentinel of PROBE_SENTINELS) {
      expect(response.body).not.toContain(sentinel);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-21(b) 站點白名單掃描
// ---------------------------------------------------------------------------

/** 去除區塊註解與行註解，以等長空白取代（保留換行位置，行號可還原）——沿
 * `phase10-audit-structure.test.ts` 之 `stripComments` 同型設計（刻意複製而
 * 非 import 測試檔，沿既有慣例）。 */
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

/** 錯誤識別字之 `.message` 讀取（容許前綴底線與成員存取空白／跨行）。
 * 刻意不涵蓋 `blocker.message`／`issue.message`／`detail.message` 等領域物件
 * 欄位——它們不是例外訊息。 */
const ERROR_MESSAGE_READ = String.raw`\b_?(?:err|error|e|ex|exception|cause)\s*\.\s*message\b`;

/** L1：`log.*`／`console.*` 呼叫之引數文字內含錯誤訊息讀取。`[^;]*?` 以陳述
 * 句結尾為界，天然涵蓋跨行與模板字面、以及巢狀呼叫（如
 * `sanitizeForLog(err.message)`）。 */
const LOG_SINK_RE = new RegExp(
  String.raw`\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:log|logger|console)\s*\.\s*` +
    String.raw`(?:trace|debug|info|warn|error|fatal)\s*\([^;]*?` +
    ERROR_MESSAGE_READ,
  "g"
);

/** L1：回應 `details` 物件字面內含錯誤訊息讀取。 */
const DETAILS_SINK_RE = new RegExp(String.raw`\bdetails\s*:\s*\{[^;]*?` + ERROR_MESSAGE_READ, "g");

/** L2：任何錯誤識別字之 `.message` 讀取。 */
const MESSAGE_READ_RE = new RegExp(ERROR_MESSAGE_READ, "g");

/** 對單一內容字串掃描，回傳每個命中之行號（已去除註解）。 */
function scanContent(content: string, patterns: readonly RegExp[]): number[] {
  const cleaned = stripComments(content);
  const lines = new Set<number>();
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null = re.exec(cleaned);
    while (match !== null) {
      lines.add(cleaned.slice(0, match.index).split("\n").length);
      match = re.exec(cleaned);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** 掃描 `SRC_ROOT` 下所有 `.ts` 檔，回傳「相對路徑 → 命中行號」之 Map
 * （零命中之檔案不入 Map，故鍵集合即檔案集合）。 */
function scanSrc(patterns: readonly RegExp[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const file of listTsFilesRecursive(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const hits = scanContent(fs.readFileSync(file, "utf8"), patterns);
    if (hits.length > 0) result.set(rel, hits);
  }
  return result;
}

/**
 * L1 白名單 — 「直接送入 `log.*`／`console.*` 或回應 `details`」之受控站點。
 *
 * `seed/seed-admin.ts`：CLI 種子腳本之頂層 catch，以 `console.error` 印出
 * `err.message`。屬開發／部署期一次性工具（非請求路徑、非結構化日誌），輸出
 * 對象為執行者本人的終端機，故受控保留。
 *
 * `platform/error-handler.ts` 自 PHASE-010-T9（AC-21(a)）起**不在此列**——
 * 修復前它在此，該差異即為本掃描之紅燈物證。
 */
const DIRECT_SINK_WHITELIST = ["seed/seed-admin.ts"];

/**
 * L2 白名單 — 全域 `err.message` 讀取之受控站點（超集；理由見檔頭）。
 *
 *   · `applications/depreciation-service.ts`／`applications/maintenance-service.ts`
 *     ／`applications/travel-service.ts`／`attachment/lifecycle-service.ts`
 *     ／`reports/report-service.ts`：死結／序列化失敗之重試判別 regex，**不輸出**。
 *   · `attachment/upload-service.ts`：縮圖降級之 `sanitizeForLog(err.message)`
 *     後經變數送入 `log.warn`（變數間接型——L1 之盲點，由本層承接）。
 *   · `index.ts`：啟動期環境變數驗證失敗，`process.stderr.write` 印出欄位名／
 *     原因後 `exit 1`（非請求路徑，且 AC-09 已保證不印值）。
 *   · `seed/seed-admin.ts`：同 L1。
 */
const MESSAGE_READ_WHITELIST = [
  "applications/depreciation-service.ts",
  "applications/maintenance-service.ts",
  "applications/travel-service.ts",
  "attachment/lifecycle-service.ts",
  "attachment/upload-service.ts",
  "index.ts",
  "reports/report-service.ts",
  "seed/seed-admin.ts",
];

describe("AC-21(b): 站點白名單掃描 — err.message 之輸出面", () => {
  it("L1（AC 字面）：直接送入 log.*／console.* 或回應 details 之檔案集合恰等於白名單", () => {
    const hits = scanSrc([LOG_SINK_RE, DETAILS_SINK_RE]);
    expect([...hits.keys()].sort()).toEqual([...DIRECT_SINK_WHITELIST].sort());
  });

  it("L2（保守超集）：全域 err.message 讀取之檔案集合恰等於白名單", () => {
    const hits = scanSrc([MESSAGE_READ_RE]);
    expect([...hits.keys()].sort()).toEqual([...MESSAGE_READ_WHITELIST].sort());
  });

  it("L1 鑑別力①：單行 log 呼叫內之 error.message 必被偵測", () => {
    const fixture = `request.log.error({ errMessage: error.message }, "Unhandled exception");`;
    expect(scanContent(fixture, [LOG_SINK_RE, DETAILS_SINK_RE])).toEqual([1]);
  });

  it("L1 鑑別力②：跨行 log 呼叫內之 err.message 必被偵測", () => {
    const fixture = [
      "request.log.warn(",
      "  {",
      "    errMessage: err.message,",
      "  },",
      '  "boom"',
      ");",
    ].join("\n");
    expect(scanContent(fixture, [LOG_SINK_RE, DETAILS_SINK_RE]).length).toBe(1);
  });

  it("L1 鑑別力③：巢狀呼叫（sanitizeForLog(err.message)）與模板字面必被偵測", () => {
    const nested = "log.warn(`thumb failed: ${sanitizeForLog(err.message)}`);";
    expect(scanContent(nested, [LOG_SINK_RE, DETAILS_SINK_RE])).toEqual([1]);
  });

  it("L1 鑑別力④：回應 details 內之 err.message 必被偵測", () => {
    const fixture = `throw new AppError("INTERNAL_ERROR", 500, "x", undefined, { details: { reason: err.message } });`;
    expect(scanContent(fixture, [DETAILS_SINK_RE])).toEqual([1]);
  });

  it("L1 鑑別力⑤（反向）：領域物件之 .message（blocker／issue／detail）不得誤報", () => {
    const fixture = [
      'request.log.info({ reason: blocker.message }, "x");',
      'log.info({ reason: issue.message }, "y");',
      'log.info({ reason: detail.message }, "z");',
    ].join("\n");
    expect(scanContent(fixture, [LOG_SINK_RE, DETAILS_SINK_RE])).toEqual([]);
    expect(scanContent(fixture, [MESSAGE_READ_RE])).toEqual([]);
  });

  it("L1 已知盲點（變數間接型）由 L2 承接 — 反向對照明示", () => {
    const fixture = ["const msg = err.message;", 'log.warn(msg, "boom");'].join("\n");
    // L1 掃不到（`err.message` 不在 log 呼叫之引數文字內）——靜態文字掃描之本質限制
    expect(scanContent(fixture, [LOG_SINK_RE, DETAILS_SINK_RE])).toEqual([]);
    // L2 掃得到——故新增此型站點仍必紅
    expect(scanContent(fixture, [MESSAGE_READ_RE])).toEqual([1]);
  });

  it("L2 鑑別力：註解內之 err.message 不得誤報（stripComments 生效）", () => {
    const fixture = [
      "// 本檔永不把 err.message 寫進日誌",
      "/* 亦不轉呼叫 sanitizeForLog(error.message) */",
      "const ok = 1;",
    ].join("\n");
    expect(scanContent(fixture, [MESSAGE_READ_RE])).toEqual([]);
  });

  it("L2 鑑別力：新增任一站點（新檔）即必紅 — 以 fixture 內容自證", () => {
    const newSite = "process.stdout.write(String(e.message));";
    expect(scanContent(newSite, [MESSAGE_READ_RE])).toEqual([1]);
  });
});
