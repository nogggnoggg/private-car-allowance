/**
 * CHORE-002-T1 修項① — D4 Decimal 字串化 ×4。
 *
 * reviewer 查證的 4 個位址（皆為「number 變數 → new Prisma.Decimal(number)」直通式，
 * number 輸入時經 float 中介，PHASE-004 R5 未涵蓋的最後理論破口）：
 *   1. parameter-service.ts createFuelVersion（priceNum → unitPrice）
 *   2. parameter-service.ts createEtcVersion（priceNum → unitPrice）
 *   3. parameter-service.ts createDepreciationVersion（input.vehiclePrice as string|number）
 *   4. depreciation-engine.ts deriveDepreciation（input.vehiclePrice as string|number）
 *
 * 修法：新增 toDecimalConstructorArg() helper（parameter-service.ts 匯出一份，
 * depreciation-engine.ts 因是 pure module 不依賴 AppError，故各自持有同形 private 版本），
 * 一律把送進 `new Prisma.Decimal(...)` 的引數轉為字串（string 輸入原樣傳遞；
 * number 輸入以 String() 轉換，不再讓建構子直接讀取 number 的精確二進位值）。
 *
 * 行為預期零變更：
 *   - 值域驗證邏輯（Number() 用於範圍/正負/整數判斷）完全不動。
 *   - 既有 phase3a 參數測試（含 4-dp 精度往返）不修改、须全綠 —— 本檔僅新增覆蓋，
 *     不重複驗證既有 AC。
 *
 * DB 需求：
 *   (a)(b) 組（字串輸入與數字輸入建構結果一致）需要真實 DB 才能走完整個
 *   create*Version 流程（含 transaction），DATABASE_URL 未設定時 skip。
 *   (d) 組（deriveDepreciation 字串/數字等價）為 pure function，不需要 DB。
 *
 * CHORE-002-R1 修訂（reviewer 裁定採 S-1 選項 (i) 最小回歸）：
 *   移除「極端量級防呆」（>= 1e21 / < 1e-6 拋錯）與對應 (c) 組測試——該防呆是
 *   核准範圍（「行為零變更」）外的新增行為，且其前提（String() 會產生 decimal.js
 *   無法解析的字面值）經 reviewer 實測為假：decimal.js 完整支援解析科學記號字串。
 */
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "../../src/db/prisma.js";
import { deriveDepreciation } from "../../src/parameters/depreciation-engine.js";
import {
  createDepreciationVersion,
  createEtcVersion,
  createFuelVersion,
  toDecimalConstructorArg,
} from "../../src/parameters/parameter-service.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const SUFFIX = Date.now();
const CREATED_BY = `chore002_test_actor_${SUFFIX}`;

// ---------------------------------------------------------------------------
// (unit) toDecimalConstructorArg — pure helper, no DB
// ---------------------------------------------------------------------------

describe("CHORE-002-T1 ①: toDecimalConstructorArg 單元測試", () => {
  it("字串輸入原樣傳回（不經任何轉換）", () => {
    expect(toDecimalConstructorArg("12.3400")).toBe("12.3400");
    expect(toDecimalConstructorArg("0")).toBe("0");
  });

  it("一般量級數字輸入 → String() 轉換的結果（非直接傳遞 number）", () => {
    expect(toDecimalConstructorArg(12.34)).toBe("12.34");
    expect(toDecimalConstructorArg(0)).toBe("0");
    expect(toDecimalConstructorArg(19.9)).toBe("19.9");
  });
});

// ---------------------------------------------------------------------------
// (d) deriveDepreciation — number vs string vehiclePrice 逐位元一致（pure, no DB）
// ---------------------------------------------------------------------------

describe("CHORE-002-T1 ①-(d): deriveDepreciation number/string vehiclePrice 建構結果等價", () => {
  it("number 輸入與等值 string 輸入產生完全相同的 derived 結果", () => {
    const byNumber = deriveDepreciation({
      vehiclePrice: 19.9,
      usefulLifeYears: 3,
      estimatedAnnualKm: 20000,
    });
    const byString = deriveDepreciation({
      vehiclePrice: "19.9",
      usefulLifeYears: 3,
      estimatedAnnualKm: 20000,
    });
    expect(byNumber.ok).toBe(true);
    expect(byString.ok).toBe(true);
    if (byNumber.ok && byString.ok) {
      expect(byNumber.annualDepreciation).toBe(byString.annualDepreciation);
      expect(byNumber.perKmUnitPrice).toBe(byString.perKmUnitPrice);
    }
  });

  it("既有精度案例（vehiclePrice=10, years=3, km=3）number 輸入不受影響（回歸）", () => {
    const result = deriveDepreciation({
      vehiclePrice: 10,
      usefulLifeYears: 3,
      estimatedAnnualKm: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annualDepreciation).toBe("3.33");
      expect(result.perKmUnitPrice).toBe("1.1111");
    }
  });

  it("number 輸入 vehiclePrice <= 0 仍回 { ok: false }（值域驗證邏輯不變）", () => {
    expect(
      deriveDepreciation({ vehiclePrice: 0, usefulLifeYears: 3, estimatedAnnualKm: 3 })
    ).toEqual({ ok: false });
    expect(
      deriveDepreciation({ vehiclePrice: -5, usefulLifeYears: 3, estimatedAnnualKm: 3 })
    ).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// (a)(b) 字串輸入與數字輸入建構結果逐位元一致（需要真實 DB）
// ---------------------------------------------------------------------------

describeWithDb(
  "CHORE-002-T1 ①-(a)(b): create*Version number/string 輸入建構結果等價（需 DB）",
  () => {
    const prisma = getPrismaClient(DB_URL);

    afterAll(async () => {
      // Cleanup scoped to sentinel effectiveFrom dates used by this file only.
      await prisma.fuelParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: new Date("2098-01-01"), lte: new Date("2098-01-31") } },
      });
      await prisma.etcParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: new Date("2098-02-01"), lte: new Date("2098-02-28") } },
      });
      await prisma.depreciationParameterVersion.deleteMany({
        where: { effectiveFrom: { gte: new Date("2098-03-01"), lte: new Date("2098-03-31") } },
      });
      await prisma.$disconnect();
    });

    it("createFuelVersion：number 19.9 與 string '19.9' 建構出相同的 unitPrice DTO", async () => {
      const byNumber = await createFuelVersion(prisma, {
        unitPrice: 19.9,
        effectiveFrom: "2098-01-01",
        createdById: CREATED_BY,
      });
      const byString = await createFuelVersion(prisma, {
        unitPrice: "19.9",
        effectiveFrom: "2098-01-02",
        createdById: CREATED_BY,
      });
      expect(byNumber.unitPrice).toBe("19.9000");
      expect(byString.unitPrice).toBe("19.9000");
      expect(byNumber.unitPrice).toBe(byString.unitPrice);
    });

    it("createEtcVersion：number 5.5 與 string '5.5' 建構出相同的 unitPrice DTO", async () => {
      const byNumber = await createEtcVersion(prisma, {
        unitPrice: 5.5,
        effectiveFrom: "2098-02-01",
        createdById: CREATED_BY,
      });
      const byString = await createEtcVersion(prisma, {
        unitPrice: "5.5",
        effectiveFrom: "2098-02-02",
        createdById: CREATED_BY,
      });
      expect(byNumber.unitPrice).toBe("5.5000");
      expect(byString.unitPrice).toBe(byString.unitPrice);
      expect(byNumber.unitPrice).toBe(byString.unitPrice);
    });

    it("createDepreciationVersion：vehiclePrice number 600000 與 string '600000' 建構出相同的 DTO + derived", async () => {
      const byNumber = await createDepreciationVersion(prisma, {
        vehiclePrice: 600000,
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2098-03-01",
        createdById: CREATED_BY,
      });
      const byString = await createDepreciationVersion(prisma, {
        vehiclePrice: "600000",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2098-03-02",
        createdById: CREATED_BY,
      });
      expect(byNumber.vehiclePrice).toBe("600000.00");
      expect(byNumber.vehiclePrice).toBe(byString.vehiclePrice);
      expect(byNumber.derived).toEqual(byString.derived);
    });
  }
);
