import type { PrismaClient } from "@prisma/client";
/**
 * CHORE-001-T1 修項② — D4 Decimal bright-line 收尾。
 *
 * `parameter-service.ts` createDepreciationVersion 的 catch 分支中，
 * `new Prisma.Decimal(0)`（傳數字）改為傳字串 `new Prisma.Decimal("0")`，
 * 與 PHASE-004 R5 已修過的其餘 7 處保持同形（消除 float 中介）。
 *
 * 這個 placeholder 值本身不會被使用：一旦 vehiclePrice 解析失敗進入 catch
 * 分支，fieldErrors 必非空，函式會在觸及交易／`vehiclePriceDecimal` 實際
 * 使用點之前就先以 AppError(VALIDATION_ERROR) 丟出（見
 * parameter-service.ts 第 512-516 行：`if (fieldErrors.length > 0) throw
 * ...` 早於第 543 行的 `vehiclePrice: vehiclePriceDecimal`）。
 * 因此本測試的目的僅是「防手滑改錯行」——證明改動後這條路徑的外部可觀察
 * 行為（丟出的錯誤 code/fields）完全不變，而非驗證某個被使用到的計算值。
 *
 * 不需要真實 DB：這個分支在觸及 `prisma.$transaction` 之前就已 return/throw，
 * 傳入的 prisma 物件不會被呼叫到，用型別斷言的假物件即可。
 *
 * CHORE-003-T3 現況更新（避免註解與實作背離，AC-29 後半）：上述
 * `new Prisma.Decimal("0")` placeholder 與其 try/catch 分支已於 CHORE-003-T2
 * 消失——`vehiclePrice` 改由 `parameter-validation.ts` 的格式層解析，失敗時
 * 直接 push `FieldError`，`vehiclePriceDecimal` 以 `null` 起始且僅在兩層驗證
 * 皆通過時賦值。本檔的守門價值因此轉為「不可解析之 `vehiclePrice` 仍必須被
 * 精確定位到該欄位並以 400 拒絕」，斷言依 Spec §14.8 第 2 項同步文案（見下）。
 */
import { describe, expect, it } from "vitest";
import { createDepreciationVersion } from "../../src/parameters/parameter-service.js";
import { AppError } from "../../src/platform/errors.js";

// Never actually invoked: fieldErrors.length > 0 causes an early throw
// before prisma.$transaction is reached (see comment above).
const unusedPrisma = {} as PrismaClient;

describe('CHORE-001-T1 ②: D4 Decimal placeholder（new Prisma.Decimal("0")）行為不變', () => {
  it("vehiclePrice 為無法解析的數值（例如 'abc'）→ 仍拋出 AppError(VALIDATION_ERROR)，且 vehiclePrice 欄位有錯誤訊息", async () => {
    await expect(
      createDepreciationVersion(unusedPrisma, {
        vehiclePrice: "abc",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2026-01-01",
        createdById: "test-actor",
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  });

  // CHORE-003-T3（Spec §14.8 第 2 項）：`reason` 文案依 §14.2 文案表更新。
  // 原鑑別意圖（「不可解析的 vehiclePrice 必須被**精確定位到該欄位**並拒絕，
  // 不得靜默寫入、不得漏報欄位」）完整保留：狀態碼 400 與 field `vehiclePrice`
  // 皆維持不變，僅 reason 隨明文批准的合約變更同步（格式層攔截取代舊 catch 分支）。
  it("錯誤的 fields 陣列包含 vehiclePrice：'必須為有效的十進位數值（不接受指數記號）'（§14.2 文案表；400 與 field 不變）", async () => {
    try {
      await createDepreciationVersion(unusedPrisma, {
        vehiclePrice: "abc",
        usefulLifeYears: 5,
        estimatedAnnualKm: 20000,
        effectiveFrom: "2026-01-01",
        createdById: "test-actor",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.fields).toContainEqual({
        field: "vehiclePrice",
        reason: "必須為有效的十進位數值（不接受指數記號）",
      });
    }
  });
});
