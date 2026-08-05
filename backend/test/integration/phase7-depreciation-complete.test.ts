/**
 * Integration tests for PHASE-007-T9 ＋ **PHASE-007-R7（折舊模型修訂段）**：
 *   折舊完成流程 ＋ 9 欄快照寫入 ＋ 原子性 ＋ 僅本人授權 ＋ 證明選填反轉 ＋
 *   新舊模型判別。
 *
 * AC covered：
 *   - **AC-27**（單一 SERIALIZABLE 交易之 §20.8.2 步驟順序）
 *   - **AC-30**（切點回滾 ＋ `P2025` 不得 500）
 *   - **AC-54**（折舊證明改選填：零附件完成 200；
 *     `DEPRECIATION_ATTACHMENT_REQUIRED` 全 `src` 掃描命中 0）
 *   - **AC-55**（修訂後快照 **9 欄** ＋ 顯式定精度 ＋ 舊二欄恆 `null` ＋
 *     三來源行內重算 ＋ `amount` 不由 `rawAmount`／`ratio` 反推）
 *   - **AC-56**（新舊模型判別：新模型列 `CURRENT`；raw SQL 播種之舊模型列
 *     `LEGACY` 且原值唯讀、零重算）
 *   併 AC-29（僅擁有人本人）、AC-16／AC-18 之**完成端點 409 段**、AC-22 之
 *   容量守門三處一致（T9b 段）。
 *
 * **不在本檔範圍**：AC-31/32/33（快照不可變、後端權威、雙完成併發）屬 R8。
 *
 * Test discipline (Spec §11.0 / Packet)：
 *   - loginName 前綴 "p7t9_" ＋ 每次執行之隨機後綴。
 *   - cleanup 僅限本檔追蹤之 id ＋ loginName 前綴；**絕不** `deleteMany({})`。
 *   - 一律合成資料（合成附件列，無真實影像、無真實個資）。
 *
 * ── 修訂段（R7）之紅燈實證 ───────────────────────────────────────────────
 *   R7 動工時 `completeDepreciationApplication` 只寫入 6 個快照欄（新模型之
 *   `snapshotAnnualDepreciation`／`snapshotAnnualTotalKm`／`snapshotRatio` 未
 *   寫入、`snapshotEstimatedAnnualKm` 仍抄自參數版本）。首條紅燈原文逐字記錄
 *   於 Handoff。
 *
 * ── 參數版本階梯（全域資料，`findEffectiveVersion` 取「生效日 ≤ 查詢日之最新
 *    者」，故一個版本會沿用至下一個版本生效為止） ─────────────────────────
 *   年度 < 2049          → 查無版本 → 409 missing=["DEPRECIATION"]
 *   2049 ≤ 年度 ≤ 2060   → V_BASE  車價 600000.00 ÷ 5 年  → A ＝ 120000.00
 *   2061 ≤ 年度 ≤ 2069   → V_KILL  車價 246899.99 ÷ 1 年  → A ＝ 246899.99
 *   2070                 → V_OVER  車價 3000000000.00 ÷ 1 → A ＝ 3000000000.00
 *   2071 ≤ 年度          → V_BAD   車價 0.00 → `deriveAnnualDepreciation` 回
 *                                   ok:false → 409 missing=
 *                                   ["DEPRECIATION_DERIVATION_FAILED"]
 *
 *   **四個版本之 `estimatedAnnualKm` 一律播成非 `null`**（模擬 §20.7.5 之
 *   「歷史版本原值保留」）。這是 AC-55(b) mutant「順手把 `version.
 *   estimatedAnnualKm` 寫進 `snapshotEstimatedAnnualKm`」之**鑑別力來源**：
 *   若播成 `null`，該 mutant 寫入 `null` 與正確實作無從區辨。
 *
 * ── 修訂後金額語意（§20.4.1；本檔所有期望值之推導） ───────────────────────
 *   `ratio     = officialKm ÷ annualTotalKm`（全精度；顯示 6dp／百分比 4dp）
 *   `rawAmount = A × officialKm ÷ annualTotalKm`（**先乘後除**，不經 ratio）
 *   `amount    = ROUND_HALF_UP(rawAmount, 0)`
 *
 * **每個測試使用互不重複的申請年度**：年度公務里程由該年度全部已完成差旅列
 * 加總而得，共用年度會使各測試互相污染金額斷言。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as depreciationParameters from "../../src/applications/depreciation-parameters.js";
import { completeDepreciationApplication } from "../../src/applications/depreciation-service.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { AppError } from "../../src/platform/errors.js";
import { buildServer } from "../../src/server.js";
import { insertLegacyDepreciationRowRaw } from "../fixtures/depreciation-legacy-row.js";

// ── T9 即審 S-1 突變自證（mutant M2／M3） ─────────────────────────────────
// 包裝**真實實作**為 spy，行為完全不變，只加可觀測性——沿
// `phase6-maintenance-complete.test.ts` 之 T7R S-3 既有慣例（該檔以同一手法
// kill mutant M6）。缺少此觀測面時，「里程與參數於同一 SERIALIZABLE 交易內
// 查詢」（AC-27）在全 Phase 無任何鑑別力：把 `tx` 改為頂層 `prisma` 後所有
// 既有斷言（金額、快照、狀態、回滾）仍全數通過，因為兩者查到的資料相同——
// 差別只在隔離級別與 write-skew 防禦，那不會顯現在結果值上。
//
// R7 增用：同一組 spy 亦為 **AC-56(d)「舊模型列不發生任何重算」**之負向觀測面
// （讀取舊模型列之 DTO 全程，兩者呼叫次數增量必為 0）。
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

vi.mock("../../src/applications/depreciation-parameters.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/applications/depreciation-parameters.js")>();
  return {
    ...actual,
    resolveDepreciationParameters: vi.fn(actual.resolveDepreciationParameters),
  };
});

/**
 * 「首引數是交易客戶端而非頂層 PrismaClient」之判準（逐字沿 006 T7R S-3）。
 *
 * `Prisma.TransactionClient` 型別上即不含 `$transaction`（denylist），頂層
 * `PrismaClient` 則有——以此區分，不依賴物件參照比較（`tx` 每次交易皆為新的
 * 代理物件，參照比較無從進行）。
 */
function expectFirstArgIsTransactionClient(firstArg: unknown, topLevel: PrismaClient): void {
  expect((firstArg as { $transaction?: unknown }).$transaction).toBeUndefined();
  expect(firstArg).not.toBe(topLevel);
}

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = path.resolve(__dirname, "../../src");

function extractCookieHeader(setCookieHeader: string | string[] | undefined): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header");
  const str = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return str.split(";")[0];
}

async function loginUser(
  app: FastifyInstance,
  loginName: string,
  password: string
): Promise<string> {
  const resp = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { loginName, password },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Login failed for ${loginName}: ${resp.statusCode} ${resp.body}`);
  }
  return extractCookieHeader(resp.headers["set-cookie"]);
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOGIN_PREFIX = "p7t9_";
const PASSWORD = "DepreciationCompleteTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

/**
 * §20.7.1 DDL 之 scale，供快照精度斷言逐欄比對（零魔術數：與 Spec 表格逐值
 * 一致）。**六個 `Decimal` 快照欄全列**（AC-55(c)）。
 */
const SNAPSHOT_SCALE = {
  vehiclePrice: 2, // Decimal(12,2)
  annualDepreciation: 2, // Decimal(12,2)
  officialKm: 2, // Decimal(12,2)
  annualTotalKm: 1, // Decimal(9,1)
  ratio: 6, // Decimal(9,6)
  rawAmount: 4, // Decimal(14,4)
} as const;

/**
 * AC-55(a) 之 **9 個快照欄**（逐字，供「漏寫其一」mutant 之機械守門）。
 * 順序與 Spec §20.3 AC-55(a) 條文一致。
 */
const SNAPSHOT_COLUMNS_9 = [
  "snapshotVehiclePrice",
  "snapshotUsefulLifeYears",
  "snapshotAnnualDepreciation",
  "snapshotOfficialKm",
  "snapshotAnnualTotalKm",
  "snapshotRatio",
  "snapshotRawAmount",
  "calculatedAt",
  "depreciationParameterVersionId",
] as const;

/** AC-55(b)：凍結唯讀之舊模型二欄——新模型列恆 `null`。 */
const FROZEN_LEGACY_COLUMNS_2 = ["snapshotEstimatedAnnualKm", "snapshotPerKmUnitPrice"] as const;

type BlockerDto = { code: string; field?: string; message: string };

/** §20.6 `DepreciationSnapshotDto`。 */
type SnapshotDto = {
  model: "CURRENT" | "LEGACY";
  annualDepreciation: string | null;
  annualTotalKm: string | null;
  ratio: string | null;
  ratioPercent: string | null;
  perKmUnitPrice: string | null;
  officialKm: string;
  rawAmount: string;
  totalAmount: number;
  calculatedAt: string;
};

type ApplicationDto = {
  id: string;
  status: string;
  applicationYear: number | null;
  annualTotalKm: string | null;
  completionBlockers: BlockerDto[] | null;
  computed: unknown;
  snapshot: SnapshotDto | null;
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: { field: string; reason: string }[];
    details?: Record<string, unknown>;
  };
};

// ===========================================================================
// AC-54(b) — `DEPRECIATION_ATTACHMENT_REQUIRED` 之全 `src` 結構性掃描
//
// 不需 DB：純檔案掃描，故置於 `describeWithDb` 之外，任何環境皆執行。
// ===========================================================================

describe("AC-54(b) — DEPRECIATION_ATTACHMENT_REQUIRED 之退場（後端 src 全庫結構性掃描）", () => {
  /** 遞迴列出 `backend/src` 之所有 `.ts` 檔（零外部相依）。 */
  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("AC-54(b)：後端 src 全庫掃描該字面值命中數 ＝ 0（含 blocker 純函式、service、route）", () => {
    const files = listSourceFiles(BACKEND_SRC);

    // 掃描面自證（防「掃了空目錄故必綠」之偽陽性）：檔數合理，且三個關鍵檔
    // 確實在掃描集合內。
    expect(files.length).toBeGreaterThan(20);
    for (const required of [
      "applications/depreciation-blockers.ts",
      "applications/depreciation-service.ts",
      "applications/routes.ts",
    ]) {
      expect(
        files.some((f) => f.replace(/\\/g, "/").endsWith(required)),
        `scan set must include ${required}`
      ).toBe(true);
    }

    const hits: string[] = [];
    for (const file of files) {
      if (fs.readFileSync(file, "utf-8").includes("DEPRECIATION_ATTACHMENT_REQUIRED")) {
        hits.push(path.relative(BACKEND_SRC, file));
      }
    }
    expect(hits).toEqual([]);
  });
});

describeWithDb("PHASE-007-T9／R7 — 折舊完成流程 ＋ 9 欄快照 ＋ 原子性 ＋ 僅本人授權", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;

  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  /** 各版本之每年折舊費用 A（＝ 車價 ÷ 年限，2dp；§20.4.1 ③）。 */
  const A_BASE = "120000.00";
  const A_KILL = "246899.99";
  const A_OVER = "3000000000.00";

  /** 超容量 fixture 之固定年度公務里程（於 `beforeAll` 播種**恰一次**）。 */
  const OVER_CAPACITY_YEAR = 2070;
  const OVER_CAPACITY_OFFICIAL_KM = "100.00";
  const OVER_CAPACITY_ANNUAL_TOTAL_KM = "100.0";

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const hash = await hashPassword(PASSWORD);
    const mkUser = (loginName: string, displayName: string, role: "USER" | "ADMIN") =>
      prisma.user.create({
        data: {
          loginName,
          displayName,
          passwordHash: hash,
          role,
          isActive: true,
          mustChangePassword: false,
        },
      });

    const owner = await mkUser(OWNER_LOGIN, "P7T9 擁有人", "USER");
    const other = await mkUser(OTHER_LOGIN, "P7T9 他人", "USER");
    const admin = await mkUser(ADMIN_LOGIN, "P7T9 管理員", "ADMIN");
    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;

    // 參數版本階梯（見檔頭）。`estimatedAnnualKm` 一律非 `null`（歷史版本形狀）
    // ——AC-55(b) mutant 之鑑別力來源。
    const versions = [
      { effectiveFrom: "2049-01-01", vehiclePrice: "600000.00", years: 5, km: 20000 },
      { effectiveFrom: "2061-01-01", vehiclePrice: "246899.99", years: 1, km: 25 },
      { effectiveFrom: "2070-01-01", vehiclePrice: "3000000000.00", years: 1, km: 1000 },
      // `deriveAnnualDepreciation` 之 `ok:false` 來源（AC-49(e)）：車價 ≤ 0。
      // 端點層擋得住此輸入，故以直寫 DB 構造——這正是 AC-49(e) 所指之「理論
      // 不可達但一旦發生一律視同缺參數」情境。
      { effectiveFrom: "2071-01-01", vehiclePrice: "0.00", years: 5, km: 20000 },
    ];
    for (const v of versions) {
      await prisma.depreciationParameterVersion.create({
        data: {
          vehiclePrice: v.vehiclePrice,
          usefulLifeYears: v.years,
          estimatedAnnualKm: v.km,
          effectiveFrom: new Date(`${v.effectiveFrom}T00:00:00.000Z`),
          createdById: adminId,
        },
      });
    }

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
    otherCookie = await loginUser(app, OTHER_LOGIN, PASSWORD);
    adminCookie = await loginUser(app, ADMIN_LOGIN, PASSWORD);

    // 超容量年度之差旅**恰播一次**（多個 describe 共用同一 fixture；若各測試
    // 各自播種，年度里程會累加而使 `officialKm` 斷言互相污染）。
    const overCapacityTravel = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${OVER_CAPACITY_YEAR}-03-03T00:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${OVER_CAPACITY_YEAR}-03-03T00:00:00.000Z`),
            snapshotTotalKm: OVER_CAPACITY_OFFICIAL_KM,
          },
        },
      },
    });
    trackApp(overCapacityTravel.id);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      const userIds = [ownerId, otherId, adminId].filter(Boolean);
      if (userIds.length > 0) {
        await prisma.depreciationParameterVersion.deleteMany({
          where: { createdById: { in: userIds } },
        });
        await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      }
      await prisma.user.deleteMany({ where: { loginName: { startsWith: LOGIN_PREFIX } } });
      await prisma.$disconnect();
    }
  });

  // ===========================================================================
  // Fixture helpers
  // ===========================================================================

  /** 已完成差旅列（年度公務里程之來源；直寫 DB 以精確控制年度與里程）。 */
  async function seedCompletedTravel(opts: {
    forOwnerId?: string;
    date: string;
    snapshotTotalKm: string;
  }): Promise<string> {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId: opts.forOwnerId ?? ownerId,
        createdById: opts.forOwnerId ?? ownerId,
        primaryDate: new Date(`${opts.date}T00:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${opts.date}T00:00:00.000Z`),
            snapshotTotalKm: opts.snapshotTotalKm,
          },
        },
      },
    });
    return trackApp(application.id);
  }

  /** 直接建立一張 `refType=DEPRECIATION` 的 `LINKED` 附件（免上傳來回）。 */
  async function linkProof(applicationId: string, forOwnerId = ownerId): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p7t9/${RUN_ID}-${createdAttachmentIds.length}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 256,
        originalFilename: "proof.jpg",
        uploaderId: forOwnerId,
        ownerId: forOwnerId,
        refType: "DEPRECIATION",
        refId: applicationId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /**
   * 經真實端點建立折舊草稿。
   *
   * `annualTotalKm`（§20.7.1／AC-47）為使用者申報之申請資料，於本檔一律**明文
   * 傳入**——修訂後之完成流程沒有它即被第 2 碼擋下（AC-53(c)）。
   */
  async function createDraft(
    applicationYear: number | null,
    annualTotalKm: string | null,
    cookie = ownerCookie
  ): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (applicationYear !== null) payload.applicationYear = applicationYear;
    if (annualTotalKm !== null) payload.annualTotalKm = annualTotalKm;

    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie },
      payload,
    });
    expect(resp.statusCode).toBe(201);
    return trackApp(resp.json<{ application: { id: string } }>().application.id);
  }

  /**
   * 建立「可完成」之草稿：年度 ＋ 年度總里程 ＋ 一張證明。
   *
   * **證明於修訂後已非完成條件**（AC-54(a)）——此處仍掛一張，是為了讓既有
   * 測試之附件面（AC-25 完成後鎖定、併發）維持原有覆蓋；「零附件亦可完成」
   * 另由 `describe("AC-54 …")` 專段證明。
   */
  async function createCompletableDraft(
    applicationYear: number,
    annualTotalKm: string,
    cookie = ownerCookie,
    forOwnerId = ownerId
  ): Promise<string> {
    const id = await createDraft(applicationYear, annualTotalKm, cookie);
    await linkProof(id, forOwnerId);
    return id;
  }

  function completeHttp(cookie: string, id: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie },
    });
  }

  function getHttp(cookie: string, id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie },
    });
  }

  /**
   * 全表資料列計數快照（T6 即審 FW-9：失敗路徑之零寫入一律以全表計數前後全等
   * 證明，而非只看目標列）。涵蓋 10 張與本流程可能相關之表。
   */
  async function tableCounts(): Promise<Record<string, number>> {
    const [
      user,
      session,
      auditLog,
      attachment,
      application,
      travelApplication,
      tripSegment,
      maintenanceApplication,
      depreciationApplication,
      depreciationParameterVersion,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.auditLog.count(),
      prisma.attachment.count(),
      prisma.application.count(),
      prisma.travelApplication.count(),
      prisma.tripSegment.count(),
      prisma.maintenanceApplication.count(),
      prisma.depreciationApplication.count(),
      prisma.depreciationParameterVersion.count(),
    ]);
    return {
      user,
      session,
      auditLog,
      attachment,
      application,
      travelApplication,
      tripSegment,
      maintenanceApplication,
      depreciationApplication,
      depreciationParameterVersion,
    };
  }

  /**
   * AC-55(b)：新模型列之凍結唯讀二欄恆 `null`。
   * 抽為共用斷言，於每一條「完成成功」之測試呼叫——「順手寫入舊二欄」之
   * mutant 因此在多條測試同時必紅（不是只有一條專門測試在守）。
   */
  async function expectFrozenLegacyColumnsNull(applicationId: string): Promise<void> {
    const row = await prisma.depreciationApplication.findUniqueOrThrow({
      where: { applicationId },
    });
    for (const column of FROZEN_LEGACY_COLUMNS_2) {
      expect(row[column], `AC-55(b): ${column} must stay NULL on new-model rows`).toBeNull();
    }
  }

  // ===========================================================================
  // AC-27 — 完成流程（分派、單一交易、§20.8.2 步驟順序）
  // ===========================================================================

  describe("AC-27 完成流程與 §20.8.2 步驟順序", () => {
    it("折舊申請經 generic 完成端點分派 → 200（修復前為 404：落入 TRAVEL 分支）", async () => {
      await seedCompletedTravel({ date: "2049-06-01", snapshotTotalKm: "100.00" });
      const id = await createCompletableDraft(2049, "1000.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);

      const dto = resp.json<{ application: ApplicationDto }>().application;
      expect(dto.status).toBe("COMPLETED");
      // A 120000.00 × 100.00 ÷ 1000.0 ＝ 12000
      expect(dto.snapshot?.totalAmount).toBe(12000);
      expect(dto.snapshot?.model).toBe("CURRENT");
      await expectFrozenLegacyColumnsNull(id);
    });

    it("完成回應不夾帶 computed，且 completionBlockers 為 null（COMPLETED 之正式契約）", async () => {
      await seedCompletedTravel({ date: "2050-03-01", snapshotTotalKm: "250.00" });
      const id = await createCompletableDraft(2050, "2500.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const dto = resp.json<{ application: ApplicationDto }>().application;
      expect(dto.computed).toBeNull();
      expect(dto.completionBlockers).toBeNull();

      // 事後重讀亦然。
      const readBack = (await getHttp(ownerCookie, id)).json<{ application: ApplicationDto }>()
        .application;
      expect(readBack.computed).toBeNull();
      expect(readBack.completionBlockers).toBeNull();
    });

    it("狀態機守門：對已完成之申請再次完成 → 403，快照與 totalAmount 逐位元不變", async () => {
      await seedCompletedTravel({ date: "2051-05-01", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2051, "100.0");
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const before = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const beforeApp = await prisma.application.findUniqueOrThrow({ where: { id } });

      const second = await completeHttp(ownerCookie, id);
      expect(second.statusCode).toBe(403);
      expect(second.json<ErrorBody>().error.code).toBe("FORBIDDEN");

      const after = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const afterApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      // 9 欄逐位元不變（不只 rawAmount——修訂後之快照為 9 欄）。
      for (const column of SNAPSHOT_COLUMNS_9) {
        expect(String(after[column]), `column ${column} must not change`).toBe(
          String(before[column])
        );
      }
      expect(afterApp.totalAmount).toBe(beforeApp.totalAmount);
      expect(afterApp.completedAt?.getTime()).toBe(beforeApp.completedAt?.getTime());
    });

    it("②先於③④：年度與年度總里程皆缺 → 400 且僅結構性兩碼（第 4~6 碼被抑制，未查詢里程與參數）", async () => {
      const id = await createDraft(null, null);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const codes = (body.error.details?.blockers as BlockerDto[]).map((b) => b.code);
      // §20.5.1 之修訂後固定順序；`DEPRECIATION_ATTACHMENT_REQUIRED` 已退場。
      expect(codes).toEqual(["YEAR_REQUIRED", "ANNUAL_TOTAL_KM_REQUIRED"]);
      expect(codes).not.toContain("PARAMETER_NOT_AVAILABLE");
      expect(codes).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
      expect(body.error.fields).toEqual([
        { field: "applicationYear", reason: "請選擇申請年度" },
        { field: "annualTotalKm", reason: "請輸入該車年度總里程" },
      ]);
    });

    it("②先於③④之鑑別：年度**無參數** ＋ 缺年度總里程 → 400 且不含 PARAMETER_NOT_AVAILABLE（結構性未過即不查參數）", async () => {
      // 2040 早於最早版本生效日 → 若先查參數必得第 4 碼；正確實作應被抑制。
      const id = await createDraft(2040, null);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const codes = (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[]).map(
        (b) => b.code
      );
      expect(codes).toEqual(["ANNUAL_TOTAL_KM_REQUIRED"]);
    });

    it("年度為 null 一律 400 YEAR_REQUIRED，**不得**映射為 409（FW：無年度即無『該年度無參數』語意）", async () => {
      const id = await createDraft(null, "1000.0");
      await linkProof(id);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.code).not.toBe("PARAMETER_NOT_AVAILABLE");
      expect((body.error.details?.blockers as BlockerDto[]).map((b) => b.code)).toEqual([
        "YEAR_REQUIRED",
      ]);
    });

    it("AC-54(e) 反轉：交易外曾有 1 張證明、完成前被刪 → 完成仍**成功 200**（附件計數已非 blocker 來源）", async () => {
      // 修訂前本 fixture 之期望為 400 `DEPRECIATION_ATTACHMENT_REQUIRED`
      // （tx 內現算之鑑別）；裁定②反轉語意後，同一 fixture 之正確期望為 200。
      await seedCompletedTravel({ date: "2066-02-01", snapshotTotalKm: "50.00" });
      const id = await createDraft(2066, "500.0");
      const attachmentId = await linkProof(id);

      const draft = (await getHttp(ownerCookie, id)).json<{ application: ApplicationDto }>()
        .application;
      expect(draft.completionBlockers).toEqual([]);

      // 完成之前附件被刪除 → 交易內現算為 0，但已與完成度脫鉤。
      await prisma.attachment.delete({ where: { id: attachmentId } });

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;
      // A 246899.99 × 50.00 ÷ 500.0 ＝ 24689.999 → 24690
      expect(snapshot?.officialKm).toBe("50.00");
      expect(snapshot?.rawAmount).toBe("24689.9990");
      expect(snapshot?.totalAmount).toBe(24690);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("COMPLETED");
      expect(
        await prisma.attachment.count({
          where: { refType: "DEPRECIATION", refId: id, status: "LINKED" },
        })
      ).toBe(0);
      await expectFrozenLegacyColumnsNull(id);
    });

    it("年度里程以擁有人為準且落在該年度：跨年度之差旅不計入（引擎唯一呼叫點，同一交易）", async () => {
      // 年度內 120.00；前一年 999.00（不得計入）；他人 777.00（不得計入）。
      await seedCompletedTravel({ date: "2052-07-01", snapshotTotalKm: "120.00" });
      await seedCompletedTravel({ date: "2048-12-31", snapshotTotalKm: "999.00" });
      await seedCompletedTravel({
        forOwnerId: otherId,
        date: "2052-07-02",
        snapshotTotalKm: "777.00",
      });
      const id = await createCompletableDraft(2052, "1200.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;
      expect(snapshot?.officialKm).toBe("120.00");
      expect(snapshot?.totalAmount).toBe(12000); // 120000 × 120 ÷ 1200
    });
  });

  // ===========================================================================
  // AC-55 — 快照 9 欄 ＋ 顯式定精度 ＋ 舊二欄恆 null ＋ amount 不得反推
  // ===========================================================================

  describe("AC-55 快照欄位與精度（9 欄）", () => {
    it("AC-55(a)(b)：9 個快照欄全部寫入且值正確；舊二欄（EstimatedAnnualKm／PerKmUnitPrice）恆 null", async () => {
      await seedCompletedTravel({ date: "2054-08-01", snapshotTotalKm: "333.33" });
      const id = await createCompletableDraft(2054, "1000.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const version = await prisma.depreciationParameterVersion.findFirstOrThrow({
        where: { effectiveFrom: new Date("2049-01-01T00:00:00.000Z") },
      });

      // ── 9 欄逐欄（「漏寫其一」之 mutant 必紅） ───────────────────────────
      expect(row.snapshotVehiclePrice?.toFixed(2)).toBe("600000.00");
      expect(row.snapshotUsefulLifeYears).toBe(5);
      expect(row.snapshotAnnualDepreciation?.toFixed(2)).toBe(A_BASE);
      expect(row.snapshotOfficialKm?.toFixed(2)).toBe("333.33");
      expect(row.snapshotAnnualTotalKm?.toFixed(1)).toBe("1000.0");
      // ratio ＝ 333.33 ÷ 1000.0 ＝ 0.33333（6dp 定寬）
      expect(row.snapshotRatio?.toFixed(6)).toBe("0.333330");
      // rawAmount ＝ 120000.00 × 333.33 ÷ 1000.0 ＝ 39999.6
      expect(row.snapshotRawAmount?.toFixed(4)).toBe("39999.6000");
      expect(row.calculatedAt).not.toBeNull();
      expect(row.depreciationParameterVersionId).toBe(version.id);

      // 機械守門：9 欄無一為 null（新增欄漏寫 → 本迴圈必紅）。
      for (const column of SNAPSHOT_COLUMNS_9) {
        expect(row[column], `AC-55(a): ${column} must be written`).not.toBeNull();
      }

      // ── AC-55(b)：舊二欄恆 null ─────────────────────────────────────────
      // 版本列之 `estimatedAnnualKm` 為非 null（20000）——「順手寫入」之 mutant
      // 會把它抄進快照，本斷言必紅。
      expect(version.estimatedAnnualKm).toBe(20000);
      expect(row.snapshotEstimatedAnnualKm).toBeNull();
      expect(row.snapshotPerKmUnitPrice).toBeNull();

      // 最終金額只落在 Application.totalAmount（不重複持久化）。
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(40000); // 39999.6 → 40000
      expect(dbApp.completedAt?.getTime()).toBe(row.calculatedAt?.getTime());

      // §20.10 揭露面：DTO 不外露車價／年限／預估年里程與版本 id。
      const bodyText = resp.body;
      expect(bodyText).not.toContain("vehiclePrice");
      expect(bodyText).not.toContain("usefulLifeYears");
      expect(bodyText).not.toContain("estimatedAnnualKm");
      expect(bodyText).not.toContain(version.id);

      // DTO 之 snapshot 五值（§20.6）。
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;
      expect(snapshot?.model).toBe("CURRENT");
      expect(snapshot?.annualDepreciation).toBe(A_BASE);
      expect(snapshot?.annualTotalKm).toBe("1000.0");
      expect(snapshot?.ratio).toBe("0.333330");
      expect(snapshot?.ratioPercent).toBe("33.3330");
      expect(snapshot?.perKmUnitPrice).toBeNull();
      expect(snapshot?.officialKm).toBe("333.33");
      expect(snapshot?.rawAmount).toBe("39999.6000");
      expect(snapshot?.totalAmount).toBe(40000);
    });

    it("AC-55(c) 顯式定精度：六個 Decimal 快照欄之小數位與 §20.7.1 DDL scale 逐欄相符（不裁尾零）", async () => {
      // ratio ＝ 10.00 ÷ 30.0 ＝ 0.3333…（無窮循環）→ 服務層必須顯式量化至
      // 6dp；未定精度而交給 Postgres 靜默捨入之實作，於本案例仍可能得到相同
      // 位數，故本組再輔以 `S-2 payload` 段之寫入前觀測（mutant M4 kill）。
      await seedCompletedTravel({ date: "2055-09-01", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2055, "30.0");
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      // 以 raw SQL 讀取字串表示，確認 Postgres 端之 scale（Decimal 物件之
      // toString 會裁尾零，故不足以證明）。
      const rows = await prisma.$queryRaw<
        {
          snapshotVehiclePrice: string;
          snapshotAnnualDepreciation: string;
          snapshotOfficialKm: string;
          snapshotAnnualTotalKm: string;
          snapshotRatio: string;
          snapshotRawAmount: string;
        }[]
      >`SELECT "snapshotVehiclePrice"::text       AS "snapshotVehiclePrice",
               "snapshotAnnualDepreciation"::text AS "snapshotAnnualDepreciation",
               "snapshotOfficialKm"::text         AS "snapshotOfficialKm",
               "snapshotAnnualTotalKm"::text      AS "snapshotAnnualTotalKm",
               "snapshotRatio"::text              AS "snapshotRatio",
               "snapshotRawAmount"::text          AS "snapshotRawAmount"
          FROM "DepreciationApplication" WHERE "applicationId" = ${id}`;
      const row = rows[0];
      const decimals = (s: string) => (s.split(".")[1] ?? "").length;
      expect(decimals(row.snapshotVehiclePrice)).toBe(SNAPSHOT_SCALE.vehiclePrice);
      expect(decimals(row.snapshotAnnualDepreciation)).toBe(SNAPSHOT_SCALE.annualDepreciation);
      expect(decimals(row.snapshotOfficialKm)).toBe(SNAPSHOT_SCALE.officialKm);
      expect(decimals(row.snapshotAnnualTotalKm)).toBe(SNAPSHOT_SCALE.annualTotalKm);
      expect(decimals(row.snapshotRatio)).toBe(SNAPSHOT_SCALE.ratio);
      expect(decimals(row.snapshotRawAmount)).toBe(SNAPSHOT_SCALE.rawAmount);

      expect(row.snapshotRatio).toBe("0.333333");
      // rawAmount ＝ 120000.00 × 10.00 ÷ 30.0 ＝ 40000（**先乘後除**之精確值）
      expect(row.snapshotRawAmount).toBe("40000.0000");
    });

    it("AC-55(e)：totalAmount／rawAmount 絕不經 snapshotRatio 重算（量化後之比例會差 0.04 元）", async () => {
      // 承上一條之同一列（2055）：
      //   先乘後除              → 120000.00 × 10.00 ÷ 30.0 ＝ 40000.0000
      //   若改經量化後之 ratio  → 120000.00 × 0.333333   ＝ 39999.9600  ← 必紅
      const rows = await prisma.depreciationApplication.findMany({
        where: { applicationYear: 2055, snapshotRatio: { not: null } },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];

      const viaRatio = (row.snapshotAnnualDepreciation as Prisma.Decimal).times(
        row.snapshotRatio as Prisma.Decimal
      );
      expect(viaRatio.toFixed(4)).toBe("39999.9600");
      expect(row.snapshotRawAmount?.toFixed(4)).toBe("40000.0000");
      expect(row.snapshotRawAmount?.toFixed(4)).not.toBe(viaRatio.toFixed(4));
    });

    it("AC-55(d) kill case：rawAmount 量化為 1234.5000 但 totalAmount 為 1234（amount 絕不由 4dp rawAmount 反推）", async () => {
      // 2061 → A 246899.99；officialKm 10.00、annualTotalKm 2000.0
      //   raw ＝ 246899.99 × 10.00 ÷ 2000.0 ＝ 1234.49995（未量化）
      await seedCompletedTravel({ date: "2061-04-01", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2061, "2000.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;

      expect(snapshot?.annualDepreciation).toBe(A_KILL);
      expect(snapshot?.annualTotalKm).toBe("2000.0");
      expect(snapshot?.ratio).toBe("0.005000");
      expect(snapshot?.rawAmount).toBe("1234.5000"); // 4dp ROUND_HALF_UP 之量化
      // 反推實作（round(1234.5000) = 1235）必紅；正確實作取未量化之
      // rawAmount（1234.49995）→ 1234。
      expect(snapshot?.totalAmount).toBe(1234);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.totalAmount).toBe(1234);
      await expectFrozenLegacyColumnsNull(id);
    });

    it("AC-55(d)：三來源（annualDepreciation／officialKm／annualTotalKm）行內重算逐位元還原 rawAmount 與 totalAmount", async () => {
      await seedCompletedTravel({ date: "2056-04-01", snapshotTotalKm: "1234.56" });
      const id = await createCompletableDraft(2056, "10000.0");
      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });

      // **只用三個來源欄**（AC-55(d)(e)：重算路徑不得經過 snapshotRatio）。
      const recomputedRaw = (row.snapshotAnnualDepreciation as Prisma.Decimal)
        .times(row.snapshotOfficialKm as Prisma.Decimal)
        .div(row.snapshotAnnualTotalKm as Prisma.Decimal);

      expect(recomputedRaw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4)).toBe(
        row.snapshotRawAmount?.toFixed(4)
      );
      expect(recomputedRaw.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()).toBe(
        dbApp.totalAmount
      );
      // 120000.00 × 1234.56 ÷ 10000.0 ＝ 14814.72
      expect(row.snapshotRawAmount?.toFixed(4)).toBe("14814.7200");
      expect(row.snapshotRatio?.toFixed(6)).toBe("0.123456");
      expect(dbApp.totalAmount).toBe(14815);
    });
  });

  // ===========================================================================
  // AC-56 — 新舊模型判別（新模型列 CURRENT；raw SQL 舊模型列 LEGACY 唯讀）
  // ===========================================================================

  describe("AC-56 新舊模型判別", () => {
    it("AC-56(a)(b)(c)：經完成流程產生之列為新模型 → snapshotAnnualTotalKm != null、DTO model=CURRENT、perKmUnitPrice 為 null", async () => {
      await seedCompletedTravel({ date: "2067-05-05", snapshotTotalKm: "100.00" });
      const id = await createCompletableDraft(2067, "250.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;

      expect(snapshot?.model).toBe("CURRENT");
      expect(snapshot?.perKmUnitPrice).toBeNull();
      expect(snapshot?.annualDepreciation).toBe(A_KILL);
      expect(snapshot?.annualTotalKm).toBe("250.0");
      expect(snapshot?.ratio).toBe("0.400000");
      expect(snapshot?.ratioPercent).toBe("40.0000");
      // 246899.99 × 100.00 ÷ 250.0 ＝ 98759.996
      expect(snapshot?.rawAmount).toBe("98759.9960");
      expect(snapshot?.totalAmount).toBe(98760);

      // §20.7.4 判別述詞於 DB 層直接成立。
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotAnnualTotalKm).not.toBeNull();
      expect(row.snapshotPerKmUnitPrice).toBeNull();
      expect(row.snapshotEstimatedAnnualKm).toBeNull();
    });

    it("AC-56(d)：raw SQL 播種之舊模型列 → DTO model=LEGACY、perKmUnitPrice 為原值、新模型四值皆 null，且**零重算**（spy 呼叫增量 0）", async () => {
      // FW-8：Prisma Client 之型別已含新 4 欄，無法製造 M2 前之列形狀，故一律
      // 以共用之 raw SQL fixture 播種（`test/fixtures/depreciation-legacy-row.ts`
      // ——與 `phase7-migration-safety.test.ts` 同一份 SQL 形狀，零重複實作）。
      const parent = await prisma.application.create({
        data: {
          type: "DEPRECIATION",
          status: "COMPLETED",
          ownerId,
          createdById: ownerId,
          primaryDate: new Date("2035-01-01T00:00:00.000Z"),
          totalAmount: 4500,
          completedAt: new Date("2035-02-02T03:04:05.678Z"),
        },
      });
      trackApp(parent.id);

      await insertLegacyDepreciationRowRaw(prisma, {
        applicationId: parent.id,
        applicationYear: 2035,
        snapshotVehiclePrice: "500000.00",
        snapshotUsefulLifeYears: 5,
        snapshotEstimatedAnnualKm: 20000,
        snapshotPerKmUnitPrice: "5.0000",
        snapshotOfficialKm: "900.00",
        snapshotRawAmount: "4500.0000",
        calculatedAt: new Date("2035-02-02T03:04:05.678Z"),
        depreciationParameterVersionId: null,
      });

      // 判別述詞之 DB 層自證（§20.7.4 舊模型列）。
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: parent.id },
      });
      expect(row.snapshotPerKmUnitPrice).not.toBeNull();
      expect(row.snapshotAnnualTotalKm).toBeNull();
      expect(row.snapshotAnnualDepreciation).toBeNull();
      expect(row.snapshotRatio).toBeNull();
      expect(row.annualTotalKm).toBeNull();

      // ── 零重算之負向 spy（讀取全程，兩個查詢／推導入口皆零呼叫）───────
      const mileageSpy = vi.mocked(mileageEngine.sumOfficialMileage);
      const paramsSpy = vi.mocked(depreciationParameters.resolveDepreciationParameters);
      const mileageBefore = mileageSpy.mock.calls.length;
      const paramsBefore = paramsSpy.mock.calls.length;

      const resp = await getHttp(ownerCookie, parent.id);
      expect(resp.statusCode).toBe(200);

      expect(mileageSpy.mock.calls.length).toBe(mileageBefore);
      expect(paramsSpy.mock.calls.length).toBe(paramsBefore);

      // ── 舊模型列一律以快照原值呈現（BE-US-14 第 3 條逐字）──────────────
      const dto = resp.json<{ application: ApplicationDto }>().application;
      expect(dto.status).toBe("COMPLETED");
      expect(dto.annualTotalKm).toBeNull();
      expect(dto.computed).toBeNull();

      const snapshot = dto.snapshot;
      expect(snapshot?.model).toBe("LEGACY");
      expect(snapshot?.perKmUnitPrice).toBe("5.0000");
      expect(snapshot?.annualDepreciation).toBeNull();
      expect(snapshot?.annualTotalKm).toBeNull();
      expect(snapshot?.ratio).toBeNull();
      expect(snapshot?.ratioPercent).toBeNull();
      // 兩模型共有欄位仍為原值（未被以新模型重算）。
      expect(snapshot?.officialKm).toBe("900.00");
      expect(snapshot?.rawAmount).toBe("4500.0000");
      expect(snapshot?.totalAmount).toBe(4500);
      expect(snapshot?.calculatedAt).toBe("2035-02-02T03:04:05.678Z");

      // 揭露面：舊模型列亦不外露車價／年限／預估年里程。
      expect(resp.body).not.toContain("vehiclePrice");
      expect(resp.body).not.toContain("usefulLifeYears");
      expect(resp.body).not.toContain("estimatedAnnualKm");
    });
  });

  // ===========================================================================
  // 完成端點之 409（AC-16／AC-18 之完成端點段，§20.5.1／§16 D5(a)）
  // ===========================================================================

  describe("完成端點 409 PARAMETER_NOT_AVAILABLE（兩來源逐字互異）", () => {
    it('查無有效版本 → 409 ＋ details.missing=["DEPRECIATION"] ＋ details.applicationYear', async () => {
      const id = await createCompletableDraft(2040, "1000.0");

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(409);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("PARAMETER_NOT_AVAILABLE");
      expect(body.error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(body.error.details?.applicationYear).toBe(2040);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
    });

    it('版本存在但推導失敗 → 409 ＋ details.missing=["DEPRECIATION_DERIVATION_FAILED"]，訊息與前者逐字互異', async () => {
      const missingId = await createCompletableDraft(2041, "1000.0");
      const failedId = await createCompletableDraft(2075, "1000.0");

      const missingResp = await completeHttp(ownerCookie, missingId);
      const failedResp = await completeHttp(ownerCookie, failedId);

      expect(missingResp.statusCode).toBe(409);
      expect(failedResp.statusCode).toBe(409);

      const missingBody = missingResp.json<ErrorBody>();
      const failedBody = failedResp.json<ErrorBody>();

      expect(missingBody.error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(failedBody.error.details?.missing).toEqual(["DEPRECIATION_DERIVATION_FAILED"]);
      expect(failedBody.error.details?.applicationYear).toBe(2075);

      // 逐字互異（兩種情境之管理員行動不同）。
      expect(failedBody.error.message).not.toBe(missingBody.error.message);
      expect(failedBody.error.message.length).toBeGreaterThan(0);
      expect(missingBody.error.message.length).toBeGreaterThan(0);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id: failedId } });
      expect(dbApp.status).toBe("DRAFT");
    });

    it("missing 陣列不跨呼叫共用參考：連續兩次缺參數完成之 details.missing 逐次獨立且穩定", async () => {
      const first = await createCompletableDraft(2042, "1000.0");
      const second = await createCompletableDraft(2043, "1000.0");

      const r1 = await completeHttp(ownerCookie, first);
      const r2 = await completeHttp(ownerCookie, second);
      expect(r1.json<ErrorBody>().error.details?.missing).toEqual(["DEPRECIATION"]);
      expect(r2.json<ErrorBody>().error.details?.missing).toEqual(["DEPRECIATION"]);
    });

    it("缺參數之 409 失敗路徑：全表資料列計數前後全等（零寫入）", async () => {
      const id = await createCompletableDraft(2044, "1000.0");
      const before = await tableCounts();

      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(409);

      expect(await tableCounts()).toEqual(before);
    });
  });

  // ===========================================================================
  // AMOUNT_OUT_OF_RANGE → 400（寫入前拒絕）
  //
  // §20.7.2（修訂後）：新公式下 `rawAmount = A × ratio` 且比例 >100% 已由
  // AC-52 擋下，故 `rawAmount < 1e10` **恆成立**、`snapshotRawAmount` 之溢位
  // **不再可達**（開發段之「4dp 量化窄窗」情境隨之結構性消失）。仍可達者只有
  // `totalAmount` 超 `int4`（車價 ≥ 2.15e9 且比例接近 1），故本段以該情境守門，
  // 並就地實證「rawAmount 仍在 Decimal(14,4) 容量內 ⇒ Postgres 22003 不可達
  // ⇒ 400 而非 500」。
  // ===========================================================================

  describe("AMOUNT_OUT_OF_RANGE 之完成端點拒絕", () => {
    it("金額超出 int4 → 400 VALIDATION_ERROR ＋ blockers=[AMOUNT_OUT_OF_RANGE]，全表零寫入", async () => {
      const id = await createCompletableDraft(OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM);

      const before = await tableCounts();
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect((body.error.details?.blockers as BlockerDto[]).map((b) => b.code)).toEqual([
        "AMOUNT_OUT_OF_RANGE",
      ]);

      expect(await tableCounts()).toEqual(before);
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      for (const column of SNAPSHOT_COLUMNS_9) {
        expect(row[column], `${column} must stay NULL on a rejected completion`).toBeNull();
      }
    });

    it("rawAmount 仍在 Decimal(14,4) 容量內（比例 ≤ 100% ⇒ raw ≤ A < 1e10）→ 400 而非 500（Postgres 22003 不可達）", async () => {
      // fixture 自證：A ＝ 3000000000.00、officialKm ＝ annualTotalKm ⇒ ratio ＝ 1
      //   raw    ＝ 3000000000.0000 < 1e10  ← Decimal(14,4) 容納得下
      //   amount ＝ 3000000000 > 2147483647 ← int4 容納不下 ⇒ 唯一之超容量來源
      const a = new Prisma.Decimal(A_OVER);
      const raw = a
        .times(new Prisma.Decimal(OVER_CAPACITY_OFFICIAL_KM))
        .div(new Prisma.Decimal(OVER_CAPACITY_ANNUAL_TOTAL_KM));
      expect(raw.toFixed(4)).toBe("3000000000.0000");
      expect(raw.lessThan(new Prisma.Decimal("1e10"))).toBe(true);
      expect(
        raw
          .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
          .greaterThan(new Prisma.Decimal("2147483647"))
      ).toBe(true);

      const id = await createCompletableDraft(OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM);
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).not.toBe(500);
      expect(resp.statusCode).toBe(400);
      expect(
        (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[]).map((b) => b.code)
      ).toEqual(["AMOUNT_OUT_OF_RANGE"]);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotRawAmount).toBeNull();
    });
  });

  // ===========================================================================
  // AC-29 — 完成僅本人（管理員亦 403）
  // ===========================================================================

  describe("AC-29 完成授權：僅擁有人本人", () => {
    it("管理員完成他人折舊草稿 → 403 FORBIDDEN、DB 零寫入；對照組本人 → 200", async () => {
      await seedCompletedTravel({ date: "2057-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2057, "300.0");

      const before = await prisma.application.findUniqueOrThrow({ where: { id } });
      const counts = await tableCounts();

      const adminResp = await completeHttp(adminCookie, id);
      expect(adminResp.statusCode).toBe(403);
      expect(adminResp.json<ErrorBody>().error.code).toBe("FORBIDDEN");

      expect(await tableCounts()).toEqual(counts);
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("DRAFT");
      expect(after.totalAmount).toBeNull();
      expect(after.completedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      // 對照組：本人完成 → 200。120000 × 30 ÷ 300 ＝ 12000
      const ownerResp = await completeHttp(ownerCookie, id);
      expect(ownerResp.statusCode).toBe(200);
      expect(
        ownerResp.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount
      ).toBe(12000);
    });

    it("一般他人完成 → 403（不因資源存在與否洩漏）", async () => {
      await seedCompletedTravel({ date: "2058-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2058, "300.0");

      const resp = await completeHttp(otherCookie, id);
      expect(resp.statusCode).toBe(403);
      expect(resp.json<ErrorBody>().error.code).toBe("FORBIDDEN");
      expect((await prisma.application.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    });

    it("管理員代操作端點不提供代完成路徑（負向斷言）", async () => {
      await seedCompletedTravel({ date: "2059-02-02", snapshotTotalKm: "30.00" });
      const id = await createCompletableDraft(2059, "300.0");

      for (const url of [
        `/admin/applications/${id}/complete`,
        `/admin/users/${ownerId}/applications/${id}/complete`,
        `/admin/users/${ownerId}/applications/depreciation/${id}/complete`,
      ]) {
        const resp = await app.inject({ method: "POST", url, headers: { cookie: adminCookie } });
        expect(resp.statusCode).toBe(404);
      }
      expect((await prisma.application.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
    });
  });

  // ===========================================================================
  // AC-30 — 原子性（切點回滾、P2025 不得 500）
  // ===========================================================================

  describe("AC-30 原子性", () => {
    it("快照寫入後、狀態轉換前注入失敗 → 全交易回滾（status 仍 DRAFT、**9 欄 ＋ 舊二欄**全 null、totalAmount 仍 null、附件仍可刪）", async () => {
      await seedCompletedTravel({ date: "2060-10-10", snapshotTotalKm: "80.00" });
      const id = await createDraft(2060, "800.0");
      const attachmentId = await linkProof(id);

      const injectedMessage = "PHASE-007-T9-INJECTED-ATOMICITY-TEST-FAILURE";
      await expect(
        completeDepreciationApplication(prisma, id, {
          __testOnlyFailAfterSnapshotWrite: () => {
            throw new Error(injectedMessage);
          },
        })
      ).rejects.toThrow(injectedMessage);

      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      // 回滾斷言涵蓋 **R7 新增之 4 欄**（`snapshotAnnualDepreciation`／
      // `snapshotAnnualTotalKm`／`snapshotRatio` 於 9 欄清單內；`annualTotalKm`
      // 為業務欄，見下方）。
      for (const column of [...SNAPSHOT_COLUMNS_9, ...FROZEN_LEGACY_COLUMNS_2]) {
        expect(row[column], `${column} must be rolled back to NULL`).toBeNull();
      }
      // 業務欄（使用者申報之申請資料）**不在**回滾範圍——它於草稿階段即已持久
      // 化，完成失敗不得把它一起清掉（防「回滾過頭」之反向 mutant）。
      expect(row.annualTotalKm?.toFixed(1)).toBe("800.0");

      // 附件仍可刪（容器仍為草稿）。
      const delResp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachmentId}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(200);
    });

    it("反向對照：不注入失敗 → 快照與狀態全部正確落地", async () => {
      await seedCompletedTravel({ date: "2062-11-11", snapshotTotalKm: "90.00" });
      const id = await createCompletableDraft(2062, "100.0");

      const record = await completeDepreciationApplication(prisma, id);
      expect(record.status).toBe("COMPLETED");
      // 246899.99 × 90.00 ÷ 100.0 ＝ 222209.991
      expect(record.totalAmount).toBe(222210);
      expect(record.completedAt).not.toBeNull();
      expect(record.depreciation?.snapshotAnnualDepreciation?.toFixed(2)).toBe(A_KILL);
      expect(record.depreciation?.snapshotOfficialKm?.toFixed(2)).toBe("90.00");
      expect(record.depreciation?.snapshotAnnualTotalKm?.toFixed(1)).toBe("100.0");
      expect(record.depreciation?.snapshotRatio?.toFixed(6)).toBe("0.900000");
      expect(record.depreciation?.snapshotRawAmount?.toFixed(4)).toBe("222209.9910");
      await expectFrozenLegacyColumnsNull(id);
    });

    it("P2025（完成中被刪）→ 404 AppError，不得以 500 呈現", async () => {
      const id = await createCompletableDraft(2049, "1000.0");
      await prisma.application.delete({ where: { id } });

      let caught: unknown;
      try {
        await completeDepreciationApplication(prisma, id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).httpStatus).toBe(404);
      expect((caught as AppError).code).toBe("NOT_FOUND");
      expect((caught as AppError).httpStatus).not.toBe(500);
    });
  });

  // ===========================================================================
  // T9 即審 S-1 — 里程與參數皆於同一交易內查詢（AC-27 之鑑別力）
  //
  // 手法逐字沿 006 T7R S-3（`phase6-maintenance-complete.test.ts`）：spy 包裝
  // 真實實作，取最後一次呼叫之首引數，斷言其為交易客戶端而非頂層 PrismaClient。
  // ===========================================================================

  describe("S-1 完成路徑同 tx 呼叫（mutant M2／M3 kill）", () => {
    it("M3：completeDepreciationApplication 呼叫 sumOfficialMileage 之首引數為 tx，非頂層 prisma", async () => {
      await seedCompletedTravel({ date: "2053-09-09", snapshotTotalKm: "25.00" });
      const id = await createCompletableDraft(2053, "250.0");

      const spy = vi.mocked(mileageEngine.sumOfficialMileage);
      const callsBefore = spy.mock.calls.length;

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      expectFirstArgIsTransactionClient(spy.mock.calls.at(-1)?.[0], prisma);
    });

    it("M2：completeDepreciationApplication 呼叫 resolveDepreciationParameters 之首引數為 tx，非頂層 prisma", async () => {
      await seedCompletedTravel({ date: "2056-09-09", snapshotTotalKm: "25.00" });
      // 2056 之年度里程於此已累積為 1234.56 ＋ 25.00 ＝ 1259.56；本條只驗證
      // 首引數，不斷言金額，故 `annualTotalKm` 取一個 ≥ 該值之整數即可。
      const id = await createCompletableDraft(2056, "2000.0");

      const spy = vi.mocked(depreciationParameters.resolveDepreciationParameters);
      const callsBefore = spy.mock.calls.length;

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(callsBefore + 1);

      expectFirstArgIsTransactionClient(spy.mock.calls.at(-1)?.[0], prisma);
    });
  });

  // ===========================================================================
  // T9 即審 S-2 — 快照寫入 payload 之顯式量化（AC-55(c) 之鑑別力）
  //
  // 既有之 `::text` 小數位斷言對 mutant M4（快照欄去量化直寫）**恆真**：
  // `numeric(p,s)` 讀出必為 s 位，且 Postgres 之捨入與 `ROUND_HALF_UP` 同向，
  // 故 DB 端無從區分「服務層已量化」與「交給 Postgres 靜默量化」（T1 FW-3）。
  // 本組改為觀測**寫入 payload 本身**（Prisma middleware，不改 src、不耦合實作
  // 細節：只斷言送進 DB 的值已是目標精度，不規定用哪個 API 達成）。
  // ===========================================================================

  describe("S-2 快照寫入 payload 已於服務層量化（mutant M4 kill）", () => {
    it("送進 depreciationApplication.update 之六個 Decimal 欄，小數位皆已 ≤ §20.7.1 DDL scale（未量化直寫必紅）", async () => {
      // 2061 → A 246899.99；officialKm 0.50、annualTotalKm 2000.0
      //   rawAmount ＝ 246899.99 × 0.50 ÷ 2000.0 ＝ 61.7249975（**7dp**）
      //   ratio     ＝ 0.50 ÷ 2000.0            ＝ 0.00025
      // ——未量化直寫時 rawAmount 之 payload 為 7dp，超過其 scale 4。
      //
      // 本 fixture 掛在**另一位擁有人**（`otherId`）名下：年度公務里程之加總為
      // 擁有人範圍（AC-14），故 2061 年之 V_KILL 版本可與既有 owner 案例共用而
      // 互不污染。
      await seedCompletedTravel({
        forOwnerId: otherId,
        date: "2061-09-09",
        snapshotTotalKm: "0.50",
      });
      const id = await createCompletableDraft(2061, "2000.0", otherCookie, otherId);

      const payloads: Record<string, unknown>[] = [];
      prisma.$use(async (params, next) => {
        if (params.model === "DepreciationApplication" && params.action === "update") {
          payloads.push(params.args.data as Record<string, unknown>);
        }
        return next(params);
      });

      // 直接呼叫服務層（本檔之 prisma 實例才掛得上 middleware）。
      const record = await completeDepreciationApplication(prisma, id);
      expect(record.status).toBe("COMPLETED");

      expect(payloads.length).toBe(1);
      const data = payloads[0];

      const decimalPlacesOf = (value: unknown): number =>
        new Prisma.Decimal(value as Prisma.Decimal).decimalPlaces();

      // 判別力來源：rawAmount 之真值為 7dp，量化後為 4dp。
      expect(decimalPlacesOf(data.snapshotRawAmount)).toBeLessThanOrEqual(SNAPSHOT_SCALE.rawAmount);
      expect(new Prisma.Decimal(data.snapshotRawAmount as Prisma.Decimal).toFixed(4)).toBe(
        "61.7250"
      );

      // 其餘五欄之來源天然即為目標 scale（參數表 2dp／引擎 2dp／里程和 2dp／
      // 申報值 1dp／`ratioString` 已 6dp），故對 M4 為等價變異——一併斷言以
      // 固定「送進 DB 的值即為目標精度」之契約。
      expect(decimalPlacesOf(data.snapshotVehiclePrice)).toBeLessThanOrEqual(
        SNAPSHOT_SCALE.vehiclePrice
      );
      expect(decimalPlacesOf(data.snapshotAnnualDepreciation)).toBeLessThanOrEqual(
        SNAPSHOT_SCALE.annualDepreciation
      );
      expect(decimalPlacesOf(data.snapshotOfficialKm)).toBeLessThanOrEqual(
        SNAPSHOT_SCALE.officialKm
      );
      expect(decimalPlacesOf(data.snapshotAnnualTotalKm)).toBeLessThanOrEqual(
        SNAPSHOT_SCALE.annualTotalKm
      );
      expect(decimalPlacesOf(data.snapshotRatio)).toBeLessThanOrEqual(SNAPSHOT_SCALE.ratio);

      // AC-55(b)：payload 層即明文寫 `null`（「順手寫入舊二欄」之 mutant 於此
      // 亦必紅——payload 會出現非 null 值）。
      for (const column of FROZEN_LEGACY_COLUMNS_2) {
        expect(data[column], `AC-55(b): payload.${column} must be null`).toBeNull();
      }

      // 量化僅作用於寫入呈現，`totalAmount` 仍取自未量化之 rawAmount。
      expect(record.totalAmount).toBe(62); // round(61.7249975)
    });
  });

  // ===========================================================================
  // T8 移交（AC-25 真實流程重驗）＋ T5 移交（AC-08 兩筆皆可完成）
  // ===========================================================================

  describe("跨 Task 移交項", () => {
    it("經真實完成端點完成之折舊，其證明附件 DELETE → 403（AC-25／AC-54(d) 真實流程重驗）", async () => {
      await seedCompletedTravel({ date: "2063-06-06", snapshotTotalKm: "60.00" });
      const id = await createDraft(2063, "600.0");
      const attachmentId = await linkProof(id);

      // 完成前可刪之對照（另一張）。
      const spareId = await linkProof(id);
      const spareDel = await app.inject({
        method: "DELETE",
        url: `/attachments/${spareId}`,
        headers: { cookie: ownerCookie },
      });
      expect(spareDel.statusCode).toBe(200);

      expect((await completeHttp(ownerCookie, id)).statusCode).toBe(200);

      const delResp = await app.inject({
        method: "DELETE",
        url: `/attachments/${attachmentId}`,
        headers: { cookie: ownerCookie },
      });
      expect(delResp.statusCode).toBe(403);
      const still = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(still.status).toBe("LINKED");
      expect(still.refId).toBe(id);
    });

    it("AC-08：同一擁有人同年度兩筆折舊申請**皆可完成**（皆 200，無唯一約束）", async () => {
      await seedCompletedTravel({ date: "2064-06-06", snapshotTotalKm: "70.00" });
      const first = await createCompletableDraft(2064, "700.0");
      const second = await createCompletableDraft(2064, "700.0");

      const r1 = await completeHttp(ownerCookie, first);
      const r2 = await completeHttp(ownerCookie, second);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      // 246899.99 × 70.00 ÷ 700.0 ＝ 24689.999 → 24690
      expect(r1.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount).toBe(
        24690
      );
      expect(r2.json<{ application: ApplicationDto }>().application.snapshot?.totalAmount).toBe(
        24690
      );
    });

    it("完成 vs 刪除證明附件之併發：12 輪皆不得 500；完成一律成功（證明改選填後不再互斥）", async () => {
      // 修訂前之期望為「恰一方成功」（附件刪除會使完成失去必要條件）；裁定②
      // 反轉後，兩者不再互斥——完成恆成功，刪除視 SSI 競態與完成鎖定而定。
      // **不得 500** 之守門與 SERIALIZABLE 重試路徑則零變更。
      await seedCompletedTravel({ date: "2065-06-06", snapshotTotalKm: "40.00" });

      for (let round = 0; round < 12; round++) {
        const id = await createDraft(2065, "400.0");
        const attachmentId = await linkProof(id);

        const [completeResp, deleteResp] = await Promise.all([
          completeHttp(ownerCookie, id),
          app.inject({
            method: "DELETE",
            url: `/attachments/${attachmentId}`,
            headers: { cookie: ownerCookie },
          }),
        ]);

        expect(completeResp.statusCode, `round ${round} complete`).toBeLessThan(500);
        expect(deleteResp.statusCode, `round ${round} delete`).toBeLessThan(500);
        expect(
          completeResp.statusCode,
          `round ${round}: complete=${completeResp.statusCode} delete=${deleteResp.statusCode}`
        ).toBe(200);

        // 事後 DB 狀態：完成一律落地；附件則視刪除是否搶在完成鎖定之前。
        const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
        expect(dbApp.status).toBe("COMPLETED");
        expect(dbApp.totalAmount).toBe(24690); // 246899.99 × 40.00 ÷ 400.0
        const linked = await prisma.attachment.count({
          where: { refType: "DEPRECIATION", refId: id, status: "LINKED" },
        });
        expect(linked).toBe(deleteResp.statusCode === 200 ? 0 : 1);
      }
    });
  });

  // ===========================================================================
  // PHASE-007-T9b — AC-22（整合層，容量守門三處一致）
  //
  // 年度：`OVER_CAPACITY_YEAR`（2070，V_OVER）之差旅於 `beforeAll` 播種**恰
  // 一次**（officialKm 恆為 100.00）；防誤殺對照組落在 2068（V_KILL）。
  // ===========================================================================

  /**
   * `depreciation-blockers.ts` 之 blocker 文案（zh-TW）。三處（草稿 DTO 之
   * `completionBlockers`、完成端點之 `details.blockers`、以及──就 code 而言──
   * 預覽之 `blockingCodes`）皆源自同一純函式，本常數用於**逐字**固定該對外
   * 文案，任一處漂移即紅。
   */
  const BLOCKER_MESSAGE = {
    AMOUNT_OUT_OF_RANGE: "計算結果超出可儲存之金額範圍，請聯絡管理員檢查折舊參數",
  } as const;

  /** §20.6 `DepreciationComputedDto`（預覽回應與草稿 DTO 之 `computed` 同型）。 */
  type ComputedDto = {
    calculable: boolean;
    annualDepreciation: string | null;
    officialKm: string | null;
    officialApplicationCount: number | null;
    annualTotalKm: string | null;
    ratio: string | null;
    ratioPercent: string | null;
    rawAmount: string | null;
    amount: number | null;
    blockingCodes: string[];
  };

  type DraftDto = ApplicationDto & {
    attachments: { id: string }[];
    computed: ComputedDto | null;
  };

  function previewHttp(
    cookie: string,
    applicationYear: number | null,
    annualTotalKm: string | null
  ) {
    const payload: Record<string, unknown> = {};
    if (applicationYear !== null) payload.applicationYear = applicationYear;
    if (annualTotalKm !== null) payload.annualTotalKm = annualTotalKm;
    return app.inject({
      method: "POST",
      url: "/applications/depreciation/preview",
      headers: { cookie },
      payload,
    });
  }

  async function readPreview(
    cookie: string,
    applicationYear: number,
    annualTotalKm: string
  ): Promise<ComputedDto> {
    const resp = await previewHttp(cookie, applicationYear, annualTotalKm);
    expect(resp.statusCode).toBe(200);
    return resp.json<{ preview: ComputedDto }>().preview;
  }

  async function readDraft(cookie: string, id: string): Promise<DraftDto> {
    const resp = await getHttp(cookie, id);
    expect(resp.statusCode).toBe(200);
    return resp.json<{ application: DraftDto }>().application;
  }

  describe("PHASE-007-T9b — AC-22 容量守門三處一致", () => {
    it("超容量之同一 fixture：預覽／草稿／完成三處同步暴露 AMOUNT_OUT_OF_RANGE ＋ calculable=false，完成 400 且全表零寫入", async () => {
      const id = await createCompletableDraft(OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM);

      // ── 第 1 處：預覽（stateless，AC-22(c)）─────────────────────────────
      const preview = await readPreview(
        ownerCookie,
        OVER_CAPACITY_YEAR,
        OVER_CAPACITY_ANNUAL_TOTAL_KM
      );
      expect(preview.calculable).toBe(false);
      expect(preview.blockingCodes).toEqual(["AMOUNT_OUT_OF_RANGE"]);
      expect(preview.officialKm).toBe(OVER_CAPACITY_OFFICIAL_KM);
      expect(preview.officialApplicationCount).toBe(1);
      expect(preview.annualDepreciation).toBe(A_OVER);
      expect(preview.annualTotalKm).toBe(OVER_CAPACITY_ANNUAL_TOTAL_KM);
      // 比例仍如實揭露（顯示值不因金額超容量而消失）。
      expect(preview.ratio).toBe("1.000000");
      // 存不進去的金額一律不呈現（不得靜默截斷後顯示）。
      expect(preview.rawAmount).toBeNull();
      expect(preview.amount).toBeNull();

      // ── 第 2 處：草稿 DTO（AC-22(c)）───────────────────────────────────
      const draft = await readDraft(ownerCookie, id);
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(preview.blockingCodes);
      expect(draft.computed?.rawAmount).toBeNull();
      expect(draft.computed?.amount).toBeNull();
      expect(draft.completionBlockers).toEqual([
        { code: "AMOUNT_OUT_OF_RANGE", message: BLOCKER_MESSAGE.AMOUNT_OUT_OF_RANGE },
      ]);
      expect(draft.snapshot).toBeNull();

      // ── 第 3 處：完成端點（AC-22(b)：寫入前拒絕、4xx、零寫入）──────────
      const before = await tableCounts();
      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).not.toBe(500);
      expect(resp.statusCode).toBe(400);
      const body = resp.json<ErrorBody>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details?.blockers).toEqual([
        { code: "AMOUNT_OUT_OF_RANGE", message: BLOCKER_MESSAGE.AMOUNT_OUT_OF_RANGE },
      ]);

      expect(await tableCounts()).toEqual(before);
      const dbApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(dbApp.status).toBe("DRAFT");
      expect(dbApp.totalAmount).toBeNull();
      expect(dbApp.completedAt).toBeNull();
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.snapshotRawAmount).toBeNull();
      expect(row.calculatedAt).toBeNull();

      // 完成被拒後三處仍一致（拒絕不改變任何一處之呈現）。
      const draftAfter = await readDraft(ownerCookie, id);
      expect(draftAfter.computed?.calculable).toBe(false);
      expect(draftAfter.completionBlockers).toEqual(draft.completionBlockers);
      expect(
        (await readPreview(ownerCookie, OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM))
          .blockingCodes
      ).toEqual(["AMOUNT_OUT_OF_RANGE"]);
    });

    it("AMOUNT_OUT_OF_RANGE 之文案於草稿與完成兩處逐字一致；預覽依契約僅暴露 code（無 message 欄）", async () => {
      const id = await createCompletableDraft(OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM);

      const draft = await readDraft(ownerCookie, id);
      const draftBlocker = (draft.completionBlockers as BlockerDto[])[0];

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(400);
      const completeBlocker = (resp.json<ErrorBody>().error.details?.blockers as BlockerDto[])[0];

      expect(draftBlocker.code).toBe("AMOUNT_OUT_OF_RANGE");
      expect(completeBlocker.code).toBe(draftBlocker.code);
      expect(completeBlocker.message).toBe(draftBlocker.message);
      expect(draftBlocker.message).toBe(BLOCKER_MESSAGE.AMOUNT_OUT_OF_RANGE);
      // 第 6 碼無 `field`（非欄位級錯誤）——兩處同形。
      expect(draftBlocker.field).toBeUndefined();
      expect(completeBlocker.field).toBeUndefined();

      // 預覽之 §20.6 契約為 `blockingCodes: string[]`——只有 code、沒有文案；
      // 「三處一致」於預覽處以 code 相等表達（此為契約差異，非漏測）。
      const preview = await readPreview(
        ownerCookie,
        OVER_CAPACITY_YEAR,
        OVER_CAPACITY_ANNUAL_TOTAL_KM
      );
      expect(preview.blockingCodes).toEqual([draftBlocker.code]);
      expect(preview.blockingCodes.every((code) => typeof code === "string")).toBe(true);
    });

    it("AC-54(e)：零附件之超容量草稿——附件已與完成度脫鉤，兩處皆恰為 AMOUNT_OUT_OF_RANGE（既不新增碼、也不抑制碼）", async () => {
      // 修訂前本 fixture 之期望為「completionBlockers 僅
      // `DEPRECIATION_ATTACHMENT_REQUIRED`（兩段式抑制第 4 碼），computed 才
      // 揭露真因」；裁定②反轉後，附件數 0 對兩處皆零影響。
      const id = await createDraft(OVER_CAPACITY_YEAR, OVER_CAPACITY_ANNUAL_TOTAL_KM);

      const draft = await readDraft(ownerCookie, id);
      expect(draft.attachments).toEqual([]);
      expect((draft.completionBlockers as BlockerDto[]).map((b) => b.code)).toEqual([
        "AMOUNT_OUT_OF_RANGE",
      ]);
      expect(draft.computed?.calculable).toBe(false);
      expect(draft.computed?.blockingCodes).toEqual(["AMOUNT_OUT_OF_RANGE"]);
      expect(draft.computed?.amount).toBeNull();
    });

    it("AC-22(d) 防誤殺對照組：容量內之同型 fixture 三處皆不暴露 AMOUNT_OUT_OF_RANGE，完成 200 且金額精確等值", async () => {
      await seedCompletedTravel({ date: "2068-03-03", snapshotTotalKm: "12.34" });
      const id = await createCompletableDraft(2068, "100.0");

      const preview = await readPreview(ownerCookie, 2068, "100.0");
      expect(preview.calculable).toBe(true);
      expect(preview.blockingCodes).toEqual([]);
      expect(preview.officialKm).toBe("12.34");
      expect(preview.annualDepreciation).toBe(A_KILL);
      expect(preview.ratio).toBe("0.123400");
      // 246899.99 × 12.34 ÷ 100.0 ＝ 30467.458766 → 4dp 30467.4588；金額 30467
      expect(preview.rawAmount).toBe("30467.4588");
      expect(preview.amount).toBe(30467);

      const draft = await readDraft(ownerCookie, id);
      expect(draft.computed?.calculable).toBe(true);
      expect(draft.computed?.blockingCodes).toEqual([]);
      expect(draft.computed?.amount).toBe(30467);
      expect(draft.completionBlockers).toEqual([]);

      const resp = await completeHttp(ownerCookie, id);
      expect(resp.statusCode).toBe(200);
      const snapshot = resp.json<{ application: ApplicationDto }>().application.snapshot;
      expect(snapshot?.model).toBe("CURRENT");
      expect(snapshot?.officialKm).toBe("12.34");
      expect(snapshot?.annualDepreciation).toBe(A_KILL);
      expect(snapshot?.annualTotalKm).toBe("100.0");
      expect(snapshot?.ratio).toBe("0.123400");
      expect(snapshot?.rawAmount).toBe("30467.4588");
      expect(snapshot?.totalAmount).toBe(30467);
    });
  });

  // ===========================================================================
  // AC-54 — 折舊證明改選填（語意反轉；取代開發段之 AC-24 段）
  // ===========================================================================

  describe("AC-54 折舊證明改選填（零附件亦可完成）", () => {
    it("AC-54(a)：草稿零附件可建立(201)可更新(200) → **完成成功(200)** ＋ 9 欄快照完整寫入", async () => {
      await seedCompletedTravel({ date: "2069-04-04", snapshotTotalKm: "25.00" });

      // ── 階段 1：草稿零附件可儲存 ────────────────────────────────────────
      const createResp = await app.inject({
        method: "POST",
        url: "/applications/depreciation",
        headers: { cookie: ownerCookie },
        payload: { applicationYear: 2069, annualTotalKm: "100.0" },
      });
      expect(createResp.statusCode).toBe(201);
      const id = trackApp(createResp.json<{ application: { id: string } }>().application.id);

      const updateResp = await app.inject({
        method: "PUT",
        url: `/applications/depreciation/${id}`,
        headers: { cookie: ownerCookie },
        payload: { applicationYear: 2069, annualTotalKm: "100.0" },
      });
      expect(updateResp.statusCode).toBe(200);
      const afterUpdate = updateResp.json<{ application: DraftDto }>().application;
      expect(afterUpdate.attachments).toEqual([]);
      expect(afterUpdate.status).toBe("DRAFT");
      expect(afterUpdate.computed?.calculable).toBe(true);
      expect(afterUpdate.computed?.blockingCodes).toEqual([]);
      // **反轉之核心斷言**：零附件之草稿已無任何完成阻擋。
      expect(afterUpdate.completionBlockers).toEqual([]);

      // ── 階段 2：零附件完成 → 200 ＋ 9 欄快照完整（AC-54(a) 逐字）────────
      const okResp = await completeHttp(ownerCookie, id);
      expect(okResp.statusCode).toBe(200);
      const completed = okResp.json<{ application: ApplicationDto }>().application;
      expect(completed.status).toBe("COMPLETED");
      // 246899.99 × 25.00 ÷ 100.0 ＝ 61724.9975
      expect(completed.snapshot?.model).toBe("CURRENT");
      expect(completed.snapshot?.annualDepreciation).toBe(A_KILL);
      expect(completed.snapshot?.officialKm).toBe("25.00");
      expect(completed.snapshot?.annualTotalKm).toBe("100.0");
      expect(completed.snapshot?.ratio).toBe("0.250000");
      expect(completed.snapshot?.rawAmount).toBe("61724.9975");
      expect(completed.snapshot?.totalAmount).toBe(61725);

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      for (const column of SNAPSHOT_COLUMNS_9) {
        expect(
          row[column],
          `AC-54(a): ${column} must be written on a zero-attachment completion`
        ).not.toBeNull();
      }
      await expectFrozenLegacyColumnsNull(id);

      const completedApp = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(completedApp.status).toBe("COMPLETED");
      expect(completedApp.totalAmount).toBe(61725);
      // 完成後仍為零附件（完成流程不得代為建立任何附件列）。
      expect(
        await prisma.attachment.count({
          where: { refType: "DEPRECIATION", refId: id, status: "LINKED" },
        })
      ).toBe(0);
    });

    it("AC-54(b)：草稿 DTO／預覽／完成三處之回應皆不含 DEPRECIATION_ATTACHMENT_REQUIRED（含 400 回應本文之字面掃描）", async () => {
      const id = await createDraft(2069, "100.0");

      const draft = await readDraft(ownerCookie, id);
      expect((draft.completionBlockers as BlockerDto[]).map((b) => b.code)).not.toContain(
        "DEPRECIATION_ATTACHMENT_REQUIRED"
      );
      expect(draft.computed?.blockingCodes).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");

      const previewResp = await previewHttp(ownerCookie, 2069, "100.0");
      expect(previewResp.statusCode).toBe(200);
      expect(previewResp.body).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");

      // 一個必定 400 之完成請求（缺年度總里程）——其回應本文亦不得出現該碼。
      const blockedId = await createDraft(null, null);
      const blockedResp = await completeHttp(ownerCookie, blockedId);
      expect(blockedResp.statusCode).toBe(400);
      expect(blockedResp.body).not.toContain("DEPRECIATION_ATTACHMENT_REQUIRED");
    });
  });
});
