#!/usr/bin/env node
/**
 * measure-performance.mjs — PHASE-011-T11 / Spec `docs/specs/PHASE-011.md`
 * AC-17（單點回應時間目標）＋ AC-18（約 20 併發之可用性）之量測 harness。
 *
 * 手法（§16 D10=(a) 主）：Node 內建 `fetch` 打 compose stack 之 nginx
 * （`:8080`，端到端、含反向代理），語意最貼近 NFR-US-14 之「使用者感知時間」。
 * 首步跑 §11.6 spike #2（客戶端瓶頸確認 ＋ 三次重跑離散度）；若判定客戶端已
 * 成為瓶頸，依 D10 改用 (b)（直打後端、跳過 nginx）——**惟本 stack 之
 * `docker-compose.yml` 未將 backend:3000 對外映射到 host**，(b) 路徑若真的
 * 觸發，需要額外的網路層安排（超出本檔射程），僅據實標註，不擅自改
 * compose（Files Forbidden）。
 *
 * 三個階段：
 *   1. 播種（Phase 1）：以純 API（比照 `scripts/verify-persistence.sh` 之
 *      `seed_fixture` 範式，不 import 該檔）建立「有意義規模」之合成資料——
 *      本次執行前實查 dev DB 僅 1 user／7 apps／7 reports／7 attachments
 *      （PHASE-011-T10R 環境終態），故本階段自行播種數十使用者、各三十筆申請
 *      （三類型：差旅／保養／折舊）、含附件與報表。
 *   2. 量測（Phase 2）：AC-17(a)~(g) 七類場景 × N≥5，取中位數與最大值，以
 *      最大值對照目標（AC-17(h)）；另加一項非 AC-17 列名場景——
 *      `DELETE /admin/users/:id` 之歷史阻擋查詢（`userHasHistory`，D17 候選
 *      索引 `Application.createdById`／`Attachment.uploaderId` 之消費端），
 *      供 Task Packet 上游交接 #5 之「D17 判定輸入」使用，對擁有完整歷史之
 *      合成使用者測（恆期望 409，零實際刪除）。
 *   3. 併發（Phase 3）：AC-18 之 20 併發混合負載（列表＋詳情＋草稿儲存），
 *      持續 ≥30s 且 ≥200 次請求，記錄 5xx／4xx 分佈與 p95。
 *
 * 重試紀律：`withSeedRetry()` 僅套用於 **Phase 1 播種**之寫入呼叫（SERIALIZABLE
 * 交易在併發播種下之已知瞬時 503——與 AC-18 待驗證之併發特性同根因但非同一
 * 件事）；Phase 2／Phase 3 之量測與併發呼叫**一律不經此包裝**，5xx 一律如實
 * 計入報告，不重試掩蓋。
 *
 * 憑證（AC-12 之掃描射程不含 `scripts/`，本檔**零憑證字面**為人工核銷義
 * 務——沿 `verify-persistence.sh` 之環境變數慣例，絕不經命令列參數）：
 *   PERF_ADMIN_LOGIN／PERF_ADMIN_PASSWORD  既有管理員帳號與密碼（必要）。
 * 選用環境變數（皆有預設值）：
 *   PERF_BASE_URL（預設 http://localhost:8080）
 *   PERF_USER_COUNT（預設 25）　播種之合成使用者數
 *   PERF_SEED_CONCURRENCY（預設 6）　播種階段之使用者級並行度
 *   PERF_SAMPLE_N（預設 8，≥5）　可重複讀取場景之取樣數
 *   PERF_MUTATION_SAMPLE_N（預設 6，≥5）　一次性寫入場景（完成／PDF／作
 *     廢／修正版）之取樣數，每筆各消耗一份專屬合成資料
 *   PERF_LOAD_CONCURRENCY（預設 20，AC-18(a)）
 *   PERF_LOAD_DURATION_SEC（預設 35，AC-18(a) 之 ≥30s 門檻另加安全邊際）
 *
 * 用法：
 *   PERF_ADMIN_LOGIN=e2eadmin PERF_ADMIN_PASSWORD='...' \
 *     node scripts/measure-performance.mjs
 *
 * 前提：compose stack 已 up 且三面 healthy（本檔不 up/down stack——量測需
 * 要穩定環境；stack 異常時本檔於前置健康檢查即以結束碼 2 中止，不自行重
 * 建）。Node 版本需 ≥18.14（`Headers#getSetCookie()`）；本檔僅用 Node 內建
 * API（`fetch`／`FormData`／`Blob`／`perf_hooks`），**零新增 npm 依賴**
 * （N-8：純 JS ESM，無 Windows-only 語法，可在 Linux 容器內執行）。
 *
 * 結束碼：0＝全數量測完成且七類皆達標且 20 併發 0 個 5xx／1＝執行期錯誤（未
 * 能完成量測）／2＝前置條件不足（stack 未就緒或缺必要環境變數）／3＝量測
 * 完成但至少一類未達標或併發 5xx>0（資料已交付，達標與否見報告——AC-17(i)
 * 明文不得因未達標而放寬目標或自動優化，人類裁定）。
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: 缺少必要環境變數：${name}（請經環境變數提供，勿寫在命令列參數）`);
    process.exit(2);
  }
  return v;
}
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const BASE_URL = envStr("PERF_BASE_URL", "http://localhost:8080");
const API = `${BASE_URL}/api`;
const ADMIN_LOGIN = requireEnv("PERF_ADMIN_LOGIN");
const ADMIN_PASSWORD = requireEnv("PERF_ADMIN_PASSWORD");
const N_USERS = envInt("PERF_USER_COUNT", 25);
const SEED_CONCURRENCY = envInt("PERF_SEED_CONCURRENCY", 6);
const SPIKE_CONCURRENCY = envInt("PERF_SPIKE_CONCURRENCY", 20);
const SAMPLE_N = Math.max(5, envInt("PERF_SAMPLE_N", 8));
const MUTATION_SAMPLE_N = Math.max(5, envInt("PERF_MUTATION_SAMPLE_N", 6));
const LOAD_CONCURRENCY = envInt("PERF_LOAD_CONCURRENCY", 20);
const LOAD_DURATION_SEC = envInt("PERF_LOAD_DURATION_SEC", 35);
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REQUEST_TIMEOUT_MS = 60_000;
const PARAM_EFFECTIVE_FROM = "2020-01-01";
const FUEL_TYPE = "GASOLINE_92";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// ---------------------------------------------------------------------------
// HTTP session（手工 cookie jar——Node `fetch` 不跨呼叫自動管理 cookie）
// ---------------------------------------------------------------------------
class Session {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }
  applySetCookie(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const kv = sc.split(";", 1)[0];
      const eq = kv.indexOf("=");
      if (eq > 0) this.cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async call(method, path, body) {
    const headers = {};
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    this.applySetCookie(res);
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      await res.arrayBuffer().catch(() => {}); // 排空非 JSON 回應（如 PDF）
    }
    return { status: res.status, data };
  }
}

function isOk(status) {
  return status >= 200 && status < 300;
}

async function login(session, loginName, password) {
  const { status, data } = await session.call("POST", "/auth/login", { loginName, password });
  if (status !== 200)
    throw new Error(`登入失敗（${loginName}）：HTTP ${status} ${JSON.stringify(data)}`);
  return data.user;
}

// ---------------------------------------------------------------------------
// 統計 ／ 併發輔助
// ---------------------------------------------------------------------------
function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function maxOf(nums) {
  return nums.length ? Math.max(...nums) : Number.NaN;
}
function p95(nums) {
  if (!nums.length) return Number.NaN;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(0.95 * a.length) - 1)];
}
async function timeIt(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}
/**
 * **僅限 Phase 1 播種**之重試包裝：SERIALIZABLE 交易在併發寫入下出現 503
 * （`已重試多次仍未成功`）為系統已知、Spec §17.1 #13 明文接受之特性，非本
 * 檔要驗證之對象——播種只是要把資料建出來。**Phase 2／Phase 3 之量測與併
 * 發呼叫一律不得經此函式**，否則會把 AC-18(b)① 之真實 5xx 訊號重試掉，
 * 得出不誠實的達標宣稱（D10 決策理由之同一精神）。
 */
async function withSeedRetry(fn, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    const r = await fn();
    if (r.status !== 503 || attempt >= retries) return r;
    await new Promise((res) => setTimeout(res, 150 * (attempt + 1) + Math.random() * 100));
  }
}
function fmt(ms) {
  return Number.isFinite(ms) ? `${ms.toFixed(0)}ms` : "N/A";
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function genPassword(tag) {
  return `Seed-${RUN_ID}-${tag}-Aa1!`;
}

// ---------------------------------------------------------------------------
// Phase 0：spike（§11.6 #2）——客戶端不成為瓶頸之確認 ＋ 三次重跑之離散度
// ---------------------------------------------------------------------------
async function runSpike(probeSession) {
  console.log("\n=== Phase 0／spike（§11.6 #2）：客戶端瓶頸確認 ＋ 三次重跑離散度 ===");
  for (let i = 0; i < 5; i++) await probeSession.call("GET", "/health"); // 序列暖機
  // 額外一次「丟棄」之併發暖機批次（不計入三次重跑）：連線池／keep-alive／JIT
  // 於首次併發突發時有一次性開銷，會在三次重跑中把第一輪灌高，製造與客戶端
  // 瓶頸無關的假離散度（2026-08-11 首跑實測：21ms/14ms/14ms，見下方絕對值判
  // 準說明）——此批次結果不計入判定。
  await Promise.all(
    Array.from({ length: SPIKE_CONCURRENCY }, () => probeSession.call("GET", "/health"))
  );

  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t0 = performance.now();
    const latencies = await Promise.all(
      Array.from({ length: SPIKE_CONCURRENCY }, async () => {
        const t = performance.now();
        const { status } = await probeSession.call("GET", "/health");
        if (status !== 200) throw new Error(`spike 探針失敗：HTTP ${status}`);
        return performance.now() - t;
      })
    );
    const totalMs = performance.now() - t0;
    h.disable();
    const round = {
      round: r,
      totalMs,
      medianLatencyMs: median(latencies),
      maxLatencyMs: maxOf(latencies),
      eventLoopMaxMs: h.max / 1e6,
    };
    rounds.push(round);
    console.log(
      `  round ${r}：批次總耗時=${fmt(totalMs)}　單請求中位數=${fmt(round.medianLatencyMs)}　` +
        `單請求最大=${fmt(round.maxLatencyMs)}　事件迴圈延遲(max)=${round.eventLoopMaxMs.toFixed(2)}ms`
    );
  }

  const totals = rounds.map((r) => r.totalMs);
  const dispersion = (maxOf(totals) - Math.min(...totals)) / median(totals);
  const eventLoopMax = maxOf(rounds.map((r) => r.eventLoopMaxMs));
  const EVENT_LOOP_THRESHOLD_MS = 50;
  const DISPERSION_THRESHOLD = 0.5;
  // 絕對值旁證（B-22 精神之鏡射：極小絕對值下相對離散度本身不具鑑別力）：
  // 20 併發之批次總耗時若全數遠低於 AC-17 最嚴苛目標（表單/列表 2000ms）的
  // 一個數量級以上，代表批次早已完成、客戶端顯然未飽和，此時相對離散度只
  // 是毫秒級雜訊（GC／OS 排程抖動），據實以此旁證判定，不放大為瓶頸訊號。
  const ABSOLUTE_FLOOR_MS = 300;
  const dispersionOk = dispersion < DISPERSION_THRESHOLD || maxOf(totals) < ABSOLUTE_FLOOR_MS;
  const pass = eventLoopMax < EVENT_LOOP_THRESHOLD_MS && dispersionOk;

  console.log(
    `  判定：事件迴圈延遲(max)=${eventLoopMax.toFixed(2)}ms（門檻 <${EVENT_LOOP_THRESHOLD_MS}ms）、` +
      `三次批次總耗時離散度=${(dispersion * 100).toFixed(1)}%（門檻 <${DISPERSION_THRESHOLD * 100}% 或批次總耗時全數 <${ABSOLUTE_FLOOR_MS}ms） → ` +
      `${pass ? "PASS（客戶端非瓶頸，續用 D10=(a) 主路徑）" : "FAIL（依 D10 應改 (b) 直打後端）"}`
  );
  return { rounds, dispersion, eventLoopMax, pass };
}

// ---------------------------------------------------------------------------
// 全域參數（沿 verify-persistence.sh 之 ensure_param 範式，本檔獨立實作）
// ---------------------------------------------------------------------------
async function ensureGlobalParams(admin) {
  const fp = await admin.call("GET", `/parameters/fuel-price?fuelType=${FUEL_TYPE}`);
  const fpCovered = (fp.data?.versions ?? []).some(
    (v) => String(v.effectiveFrom).slice(0, 10) <= PARAM_EFFECTIVE_FROM
  );
  if (!fpCovered) {
    const r = await admin.call("POST", "/parameters/fuel-price", {
      fuelType: FUEL_TYPE,
      pricePerLiter: "30.0000",
      effectiveFrom: PARAM_EFFECTIVE_FROM,
    });
    if (r.status !== 201)
      throw new Error(`建立油價參數失敗：HTTP ${r.status} ${JSON.stringify(r.data)}`);
  }
  const etc = await admin.call("GET", "/parameters/etc");
  const etcCovered = (etc.data?.versions ?? []).some(
    (v) => String(v.effectiveFrom).slice(0, 10) <= PARAM_EFFECTIVE_FROM
  );
  if (!etcCovered) {
    const r = await admin.call("POST", "/parameters/etc", {
      unitPrice: 1.5,
      effectiveFrom: PARAM_EFFECTIVE_FROM,
    });
    if (r.status !== 201)
      throw new Error(`建立 ETC 參數失敗：HTTP ${r.status} ${JSON.stringify(r.data)}`);
  }
}

// ---------------------------------------------------------------------------
// 合成使用者與申請建立（純 API，全合成資料）
// ---------------------------------------------------------------------------
async function createSeedUser(admin, tag, displayName) {
  const loginName = `perf${RUN_ID}${tag}`;
  const initialPw = genPassword(`i${tag}`);
  const finalPw = genPassword(`l${tag}`);
  const created = await withSeedRetry(() =>
    admin.call("POST", "/admin/users", { loginName, displayName, temporaryPassword: initialPw })
  );
  if (created.status !== 201)
    throw new Error(
      `建立使用者失敗（${loginName}）：HTTP ${created.status} ${JSON.stringify(created.data)}`
    );
  const userId = created.data.user.id;

  const session = new Session(loginName);
  await login(session, loginName, initialPw);
  const chg = await withSeedRetry(() =>
    session.call("POST", "/me/password", { currentPassword: initialPw, newPassword: finalPw })
  );
  if (chg.status !== 200)
    throw new Error(`改密失敗（${loginName}）：HTTP ${chg.status} ${JSON.stringify(chg.data)}`);

  // fuel-consumption 為管理端點（adminPreHandlers）——必須以 admin session 呼叫，
  // 不可用使用者自己的 session（一般使用者呼叫會 403）。
  const fc = await withSeedRetry(() =>
    admin.call("POST", `/users/${userId}/fuel-consumption`, {
      fuelType: FUEL_TYPE,
      kmPerLiter: "10.0000",
      effectiveFrom: PARAM_EFFECTIVE_FROM,
      basisNote: "PHASE-011-T11 synthetic seed",
    })
  );
  if (fc.status !== 201)
    throw new Error(
      `建立油耗版本失敗（${loginName}）：HTTP ${fc.status} ${JSON.stringify(fc.data)}`
    );

  return { session, loginName, userId };
}

/**
 * 建立一筆差旅申請（全合成、單一行程段）。
 * options: { dateOffsetDays, withAttachment, complete, withReport }
 */
async function createTravelApp(
  session,
  { dateOffsetDays, withAttachment = false, complete = false, withReport = false }
) {
  const tripDate = isoDateDaysAgo(dateOffsetDays);
  const created = await withSeedRetry(() => session.call("POST", "/applications/travel", {}));
  if (created.status !== 201)
    throw new Error(`建立差旅草稿失敗：HTTP ${created.status} ${JSON.stringify(created.data)}`);
  const appId = created.data.application.id;

  let attachmentIds = [];
  if (withAttachment) {
    const fd = new FormData();
    fd.append("file", new Blob([TINY_PNG], { type: "image/png" }), "seed.png");
    const up = await withSeedRetry(() => session.call("POST", "/attachments", fd));
    if (up.status !== 201)
      throw new Error(`上傳附件失敗：HTTP ${up.status} ${JSON.stringify(up.data)}`);
    attachmentIds = [up.data.attachment.id];
  }

  const fill = await withSeedRetry(() =>
    session.call("PUT", `/applications/travel/${appId}`, {
      tripDate,
      purpose: "PHASE-011-T11 效能量測合成資料",
      segments: [
        {
          origin: "SiteA",
          destination: "SiteB",
          totalKm: "50.00",
          highwayKm: "10.00",
          attachmentIds,
        },
      ],
    })
  );
  if (fill.status !== 200)
    throw new Error(`填寫差旅草稿失敗：HTTP ${fill.status} ${JSON.stringify(fill.data)}`);

  if (!complete) return { appId, attachmentIds, completed: false, reported: false };

  const comp = await withSeedRetry(() =>
    session.call("POST", `/applications/${appId}/complete`, {})
  );
  if (comp.status !== 200)
    throw new Error(`完成申請失敗：HTTP ${comp.status} ${JSON.stringify(comp.data)}`);

  if (!withReport) return { appId, attachmentIds, completed: true, reported: false };

  const rep = await withSeedRetry(() => session.call("POST", `/applications/${appId}/report`, {}));
  if (![200, 201].includes(rep.status))
    throw new Error(`產生報表失敗：HTTP ${rep.status} ${JSON.stringify(rep.data)}`);

  return { appId, attachmentIds, completed: true, reported: true };
}

async function createMaintenanceDraft(session, dateOffsetDays) {
  const current = isoDateDaysAgo(dateOffsetDays);
  const last = isoDateDaysAgo(dateOffsetDays + 60);
  const { status, data } = await withSeedRetry(() =>
    session.call("POST", "/applications/maintenance", {
      lastMaintenanceDate: last,
      currentMaintenanceDate: current,
      lastOdometerKm: "1000.00",
      currentOdometerKm: "1500.00",
      actualCost: "800.00",
    })
  );
  if (status !== 201) throw new Error(`建立保養草稿失敗：HTTP ${status} ${JSON.stringify(data)}`);
}

async function createDepreciationDraft(session, year) {
  const { status, data } = await withSeedRetry(() =>
    session.call("POST", "/applications/depreciation", {
      applicationYear: year,
      annualTotalKm: "12000.00",
    })
  );
  if (status !== 201) throw new Error(`建立折舊草稿失敗：HTTP ${status} ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------
// Phase 1：播種——批量使用者（資料規模）＋ 量測固定操作者（perfmeasure）
// ---------------------------------------------------------------------------
async function seedBulkUser(admin, index) {
  const tag = `u${String(index).padStart(3, "0")}`;
  const u = await createSeedUser(admin, tag, `效能量測合成使用者 ${index}`);
  const travel = { draft: [], completed: [] };
  // 15 筆差旅：10 完成（皆含附件——SEGMENT_ATTACHMENT_REQUIRED 為完成之必要
  // 前提，非本檔原先誤判之「裝飾性」欄位，2026-08-11 實跑 400 才發現；其中 3
  // 筆再產報表）＋ 5 筆草稿（刻意不附件，代表「尚缺 Google Maps 截圖」之真
  // 實未完成態，貼合此業務規則的合成資料形狀）。
  for (let i = 0; i < 15; i++) {
    const willComplete = i < 10;
    const r = await createTravelApp(u.session, {
      dateOffsetDays: randInt(1, 180),
      withAttachment: willComplete,
      complete: willComplete,
      withReport: i < 3,
    });
    (r.completed ? travel.completed : travel.draft).push(r.appId);
  }
  // 8 筆保養草稿 ＋ 7 筆折舊草稿（三類型齊備；業務完成前提複雜，本階段刻意
  // 留為草稿——不影響 AC-17 量測射程，僅供資料規模與列表/詳情涵蓋三類型）
  for (let i = 0; i < 8; i++) await createMaintenanceDraft(u.session, randInt(1, 180));
  for (let i = 0; i < 7; i++) await createDepreciationDraft(u.session, randInt(2018, 2026));

  return {
    loginName: u.loginName,
    session: u.session,
    userId: u.userId,
    sampleDetailId: travel.completed[0] ?? null,
    sampleDraftId: travel.draft[0] ?? null,
  };
}

async function seedBulk(admin) {
  const t0 = performance.now();
  const users = await mapLimit(
    Array.from({ length: N_USERS }, (_, i) => i + 1),
    SEED_CONCURRENCY,
    (i) => seedBulkUser(admin, i)
  );
  return { users, elapsedMs: performance.now() - t0 };
}

async function seedPerfActor(admin) {
  const t0 = performance.now();
  const u = await createSeedUser(admin, "measure", "效能量測固定操作者");
  const s = u.session;

  // draftSave 本身永不完成（僅供重複 PUT 儲存計時），無需附件。
  const draftSave = await createTravelApp(s, { dateOffsetDays: 5 });

  // completeTargets：填妥但**未**完成——「完成申請」之計時在 Phase 2 才觸發，
  // 但 SEGMENT_ATTACHMENT_REQUIRED 於完成當下守門，故準備階段仍須先附件。
  const completeTargets = [];
  for (let i = 0; i < MUTATION_SAMPLE_N; i++) {
    const r = await createTravelApp(s, { dateOffsetDays: randInt(1, 45), withAttachment: true });
    completeTargets.push(r.appId);
  }
  const pdfTargets = [];
  for (let i = 0; i < MUTATION_SAMPLE_N; i++) {
    const r = await createTravelApp(s, {
      dateOffsetDays: randInt(1, 45),
      withAttachment: true,
      complete: true,
    });
    pdfTargets.push(r.appId);
  }
  const voidTargets = [];
  for (let i = 0; i < MUTATION_SAMPLE_N; i++) {
    const r = await createTravelApp(s, {
      dateOffsetDays: randInt(1, 45),
      withAttachment: true,
      complete: true,
      withReport: true,
    });
    voidTargets.push(r.appId);
  }
  const revisionTargets = [];
  for (let i = 0; i < MUTATION_SAMPLE_N; i++) {
    const r = await createTravelApp(s, {
      dateOffsetDays: randInt(1, 45),
      withAttachment: true,
      complete: true,
      withReport: true,
    });
    revisionTargets.push(r.appId);
  }

  return {
    session: s,
    userId: u.userId,
    draftSaveId: draftSave.appId,
    completeTargets,
    pdfTargets,
    voidTargets,
    revisionTargets,
    elapsedMs: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Phase 2：AC-17 七類場景 × N（≥5）——中位數與最大值
// ---------------------------------------------------------------------------
function summarize(samples, isSuccess = isOk) {
  const fails = samples.filter((s) => !isSuccess(s.status));
  const ms = samples.map((s) => s.ms);
  return {
    n: samples.length,
    medianMs: median(ms),
    maxMs: maxOf(ms),
    failCount: fails.length,
    fails,
  };
}
async function sampleN(n, fn, isSuccess = isOk) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const { ms, result } = await timeIt(fn);
    samples.push({ ms, status: result.status });
  }
  return summarize(samples, isSuccess);
}
async function sampleEach(ids, fn) {
  const samples = [];
  for (const id of ids) {
    const { ms, result } = await timeIt(() => fn(id));
    samples.push({ ms, status: result.status });
  }
  return summarize(samples);
}

async function measurePerformance(admin, actor, bulkUsers) {
  const results = {};

  results.list = await sampleN(SAMPLE_N, () => actor.session.call("GET", "/applications"));

  const detailId = actor.pdfTargets[0] ?? actor.completeTargets[0];
  results.detail = await sampleN(SAMPLE_N, () =>
    actor.session.call("GET", `/applications/travel/${detailId}`)
  );

  results.adminList = await sampleN(SAMPLE_N, () => admin.call("GET", "/admin/users"));

  const dateFrom = isoDateDaysAgo(60);
  const dateTo = isoDateDaysAgo(0);
  results.statistics = await sampleN(SAMPLE_N, () =>
    actor.session.call("GET", `/statistics/mileage?dateFrom=${dateFrom}&dateTo=${dateTo}`)
  );

  const savePayload = {
    tripDate: isoDateDaysAgo(5),
    purpose: "PHASE-011-T11 效能量測（重複儲存樣本）",
    segments: [
      {
        origin: "SiteA",
        destination: "SiteB",
        totalKm: "50.00",
        highwayKm: "10.00",
        attachmentIds: [],
      },
    ],
  };
  results.formSaveDraft = await sampleN(SAMPLE_N, () =>
    actor.session.call("PUT", `/applications/travel/${actor.draftSaveId}`, savePayload)
  );

  results.formComplete = await sampleEach(actor.completeTargets, (id) =>
    actor.session.call("POST", `/applications/${id}/complete`, {})
  );
  results.pdfGenerate = await sampleEach(actor.pdfTargets, (id) =>
    actor.session.call("POST", `/applications/${id}/report`, {})
  );
  results.voidApp = await sampleEach(actor.voidTargets, (id) =>
    actor.session.call("POST", `/applications/${id}/void`, {
      reason: "PHASE-011-T11 效能量測合成作廢原因",
    })
  );
  results.revision = await sampleEach(actor.revisionTargets, (id) =>
    actor.session.call("POST", `/applications/${id}/revision`, undefined)
  );

  results.auditList = await sampleN(SAMPLE_N, () => admin.call("GET", "/admin/audit-logs"));

  // D17 判定輸入之第三項（Task Packet 上游交接 #5）：「使用者刪除路徑」——
  // `DELETE /admin/users/:id` 之 `userHasHistory` 唯讀阻擋查詢（掃描
  // Application.createdById／Attachment.uploaderId／AuditLog.actorId 等，正
  // 是 D17 候選索引之消費端）。用擁有完整歷史（10 筆已完成申請＋附件＋稽核
  // 列）之批量播種使用者測，預期恆為 409（查到歷史即擋，零實際刪除、零狀
  // 態變更，可安全對多位不同使用者各測一次）——非測試載體之獨立第三項，不
  // 記入 AC-17(a)~(g) 七類表（其本身不是 AC-17 之列名場景），僅供 D17 參考。
  const deleteBlockTargets = bulkUsers.slice(0, SAMPLE_N).map((u) => u.userId);
  results.userDeleteBlockCheck = await sampleN(
    deleteBlockTargets.length,
    (() => {
      let i = 0;
      return () => admin.call("DELETE", `/admin/users/${deleteBlockTargets[i++]}`);
    })(),
    (status) => status === 409
  );

  return results;
}

// ---------------------------------------------------------------------------
// Phase 3：AC-18 — 20 併發混合負載（列表＋詳情＋草稿儲存）
// ---------------------------------------------------------------------------
async function runConcurrency(bulkUsers) {
  console.log(
    `\n=== Phase 3／AC-18：${LOAD_CONCURRENCY} 併發混合負載（≥${LOAD_DURATION_SEC}s 且 ≥200 次請求）===`
  );
  const workers = bulkUsers
    .slice(0, LOAD_CONCURRENCY)
    .filter((u) => u.sampleDetailId && u.sampleDraftId);
  if (workers.length < LOAD_CONCURRENCY) {
    console.warn(
      `  警告：可用（且同時具詳情樣本與草稿樣本）之使用者數（${workers.length}）小於目標併發數（${LOAD_CONCURRENCY}）`
    );
  }

  const deadline = performance.now() + LOAD_DURATION_SEC * 1000;
  const buckets = { list: [], detail: [], save: [] };
  const statusCounts = new Map();
  const attributions = [];
  let totalRequests = 0;

  function record(kind, status, ms, path) {
    totalRequests++;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    buckets[kind].push(ms);
    if (status >= 500) attributions.push({ kind, status, path, ms });
  }

  async function workerLoop(u) {
    const savePayload = {
      tripDate: isoDateDaysAgo(3),
      purpose: "PHASE-011-T11 併發混合負載（草稿儲存樣本）",
      segments: [
        {
          origin: "SiteA",
          destination: "SiteB",
          totalKm: "40.00",
          highwayKm: "5.00",
          attachmentIds: [],
        },
      ],
    };
    while (performance.now() < deadline) {
      let t0 = performance.now();
      let r = await u.session.call("GET", "/applications");
      record("list", r.status, performance.now() - t0, "GET /applications");

      t0 = performance.now();
      r = await u.session.call("GET", `/applications/travel/${u.sampleDetailId}`);
      record("detail", r.status, performance.now() - t0, "GET /applications/travel/:id");

      t0 = performance.now();
      r = await u.session.call("PUT", `/applications/travel/${u.sampleDraftId}`, savePayload);
      record("save", r.status, performance.now() - t0, "PUT /applications/travel/:id");
    }
  }

  const t0 = performance.now();
  await Promise.all(workers.map(workerLoop));
  const elapsedSec = (performance.now() - t0) / 1000;

  const EXPECTED_4XX = new Set([400, 401, 403, 404, 409]);
  let total5xx = 0;
  let total4xxUnexpected = 0;
  for (const [status, count] of statusCounts) {
    if (status >= 500) total5xx += count;
    else if (status >= 400 && status < 500 && !EXPECTED_4XX.has(status))
      total4xxUnexpected += count;
  }

  return {
    workerCount: workers.length,
    elapsedSec,
    totalRequests,
    statusCounts: Object.fromEntries(statusCounts),
    total5xx,
    total4xxUnexpected,
    p95: { list: p95(buckets.list), detail: p95(buckets.detail), save: p95(buckets.save) },
    attributions,
  };
}

// ---------------------------------------------------------------------------
// 報告
// ---------------------------------------------------------------------------
const TARGETS_MS = {
  list: 2000,
  detail: 2000,
  adminList: 2000,
  statistics: 3000,
  formSaveDraft: 2000,
  formComplete: 2000,
  pdfGenerate: 10000,
  voidApp: 10000,
  revision: 5000,
  auditList: 2000,
};
const LABELS = {
  list: "AC-17(a) 一般列表 — GET /applications",
  detail: "AC-17(a) 申請詳情 — GET /applications/travel/:id",
  adminList: "AC-17(a) 管理員全域列表 — GET /admin/users",
  statistics: "AC-17(b) 日期區間里程統計 — GET /statistics/mileage",
  formSaveDraft: "AC-17(c) 表單提交：草稿儲存 — PUT /applications/travel/:id",
  formComplete: "AC-17(c) 表單提交：完成申請 — POST /applications/:id/complete",
  pdfGenerate: "AC-17(d) 正式 PDF 產生 — POST /applications/:id/report",
  voidApp: "AC-17(e) 作廢（含作廢版 PDF）— POST /applications/:id/void",
  revision: "AC-17(f) 建立修正版（含附件複製）— POST /applications/:id/revision",
  auditList: "AC-17(g) 稽核列表查詢 — GET /admin/audit-logs",
};

function printReport({ spike, seedInfo, measure, load }) {
  console.log("\n=== AC-17 七類場景 × N≥5 中位數／最大值表（最大值對照目標） ===");
  let allTargetsMet = true;
  for (const key of Object.keys(LABELS)) {
    const r = measure[key];
    const target = TARGETS_MS[key];
    const pass = r.maxMs <= target && r.failCount === 0;
    if (!pass) allTargetsMet = false;
    console.log(
      `${LABELS[key]}\n  N=${r.n}  中位數=${fmt(r.medianMs)}  最大值=${fmt(r.maxMs)}  目標=${target}ms  ` +
        `失敗次數=${r.failCount}  → ${pass ? "PASS" : "FAIL"}`
    );
    if (r.failCount > 0) {
      for (const f of r.fails)
        console.log(`    失敗樣本：status=${f.status} ms=${f.ms.toFixed(0)}`);
    }
  }

  console.log("\n=== AC-18 20 併發混合負載 ===");
  console.log(
    `  實際併發數=${load.workerCount}  持續時間=${load.elapsedSec.toFixed(1)}s  總請求數=${load.totalRequests}`
  );
  console.log(`  狀態碼分佈：${JSON.stringify(load.statusCounts)}`);
  console.log(`  5xx 數=${load.total5xx}（判準：必須為 0）`);
  console.log(`  非預期 4xx 數=${load.total4xxUnexpected}（預期業務碼集合：400/401/403/404/409）`);
  console.log(
    `  p95：列表=${fmt(load.p95.list)}（對照 AC-17(a) 2000ms）　詳情=${fmt(load.p95.detail)}（對照 2000ms）　` +
      `草稿儲存=${fmt(load.p95.save)}（對照 AC-17(c) 2000ms）`
  );
  if (load.attributions.length) {
    console.log("  5xx 逐筆歸因：");
    for (const a of load.attributions)
      console.log(`    ${a.kind}  ${a.path}  status=${a.status}  ms=${a.ms.toFixed(0)}`);
  }

  const del = measure.userDeleteBlockCheck;
  console.log("\n=== D17 判定輸入之額外項：使用者刪除路徑（阻擋查詢，非 AC-17 列名場景） ===");
  console.log(
    `  DELETE /admin/users/:id（對擁有完整歷史之使用者，恆期望 409）\n  N=${del.n}  中位數=${fmt(del.medianMs)}  最大值=${fmt(del.maxMs)}  失敗次數（非 409）=${del.failCount}`
  );

  console.log("\n=== AC-17(h) 量測條件 ===");
  console.log(
    `  環境：本機 docker compose stack（COMPOSE_PROJECT_NAME=oilexpense），量測對象 ${BASE_URL}（nginx :8080 全鏈）`
  );
  console.log(
    `  資料規模：播種 ${seedInfo.userCount} 位合成使用者，各 30 筆申請（15 差旅／8 保養／7 折舊），耗時 ${(seedInfo.seedElapsedMs / 1000).toFixed(1)}s；`
  );
  console.log(
    `    另建量測固定操作者 perfmeasure，含 4 類 × ${MUTATION_SAMPLE_N} 筆專屬新鮮樣本，耗時 ${(seedInfo.actorElapsedMs / 1000).toFixed(1)}s`
  );
  console.log(
    "  量測方式：暖機後取樣（非冷啟），單一 Node 行程序列取樣（讀取類）／逐筆消耗式取樣（寫入類），取樣數見上表"
  );
  console.log(`  時點：${new Date().toISOString()}`);

  return allTargetsMet && load.total5xx === 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log("PHASE-011-T11 效能量測 harness");
  console.log(`BASE_URL=${BASE_URL}  RUN_ID=${RUN_ID}  開始時間=${new Date().toISOString()}`);
  console.log(
    `參數：N_USERS=${N_USERS} SEED_CONCURRENCY=${SEED_CONCURRENCY} SAMPLE_N=${SAMPLE_N} ` +
      `MUTATION_SAMPLE_N=${MUTATION_SAMPLE_N} LOAD_CONCURRENCY=${LOAD_CONCURRENCY} LOAD_DURATION_SEC=${LOAD_DURATION_SEC}`
  );

  const probe = new Session("probe");
  const health = await probe.call("GET", "/health");
  if (health.status !== 200) {
    console.error(
      `前置條件不足：GET /api/health 非 200（${health.status}）——stack 未就緒，本次量測拒絕出數`
    );
    process.exit(2);
  }

  const spike = await runSpike(probe);
  if (!spike.pass) {
    console.warn(
      "\n⚠ spike 未通過：依 Spec §16 D10 應改用 (b) 直打後端路徑；但本 compose stack 未將後端埠對外映射到 host"
    );
    console.warn(
      "  （docker-compose.yml 之 backend 服務僅內部埠 3000/tcp，無 host port mapping），(b) 路徑需另行網路安排——本次據實標註，續以 (a) 執行"
    );
  }

  const admin = new Session("admin");
  await login(admin, ADMIN_LOGIN, ADMIN_PASSWORD);
  await ensureGlobalParams(admin);

  console.log("\n=== Phase 1／播種：資料規模建置 ===");
  const { users: bulkUsers, elapsedMs: seedElapsedMs } = await seedBulk(admin);
  console.log(
    `  已建立 ${bulkUsers.length} 位合成使用者，耗時 ${(seedElapsedMs / 1000).toFixed(1)}s`
  );

  const actor = await seedPerfActor(admin);
  console.log(`  已建立量測固定操作者 perfmeasure，耗時 ${(actor.elapsedMs / 1000).toFixed(1)}s`);

  console.log("\n=== Phase 2／AC-17 七類場景量測 ===");
  const measure = await measurePerformance(admin, actor, bulkUsers);
  console.log("  完成（各類樣本數與結果見報告）");

  const load = await runConcurrency(bulkUsers);

  const passed = printReport({
    spike,
    seedInfo: { userCount: bulkUsers.length, seedElapsedMs, actorElapsedMs: actor.elapsedMs },
    measure,
    load,
  });

  console.log(`\n=== 完成 ${new Date().toISOString()} ===`);
  process.exit(passed ? 0 : 3);
}

main().catch((err) => {
  console.error("量測 harness 發生未預期錯誤：", err);
  process.exit(1);
});
