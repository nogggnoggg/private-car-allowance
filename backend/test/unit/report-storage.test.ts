/**
 * Unit tests for storage/local-volume-storage.ts — PHASE-008-T8a (AC-26)
 *
 * Also hosts two later, unrelated structural guard suites appended at the
 * bottom of this file (not about local-volume-storage.ts itself): the
 * `frontend/nginx.conf.template` AC-26 location-block scan (PHASE-008-T14R),
 * and the `frontend/Dockerfile` / `docker-compose.yml` default-value guard
 * (DEPLOY-ZB-T2, AR-11) — both piggyback here rather than in a new file
 * because they share this file's zero-DB/zero-network structural-scan style
 * and existing `fs`/`path` imports.
 *
 * Scope (Spec §9.4, §11.2, D6, AC-26):
 *   - Key whitelist is parameterised via constructor option `{ prefixes: string[] }`,
 *     default remains `["att"]` — existing `storage.test.ts` MUST stay untouched
 *     and green (verified separately by `git diff` + full run, not re-asserted here).
 *   - A `rpt`-prefixed instance accepts `rpt/<id>/<suffix>` keys and rejects the
 *     same path-traversal matrix as the existing `att` suite (rerun for `rpt`).
 *   - Cross-instance rejection: an `att`-only instance rejects `rpt/...` keys and
 *     a `rpt`-only instance rejects `att/...` keys (closed prefix set, not open).
 *   - A multi-prefix instance (`["att", "rpt"]`) accepts both — proves the
 *     whitelist is genuinely parameterised, not a hardcoded single value.
 *   - Omitting the constructor's second argument keeps the default `["att"]`
 *     behaviour (mirrors existing storage.test.ts callers unchanged).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalVolumeStorage } from "../../src/storage/local-volume-storage.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t8a-report-storage-test-"));
}

// The same path-traversal / malformed-key matrix as backend/test/unit/storage.test.ts,
// rewritten for the `rpt` prefix per Spec §11.2 row "storage 前綴".
const TRAVERSAL_MATRIX_RPT: Array<[string, string]> = [
  ["path traversal: ../x", "../x"],
  ["path traversal: rpt/../../x", "rpt/../../x"],
  ["path traversal: rpt/id/../../../etc/passwd", "rpt/id/../../../etc/passwd"],
  ["absolute path (unix)", "/etc/passwd"],
  ["absolute path (windows drive)", "C:\\Windows\\System32"],
  ["absolute path (windows unc)", "\\\\server\\share"],
  ["backslash in key", "rpt\\id\\pdf"],
  ["null byte", "rpt/id\x00/pdf"],
  ["empty string", ""],
  ["leading slash", "/rpt/id/pdf"],
  ["trailing slash", "rpt/id/pdf/"],
  ["just dots", ".."],
  ["just dot", "."],
  ["double dot segment", "rpt/../etc"],
  ["encoded traversal (url-like)", "rpt/%2e%2e/etc"],
  ["newline in key", "rpt/id/p\ndf"],
  ["carriage return in key", "rpt/id/p\rdf"],
  ["tab in key", "rpt/id/p\tdf"],
  ["prefix embedded, not leading", "zzz/rpt/id/pdf"],
  ["prefix as substring (no separator)", "rptXYZ"],
  ["extra leading segment", "a/b/rpt/id/pdf"],
];

// ──────────────────────────────────────────────────────────────────────────
// rpt-only instance: accepts rpt/<id>/<suffix>, rejects the traversal matrix
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — rpt prefix (key validation, no fs)", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-rpt-validation-tests", {
    prefixes: ["rpt"],
  });

  it.each([
    ["rpt/<uuid>/pdf", "rpt/3fa85f64-5717-4562-b3fc-2c963f66afa6/pdf"],
    ["rpt/<uuid>/pdf (short id)", "rpt/abc123/pdf"],
  ])("accepts valid key: %s", async (_label, key) => {
    await expect(storage.exists(key)).resolves.toBe(false); // key valid, file doesn't exist
  });

  it.each(TRAVERSAL_MATRIX_RPT)(
    "AC-26: rpt 前綴之路徑穿越矩陣全數拒絕: %s",
    async (_label, key) => {
      await expect(storage.exists(key)).rejects.toThrow(
        /invalid.*key|key.*invalid|reject|not allowed|illegal/i
      );
    }
  );

  it("AR-3: TRAVERSAL_MATRIX_RPT covers the full 21-row matrix (18 original + 3 anchor/boundary rows)", () => {
    expect(TRAVERSAL_MATRIX_RPT).toHaveLength(21);
  });
});

describe("LocalVolumeStorage — rpt prefix (functional, real tmpdir)", () => {
  let tmpRoot: string;
  let storage: LocalVolumeStorage;

  beforeAll(() => {
    tmpRoot = makeTmpDir();
    storage = new LocalVolumeStorage(tmpRoot, { prefixes: ["rpt"] });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("put then get returns identical bytes for an rpt key", async () => {
    const key = "rpt/roundtrip001/pdf";
    const data = Buffer.from("%PDF-1.4 fake pdf bytes %%EOF", "utf8");
    await storage.put(key, data, "application/pdf");
    const result = await storage.get(key);
    expect((result as Buffer).equals(data)).toBe(true);
  });

  it("delete then exists returns false for an rpt key", async () => {
    const key = "rpt/delete001/pdf";
    await storage.put(key, Buffer.from("delete me"), "application/pdf");
    expect(await storage.exists(key)).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-instance rejection: closed prefix set, not open / shared
// ──────────────────────────────────────────────────────────────────────────

describe("AC-26: 附件實例拒 rpt 金鑰、報表實例拒 att 金鑰（跨實例互拒）", () => {
  it("an att-only instance rejects rpt/ keys", async () => {
    const attStorage = new LocalVolumeStorage("/non-existent-root-cross-1", {
      prefixes: ["att"],
    });
    await expect(attStorage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("a rpt-only instance rejects att/ keys", async () => {
    const rptStorage = new LocalVolumeStorage("/non-existent-root-cross-2", {
      prefixes: ["rpt"],
    });
    await expect(rptStorage.exists("att/abc123/original")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("a default (no options) instance behaves exactly like an explicit att-only instance: rejects rpt/ keys", async () => {
    const defaultStorage = new LocalVolumeStorage("/non-existent-root-cross-3");
    await expect(defaultStorage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Multi-prefix instance: proves the whitelist is a genuine parameter, not a
// hardcoded single value with a different name.
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — multi-prefix instance accepts every configured prefix", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-multi-prefix-tests", {
    prefixes: ["att", "rpt"],
  });

  it("accepts an att/ key", async () => {
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
  });

  it("accepts a rpt/ key", async () => {
    await expect(storage.exists("rpt/abc123/pdf")).resolves.toBe(false);
  });

  it("still rejects a prefix outside the configured set", async () => {
    await expect(storage.exists("xyz/abc123/other")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it.each([
    ["prefix embedded, not leading", "zzz/rpt/id/pdf"],
    ["prefix as substring (no separator)", "attXYZ"],
    ["extra leading segment", "a/b/rpt/id/pdf"],
  ])("rejects malformed multi-prefix key: %s", async (_label, key) => {
    await expect(storage.exists(key)).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AR-1: escapeRegExp correctness — a prefix containing a regex special char
// (".") must be matched literally, not as a regex wildcard.
// ──────────────────────────────────────────────────────────────────────────

describe("LocalVolumeStorage — prefix regex-escaping (AR-1: escapeRegExp correctness)", () => {
  const storage = new LocalVolumeStorage("/non-existent-root-for-escape-test", {
    prefixes: ["a.t"],
  });

  it("rejects abt/x/y (literal '.' must not act as a regex wildcard)", async () => {
    await expect(storage.exists("abt/x/y")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it("accepts a.t/x/y (literal dot prefix matches exactly)", async () => {
    await expect(storage.exists("a.t/x/y")).resolves.toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Default parameter: constructor's second argument omitted → prefixes ["att"]
// ──────────────────────────────────────────────────────────────────────────

describe('LocalVolumeStorage — default prefixes parameter stays ["att"]', () => {
  it("omitting the options argument accepts att/ keys (mirrors existing storage.test.ts callers)", async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test");
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
  });

  it("omitting the options argument rejects rpt/ keys", async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test-2");
    await expect(storage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });

  it('passing an explicit empty options object ({}) still defaults to ["att"]', async () => {
    const storage = new LocalVolumeStorage("/non-existent-root-for-default-param-test-3", {});
    await expect(storage.exists("att/abc123/original")).resolves.toBe(false);
    await expect(storage.exists("rpt/abc123/pdf")).rejects.toThrow(
      /invalid.*key|key.*invalid|reject|not allowed|illegal/i
    );
  });
});

// AC-26 末句（Spec §229 逐字）: PDF 位元組一律經後端授權端點回傳，volume 不得由
// nginx 靜態直出（結構性斷言：nginx.conf.template 無 volume 路徑之 location）。掃描字面取
// 自 docker-compose.yml（STORAGE_PATH 預設 /data/storage）與 .env.example（D4/D6
// 之 att/ rpt/ 金鑰前綴）。取捨見 Handoff：解析 location 區塊逐一查 root/alias，
// 優於裸字面 grep（可精確定位命中位置、不誤判 proxy_pass／註解文字）。

describe("AC-26: nginx.conf.template 結構性斷言 — PDF/附件 volume 不得由 nginx location 靜態直出", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const NGINX_CONF_PATH = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "frontend",
    "nginx.conf.template"
  );

  const VOLUME_LITERALS = ["/data/storage", "att/", "rpt/"];

  type LocationBlock = { pattern: string; body: string };

  function parseLocations(confText: string): LocationBlock[] {
    // 本檔 location 區塊皆無巢狀大括號，單層配對即足夠。
    // PHASE-008-T14R MF-1：放寬修飾子（~ ~* ^~ =），避免 `location ~ ^/files/
    // { alias ...; }` 之類的正則/前綴修飾寫法逃脫本正則、整個 location 未被
    // 解析（reviewer N2）。
    const blocks: LocationBlock[] = [];
    const startRe = /location\s+(?:[~^=*]+\s*)?([^\s{]+)\s*\{/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: 標準 regex.exec 迴圈慣用寫法
    while ((match = startRe.exec(confText)) !== null) {
      const pattern = match[1];
      const bodyStart = match.index + match[0].length;
      const closeIdx = confText.indexOf("}", bodyStart);
      if (closeIdx === -1) {
        throw new Error(`nginx.conf.template: location ${pattern} 缺少對應的 '}'`);
      }
      blocks.push({ pattern, body: confText.slice(bodyStart, closeIdx) });
    }
    return blocks;
  }

  function assertNoVolumeLocation(confText: string, source: string): void {
    const blocks = parseLocations(confText);
    if (blocks.length === 0) {
      throw new Error(`${source}: 未解析到任何 location 區塊 — 解析器可能失效`);
    }
    for (const block of blocks) {
      // 只查 root/alias（會靜態直出檔案）；proxy_pass 轉發給後端，不在本斷言範圍。
      const rootOrAliasMatches = block.body.match(/\b(root|alias)\s+([^;]+);/g) ?? [];
      for (const directive of rootOrAliasMatches) {
        for (const literal of VOLUME_LITERALS) {
          if (directive.includes(literal)) {
            throw new Error(
              `${source}: location ${block.pattern} 之 "${directive.trim()}" 疑似直出 volume 路徑（命中字面: "${literal}"）`
            );
          }
        }
      }
    }
  }

  // PHASE-008-T14R MF-1：全檔字面兜底 —— 逐 location 之結構解析（root/alias）
  // 對「不在任何 location 內的裸露 root」（reviewer N1，server 層）與「巢狀大
  // 括號截斷 location body」（reviewer N3，如 `if (...) { }` 使 `indexOf("}")`
  // 提前收尾）兩類天生無法涵蓋——這兩類的共同點是 volume 路徑字面本身仍原樣
  // 出現在檔案文字中，故以「全文字面掃描」作為結構法之補強，兩法互補、缺一
  // 不可（結構法仍保留，用以定位「哪個 location」；字面法純粹作為兜底防線）。
  function assertNoVolumeLiteral(confText: string, source: string): void {
    for (const literal of VOLUME_LITERALS) {
      if (confText.includes(literal)) {
        throw new Error(
          `${source}: 檔案全文出現疑似 volume 路徑字面 "${literal}"（結構解析盲點之全檔字面兜底 —— 常見於 server 層裸 root 或 location 內巢狀括號截斷 body）`
        );
      }
    }
  }

  /** 結構法（root/alias）＋ 全檔字面兜底，兩者皆須通過。 */
  function assertNoVolumeExposure(confText: string, source: string): void {
    assertNoVolumeLocation(confText, source);
    assertNoVolumeLiteral(confText, source);
  }

  it("正向對照：nginx.conf.template 存在 /api proxy 之 location 區塊（證明解析器確實讀到並解析了 location，非恆真）", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    const blocks = parseLocations(confText);
    const apiBlock = blocks.find((b) => b.pattern === "/api/");
    expect(apiBlock).toBeDefined();
    expect(apiBlock?.body).toMatch(/proxy_pass\s+http:\/\/\$BACKEND_UPSTREAM\//);
  });

  it("AC-26: nginx.conf.template 現況零 location 之 root/alias 指向 storage/report volume 路徑", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    expect(() => assertNoVolumeLocation(confText, "frontend/nginx.conf.template")).not.toThrow();
  });

  it("AC-26: nginx.conf.template 現況全文字面零命中 volume 路徑（全檔字面兜底之正向對照）", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    expect(() => assertNoVolumeLiteral(confText, "frontend/nginx.conf.template")).not.toThrow();
  });

  it("鑑別力自證（mutant）：加入直出 volume 路徑的 location 後，斷言邏輯必須偵測並拋錯", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    const lastBraceIdx = confText.lastIndexOf("}"); // server 區塊的收尾 '}'
    expect(lastBraceIdx).toBeGreaterThan(-1);
    const mutantLocation = "\n    location /files/ {\n        alias /data/storage/pdf/;\n    }\n";
    const mutated = confText.slice(0, lastBraceIdx) + mutantLocation + confText.slice(lastBraceIdx);
    expect(mutated).not.toBe(confText); // 確保真的插入成功，不是空替換
    expect(() => assertNoVolumeLocation(mutated, "mutant")).toThrow(/疑似直出 volume 路徑/);
  });

  // 鑑別力自證（PHASE-008-T14R MF-1｜N1/N2/N3）：reviewer 合併複審記載之三類
  // 繞過，各以 assertNoVolumeExposure（結構法＋全檔字面兜底）重放，逐一必
  // 紅（即 mutant 必被偵測、拋錯）。落地前以「當前」assertNoVolumeLocation
  // 單獨重放時，三者皆為 not.toThrow（mutant 存活，已於本回合開發階段實測
  // 確認並作為 TDD 紅燈證據，見 Task Handoff）。
  it("鑑別力自證（N1｜MF-1）：server 層裸 root 指向 volume 路徑（不在任何 location 內）之繞過必被偵測", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    const mutated = confText.replace("server_name _;", "server_name _;\n    root /data/storage;");
    expect(mutated).not.toBe(confText);
    expect(() => assertNoVolumeExposure(mutated, "mutant-N1")).toThrow(
      /疑似直出 volume 路徑|檔案全文出現疑似 volume 路徑字面/
    );
  });

  it("鑑別力自證（N2｜MF-1）：帶正則／前綴修飾子（如 ~ ^/files/）之 location alias 繞過必被偵測", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    const lastBraceIdx = confText.lastIndexOf("}");
    const mutantLocation =
      "\n    location ~ ^/files/ {\n        alias /data/storage/pdf/;\n    }\n";
    const mutated = confText.slice(0, lastBraceIdx) + mutantLocation + confText.slice(lastBraceIdx);
    expect(mutated).not.toBe(confText);
    expect(() => assertNoVolumeExposure(mutated, "mutant-N2")).toThrow(
      /疑似直出 volume 路徑|檔案全文出現疑似 volume 路徑字面/
    );
  });

  it("鑑別力自證（N3｜MF-1）：location 內巢狀大括號（如 if 區塊）截斷 body 之繞過必被偵測", () => {
    const confText = fs.readFileSync(NGINX_CONF_PATH, "utf8");
    const lastBraceIdx = confText.lastIndexOf("}");
    const mutantLocation =
      "\n    location /files/ {\n        if ($request_method = GET) { }\n        alias /data/storage/pdf/;\n    }\n";
    const mutated = confText.slice(0, lastBraceIdx) + mutantLocation + confText.slice(lastBraceIdx);
    expect(mutated).not.toBe(confText);
    expect(() => assertNoVolumeExposure(mutated, "mutant-N3")).toThrow(
      /疑似直出 volume 路徑|檔案全文出現疑似 volume 路徑字面/
    );
  });
});

// ---------------------------------------------------------------------------
// AR-11 — frontend/Dockerfile 與 docker-compose.yml 之預設值在場守門
// ---------------------------------------------------------------------------
//
// 規範出處：DEPLOY-ZB-T2 複審 AR-11（採納）。防兩類退化：①`frontend/Dockerfile`
// 之 `ENV BACKEND_UPSTREAM=backend:3000` 若被移除，裸 `docker run`（未經
// compose 之 `environment:` 覆寫）會渲染出 `proxy_pass http:///;`（空上游）而
// nginx 啟動即失敗；同批一併釘死 SF-6 之 `ENV NGINX_ENVSUBST_FILTER=
// ^BACKEND_UPSTREAM$`（見同檔 Dockerfile 之硬化說明——限縮 envsubst 代換範圍，
// 避免注入之環境變數同名巧合覆寫 nginx 內建變數如 $host/$uri/$scheme）。
// ②`docker-compose.yml` 之 `frontend.environment.BACKEND_UPSTREAM` 若失去
// `:-backend:3000` 後援，`.env` 未設該變數時 compose 會把空字串傳入容器，同型
// 故障。三格皆為結構性字面在場檢查（零 docker 依賴、零磁碟寫入），各配一條
// mutant 自證，防「格子本身失效仍恆綠」。
describe("AR-11: frontend/Dockerfile 與 docker-compose.yml 之預設值在場守門", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const DOCKERFILE_PATH = path.resolve(__dirname, "..", "..", "..", "frontend", "Dockerfile");
  const COMPOSE_PATH = path.resolve(__dirname, "..", "..", "..", "docker-compose.yml");

  const BACKEND_UPSTREAM_DEFAULT_RE = /^ENV BACKEND_UPSTREAM=backend:3000$/m;
  const ENVSUBST_FILTER_RE = /^ENV NGINX_ENVSUBST_FILTER=\^BACKEND_UPSTREAM\$$/m;
  const COMPOSE_FALLBACK_RE = /BACKEND_UPSTREAM:\s*\$\{BACKEND_UPSTREAM:-backend:3000\}/;

  it("frontend/Dockerfile 含 ENV BACKEND_UPSTREAM=backend:3000（本機／裸 docker run 之預設上游）", () => {
    const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, "utf8");
    expect(dockerfileText).toMatch(BACKEND_UPSTREAM_DEFAULT_RE);
  });

  it("frontend/Dockerfile 含 ENV NGINX_ENVSUBST_FILTER=^BACKEND_UPSTREAM$（SF-6：限縮 envsubst 代換範圍至目標變數）", () => {
    const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, "utf8");
    expect(dockerfileText).toMatch(ENVSUBST_FILTER_RE);
  });

  it("docker-compose.yml frontend 服務之 BACKEND_UPSTREAM 帶 :-backend:3000 後援", () => {
    const composeText = fs.readFileSync(COMPOSE_PATH, "utf8");
    expect(composeText).toMatch(COMPOSE_FALLBACK_RE);
  });

  it("鑑別力自證（mutant）：拿掉 Dockerfile 之 ENV BACKEND_UPSTREAM 行 → 對應格必紅（防恆真）", () => {
    const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, "utf8");
    const mutated = dockerfileText.replace(/^ENV BACKEND_UPSTREAM=backend:3000\n/m, "");
    expect(mutated).not.toBe(dockerfileText);
    expect(mutated).not.toMatch(BACKEND_UPSTREAM_DEFAULT_RE);
  });

  it("鑑別力自證（mutant）：拿掉 Dockerfile 之 ENV NGINX_ENVSUBST_FILTER 行 → 對應格必紅（防恆真）", () => {
    const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, "utf8");
    const mutated = dockerfileText.replace(
      /^ENV NGINX_ENVSUBST_FILTER=\^BACKEND_UPSTREAM\$\n/m,
      ""
    );
    expect(mutated).not.toBe(dockerfileText);
    expect(mutated).not.toMatch(ENVSUBST_FILTER_RE);
  });

  it("鑑別力自證（mutant）：拿掉 docker-compose.yml 之 :-backend:3000 後援 → 對應格必紅（防恆真）", () => {
    const composeText = fs.readFileSync(COMPOSE_PATH, "utf8");
    const mutated = composeText.replace(
      "BACKEND_UPSTREAM: ${BACKEND_UPSTREAM:-backend:3000}",
      "BACKEND_UPSTREAM: ${BACKEND_UPSTREAM}"
    );
    expect(mutated).not.toBe(composeText);
    expect(mutated).not.toMatch(COMPOSE_FALLBACK_RE);
  });
});
