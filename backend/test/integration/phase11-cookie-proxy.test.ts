/**
 * Integration test: PHASE-011-T7 — HTTPS／Cookie 屬性／反向代理信任
 * （`docs/specs/PHASE-011.md` **AC-09(d)(e)**、**AC-10(a)(b)(c)(e)**；
 * §16 **D7**=(a)「維持現況並釘死」、**D8**=(a)「不信任反向代理標頭，HTTPS 之
 * 保證來自部署平台」；邊界 **B-10**／**B-11**／**B-12**）
 *
 * ---------------------------------------------------------------------------
 * 本檔與 `test/unit/cookie-options.test.ts` 之分工
 * ---------------------------------------------------------------------------
 * 單元檔守的是**選項物件**（純函式之屬性集封閉）；本檔守的是**wire 面**——
 * 真的發一次登入、真的看 `Set-Cookie` 標頭長什麼樣，以及**代理標頭偽造**下
 * 應用是否仍然不把連線當成安全連線。兩者不可互相取代：選項物件正確但註冊
 * 順序或序列化出錯時，只有 wire 面會紅。
 *
 * ---------------------------------------------------------------------------
 * production 分支之取得方式（Spec §11.0 #5 強制）
 * ---------------------------------------------------------------------------
 * **不得**設定 `process.env.NODE_ENV=production`（會撞 `global-setup.ts` :304
 * 之 fail-closed 護欄）。本檔一律以 `buildServer({ forceSecureCookies: true })`
 * **參數注入**取得 production 之 Cookie 行為。該注入點本身之安全性質（單向
 * 加嚴、不可用來關掉 `Secure`）由單元檔之 `resolveSecureCookies` 守門。
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-09(d)** production 注入實例之 `Set-Cookie` 逐屬性 ＋ 屬性名集合封閉
 *     ＋ Cookie 值於日誌零命中（含掃描器之鑑別力自證）；
 *   · **AC-09(e)／B-12** D7=(a) 之下**不採** `__Host-` 前綴——以記載型 `it`
 *     ＋ 前綴零命中之機械斷言封住「日後有人改預設 Cookie 名卻沒處理開發環境
 *     無聲丟棄」之退化路徑；
 *   · **AC-10(a)** 安全連線判定恰一來源（全 `backend/src` 之代理標頭／
 *     `request.protocol` 取值零處；`secure:` 之取值恰一個來源）＋ 掃描器之
 *     合成 mutant 自證；
 *   · **AC-10(b-2)** 「不信任、由平台保證」之記載型 `it` ＋ `trustProxy` 之
 *     設定值機械斷言（恰一處、且恰為 `false`）；
 *   · **AC-10(c)／B-11** 偽造 `X-Forwarded-Proto: https` 不被採信（wire 面
 *     ＋ `request.protocol` 探針兩路證據）；
 *   · **B-10** production 下**未**收到 `X-Forwarded-Proto` 時 `Secure` 不得被
 *     靜默關閉（防「代理沒送標頭就降級」）；
 *   · **AC-10(e)** HTTP→HTTPS 導向之落層記載 ＋ 應用層零導向之機械斷言。
 *
 * AC-10(d)（`frontend/nginx.conf` :24 之 `X-Forwarded-Proto $scheme` 轉發**零
 * 變更**）為非測試載體，登記於 Task Handoff。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { buildServer } from "../../src/server.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "../..");
const SRC_ROOT = path.join(BACKEND_ROOT, "src");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedSetCookie {
  /** Cookie 名（第一組 name=value 之 name） */
  name: string;
  /** Cookie 值（session raw token） */
  value: string;
  /** 屬性表（鍵一律小寫；無值屬性如 HttpOnly／Secure 之值為 `true`） */
  attrs: Record<string, string | true>;
}

/** 解析單一 `Set-Cookie` 標頭字串。 */
function parseSetCookie(header: string): ParsedSetCookie {
  const parts = header.split(";").map((p) => p.trim());
  const [first, ...rest] = parts;
  const eq = first.indexOf("=");
  if (eq === -1) throw new Error(`Malformed Set-Cookie: ${header}`);

  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      attrs[part.toLowerCase()] = true;
    } else {
      attrs[part.slice(0, idx).toLowerCase()] = part.slice(idx + 1);
    }
  }

  return { name: first.slice(0, eq), value: first.slice(eq + 1), attrs };
}

/** 從 inject 回應取出唯一的 `Set-Cookie` 標頭字串。 */
function setCookieOf(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const header = Array.isArray(raw) ? (raw[0] as string) : (raw as string);
  expect(header, "回應必須帶 Set-Cookie 標頭").toBeDefined();
  return header;
}

/** 收集 pino JSON 日誌行（沿 `log-security.test.ts` 之既有形狀）。 */
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

/** 註解剝除（區塊 ＋ 行），保留行號結構。 */
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

/** `backend/src` 相對路徑（正斜線），供斷言訊息可讀。 */
function relToSrc(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

/**
 * AC-10(a) 之掃描樣式：任何「讀取反向代理所提供之原始連線資訊」的取值面。
 * D8=(a) 之下這些**一處都不該有**——本系統不需要原始協定或用戶端 IP。
 */
const PROXY_SOURCE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "x-forwarded-proto", pattern: /x-forwarded-proto/i },
  { label: "x-forwarded-for", pattern: /x-forwarded-for/i },
  { label: "x-forwarded-host", pattern: /x-forwarded-host/i },
  { label: "x-real-ip", pattern: /x-real-ip/i },
  { label: "request.protocol", pattern: /\b(?:request|req|_req)\s*\.\s*protocol\b/ },
  { label: "request.ip / request.ips", pattern: /\b(?:request|req|_req)\s*\.\s*ips?\b/ },
];

/** 對單一份原始碼（已剝註解）回報命中之樣式標籤。 */
function proxySourceHits(cleaned: string): string[] {
  return PROXY_SOURCE_PATTERNS.filter(({ pattern }) => pattern.test(cleaned)).map(
    ({ label }) => label
  );
}

// ===========================================================================
// AC-09(d)(e) — wire 面：production 注入實例之 Set-Cookie ＋ 日誌零命中
// ===========================================================================

describeWithDb("PHASE-011-T7 — AC-09(d): production 注入實例之 Set-Cookie（wire 面）", () => {
  let prisma: PrismaClient;
  let prodApp: FastifyInstance;
  let devApp: FastifyInstance;
  let prodLogLines: string[];

  const USER_LOGIN = `t7_cookie_${Date.now()}`;
  const PASSWORD = "T7CookieWire99!";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        loginName: USER_LOGIN,
        displayName: "T7 Cookie Wire User",
        passwordHash: await hashPassword(PASSWORD),
        isActive: true,
        mustChangePassword: false,
      },
    });

    // production 之 Cookie 行為以**參數注入**取得（Spec §11.0 #5：不得改
    // NODE_ENV）。日誌以 trace 等級全量捕捉，供 AC-09(d) 之零命中斷言。
    const capture = makeLogCapture();
    prodLogLines = capture.lines;
    prodApp = await buildServer({
      databaseUrl: DB_URL,
      forceSecureCookies: true,
      logLevel: "trace",
      logStream: capture.stream,
    });
    await prodApp.ready();

    devApp = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await devApp.ready();
  });

  afterAll(async () => {
    if (prodApp) await prodApp.close();
    if (devApp) await devApp.close();
    if (prisma) {
      await prisma.session.deleteMany({ where: { user: { loginName: USER_LOGIN } } });
      await prisma.user.deleteMany({ where: { loginName: USER_LOGIN } });
      await prisma.$disconnect();
    }
  });

  async function login(app: FastifyInstance, headers: Record<string, string> = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers,
      payload: { loginName: USER_LOGIN, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return response;
  }

  it("(d) Set-Cookie 逐屬性：HttpOnly ＋ Secure ＋ SameSite=Lax ＋ Path=/ ＋ Max-Age>0", async () => {
    const parsed = parseSetCookie(setCookieOf((await login(prodApp)).headers));

    expect(parsed.attrs.httponly).toBe(true);
    expect(parsed.attrs.secure).toBe(true);
    expect(String(parsed.attrs.samesite).toLowerCase()).toBe("lax");
    expect(parsed.attrs.path).toBe("/");
    expect(Number(parsed.attrs["max-age"])).toBeGreaterThan(0);
  });

  it("(d) Set-Cookie 之屬性名集合封閉（多一／少一必紅）", async () => {
    // ★ 與單元檔之 `toEqual` 封閉互補：這裡守的是**序列化之後**的樣子。
    //   少一（有人拿掉 Secure）或多一（有人偷加 Domain）皆必紅。
    const parsed = parseSetCookie(setCookieOf((await login(prodApp)).headers));
    expect(Object.keys(parsed.attrs).sort()).toEqual([
      "httponly",
      "max-age",
      "path",
      "samesite",
      "secure",
    ]);
  });

  it("(d) Cookie 值於日誌零命中（含掃描器之鑑別力自證）", async () => {
    const parsed = parseSetCookie(setCookieOf((await login(prodApp)).headers));
    const rawToken = decodeURIComponent(parsed.value);
    expect(rawToken.length).toBeGreaterThan(16); // 防「值是空字串所以當然沒命中」

    // 防恆真：必須真的有日誌行被產出，零命中才有意義。
    expect(prodLogLines.length).toBeGreaterThan(0);

    const hits = prodLogLines.filter(
      (line) => line.includes(rawToken) || line.includes(parsed.value)
    );
    expect(hits).toEqual([]);

    // 鑑別力自證：同一個搜尋條件對「刻意含有該值」之合成行必須命中——
    // 否則上面的零命中只證明了搜尋器壞掉。
    const syntheticLine = `{"level":30,"msg":"synthetic","cookie":"sid=${rawToken}"}`;
    expect([syntheticLine].filter((line) => line.includes(rawToken))).toEqual([syntheticLine]);
  });

  it("(e)／B-12: D7=(a) 不採 __Host-／__Secure- 前綴——Cookie 名零前綴", () => {
    // 【記載型 ＋ 機械斷言】§16 D7 裁定 (a)（維持現況並釘死），**未**採用
    // `__Host-` 前綴。理由（D7 選項 (c) 代價欄逐字）：`__Host-` 於開發環境
    // （HTTP）會被瀏覽器**靜默丟棄**，需依環境切換 Cookie 名，等於引入兩個
    // Cookie 名之複雜度與 B-12 之無聲失敗風險；而 US 兩項逐字要求（安全屬性、
    // 限制用戶端讀取）已由 `Secure` ＋ `HttpOnly` 完整滿足。
    //
    // 本格之機械價值：若日後有人把 `SESSION_COOKIE_NAME` 之預設改成
    // `__Host-sid` 卻沒有同批處理「開發環境不套前綴」，此格必紅——B-12 之
    // 無聲失敗（開發環境登入整體失效且無錯誤訊息）因而不可能靜默發生。
    const envSource = stripComments(fs.readFileSync(path.join(SRC_ROOT, "config/env.ts"), "utf8"));
    const defaultMatch = envSource.match(/SESSION_COOKIE_NAME[^\n]*default\(\s*"([^"]*)"\s*\)/);
    expect(defaultMatch, "env schema 必須有 SESSION_COOKIE_NAME 之預設值").not.toBeNull();
    const defaultName = (defaultMatch as RegExpMatchArray)[1];
    expect(defaultName).toBe("sid");
    expect(defaultName.startsWith("__Host-")).toBe(false);
    expect(defaultName.startsWith("__Secure-")).toBe(false);
  });

  it("(e) wire 面之 Cookie 名與 env 預設一致且零前綴", async () => {
    const parsed = parseSetCookie(setCookieOf((await login(prodApp)).headers));
    expect(parsed.name).toBe("sid");
  });

  // =========================================================================
  // AC-10(c)／B-11／B-10 — 代理標頭偽造與「缺標頭不降級」
  // =========================================================================

  it("AC-10(c)／B-11: 偽造 X-Forwarded-Proto: https 不使非 production 被當成安全連線", async () => {
    // 若應用（或 Fastify 之 trustProxy）採信該標頭，任何用戶端都能自稱 https。
    // 這裡的鑑別力：開發環境實例收到偽造標頭後，`Secure` 仍**不得**出現。
    const parsed = parseSetCookie(
      setCookieOf(
        (
          await login(devApp, {
            "x-forwarded-proto": "https",
            "x-forwarded-for": "203.0.113.7",
          })
        ).headers
      )
    );
    expect(parsed.attrs.secure).toBeUndefined();
    expect(String(parsed.attrs.samesite).toLowerCase()).toBe("lax");
    expect(parsed.attrs.httponly).toBe(true);
  });

  it("AC-10(c): 偽造標頭下 request.protocol 仍為 http（trustProxy 未開之執行期物證）", async () => {
    // 結構斷言（下方 AC-10(b)）證明 `trustProxy: false` 寫在原始碼裡；本格證明
    // 它在**執行期**確實生效：同一個實例上掛一條只回報 `request.protocol` 的
    // 探針路由，帶偽造標頭打進去。若有人把 `trustProxy` 改為 `true`，Fastify
    // 會依 `X-Forwarded-Proto` 回報 `https`，此格立刻轉紅。
    const probeApp = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    probeApp.get("/__t7_protocol_probe", async (request) => ({
      protocol: request.protocol,
      ip: request.ip,
    }));
    await probeApp.ready();

    try {
      const response = await probeApp.inject({
        method: "GET",
        url: "/__t7_protocol_probe",
        headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { protocol: string; ip: string };
      expect(body.protocol).toBe("http");
      // 用戶端 IP 亦不得被偽造標頭取代（同一個 trustProxy 開關管兩者）。
      expect(body.ip).not.toBe("203.0.113.7");
    } finally {
      await probeApp.close();
    }
  });

  it("B-10: production 下未收到 X-Forwarded-Proto 時，Secure 不得被靜默關閉", async () => {
    // Spec §5 B-10 逐字：「**不得**因而靜默關閉 `Secure`（那會使正式環境降級）」。
    // production 之 `Secure` 只由 NODE_ENV 決定，與代理是否送標頭無關。
    const withoutHeader = parseSetCookie(setCookieOf((await login(prodApp)).headers));
    expect(withoutHeader.attrs.secure).toBe(true);

    const withHttpHeader = parseSetCookie(
      setCookieOf((await login(prodApp, { "x-forwarded-proto": "http" })).headers)
    );
    expect(withHttpHeader.attrs.secure).toBe(true);
  });

  it("AC-09(c) 背書: 非 production 實例之 wire 面無 Secure（開發環境行為零變更）", async () => {
    const parsed = parseSetCookie(setCookieOf((await login(devApp)).headers));
    expect(parsed.attrs.secure).toBeUndefined();
    expect(parsed.attrs.httponly).toBe(true);
    expect(String(parsed.attrs.samesite).toLowerCase()).toBe("lax");
    expect(parsed.attrs.path).toBe("/");
  });
});

// ===========================================================================
// AC-10(a)(b)(e) — 結構面（不需 DB）
// ===========================================================================

describe("PHASE-011-T7 — AC-10(a): 安全連線判定恰一來源（§16 D8=(a)）", () => {
  const srcFiles = listTsFilesRecursive(SRC_ROOT);

  it("(a) 全 backend/src 零讀取反向代理所提供之原始連線資訊", () => {
    // D8=(a)：本系統今日沒有任何邏輯需要知道原始協定或用戶端 IP
    // （日誌不記 IP、`Secure` 由 NODE_ENV 決定、導向歸平台）。故這些取值面
    // 應為**空集**——出現任何一處，就代表有邏輯開始依賴可偽造的輸入，必須
    // 先回 Spec 決定信任模型（D8 之 (b)／(c)），不得靜默生長。
    const offenders = srcFiles
      .map((file) => ({
        file: relToSrc(file),
        hits: proxySourceHits(stripComments(fs.readFileSync(file, "utf8"))),
      }))
      .filter(({ hits }) => hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it("(a) 掃描器之鑑別力自證：合成來源必命中（防掃描器自身退化）", () => {
    // 上一格之空集若因正則寫壞而恆真，本格會抓到。
    expect(proxySourceHits(`const proto = request.headers["x-forwarded-proto"];`)).toEqual([
      "x-forwarded-proto",
    ]);
    expect(proxySourceHits("const isHttps = request.protocol === 'https';")).toEqual([
      "request.protocol",
    ]);
    expect(proxySourceHits("logger.info({ ip: req.ip });")).toEqual(["request.ip / request.ips"]);

    // 反向：註解中的說明文字不得誤報（本檔之掃描一律先剝註解）。
    expect(
      proxySourceHits(stripComments("// 本專案不採信 x-forwarded-proto\nconst a = 1;"))
    ).toEqual([]);
  });

  it("(a) `secure:` 之取值恰一個來源：resolveSecureCookies", () => {
    // 「安全連線判定恰一來源」之實質：Cookie 之 `secure` 不得出現第二個算法
    // （例如某處寫死 `secure: true`、另一處讀環境變數）。
    const files = srcFiles.filter((file) =>
      /\bsecure\s*:/.test(stripComments(fs.readFileSync(file, "utf8")))
    );
    expect(files.map(relToSrc)).toEqual(["auth/routes.ts"]);

    const routes = stripComments(fs.readFileSync(path.join(SRC_ROOT, "auth/routes.ts"), "utf8"));
    const secureValues = [...routes.matchAll(/\bsecure\s*:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    // 兩具 builder（設定用／清除用）各一處，且**同一個**變數——不是字面值、
    // 不是兩套各自的判定。
    expect(secureValues).toEqual(["isProduction", "isProduction"]);

    // 判定函式：全 src 恰一份宣告、恰一處呼叫。
    const declaringFiles = srcFiles.filter((file) =>
      /function\s+resolveSecureCookies\s*\(/.test(stripComments(fs.readFileSync(file, "utf8")))
    );
    expect(declaringFiles.map(relToSrc)).toEqual(["auth/routes.ts"]);

    const totalMentions = [...routes.matchAll(/resolveSecureCookies\s*\(/g)].length;
    const declarations = [...routes.matchAll(/function\s+resolveSecureCookies\s*\(/g)].length;
    expect(declarations).toBe(1);
    expect(totalMentions - declarations).toBe(1);
  });
});

describe("PHASE-011-T7 — AC-10(b-2)(e): 不信任代理、導向歸平台（記載型 ＋ 機械斷言）", () => {
  const srcFiles = listTsFilesRecursive(SRC_ROOT);

  it("(b-2)【記載型】HTTPS 之保證來自部署平台，應用層不驗證——trustProxy 恰一處且恰為 false", () => {
    // ─────────────────────────────────────────────────────────────────────
    // 【本專案之信任模型（§16 D8=(a) 裁定，Spec §17.1 #2 記載）】
    //
    //   · 正式環境之 TLS 由**部署平台**（Zeabur）終結；後端收到的是 HTTP。
    //   · 應用層**不採信** `X-Forwarded-*`，故 `trustProxy` 維持 `false`。
    //   · Cookie 之 `Secure` 由 `NODE_ENV=production` **單獨**決定，與代理是否
    //     送標頭無關（見 B-10 一格）。
    //
    // 【此假設之失效後果——必須被誠實記載，不得被本檔之綠燈掩蓋】
    //   若部署平台**未**強制 HTTPS，應用**不會察覺**：伺服器照常服務、
    //   健康檢查照常為綠、本檔全部格照常全綠，而使用者的流量是明文。
    //   偵測與處置歸 Runbook（Spec §17.1 #2 逐字：「Runbook 須載明此假設與其
    //   失效後果」），真實 TLS 之目視驗證歸整合 Gate 之人工項（§11.6 #4）。
    //   **NFR-US-11① 之自動化射程僅止於「Cookie 於 production 帶 Secure」。**
    //
    // 【為何是 `false` 而不是「不寫」】
    //   Fastify 之預設本就是 `false`，明寫零行為變更；但明寫使「這是一個經過
    //   裁定的選擇」在 `server.ts` 上可見，且讓下面的機械斷言能守住「值」而不
    //   只是守住「不存在」——日後任何人改成 `true`（信任任意上游，D8 之 (c)，
    //   Spec 逐字稱之為「明確的安全反模式」）必紅。
    // ─────────────────────────────────────────────────────────────────────
    const mentioning = srcFiles.filter((file) =>
      /trustProxy/.test(stripComments(fs.readFileSync(file, "utf8")))
    );
    expect(mentioning.map(relToSrc)).toEqual(["server.ts"]);

    const server = stripComments(fs.readFileSync(path.join(SRC_ROOT, "server.ts"), "utf8"));
    const values = [...server.matchAll(/trustProxy\s*:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(values).toEqual(["false"]);
  });

  it("(e)【記載型】HTTP→HTTPS 導向落於平台層，應用層零導向", () => {
    // 導向若做在應用層，必然需要知道原始協定 → 必然要採信 `X-Forwarded-Proto`
    // → 就得開 `trustProxy`（D8 之 (b)/(c)）。D8=(a) 的直接後果就是：**導向
    // 不在這裡做**，本專案之 HTTP→HTTPS 導向落於部署平台（Zeabur）之入口層；
    // compose 之 nginx 只聽 80、僅供本機開發，不做導向（`frontend/nginx.conf`
    // 本 Task 零變更，見 AC-10(d)）。
    //
    // 機械面：應用層零導向原語——出現任何一處都代表上述推理鏈被打破。
    const offenders = srcFiles
      .filter((file) => {
        const cleaned = stripComments(fs.readFileSync(file, "utf8"));
        return /\.redirect\s*\(/.test(cleaned) || /\b(?:301|308)\b/.test(cleaned);
      })
      .map(relToSrc);
    expect(offenders).toEqual([]);
  });
});
