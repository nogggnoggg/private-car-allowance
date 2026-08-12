/**
 * PHASE-010-T9／T9R — error-handler 兜底路徑之洩漏面收斂（AC-21）
 *
 * 涵蓋（`docs/specs/PHASE-010.md` §2 H 段 AC-21 四段逐字）：
 *   · AC-21(a) `error-handler.ts` 分支 4（未預期例外）之日誌**不再記錄
 *     `error.message` 原文**，改記固定分類標籤 ＋ `error.name`；`requestId`
 *     仍為關聯手段。
 *   · AC-21(b) 站點白名單掃描：全 `backend/src` 中「將 `err.message`／
 *     `error.message` 直接送入 `log.*` 或回應 `details`」之出現位置，其檔案
 *     集合恰等於白名單；新增站點必紅（以 fixture ＋ 真實檔暫改雙軌自證）。
 *   · AC-21(c) 反向探針：注入訊息含絕對路徑之未預期例外，斷言 `logStream`
 *     之該筆錯誤紀錄零路徑分隔字面命中。
 *   · AC-21(d) wire 零變更：`500` 回應 body 逐位元組不變。
 *
 * PHASE-011-T16（`docs/specs/PHASE-011.md` §16 D15=(a)／AC-28）—**同檔就地擴
 * 充**，關閉本檔原「已知不可及⑦／⑫」記載之 pino 錯誤物件序列化型洩漏面：
 *   · AC-28(a) 掃描器擴充：`{ err }` 物件簡寫／`err` 位置引數兩式，見下方
 *     `buildPinoSerializePatterns`（併入 L1）。
 *   · AC-28(b) `logger.ts` serializer 定案釘死（見對應 `describe`）。
 *   · AC-28(c) 兩處今日即存在站點（`index.ts` :33／`audit/audit.ts` :56）之
 *     修復（原始碼側，非本檔）；本檔以白名單零變動佐證修復生效。
 *   · AC-28(d) 原「已知不可及⑫」it 已改寫為正向格（見該 it）。
 *   · AC-28(e) ajv `detail.message` 面評估（見對應 `describe`）。
 *
 * 零 DB 依賴（沿 `error-handler.test.ts` 之 `noopDbProbe` 慣例），全套件恆跑。
 *
 * ---------------------------------------------------------------------------
 * AC-21(b) 之「站點」定義與兩層掃描
 * ---------------------------------------------------------------------------
 * AC 原文之站點類別為「直接送入 `log.*` 或回應 `details`」。故本檔做**兩層**
 * 掃描，互補而非擇一：
 *   L1（AC 字面）：`log.*`／`console.*` 呼叫之引數文字內含錯誤訊息取值，或
 *       `details:` 物件字面內含之 → 直接輸出站點。白名單
 *       `DIRECT_SINK_WHITELIST`。
 *   L2（保守超集）：`backend/src` 全域任何錯誤訊息取值 → 白名單
 *       `MESSAGE_READ_WHITELIST`。此層涵蓋 L1 之全部命中，另補上**變數間接
 *       型**與非 `log.*` 之輸出面（`process.stderr.write`）。
 *       必要性：`attachment/upload-service.ts` :150-151 正是變數間接型
 *       （`const msg = sanitizeForLog(err.message)` 後於次行 `log.warn` 送
 *       出），只做 L1 的話這個**今日已知受控站點**會落在白名單外。
 * 代價明示：L2 會把「讀了 `err.message` 但根本不輸出」之用法（死結重試判別之
 * regex 比對）一併納入白名單，新增此類用法亦會紅——刻意偏保守。
 *
 * ---------------------------------------------------------------------------
 * 掃描涵蓋面 — **據實敘述**（T9R／複審 M-1；初版檔頭曾宣稱「不可漏報」，經
 * 複審實測為與事實相反之過度宣稱，已刪除該宣稱並改為下列逐型記載）
 * ---------------------------------------------------------------------------
 * 複審列舉之七型 TS 主流寫法，本掃描器之涵蓋狀態：
 *   ① `(err as Error).message`（斷言後取值）        → **可及**（`\)` 分支）
 *   ② `err?.message`（optional chaining）           → **可及**（`\??`）
 *   ③ `err["message"]`／`err?.["message"]`（bracket）→ **可及**（bracket 分支）
 *   ④ `wireError.message`（TS 窄化後之他名變數）    → **可及**（識別字含
 *      `err`／`error`／`exception`／`cause` 字樣即納入，不再限縮於固定短名清單）
 *   ⑤ `catch (reason) { … reason.message }`（catch 他名繫結）
 *                                                   → **可及**（逐檔先擷取
 *      `catch (X)` 之繫結名，再併入該檔之錯誤識別字集合——非固定字樣清單）
 *   ⑥ `const { message } = err;`（解構賦值）        → **可及**（L2；L1 不及，
 *      因解構後送出屬變數間接型）。**參數位解構**（`function f({ message })`）
 *      仍**不可及**——無從判定該參數是否為錯誤物件。
 *   ⑦ `log.error({ err })`（pino 之 err 序列化器自動展開 message）
 *                                                   → **PHASE-011-T16 起可
 *      及**：此型不含任何 `.message` 字面，屬「序列化器行為」而非取值語法，故
 *      非上述 L1／L2 之 `errorRead` 判準所能涵蓋，改以獨立之
 *      `buildPinoSerializePatterns`（鍵名逐字 `err` 之物件形／err 識別字之
 *      位置引數形，含非首位——`console.error("msg", err)`）判準，併入 L1。
 *      原「已知不可及⑫」之記載型反向 it 已依 AC-28(d) 改寫為正向格。
 * 另一項刻意接受之**偽陽性**（方向安全）：`\)` 分支為名稱盲判，任何
 * `foo(...).message` 皆會命中，即使 `foo()` 回傳的不是錯誤物件。誤報方向為
 * 「多抓」，由維護者具名加入白名單即可；漏報才是不可接受的方向。
 *
 * 自證雙軌：fixture 內容字串（零磁碟寫入）＋ **真實檔暫改**（重放複審 M5：於
 * `error-handler.ts` 分支 3 植入 `errMessage: wireError.message`）。後者於記憶
 * 體內對真實檔內容字串施加突變後掃描，並斷言磁碟原檔位元組全等——刻意不寫回
 * 磁碟，以免平行測試或中途失敗留下被改壞的原始碼。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLoggerOptions } from "../../src/logger.js";
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
// AC-21(b) 站點白名單掃描 — 掃描核心
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 含 `err`／`error`／`exception`／`cause` 字樣之**任意**識別字——涵蓋 TS 窄化
 * 後之他名變數（`wireError`／`fastifyError`／`deleteErr`／`rootCause`…）。
 * 刻意不再使用「固定短名清單」：複審 M-1 證實那會漏掉窄化變數一整型。 */
const ERROR_NAMED_IDENT = String.raw`\w*(?:[Ee]rr(?:or)?|[Ee]xception|[Cc]ause)\w*`;

/** 歷史短名（`catch (e)`／`catch (ex)`）。 */
const ERROR_SHORT_IDENTS = ["ex", "e"];

/** `.message` 之各種取值語法：`.message`／`?.message`／`["message"]`／
 * `?.["message"]`；成員存取之空白與跨行皆容許。
 * （T9R 自測踩點：早期寫法把 `?` 與 `.` 拆成 `\??\s*\.`，導致
 * `err?.["message"]` 這型漏報——optional chaining 之 `?.` 後面接的是 `[` 而非
 * 第二個 `.`。故 dot 型與 bracket 型各自帶自己的 `?.` 前綴。） */
const MESSAGE_ACCESS = String.raw`\s*(?:(?:\?\s*\.|\.)\s*message\b|(?:\?\s*\.)?\s*\[\s*["']message["']\s*\])`;

/** 擷取內容中所有 `catch (X)` 之繫結名（任意命名，如 `catch (reason)`）。 */
function extractCatchBindings(cleaned: string): string[] {
  const names = new Set<string>();
  for (const m of cleaned.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return [...names];
}

/** 錯誤識別字之比對式（具名字樣 ∪ 歷史短名 ∪ 本檔 catch 繫結名）。 */
function buildErrorIdent(catchNames: readonly string[]): string {
  const alts = [ERROR_NAMED_IDENT, ...ERROR_SHORT_IDENTS, ...catchNames.map(escapeRegex)];
  return String.raw`\b(?:${alts.join("|")})(?![\w$])`;
}

/** 錯誤運算式＝錯誤識別字 ∪ 右括號（涵蓋 `(err as Error)`／`getErr()` 等
 * 斷言後／呼叫後取值；名稱盲判之偽陽性已於檔頭明示接受）。 */
function buildErrorExpr(catchNames: readonly string[]): string {
  return `(?:${buildErrorIdent(catchNames)}|\\))`;
}

/** `log|logger|console` 之呼叫首碼（呼叫本身之開括號一併吃入）——PHASE-011-T16
 * 之三式比對式共用。與既有 L1 之 message-access 比對式使用相同首碼字面，刻意
 * 各自持有一份（沿本檔頭「刻意複製而非 import」之既有慣例），不去動既有比對式。 */
const LOG_CALL_PREFIX =
  String.raw`\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:log|logger|console)\s*\.\s*` +
  String.raw`(?:trace|debug|info|warn|error|fatal)\s*\(`;

/**
 * PHASE-011-T16（AC-28(a)）：pino 錯誤物件序列化型兩式之比對式。
 *
 * 與 `errorRead`（`.message` 取值型）完全不同之洩漏機制：pino 對 merging
 * 物件中**鍵名逐字為 `err`**之屬性、以及**位置引數本身是錯誤物件**兩種情形，
 * 會自動展開 `message` 與 `stack`（`node -e` 實測釘死：鍵名 `error` 不觸發，
 * 只有 `err` 觸發——見 Handoff 洩漏物證與 `logger.ts` 之對應 `describe`）。
 *
 *   A（物件形，簡寫或具值皆可）：`log.*({ err })`／`log.*({ err: someVar })`
 *       ——鍵名比對用字面 `err`（`\berr\b`），不用 `buildErrorIdent`：後者含
 *       `errName`／`errClass` 等既有安全欄位之字樣（`err(?:or)?` 等），但那些
 *       欄位與 "err" 之間**無詞界**，`\berr\b` 本就不會誤判它們；用字面 `err`
 *       是因為唯有此鍵名才會觸發 pino 之預設序列化，鍵名 `wireError`／`error`
 *       等縱使語意上是錯誤物件也不會觸發（此為 pino 之契約特性，非本專案認定）。
 *       `(?<=[{,])` 鎖定「err 必須是屬性起點」（緊接 `{`／`,` 之後，容許中間
 *       空白）——若無此鎖定，`{ error: err }` 之**值** `err`（鍵名其實是安全
 *       的 `error`）會被誤判成鍵名 `err` 而誤報（T16 開發期自我審查測出，見
 *       Handoff 之「反向對照①」）。
 *   B1（位置引數，首位）：`log.*(err, "…")`／`log.*(err)`——AC 原文之逐字形，
 *       緊接呼叫開括號之後，以此天然排除巢狀呼叫誤判。
 *   B2（位置引數，非首位）：`console.error("msg", err)`——`audit.ts` :56 之
 *       今日實際形。刻意排除 `()`／`{}` 於 err 之前的可跳過內容——否則
 *       `errorLabel(err)`／`{ errLabel: errorLabel(err) }`（`upload-service.ts`
 *       :319/:332，皆為安全站點）之巢狀呼叫右括號會被誤認成本呼叫自身之右括
 *       號而誤報（T16 開發期以全 `backend/src` 實跑踩過此坑並修正，見 Handoff）。
 * B1／B2 皆用 `buildErrorIdent`（非 `buildErrorExpr`）：**不**含 `\)` 分支，
 * 因為若允許任意運算式以 `)` 結尾即視為命中，`errorLabel(err)`／`String(err)`
 * 這類巢狀呼叫的右括號又會被誤判成外層呼叫的右括號。
 */
function buildPinoSerializePatterns(catchNames: readonly string[]): RegExp[] {
  const errorIdent = buildErrorIdent(catchNames);
  return [
    new RegExp(LOG_CALL_PREFIX + String.raw`\s*\{[^{}]*?(?<=[{,])\s*\berr\b\s*(?:,|:|\})`, "g"),
    new RegExp(LOG_CALL_PREFIX + String.raw`\s*` + errorIdent + String.raw`\s*(?:,|\))`, "g"),
    new RegExp(
      LOG_CALL_PREFIX + String.raw`[^;(){}]*?,\s*` + errorIdent + String.raw`\s*(?:,|\))`,
      "g"
    ),
  ];
}

type ScanLayer = "L1" | "L2";

/**
 * 依「已去註解之內容」組出該層之比對式集合。
 * catch 繫結名逐檔擷取，故比對式與內容相依（不能是模組級常數）。
 */
function buildLayerPatterns(cleaned: string, layer: ScanLayer): RegExp[] {
  const catchNames = extractCatchBindings(cleaned);
  const errorExpr = buildErrorExpr(catchNames);
  const errorRead = errorExpr + MESSAGE_ACCESS;

  if (layer === "L1") {
    return [
      // `log.*`／`console.*` 呼叫之引數文字內含錯誤訊息取值。`[^;]*?` 以陳述句
      // 結尾為界，天然涵蓋跨行、模板字面與巢狀呼叫（`sanitizeForLog(err.message)`）。
      new RegExp(
        String.raw`\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:log|logger|console)\s*\.\s*` +
          String.raw`(?:trace|debug|info|warn|error|fatal)\s*\([^;]*?` +
          errorRead,
        "g"
      ),
      // 回應 `details` 物件字面內含錯誤訊息取值。
      new RegExp(String.raw`\bdetails\s*:\s*\{[^;]*?` + errorRead, "g"),
      // PHASE-011-T16（AC-28(a)）：pino 錯誤物件序列化型兩式（見上方函式註解）。
      ...buildPinoSerializePatterns(catchNames),
    ];
  }
  return [
    // 任何錯誤訊息取值。
    new RegExp(errorRead, "g"),
    // 解構賦值型：`const { message } = err;`／`= (err as Error);`
    // （右側限錯誤識別字，不含 `\)` 分支——否則 `= foo()` 會誤報）。
    new RegExp(
      String.raw`\{[^{}]*\bmessage\b[^{}]*\}\s*=[^;]{0,40}?` + buildErrorIdent(catchNames),
      "g"
    ),
  ];
}

/** 對單一內容字串掃描，回傳每個命中之行號與命中文字（已去除註解）。
 * 行號為**比對式起點**所在行——L1 之起點是 `log.*` 呼叫本身，故跨行寫法之行號
 * 指向呼叫首行而非 `.message` 那一行（M5 重放 it 即據此比對命中文字）。 */
function scanContentMatches(content: string, layer: ScanLayer): { line: number; text: string }[] {
  const cleaned = stripComments(content);
  const found = new Map<number, string>();
  for (const pattern of buildLayerPatterns(cleaned, layer)) {
    let match: RegExpExecArray | null = pattern.exec(cleaned);
    while (match !== null) {
      const line = cleaned.slice(0, match.index).split("\n").length;
      if (!found.has(line)) found.set(line, match[0]);
      match = pattern.exec(cleaned);
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text }));
}

/** 對單一內容字串掃描，回傳每個命中之行號（已去除註解）。 */
function scanContent(content: string, layer: ScanLayer): number[] {
  return scanContentMatches(content, layer).map((m) => m.line);
}

/** 掃描 `SRC_ROOT` 下所有 `.ts` 檔，回傳「相對路徑 → 命中行號」之 Map
 * （零命中之檔案不入 Map，故鍵集合即檔案集合）。 */
function scanSrc(layer: ScanLayer): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const file of listTsFilesRecursive(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const hits = scanContent(fs.readFileSync(file, "utf8"), layer);
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
 * 修復前它在此，該差異即為本掃描之紅燈物證（T9R 另以真實檔暫改 it 常設重放）。
 */
const DIRECT_SINK_WHITELIST = ["seed/seed-admin.ts"];

/**
 * L2 白名單 — 全域錯誤訊息取值之受控站點（超集；理由見檔頭）。
 *
 *   · `applications/depreciation-service.ts`／`applications/maintenance-service.ts`
 *     ／`applications/travel-service.ts`／`attachment/lifecycle-service.ts`
 *     ／`reports/report-service.ts`：死結／序列化失敗之重試判別 regex，**不輸出**。
 *   · `attachment/upload-service.ts`：縮圖降級之 `sanitizeForLog(err.message)`
 *     後經變數送入 `log.warn`（變數間接型——L1 之盲點，由本層承接）。
 *   · `index.ts`：啟動期環境變數驗證失敗，`process.stderr.write` 印出欄位名／
 *     原因後 `exit 1`（非請求路徑，且 AC-09 已保證不印值）。**本條目之理由僅
 *     涵蓋此 env 驗證之 stderr——不涵蓋同檔 :33 之 `server.log.error(err)`**
 *     （該站點屬 PHASE-011-T16 之 pino 序列化型，已修復，見 L1 之
 *     `buildPinoSerializePatterns`；`docs/specs/PHASE-011.md` §13 #1 之建議）。
 *   · `seed/seed-admin.ts`：同 L1。
 *
 * T9R 之 regex 擴充（斷言／optional／bracket／窄化變數／catch 他名／解構）對
 * 真實原始碼**未新增任何命中檔**——實查：全 `backend/src` 今日零 `).message`、
 * 零 `?.message`、零 `["message"]`，`catch` 繫結名僅 `err`（34 處）與
 * `deleteErr`（1 處，`attachment/lifecycle-service.ts`，該檔本已在列）。故本
 * 基線與 T9 相同，非「擴充後仍漏掉」，而是「今日這些型別在 src 中不存在」。
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

// ---------------------------------------------------------------------------
// 真實檔暫改自證（重放複審 M5）之錨點
// ---------------------------------------------------------------------------

const ERROR_HANDLER_PATH = path.join(SRC_ROOT, "platform/error-handler.ts");

/** `error-handler.ts` 分支 3（wire-level 4xx）之日誌物件逐字。錨點失效即代表
 * 該分支已改版，本 it 會以明確訊息紅燈，提示維護者同步更新重放突變。 */
const M5_ANCHOR = "{ errName: error.name, errCode: wireError.code },";

/** 複審 M5 之突變：於分支 3 植入 TS 窄化變數之 message（初版掃描器對此型
 * 漏報，17/17 全綠——即 M-1 之核心證據）。 */
const M5_MUTANT =
  "{ errName: error.name, errCode: wireError.code, errMessage: wireError.message },";

describe("AC-21(b): 站點白名單掃描 — 錯誤訊息之輸出面", () => {
  it("L1（AC 字面）：直接送入 log.*／console.* 或回應 details 之檔案集合恰等於白名單", () => {
    const hits = scanSrc("L1");
    expect([...hits.keys()].sort()).toEqual([...DIRECT_SINK_WHITELIST].sort());
  });

  it("L2（保守超集）：全域錯誤訊息取值之檔案集合恰等於白名單", () => {
    const hits = scanSrc("L2");
    expect([...hits.keys()].sort()).toEqual([...MESSAGE_READ_WHITELIST].sort());
  });

  it("L1 鑑別力①：單行 log 呼叫內之 error.message 必被偵測", () => {
    const fixture = `request.log.error({ errMessage: error.message }, "Unhandled exception");`;
    expect(scanContent(fixture, "L1")).toEqual([1]);
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
    expect(scanContent(fixture, "L1").length).toBe(1);
  });

  it("L1 鑑別力③：巢狀呼叫（sanitizeForLog(err.message)）與模板字面必被偵測", () => {
    const nested = "log.warn(`thumb failed: ${sanitizeForLog(err.message)}`);";
    expect(scanContent(nested, "L1")).toEqual([1]);
  });

  it("L1 鑑別力④：回應 details 內之 err.message 必被偵測", () => {
    const fixture = `throw new AppError("INTERNAL_ERROR", 500, "x", undefined, { details: { reason: err.message } });`;
    expect(scanContent(fixture, "L1")).toEqual([1]);
  });

  it("L1 鑑別力⑤（反向）：領域物件之 .message（blocker／issue／detail）不得誤報", () => {
    const fixture = [
      'request.log.info({ reason: blocker.message }, "x");',
      'log.info({ reason: issue.message }, "y");',
      'log.info({ reason: detail.message }, "z");',
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([]);
    expect(scanContent(fixture, "L2")).toEqual([]);
  });

  // ── T9R／M-1：七型主流寫法之逐型鑑別力（①~⑤ 見上，⑥~⑫ 如下）────────────

  it("鑑別力⑥：型別斷言後取值 (err as Error).message 必被偵測（L1／L2 皆是）", () => {
    const fixture = 'request.log.error({ m: (err as Error).message }, "boom");';
    expect(scanContent(fixture, "L1")).toEqual([1]);
    expect(scanContent(fixture, "L2")).toEqual([1]);
  });

  it("鑑別力⑦：optional chaining err?.message 必被偵測（L1／L2 皆是）", () => {
    const fixture = 'request.log.error({ m: err?.message }, "boom");';
    expect(scanContent(fixture, "L1")).toEqual([1]);
    expect(scanContent(fixture, "L2")).toEqual([1]);
  });

  it('鑑別力⑧：bracket 取值 err["message"]／err?.["message"] 必被偵測（L1／L2 皆是）', () => {
    const bracket = 'log.error({ m: err["message"] }, "boom");';
    const optionalBracket = "const m = err?.['message'];";
    expect(scanContent(bracket, "L1")).toEqual([1]);
    expect(scanContent(bracket, "L2")).toEqual([1]);
    expect(scanContent(optionalBracket, "L2")).toEqual([1]);
  });

  it("鑑別力⑨：TS 窄化後之他名變數（wireError／fastifyError）必被偵測（L1／L2 皆是）", () => {
    const fixture = [
      'request.log.info({ m: wireError.message }, "wire 4xx");',
      "const detail = fastifyError.message;",
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([1]);
    expect(scanContent(fixture, "L2")).toEqual([1, 2]);
  });

  it("鑑別力⑩：catch 他名繫結（catch (reason)）之 .message 必被偵測（L1／L2 皆是）", () => {
    const fixture = [
      "try {",
      "  doWork();",
      "} catch (reason) {",
      '  request.log.error({ m: reason.message }, "boom");',
      "}",
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([4]);
    expect(scanContent(fixture, "L2")).toEqual([4]);
    // 反向對照：同一個他名若不是 catch 繫結（純領域變數），則不誤報
    const notCatch = 'request.log.error({ m: reason.message }, "boom");';
    expect(scanContent(notCatch, "L2")).toEqual([]);
  });

  it("鑑別力⑪：解構賦值 const { message } = err 必被偵測（L2；L1 不及——變數間接）", () => {
    const fixture = ["const { message } = err;", 'log.warn(message, "boom");'].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([]);
    expect(scanContent(fixture, "L2")).toEqual([1]);
    // 改名解構與斷言後解構亦可及
    expect(scanContent("const { message: m } = (err as Error);", "L2")).toEqual([1]);
    // 反向：非錯誤來源之解構不誤報
    expect(scanContent("const { message } = dto;", "L2")).toEqual([]);
  });

  // 原「已知不可及⑫」（記載型反向對照）——PHASE-011-T16（AC-28(d)）同批改寫為
  // 正向格：`buildPinoSerializePatterns` 併入 L1 後，物件簡寫與位置引數兩式皆
  // 必被偵測。此為**設計如此之預期翻紅**，非迴歸（commit message 逐字說明）。
  it("⑫ 改寫：log.error({ err }) 之 pino 序列化型物件簡寫必被 L1 偵測（AC-28(a)(d)）", () => {
    const fixture = 'request.log.error({ err }, "Unhandled exception");';
    expect(scanContent(fixture, "L1")).toEqual([1]);
  });

  it("⑫ 改寫：log.error(err, …) 之 pino 序列化型位置引數（首位）必被 L1 偵測（AC-28(a)(d)）", () => {
    const fixture = 'request.log.error(err, "positional form");';
    expect(scanContent(fixture, "L1")).toEqual([1]);
  });

  it("⑫ 改寫：console.error(msg, err) 之位置引數（非首位）必被 L1 偵測 — audit.ts :56 之今日實際形（AC-28(a)(c))", () => {
    const fixture = 'console.error("[audit] Failed to write AuditLog:", err);';
    expect(scanContent(fixture, "L1")).toEqual([1]);
  });

  it("⑫ 改寫：L2 刻意未疊加此判準（by design——pino 序列化型非 .message 取值型，L1 之直接送入判準已涵蓋）", () => {
    const fixture = [
      'request.log.error({ err }, "Unhandled exception");',
      'request.log.error(err, "positional form");',
    ].join("\n");
    expect(scanContent(fixture, "L2")).toEqual([]);
  });

  it("pino 序列化型鑑別力：物件形具值（{ err: wireError }）／多屬性夾帶皆必被偵測", () => {
    expect(scanContent('log.error({ err: wireError }, "x");', "L1")).toEqual([1]);
    expect(scanContent('log.error({ msg: "x", err }, "y");', "L1")).toEqual([1]);
    expect(scanContent('log.error({ err, extra: 1 }, "y");', "L1")).toEqual([1]);
  });

  it("pino 序列化型鑑別力：catch 他名繫結之位置引數亦必被偵測（沿既有他名繫結慣例）", () => {
    const fixture = [
      "try {",
      "  doWork();",
      "} catch (reason) {",
      '  log.error(reason, "boom");',
      "}",
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([4]);
  });

  it("pino 序列化型反向對照①（鍵名 error 不觸發 pino 之預設序列化，不誤報）", () => {
    // node -e 實測釘死：merging 物件鍵名為 "error"（非 "err"）時，pino 不展開
    // message/stack（`err serializer` 只鍵在字面 "err"）——故不納入本判準。
    expect(scanContent('log.error({ error: err }, "x");', "L1")).toEqual([]);
  });

  it("pino 序列化型反向對照②（errName／errClass 等既有安全欄位不得誤報）", () => {
    const fixture = [
      'fastify.log.error({ probe: "db", errName: err instanceof Error ? err.name : "UnknownError" });',
      'request.log.error({ errName: error.name, errClass: "UNEXPECTED_EXCEPTION" }, "Unhandled exception");',
      'request.log.info({ errName: error.name, errCode: wireError.code }, "Wire-level 4xx error");',
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([]);
  });

  it("pino 序列化型反向對照③（巢狀呼叫之右括號不得誤判為外層呼叫之右括號 — upload-service.ts 之今日安全站點形）", () => {
    // `attachment/upload-service.ts` :319/:332 之今日實際形：err 皆經
    // errorLabel() 轉為安全字串後才送入 log.*，非直接挾帶錯誤物件。
    const fixture = [
      "request.log.warn(`Compensation delete failed for key (log-safe): ${errorLabel(deleteErr)}`);",
      'request.log.error({ errLabel: errorLabel(err) }, "x");',
    ].join("\n");
    expect(scanContent(fixture, "L1")).toEqual([]);
  });

  it("pino 序列化型反向對照④（非 log/console 呼叫之裸露 err 引數不得誤報）", () => {
    expect(scanContent('doSomething(err, "x");', "L1")).toEqual([]);
  });

  it("pino 序列化型反向對照⑤（三元運算式內之 err／巢狀 String(err) 不得誤報為裸露位置引數 — seed-admin.ts 之今日實際形之簡化重現）", () => {
    // 刻意去除原檔之 `err.message`（該取值本身另由既有 L1／L2 之 .message
    // 判準偵測，seed-admin.ts 因此已在 DIRECT_SINK_WHITELIST／
    // MESSAGE_READ_WHITELIST——見下一 it 之區隔對照），本 it 只獨立驗證「pino
    // 序列化型」三式（A/B1/B2）不對「err instanceof Error」與「String(err)」
    // 這兩種形狀誤報。
    const fixture =
      'console.error("[seed:admin] Unexpected error:", err instanceof Error, String(err));';
    expect(scanContent(fixture, "L1")).toEqual([]);
  });

  it("區隔對照：seed-admin.ts 之今日實際完整寫法仍經既有 .message 判準命中 L1（非本 T16 新判準所致，行為不變）", () => {
    const fixture =
      'console.error( "[seed:admin] Unexpected error:", err instanceof Error ? err.message : String(err));';
    // 命中源自既有（PHASE-010）之 err.message 取值判準，非本 T16 新增之三式
    // ——佐證：把 `err.message` 換成 `err.name`（非取值字樣）後應轉為零命中。
    expect(scanContent(fixture, "L1")).toEqual([1]);
    const withoutMessageAccess = fixture.replace("err.message", "err.name");
    expect(scanContent(withoutMessageAccess, "L1")).toEqual([]);
  });

  it("真實檔案零命中自證：index.ts／audit.ts 修復後之現況內容對 pino 序列化型判準乾淨（站點修復生效佐證）", () => {
    const indexContent = fs.readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8");
    const auditContent = fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8");
    expect(scanContent(indexContent, "L1")).toEqual([]);
    expect(scanContent(auditContent, "L1")).toEqual([]);
  });

  it("mutant 自證＋還原：index.ts／audit.ts 之修復前寫法（原文重現）必被 L1 偵測，且非寫回磁碟", () => {
    // 兩處站點之修復前逐字寫法（PHASE-011-T16 修復前原文，非現行磁碟內容）。
    const INDEX_TS_BEFORE_FIX = "server.log.error(err);";
    const AUDIT_TS_BEFORE_FIX = 'console.error("[audit] Failed to write AuditLog:", err);';

    expect(scanContent(INDEX_TS_BEFORE_FIX, "L1")).toEqual([1]);
    expect(scanContent(AUDIT_TS_BEFORE_FIX, "L1")).toEqual([1]);

    // 修復後之現況磁碟內容確實不含這兩行原文（未寫回磁碟，讀取真實檔案佐證）。
    const indexContent = fs.readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8");
    const auditContent = fs.readFileSync(path.join(SRC_ROOT, "audit/audit.ts"), "utf8");
    expect(indexContent).not.toContain(INDEX_TS_BEFORE_FIX);
    expect(auditContent).not.toContain(AUDIT_TS_BEFORE_FIX);
  });

  it("已知不可及（記載型）：參數位解構 function f({ message }) 掃不到 — 無從判定是否為錯誤物件", () => {
    const paramDestructure =
      "function render({ message }: { message: string }) { return message; }";
    expect(scanContent(paramDestructure, "L2")).toEqual([]);
  });

  it("L1 已知盲點（變數間接型）由 L2 承接 — 反向對照明示", () => {
    const fixture = ["const msg = err.message;", 'log.warn(msg, "boom");'].join("\n");
    // L1 掃不到（`err.message` 不在 log 呼叫之引數文字內）——靜態文字掃描之本質限制
    expect(scanContent(fixture, "L1")).toEqual([]);
    // L2 掃得到——故新增此型站點仍必紅
    expect(scanContent(fixture, "L2")).toEqual([1]);
  });

  it("L2 鑑別力：註解內之 err.message 不得誤報（stripComments 生效）", () => {
    const fixture = [
      "// 本檔永不把 err.message 寫進日誌",
      "/* 亦不轉呼叫 sanitizeForLog(error.message) */",
      "const ok = 1;",
    ].join("\n");
    expect(scanContent(fixture, "L2")).toEqual([]);
  });

  it("L2 鑑別力：新增任一站點（新檔）即必紅 — 以 fixture 內容自證", () => {
    const newSite = "process.stdout.write(String(e.message));";
    expect(scanContent(newSite, "L2")).toEqual([1]);
  });

  // ── T9R：真實檔暫改自證（重放複審 M5）──────────────────────────────────

  it("真實檔暫改自證（重放複審 M5）：error-handler 分支 3 植入 wireError.message 即轉紅，原檔位元組不變", () => {
    const beforeBytes = fs.readFileSync(ERROR_HANDLER_PATH);
    const source = beforeBytes.toString("utf8");

    // 錨點實查——失效即代表分支 3 已改版，須同步更新本重放突變
    expect(
      source.includes(M5_ANCHOR),
      `M5 錨點未於 error-handler.ts 找到（分支 3 已改版？）：${M5_ANCHOR}`
    ).toBe(true);

    // 原檔：L1 零命中（與白名單斷言一致）
    expect(scanContent(source, "L1")).toEqual([]);

    // 突變後：L1 必命中恰一處，且落在 `errMessage` 那一行
    const mutated = source.replace(M5_ANCHOR, M5_MUTANT);
    expect(mutated).not.toBe(source);
    const mutatedHits = scanContentMatches(mutated, "L1");
    expect(mutatedHits.length).toBe(1);
    // 命中文字自 `request.log.info(` 起、至被植入的 `wireError.message` 止
    expect(mutatedHits[0].text).toContain("request.log.info(");
    expect(mutatedHits[0].text).toContain("wireError.message");

    // L2 亦必命中（超集層）
    expect(scanContent(mutated, "L2").length).toBeGreaterThan(0);

    // 還原 byte-identical：全程未寫檔，重讀比對以杜絕誤寫
    expect(fs.readFileSync(ERROR_HANDLER_PATH).equals(beforeBytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-28(b)：logger.ts 之 serializer 設定定案（釘死）
// ---------------------------------------------------------------------------

describe("AC-28(b): logger.ts 之 err serializer 設定定案", () => {
  it("定案：覆寫 err serializer，回傳值只保留分類用之 type，message／stack 皆為固定占位字串（非原文）", () => {
    const options = buildLoggerOptions("info") as unknown as {
      serializers?: { err?: (err: unknown) => Record<string, unknown> };
    };
    expect(options.serializers).toBeDefined();
    const serialized = options.serializers?.err?.(new Error("probe /abs/path/should-not-leak"));
    expect(serialized).toEqual({
      type: "Error",
      message: "[REDACTED]",
      stack: "[REDACTED]",
    });
  });

  it("非 Error 之擲出值（如字串）：type 退回 UnknownError，不拋例外", () => {
    const options = buildLoggerOptions("info") as unknown as {
      serializers?: { err?: (err: unknown) => Record<string, unknown> };
    };
    const serialized = options.serializers?.err?.("plain string thrown");
    expect(serialized?.type).toBe("UnknownError");
  });

  it("運行期整合釘死：以真實 pino 實例分別餵入物件簡寫與位置引數兩式，輸出零 message／stack 原文、零路徑分隔字面", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(buildLoggerOptions("info"), stream);
    const SENTINEL = "t16-serializer-probe";
    const err = new Error(`${SENTINEL} C:\\Users\\t16\\secret\\path.ts`);

    logger.error({ err }, "object shorthand form");
    logger.error(err, "positional form");

    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        err?: { type?: string; message?: string; stack?: string };
      };
      expect(parsed.err?.type).toBe("Error");
      expect(parsed.err?.message).toBe("[REDACTED]");
      expect(parsed.err?.stack).toBe("[REDACTED]");
    }
    const combined = lines.join("\n");
    expect(combined).not.toContain(SENTINEL);
    expect(combined).not.toMatch(/[/\\]/);
  });

  it("反向對照：pino 之預設序列化行為釘死——鍵名 error（非 err）不觸發展開（本專案選用鍵名 err 之判準依此而定）", () => {
    // 未套用本專案 serializers 覆寫、純 pino 預設之對照組，證明 buildPinoSerializePatterns
    // （AC-28(a)）只鎖定鍵名 "err" 是有事實根據的選擇，而非隨意窄化。
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const rawLogger = pino({}, stream);
    const err = new Error("probe");
    rawLogger.error({ error: err }, "error-key form");
    const parsed = JSON.parse(lines[0]) as { error?: Record<string, unknown> };
    expect(parsed.error).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AC-28(e)：ajv `detail.message` 面之評估
// ---------------------------------------------------------------------------
//
// 評估結論（記入 Handoff 全文；此處為記載型 it 之落地）：ajv 產生之
// `detail.message`（經 `error-handler.ts` 之 `extractFieldErrors` 轉為
// `fields[].reason`）為**基於 schema 關鍵字之固定形式文字**（如
// `must have required property 'x'`／`must be string`），**不衍生自例外物件
// 之 stack 或呼叫端之實際輸入值**——ajv 預設不把違反驗證的實際值嵌入
// `message`（僅少數 keyword 如 `pattern` 會把 schema 自身之 pattern 原文放進
// 訊息，那是 schema 作者自訂的內容，非執行期例外細節）。故本面**不納入**
// AC-28(a) 之 pino 序列化型判準，亦不需比照 AC-21(a) 改記分類標籤——性質不同
// （AC-21(a) 收斂的是**例外物件**之不可預測訊息；ajv 之 `detail.message` 是
// **驗證器產生之確定性文字**，本身就是設計給終端使用者看的欄位級提示）。
// 下列 it 以真實 schema-validation 路徑實測佐證此結論，而非僅憑推論。
describe("AC-28(e): ajv detail.message 面之評估（結論：不納入 pino 序列化型判準）", () => {
  let ajvApp: FastifyInstance;

  beforeAll(async () => {
    ajvApp = await buildServer({ dbProbeOverride: async () => {} });
    ajvApp.post("/test/ajv-probe", {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 3, pattern: "^[a-z]+$" } },
        },
      },
      handler: async () => ({ ok: true }),
    });
    await ajvApp.ready();
  });

  afterAll(async () => {
    if (ajvApp) await ajvApp.close();
  });

  it("required 缺漏之 detail.message 為固定形式文字，零路徑分隔字面、零 stack 欄位", async () => {
    const response = await ajvApp.inject({ method: "POST", url: "/test/ajv-probe", payload: {} });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { fields?: Array<{ field: string; reason: string }> } }>();
    expect(body.error.fields).toBeInstanceOf(Array);
    expect(body.error.fields?.length).toBeGreaterThan(0);
    for (const f of body.error.fields ?? []) {
      expect(f.reason).not.toMatch(/[/\\]/);
      expect(f.reason).not.toContain("stack");
    }
  });

  it("型別／pattern 不符之 detail.message 亦不含呼叫端實際輸入值（僅含 schema 自身之關鍵字資訊）", async () => {
    const response = await ajvApp.inject({
      method: "POST",
      url: "/test/ajv-probe",
      payload: { name: "AB" }, // 違反 minLength 亦違反 pattern（大寫），輸入值本身不應出現於 reason
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { fields?: Array<{ field: string; reason: string }> } }>();
    const reasons = (body.error.fields ?? []).map((f) => f.reason).join(" | ");
    expect(reasons).not.toContain("AB"); // 呼叫端實際輸入值不得出現於訊息
    expect(reasons).not.toMatch(/[/\\]/);
  });

  it("記載型結論：ajv detail.message 面不納入 AC-28(a) 之 pino 序列化型判準（性質不同，理由見上方檔頭）", () => {
    // 本 it 純記載評估結論，無新斷言——避免結論僅存在於註解而未落地為可被
    // grep／CI 追蹤之測試名稱（沿本檔既有「記載型」it 之慣例）。
    expect(true).toBe(true);
  });
});
