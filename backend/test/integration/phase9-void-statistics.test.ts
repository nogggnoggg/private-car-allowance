/**
 * PHASE-009-T9 — 統計排除之真實流程回歸（AC-16／AC-17）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-009.md`，逐字引用）
 * ---------------------------------------------------------------------------
 * AC-16（:195）：「**AC-16 區間公務里程排除已作廢（PHASE-005 AC-04 之真實流程
 *   回歸）**——以**真實作廢端點**（非 `prisma.application.update` 直寫）作廢一
 *   筆已完成差旅後：`sumOfficialMileage` 之結果**恰等於**未含該筆之值；
 *   `buildOfficialMileageWhere` 之 `status` 仍為字面 `"COMPLETED"`（非
 *   `{ not: "DRAFT" }`）之既有斷言**零改動且全綠**；`backend/src/mileage/`
 *   **全目錄本 Phase 零 diff**（結構性斷言）。」
 *
 * AC-17（:197）：「**AC-17 保養期間與折舊年度公務里程排除已作廢（真實流程）**
 *   ——同一引擎之兩個消費端各一：(a) 保養草稿之 `computed.officialKm` 於區間內
 *   某差旅被**真實作廢**後下降對應值；(b) 折舊草稿之年度公務里程同型；(c) 兩者
 *   之**已完成快照**於作廢後**不變**（歷史不因後續作廢而改變——快照即歷史，
 *   AC-04 之延伸）。」
 *
 * 上游硬約束 D8(a)（:672）：作廢以 `status='VOIDED'` 取代 `COMPLETED`、
 * mileage-engine 過濾條件連動、真實作廢流程回歸 PHASE-005 AC-04——本檔即其正式
 * 回歸落地。
 *
 * Spec §11.0 #4（測試紀律）：「**真實流程優先**：AC-16／AC-17 之作廢**一律走真
 * 實端點**，不得以 `prisma.application.update` 直寫（PHASE-005 當時之權宜作法於
 * 本 Phase 正式退場）。」——本檔全部作廢一律 `POST /applications/:id/void`。
 *
 * ---------------------------------------------------------------------------
 * 本 Task 之生產碼變更：零
 * ---------------------------------------------------------------------------
 * 本檔為**回歸實證型**測試：AC-16／AC-17 所要求之行為，其正確性早在 PHASE-005
 * （`buildOfficialMileageWhere` 之字面 `status: "COMPLETED"`）即已落地，本 Phase
 * 新增的只是「VOIDED 由真實端點產生」這條路徑。因此本檔於 `src/` 零 diff 之下即
 * 應全綠——TDD 之紅燈證據改以 **mutant 自證**取得（Spec §11.0 #2）：
 *
 *   ① AC-16 之 mutant「`status: { not: "DRAFT" }`」：本檔以**測試內就地建構之
 *      mutant where**（不改 `src/`）正向證明鑑別力——同一組資料下 mutant 條件
 *      會把剛被真實作廢的那筆重新算進來，得到與正解**不同**的數值。真正把
 *      `src/mileage/mileage-range.ts` 改成 mutant 之整檔紅燈實錄記於 Handoff。
 *   ② AC-17(c) 之 mutant「已完成之快照欄改為重算」：在**同一次作廢事件**下同時
 *      觀測「草稿（重算路徑）」與「已完成（讀快照路徑）」——草稿下降、快照不
 *      變。若已完成側改為重算，其值必與草稿側同步下降而使斷言必紅；此為不需改
 *      動 `src/` 即可行使的鑑別性對照。
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（Spec §11.0 ／ Packet）
 * ---------------------------------------------------------------------------
 *   - loginName 前綴 `p9t9_` ＋ 每次執行之隨機 `RUN_ID` 後綴。
 *   - fixture 使用者顯式指定 `mustChangePassword: false`（T3 假綠教訓）。
 *   - cleanup 僅限本檔追蹤之 id ／ loginName 前綴；絕不 `deleteMany({})`。
 *   - 一律合成資料；里程斷言一律精確等值（`toFixed(2)` 字串比對，零浮點中介）。
 *   - 年度採 2210~2213（避讓既有測試檔之年度：T8 用 2190-2193、phase5a 用
 *     2061-2062、phase6/7 各自年度），避免同一 worker schema 下之互相污染。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import { sumOfficialMileage } from "../../src/mileage/mileage-engine.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const LOGIN_PREFIX = "p9t9_";
const PASSWORD = "P9t9-Synthetic-Passw0rd!";

// ===========================================================================
// §A — AC-16 結構性斷言：`backend/src/mileage/` 全目錄本 Phase 零 diff
//
// 手法沿既有兩個先例（皆為本 repo 內既有做法，非本 Task 新發明）：
//   · 檔案清單封閉比對 —— `phase8-contract.test.ts:304`
//     （`PHASE_008_SRC_FILES` 九檔清單 vs 目錄實際 `.ts` 檔）。
//   · 原始碼 SHA-256 釘選 —— `phase5a-travel-complete.test.ts:154`
//     （`travel-calculation.ts` 之 sha256 釘選，「若日後修改該檔哪怕一個字元，
//     本測試必紅」）。
//
// 兩者相加即為「全目錄零 diff」：清單擋新增／刪除檔案，逐檔雜湊擋任何位元變動。
// 釘選值之出處（可由人類複驗）：PHASE-009 之 Phase 基準 commit `ac56f20`
// （「docs: PHASE-009 開工記錄」，本 Phase 第一個 commit 之前）——
//   `git show ac56f20:backend/src/mileage/<file> | sha256sum`
// 且已實測 `git show` 之 blob 與工作區磁碟內容位元組全等（無 CRLF 轉換差異）。
// 因此「磁碟內容雜湊 == 基準 commit 雜湊」即 = 「本 Phase 該檔零 diff」。
// ===========================================================================

describe("AC-16 結構: backend/src/mileage 全目錄本 Phase 零 diff", () => {
  /**
   * 相對 `backend/src/mileage/` 之檔名 → PHASE-009 基準 commit `ac56f20` 之
   * 原始碼 SHA-256（hex）。
   */
  const MILEAGE_SRC_BASELINE: Record<string, string> = {
    "mileage-engine.ts": "6b44e84ec722439f1e640f6dbbc37d138a7289db653a5b0aba71e183c0a17ad5",
    "mileage-range.ts": "e93f1abad1f7cc5964150a3246b414332d827912e6608b55bcb6c33382e29957",
    "routes.ts": "a61ed26af658fc56a438195fcc82247e087c4c5f017e2587c38a011ba83e24ab",
  };

  const MILEAGE_DIR = path.join(BACKEND_ROOT, "src/mileage");

  it("目錄之實際 .ts 檔案清單恰為三檔（於 src/mileage/ 新增或刪除任何檔案即紅）", () => {
    const actual = fs
      .readdirSync(MILEAGE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(actual).toEqual(Object.keys(MILEAGE_SRC_BASELINE).sort());
    // 正向對照：清單非空（非因目錄不存在／讀取失敗而恆真通過）。
    expect(actual.length).toBe(3);
  });

  it("三檔之原始碼 SHA-256 逐檔等於 PHASE-009 基準 commit ac56f20 之值（改動任一位元組即紅）", () => {
    for (const [file, expectedHash] of Object.entries(MILEAGE_SRC_BASELINE)) {
      const bytes = fs.readFileSync(path.join(MILEAGE_DIR, file));
      const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
      expect(actualHash, `src/mileage/${file} 於本 Phase 已被修改（AC-16 要求零 diff）`).toBe(
        expectedHash
      );
    }
  });

  it('AC-16 逐字: buildOfficialMileageWhere 之 status 為字面 "COMPLETED"，原始碼中不存在 { not: "DRAFT" } 之否定式過濾', () => {
    const src = fs.readFileSync(path.join(MILEAGE_DIR, "mileage-range.ts"), "utf-8");
    const whereBody = /export function buildOfficialMileageWhere\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(whereBody, "buildOfficialMileageWhere 宣告未找到").not.toBe("");
    expect(whereBody).toContain('status: "COMPLETED"');
    expect(whereBody).not.toMatch(/not:\s*"DRAFT"/);
  });
});

// ===========================================================================
// §B — AC-16／AC-17 真實流程回歸（需 DB ＋ HTTP）
// ===========================================================================

describeWithDb("PHASE-009-T9 — 統計排除之真實作廢流程回歸（AC-16／AC-17）", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  let ownerId: string;
  let ownerCookie: string;
  let adminId: string;

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdDepreciationParamIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  async function login(loginName: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password: PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`login failed: ${resp.statusCode} ${resp.body}`);
    }
    const raw = resp.headers["set-cookie"];
    const str = Array.isArray(raw) ? raw[0] : (raw as string);
    return str.split(";")[0];
  }

  async function createUser(
    suffix: string,
    role: "USER" | "ADMIN"
  ): Promise<{ id: string; cookie: string }> {
    const loginName = `${LOGIN_PREFIX}${suffix}_${RUN_ID}`;
    const user = await prisma.user.create({
      data: {
        loginName,
        displayName: `T9 ${suffix}`,
        passwordHash: await hashPassword(PASSWORD),
        role,
        isActive: true,
        // T3 假綠教訓：fixture 一律顯式指定，不倚賴 schema 預設。
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);
    return { id: user.id, cookie: await login(loginName) };
  }

  /**
   * 一筆**已完成**差旅（統計之分子來源）。
   *
   * 完成側以 Prisma 直寫合成（沿 `phase6-official-mileage.test.ts` ／
   * `phase7-annual-mileage.test.ts` ／ `phase9-void.test.ts` 之既有先例）——
   * §11.0 #4 之「真實流程」義務針對的是**作廢**這一側（本檔全部走端點），
   * 完成側之真實流程正確性屬 PHASE-004/005a 既有覆蓋，非本 AC 之對象。
   */
  async function seedCompletedTravel(opts: {
    tripDate: string;
    snapshotTotalKm: string;
    purpose: string;
  }): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${opts.tripDate}T00:00:00.000Z`),
        totalAmount: 100,
        completedAt: new Date(`${opts.tripDate}T08:00:00.000Z`),
        travel: {
          create: {
            tripDate: new Date(`${opts.tripDate}T00:00:00.000Z`),
            purpose: opts.purpose,
            snapshotTotalKm: opts.snapshotTotalKm,
          },
        },
      },
    });
    return trackApp(created.id);
  }

  /** 直接建立一張 `LINKED` 附件（免上傳來回；沿 phase7 `linkProof` 先例）。 */
  async function linkProof(
    refType: "MAINTENANCE" | "DEPRECIATION",
    refId: string
  ): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        status: "LINKED",
        storageKey: `p9t9/${RUN_ID}-${createdAttachmentIds.length}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 256,
        originalFilename: "proof.jpg",
        uploaderId: ownerId,
        ownerId,
        refType,
        refId,
        linkedAt: new Date(),
      },
    });
    createdAttachmentIds.push(attachment.id);
    return attachment.id;
  }

  /** **真實作廢端點**（§11.0 #4：不得以 `prisma.application.update` 直寫）。 */
  async function voidViaEndpoint(id: string, reason: string): Promise<void> {
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason },
    });
    expect(resp.statusCode, `void 端點未回 200：${resp.body}`).toBe(200);
    // 端點確實把狀態改為 VOIDED（作廢事實成立，後續統計斷言才有意義）。
    const row = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("VOIDED");
    expect(row.voidedAt).not.toBeNull();
    expect(row.voidedById).toBe(ownerId);
  }

  async function createMaintenanceDraft(opts: {
    lastMaintenanceDate: string;
    currentMaintenanceDate: string;
    lastOdometerKm: string;
    currentOdometerKm: string;
    actualCost: string;
  }): Promise<string> {
    const createResp = await app.inject({
      method: "POST",
      url: "/applications/maintenance",
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(createResp.statusCode).toBe(201);
    const id = trackApp(createResp.json<{ application: { id: string } }>().application.id);

    const putResp = await app.inject({
      method: "PUT",
      url: `/applications/maintenance/${id}`,
      headers: { cookie: ownerCookie },
      payload: opts,
    });
    expect(putResp.statusCode, putResp.body).toBe(200);
    return id;
  }

  async function createDepreciationDraft(
    applicationYear: number,
    annualTotalKm: string
  ): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/applications/depreciation",
      headers: { cookie: ownerCookie },
      payload: { applicationYear, annualTotalKm },
    });
    expect(resp.statusCode, resp.body).toBe(201);
    return trackApp(resp.json<{ application: { id: string } }>().application.id);
  }

  async function completeHttp(id: string): Promise<void> {
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/complete`,
      headers: { cookie: ownerCookie },
    });
    expect(resp.statusCode, `complete 未回 200：${resp.body}`).toBe(200);
  }

  type MaintenanceDto = {
    computed?: { officialKm: string | null } | null;
    snapshot?: { officialKm: string; ratio: string; rawAmount: string } | null;
  };
  type DepreciationDto = MaintenanceDto;

  async function getMaintenance(id: string): Promise<MaintenanceDto> {
    const resp = await app.inject({
      method: "GET",
      url: `/applications/maintenance/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(resp.statusCode, resp.body).toBe(200);
    return resp.json<{ application: MaintenanceDto }>().application;
  }

  async function getDepreciation(id: string): Promise<DepreciationDto> {
    const resp = await app.inject({
      method: "GET",
      url: `/applications/depreciation/${id}`,
      headers: { cookie: ownerCookie },
    });
    expect(resp.statusCode, resp.body).toBe(200);
    return resp.json<{ application: DepreciationDto }>().application;
  }

  /** 引擎直呼（AC-16 之受測對象）。 */
  function sumRange(dateFrom: string, dateTo: string) {
    return sumOfficialMileage(prisma, {
      ownerId,
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
      dateTo: new Date(`${dateTo}T00:00:00.000Z`),
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    app = await buildServer({ databaseUrl: DB_URL, logLevel: "error" });
    await app.ready();

    const owner = await createUser("owner", "USER");
    ownerId = owner.id;
    ownerCookie = owner.cookie;
    const admin = await createUser("admin", "ADMIN");
    adminId = admin.id;

    // 折舊參數版本（AC-17(b)/(c) 之折舊完成與草稿計算前提）。
    const param = await prisma.depreciationParameterVersion.create({
      data: {
        vehiclePrice: new Prisma.Decimal("600000.00"),
        usefulLifeYears: 5,
        estimatedAnnualKm: new Prisma.Decimal("20000.0"),
        effectiveFrom: new Date("2200-01-01T00:00:00.000Z"),
        createdById: adminId,
      },
    });
    createdDepreciationParamIds.push(param.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (app) await app.close();
    if (createdAttachmentIds.length > 0) {
      await prisma.attachment.deleteMany({ where: { id: { in: createdAttachmentIds } } });
    }
    if (createdApplicationIds.length > 0) {
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    if (createdDepreciationParamIds.length > 0) {
      await prisma.depreciationParameterVersion.deleteMany({
        where: { id: { in: createdDepreciationParamIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  // =========================================================================
  // AC-16 — 區間公務里程排除已作廢（PHASE-005 AC-04 之真實流程回歸）
  // =========================================================================

  describe("AC-16: 經真實作廢端點作廢後，sumOfficialMileage 恰等於未含該筆之值", () => {
    const FROM = "2210-01-01";
    const TO = "2210-12-31";
    const KM_A = "120.50";
    const KM_B = "250.25";
    const KM_C = "40.00";

    it('三筆已完成差旅 → 作廢中間一筆（真實端點）→ 總和恰等於另兩筆之和、筆數恰減 1；且 { not: "DRAFT" } mutant 條件於同一組資料下必得不同值（鑑別力正向對照）', async () => {
      const idA = await seedCompletedTravel({
        tripDate: "2210-03-01",
        snapshotTotalKm: KM_A,
        purpose: "T9 AC-16 差旅 A",
      });
      const idB = await seedCompletedTravel({
        tripDate: "2210-06-15",
        snapshotTotalKm: KM_B,
        purpose: "T9 AC-16 差旅 B（待作廢）",
      });
      const idC = await seedCompletedTravel({
        tripDate: "2210-09-09",
        snapshotTotalKm: KM_C,
        purpose: "T9 AC-16 差旅 C",
      });
      expect([idA, idB, idC].every((id) => typeof id === "string")).toBe(true);

      // 「未含該筆之值」之獨立基準：由三個 fixture 常數直接算出（不倚賴引擎
      // 自身的任何中間結果），故此為外部真值而非自證循環。
      const sumAll = new Prisma.Decimal(KM_A).plus(KM_B).plus(KM_C); // 410.75
      const sumWithoutB = new Prisma.Decimal(KM_A).plus(KM_C); // 160.50

      const before = await sumRange(FROM, TO);
      expect(before.totalKm.toFixed(2)).toBe(sumAll.toFixed(2));
      expect(before.applicationCount).toBe(3);

      // ── 真實作廢端點（非 prisma.application.update 直寫，§11.0 #4）──────
      await voidViaEndpoint(idB, "AC-16 真實流程回歸：作廢差旅 B");

      const after = await sumRange(FROM, TO);
      expect(after.totalKm.toFixed(2)).toBe(sumWithoutB.toFixed(2));
      expect(after.applicationCount).toBe(2);
      // 差額恰為被作廢那筆之里程（「恰等於未含該筆之值」之等價逐字檢查）。
      expect(before.totalKm.minus(after.totalKm).toFixed(2)).toBe(
        new Prisma.Decimal(KM_B).toFixed(2)
      );

      // ── mutant 鑑別力正向對照（不改 src/）─────────────────────────────
      // 若 `buildOfficialMileageWhere` 之 status 被改為 `{ not: "DRAFT" }`，
      // 剛被作廢的 B 會重新被算進來。此處於測試內就地建構該 mutant 條件，
      // 證明本組 fixture 資料確實能鑑別兩者（非「怎麼寫都會過」的恆真斷言）。
      const mutantAgg = await prisma.travelApplication.aggregate({
        where: {
          application: {
            ownerId,
            type: "TRAVEL",
            status: { not: "DRAFT" },
            travel: {
              tripDate: {
                gte: new Date(`${FROM}T00:00:00.000Z`),
                lte: new Date(`${TO}T00:00:00.000Z`),
              },
            },
          },
        },
        _sum: { snapshotTotalKm: true },
        _count: { _all: true },
      });
      expect(mutantAgg._sum.snapshotTotalKm?.toFixed(2)).toBe(sumAll.toFixed(2));
      expect(mutantAgg._count._all).toBe(3);
      // 正解與 mutant 必不相等 —— 鑑別力成立。
      expect(after.totalKm.toFixed(2)).not.toBe(mutantAgg._sum.snapshotTotalKm?.toFixed(2));
    });
  });

  // =========================================================================
  // AC-17 — 保養期間與折舊年度公務里程排除已作廢（同一引擎之兩個消費端）
  // =========================================================================

  describe("AC-17(a): 保養草稿之 computed.officialKm 於區間內某差旅被真實作廢後下降對應值", () => {
    it("期間內兩筆已完成差旅（100.00 ＋ 60.00）→ 草稿 officialKm 160.00；作廢其中 60.00 那筆 → 恰降為 100.00", async () => {
      await seedCompletedTravel({
        tripDate: "2211-02-02",
        snapshotTotalKm: "100.00",
        purpose: "T9 AC-17(a) 保留",
      });
      const voidTargetId = await seedCompletedTravel({
        tripDate: "2211-04-04",
        snapshotTotalKm: "60.00",
        purpose: "T9 AC-17(a) 待作廢",
      });

      const draftId = await createMaintenanceDraft({
        lastMaintenanceDate: "2211-01-01",
        currentMaintenanceDate: "2211-06-30",
        lastOdometerKm: "1000.00",
        currentOdometerKm: "1500.00",
        actualCost: "1000.00",
      });

      const before = await getMaintenance(draftId);
      expect(before.computed?.officialKm).toBe("160.00");

      await voidViaEndpoint(voidTargetId, "AC-17(a) 真實流程回歸：作廢期間內差旅");

      const after = await getMaintenance(draftId);
      expect(after.computed?.officialKm).toBe("100.00");
      // 下降量恰為被作廢那筆之里程（AC-17(a)「下降對應值」逐字）。
      expect(
        new Prisma.Decimal(before.computed?.officialKm ?? "0")
          .minus(new Prisma.Decimal(after.computed?.officialKm ?? "0"))
          .toFixed(2)
      ).toBe("60.00");
    });
  });

  describe("AC-17(b): 折舊草稿之年度公務里程於年度內某差旅被真實作廢後下降對應值", () => {
    it("年度內兩筆已完成差旅（300.00 ＋ 200.00）→ 草稿 officialKm 500.00；作廢其中 200.00 那筆 → 恰降為 300.00", async () => {
      await seedCompletedTravel({
        tripDate: "2212-03-03",
        snapshotTotalKm: "300.00",
        purpose: "T9 AC-17(b) 保留",
      });
      const voidTargetId = await seedCompletedTravel({
        tripDate: "2212-08-08",
        snapshotTotalKm: "200.00",
        purpose: "T9 AC-17(b) 待作廢",
      });

      const draftId = await createDepreciationDraft(2212, "5000.0");

      const before = await getDepreciation(draftId);
      expect(before.computed?.officialKm).toBe("500.00");

      await voidViaEndpoint(voidTargetId, "AC-17(b) 真實流程回歸：作廢年度內差旅");

      const after = await getDepreciation(draftId);
      expect(after.computed?.officialKm).toBe("300.00");
      expect(
        new Prisma.Decimal(before.computed?.officialKm ?? "0")
          .minus(new Prisma.Decimal(after.computed?.officialKm ?? "0"))
          .toFixed(2)
      ).toBe("200.00");
    });
  });

  describe("AC-17(c): 已完成之保養／折舊快照於作廢後不變（快照即歷史）", () => {
    it("同一次作廢事件下：已完成側之 snapshot.officialKm 與整列指紋逐欄不變，草稿側（重算路徑）同步下降 —— 已完成側若改為重算則必紅", async () => {
      // 年度 2213 內兩筆已完成差旅；保養期間亦涵蓋此兩筆。
      await seedCompletedTravel({
        tripDate: "2213-02-02",
        snapshotTotalKm: "150.00",
        purpose: "T9 AC-17(c) 保留",
      });
      const voidTargetId = await seedCompletedTravel({
        tripDate: "2213-05-05",
        snapshotTotalKm: "50.00",
        purpose: "T9 AC-17(c) 待作廢",
      });

      // ── 已完成側：保養 ────────────────────────────────────────────────
      const completedMaintenanceId = await createMaintenanceDraft({
        lastMaintenanceDate: "2213-01-01",
        currentMaintenanceDate: "2213-06-30",
        lastOdometerKm: "2000.00",
        currentOdometerKm: "2500.00",
        actualCost: "1000.00",
      });
      await linkProof("MAINTENANCE", completedMaintenanceId);
      await completeHttp(completedMaintenanceId);

      // ── 已完成側：折舊 ────────────────────────────────────────────────
      const completedDepreciationId = await createDepreciationDraft(2213, "4000.0");
      await linkProof("DEPRECIATION", completedDepreciationId);
      await completeHttp(completedDepreciationId);

      // ── 草稿側（同期間／同年度）：作為「重算路徑確實會變」之對照組 ────
      const draftMaintenanceId = await createMaintenanceDraft({
        lastMaintenanceDate: "2213-01-01",
        currentMaintenanceDate: "2213-06-30",
        lastOdometerKm: "3000.00",
        currentOdometerKm: "3500.00",
        actualCost: "1000.00",
      });
      const draftDepreciationId = await createDepreciationDraft(2213, "4000.0");

      // 作廢前之四項觀測。
      const maintSnapBefore = await getMaintenance(completedMaintenanceId);
      const deprSnapBefore = await getDepreciation(completedDepreciationId);
      const maintDraftBefore = await getMaintenance(draftMaintenanceId);
      const deprDraftBefore = await getDepreciation(draftDepreciationId);

      expect(maintSnapBefore.snapshot?.officialKm).toBe("200.00");
      expect(deprSnapBefore.snapshot?.officialKm).toBe("200.00");
      expect(maintDraftBefore.computed?.officialKm).toBe("200.00");
      expect(deprDraftBefore.computed?.officialKm).toBe("200.00");

      // 已完成側之 DB 列全欄指紋（快照欄與金額欄逐欄，比 DTO 更嚴）。
      const maintRowBefore = await prisma.maintenanceApplication.findUniqueOrThrow({
        where: { applicationId: completedMaintenanceId },
      });
      const deprRowBefore = await prisma.depreciationApplication.findUniqueOrThrow({
        where: { applicationId: completedDepreciationId },
      });
      const maintAppBefore = await prisma.application.findUniqueOrThrow({
        where: { id: completedMaintenanceId },
      });
      const deprAppBefore = await prisma.application.findUniqueOrThrow({
        where: { id: completedDepreciationId },
      });

      // ── 單一作廢事件（真實端點）────────────────────────────────────────
      await voidViaEndpoint(voidTargetId, "AC-17(c) 真實流程回歸：作廢後歷史不得改變");

      // (c) 已完成快照不變 —— DTO 層。
      const maintSnapAfter = await getMaintenance(completedMaintenanceId);
      const deprSnapAfter = await getDepreciation(completedDepreciationId);
      expect(maintSnapAfter.snapshot).toEqual(maintSnapBefore.snapshot);
      expect(deprSnapAfter.snapshot).toEqual(deprSnapBefore.snapshot);
      expect(maintSnapAfter.snapshot?.officialKm).toBe("200.00");
      expect(deprSnapAfter.snapshot?.officialKm).toBe("200.00");

      // (c) 已完成快照不變 —— DB 列層（逐欄）。
      expect(
        await prisma.maintenanceApplication.findUniqueOrThrow({
          where: { applicationId: completedMaintenanceId },
        })
      ).toEqual(maintRowBefore);
      expect(
        await prisma.depreciationApplication.findUniqueOrThrow({
          where: { applicationId: completedDepreciationId },
        })
      ).toEqual(deprRowBefore);
      expect(
        await prisma.application.findUniqueOrThrow({ where: { id: completedMaintenanceId } })
      ).toEqual(maintAppBefore);
      expect(
        await prisma.application.findUniqueOrThrow({ where: { id: completedDepreciationId } })
      ).toEqual(deprAppBefore);

      // ── mutant 鑑別力（不改 src/）：同一次作廢事件下，重算路徑確實下降 ──
      // 若已完成側改為重算（而非讀快照），其值必與下列草稿側同步降為 150.00，
      // 上方「不變」之斷言即必紅。故本組對照證明上方斷言非恆真。
      const maintDraftAfter = await getMaintenance(draftMaintenanceId);
      const deprDraftAfter = await getDepreciation(draftDepreciationId);
      expect(maintDraftAfter.computed?.officialKm).toBe("150.00");
      expect(deprDraftAfter.computed?.officialKm).toBe("150.00");
      expect(maintSnapAfter.snapshot?.officialKm).not.toBe(maintDraftAfter.computed?.officialKm);
      expect(deprSnapAfter.snapshot?.officialKm).not.toBe(deprDraftAfter.computed?.officialKm);
    });
  });
});
