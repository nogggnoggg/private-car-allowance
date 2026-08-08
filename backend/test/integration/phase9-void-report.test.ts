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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/auth/password.js";
import {
  type ReportApplicationRecord,
  type ReportData,
  buildReportData,
  reportApplicationInclude,
} from "../../src/reports/report-data.js";
import { buildServer } from "../../src/server.js";

// ── report-html.ts／pdf-renderer.ts：呼叫穿透之 spy 包裝（§D 用；沿
//    `phase8-report-generate.test.ts` :87-98 之既有慣例，逐字同型：
//    `vi.fn(actual.fn)` 預設呼叫真實實作，個別測試以 mockImplementation 覆
//    寫）。§A～§C（T10）不觸及此二模組，行為零影響。────────────────────────
vi.mock("../../src/reports/report-html.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reports/report-html.js")>();
  return { ...actual, renderReportHtml: vi.fn(actual.renderReportHtml) };
});
vi.mock("../../src/reports/pdf-renderer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reports/pdf-renderer.js")>();
  return { ...actual, renderPdf: vi.fn(actual.renderPdf) };
});

import { voidApplication } from "../../src/applications/application-void.js";
import { renderPdf } from "../../src/reports/pdf-renderer.js";
import { renderReportHtml } from "../../src/reports/report-html.js";
import {
  ReportGenerationError,
  type ReportServiceDeps,
  prepareVoidedReport,
} from "../../src/reports/report-service.js";
import { LocalVolumeStorage, type Storage } from "../../src/storage/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DATA_SRC_PATH = path.resolve(__dirname, "../../src/reports/report-data.ts");
const REPORT_SERVICE_SRC_PATH = path.resolve(__dirname, "../../src/reports/report-service.ts");
const REPORTS_ROUTES_SRC_PATH = path.resolve(__dirname, "../../src/reports/routes.ts");

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

// ===========================================================================
// §D — PHASE-009-T12a：作廢版 PDF 之產生與保存（AC-21 (a)(c)(e)(f)）
//
// ---------------------------------------------------------------------------
// 規範出處（`docs/specs/PHASE-009.md` :209，逐字引用）
// ---------------------------------------------------------------------------
// AC-21：「(a) 作廢**已產生報表**之申請時，於**同一交易**內以同一份快照 ＋ 作
//   廢資訊渲染出**作廢版 PDF**，經 `put` → 讀回校驗（位元組數 ＋ SHA-256）→
//   `INSERT VoidedReportFile` → 提交；任一階段失敗 → **整筆作廢回滾**（狀態仍
//   為 `COMPLETED`）、storage 零殘留、回應 500 `REPORT_GENERATION_FAILED` ＋
//   `details.stage`；…(c) 原 `Report.storageKey` 之位元組 SHA-256 **前後不
//   變**（BE-US-27⑤「保留原始內容」之實證）；…(e) **未產生報表**之申請作廢 →
//   零渲染、零 storage 寫入（作廢為純 DB 操作）；(f) `Report` 列**零更新**——
//   PHASE-008 之「`reports/` 零 `.report.update(`／`.delete(`／`.upsert(`」結
//   構斷言**零改動且全綠**。」
//
// (b)(d)（下載語意）屬 **T12b**，不在本段。
//
// ---------------------------------------------------------------------------
// 「作廢標示可證面」之取證方式（沿 PHASE-008 T8R2 SF-7 之既有結論，見
// `phase8-report-generate.test.ts` :587-606）
// ---------------------------------------------------------------------------
// 該處已實證：Chromium 產出之 PDF 內容串流為**子集字型之 glyph 編碼**，對原始
// 位元組（含 zlib 解壓後）直接做子字串比對**不可命中**，須經 `/ToUnicode` CMap
// 反查（等同引入一套文字擷取邏輯，超出零新增套件之邊界）。故「PDF 位元組逐字含
// 已作廢」在本專案技術上不可行，該檔已裁定改以**餵給 `renderPdf` 的 HTML**
// （即 PDF 之產生輸入）作為同一層次之自證。本段沿用該既有裁定：以
// `renderReportHtml` 之 spy 斷言「作廢版 PDF 的產生輸入」逐字含 `已作廢`、作廢
// 原因與操作者，並另以真實 Chromium 端到端一則證明配線（服務層確實呼叫真實渲
// 染器，非只呼叫替身）。
//
// ---------------------------------------------------------------------------
// TDD 紅燈實錄（先紅後綠；`git stash` 法，完整輸出見 Task Handoff）
// ---------------------------------------------------------------------------
// 本段於五檔實作**全部 stash** 之狀態下先行實跑：`prepareVoidedReport` 等匯出
// 不存在 → 本檔於 collect 階段即紅（tsc 亦紅）。實作還原後全綠。
// 另有三則 mutant 自證（暫改 `src/` 後復原，不烙入本檔）——見 Handoff：
//   ① 讀回校驗略過（不比對位元組數／SHA-256）→ §D-5③ 必紅
//   ② 補償刪除停用（`compensate` 改 no-op）→ §D-5②③④／§D-7 必紅
//   ③ `INSERT` 移出交易（`tx.` → `deps.prisma.`）→ §D-7 必紅
// ===========================================================================

/**
 * 合成 PDF 位元組（沿 `phase8-report-generate.test.ts` :114-118 之同型替身）：
 * `%PDF-` 開頭、`%%EOF` 結尾、長度 > 1024。多數 §D 測試驗證的是**交易／
 * storage／補償**之正確性，與位元組是否出自真實 Chromium 無關；真實 Chromium
 * 之端到端配線另有專則（§D-3）。
 */
const FAKE_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic fixture for PHASE-009-T12a fast tests\n${"Y".repeat(1200)}\n%%EOF`
);

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeTempStorageRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase9-t12a-${label}-`));
}

function removeTempStorageRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** 列出 `<root>/rpt/<token>/<suffix>` 之全部 key（零殘留／零孤兒斷言用）。 */
function listReportStorageKeys(root: string): string[] {
  const rptDir = path.join(root, "rpt");
  if (!fs.existsSync(rptDir)) return [];
  const keys: string[] = [];
  for (const token of fs.readdirSync(rptDir)) {
    const tokenDir = path.join(rptDir, token);
    if (!fs.statSync(tokenDir).isDirectory()) continue;
    for (const suffix of fs.readdirSync(tokenDir)) {
      keys.push(`rpt/${token}/${suffix}`);
    }
  }
  return keys.sort();
}

async function readAllBytes(storage: Storage, key: string): Promise<Buffer> {
  const result = await storage.get(key);
  if (Buffer.isBuffer(result)) return result;
  const chunks: Buffer[] = [];
  for await (const chunk of result as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** `put` 一律拋錯（STORE 階段注入；沿 `phase9-revision-attachment.test.ts` :89 之 FailingStorage 形狀）。 */
class PutFailingStorage implements Storage {
  constructor(private readonly inner: Storage) {}
  async put(key: string): Promise<void> {
    throw new Error(`Injected storage failure while writing key: ${JSON.stringify(key)}`);
  }
  get(key: string): Promise<Buffer | NodeJS.ReadableStream> {
    return this.inner.get(key);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
}

/**
 * `put` 正常落地，但 `get`（讀回校驗）回傳**被竄改**之位元組 —— VERIFY 階段
 * 注入。這是 mutant ①（讀回不比對）之自證點：若實作略過讀回校驗，本注入無法
 * 被偵測，測試必紅。
 */
class TamperingReadBackStorage implements Storage {
  readonly putKeys: string[] = [];
  constructor(
    private readonly inner: Storage,
    /** `"CORRUPT"` = 同長度不同內容（僅 SHA-256 可辨）；`"TRUNCATE"` = 長度不同。 */
    private readonly mode: "CORRUPT" | "TRUNCATE"
  ) {}
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.inner.put(key, bytes, contentType);
    this.putKeys.push(key);
  }
  async get(key: string): Promise<Buffer | NodeJS.ReadableStream> {
    const real = await readAllBytes(this.inner, key);
    if (this.mode === "TRUNCATE") return real.subarray(0, real.length - 1);
    const corrupted = Buffer.from(real);
    // 同長度、單一位元組不同 → 位元組數比對通過，唯 SHA-256 可辨。
    const last = corrupted.length - 1;
    corrupted[last] = (corrupted[last] as number) ^ 0xff;
    return corrupted;
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
}

/** 任何呼叫皆拋錯 —— AC-21(e)「零 storage 觸碰」之結構性證人。 */
class ForbiddenStorage implements Storage {
  async put(): Promise<void> {
    throw new Error("ForbiddenStorage.put must never be called");
  }
  async get(): Promise<Buffer> {
    throw new Error("ForbiddenStorage.get must never be called");
  }
  async delete(): Promise<void> {
    throw new Error("ForbiddenStorage.delete must never be called");
  }
  async exists(): Promise<boolean> {
    throw new Error("ForbiddenStorage.exists must never be called");
  }
}

// ===========================================================================
// §D-0 — 結構性斷言（不需 DB；任何環境皆執行）
// ===========================================================================

describe("PHASE-009-T12a §D-0 — 結構性斷言（AC-21(f) ＋ SPEC-REV-9T12 兩下游約束）", () => {
  it("AC-21(f): report-service.ts／reports/routes.ts 原始碼零 .report.update(／.delete(／.upsert(／.deleteMany(／.updateMany(（PHASE-008 既有斷言於作廢版落地後零改動且全綠）", () => {
    const serviceSrc = fs.readFileSync(REPORT_SERVICE_SRC_PATH, "utf8");
    const routesSrc = fs.readFileSync(REPORTS_ROUTES_SRC_PATH, "utf8");
    for (const src of [serviceSrc, routesSrc]) {
      expect(src).not.toMatch(/\.report\.update\(/);
      expect(src).not.toMatch(/\.report\.delete\(/);
      expect(src).not.toMatch(/\.report\.upsert\(/);
      expect(src).not.toMatch(/\.report\.deleteMany\(/);
      expect(src).not.toMatch(/\.report\.updateMany\(/);
    }
    // 正向對照（否則掃描因「根本沒碰 report delegate」而恆真）。
    expect(serviceSrc).toMatch(/\.report\.create\(/);
    expect(serviceSrc).toMatch(/\.report\.findUnique\(/);
    // 作廢版之唯一寫入落在獨立表（§8.2「為何不擴充 Report」）。
    expect(serviceSrc).toMatch(/\.voidedReportFile\.create\(/);
  });

  it("SPEC-REV-9T12 下游約束 #1：作廢版渲染碼整段位於既有 §9.1 產生流程之後——renderReportHtml( 之首現位置仍落在產生交易內（phase8-report-generate :225-247 之三段序不變）", () => {
    const src = fs.readFileSync(REPORT_SERVICE_SRC_PATH, "utf8");
    const txCallIdx = src.indexOf("$transaction(");
    const renderCallIdx = src.indexOf("renderReportHtml(");
    const readCommittedIdx = src.indexOf("Prisma.TransactionIsolationLevel.ReadCommitted");
    expect(txCallIdx).toBeGreaterThan(-1);
    expect(renderCallIdx).toBeGreaterThan(-1);
    expect(readCommittedIdx).toBeGreaterThan(-1);
    // 既有斷言之逐字複刻——使「把作廢版渲染碼搬到產生流程之前」在本 Task 自己
    // 的測試檔即刻轉紅，而非只在 Files Forbidden 之 phase8 檔轉紅。
    expect(txCallIdx).toBeLessThan(renderCallIdx);
    expect(renderCallIdx).toBeLessThan(readCommittedIdx);
    // 作廢版之進入點必在既有產生交易之後（位置約束之正面表述）。
    expect(src.indexOf("export async function prepareVoidedReport")).toBeGreaterThan(
      readCommittedIdx
    );
  });

  it("SPEC-REV-9T12 下游約束 #2：本 Task 零新增 backend/src/reports/*.ts（PHASE_008_SRC_FILES 九檔清單零觸）", () => {
    const dir = path.resolve(__dirname, "../../src/reports");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files).toEqual(
      [
        "pdf-renderer.ts",
        "report-data.ts",
        "report-filename.ts",
        "report-html.ts",
        "report-images.ts",
        "report-labels.ts",
        "report-number.ts",
        "report-service.ts",
        "routes.ts",
      ].sort()
    );
    expect(files.length).toBe(9);
  });
});

// ===========================================================================
// §D-1〜§D-8 — 行為（需 DB ＋ HTTP ＋ 真實 storage 根目錄）
// ===========================================================================

describeWithDb("PHASE-009-T12a §D — 作廢版 PDF 之產生與保存（AC-21(a)(c)(e)）", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentRoot: string;
  let reportRoot: string;
  let reportStorage: LocalVolumeStorage;
  let attachmentStorage: LocalVolumeStorage;

  let ownerId: string;
  let ownerCookie: string;
  let ownerDisplayName: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  const D_PREFIX = "p9t12a_";
  const D_PASSWORD = "P9t12a-Synthetic-Passw0rd!";

  /** §D 專用之最小 deps（service 層失敗注入用）；兩個 storage 可逐測試替換。 */
  function makeDeps(overrides?: Partial<ReportServiceDeps>): ReportServiceDeps {
    return {
      prisma,
      attachmentStorage,
      reportStorage,
      imageMaxPx: 1600,
      pdfTimeoutMs: 30000,
      log: { error: () => undefined },
      ...overrides,
    };
  }

  async function login(loginName: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password: D_PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`login failed: ${resp.statusCode} ${resp.body}`);
    }
    const raw = resp.headers["set-cookie"];
    const str = Array.isArray(raw) ? raw[0] : (raw as string);
    return str.split(";")[0];
  }

  /** 已完成差旅（完成側以 Prisma 直寫合成，沿本檔 §C 之既有先例）。 */
  async function seedCompletedTravel(purpose: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2216-04-10T00:00:00.000Z"),
        totalAmount: 1234,
        completedAt: new Date("2216-04-11T02:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2216-04-10T00:00:00.000Z"),
            purpose,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            etcParameterVersionId: "p9t12a-etc-v1",
            fuelPriceVersionId: "p9t12a-fuel-price-v1",
            fuelConsumptionVersionId: "p9t12a-fuel-consum-v1",
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "15.2000",
            snapshotTotalKm: "210.50",
            snapshotRawAmount: "1234.4444",
            calculatedAt: new Date("2216-04-11T02:00:00.000Z"),
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "台中",
                  totalKm: "210.50",
                  highwayKm: "150.00",
                  snapshotFuelAmount: "436.1000",
                  snapshotEtcAmount: "185.1750",
                  snapshotRawAmount: "1234.4444",
                  snapshotAmount: 1234,
                },
              ],
            },
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  /** 已完成差旅 ＋ **經真實端點**產生之正式報表（POST /applications/:id/report）。 */
  async function seedWithReport(purpose: string): Promise<string> {
    const id = await seedCompletedTravel(purpose);
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/report`,
      headers: { cookie: ownerCookie },
    });
    if (resp.statusCode !== 201) {
      throw new Error(`report generation failed: ${resp.statusCode} ${resp.body}`);
    }
    return id;
  }

  async function voidViaEndpoint(id: string, reason: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason },
    });
  }

  /** 作廢前之完整狀態快照，供「整筆回滾」之逐項比對。 */
  async function snapshotOf(id: string) {
    const application = await prisma.application.findUniqueOrThrow({ where: { id } });
    const report = await prisma.report.findUnique({ where: { applicationId: id } });
    return {
      application,
      report,
      reportBytesHash: report ? sha256(await readAllBytes(reportStorage, report.storageKey)) : null,
      storageKeys: listReportStorageKeys(reportRoot),
      voidedCount: await prisma.voidedReportFile.count(),
      auditCount: await prisma.auditLog.count({ where: { actorId: ownerId } }),
    };
  }

  /**
   * 「整筆作廢回滾」之統一斷言（AC-21(a) 失敗側）：狀態仍 `COMPLETED`、四個作
   * 廢欄仍 `NULL`、`Application` 與 `Report` 兩列逐欄不變、原 PDF 位元組
   * SHA-256 不變（AC-21(c)）、storage 零殘留、零 `VoidedReportFile`、零稽核列。
   */
  async function expectFullRollback(
    id: string,
    before: Awaited<ReturnType<typeof snapshotOf>>
  ): Promise<void> {
    const after = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.voidReason).toBeNull();
    expect(after.voidedAt).toBeNull();
    expect(after.voidedById).toBeNull();
    // 快照零改寫（AC-04 之延伸）：整列逐欄與作廢前全等。
    expect(after).toEqual(before.application);

    // AC-21(c)：原 Report 列與其位元組 SHA-256 前後不變。
    const report = await prisma.report.findUnique({ where: { applicationId: id } });
    expect(report).toEqual(before.report);
    if (before.report) {
      expect(sha256(await readAllBytes(reportStorage, before.report.storageKey))).toBe(
        before.reportBytesHash
      );
    }

    // storage 零殘留（補償刪除已回收本輪已 put 之 key）。
    expect(listReportStorageKeys(reportRoot)).toEqual(before.storageKeys);
    expect(await prisma.voidedReportFile.count()).toBe(before.voidedCount);
    expect(await prisma.auditLog.count({ where: { actorId: ownerId } })).toBe(before.auditCount);
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    attachmentRoot = makeTempStorageRoot("att");
    reportRoot = makeTempStorageRoot("rpt");
    attachmentStorage = new LocalVolumeStorage(attachmentRoot, { prefixes: ["att"] });
    reportStorage = new LocalVolumeStorage(reportRoot, { prefixes: ["rpt"] });

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await buildServer({ storageRoot: attachmentRoot, reportStorageRoot: reportRoot });
    await app.ready();

    ownerDisplayName = "T12a 擁有人";
    const owner = await prisma.user.create({
      data: {
        loginName: `${D_PREFIX}owner_${RUN_ID}`,
        displayName: ownerDisplayName,
        passwordHash: await hashPassword(D_PASSWORD),
        role: "USER",
        isActive: true,
        // T3 假綠教訓：fixture 一律顯式指定，不倚賴 schema 預設。
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);
    ownerCookie = await login(owner.loginName);
  }, 60000);

  afterAll(async () => {
    if (!prisma) return;
    if (app) await app.close();
    if (createdApplicationIds.length > 0) {
      const reports = await prisma.report.findMany({
        where: { applicationId: { in: createdApplicationIds } },
        select: { id: true },
      });
      if (reports.length > 0) {
        await prisma.voidedReportFile.deleteMany({
          where: { reportId: { in: reports.map((r) => r.id) } },
        });
        await prisma.report.deleteMany({
          where: { applicationId: { in: createdApplicationIds } },
        });
      }
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    removeTempStorageRoot(attachmentRoot);
    removeTempStorageRoot(reportRoot);
  }, 60000);

  // =========================================================================
  // §D-1〜§D-2、§D-4〜§D-8：快速替身區塊（renderPdf → 合成位元組）
  // =========================================================================

  describe("§快速替身（renderPdf 覆寫為合成位元組；renderReportHtml 仍為真實實作）", () => {
    beforeEach(() => {
      vi.mocked(renderReportHtml).mockClear();
      vi.mocked(renderPdf).mockClear();
      vi.mocked(renderPdf).mockImplementation(async () => Buffer.from(FAKE_PDF_BYTES));
    });

    // -----------------------------------------------------------------------
    // §D-1 AC-21(a) 正向
    // -----------------------------------------------------------------------

    it("AC-21(a) 正向: 作廢已產生報表之申請 → 200 ＋ 恰一列 VoidedReportFile（逐欄齊）＋ 讀回位元組之長度與 SHA-256 與該列相符", async () => {
      const id = await seedWithReport("D1 正向");
      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const reason = "T12a 正向：金額誤植，重新申報";

      const resp = await voidViaEndpoint(id, reason);
      expect(resp.statusCode, resp.body).toBe(200);

      const rows = await prisma.voidedReportFile.findMany({ where: { reportId: report.id } });
      expect(rows.length).toBe(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");

      // §8.2 逐欄。
      expect(row.reportId).toBe(report.id);
      expect(row.fileName).toBe(report.fileName); // 編號不變 → 檔名不變
      expect(row.createdById).toBe(ownerId);
      expect(row.storageKey).toMatch(/^rpt\/[A-Za-z0-9_-]+\/void$/);
      expect(row.storageKey).not.toBe(report.storageKey);

      // 讀回校驗之實證：DB 記錄之 byteSize／contentHash 與 storage 實際位元組相符。
      const bytes = await readAllBytes(reportStorage, row.storageKey);
      expect(row.byteSize).toBe(bytes.length);
      expect(row.contentHash).toBe(sha256(bytes));

      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(application.status).toBe("VOIDED");
      expect(application.voidReason).toBe(reason);
    });

    it("AC-21(a) 作廢標示可證面: 餵給 renderPdf 之 HTML（作廢版 PDF 之產生輸入）逐字含「已作廢」＋作廢原因，且 ReportData 之 common 帶正確作廢資訊與原編號", async () => {
      const id = await seedWithReport("D1 標示");
      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const reason = "T12a 標示：出差取消";

      vi.mocked(renderReportHtml).mockClear();
      const resp = await voidViaEndpoint(id, reason);
      expect(resp.statusCode, resp.body).toBe(200);

      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      const call = vi.mocked(renderReportHtml).mock.calls.at(-1);
      const result = vi.mocked(renderReportHtml).mock.results.at(-1);
      expect(call, "作廢版渲染未呼叫 renderReportHtml").toBeDefined();
      if (!call || !result) throw new Error("unreachable");

      const data = call[0];
      // 作廢資訊（§3.1 不變式③：狀態寫入早於渲染 → 渲染輸入恆帶正確作廢資訊）。
      expect(data.common.void).toEqual({
        reason,
        at: application.voidedAt?.toISOString(),
        byDisplayName: ownerDisplayName,
      });
      expect(data.common.statusLabel).toBe("已作廢");
      // 同一份快照 ＋ 原編號／原產生時間（AC-21(a)「同一份快照」；編號不變）。
      expect(data.common.reportNumber).toBe(report.reportNumber);
      expect(data.common.generatedAt).toBe(report.generatedAt.toISOString());
      expect(data.common.totalAmount).toBe(application.totalAmount);

      // 產生輸入之 HTML 逐字含作廢標示、原因與操作者（T11 之 .void-banner）。
      expect(result.type).toBe("return");
      const html = String(result.value);
      expect(html).toContain("已作廢");
      expect(html).toContain(reason);
      expect(html).toContain("void-banner");
      expect(html).toContain(ownerDisplayName);
      expect(html).toContain(report.reportNumber);
    });

    // -----------------------------------------------------------------------
    // §D-2 AC-21(c)
    // -----------------------------------------------------------------------

    it("AC-21(c): 原 Report 列逐欄不變、其 storageKey 之位元組 SHA-256 前後不變（作廢成功路徑）", async () => {
      const id = await seedWithReport("D2 原檔保留");
      const before = await snapshotOf(id);
      if (!before.report) throw new Error("fixture: report 必須存在");

      const resp = await voidViaEndpoint(id, "T12a 原檔保留驗證");
      expect(resp.statusCode, resp.body).toBe(200);

      const after = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      expect(after).toEqual(before.report);
      expect(sha256(await readAllBytes(reportStorage, before.report.storageKey))).toBe(
        before.reportBytesHash
      );
      expect(await reportStorage.exists(before.report.storageKey)).toBe(true);

      // 作廢版落在**另一個** key（原檔永不被覆寫）。
      const voided = await prisma.voidedReportFile.findUniqueOrThrow({
        where: { reportId: before.report.id },
      });
      expect(voided.storageKey).not.toBe(before.report.storageKey);
    });

    // -----------------------------------------------------------------------
    // §D-4 AC-21(e)
    // -----------------------------------------------------------------------

    it("AC-21(e): 未產生報表之申請作廢 → 200、零渲染（renderReportHtml／renderPdf 零呼叫）、零 storage 寫入、零 VoidedReportFile", async () => {
      const id = await seedCompletedTravel("D4 無報表");
      const keysBefore = listReportStorageKeys(reportRoot);
      const voidedBefore = await prisma.voidedReportFile.count();
      vi.mocked(renderReportHtml).mockClear();
      vi.mocked(renderPdf).mockClear();

      const resp = await voidViaEndpoint(id, "T12a 無報表作廢");
      expect(resp.statusCode, resp.body).toBe(200);

      expect(vi.mocked(renderReportHtml)).not.toHaveBeenCalled();
      expect(vi.mocked(renderPdf)).not.toHaveBeenCalled();
      expect(listReportStorageKeys(reportRoot)).toEqual(keysBefore);
      expect(await prisma.voidedReportFile.count()).toBe(voidedBefore);

      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(application.status).toBe("VOIDED");
    });

    it("AC-21(e) 結構性證人: 未產生報表時 prepareVoidedReport 回 null，且**兩個 storage 皆為呼叫即拋錯之替身**仍不拋錯（零 storage 觸碰非靠條件式運氣）", async () => {
      const id = await seedCompletedTravel("D4 證人");
      const deps = makeDeps({
        reportStorage: new ForbiddenStorage(),
        attachmentStorage: new ForbiddenStorage(),
      });
      vi.mocked(renderReportHtml).mockClear();
      vi.mocked(renderPdf).mockClear();
      await expect(prepareVoidedReport(deps, id, ownerId)).resolves.toBeNull();
      expect(vi.mocked(renderReportHtml)).not.toHaveBeenCalled();
      expect(vi.mocked(renderPdf)).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // §D-5 四階段失敗注入（service 層；每一則皆整筆回滾，故同一 fixture 可重用
    // ——「可重用」本身即回滾正確性之附帶自證）
    // -----------------------------------------------------------------------

    describe("AC-21(a) 失敗側：四階段失敗注入各自整筆回滾、零殘留、stage 逐字", () => {
      let injectId: string;

      beforeAll(async () => {
        if (!DB_URL) return;
        injectId = await seedWithReport("D5 失敗注入共用 fixture");
      }, 60000);

      it("① RENDER（renderReportHtml 拋錯）→ ReportGenerationError(stage=RENDER) ＋ 整筆回滾 ＋ 零殘留", async () => {
        const before = await snapshotOf(injectId);
        vi.mocked(renderReportHtml).mockImplementationOnce(() => {
          throw new Error("injected html render failure");
        });

        const plan = await prepareVoidedReport(makeDeps(), injectId, ownerId);
        expect(plan).not.toBeNull();
        if (!plan) throw new Error("unreachable");

        await expect(
          voidApplication(prisma, injectId, "RENDER 注入", ownerId, undefined, plan.onVoided)
        ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "RENDER" });

        await plan.compensate();
        await expectFullRollback(injectId, before);
      });

      it("① RENDER（renderPdf 拋錯／逾時）→ stage=RENDER ＋ 整筆回滾 ＋ 零殘留", async () => {
        const before = await snapshotOf(injectId);
        vi.mocked(renderPdf).mockImplementationOnce(async () => {
          throw new Error("injected pdf render timeout");
        });

        const plan = await prepareVoidedReport(makeDeps(), injectId, ownerId);
        if (!plan) throw new Error("unreachable");

        await expect(
          voidApplication(prisma, injectId, "RENDER 注入 2", ownerId, undefined, plan.onVoided)
        ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "RENDER" });

        await plan.compensate();
        await expectFullRollback(injectId, before);
      });

      it("② STORE（put 拋錯）→ stage=STORE ＋ 整筆回滾 ＋ 零殘留", async () => {
        const before = await snapshotOf(injectId);
        const plan = await prepareVoidedReport(
          makeDeps({ reportStorage: new PutFailingStorage(reportStorage) }),
          injectId,
          ownerId
        );
        if (!plan) throw new Error("unreachable");

        await expect(
          voidApplication(prisma, injectId, "STORE 注入", ownerId, undefined, plan.onVoided)
        ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "STORE" });

        await plan.compensate();
        await expectFullRollback(injectId, before);
      });

      it("③ VERIFY（讀回位元組被竄改：同長度、單一位元組不同）→ stage=VERIFY ＋ 已 put 之 key 補償刪除 ＋ 整筆回滾（校驗略過與補償停用兩個 mutant 之共同自證點）", async () => {
        const before = await snapshotOf(injectId);
        const tampering = new TamperingReadBackStorage(reportStorage, "CORRUPT");
        const plan = await prepareVoidedReport(
          makeDeps({ reportStorage: tampering }),
          injectId,
          ownerId
        );
        if (!plan) throw new Error("unreachable");

        await expect(
          voidApplication(prisma, injectId, "VERIFY 注入", ownerId, undefined, plan.onVoided)
        ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "VERIFY" });

        // 本輪確實走到過 storage 寫入（否則「補償」之斷言恆真）。
        expect(tampering.putKeys.length).toBe(1);
        for (const key of tampering.putKeys) {
          expect(await reportStorage.exists(key), "補償刪除遺漏 key（殘留檔）").toBe(false);
        }
        await plan.compensate();
        await expectFullRollback(injectId, before);
      });

      it("③ VERIFY（讀回位元組長度不符）→ stage=VERIFY ＋ 零殘留（位元組數比對之獨立自證）", async () => {
        const before = await snapshotOf(injectId);
        const tampering = new TamperingReadBackStorage(reportStorage, "TRUNCATE");
        const plan = await prepareVoidedReport(
          makeDeps({ reportStorage: tampering }),
          injectId,
          ownerId
        );
        if (!plan) throw new Error("unreachable");

        await expect(
          voidApplication(prisma, injectId, "VERIFY 注入 2", ownerId, undefined, plan.onVoided)
        ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "VERIFY" });

        expect(tampering.putKeys.length).toBe(1);
        await plan.compensate();
        await expectFullRollback(injectId, before);
      });

      it("④ PERSIST（reportId 唯一約束衝突）→ stage=PERSIST ＋ 整筆回滾 ＋ 零殘留", async () => {
        const report = await prisma.report.findUniqueOrThrow({
          where: { applicationId: injectId },
        });
        // 冪等鍵（`reportId` @unique，§8.2）之先占列——使 INSERT 必然 P2002。
        const blocker = await prisma.voidedReportFile.create({
          data: {
            reportId: report.id,
            storageKey: `rpt/${crypto.randomUUID()}/void`,
            fileName: report.fileName,
            byteSize: 1,
            contentHash: sha256(Buffer.from("blocker")),
            createdById: ownerId,
          },
        });
        try {
          const before = await snapshotOf(injectId);
          const plan = await prepareVoidedReport(makeDeps(), injectId, ownerId);
          if (!plan) throw new Error("unreachable");

          await expect(
            voidApplication(prisma, injectId, "PERSIST 注入", ownerId, undefined, plan.onVoided)
          ).rejects.toMatchObject({ name: "ReportGenerationError", stage: "PERSIST" });

          await plan.compensate();
          await expectFullRollback(injectId, before);
          // 先占列本身零觸碰（本流程對既有列零更新、零刪除）。
          expect(await prisma.voidedReportFile.findUnique({ where: { id: blocker.id } })).toEqual(
            blocker
          );
        } finally {
          await prisma.voidedReportFile.delete({ where: { id: blocker.id } });
        }
      });
    });

    // -----------------------------------------------------------------------
    // §D-6 wire 層：500 REPORT_GENERATION_FAILED ＋ details.stage 逐字
    // -----------------------------------------------------------------------

    it("AC-21(a) wire 層: 作廢版 PDF 產生失敗 → 500 REPORT_GENERATION_FAILED ＋ details.stage 逐字 ＋ 整筆回滾（狀態仍 COMPLETED、零稽核列、storage 零殘留）", async () => {
      const id = await seedWithReport("D6 wire 500");
      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const blocker = await prisma.voidedReportFile.create({
        data: {
          reportId: report.id,
          storageKey: `rpt/${crypto.randomUUID()}/void`,
          fileName: report.fileName,
          byteSize: 1,
          contentHash: sha256(Buffer.from("blocker-wire")),
          createdById: ownerId,
        },
      });
      try {
        const before = await snapshotOf(id);

        const resp = await voidViaEndpoint(id, "T12a wire 層失敗注入");
        expect(resp.statusCode, resp.body).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("REPORT_GENERATION_FAILED");
        expect(body.error.details).toEqual({ stage: "PERSIST" });
        expect(typeof body.error.requestId).toBe("string");
        // 回應零 storage key 外洩（§7.5／AC-25 之同型紀律）。
        expect(resp.body).not.toContain("rpt/");
        expect(resp.body).not.toContain(report.storageKey);

        await expectFullRollback(id, before);
      } finally {
        await prisma.voidedReportFile.delete({ where: { id: blocker.id } });
      }
    });

    // -----------------------------------------------------------------------
    // §D-7 外層補償 ＋ mutant ③（INSERT 移出交易）之自證點
    // -----------------------------------------------------------------------

    it("PDF 步驟成功、其後稽核寫入於 DB 層失敗（**經真實端點** ＋ 觸發器注入）→ 500 ＋ 整筆回滾：零 VoidedReportFile（INSERT 移出交易之 mutant 必紅）＋ **端點之外層補償**使 storage 零殘留（刪除 routes.ts 之 plan.compensate() 之 mutant 必紅）", async () => {
      const id = await seedWithReport("D7 端點外層補償");
      const before = await snapshotOf(id);
      const application = await prisma.application.findUniqueOrThrow({
        where: { id },
        select: { owner: { select: { loginName: true } } },
      });
      // 端點寫入之 `targetLabel` 形狀為 `{loginName}#{applicationId}`（AC-24）。
      const targetLabel = `${application.owner.loginName}#${id}`;
      const fnName = `p9t12a_fail_audit_${RUN_ID}`;
      const trgName = `p9t12a_fail_audit_trg_${RUN_ID}`;

      // ── 為何用 DB 觸發器而非 spy ──────────────────────────────────────────
      // 本則的驗證目標是**端點的外層補償接線**（`applications/routes.ts` 之
      // `catch { if (plan) await plan.compensate(); throw err; }`），故必須**走
      // 真實端點**——先前版本改為在測試內自行呼叫 `plan.compensate()`，驗到的只
      // 是機制本身，刪掉端點那一行仍會全綠（T12a 即審 MF-1）。
      // 端點的稽核寫入走的是 `tx.auditLog.create`（交易客戶端），且 server 內部
      // 持有的是**自己的** `PrismaClient` 實例（`buildServer` 內建立），非本檔的
      // `prisma`——故 `vi.spyOn(prisma.auditLog, "create")` 攔不到。BEFORE INSERT
      // 觸發器作用於資料庫本身，與哪一個 client／是否在交易內無關，是此處唯一
      // 可靠且與 per-worker prisma 相容的注入點。作用域以 `targetLabel` 精確限縮
      // 於本則之申請，`finally` 一律拆除。
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION ${fnName}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected audit failure (p9t12a)'; END; $$ LANGUAGE plpgsql;`
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER ${trgName} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."targetLabel" = '${targetLabel}') EXECUTE FUNCTION ${fnName}();`
      );

      try {
        const resp = await voidViaEndpoint(id, "T12a 稽核寫入失敗（觸發器注入）");

        // 稽核失敗不是 PDF 產生失敗，故**不是** REPORT_GENERATION_FAILED——
        // 走一般未預期錯誤路徑之 500（錯誤碼與 stage 之分辨力於 §D-6 另證）。
        expect(resp.statusCode, resp.body).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.error.code).toBe("INTERNAL_ERROR");
        expect(resp.body).not.toContain("rpt/");

        // 此路徑之 storage 回收**只能**來自端點的外層補償：7d 之 put 與 INSERT
        // 皆已成功，內層補償（PDF 步驟自身之 catch）根本不會被觸發。
        await expectFullRollback(id, before);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trgName} ON "AuditLog";`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fnName}();`);
      }
    });

    // -----------------------------------------------------------------------
    // §D-7b 交易 timeout 裕度（沿 `phase8-report-generate.test.ts` 之
    // 「MF-2 探針①：交易內渲染 6000ms」同型先例——T12a 即審 SF-2）
    // -----------------------------------------------------------------------

    it("交易 timeout 裕度: 交易內渲染耗時 6000ms（逼近並超過 Prisma 套件預設之 5000ms 交易 timeout）→ 仍 200 ＋ 恰一列 VoidedReportFile（移除 application-void.ts 之顯式 timeout／maxWait 之 mutant 必紅）", async () => {
      const id = await seedWithReport("D7b 交易裕度");
      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

      // 僅本次作廢之渲染耗時 6000ms（fixture 之報表產生不受影響）。
      vi.mocked(renderPdf).mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return Buffer.from(FAKE_PDF_BYTES);
      });

      const startedAt = Date.now();
      const resp = await voidViaEndpoint(id, "T12a 交易裕度探針");
      const elapsedMs = Date.now() - startedAt;

      // 確實走過 6s 之渲染（否則本則對 timeout 零鑑別力，恆真）。
      expect(elapsedMs).toBeGreaterThan(6000);
      expect(resp.statusCode, resp.body).toBe(200);

      const rows = await prisma.voidedReportFile.findMany({ where: { reportId: report.id } });
      expect(rows.length).toBe(1);
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(application.status).toBe("VOIDED");
    }, 60000);

    // -----------------------------------------------------------------------
    // §D-8 B-08：含報表之申請雙作廢（併發）
    // -----------------------------------------------------------------------

    it("B-08 併發回歸: 同一筆已產生報表之申請雙作廢 → 恰一成功（200）一衝突（409），恰一列 VoidedReportFile，storage 恰增一個 key", async () => {
      const id = await seedWithReport("D8 併發");
      const keysBefore = listReportStorageKeys(reportRoot);

      const [a, b] = await Promise.all([
        voidViaEndpoint(id, "併發作廢-A"),
        voidViaEndpoint(id, "併發作廢-B"),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, `${a.statusCode}:${a.body} / ${b.statusCode}:${b.body}`).toEqual([200, 409]);

      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const rows = await prisma.voidedReportFile.findMany({ where: { reportId: report.id } });
      expect(rows.length).toBe(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");

      // 敗方零殘留：storage 恰多出一個 key（勝方之作廢版），不多不少。
      const keysAfter = listReportStorageKeys(reportRoot);
      expect(keysAfter.length).toBe(keysBefore.length + 1);
      expect(keysAfter).toContain(row.storageKey);

      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(application.status).toBe("VOIDED");
    }, 60000);
  });

  // =========================================================================
  // §D-3 真實 Chromium 端到端（唯一未覆寫 renderPdf 之區塊——配線證明：服務層
  // 確實呼叫真實渲染器，而非只呼叫測試替身）
  // =========================================================================

  describe("§真實 Chromium 端到端（renderPdf 未覆寫）", () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("../../src/reports/pdf-renderer.js")>(
        "../../src/reports/pdf-renderer.js"
      );
      vi.mocked(renderPdf).mockImplementation(actual.renderPdf);
      const actualHtml = await vi.importActual<typeof import("../../src/reports/report-html.js")>(
        "../../src/reports/report-html.js"
      );
      vi.mocked(renderReportHtml).mockImplementation(actualHtml.renderReportHtml);
    });

    it("AC-21(a) 端到端: 真實 Chromium 產出之作廢版 PDF 通過 %PDF-／%%EOF／長度校驗，讀回 SHA-256 與 VoidedReportFile 相符，且與原 PDF 位元組互異（T11 FW③ 之預期差異）", async () => {
      const id = await seedWithReport("D3 真實 Chromium");
      const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
      const originalHash = sha256(await readAllBytes(reportStorage, report.storageKey));

      const resp = await voidViaEndpoint(id, "T12a 端到端：真實渲染");
      expect(resp.statusCode, resp.body).toBe(200);

      const row = await prisma.voidedReportFile.findUniqueOrThrow({
        where: { reportId: report.id },
      });
      const bytes = await readAllBytes(reportStorage, row.storageKey);
      // 本區塊之「替身已還原」自證：位元組必**不**等於 §快速替身之合成常數。
      // 少了這一條，若 `renderPdf` 之真實實作未被還原，本則會假綠——合成常數
      // 同樣以 `%PDF-` 開頭、以 `%%EOF` 結尾、長度 > 1024，下方三項校驗無從
      // 分辨。
      expect(bytes.equals(FAKE_PDF_BYTES), "renderPdf 真實實作未還原（仍為合成替身）").toBe(false);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.subarray(-8).toString("latin1")).toContain("%%EOF");
      expect(bytes.length).toBeGreaterThan(1024);
      expect(row.byteSize).toBe(bytes.length);
      expect(row.contentHash).toBe(sha256(bytes));

      // AC-21(c)：原檔位元組零觸碰。
      expect(sha256(await readAllBytes(reportStorage, report.storageKey))).toBe(originalHash);
      // 作廢版與原版必然互異（作廢版多 .void-banner 與其樣式規則）。
      expect(row.contentHash).not.toBe(originalHash);
    }, 180000);
  });
});

// ===========================================================================
// §E — PHASE-009-T12b：作廢後之下載語意（AC-21 (b)(d)）
//
// ---------------------------------------------------------------------------
// 規範出處（`docs/specs/PHASE-009.md` :209，逐字引用）
// ---------------------------------------------------------------------------
// AC-21：「…(b) 作廢後下載 → 回**作廢版**位元組，`Content-Disposition` 之報表
//   編號**不變**；…(d) 作廢後重複下載**位元組全等**且**渲染器零呼叫**
//   （PHASE-008 AC-08 之紀律於作廢後仍成立）。」
//
// (a)(c)(e)(f)（產生／保存面）屬 **T12a**，見 §D。AC-23 之「下載 → 200（依
// D4）」一格（授權矩陣面）由 T12b 補於 `phase9-contract.test.ts` §D。
//
// ---------------------------------------------------------------------------
// 「無 `VoidedReportFile` → 回原檔」之 fallback（T12a 即審 AR-1／FW-3；大總管
// 2026-08-07 裁量）
// ---------------------------------------------------------------------------
// D4(b1) 之交易語意保證「`VOIDED` 且有 `Report` ⇒ 有 `VoidedReportFile`」，故
// 本 fallback 於正確實作下**結構性不可達**。仍實作並實測之理由：回原檔是「保
// 留原始內容」（BE-US-27⑤）之安全預設——理論競態窗或未來歷史資料若落入該狀
// 態，回原檔遠優於 404／500。本段以**直造資料**（`prisma.application.update`
// 直寫 `VOIDED`，繞過作廢服務）使該路徑可達並釘樁。
//
// ---------------------------------------------------------------------------
// 替身之可辨識性（本段之關鍵前提）
// ---------------------------------------------------------------------------
// §D 之 `renderPdf` 替身對任何輸入皆回**同一份** `FAKE_PDF_BYTES`——若沿用，
// 「回作廢版」與「回原檔」之位元組完全相同，(b) 之斷言將**恆真而無鑑別力**。
// 故本段之替身依「產生輸入 HTML 是否含 `已作廢`」（AC-20(a) 之逐字標示）回傳
// **兩份互異**之合成位元組（長度亦不同），使「端點誤回原檔」必紅。
//
// ---------------------------------------------------------------------------
// TDD 紅燈實錄（先紅後綠；`git stash` 法，完整輸出見 Task Handoff）
// ---------------------------------------------------------------------------
// 本段於 `src/reports/routes.ts` 之作廢分支 stash 之狀態下先行實跑：下載端點
// 一律回原檔 → §E-1 兩則與 §E-2 紅（位元組為原版）；§E-3／§E-4 綠（fallback
// 與未作廢兩者本即回原檔，屬「零行為變更」之對照面）。實作還原後全綠。
// ===========================================================================

/** 未作廢版之合成 PDF 位元組（`renderPdf` 替身之「產生輸入不含『已作廢』」分支）。 */
const E_ORIGINAL_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic ORIGINAL fixture for PHASE-009-T12b\n${"O".repeat(1100)}\n%%EOF`
);
/** 作廢版之合成 PDF 位元組——與上者**長度與內容皆不同**（見上方「替身之可辨識性」）。 */
const E_VOIDED_PDF_BYTES = Buffer.from(
  `%PDF-1.4\n% synthetic VOIDED fixture for PHASE-009-T12b\n${"V".repeat(1500)}\n%%EOF`
);

describeWithDb("PHASE-009-T12b §E — 作廢後之下載語意（AC-21(b)(d)）", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let attachmentRoot: string;
  let reportRoot: string;
  let reportStorage: LocalVolumeStorage;

  let ownerId: string;
  let ownerCookie: string;

  const createdApplicationIds: string[] = [];
  const createdUserIds: string[] = [];

  const E_PREFIX = "p9t12b_";
  const E_PASSWORD = "P9t12b-Synthetic-Passw0rd!";

  async function login(loginName: string): Promise<string> {
    const resp = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { loginName, password: E_PASSWORD },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`login failed: ${resp.statusCode} ${resp.body}`);
    }
    const raw = resp.headers["set-cookie"];
    const str = Array.isArray(raw) ? raw[0] : (raw as string);
    return str.split(";")[0];
  }

  /** 已完成差旅（完成側以 Prisma 直寫合成，沿 §C／§D 之既有先例）。 */
  async function seedCompletedTravel(purpose: string): Promise<string> {
    const created = await prisma.application.create({
      data: {
        type: "TRAVEL",
        status: "COMPLETED",
        ownerId,
        createdById: ownerId,
        primaryDate: new Date("2217-06-12T00:00:00.000Z"),
        totalAmount: 987,
        completedAt: new Date("2217-06-13T02:00:00.000Z"),
        travel: {
          create: {
            tripDate: new Date("2217-06-12T00:00:00.000Z"),
            purpose,
            fuelUnitPrice: "2.3456",
            etcUnitPrice: "1.2345",
            etcParameterVersionId: "p9t12b-etc-v1",
            fuelPriceVersionId: "p9t12b-fuel-price-v1",
            fuelConsumptionVersionId: "p9t12b-fuel-consum-v1",
            snapshotFuelType: "GASOLINE_95",
            snapshotFuelPricePerLiter: "31.5000",
            snapshotFuelConsumption: "15.2000",
            snapshotTotalKm: "180.00",
            snapshotRawAmount: "987.1234",
            calculatedAt: new Date("2217-06-13T02:00:00.000Z"),
            segments: {
              create: [
                {
                  sortOrder: 0,
                  origin: "台北",
                  destination: "新竹",
                  totalKm: "180.00",
                  highwayKm: "120.00",
                  snapshotFuelAmount: "373.0000",
                  snapshotEtcAmount: "148.1400",
                  snapshotRawAmount: "987.1234",
                  snapshotAmount: 987,
                },
              ],
            },
          },
        },
      },
    });
    createdApplicationIds.push(created.id);
    return created.id;
  }

  /** 已完成差旅 ＋ **經真實端點**產生之正式報表。 */
  async function seedWithReport(purpose: string): Promise<string> {
    const id = await seedCompletedTravel(purpose);
    const resp = await app.inject({
      method: "POST",
      url: `/applications/${id}/report`,
      headers: { cookie: ownerCookie },
    });
    if (resp.statusCode !== 201) {
      throw new Error(`report generation failed: ${resp.statusCode} ${resp.body}`);
    }
    return id;
  }

  function voidViaEndpoint(id: string, reason: string) {
    return app.inject({
      method: "POST",
      url: `/applications/${id}/void`,
      headers: { cookie: ownerCookie },
      payload: { reason },
    });
  }

  function downloadPdf(id: string) {
    return app.inject({
      method: "GET",
      url: `/applications/${id}/report/pdf`,
      headers: { cookie: ownerCookie },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    attachmentRoot = makeTempStorageRoot("att-e");
    reportRoot = makeTempStorageRoot("rpt-e");
    reportStorage = new LocalVolumeStorage(reportRoot, { prefixes: ["rpt"] });

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    app = await buildServer({ storageRoot: attachmentRoot, reportStorageRoot: reportRoot });
    await app.ready();

    const owner = await prisma.user.create({
      data: {
        loginName: `${E_PREFIX}owner_${RUN_ID}`,
        displayName: "T12b 擁有人",
        passwordHash: await hashPassword(E_PASSWORD),
        role: "USER",
        isActive: true,
        // T3 假綠教訓：fixture 一律顯式指定，不倚賴 schema 預設。
        mustChangePassword: false,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);
    ownerCookie = await login(owner.loginName);
  }, 60000);

  afterAll(async () => {
    if (!prisma) return;
    if (app) await app.close();
    if (createdApplicationIds.length > 0) {
      const reports = await prisma.report.findMany({
        where: { applicationId: { in: createdApplicationIds } },
        select: { id: true },
      });
      if (reports.length > 0) {
        await prisma.voidedReportFile.deleteMany({
          where: { reportId: { in: reports.map((r) => r.id) } },
        });
        await prisma.report.deleteMany({
          where: { applicationId: { in: createdApplicationIds } },
        });
      }
      await prisma.application.deleteMany({ where: { id: { in: createdApplicationIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
    removeTempStorageRoot(attachmentRoot);
    removeTempStorageRoot(reportRoot);
  }, 60000);

  beforeEach(() => {
    vi.mocked(renderReportHtml).mockClear();
    vi.mocked(renderPdf).mockClear();
    vi.mocked(renderPdf).mockImplementation(async (html: string) =>
      Buffer.from(html.includes("已作廢") ? E_VOIDED_PDF_BYTES : E_ORIGINAL_PDF_BYTES)
    );
  });

  // -------------------------------------------------------------------------
  // §E-1 AC-21(b)
  // -------------------------------------------------------------------------

  it("AC-21(b): 作廢後下載 → 200 ＋ 回作廢版位元組（SHA-256 ＝ VoidedReportFile.contentHash，且**不等於**原檔）", async () => {
    const id = await seedWithReport("E1 作廢後下載");
    const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
    const originalBytes = await readAllBytes(reportStorage, report.storageKey);

    // 作廢前之對照：下載回原檔（本則自身之「非恆真」證人）。
    const beforeResp = await downloadPdf(id);
    expect(beforeResp.statusCode, beforeResp.body).toBe(200);
    expect(beforeResp.rawPayload.equals(originalBytes)).toBe(true);

    const voidResp = await voidViaEndpoint(id, "E1：金額誤植，重新申報");
    expect(voidResp.statusCode, voidResp.body).toBe(200);
    const voidedRow = await prisma.voidedReportFile.findUniqueOrThrow({
      where: { reportId: report.id },
    });

    const resp = await downloadPdf(id);
    expect(resp.statusCode, resp.body).toBe(200);
    expect(sha256(resp.rawPayload)).toBe(voidedRow.contentHash);
    expect(resp.rawPayload.length).toBe(voidedRow.byteSize);
    expect(resp.rawPayload.equals(await readAllBytes(reportStorage, voidedRow.storageKey))).toBe(
      true
    );
    // 鑑別力：作廢版與原檔互異（若端點誤回原檔，本行必紅）。
    expect(resp.rawPayload.equals(originalBytes)).toBe(false);
    expect(resp.headers["content-type"]).toBe("application/pdf");
    expect(resp.headers["cache-control"]).toBe("no-store");
    expect(resp.headers["x-content-type-options"]).toBe("nosniff");

    // AC-21(c) 之下載面對照：原檔位元組零觸碰。
    expect(sha256(await readAllBytes(reportStorage, report.storageKey))).toBe(
      sha256(originalBytes)
    );
  }, 60000);

  it("AC-21(b): Content-Disposition 之報表編號與檔名作廢前後逐字不變（storageKey 之 void 後綴不得外洩為檔名）", async () => {
    const id = await seedWithReport("E1 編號不變");
    const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

    const before = await downloadPdf(id);
    const dispositionBefore = before.headers["content-disposition"] as string;

    const voidResp = await voidViaEndpoint(id, "E1：編號不變之驗證");
    expect(voidResp.statusCode, voidResp.body).toBe(200);
    const after = await downloadPdf(id);
    const dispositionAfter = after.headers["content-disposition"] as string;

    expect(dispositionAfter).toBe(dispositionBefore);
    expect(dispositionAfter).toContain(`filename="${report.reportNumber}.pdf"`);
    expect(dispositionAfter).toContain("filename*=UTF-8''");

    // T12a 即審 FW-1：`VoidedReportFile.storageKey` 之後綴為 `void`（**非**
    // `void.pdf`）——檔名沿 `VoidedReportFile.fileName`（＝原 `Report.fileName`）
    // 而非 storageKey，故標頭零 `rpt/` 片段、零 storageKey 外洩。
    const voidedRow = await prisma.voidedReportFile.findUniqueOrThrow({
      where: { reportId: report.id },
    });
    expect(voidedRow.storageKey.endsWith("/void")).toBe(true);
    expect(voidedRow.fileName).toBe(report.fileName);
    expect(dispositionAfter).not.toContain("rpt/");
    expect(dispositionAfter).not.toContain(voidedRow.storageKey);
  }, 60000);

  // -------------------------------------------------------------------------
  // §E-2 AC-21(d)
  // -------------------------------------------------------------------------

  it("AC-21(d): 作廢後重複下載位元組全等，且下載期間 renderPdf／renderReportHtml 零呼叫（PHASE-008 AC-08 紀律於作廢後仍成立）", async () => {
    const id = await seedWithReport("E2 重複下載");
    const voidResp = await voidViaEndpoint(id, "E2：重複下載一致性");
    expect(voidResp.statusCode, voidResp.body).toBe(200);
    const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });

    const renderPdfCallsBefore = vi.mocked(renderPdf).mock.calls.length;
    const renderHtmlCallsBefore = vi.mocked(renderReportHtml).mock.calls.length;
    const storageKeysBefore = listReportStorageKeys(reportRoot);

    const first = await downloadPdf(id);
    const second = await downloadPdf(id);
    const third = await downloadPdf(id);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);

    // 逐位元全等（Buffer.compare，沿 PHASE-008 AC-08 之既有手法）。
    expect(Buffer.compare(first.rawPayload, second.rawPayload)).toBe(0);
    expect(Buffer.compare(first.rawPayload, third.rawPayload)).toBe(0);
    expect(second.headers["content-disposition"]).toBe(first.headers["content-disposition"]);
    // 回的確實是作廢版（否則本則於「恆回原檔」之實作下亦會全綠）。
    const voidedRow = await prisma.voidedReportFile.findUniqueOrThrow({
      where: { reportId: report.id },
    });
    expect(sha256(first.rawPayload)).toBe(voidedRow.contentHash);

    // 渲染器零呼叫（三次下載期間之呼叫數增量恆為 0）。
    expect(vi.mocked(renderPdf).mock.calls.length).toBe(renderPdfCallsBefore);
    expect(vi.mocked(renderReportHtml).mock.calls.length).toBe(renderHtmlCallsBefore);

    // 下載為唯讀路徑：storage 零新增檔案、作廢版列仍恰一列。
    expect(listReportStorageKeys(reportRoot)).toEqual(storageKeysBefore);
    expect(await prisma.voidedReportFile.count({ where: { reportId: report.id } })).toBe(1);
  }, 60000);

  // -------------------------------------------------------------------------
  // §E-3 fallback（T12a 即審 AR-1／FW-3）
  // -------------------------------------------------------------------------

  it("fallback（AR-1／FW-3）: VOIDED 但無 VoidedReportFile（直造資料）→ 200 回**原檔**位元組，非 404／500", async () => {
    const id = await seedWithReport("E3 fallback");
    const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
    const originalBytes = await readAllBytes(reportStorage, report.storageKey);

    // 直寫 `VOIDED`（繞過作廢服務）——製造「D4(b1) 交易語意下結構性不可達」之
    // 狀態，使 fallback 分支可達並可釘樁。
    await prisma.application.update({
      where: { id },
      data: {
        status: "VOIDED",
        voidReason: "E3：直造之無作廢版狀態",
        voidedAt: new Date("2217-06-20T02:00:00.000Z"),
        voidedById: ownerId,
      },
    });
    expect(await prisma.voidedReportFile.count({ where: { reportId: report.id } })).toBe(0);

    const renderPdfCallsBefore = vi.mocked(renderPdf).mock.calls.length;
    const resp = await downloadPdf(id);
    expect(resp.statusCode, resp.body).toBe(200);
    expect(resp.rawPayload.equals(originalBytes)).toBe(true);
    expect(resp.headers["content-disposition"]).toContain(`filename="${report.reportNumber}.pdf"`);
    // 唯讀：fallback 不得「補產生」作廢版（渲染器零呼叫、零新列）。
    expect(vi.mocked(renderPdf).mock.calls.length).toBe(renderPdfCallsBefore);
    expect(await prisma.voidedReportFile.count({ where: { reportId: report.id } })).toBe(0);
  }, 60000);

  // -------------------------------------------------------------------------
  // §E-4 回歸：未作廢申請之下載行為零變更
  // -------------------------------------------------------------------------

  it("回歸: 未作廢（COMPLETED）申請之下載行為零變更——200 回原檔、重複下載全等、渲染器零呼叫；未產生報表仍 404（B-27）", async () => {
    const id = await seedWithReport("E4 未作廢回歸");
    const report = await prisma.report.findUniqueOrThrow({ where: { applicationId: id } });
    const originalBytes = await readAllBytes(reportStorage, report.storageKey);

    const renderPdfCallsBefore = vi.mocked(renderPdf).mock.calls.length;
    const renderHtmlCallsBefore = vi.mocked(renderReportHtml).mock.calls.length;

    const first = await downloadPdf(id);
    const second = await downloadPdf(id);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.rawPayload.equals(originalBytes)).toBe(true);
    expect(Buffer.compare(first.rawPayload, second.rawPayload)).toBe(0);
    expect(sha256(first.rawPayload)).toBe(report.contentHash);
    expect(first.headers["content-disposition"]).toContain(`filename="${report.reportNumber}.pdf"`);
    expect(vi.mocked(renderPdf).mock.calls.length).toBe(renderPdfCallsBefore);
    expect(vi.mocked(renderReportHtml).mock.calls.length).toBe(renderHtmlCallsBefore);

    // B-27 語意不變：未產生報表之已完成申請下載仍 404。
    const noReportId = await seedCompletedTravel("E4 未產生報表");
    expect((await downloadPdf(noReportId)).statusCode).toBe(404);
  }, 60000);
});
