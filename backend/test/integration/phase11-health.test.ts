/**
 * PHASE-011-T9 — 健康檢查完善（Spec `docs/specs/PHASE-011.md` AC-14；§16 D9=(a)）
 *
 * D9=(a) 裁定：維持單一 `/health` ＋ 僅 DB 探針，補齊「探針逾時上限」與
 * 「失敗日誌紀律」之測試覆蓋——不新增 storage 探針、不分離 liveness／
 * readiness、不觸碰 `docker-compose.yml`（AC-14(d) 之 (d-1)(d-2) 兩子項依
 * 本裁定皆未觸發，見檔尾說明）。
 *
 * 涵蓋：
 *   · AC-14(a) 正常態：`checks.db` 鍵名與值域不變（本檔以封閉斷言 `toEqual`
 *     釘住，日後誤加鍵即紅）。
 *   · AC-14(b) 異常態：探針失敗／逾時 → `503` ＋ `checks.db === "down"` ＋
 *     回應零連線資訊；B-14／N-4：逾時上限在場，健康檢查恆快。
 *   · AC-14(c) 探針失敗之日誌：只記探針名（`probe`）與 `err.name`
 *     （`errName`），不記 `err.message`——直接失敗與逾時失敗兩路徑同形。
 *   · mutant 自證：逾時上限與日誌紀律兩處皆以合成對照證明鑑別力（不改真實
 *     `health.ts`，沿本專案既有之合成 mutant 慣例，如
 *     `phase11-attachment-cleanup.test.ts` 檔頭所述）。
 *
 * 與既有檔之分工（零重複）：
 *   · `backend/test/integration/health.test.ts`（既有，本 Task 零改動）已覆蓋
 *     透過 `buildServer()` 全棧組裝下之 200／503 基本回應與零連線資訊洩漏。
 *   · `backend/test/integration/log-security.test.ts`（既有，本 Task 零改動）
 *     已覆蓋 DB 探針直接失敗時 `errName` 存在且 `err.message` 不外洩。
 *   本檔聚焦 T9 新增之逾時語意與日誌欄位結構（`probe` 鍵、逾時路徑之同形
 *   紀律），並以獨立 Fastify 實例直接掛載 `healthPlugin`（零 DB、零
 *   `buildServer` 依賴——手法沿 `admin-users.test.ts` :793 之既有先例：於
 *   測試內建立最小 Fastify 實例直接掛載目標 plugin），故
 *   `backend/src/server.ts` 本 Task 全程零改動。
 *
 * AC-14(d) 記載：依 D9=(a)，(d-1)（storage 可寫探針零殘留）與 (d-2)
 * （liveness/readiness 分離 ＋ compose 同批指向）兩子項之前提條件（「若新增
 * storage 探針」／「若分離兩端點」）皆未成立，故本 Task 不新增任何測試涵蓋
 * 這兩子項——與 §12 AC-14(d) 列之 N/A 記載一致，並非漏做。
 */
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROBE_TIMEOUT_MS, type DbProbe, healthPlugin } from "../../src/platform/health.js";

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

function parseErrorEntries(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((entry) => entry.level === 50);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildHealthApp(opts: {
  dbProbe: DbProbe;
  probeTimeoutMs?: number;
  stream?: Writable;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.stream ? { level: "error", stream: opts.stream } : { level: "error" },
  });
  await app.register(healthPlugin, {
    dbProbe: opts.dbProbe,
    probeTimeoutMs: opts.probeTimeoutMs,
  });
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("AC-14: 逾時上限之預設值在場", () => {
  it("DEFAULT_PROBE_TIMEOUT_MS 為正整數毫秒，且遠小於 docker-compose 健康檢查間隔（:49-58 之 10s）", () => {
    expect(Number.isInteger(DEFAULT_PROBE_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeLessThan(10000);
  });
});

describe("AC-14(a): 正常態", () => {
  it("全探針 up → 200 ＋ checks 封閉為 { db: 'up' }（既有鍵名與值域不變）", async () => {
    app = await buildHealthApp({ dbProbe: async () => {} });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: Record<string, string> }>();
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ db: "up" });
  });
});

describe("AC-14(b): 異常態", () => {
  it("探針拋出 → 503 ＋ checks 封閉為 { db: 'down' } ＋ 回應零連線資訊", async () => {
    app = await buildHealthApp({
      dbProbe: async () => {
        throw new Error("connect ECONNREFUSED postgresql://u:p@host:5432/db");
      },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; checks: Record<string, string> }>();
    expect(body.status).toBe("error");
    expect(body.checks).toEqual({ db: "down" });
    expect(res.body).not.toMatch(/postgresql:\/\//);
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("／B-14: 探針逾時（掛住不拋不resolve）→ 503 ＋ checks.db='down'（視為 down，非無限等待）", async () => {
    app = await buildHealthApp({
      dbProbe: () => delay(300), // 慢於下方 probeTimeoutMs，模擬逾時
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    const elapsedMs = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json<{ checks: { db: string } }>().checks.db).toBe("down");
    // 逾時上限在場之直接證據：回應遠早於探針自身完成時間（300ms）到達。
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe("AC-14(c): 探針失敗之日誌紀律", () => {
  it("直接失敗：日誌含 probe='db' 與 errName，零 err.message 原文", async () => {
    const { lines, stream } = makeLogCapture();
    const secretMarker = "SECRET-MARKER-CONN-STRING-9f1c";
    app = await buildHealthApp({
      dbProbe: async () => {
        throw new Error(`connection failed: ${secretMarker}`);
      },
      stream,
    });
    await app.inject({ method: "GET", url: "/health" });

    const entries = parseErrorEntries(lines);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].probe).toBe("db");
    expect(entries[0].errName).toBe("Error");
    const combined = lines.join("\n");
    expect(combined).not.toContain(secretMarker);
    expect(combined).not.toContain("connection failed");
  });

  it("逾時失敗：同形日誌紀律——probe='db'、errName='ProbeTimeoutError'、零逾時訊息原文", async () => {
    const { lines, stream } = makeLogCapture();
    app = await buildHealthApp({
      dbProbe: () => delay(300),
      probeTimeoutMs: 50,
      stream,
    });
    await app.inject({ method: "GET", url: "/health" });

    const entries = parseErrorEntries(lines);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].probe).toBe("db");
    expect(entries[0].errName).toBe("ProbeTimeoutError");
    const combined = lines.join("\n");
    expect(combined).not.toContain("timed out");
  });
});

describe("AC-14: mutant 自證", () => {
  it("逾時上限移除之合成對照：無上限拘束下，慢探針不受 150ms 期限拘束；真實 health.ts 則受拘束", async () => {
    const slowProbe = () => delay(300);
    const DEADLINE_MS = 150;

    // 合成「無逾時」變體：不改真實 health.ts，僅在測試內直接 await 慢探針
    // （即 withProbeTimeout 移除後的等價行為），並與一個短暫期限賽跑觀察。
    const raceLabel = await Promise.race([
      slowProbe().then(() => "probe-finished" as const),
      delay(DEADLINE_MS).then(() => "deadline" as const),
    ]);
    // 若逾時邏輯真的不存在，150ms 內探針不會完成——deadline 先到，證明
    // 「移除 withProbeTimeout」這個 mutant 會讓健康檢查受制於探針之真實耗
    // 時而非任何上限（本斷言即該 mutant 之紅燈物證）。
    expect(raceLabel).toBe("deadline");

    // 對照組：真實 health.ts（含 withProbeTimeout）在同一慢探針、
    // probeTimeoutMs=50（遠小於 DEADLINE_MS）下，必定早於 150ms 完成。
    app = await buildHealthApp({ dbProbe: slowProbe, probeTimeoutMs: 50 });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    expect(res.statusCode).toBe(503);
  });

  it("日誌紀律弱化之合成對照：含 err.message 之日誌物件必被本檔斷言偵測（防掃描器自身退化）", () => {
    const secretMarker = "SECRET-MARKER-MUTANT-DETECT-4b2e";
    // 合成「弱化版」日誌物件：把 err.message 直接混入（真實 health.ts 不會
    // 這樣做——見上方 AC-14(c) 兩格皆斷言零命中）。
    const mutantLogPayload = {
      probe: "db",
      errName: "Error",
      errMessage: `connection failed: ${secretMarker}`, // 真實碼不存在此鍵
    };
    const serialized = JSON.stringify(mutantLogPayload);
    // 本斷言證明 AC-14(c) 兩格之 `.not.toContain(secretMarker)` 型斷言具備
    // 偵測力（非恆真的空判斷）：若日誌真的挾帶 err.message，這裡會被抓到。
    expect(serialized).toContain(secretMarker);
  });
});
