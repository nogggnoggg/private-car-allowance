/**
 * Integration tests for PHASE-007-T10 ／ **R8（折舊模型修訂段）**:
 *   快照不可變 ＋ 後端為唯一權威 ＋ 雙完成併發 ＋ 參數版本引用保護。
 *
 * AC covered（PHASE-007 Spec §2 群組 I ＋ §20.3 修訂段）：
 *   - **AC-31**「事後改參數，歷史不變」（§12R.2 R8 列逐字：「8 欄逐位元不變」
 *     → 「**9 欄**逐位元不變」；spy 零重算之被監視函式改為
 *     `deriveAnnualDepreciation`）：完成一筆折舊 → 管理員建立新折舊參數版本
 *     （生效日**更早**／**同年度中途**／**更晚**三種）→ 重新讀取該申請，
 *     `snapshot` 之 **9 欄逐位元不變**、`totalAmount` 不變；**spy 證明讀取路徑
 *     零重算**（`sumOfficialMileage`／`deriveAnnualDepreciation`／
 *     `resolveDepreciationParameters` 皆未被呼叫）。**fixture 必經真實完成
 *     流程**（直寫 `markCompleted` 會得 `snapshot:null` 而遮蔽斷言，006 T8 FW
 *     教訓；R7 移交後草稿須帶 `annualTotalKm` 方可完成）。
 *   - **AC-32**「後端為唯一權威」（§12R.2 R8 列逐字：夾帶矩陣新增 `ratio`／
 *     `ratioPercent`／`annualDepreciation` 為**不採用**）：建立／更新／完成三
 *     端點之 body 夾帶 `officialKm`／`annualOfficialKm`／`annualDepreciation`／
 *     `ratio`／`ratioPercent`／`perKmUnitPrice`／`rawAmount`／`amount`／
 *     `totalAmount`／`snapshot*` 等任一 → 一律不採用（DB 值與未夾帶之對照組
 *     **逐位元相同**）；另含 `ownerId`／`createdById`／`status` 之夾帶封閉。
 *   - **AC-48（權威面）**「年度總里程為**申請資料**應予採用」：**同一請求之
 *     採用／不採用對照矩陣**——同一次 `POST`／`PUT` 同時夾帶 `annualTotalKm`
 *     （**採用**，逐位元入庫）與 `officialKm`／`ratio`／`ratioPercent`／
 *     `annualDepreciation`／`rawAmount`／`amount`／`totalAmount`（**一律不採
 *     用**，與對照組逐位元相同）。完成端點則為**反面**：該端點不受理任何欄位
 *     更新，故 `annualTotalKm` 於此一律**不採用**（見完成端點之夾帶矩陣）。
 *   - **AC-33** 併發：同一草稿之兩個完成請求**恰一成功**，另一為 4xx（不得
 *     500）；N 輪迴圈（本檔 20 輪，T9 即審 AR-1 之加固建議）。
 *     `parameterHasReferences("DEPRECIATION", versionId)` 於完成後回 `true`、
 *     僅有草稿引用時回 `false`（§16 **D12(a)**；PHASE-003a §4.7 對本 Phase 之
 *     承諾兌現，BE-US-19 於折舊端之真實回歸）。
 *
 * ── 修復前紅燈實證（TDD 順序） ────────────────────────────────────────────
 *   T10 動工時 `backend/src/parameters/reference-guard.ts` 之 `ParameterType`
 *   僅有 `"FUEL" | "FUEL_PRICE" | "FUEL_CONSUMPTION" | "ETC"`（Spec 實查發現
 *   #8），折舊端無任何引用來源；實作 `"DEPRECIATION"` 分支後轉綠。
 *   **R8 動工時**（base `0276baf`）本檔對修訂後模型全面失效：完成流程因草稿
 *   未帶 `annualTotalKm` 一律 400，`AC-31` describe（8 條）與 `AC-32` 完成端點
 *   describe（20 條）之 `beforeAll` 連帶爆掉而全數 **skipped**，另 4 條紅
 *   （逐字輸出見 Handoff）。本次遷移之範圍逐字依 §20.11.2 之 R8 列（本檔
 *   AC-31/32/48）——零測試被刪除／`skip`／弱化，斷言一律**加嚴**（8 欄 → 9 欄、
 *   夾帶矩陣 17 格 → 21 格、新增同一請求採用／不採用對照矩陣）。
 *
 * ── T9 即審 FW 之逐項落地（R8 沿用） ─────────────────────────────────────
 *   1. **AC-33 正例必經真實完成流程**：`depreciationParameterVersionId` 一律由
 *      `completeDepreciationApplication` 寫入；本檔**絕不**直寫該欄位（草稿
 *      fixture 亦然——負例之「僅有草稿引用」即以真實草稿之 `null` 表達）。
 *   2. **該欄無 FK**（T1 FW-6）：故引用斷言一律落在**欄位值層**（DB 讀回後與
 *      版本 id 逐字比對），不倚賴任何 referential action。
 *   3. **AC-31 spy 範圍界定**（006 T8 FW 同型紀律）：spy 只鎖
 *      `sumOfficialMileage`、`deriveAnnualDepreciation`（R8 Packet 逐字指名）
 *      ＋ `depreciationParameterVersion.findMany` 之唯一包裝
 *      `resolveDepreciationParameters` 三處，**刻意排除**交易後 DTO 組裝之附件
 *      查詢與 `duplicateYearNotice` 查詢——那兩者於 `COMPLETED` 仍會執行且與
 *      「金額重算」無關。`buildDepreciationApplicationDto` 對 `COMPLETED` 已
 *      結構性不呼叫 `computeDepreciationComputedResult`
 *      （`depreciation-service.ts` §「查詢面」），故 spy 為**守門**而非探索；
 *      為證明 spy 確有牙齒，同一 describe 內附一條 `DRAFT` 對照（spy 必被呼叫）。
 *   4. **AC-32 夾帶矩陣**：夾帶值一律為**頂層純量**（T8 MF-1 教訓：巢狀物件與
 *      恆真斷言為無效測試），且與正確值可鑑別；斷言一律落在 **DB 層**。
 *   5. **年度資源**：2040~2075 於既有 phase7 測試檔已用罄，本檔另起 **2085+**
 *      區間（見下方年度配置表）。
 *
 * ── 參數版本階梯與年度配置（`findEffectiveVersion` 以「申請年度 1/1」為查詢
 *    日，取生效日 ≤ 查詢日之最新者；折舊參數版本為**全域**資料） ────────────
 *   V_BASE  effectiveFrom 2085-01-01  車價 600000.00 / 年限 5
 *           → `deriveAnnualDepreciation` ＝ 每年折舊費用 **120000.00**
 *
 *   全檔之年度總里程一律 `ANNUAL_TOTAL_KM`＝`"16384.0"`（2^14；使 `ratio` 與
 *   `rawAmount` 皆為有限小數而非循環小數，斷言得以逐位元精確且**仍帶真實小數
 *   位**——避免整除掩蓋捨入 mutant）。
 *
 *   | 年度 | 用途 | 有效版本 | 年度公務里程 → 金額 |
 *   |---|---|---|---|
 *   | 2086 | AC-32 建立／更新端點夾帶矩陣 ＋ AC-48 對照矩陣 | V_BASE | （草稿，不完成）|
 *   | 2087 | AC-32 完成端點夾帶矩陣（含對照組） | V_BASE | 250.50 → 1835 |
 *   | 2088 | AC-33 雙完成併發 20 輪 | V_BASE | 40.00 → 293 |
 *   | 2090 | AC-31 事後改參數（本測試**獨佔** 2089 以後之年度資源） | V_BASE → 事後被 V_EARLIER 取代 | 100.00 → 732 |
 *   | 2094 | AC-33 引用保護正例 | V_REF（本測試自建，2094-01-01，700000/5）| 10.00 → 85 |
 *   | 2095 | AC-33 引用保護負例（草稿） | V_DRAFT_ONLY（本測試自建，2095-01-01，800000/5）| — |
 *   | 2096 | AC-33 型別鑑別 | 本測試自建 2096-01-01（600000/5）| 20.00 → 146 |
 *
 *   AC-31 事後建立之三個版本（2089-06-01／2090-07-01／2091-01-01）只會影響
 *   **年度 ≥ 2090** 之選版，故對 2086~2088 之測試零污染；2094／2095／2096 三
 *   測試各自建立生效日更晚之專屬版本，恆為其年度之勝出者。
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
import * as depreciationEngine from "../../src/parameters/depreciation-engine.js";
import { parameterHasReferences } from "../../src/parameters/reference-guard.js";
import { buildServer } from "../../src/server.js";

/**
 * AC-31 之 spy 面（其一）：`sumOfficialMileage`／`deriveAnnualDepreciation`／
 * `resolveDepreciationParameters` 包裝**真實實作**，行為完全不變，只加可觀測
 * 性——沿 `phase7-depreciation-complete.test.ts` 之 T9 即審 S-1 既有慣例。
 *
 * `deriveAnnualDepreciation` 為 **R8 Packet 逐字指名**之被監視函式（取代舊模型
 * 之 `deriveDepreciation`）；`deriveDepreciation` 經 `...actual` 原樣保留為真實
 * 實作（其行為凍結由 `depreciation-engine.test.ts` 守護，本檔不介入）。
 */
vi.mock("../../src/mileage/mileage-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mileage/mileage-engine.js")>();
  return {
    ...actual,
    sumOfficialMileage: vi.fn(actual.sumOfficialMileage),
  };
});

vi.mock("../../src/parameters/depreciation-engine.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/parameters/depreciation-engine.js")>();
  return {
    ...actual,
    deriveAnnualDepreciation: vi.fn(actual.deriveAnnualDepreciation),
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
 * **在 Prisma 5 下不可行**——實測（T10 動工過程中的真實紅燈）會使該 client
 * 隨即損壞：spy 期間丟出
 *   `TypeError: Cannot read properties of undefined (reading 'filter')`，
 * `mockRestore()` 之後更變成
 *   `TypeError: db.depreciationParameterVersion.findMany is not a function`。
 * delegate 的方法並非普通的可替換屬性，替換會破壞 Prisma 內部的請求組裝。
 *
 * 故 `findMany` 之守門改以**兩道等效且更強的機制**落地：
 *   (1) 執行期：spy 其**唯一呼叫點** `resolveDepreciationParameters`
 *       （`backend/src/applications/depreciation-parameters.ts` 為折舊路徑上
 *       `depreciationParameterVersion.findMany` 的唯一出現處）。
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

/**
 * 全檔標準之年度總里程（申請資料，AC-47 之 1 位小數契約內）。見檔頭選值理由。
 * DB 欄為 `Decimal(9,1)`，故 `.toString()` 之表示為 `"16384"`（尾零不保留）。
 */
const ANNUAL_TOTAL_KM = "16384.0";

/**
 * AC-48 對照矩陣專用之**採用值**——刻意與 `ANNUAL_TOTAL_KM` 可鑑別，且帶一位
 * 小數（`.toString()` ＝ `"12345.6"`），使「靜默取整」「靜默改用對照值」兩種
 * mutant 皆必紅。
 */
const ADOPTED_ANNUAL_TOTAL_KM = "12345.6";

/** §20.6 `DepreciationSnapshotDto`（修訂後形狀）。 */
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

/** §20.6 `DepreciationComputedDto`（修訂後形狀）。 */
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

type ApplicationDto = {
  id: string;
  status: string;
  ownerId: string;
  createdById: string;
  applicationYear: number | null;
  annualTotalKm: string | null;
  computed: ComputedDto | null;
  snapshot: SnapshotDto | null;
};

/**
 * **AC-31 之 9 個快照欄**（§20.3 AC-55(a) 逐字順序；與
 * `phase7-depreciation-complete.test.ts` 之 `SNAPSHOT_COLUMNS_9` 同一份清單，
 * 該檔為 R7 之權威來源、本檔不修改它）。「9 欄逐位元不變」之機械守門即以本清
 * 單驅動——漏列任一欄都會使「事後被重寫」之 mutant 逃逸。
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

/**
 * DB 層指紋（AC-31 之「9 欄逐位元」與 AC-32／AC-48 之「與對照組逐位元相同」
 * 共用）。
 *
 * `Decimal` 一律以 `.toString()` 取回 DB 實際保存之表示，**不**經 `Number()`
 * ——四捨五入或精度漂移必須顯現為字串不等，而非被浮點吸收。
 *
 * **T10 即審 SF-1 修復**：原版遺漏 `Application.type` 與 `completedAt`，且把
 * `calculatedAt` 降維成 `hasCalculatedAt: boolean`——reviewer C2 mutant（完成
 * 流程把兩個時間戳寫成 `2000-01-01`）因此在全套 2219 條中零紅。現改為：
 *   - `type`／`completedAt` 一併納入指紋（`type` 與對照組同型比較）；
 *   - `calculatedAt`／`completedAt` 不做跨申請等值比較（各申請本就不同），改以
 *     **值域視窗**斷言（見 `expectCompletionTimestamp`）＋「兩欄同值」不變式。
 *
 * **R8 擴充**：新增申請資料欄 `annualTotalKm`（AC-48 之採用面斷言落點）與新模型
 * 三快照欄 `snapshotAnnualDepreciation`／`snapshotAnnualTotalKm`／`snapshotRatio`
 * （AC-31 之 9 欄集合），凍結唯讀二欄一併保留（其恆 `null` 亦為契約）。
 */
type DbFingerprint = {
  type: string;
  status: string;
  ownerId: string;
  createdById: string;
  totalAmount: number | null;
  applicationYear: number | null;
  /** ★ R8：申請資料欄（**應予採用**，AC-48(a)）——不是快照欄。 */
  annualTotalKm: string | null;
  snapshotVehiclePrice: string | null;
  snapshotUsefulLifeYears: number | null;
  snapshotAnnualDepreciation: string | null;
  snapshotOfficialKm: string | null;
  snapshotAnnualTotalKm: string | null;
  snapshotRatio: string | null;
  snapshotRawAmount: string | null;
  snapshotEstimatedAnnualKm: number | null;
  snapshotPerKmUnitPrice: string | null;
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

describeWithDb("PHASE-007-T10／R8 — 快照不可變 ＋ 後端權威 ＋ 併發 ＋ 引用保護", () => {
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

  /**
   * 建立一個折舊參數版本（全域資料；管理員身分為建立者）。
   *
   * `estimatedAnnualKm` 刻意仍寫入非 `null` 值（20000）——修訂後該欄為**凍結
   * 唯讀**（§20.7.5），完成流程若「順手抄進快照」即為 mutant，由指紋中的
   * `snapshotEstimatedAnnualKm: null` 逐次攔截。
   */
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

    // V_BASE（見檔頭階梯表）：600000.00 ÷ 5 = 每年折舊費用 120000.00。
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

  /**
   * 經真實端點建立折舊草稿（可夾帶任意額外 body 欄位供 AC-32／AC-48 使用）。
   *
   * `annualTotalKm` 為**具名參數**而非 `extraBody` 之一員：它是修訂後模型的
   * 正規申請欄位（AC-47／AC-48），與「夾帶」語意相反，兩者不可混為一談。
   * 傳 `null` ＝ 完全不送該 key（供 AC-48 對照矩陣以 `extraBody` 自行控制）。
   */
  async function createDraft(
    applicationYear: number | null,
    annualTotalKm: string | null = ANNUAL_TOTAL_KM,
    extraBody: Record<string, unknown> = {}
  ): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: {
        ...(applicationYear === null ? {} : { applicationYear }),
        ...(annualTotalKm === null ? {} : { annualTotalKm }),
        ...extraBody,
      },
    });
    expect(resp.statusCode).toBe(201);
    return trackApp(resp.json<{ application: ApplicationDto }>().application.id);
  }

  async function createCompletableDraft(
    applicationYear: number,
    extraBody: Record<string, unknown> = {}
  ): Promise<string> {
    const id = await createDraft(applicationYear, ANNUAL_TOTAL_KM, extraBody);
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
      annualTotalKm: decimalToString(depreciation.annualTotalKm),
      snapshotVehiclePrice: decimalToString(depreciation.snapshotVehiclePrice),
      snapshotUsefulLifeYears: depreciation.snapshotUsefulLifeYears,
      snapshotAnnualDepreciation: decimalToString(depreciation.snapshotAnnualDepreciation),
      snapshotOfficialKm: decimalToString(depreciation.snapshotOfficialKm),
      snapshotAnnualTotalKm: decimalToString(depreciation.snapshotAnnualTotalKm),
      snapshotRatio: decimalToString(depreciation.snapshotRatio),
      snapshotRawAmount: decimalToString(depreciation.snapshotRawAmount),
      snapshotEstimatedAnnualKm: depreciation.snapshotEstimatedAnnualKm,
      snapshotPerKmUnitPrice: decimalToString(depreciation.snapshotPerKmUnitPrice),
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
   *
   * `overrides`（R8 新增，AC-48 專用）：**唯一**允許與對照組相異的欄位集合，
   * 且必須逐欄給出期望值——「採用」不是「不比較」，而是「比對到另一個明文
   * 期望」。未列於 `overrides` 者一律仍須與對照組逐位元相同。
   */
  function expectFingerprintMatchesControl(
    actual: DbFingerprint,
    control: DbFingerprint,
    label: string,
    overrides: Partial<DbFingerprint> = {}
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
    expect(actualRest, label).toEqual({ ...controlRest, ...overrides });

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
  // AC-31 — 事後改參數，歷史不變（9 欄）＋ 讀取路徑零重算
  // ===========================================================================

  describe("AC-31 事後改參數，歷史不變", () => {
    let completedId: string;
    /** 完成當下之 **9 欄**快照（逐位元基準）。 */
    let baselineSnapshotColumns: Record<string, string | number | null>;
    let baselineDto: SnapshotDto;
    let baselineTotalAmount: number | null;

    /** 由 DB 列擷取 9 欄 ＋ 凍結二欄之可比較形狀（`Decimal`／`Date` 一律字串化）。 */
    function snapshotColumnsOf(
      row: Record<string, unknown>
    ): Record<string, string | number | null> {
      const out: Record<string, string | number | null> = {};
      for (const column of [...SNAPSHOT_COLUMNS_9, ...FROZEN_LEGACY_COLUMNS_2]) {
        const value = row[column];
        out[column] =
          value === null || value === undefined
            ? null
            : value instanceof Date
              ? value.toISOString()
              : typeof value === "number"
                ? value
                : String(value);
      }
      return out;
    }

    beforeAll(async () => {
      // 2090 年度：officialKm 100.00、annualTotalKm 16384.0、每年折舊 120000.00
      //   ratio      = 100 ÷ 16384       = 0.0061035156250   → 6dp "0.006104"
      //   rawAmount  = 120000 × 100 ÷ 16384 = 732.421875     → 4dp "732.4219"
      //   totalAmount= ROUND_HALF_UP(732.421875, 0)          = 732
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
      baselineSnapshotColumns = snapshotColumnsOf(row as unknown as Record<string, unknown>);
    });

    async function expectSnapshotUnchanged(label: string): Promise<void> {
      const row = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: completedId },
      });
      const applicationRow = await prisma.application.findUniqueOrThrow({
        where: { id: completedId },
      });
      const after = snapshotColumnsOf(row as unknown as Record<string, unknown>);

      // ① 集合層：整組（9 欄 ＋ 凍結二欄）逐位元相同。
      expect(after, label).toEqual(baselineSnapshotColumns);
      // ② 逐欄層（機械守門）：即使 ① 之比較器將來被弱化，9 欄仍各自被點名。
      for (const column of SNAPSHOT_COLUMNS_9) {
        expect(after[column], `${label}: ${column} 逐位元不變`).toBe(
          baselineSnapshotColumns[column]
        );
      }
      expect(applicationRow.totalAmount, label).toBe(baselineTotalAmount);

      // wire 面（DTO）亦逐位元不變。
      const dto = (await getHttp(completedId)).json<{ application: ApplicationDto }>().application;
      expect(dto.snapshot, label).toEqual(baselineDto);
      expect(dto.computed, label).toBeNull();
    }

    it("基準：9 欄快照 ＝ 每年折舊 120000.00 × 官方里程 100.00 ÷ 年度總里程 16384.0 → rawAmount 732.4219、totalAmount 732", () => {
      // SF-1：`calculatedAt` 不得以受測值自身當期望。
      const { calculatedAt, ...scalars } = baselineDto;
      expect(scalars).toEqual({
        model: "CURRENT",
        annualDepreciation: "120000.00",
        annualTotalKm: "16384.0",
        ratio: "0.006104",
        ratioPercent: "0.6104",
        perKmUnitPrice: null,
        officialKm: "100.00",
        rawAmount: "732.4219",
        totalAmount: 732,
      });
      expectCompletionTimestamp(new Date(calculatedAt), "AC-31 baseline snapshot.calculatedAt");
      expect(baselineTotalAmount).toBe(732);

      // 9 欄之 DB 表示（逐欄明文；`Decimal.toString()` 不保留尾零）。
      expect(baselineSnapshotColumns.snapshotVehiclePrice).toBe("600000");
      expect(baselineSnapshotColumns.snapshotUsefulLifeYears).toBe(5);
      expect(baselineSnapshotColumns.snapshotAnnualDepreciation).toBe("120000");
      expect(baselineSnapshotColumns.snapshotOfficialKm).toBe("100");
      expect(baselineSnapshotColumns.snapshotAnnualTotalKm).toBe("16384");
      expect(baselineSnapshotColumns.snapshotRatio).toBe("0.006104");
      expect(baselineSnapshotColumns.snapshotRawAmount).toBe("732.4219");
      expect(baselineSnapshotColumns.calculatedAt).not.toBeNull();
      expect(baselineSnapshotColumns.depreciationParameterVersionId).toBe(baseVersionId);

      // AC-55(b)：凍結唯讀二欄恆 null（版本列之 estimatedAnnualKm ＝ 20000，
      // 「順手抄寫」之 mutant 於此必紅）。
      expect(baselineSnapshotColumns.snapshotEstimatedAnnualKm).toBeNull();
      expect(baselineSnapshotColumns.snapshotPerKmUnitPrice).toBeNull();
    });

    it("事後建立**生效日更早**（但仍晚於原版本）之新參數版本 → 9 欄逐位元不變", async () => {
      // 2089-06-01 ≤ 2090-01-01（選版查詢日）⇒ 對年度 2090 而言，這是**新的
      // 勝出版本**：若讀取路徑重算，每年折舊費用會變成 180000.00、金額 1099。
      await createVersion({
        effectiveFrom: "2089-06-01",
        vehiclePrice: "900000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expectSnapshotUnchanged("earlier-effective version");
    });

    it("鑑別力探針：同年度**新草稿**確實看到新的每年折舊費用 180000.00／金額 1099（證明世界真的變了）", async () => {
      const probeId = await createDraft(2090);
      const dto = (await getHttp(probeId)).json<{ application: ApplicationDto }>().application;
      // 180000 × 100 ÷ 16384 = 1098.6328125 → ROUND_HALF_UP → 1099
      expect(dto.computed?.annualDepreciation).toBe("180000.00");
      expect(dto.computed?.rawAmount).toBe("1098.6328");
      expect(dto.computed?.amount).toBe(1099);
      // 同一時刻，已完成之申請仍為 120000.00／732。
      expect(baselineDto.annualDepreciation).toBe("120000.00");
      expect(baselineDto.totalAmount).toBe(732);
      await expectSnapshotUnchanged("probe vs completed");
    });

    it("事後建立**同年度中途**生效之新參數版本 → 9 欄逐位元不變", async () => {
      await createVersion({
        effectiveFrom: "2090-07-01",
        vehiclePrice: "1200000.00",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
      });
      await expectSnapshotUnchanged("mid-year version");
    });

    it("事後建立**生效日更晚**之新參數版本 → 9 欄逐位元不變", async () => {
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

    it("spy：讀取已完成申請之路徑**零重算**（sumOfficialMileage／deriveAnnualDepreciation／參數選版皆未被呼叫）", async () => {
      const mileageSpy = vi.mocked(mileageEngine.sumOfficialMileage);
      const deriveSpy = vi.mocked(depreciationEngine.deriveAnnualDepreciation);
      const resolveSpy = vi.mocked(depreciationParameters.resolveDepreciationParameters);

      mileageSpy.mockClear();
      deriveSpy.mockClear();
      resolveSpy.mockClear();

      const resp = await getHttp(completedId);
      expect(resp.statusCode).toBe(200);
      expect(resp.json<{ application: ApplicationDto }>().application.snapshot).toEqual(
        baselineDto
      );

      expect(mileageSpy).not.toHaveBeenCalled();
      expect(deriveSpy).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();

      // ── spy 有牙齒之對照組（否則「零呼叫」可能只是 spy 根本沒接上） ──────
      const draftId = await createDraft(2090);
      mileageSpy.mockClear();
      deriveSpy.mockClear();
      resolveSpy.mockClear();

      expect((await getHttp(draftId)).statusCode).toBe(200);
      expect(mileageSpy).toHaveBeenCalled();
      expect(deriveSpy).toHaveBeenCalled();
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
   *
   * **R8 擴充**（§12R.2 AC-32 列逐字）：新增 `annualDepreciation`／`ratio`／
   * `ratioPercent` 三個**修訂後計算結果**欄，以及其對應之三個新快照欄
   * `snapshotAnnualDepreciation`／`snapshotAnnualTotalKm`／`snapshotRatio`。
   * 舊模型之 `perKmUnitPrice`／`snapshotPerKmUnitPrice`／
   * `snapshotEstimatedAnnualKm` **保留於矩陣中**——它們雖已退出新模型計算，
   * 「夾帶後被寫進凍結欄」仍是一個真實可達的 mutant（凍結欄恆 `null` 之契約）。
   *
   * **`annualTotalKm` 刻意不在此矩陣**：它是**申請資料**（AC-48(a) 應予採用），
   * 於建立／更新端點之採用面由下方 AC-48 對照矩陣證明；於**完成端點**則另行
   * 加入不採用矩陣（`COMPLETE_ONLY_INJECTIONS`）。
   */
  const INJECTIONS: [name: string, key: string, value: string | number | boolean][] = [
    ["officialKm", "officialKm", "999999.99"],
    ["annualOfficialKm", "annualOfficialKm", 999999.99],
    ["annualDepreciation", "annualDepreciation", "777777.77"],
    ["ratio", "ratio", "0.999999"],
    ["ratioPercent", "ratioPercent", "99.9999"],
    ["perKmUnitPrice", "perKmUnitPrice", "9999.9999"],
    ["rawAmount", "rawAmount", "88888.8888"],
    ["amount", "amount", 987654],
    ["totalAmount", "totalAmount", 987654],
    ["snapshotVehiclePrice", "snapshotVehiclePrice", "1234567.89"],
    ["snapshotUsefulLifeYears", "snapshotUsefulLifeYears", 99],
    ["snapshotAnnualDepreciation", "snapshotAnnualDepreciation", "654321.09"],
    ["snapshotAnnualTotalKm", "snapshotAnnualTotalKm", "77777.7"],
    ["snapshotRatio", "snapshotRatio", "0.777777"],
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

  /**
   * **僅完成端點**之額外夾帶項（AC-48 之反面）：完成端點不受理任何欄位更新，
   * 故連「應予採用」的 `annualTotalKm` 於此也**一律不採用**——申請列之欄值與
   * 據以寫入之 `snapshotAnnualTotalKm` 皆須與對照組逐位元相同。
   */
  const COMPLETE_ONLY_INJECTIONS: [name: string, key: string, value: string | number | boolean][] =
    [["annualTotalKm（完成端點不受理欄位更新）", "annualTotalKm", ADOPTED_ANNUAL_TOTAL_KM]];

  /**
   * AC-48(b) 對照矩陣之**不採用側**（同一請求內與 `annualTotalKm` 併送）。
   * 逐字取自 Spec §20.3 AC-48(b)：`officialKm`／`ratio`／`ratioPercent`／
   * `annualDepreciation`／`rawAmount`／`amount`／`totalAmount`。
   */
  const AC48_NOT_ADOPTED_PAYLOAD: Record<string, string | number> = {
    officialKm: "999999.99",
    ratio: "0.999999",
    ratioPercent: "99.9999",
    annualDepreciation: "777777.77",
    rawAmount: "88888.8888",
    amount: 987654,
    totalAmount: 987654,
  };

  describe("AC-32 後端為唯一權威 — 建立端點（POST /applications/depreciation）", () => {
    let controlFingerprint: DbFingerprint;

    beforeAll(async () => {
      const controlId = await createDraft(2086);
      controlFingerprint = await dbFingerprint(controlId);
    });

    it("對照組：草稿之 DB 值為 DRAFT／ownerId=本人／annualTotalKm 已採用／全部快照欄 null", () => {
      expect(controlFingerprint).toEqual({
        type: "DEPRECIATION",
        status: "DRAFT",
        ownerId,
        createdById: ownerId,
        totalAmount: null,
        applicationYear: 2086,
        // AC-48(a)：申請資料，逐位元採用（`Decimal(9,1)` 之 `.toString()`）。
        annualTotalKm: "16384",
        snapshotVehiclePrice: null,
        snapshotUsefulLifeYears: null,
        snapshotAnnualDepreciation: null,
        snapshotOfficialKm: null,
        snapshotAnnualTotalKm: null,
        snapshotRatio: null,
        snapshotRawAmount: null,
        snapshotEstimatedAnnualKm: null,
        snapshotPerKmUnitPrice: null,
        depreciationParameterVersionId: null,
        calculatedAt: null,
        completedAt: null,
      });
    });

    it.each(INJECTIONS)(
      "建立時夾帶頂層 %s → DB 值與對照組逐位元相同",
      async (_name, key, value) => {
        const id = await createDraft(2086, ANNUAL_TOTAL_KM, { [key]: value });
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
      const id = await createDraft(2086, ANNUAL_TOTAL_KM, { [key]: otherId });
      const fingerprint = await dbFingerprint(id);
      expect(fingerprint.ownerId).toBe(ownerId);
      expect(fingerprint.createdById).toBe(ownerId);
      expectFingerprintMatchesControl(fingerprint, controlFingerprint, `create ${_name}`);
    });

    it("AC-48: annualTotalKm is 申請資料 and IS adopted from the request body, while officialKm/ratio/amount are never adopted (same-request contrast matrix)", async () => {
      // 同一次請求：`annualTotalKm` 採用（且與對照組**可鑑別**），其餘七欄不採用。
      const id = await createDraft(2086, ADOPTED_ANNUAL_TOTAL_KM, AC48_NOT_ADOPTED_PAYLOAD);
      const fingerprint = await dbFingerprint(id);

      // ── 採用側：逐位元等於請求值，且**不等於**對照組（否則測試恆真）──────
      expect(fingerprint.annualTotalKm, "AC-48(a) 採用側逐位元").toBe("12345.6");
      expect(fingerprint.annualTotalKm).not.toBe(controlFingerprint.annualTotalKm);

      // ── 不採用側：除 `annualTotalKm` 外，全部欄位與對照組逐位元相同 ───────
      expectFingerprintMatchesControl(fingerprint, controlFingerprint, "AC-48 create contrast", {
        annualTotalKm: "12345.6",
      });

      // wire 面：DTO 之 `annualTotalKm` 為固定 1 位小數字串（AC-48(a)）。
      const dto = (await getHttp(id)).json<{ application: ApplicationDto }>().application;
      expect(dto.annualTotalKm).toBe("12345.6");
      expect(dto.computed?.annualTotalKm).toBe("12345.6");
    });
  });

  describe("AC-32 後端為唯一權威 — 更新端點（PUT /applications/depreciation/:id）", () => {
    let controlFingerprint: DbFingerprint;

    beforeAll(async () => {
      const controlId = await createDraft(2086);
      const resp = await putHttp(controlId, {
        applicationYear: 2086,
        annualTotalKm: ANNUAL_TOTAL_KM,
      });
      expect(resp.statusCode).toBe(200);
      controlFingerprint = await dbFingerprint(controlId);
    });

    it.each(INJECTIONS)(
      "更新時夾帶頂層 %s → DB 值與對照組逐位元相同",
      async (_name, key, value) => {
        const id = await createDraft(2086);
        const resp = await putHttp(id, {
          applicationYear: 2086,
          annualTotalKm: ANNUAL_TOTAL_KM,
          [key]: value,
        });
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
      const resp = await putHttp(id, {
        applicationYear: 2086,
        annualTotalKm: ANNUAL_TOTAL_KM,
        [key]: otherId,
      });
      expect(resp.statusCode).toBe(200);
      expectFingerprintMatchesControl(await dbFingerprint(id), controlFingerprint, `put ${_name}`);
    });

    it("AC-48: annualTotalKm is 申請資料 and IS adopted from the request body, while officialKm/ratio/amount are never adopted (same-request contrast matrix) — 更新端點", async () => {
      const id = await createDraft(2086);
      const resp = await putHttp(id, {
        applicationYear: 2086,
        annualTotalKm: ADOPTED_ANNUAL_TOTAL_KM,
        ...AC48_NOT_ADOPTED_PAYLOAD,
      });
      expect(resp.statusCode).toBe(200);
      const fingerprint = await dbFingerprint(id);

      expect(fingerprint.annualTotalKm, "AC-48(a) 採用側逐位元").toBe("12345.6");
      expect(fingerprint.annualTotalKm).not.toBe(controlFingerprint.annualTotalKm);
      expectFingerprintMatchesControl(fingerprint, controlFingerprint, "AC-48 put contrast", {
        annualTotalKm: "12345.6",
      });

      expect(
        resp.json<{ application: ApplicationDto }>().application.annualTotalKm,
        "PUT 回應之 wire 值"
      ).toBe("12345.6");
    });
  });

  describe("AC-32 後端為唯一權威 — 完成端點（POST /applications/:id/complete）", () => {
    let controlFingerprint: DbFingerprint;
    let controlSnapshot: SnapshotDto;

    beforeAll(async () => {
      // 2087 年度：officialKm 250.50、annualTotalKm 16384.0、每年折舊 120000.00
      //   ratio      = 250.50 ÷ 16384          = 0.015289306640625 → "0.015289"
      //   rawAmount  = 120000 × 250.50 ÷ 16384 = 1834.716796875    → "1834.7168"
      //   totalAmount= ROUND_HALF_UP(...)      = 1835
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
        model: "CURRENT",
        annualDepreciation: "120000.00",
        annualTotalKm: "16384.0",
        ratio: "0.015289",
        ratioPercent: "1.5289",
        perKmUnitPrice: null,
        officialKm: "250.50",
        rawAmount: "1834.7168",
        totalAmount: 1835,
      });
      expectCompletionTimestamp(new Date(calculatedAt), "control snapshot.calculatedAt");
      expect(controlFingerprint.type).toBe("DEPRECIATION");
      expect(controlFingerprint.status).toBe("COMPLETED");
      expect(controlFingerprint.totalAmount).toBe(1835);
      expect(controlFingerprint.depreciationParameterVersionId).toBe(baseVersionId);
      // AC-48(c)：完成時原樣寫入（不重新查詢、不重算——它沒有系統來源）。
      expect(controlFingerprint.annualTotalKm).toBe("16384");
      expect(controlFingerprint.snapshotAnnualTotalKm).toBe("16384");
      expectCompletionTimestamp(controlFingerprint.calculatedAt, "control calculatedAt");
      expectCompletionTimestamp(controlFingerprint.completedAt, "control completedAt");
    });

    it.each([...INJECTIONS, ...COMPLETE_ONLY_INJECTIONS])(
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

    it("AC-48(b) 同一請求對照矩陣 — 完成端點：七欄夾帶一律不採用，快照仍為後端權威值", async () => {
      const id = await createCompletableDraft(2087);
      const resp = await completeHttp(id, AC48_NOT_ADOPTED_PAYLOAD);
      expect(resp.statusCode).toBe(200);
      expectFingerprintMatchesControl(
        await dbFingerprint(id),
        controlFingerprint,
        "AC-48 complete contrast"
      );
    });
  });

  // ===========================================================================
  // AC-33 — 雙完成併發（20 輪）
  // ===========================================================================

  describe("AC-33 雙完成併發", () => {
    it("同一草稿之兩個完成請求：20 輪皆恰一成功，敗方為 4xx（不得 500）", async () => {
      // 2088 年度：officialKm 40.00、annualTotalKm 16384.0、每年折舊 120000.00
      //   rawAmount = 120000 × 40 ÷ 16384 = 292.96875 → "292.9688"、金額 293
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
        expect(fingerprint.totalAmount, detail).toBe(293);
        expect(fingerprint.snapshotOfficialKm, detail).toBe("40");
        expect(fingerprint.snapshotAnnualTotalKm, detail).toBe("16384");
        expect(fingerprint.snapshotAnnualDepreciation, detail).toBe("120000");
        expect(fingerprint.snapshotRatio, detail).toBe("0.002441");
        expect(fingerprint.snapshotRawAmount, detail).toBe("292.9688");
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
      // 700000 ÷ 5 = 140000.00；140000 × 10 ÷ 16384 = 85.44921875 → 85
      expect(row.snapshotAnnualDepreciation?.toString()).toBe("140000");
      expect(row.snapshotRawAmount?.toString()).toBe("85.4492");

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

      // 草稿確實「用到」該版本（預覽之每年折舊費用 800000 ÷ 5 = 160000.00），
      // 但快照欄位仍為 null。
      const dto = (await getHttp(draftId)).json<{ application: ApplicationDto }>().application;
      expect(dto.status).toBe("DRAFT");
      expect(dto.computed?.annualDepreciation).toBe("160000.00");
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
