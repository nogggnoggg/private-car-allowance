/**
 * Integration tests for PHASE-007-T10:
 *   快照不可變 ＋ 後端為唯一權威 ＋ 雙完成併發 ＋ 參數版本引用保護。
 *
 * AC covered（PHASE-007 Spec §2 群組 I）：
 *   - **AC-31**「事後改參數，歷史不變」：完成一筆折舊 → 管理員建立新折舊參數
 *     版本（生效日**更早**／**同年度中途**／**更晚**三種）→ 重新讀取該申請，
 *     `snapshot` 之 **8 欄逐位元不變**、`totalAmount` 不變；**spy 證明讀取路徑
 *     零重算**（不再呼叫 `deriveDepreciation`／`sumOfficialMileage`）。
 *   - **AC-32**「後端為唯一權威」：建立／更新／完成三端點之 body 夾帶
 *     `officialKm`／`annualOfficialKm`／`perKmUnitPrice`／`rawAmount`／`amount`／
 *     `totalAmount`／`snapshotVehiclePrice` 等任一 → 一律不採用（DB 值與未夾帶
 *     之對照組**逐位元相同**）；另含 `ownerId`／`createdById`／`status` 之夾帶封閉。
 *   - **AC-33** 併發：同一草稿之兩個完成請求**恰一成功**，另一為 4xx（不得
 *     500）；N 輪迴圈（本檔 20 輪，T9 即審 AR-1 之加固建議）。
 *     `parameterHasReferences("DEPRECIATION", versionId)` 於完成後回 `true`、
 *     僅有草稿引用時回 `false`（§16 **D12(a)**；PHASE-003a §4.7 對本 Phase 之
 *     承諾兌現，BE-US-19 於折舊端之真實回歸）。
 *
 * ── 修復前紅燈實證（TDD 順序，Packet 明列） ──────────────────────────────
 *   本 Task 動工時 `backend/src/parameters/reference-guard.ts` 之
 *   `ParameterType` 僅有 `"FUEL" | "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC"`
 *   （Spec 實查發現 #8），折舊端無任何引用來源。首條紅燈為型別層 ＋ 執行層
 *   雙紅（逐字記錄於 Handoff）。實作 `"DEPRECIATION"` 分支後轉綠。
 *
 * ── T9 即審 FW 之逐項落地 ────────────────────────────────────────────────
 *   1. **AC-33 正例必經真實完成流程**：`depreciationParameterVersionId` 一律由
 *      `completeDepreciationApplication` 寫入；本檔**絕不**直寫該欄位（草稿
 *      fixture 亦然——負例之「僅有草稿引用」即以真實草稿之 `null` 表達）。
 *   2. **該欄無 FK**（T1 FW-6）：故引用斷言一律落在**欄位值層**（DB 讀回後與
 *      版本 id 逐字比對），不倚賴任何 referential action。
 *   3. **AC-31 spy 範圍界定**（006 T8 FW 同型紀律）：spy 只鎖
 *      `sumOfficialMileage` ＋ `depreciationParameterVersion.findMany`
 *      （＋其唯一包裝 `resolveDepreciationParameters`）兩處，**刻意排除**交易
 *      後 DTO 組裝之附件查詢與 `duplicateYearNotice` 查詢——那兩者於
 *      `COMPLETED` 仍會執行且與「金額重算」無關。`buildDepreciationApplicationDto`
 *      對 `COMPLETED` 已結構性不呼叫 `computeDepreciationComputedResult`
 *      （`depreciation-service.ts` §「查詢面」），故 spy 為**守門**而非探索；
 *      為證明 spy 確有牙齒，同一 describe 內附一條 `DRAFT` 對照（spy 必被呼叫）。
 *   4. **AC-32 夾帶矩陣**：夾帶值一律為**頂層純量**（T8 MF-1 教訓：巢狀物件與
 *      恆真斷言為無效測試），且與正確值可鑑別；斷言一律落在 **DB 層**。
 *   5. **年度資源**：2040~2075 於既有 phase7 測試檔已用罄，本檔另起 **2085+**
 *      區間（見下方年度配置表）。
 *
 * ── 參數版本階梯與年度配置（`findEffectiveVersion` 以「申請年度 1/1」為查詢
 *    日，取生效日 ≤ 查詢日之最新者；折舊參數版本為**全域**資料） ────────────
 *   V_BASE  effectiveFrom 2085-01-01  600000.00 / 5 / 20000 → perKm 6.0000
 *
 *   | 年度 | 用途 | 有效版本 |
 *   |---|---|---|
 *   | 2086 | AC-32 建立／更新端點夾帶矩陣 | V_BASE |
 *   | 2087 | AC-32 完成端點夾帶矩陣（含對照組） | V_BASE |
 *   | 2088 | AC-33 雙完成併發 20 輪 | V_BASE |
 *   | 2090 | AC-31 事後改參數（本測試**獨佔** 2089 以後之年度資源） | V_BASE → 事後被 V_EARLIER 取代 |
 *   | 2094 | AC-33 引用保護正例 | V_REF（本測試自建，2094-01-01） |
 *   | 2095 | AC-33 引用保護負例（草稿） | V_DRAFT_ONLY（本測試自建，2095-01-01） |
 *
 *   AC-31 事後建立之三個版本（2089-06-01／2090-07-01／2091-01-01）只會影響
 *   **年度 ≥ 2090** 之選版，故對 2086~2088 之測試零污染；2094／2095 兩測試各
 *   自建立生效日更晚之專屬版本，恆為其年度之勝出者。
 *
 * Test discipline（Spec §11.0 / Packet）：
 *   - loginName 前綴 "p7t10_" ＋ 每次執行之隨機後綴。
 *   - cleanup 僅限本檔追蹤之 id ＋ loginName 前綴；**絕不** `deleteMany({})`。
 *   - 一律合成資料（合成附件列，無真實影像、無真實個資）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as depreciationParameters from "../../src/applications/depreciation-parameters.js";
import { hashPassword } from "../../src/auth/password.js";
import * as mileageEngine from "../../src/mileage/mileage-engine.js";
import { parameterHasReferences } from "../../src/parameters/reference-guard.js";
import { buildServer } from "../../src/server.js";

/**
 * AC-31 之 spy 面（其一）：`sumOfficialMileage`／`resolveDepreciationParameters`
 * 包裝**真實實作**，行為完全不變，只加可觀測性——沿
 * `phase7-depreciation-complete.test.ts` 之 T9 即審 S-1 既有慣例。
 */
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
 * AC-31 之 spy 面（其二）——Packet 逐字指名 `depreciationParameterVersion.findMany`。
 *
 * **據實揭露之落地差異（Handoff 亦記載）**：直接對 `PrismaClient` 的 model
 * delegate 掛 `vi.spyOn(prisma.depreciationParameterVersion, "findMany")`
 * **在 Prisma 5 下不可行**——實測（本 Task 動工過程中的真實紅燈）會使該 client
 * 隨即損壞：spy 期間丟出
 *   `TypeError: Cannot read properties of undefined (reading 'filter')`，
 * `mockRestore()` 之後更變成
 *   `TypeError: db.depreciationParameterVersion.findMany is not a function`。
 * delegate 的方法並非普通的可替換屬性，替換會破壞 Prisma 內部的請求組裝。
 *
 * 故 `findMany` 之守門改以**兩道等效且更強的機制**落地：
 *   (1) 執行期：spy 其**唯一呼叫點** `resolveDepreciationParameters`
 *       （`backend/src/applications/depreciation-parameters.ts:125` 為折舊路徑
 *       上 `depreciationParameterVersion.findMany` 的唯一出現處）。
 *   (2) 靜態面：`depreciation-service.ts` 原始碼掃描，斷言其**完全不出現**
 *       `depreciationParameterVersion` 字樣——封閉 (1) 唯一擋不住的 mutant
 *       「把 `findMany` 內聯進 service 以繞過包裝函式」。
 */

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

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
const LOGIN_PREFIX = "p7t10_";
const PASSWORD = "SnapshotImmutabilityTest99!";

const OWNER_LOGIN = `${LOGIN_PREFIX}owner_${RUN_ID}`;
const OTHER_LOGIN = `${LOGIN_PREFIX}other_${RUN_ID}`;
const ADMIN_LOGIN = `${LOGIN_PREFIX}admin_${RUN_ID}`;

type SnapshotDto = {
  officialKm: string;
  perKmUnitPrice: string;
  rawAmount: string;
  totalAmount: number;
  calculatedAt: string;
};

type ComputedDto = {
  calculable: boolean;
  officialKm: string | null;
  perKmUnitPrice: string | null;
  rawAmount: string | null;
  amount: number | null;
  blockingCodes: string[];
};

type ApplicationDto = {
  id: string;
  status: string;
  ownerId: string;
  createdById: string;
  applicationYear: number | null;
  computed: ComputedDto | null;
  snapshot: SnapshotDto | null;
};

/**
 * DB 層指紋（AC-31 之「8 欄逐位元」與 AC-32 之「與對照組逐位元相同」共用）。
 *
 * `Decimal` 一律以 `.toString()` 取回 DB 實際保存之表示（含尾零），**不**經
 * `Number()`——四捨五入或精度漂移必須顯現為字串不等，而非被浮點吸收。
 *
 * **T10 即審 SF-1 修復**：原版遺漏 `Application.type` 與 `completedAt`，且把
 * `calculatedAt` 降維成 `hasCalculatedAt: boolean`——reviewer C2 mutant（完成
 * 流程把兩個時間戳寫成 `2000-01-01`）因此在全套 2219 條中零紅。現改為：
 *   - `type`／`completedAt` 一併納入指紋（`type` 與對照組同型比較）；
 *   - `calculatedAt`／`completedAt` 不做跨申請等值比較（各申請本就不同），改以
 *     **值域視窗**斷言（見 `expectCompletionTimestamp`）＋「兩欄同值」不變式。
 */
type DbFingerprint = {
  type: string;
  status: string;
  ownerId: string;
  createdById: string;
  totalAmount: number | null;
  applicationYear: number | null;
  snapshotVehiclePrice: string | null;
  snapshotUsefulLifeYears: number | null;
  snapshotEstimatedAnnualKm: number | null;
  snapshotPerKmUnitPrice: string | null;
  snapshotOfficialKm: string | null;
  snapshotRawAmount: string | null;
  depreciationParameterVersionId: string | null;
  calculatedAt: Date | null;
  completedAt: Date | null;
};

function decimalToString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * 本檔模組載入時刻——早於本檔任何一次完成流程，故為所有完成時間戳的合法下界。
 * 這是「不以回應自身值當期望」的替代基準（SF-1）：任何被寫死或被夾帶值覆寫的
 * 時間戳（如 `2000-01-01`）都會落在視窗外而紅燈。
 */
const SUITE_START_MS = Date.now();

/** 完成時間戳之值域視窗斷言：`[本檔載入時刻, 現在 + 1s]`。 */
function expectCompletionTimestamp(value: Date | null, label: string): Date {
  expect(value, `${label}: 期望非 null 之完成時間戳`).not.toBeNull();
  const at = value as Date;
  expect(at.getTime(), `${label} 不得早於本檔載入時刻`).toBeGreaterThanOrEqual(SUITE_START_MS);
  expect(at.getTime(), `${label} 不得晚於現在`).toBeLessThanOrEqual(Date.now() + 1000);
  return at;
}

describeWithDb("PHASE-007-T10 — 快照不可變 ＋ 後端權威 ＋ 併發 ＋ 引用保護", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  let ownerId: string;
  let otherId: string;
  let adminId: string;

  let ownerCookie: string;

  let baseVersionId: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  /** 建立一個折舊參數版本（全域資料；管理員身分為建立者）。 */
  async function createVersion(opts: {
    effectiveFrom: string;
    vehiclePrice: string;
    usefulLifeYears: number;
    estimatedAnnualKm: number;
  }): Promise<string> {
    const row = await prisma.depreciationParameterVersion.create({
      data: {
        vehiclePrice: opts.vehiclePrice,
        usefulLifeYears: opts.usefulLifeYears,
        estimatedAnnualKm: opts.estimatedAnnualKm,
        effectiveFrom: new Date(`${opts.effectiveFrom}T00:00:00.000Z`),
        createdById: adminId,
      },
    });
    return row.id;
  }

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

    const owner = await mkUser(OWNER_LOGIN, "P7T10 擁有人", "USER");
    const other = await mkUser(OTHER_LOGIN, "P7T10 他人", "USER");
    const admin = await mkUser(ADMIN_LOGIN, "P7T10 管理員", "ADMIN");
    ownerId = owner.id;
    otherId = other.id;
    adminId = admin.id;

    // V_BASE（見檔頭階梯表）：600000.00 ÷ (5 × 20000) = 6.0000 元/km。
    baseVersionId = await createVersion({
      effectiveFrom: "2085-01-01",
      vehiclePrice: "600000.00",
      usefulLifeYears: 5,
      estimatedAnnualKm: 20000,
    });

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    ownerCookie = await loginUser(app, OWNER_LOGIN, PASSWORD);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      const userIds = [ownerId, otherId, adminId].filter(Boolean);
      if (createdAttachmentIds.length > 0) {
        await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
      }
      if (createdApplicationIds.length > 0) {
        await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
      }
      if (userIds.length > 0) {
        // 保險網：某些負向情境下端點會在「已建立列」之後才失敗，回應非 2xx 使
        // 呼叫端來不及登記該 id。清理範圍仍嚴格限於**本檔自建的三個使用者**
        // （絕非 `deleteMany({})`）。
        await prisma.attachment.deleteMany({ where: { ownerId: { in: userIds } } });
        await prisma.application.deleteMany({ where: { ownerId: { in: userIds } } });
      }
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
    date: string;
    snapshotTotalKm: string;
  }): Promise<string> {
    const application = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
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
  async function linkProof(applicationId: string): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p7t10/${RUN_ID}-${createdAttachmentIds.length}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 256,
        originalFilename: "proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType: "DEPRECIATION",
        refId: applicationId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /** 經真實端點建立折舊草稿（可夾帶任意額外 body 欄位供 AC-32 使用）。 */
  async function createDraft(
    applicationYear: number | null,
    extraBody: Record<string, unknown> = {}
  ): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: { ...(applicationYear === null ? {} : { applicationYear }), ...extraBody },
    });
    expect(resp.statusCode).toBe(201);
    return trackApp(resp.json<{ application: ApplicationDto }>().application.id);
  }

  async function createCompletableDraft(
    applicationYear: number,
    extraBody: Record<string, unknown> = {}
  ): Promise<string> {
    const id = await createDraft(applicationYear, extraBody);
    await linkProof(id);
    return id;
  }

  function completeHttp(id: string, payload?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie: ownerCookie },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function getHttp(id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie: ownerCookie },
    });
  }

  function putHttp(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/applications/depreciation/${id}`,
      headers: { cookie: ownerCookie },
      payload,
    });
  }

  /** DB 層指紋（見型別說明）。一律以測試自己的 client 讀取，不經任何 DTO。 */
  async function dbFingerprint(id: string): Promise<DbFingerprint> {
    const application = await prisma.application.findUniqueOrThrow({ where: { id } });
    const depreciation = await prisma.depreciationApplication.findUniqueOrThrow({
      where: { applicationId: id },
    });
    return {
      type: application.type,
      status: application.status,
      ownerId: application.ownerId,
      createdById: application.createdById,
      totalAmount: application.totalAmount,
      applicationYear: depreciation.applicationYear,
      snapshotVehiclePrice: decimalToString(depreciation.snapshotVehiclePrice),
      snapshotUsefulLifeYears: depreciation.snapshotUsefulLifeYears,
      snapshotEstimatedAnnualKm: depreciation.snapshotEstimatedAnnualKm,
      snapshotPerKmUnitPrice: decimalToString(depreciation.snapshotPerKmUnitPrice),
      snapshotOfficialKm: decimalToString(depreciation.snapshotOfficialKm),
      snapshotRawAmount: decimalToString(depreciation.snapshotRawAmount),
      depreciationParameterVersionId: depreciation.depreciationParameterVersionId,
      calculatedAt: depreciation.calculatedAt,
      completedAt: application.completedAt,
    };
  }

  /**
   * 指紋比對（SF-1）：兩個時間戳以外之欄位一律與對照組**逐位元相同**；
   * 兩個時間戳則走值域視窗 ＋「同一次完成寫入之兩欄必同值」不變式
   * （`depreciation-service.ts` §9.3 ⑥a/⑥b 以同一個 `calculatedAt` 物件同時
   * 寫入 `DepreciationApplication.calculatedAt` 與 `Application.completedAt`）。
   * **絕不**以受測回應自身的時間戳當作期望值。
   */
  function expectFingerprintMatchesControl(
    actual: DbFingerprint,
    control: DbFingerprint,
    label: string
  ): void {
    const {
      calculatedAt: actualCalculatedAt,
      completedAt: actualCompletedAt,
      ...actualRest
    } = actual;
    const {
      calculatedAt: _controlCalculatedAt,
      completedAt: _controlCompletedAt,
      ...controlRest
    } = control;
    expect(actualRest, label).toEqual(controlRest);

    if (control.status !== "COMPLETED") {
      // 草稿：兩個時間戳皆必須仍為 null（完成流程未跑過）。
      expect(actualCalculatedAt, `${label} calculatedAt`).toBeNull();
      expect(actualCompletedAt, `${label} completedAt`).toBeNull();
      return;
    }

    const calculatedAt = expectCompletionTimestamp(actualCalculatedAt, `${label} calculatedAt`);
    const completedAt = expectCompletionTimestamp(actualCompletedAt, `${label} completedAt`);
    expect(completedAt.getTime(), `${label}: completedAt 與 calculatedAt 必為同一時刻`).toBe(
      calculatedAt.getTime()
    );
  }

  // ===========================================================================
  // AC-31 — 事後改參數，歷史不變（＋ 讀取路徑零重算）
  // ===========================================================================

  describe("AC-31 事後改參數，歷史不變", () => {
    let completedId: string;
    /** 完成當下之 8 欄快照（逐位元基準）。 */
    let baselineSnapshotColumns: Record<string, string | number | null>;
    let baselineDto: SnapshotDto;
    let baselineTotalAmount: number | null;

    beforeAll(async () => {
      // 2090 年度：公務里程 100.00 km × 6.0000 元/km = 600.0000 → 600 元。
      await seedCompletedTravel({ date: "2090-06-01", snapshotTotalKm: "100.00" });
      completedId = await createCompletableDraft(2090);

      const resp = await completeHttp(completedId);
      expect(resp.statusCode).toBe(200);
      baselineDto = resp.json<{ application: ApplicationDto }>().application
        .snapshot as SnapshotDto;

      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: completedId },
      });
      const applicationRow = await prisma.application.findUniqueOrThrow({
        where: { id: completedId },
      });
      baselineTotalAmount = applicationRow.totalAmount;
      // §8.2 之 8 個快照欄，逐欄以字串／數值原樣保存為基準。
      baselineSnapshotColumns = {
        snapshotVehiclePrice: decimalToString(row.snapshotVehiclePrice),
        snapshotUsefulLifeYears: row.snapshotUsefulLifeYears,
        snapshotEstimatedAnnualKm: row.snapshotEstimatedAnnualKm,
        snapshotPerKmUnitPrice: decimalToString(row.snapshotPerKmUnitPrice),
        snapshotOfficialKm: decimalToString(row.snapshotOfficialKm),
        snapshotRawAmount: decimalToString(row.snapshotRawAmount),
        calculatedAt: row.calculatedAt === null ? null : row.calculatedAt.toISOString(),
        depreciationParameterVersionId: row.depreciationParameterVersionId,
      };
    });

    async function expectSnapshotUnchanged(label: string): Promise<void> {
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: completedId },
      });
      const applicationRow = await prisma.application.findUniqueOrThrow({
        where: { id: completedId },
      });
      expect(
        {
          snapshotVehiclePrice: decimalToString(row.snapshotVehiclePrice),
          snapshotUsefulLifeYears: row.snapshotUsefulLifeYears,
          snapshotEstimatedAnnualKm: row.snapshotEstimatedAnnualKm,
          snapshotPerKmUnitPrice: decimalToString(row.snapshotPerKmUnitPrice),
          snapshotOfficialKm: decimalToString(row.snapshotOfficialKm),
          snapshotRawAmount: decimalToString(row.snapshotRawAmount),
          calculatedAt: row.calculatedAt === null ? null : row.calculatedAt.toISOString(),
          depreciationParameterVersionId: row.depreciationParameterVersionId,
        },
        label
      ).toEqual(baselineSnapshotColumns);
      expect(applicationRow.totalAmount, label).toBe(baselineTotalAmount);

      // wire 面（DTO）亦逐位元不變。
      const dto = (await getHttp(completedId)).json<{ application: ApplicationDto }>().application;
      expect(dto.snapshot, label).toEqual(baselineDto);
      expect(dto.computed, label).toBeNull();
    }

    it("基準：完成快照為 officialKm 100.00 × perKm 6.0000 = 600.0000 → totalAmount 600", () => {
      // SF-1：`calculatedAt` 不得以受測值自身當期望。
      const { calculatedAt, ...scalars } = baselineDto;
      expect(scalars).toEqual({
        officialKm: "100.00",
        perKmUnitPrice: "6.0000",
        rawAmount: "600.0000",
        totalAmount: 600,
      });
      expectCompletionTimestamp(new Date(calculatedAt), "AC-31 baseline snapshot.calculatedAt");
      expect(baselineTotalAmount).toBe(600);
      expect(baselineSnapshotColumns.depreciationParameterVersionId).toBe(baseVersionId);
      expect(baselineSnapshotColumns.snapshotVehiclePrice).toBe("600000");
      expect(baselineSnapshotColumns.snapshotUsefulLifeYears).toBe(5);
      expect(baselineSnapshotColumns.snapshotEstimatedAnnualKm).toBe(20000);
    });

    it("事後建立**生效日更早**（但仍晚於原版本）之新參數版本 → 8 欄逐位元不變", async () => {
      // 2089-06-01 ≤ 2090-01-01（選版查詢日）⇒ 對年度 2090 而言，這是**新的
      // 勝出版本**：若讀取路徑重算，單價會變成 9.0000、金額變成 900。
      await createVersion({
        effectiveFrom: "2089-06-01",
        vehiclePrice: "900000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expectSnapshotUnchanged("earlier-effective version");
    });

    it("鑑別力探針：同年度**新草稿**確實看到新單價 9.0000（證明世界真的變了）", async () => {
      const probeId = await createDraft(2090);
      const dto = (await getHttp(probeId)).json<{ application: ApplicationDto }>().application;
      expect(dto.computed?.perKmUnitPrice).toBe("9.0000");
      expect(dto.computed?.amount).toBe(900);
      // 同一時刻，已完成之申請仍為 6.0000／600。
      expect(baselineDto.perKmUnitPrice).toBe("6.0000");
      await expectSnapshotUnchanged("probe vs completed");
    });

    it("事後建立**同年度中途**生效之新參數版本 → 8 欄逐位元不變", async () => {
      await createVersion({
        effectiveFrom: "2090-07-01",
        vehiclePrice: "1200000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expectSnapshotUnchanged("mid-year version");
    });

    it("事後建立**生效日更晚**之新參數版本 → 8 欄逐位元不變", async () => {
      await createVersion({
        effectiveFrom: "2091-01-01",
        vehiclePrice: "1500000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expectSnapshotUnchanged("later version");
    });

    it("事後**新增同年度已完成差旅**（年度里程改變）→ 快照 officialKm 逐位元不變", async () => {
      await seedCompletedTravel({ date: "2090-09-09", snapshotTotalKm: "777.00" });
      await expectSnapshotUnchanged("extra travel in the same year");
    });

    it("spy：讀取已完成申請之路徑**零重算**（sumOfficialMileage／參數選版皆未被呼叫）", async () => {
      const mileageSpy = vi.mocked(mileageEngine.sumOfficialMileage);
      const resolveSpy = vi.mocked(depreciationParameters.resolveDepreciationParameters);

      mileageSpy.mockClear();
      resolveSpy.mockClear();

      const resp = await getHttp(completedId);
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: ApplicationDto }>().application.snapshot).toEqual(
        baselineDto
      );

      expect(mileageSpy).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();

      // ── spy 有牙齒之對照組（否則「零呼叫」可能只是 spy 根本沒接上） ──────
      const draftId = await createDraft(2090);
      mileageSpy.mockClear();
      resolveSpy.mockClear();

      expect((await getHttp(draftId)).statusCode).toBe(200);
      expect(mileageSpy).toHaveBeenCalled();
      expect(resolveSpy).toHaveBeenCalled();
    });

    it("靜態面：`depreciation-service.ts` 從未直接觸及 `depreciationParameterVersion`（封閉「內聯 findMany」mutant）", () => {
      const source = fs.readFileSync(
        path.resolve(BACKEND_ROOT, "src/applications/depreciation-service.ts"),
        "utf8"
      );
      // 檔頭註解中確有一處以反引號提及此表名（描述查詢面），故掃描對象為
      // **程式碼行**：去除整行註解與行末註解後不得出現該識別字。
      const codeOnly = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(codeOnly).not.toContain("depreciationParameterVersion.");
      expect(codeOnly).not.toContain("depreciationParameterVersion:");
    });
  });

  // ===========================================================================
  // AC-32 — 後端為唯一權威（頂層純量夾帶矩陣 ＋ DB 層斷言）
  // ===========================================================================

  /**
   * 夾帶矩陣（**頂層純量**，且每個值都與正確值可鑑別——T8 MF-1 逐字教訓：
   * 巢狀物件與恆真斷言為無效測試）。
   */
  const INJECTIONS: [name: string, key: string, value: string | number | boolean][] = [
    ["officialKm", "officialKm", "999999.99"],
    ["annualOfficialKm", "annualOfficialKm", 999999.99],
    ["perKmUnitPrice", "perKmUnitPrice", "9999.9999"],
    ["rawAmount", "rawAmount", "88888.8888"],
    ["amount", "amount", 987654],
    ["totalAmount", "totalAmount", 987654],
    ["snapshotVehiclePrice", "snapshotVehiclePrice", "1234567.89"],
    ["snapshotUsefulLifeYears", "snapshotUsefulLifeYears", 99],
    ["snapshotEstimatedAnnualKm", "snapshotEstimatedAnnualKm", 99999],
    ["snapshotPerKmUnitPrice", "snapshotPerKmUnitPrice", "1111.1111"],
    ["snapshotOfficialKm", "snapshotOfficialKm", "4321.00"],
    ["snapshotRawAmount", "snapshotRawAmount", "5555.5555"],
    ["calculatedAt", "calculatedAt", "2000-01-01T00:00:00.000Z"],
    ["depreciationParameterVersionId", "depreciationParameterVersionId", "injected-version-id"],
    ["status", "status", "COMPLETED"],
    ["completedAt", "completedAt", "2000-01-01T00:00:00.000Z"],
    ["type", "type", "TRAVEL"],
  ];

  describe("AC-32 後端為唯一權威 — 建立端點（POST /applications/depreciation）", () => {
    let controlFingerprint: DbFingerprint;

    beforeAll(async () => {
      const controlId = await createDraft(2086);
      controlFingerprint = await dbFingerprint(controlId);
    });

    it("對照組：草稿之 DB 值為 DRAFT／ownerId=本人／全部快照欄 null", () => {
      expect(controlFingerprint).toEqual({
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        totalAmount: null,
        applicationYear: 2086,
        snapshotVehiclePrice: null,
        snapshotUsefulLifeYears: null,
        snapshotEstimatedAnnualKm: null,
        snapshotPerKmUnitPrice: null,
        snapshotOfficialKm: null,
        snapshotRawAmount: null,
        depreciationParameterVersionId: null,
        calculatedAt: null,
        completedAt: null,
      });
    });

    it.each(INJECTIONS)(
      "建立時夾帶頂層 %s → DB 值與對照組逐位元相同",
      async (_name, key, value) => {
        const id = await createDraft(2086, { [key]: value });
        expectFingerprintMatchesControl(
          await dbFingerprint(id),
          controlFingerprint,
          `create ${_name}`
        );
      }
    );

    it.each([
      ["ownerId", "ownerId"],
      ["createdById", "createdById"],
    ])("建立時夾帶頂層 %s（他人 id）→ 擁有人仍為本人", async (_name, key) => {
      const id = await createDraft(2086, { [key]: otherId });
      const fingerprint = await dbFingerprint(id);
      expect(fingerprint.ownerId).toBe(ownerId);
      expect(fingerprint.createdById).toBe(ownerId);
      expectFingerprintMatchesControl(fingerprint, controlFingerprint, `create ${_name}`);
    });
  });

  describe("AC-32 後端為唯一權威 — 更新端點（PUT /applications/depreciation/:id）", () => {
    let controlFingerprint: DbFingerprint;

    beforeAll(async () => {
      const controlId = await createDraft(2086);
      const resp = await putHttp(controlId, { applicationYear: 2086 });
      expect(resp.statusCode).toBe(200);
      controlFingerprint = await dbFingerprint(controlId);
    });

    it.each(INJECTIONS)(
      "更新時夾帶頂層 %s → DB 值與對照組逐位元相同",
      async (_name, key, value) => {
        const id = await createDraft(2086);
        const resp = await putHttp(id, { applicationYear: 2086, [key]: value });
        expect(resp.statusCode).toBe(200);
        expectFingerprintMatchesControl(
          await dbFingerprint(id),
          controlFingerprint,
          `put ${_name}`
        );
      }
    );

    it.each([
      ["ownerId", "ownerId"],
      ["createdById", "createdById"],
    ])("更新時夾帶頂層 %s（他人 id）→ 擁有人仍為本人", async (_name, key) => {
      const id = await createDraft(2086);
      const resp = await putHttp(id, { applicationYear: 2086, [key]: otherId });
      expect(resp.statusCode).toBe(200);
      expectFingerprintMatchesControl(await dbFingerprint(id), controlFingerprint, `put ${_name}`);
    });
  });

  describe("AC-32 後端為唯一權威 — 完成端點（POST /applications/:id/complete）", () => {
    let controlFingerprint: DbFingerprint;
    let controlSnapshot: SnapshotDto;

    beforeAll(async () => {
      // 2087 年度：250.50 km × 6.0000 = 1503.0000 → 1503 元。
      await seedCompletedTravel({ date: "2087-04-04", snapshotTotalKm: "250.50" });
      const controlId = await createCompletableDraft(2087);
      const resp = await completeHttp(controlId);
      expect(resp.statusCode).toBe(200);
      controlSnapshot = resp.json<{ application: ApplicationDto }>().application
        .snapshot as SnapshotDto;
      controlFingerprint = await dbFingerprint(controlId);
    });

    it("對照組：未夾帶任何欄位之完成結果（後端權威值）", () => {
      // SF-1：`calculatedAt` **不得**以受測值自身當期望——先剝離後逐值比對，
      // 時間戳單獨走值域視窗斷言。
      const { calculatedAt, ...scalars } = controlSnapshot;
      expect(scalars).toEqual({
        officialKm: "250.50",
        perKmUnitPrice: "6.0000",
        rawAmount: "1503.0000",
        totalAmount: 1503,
      });
      expectCompletionTimestamp(new Date(calculatedAt), "control snapshot.calculatedAt");
      expect(controlFingerprint.type).toBe("DEPRECIATION");
      expect(controlFingerprint.status).toBe("COMPLETED");
      expect(controlFingerprint.totalAmount).toBe(1503);
      expect(controlFingerprint.depreciationParameterVersionId).toBe(baseVersionId);
      expectCompletionTimestamp(controlFingerprint.calculatedAt, "control calculatedAt");
      expectCompletionTimestamp(controlFingerprint.completedAt, "control completedAt");
    });

    it.each(INJECTIONS)(
      "完成時夾帶頂層 %s → DB 值與對照組逐位元相同",
      async (_name, key, value) => {
        const id = await createCompletableDraft(2087);
        const resp = await completeHttp(id, { [key]: value });
        expect(resp.statusCode).toBe(200);
        expectFingerprintMatchesControl(
          await dbFingerprint(id),
          controlFingerprint,
          `complete ${_name}`
        );

        // SF-1：wire 面亦不得以回應自身之 `calculatedAt` 當期望——剝離後與對照
        // 組逐值比對，時間戳單獨走值域視窗。
        const snapshot = resp.json<{ application: ApplicationDto }>().application
          .snapshot as SnapshotDto;
        const { calculatedAt, ...scalars } = snapshot;
        const { calculatedAt: _controlCalculatedAt, ...controlScalars } = controlSnapshot;
        expect(scalars, `complete ${_name}`).toEqual(controlScalars);
        expectCompletionTimestamp(
          new Date(calculatedAt),
          `complete ${_name} snapshot.calculatedAt`
        );
      }
    );

    it.each([
      ["ownerId", "ownerId"],
      ["createdById", "createdById"],
    ])("完成時夾帶頂層 %s（他人 id）→ 擁有人與金額皆不受影響", async (_name, key) => {
      const id = await createCompletableDraft(2087);
      const resp = await completeHttp(id, { [key]: otherId });
      expect(resp.statusCode).toBe(200);
      expectFingerprintMatchesControl(
        await dbFingerprint(id),
        controlFingerprint,
        `complete ${_name}`
      );
    });
  });

  // ===========================================================================
  // AC-33 — 雙完成併發（20 輪）
  // ===========================================================================

  describe("AC-33 雙完成併發", () => {
    it("同一草稿之兩個完成請求：20 輪皆恰一成功，敗方為 4xx（不得 500）", async () => {
      // 2088 年度：40.00 km × 6.0000 = 240.0000 → 240 元。
      await seedCompletedTravel({ date: "2088-08-08", snapshotTotalKm: "40.00" });

      const loserStatuses: number[] = [];
      for (let round = 0; round < 20; round++) {
        const id = await createCompletableDraft(2088);

        const [a, b] = await Promise.all([completeHttp(id), completeHttp(id)]);

        const statuses = [a.statusCode, b.statusCode];
        const detail = `round ${round}: [${statuses.join(", ")}]`;

        // 不得 500（含 503 重試耗盡）。
        for (const status of statuses) {
          expect(status, detail).toBeLessThan(500);
        }
        // 恰一成功。
        expect(statuses.filter((s) => s === 200).length, detail).toBe(1);
        const loser = statuses.find((s) => s !== 200) as number;
        expect(loser, detail).toBeGreaterThanOrEqual(400);
        loserStatuses.push(loser);

        // 事後 DB 斷言：狀態 COMPLETED、金額為後端權威值、快照只寫過一次。
        const fingerprint = await dbFingerprint(id);
        expect(fingerprint.type, detail).toBe("DEPRECIATION");
        expect(fingerprint.status, detail).toBe("COMPLETED");
        expect(fingerprint.totalAmount, detail).toBe(240);
        expect(fingerprint.snapshotOfficialKm, detail).toBe("40");
        expect(fingerprint.snapshotRawAmount, detail).toBe("240");
        expect(fingerprint.depreciationParameterVersionId, detail).toBe(baseVersionId);
        const calculatedAt = expectCompletionTimestamp(
          fingerprint.calculatedAt,
          `${detail} calculatedAt`
        );
        const completedAt = expectCompletionTimestamp(
          fingerprint.completedAt,
          `${detail} completedAt`
        );
        expect(completedAt.getTime(), detail).toBe(calculatedAt.getTime());
      }

      // 敗方一律為狀態機拒絕（403 FORBIDDEN），非隨機 4xx。
      expect(new Set(loserStatuses)).toEqual(new Set([403]));
    });
  });

  // ===========================================================================
  // AC-33 — 引用保護（§16 D12(a)；PHASE-003a §4.7 承諾兌現）
  // ===========================================================================

  describe("AC-33 parameterHasReferences('DEPRECIATION') 正負例", () => {
    it("正例：**經真實完成流程**完成之折舊引用 v → parameterHasReferences 回 true", async () => {
      const versionId = await createVersion({
        effectiveFrom: "2094-01-01",
        vehiclePrice: "700000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      // 完成前：尚無任何引用。
      await expect(parameterHasReferences(prisma, "DEPRECIATION", versionId)).resolves.toBe(false);

      await seedCompletedTravel({ date: "2094-02-02", snapshotTotalKm: "10.00" });
      const id = await createCompletableDraft(2094);
      const resp = await completeHttp(id);
      expect(resp.statusCode).toBe(200);

      // T9 即審 FW-2：該欄無 FK，故斷言落在**欄位值層**——且該值必須由真實完成
      // 流程寫入（本檔從不直寫此欄）。
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: id },
      });
      expect(row.depreciationParameterVersionId).toBe(versionId);
      // 10.00 × 7.0000 = 70.0000
      expect(row.snapshotPerKmUnitPrice?.toString()).toBe("7");

      await expect(parameterHasReferences(prisma, "DEPRECIATION", versionId)).resolves.toBe(true);
    });

    it("負例：僅有**草稿**引用（真實草稿，欄位為 null）→ 回 false", async () => {
      const versionId = await createVersion({
        effectiveFrom: "2095-01-01",
        vehiclePrice: "800000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      const draftId = await createCompletableDraft(2095);

      // 草稿確實「用到」該版本（預覽單價 8.0000），但快照欄位仍為 null。
      const dto = (await getHttp(draftId)).json<{ application: ApplicationDto }>().application;
      expect(dto.status).toBe("DRAFT");
      expect(dto.computed?.perKmUnitPrice).toBe("8.0000");
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: draftId },
      });
      expect(row.depreciationParameterVersionId).toBeNull();

      await expect(parameterHasReferences(prisma, "DEPRECIATION", versionId)).resolves.toBe(false);
    });

    it("負例：從未被任何申請觸及之版本 → 回 false", async () => {
      const orphanVersionId = await createVersion({
        effectiveFrom: "2097-01-01",
        vehiclePrice: "500000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expect(parameterHasReferences(prisma, "DEPRECIATION", orphanVersionId)).resolves.toBe(
        false
      );
    });

    it("型別鑑別：折舊版本 id 對 'FUEL_PRICE'／'ETC' 一律 false；差旅版本 id 對 'DEPRECIATION' 亦 false", async () => {
      // 折舊端已被完成申請引用之版本（承上一條正例所建立之 2094 版本語意，
      // 此處另建一組獨立資料，避免測試間順序耦合）。
      const versionId = await createVersion({
        effectiveFrom: "2096-01-01",
        vehiclePrice: "600000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await seedCompletedTravel({ date: "2096-03-03", snapshotTotalKm: "20.00" });
      const id = await createCompletableDraft(2096);
      expect((await completeHttp(id)).statusCode).toBe(200);
      await expect(parameterHasReferences(prisma, "DEPRECIATION", versionId)).resolves.toBe(true);

      // 同一個 id 拿去問差旅型別 → false（分支確實依 type 換表／換欄）。
      await expect(parameterHasReferences(prisma, "FUEL_PRICE", versionId)).resolves.toBe(false);
      await expect(parameterHasReferences(prisma, "FUEL_CONSUMPTION", versionId)).resolves.toBe(
        false
      );
      await expect(parameterHasReferences(prisma, "ETC", versionId)).resolves.toBe(false);
      await expect(parameterHasReferences(prisma, "FUEL", versionId)).resolves.toBe(false);

      // 反向：一筆已完成差旅之燃料版本 id，問 "DEPRECIATION" → false。
      const fuelVersion = await prisma.fuelPriceVersion.create({
        data: {
          fuelType: "GASOLINE_92",
          pricePerLiter: "30.0000",
          effectiveFrom: new Date("2096-01-01T00:00:00.000Z"),
          createdById: adminId,
        },
      });
      const travelId = await seedCompletedTravel({
        date: "2096-04-04",
        snapshotTotalKm: "30.00",
      });
      await prisma.travelApplication.update({
        where: { applicationId: travelId },
        data: { fuelPriceVersionId: fuelVersion.id },
      });
      await expect(parameterHasReferences(prisma, "FUEL_PRICE", fuelVersion.id)).resolves.toBe(
        true
      );
      await expect(parameterHasReferences(prisma, "DEPRECIATION", fuelVersion.id)).resolves.toBe(
        false
      );

      await prisma.fuelPriceVersion.delete({ where: { id: fuelVersion.id } });
    });
  });
});
