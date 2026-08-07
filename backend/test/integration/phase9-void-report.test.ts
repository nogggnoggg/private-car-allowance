/**
 * PHASE-009-T10 — `ReportData` 之作廢欄位（AC-19）＋ `report-data.ts` 附件排序
 * tiebreaker 守門（AC-39）
 *
 * ---------------------------------------------------------------------------
 * 規範出處（`docs/specs/PHASE-009.md`，逐字引用）
 * ---------------------------------------------------------------------------
 * AC-19（:205）：「**AC-19 `ReportData` 之作廢欄位（封閉鍵集之受控擴充）**——
 *   `ReportCommon` 新增**恰一個**欄位 `void: { reason: string; at: string;
 *   byDisplayName: string } | null`（未作廢恆為 `null`）。斷言：(a)
 *   `ReportCommon` 鍵集 `toEqual` 全等（**八鍵**，多一鍵必紅）；(b) 三型 body
 *   鍵集**逐字不變**（作廢資訊只落於 `common`，不污染三型 body）；(c)
 *   `byDisplayName` 取自作廢當下之操作者顯示名稱（`voidedById` 解析；使用者不
 *   存在時以 `"—"` 呈現，不拋錯、不洩漏 id）；(d) `report-data.ts` **零算式**之
 *   既有結構掃描（`.times(`／`.div(`／`.plus(`／`.minus(` 零出現）維持全綠。」
 *
 * AC-39（:257）：「**AC-39 `report-data.ts` 附件排序 tiebreaker 守門**——(a) 結
 *   構性斷言：`report-data.ts` 之 `orderBy` 含 `{ id: "asc" }` **恰兩處**（差旅
 *   段路徑＋保養／折舊路徑；移除任一處必紅）；(b) 行為斷言：**保養／折舊**路徑
 *   之三張同 `linkedAt` 附件、寫入序與 `id` 遞增序刻意相反時，輸出恆依 `id` 遞
 *   增序（既有僅差旅覆蓋——PHASE-008 終審 AR-2／X8b 守門缺口之關閉）。」
 *
 * §8.4（:580）：「作廢**只**改 `status` 與三個作廢欄；`totalAmount`、
 *   `completedAt`、三型全部 `snapshot*` 欄**逐欄不變**（AC-04）。」——故本檔之
 *   `void.at` 採與 `common.createdAt`／`common.generatedAt` **同型**之 ISO8601
 *   字串（`toISOString()`）；台北時區中文格式化屬**列印版**之責（AC-20 明文：
 *   「沿 `formatTaipeiDateTime` **唯一**格式化來源，不新增第二個格式化函式」），
 *   資料層不得預先格式化，否則列印版將無法沿用唯一格式化來源。
 *
 * ---------------------------------------------------------------------------
 * TDD 紅燈實錄（先紅後綠）
 * ---------------------------------------------------------------------------
 * 本檔於 `src/reports/report-data.ts` 尚未擴充 `void` 欄之狀態下先行落地，紅燈
 * 證據以 `git stash` 法取得（完整輸出見 Task Handoff）：
 *   · AC-19 全部案例因 `ReportCommon` 無 `void` 鍵而紅（tsc 亦紅）。
 *   · AC-39 兩則於實作**未變動**下天然全綠（`orderBy` 兩處早在 PHASE-008 即已
 *     正確；缺的是守門）——故其鑑別力改以 **mutant 自證**取得（Spec §11.0 #2），
 *     實錄（暫改 `src/` 後復原，不烙入本檔）見 Handoff：
 *       ① 移除 `fetchSegmentAttachments` 之 `{ id: "asc" }` → (a) 必紅
 *       ② 移除 `fetchApplicationAttachments` 之 `{ id: "asc" }` → (a)＋(b) 必紅
 *
 * ---------------------------------------------------------------------------
 * 測試紀律（Spec §11.0 ／ Packet）
 * ---------------------------------------------------------------------------
 *   - loginName 前綴 `p9t10_` ＋ 每次執行之隨機 `RUN_ID` 後綴。
 *   - fixture 使用者顯式指定 `mustChangePassword: false`（T3 假綠教訓）。
 *   - 作廢一律走**真實端點** `POST /applications/:id/void`（§11.0 #4）。
 *   - cleanup 僅限本檔追蹤之 id；絕不 `deleteMany({})`。
 *   - 一律合成資料。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import {
  type ReportApplicationRecord,
  type ReportData,
  buildReportData,
  reportApplicationInclude,
} from "../../src/reports/report-data.js";
import { buildServer } from "../../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DATA_SRC_PATH = path.resolve(__dirname, "../../src/reports/report-data.ts");

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const LOGIN_PREFIX = "p9t10_";
const PASSWORD = "P9t10-Synthetic-Passw0rd!";

/** AC-19(c)：`voidedById` 無 FK，故「使用者不存在」為可達狀態之合成 id。 */
const ORPHAN_VOIDER_ID = `p9t10-deleted-user-${RUN_ID}`;

// ===========================================================================
// §A — 結構性斷言（不需 DB；任何環境皆執行）
// ===========================================================================

/**
 * 僅抹除註解（保留字串字面），供 AC-39(a) 之 `{ id: "asc" }` 計數使用——與
 * `phase8-report-data.test.ts:124` 之 `blankCommentsAndStrings` 為姊妹手法，差
 * 別在於本函式**必須保留字串**（`"asc"` 本身即待計數之字面）。
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `phase8-report-data.test.ts:124` 之同名手法（註解＋字串皆抹除）。 */
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "`") {
      out += " ";
      i++;
      while (i < n && src[i] !== "`") {
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function countMatches(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

/** 由 `async function <name>(` 起至下一個頂層 `\n}` 止之函式本體。 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf("\n}", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

const ID_ASC_RE = /\{\s*id:\s*"asc"\s*\}/g;

describe("PHASE-009-T10 §A — report-data.ts 結構性掃描（AC-19(d)／AC-39(a)）", () => {
  it("AC-19(d): report-data.ts 原始碼零 .times(/.div(/.plus(/.minus(（PHASE-008 AC-17(c) 之既有掃描於本 Phase 擴欄後維持全綠）", () => {
    const src = blankCommentsAndStrings(fs.readFileSync(REPORT_DATA_SRC_PATH, "utf8"));
    expect(src).not.toMatch(/\.times\(/);
    expect(src).not.toMatch(/\.div\(/);
    expect(src).not.toMatch(/\.plus\(/);
    expect(src).not.toMatch(/\.minus\(/);
  });

  it('AC-39(a) 結構: report-data.ts 之 orderBy 含 { id: "asc" } 恰兩處（移除任一處必紅）', () => {
    const src = blankComments(fs.readFileSync(REPORT_DATA_SRC_PATH, "utf8"));

    // 全檔恰兩處（多一處／少一處皆紅）。
    expect(countMatches(src, ID_ASC_RE)).toBe(2);

    // 兩處皆須落在 `orderBy: [...]` 陣列內（而非任何其他語境）。
    expect(countMatches(src, /orderBy:\s*\[[^\]]*\{\s*id:\s*"asc"\s*\}[^\]]*\]/g)).toBe(2);

    // 逐路徑定位：差旅段路徑一處、保養／折舊路徑一處——避免「兩處都擠在同一
    // 個函式」仍能通過全檔計數之假綠。
    const segmentBody = functionBody(src, "fetchSegmentAttachments");
    const applicationBody = functionBody(src, "fetchApplicationAttachments");
    expect(segmentBody, "fetchSegmentAttachments 宣告未找到").not.toBe("");
    expect(applicationBody, "fetchApplicationAttachments 宣告未找到").not.toBe("");
    expect(countMatches(segmentBody, ID_ASC_RE)).toBe(1);
    expect(countMatches(applicationBody, ID_ASC_RE)).toBe(1);

    // 兩處之 tiebreaker 皆須排在 `linkedAt` 之後（次序顛倒即非 tiebreaker）。
    for (const body of [segmentBody, applicationBody]) {
      expect(body).toMatch(
        /orderBy:\s*\[\s*\{\s*linkedAt:\s*"asc"\s*\},\s*\{\s*id:\s*"asc"\s*\}\s*\]/
      );
    }
  });
});

// ===========================================================================
// §B — 鍵集常數（AC-19(a)(b)）
//
// `COMMON_KEYS` 為本 Phase 之**八鍵**（AC-19 明文之受控擴充：七 → 八）；三型
// body 之鍵集則逐字沿用 PHASE-008 `phase8-report-data.test.ts` 之既有清單，一
// 字未改——這正是 AC-19(b)「作廢資訊只落於 common，不污染三型 body」之證。
// ===========================================================================

const COMMON_KEYS = [
  "reportNumber",
  "generatedAt",
  "ownerDisplayName",
  "typeLabel",
  "statusLabel",
  "createdAt",
  "totalAmount",
  "void",
].sort();

const TRAVEL_KEYS = [
  "model",
  "tripDate",
  "purpose",
  "segments",
  "totalKm",
  "preRoundingTotal",
  "fuelUnitPrice",
  "etcUnitPrice",
  "fuelType",
  "fuelPricePerLiter",
  "fuelConsumption",
].sort();

const MAINTENANCE_KEYS = [
  "lastMaintenanceDate",
  "currentMaintenanceDate",
  "lastOdometerKm",
  "currentOdometerKm",
  "intervalKm",
  "officialKm",
  "ratioPercent",
  "actualCost",
  "companyAmount",
  "attachments",
].sort();

const DEPRECIATION_KEYS = [
  "model",
  "applicationYear",
  "annualDepreciation",
  "annualTotalKm",
  "ratioPercent",
  "perKmUnitPrice",
  "officialKm",
  "attachments",
].sort();

const VOID_KEYS = ["reason", "at", "byDisplayName"].sort();

/** 取出三型分派之 body（`kind` 與 `common` 以外之唯一鍵）。 */
function bodyOf(data: ReportData): Record<string, unknown> {
  if (data.kind === "TRAVEL") return data.travel as unknown as Record<string, unknown>;
  if (data.kind === "MAINTENANCE") return data.maintenance as unknown as Record<string, unknown>;
  return data.depreciation as unknown as Record<string, unknown>;
}

function bodyKeysOf(data: ReportData): string[] {
  if (data.kind === "TRAVEL") return TRAVEL_KEYS;
  if (data.kind === "MAINTENANCE") return MAINTENANCE_KEYS;
  return DEPRECIATION_KEYS;
}

// ===========================================================================
// §C — 行為（需 DB ＋ HTTP）
// ===========================================================================

describeWithDb("PHASE-009-T10 §C — buildReportData 之作廢欄位與排序（AC-19／AC-39）", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  let ownerId: string;
  let ownerCookie: string;
  let ownerDisplayName: string;

  let travelVoidedId: string;
  let travelActiveId: string;
  let travelOrphanVoidedId: string;
  let maintenanceVoidedId: string;
  let maintenanceActiveId: string;
  let depreciationVoidedId: string;
  let depreciationActiveId: string;

  const VOID_REASON = "T10 合成作廢原因：金額誤植，重新申報";
  const ORPHAN_VOID_REASON = "T10 合成作廢原因：操作者帳號其後已被刪除";

  const createdApplicationIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdUserIds: string[] = [];

  function trackApp(id: string): string {
    createdApplicationIds.push(id);
    return id;
  }

  async function loadRecord(applicationId: string): Promise<ReportApplicationRecord> {
    return prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: reportApplicationInclude,
    });
  }

  async function buildFor(applicationId: string): Promise<ReportData> {
    return buildReportData(prisma, await loadRecord(applicationId), null);
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

  /**
   * 完成側以 Prisma 直寫合成（沿 `phase8-report-data.test.ts` ／
   * `phase9-void-statistics.test.ts` 之既有先例）——§11.0 #4 之「真實流程」義務
   * 針對的是**作廢**這一側（本檔全部走端點）。
   */
  async function seedCompletedTravel(purpose: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2214-03-15T00:00:00.000Z"),
        totalAmount: 888,
        completedAt: new Date("2214-03-16T02:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2214-03-15T00:00:00.000Z"),
            purpose,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            etcParameterVersionId: "p9t10-etc-v1",
            fuelPriceVersionId: "p9t10-fuel-price-v1",
            fuelConsumptionVersionId: "p9t10-fuel-consum-v1",
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "15.2000",
            snapshotTotalKm: "150.75",
            snapshotRawAmount: "888.8888",
            calculatedAt: new Date("2214-03-16T02:00:00.000Z"),
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "新竹",
                  totalKm: "150.75",
                  highwayKm: "80.00",
                  snapshotFuelAmount: "353.6000",
                  snapshotEtcAmount: "98.7600",
                  snapshotRawAmount: "888.8888",
                  snapshotAmount: 888,
                },
              ],
            },
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function seedCompletedMaintenance(): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "MAINTENANCE",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2214-05-20T00:00:00.000Z"),
        totalAmount: 3200,
        completedAt: new Date("2214-05-21T02:00:00.000Z"),
        maintenance: {
          create: {
            lastMaintenanceDate: new Date("2213-11-20T00:00:00.000Z"),
            currentMaintenanceDate: new Date("2214-05-20T00:00:00.000Z"),
            lastOdometerKm: "10000.00",
            currentOdometerKm: "18000.00",
            actualCost: "8000.00",
            snapshotIntervalKm: "8000.00",
            snapshotOfficialKm: "3200.00",
            snapshotRatio: "0.400000",
            snapshotRawAmount: "3200.0000",
            calculatedAt: new Date("2214-05-21T02:00:00.000Z"),
          },
        },
      },
    });
    return trackApp(created.id);
  }

  async function seedCompletedDepreciation(year: number): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "DEPRECIATION",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date(`${year}-12-31T00:00:00.000Z`),
        totalAmount: 24000,
        completedAt: new Date(`${year}-12-31T02:00:00.000Z`),
        depreciation: {
          create: {
            applicationYear: year,
            annualTotalKm: "20000.0",
            snapshotVehiclePrice: "600000.00",
            snapshotUsefulLifeYears: 5,
            snapshotAnnualDepreciation: "120000.00",
            snapshotOfficialKm: "4000.00",
            snapshotAnnualTotalKm: "20000.0",
            snapshotRatio: "0.200000",
            snapshotRawAmount: "24000.0000",
            calculatedAt: new Date(`${year}-12-31T02:00:00.000Z`),
          },
        },
      },
    });
    return trackApp(created.id);
  }

  /**
   * AC-39(b) 之關鍵 fixture：三張**同 `linkedAt`** 之 `LINKED` 附件，`id` 顯式
   * 指定為遞增序（`…-a` < `…-b` < `…-c`），而**寫入順序刻意相反**（c → b → a）。
   * 無 tiebreaker 時，Postgres 對相同 `linkedAt` 之列不保證任何順序（實務上多
   * 為實體寫入序，即 c/b/a）；有 tiebreaker 時輸出恆為 a/b/c。
   */
  async function seedThreeSameLinkedAtAttachments(
    refType: "MAINTENANCE" | "DEPRECIATION",
    refId: string,
    idPrefix: string
  ): Promise<string[]> {
    const linkedAt = new Date("2214-06-01T00:00:00.000Z");
    const ascendingIds = [`${idPrefix}-a`, `${idPrefix}-b`, `${idPrefix}-c`];
    // 寫入序 = id 遞增序之反序。
    for (const id of [...ascendingIds].reverse()) {
      const attachment = await prisma.attachment.create({
        data: {
          id,
          status: "LINKED",
          storageKey: `att/${id}/proof.jpg`,
          mimeType: "image/jpeg",
          byteSize: 512,
          originalFilename: `${id}.jpg`,
          uploaderId: ownerId,
          ownerId,
          refType,
          refId,
          linkedAt,
        },
      });
      createdAttachmentIds.push(attachment.id);
    }
    return ascendingIds;
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
    const row = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("VOIDED");
    expect(row.voidReason).toBe(reason);
    expect(row.voidedAt).not.toBeNull();
    expect(row.voidedById).toBe(ownerId);
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await buildServer();
    await app.ready();

    ownerDisplayName = "T10 擁有人";
    const owner = await prisma.user.create({
      data: {
        loginName: `${LOGIN_PREFIX}owner_${RUN_ID}`,
        displayName: ownerDisplayName,
        passwordHash: await hashPassword(PASSWORD),
        role: "USER",
        isActive: true,
        // T3 假綠教訓：fixture 一律顯式指定，不倚賴 schema 預設。
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);
    ownerCookie = await login(owner.loginName);

    travelActiveId = await seedCompletedTravel("T10 未作廢差旅");
    travelVoidedId = await seedCompletedTravel("T10 已作廢差旅");
    travelOrphanVoidedId = await seedCompletedTravel("T10 孤兒操作者差旅");
    maintenanceActiveId = await seedCompletedMaintenance();
    maintenanceVoidedId = await seedCompletedMaintenance();
    depreciationActiveId = await seedCompletedDepreciation(2214);
    depreciationVoidedId = await seedCompletedDepreciation(2215);

    await seedThreeSameLinkedAtAttachments(
      "MAINTENANCE",
      maintenanceVoidedId,
      `p9t10-mnt-${RUN_ID}`
    );
    await seedThreeSameLinkedAtAttachments(
      "DEPRECIATION",
      depreciationVoidedId,
      `p9t10-dep-${RUN_ID}`
    );

    await voidViaEndpoint(travelVoidedId, VOID_REASON);
    await voidViaEndpoint(maintenanceVoidedId, VOID_REASON);
    await voidViaEndpoint(depreciationVoidedId, VOID_REASON);

    // AC-19(c) 孤兒案例：先經**真實端點**作廢（作廢事實由真實流程產生），再將
    // `voidedById` 改指向一個不存在之使用者 id，以模擬「作廢後該帳號被刪除」。
    // 何以不真的刪除使用者：`AuditLog.actorId` 為 FK（`onDelete` 預設
    // `Restrict`），而作廢端點必寫 `APPLICATION_VOIDED` 稽核列，故操作者實際上
    // **無法**被刪除；而 `Application.voidedById` **無 FK**（§8.3 明文，沿
    // `Report.generatedById` 慣例），懸空 id 本即為 schema 容許之可達狀態。此處
    // 之直寫只作用於該一欄，不繞過作廢流程本身。
    await voidViaEndpoint(travelOrphanVoidedId, ORPHAN_VOID_REASON);
    await prisma.application.update({
      where: { id: travelOrphanVoidedId },
      data: { voidedById: ORPHAN_VOIDER_ID },
    });
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
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  // =========================================================================
  // AC-19(a) — ReportCommon 鍵集恰八鍵（封閉；多一鍵必紅）
  // =========================================================================

  describe("AC-19(a): ReportCommon 鍵集恰八鍵（toEqual 全等，多一鍵必紅）", () => {
    it("三型 × 作廢／未作廢共六種組合之 common 鍵集皆恰等於八鍵清單", async () => {
      const ids = [
        travelActiveId,
        travelVoidedId,
        maintenanceActiveId,
        maintenanceVoidedId,
        depreciationActiveId,
        depreciationVoidedId,
      ];
      expect(COMMON_KEYS.length).toBe(8);
      for (const id of ids) {
        const data = await buildFor(id);
        expect(Object.keys(data.common).sort(), `common 鍵集不符：${id}`).toEqual(COMMON_KEYS);
      }
    });

    it("void 物件本身亦為封閉三鍵（reason／at／byDisplayName；多一鍵如 voidedById 必紅）", async () => {
      const data = await buildFor(travelVoidedId);
      expect(data.common.void).not.toBeNull();
      const info = data.common.void;
      if (info === null) throw new Error("unreachable");
      expect(Object.keys(info).sort()).toEqual(VOID_KEYS);
    });

    it("未作廢申請之 void 恆為 null（負向；三型各一）", async () => {
      for (const id of [travelActiveId, maintenanceActiveId, depreciationActiveId]) {
        const data = await buildFor(id);
        expect(data.common.void, `未作廢卻有 void：${id}`).toBeNull();
        expect(data.common.statusLabel).toBe("已完成");
      }
    });

    it("已作廢申請之 statusLabel 為「已作廢」且 void 三欄逐值正確（真實端點產生）", async () => {
      const row = await prisma.application.findUniqueOrThrow({ where: { id: travelVoidedId } });
      const data = await buildFor(travelVoidedId);
      expect(data.common.statusLabel).toBe("已作廢");
      expect(data.common.void).toEqual({
        reason: VOID_REASON,
        at: row.voidedAt?.toISOString(),
        byDisplayName: ownerDisplayName,
      });
    });
  });

  // =========================================================================
  // AC-19(b) — 三型 body 鍵集逐字不變（作廢資訊不污染 body）
  // =========================================================================

  describe("AC-19(b): 三型 body 鍵集逐字不變（作廢資訊只落於 common）", () => {
    it("三型之作廢／未作廢兩態，body 鍵集皆逐字等於 PHASE-008 之既有清單", async () => {
      for (const id of [
        travelActiveId,
        travelVoidedId,
        maintenanceActiveId,
        maintenanceVoidedId,
        depreciationActiveId,
        depreciationVoidedId,
      ]) {
        const data = await buildFor(id);
        expect(Object.keys(bodyOf(data)).sort(), `body 鍵集不符：${id}`).toEqual(bodyKeysOf(data));
      }
    });

    it("已作廢三型之 body 序列化零作廢字面（reason／void 鍵／作廢時間皆不出現於 body）", async () => {
      for (const id of [travelVoidedId, maintenanceVoidedId, depreciationVoidedId]) {
        const row = await prisma.application.findUniqueOrThrow({ where: { id } });
        const data = await buildFor(id);
        const bodyJson = JSON.stringify(bodyOf(data));
        expect(bodyJson, `body 含作廢原因：${id}`).not.toContain(VOID_REASON);
        expect(bodyJson).not.toContain('"void"');
        expect(bodyJson).not.toContain('"byDisplayName"');
        expect(bodyJson).not.toContain(row.voidedAt?.toISOString() ?? "__never__");
        // 正向對照：作廢資訊確實存在於 common（否則上列負向恆真）。
        expect(JSON.stringify(data.common)).toContain(VOID_REASON);
      }
    });
  });

  // =========================================================================
  // AC-19(c) — byDisplayName 解析（含孤兒「—」）且零 voidedById 洩漏
  // =========================================================================

  describe("AC-19(c): byDisplayName 由 voidedById 解析；使用者不存在時為「—」且不洩漏 id", () => {
    it("正常態：byDisplayName 為作廢操作者之顯示名稱", async () => {
      const data = await buildFor(travelVoidedId);
      expect(data.common.void?.byDisplayName).toBe(ownerDisplayName);
    });

    it("孤兒態：voidedById 指向不存在之使用者 → byDisplayName 為「—」，不拋錯", async () => {
      const row = await prisma.application.findUniqueOrThrow({
        where: { id: travelOrphanVoidedId },
      });
      expect(row.voidedById).toBe(ORPHAN_VOIDER_ID);
      const data = await buildFor(travelOrphanVoidedId);
      expect(data.common.void).not.toBeNull();
      expect(data.common.void?.byDisplayName).toBe("—");
      expect(data.common.void?.reason).toBe(ORPHAN_VOID_REASON);
    });

    it("兩態之完整輸出皆零 voidedById（鍵名與值字面雙向負向）", async () => {
      for (const id of [travelVoidedId, travelOrphanVoidedId]) {
        const row = await prisma.application.findUniqueOrThrow({ where: { id } });
        const serialized = JSON.stringify(await buildFor(id));
        expect(serialized, `輸出含 voidedById 鍵名：${id}`).not.toContain('"voidedById"');
        expect(serialized, `輸出含 voidedById 值：${id}`).not.toContain(
          row.voidedById ?? "__never__"
        );
      }
    });
  });

  // =========================================================================
  // AC-39(b) — 保養／折舊路徑之 tiebreaker 行為
  // =========================================================================

  describe("AC-39(b): 保養／折舊路徑之同 linkedAt 三附件恆依 id 遞增序輸出", () => {
    it("保養：寫入序與 id 遞增序刻意相反，輸出仍為 id 遞增序", async () => {
      const data = await buildFor(maintenanceVoidedId);
      expect(data.kind).toBe("MAINTENANCE");
      if (data.kind !== "MAINTENANCE") throw new Error("unreachable");
      const ids = data.maintenance.attachments.map((a) => a.attachmentId);
      expect(ids.length).toBe(3);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toEqual([
        `p9t10-mnt-${RUN_ID}-a`,
        `p9t10-mnt-${RUN_ID}-b`,
        `p9t10-mnt-${RUN_ID}-c`,
      ]);
      // 三張確為同一 linkedAt（否則 tiebreaker 未被行使，測試恆真）。
      const rows = await prisma.attachment.findMany({
        where: { id: { in: ids } },
        select: { linkedAt: true },
      });
      expect(new Set(rows.map((r) => r.linkedAt?.toISOString())).size).toBe(1);
    });

    it("折舊：寫入序與 id 遞增序刻意相反，輸出仍為 id 遞增序（同一 fetchApplicationAttachments 路徑之第二消費端）", async () => {
      const data = await buildFor(depreciationVoidedId);
      expect(data.kind).toBe("DEPRECIATION");
      if (data.kind !== "DEPRECIATION") throw new Error("unreachable");
      const ids = data.depreciation.attachments.map((a) => a.attachmentId);
      expect(ids.length).toBe(3);
      expect(ids).toEqual([
        `p9t10-dep-${RUN_ID}-a`,
        `p9t10-dep-${RUN_ID}-b`,
        `p9t10-dep-${RUN_ID}-c`,
      ]);
      const rows = await prisma.attachment.findMany({
        where: { id: { in: ids } },
        select: { linkedAt: true },
      });
      expect(new Set(rows.map((r) => r.linkedAt?.toISOString())).size).toBe(1);
    });
  });
});
