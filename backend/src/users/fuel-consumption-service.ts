/**
 * User fuel-consumption service — PHASE-005a-T4
 *
 * 按使用者之車輛油種＋油耗版本 service 層（建立／列表）。
 * Spec §2.B AC-07/08/09/10/11、§7.2、§16 D3(b-1)/D8(a)。
 *
 * **Out of scope（T5 承接）**：route 註冊、授權矩陣（15 格）、稽核
 * （`AuditLog` 寫入、`before`/`after` 計算）、`state`
 * （`HISTORICAL`/`CURRENT`/`FUTURE`）欄位計算。本檔僅提供純 service 層之
 * 建立與列表函式，供 T5 之 route 層呼叫並附加上述行為。
 *
 * **複用義務（AC-11 實作約束逐字，同 AC-06）**：`kmPerLiter` 格式層驗證
 * 一律複用 `parameter-validation.ts` 之 `parseParameterDecimalField` 與
 * `UNIT_PRICE_CAPACITY`（`Decimal(10,4)`，§16 D3(b-1) 已批准同容量），
 * **不得另寫一套**。重疊判定一律複用 `parameter-version-engine.ts` 之
 * `checkNoOverlap`（`existing` 由呼叫端以 `userId` 收斂查詢後傳入，使跨
 * 使用者時間軸互不干涉——AC-10 鑑別力核心）。日期解析／格式化複用
 * `parameter-service.ts` 之 `parseUtcDate`／`formatUtcDate`（PHASE-003a 既有
 * 純函式，同形沿用，不重寫日期比較邏輯）。
 *
 * `Decimal` 建構全程以字串／既有 Decimal 值進行（D4 bright-line）；本檔
 * 唯一涉及數值的路徑（`kmPerLiter`）完全交由 `parseParameterDecimalField`
 * 處理，本檔自身不含任何 `Number()`／`parseFloat`／`parseInt`／一元 `+`
 * 數值脅制（AC-28，見 `test/unit/fuel-price-engine.test.ts` 之
 * `PHASE_005A_SRC_FILES` 結構性掃描——本檔已列入該清單）。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { FuelType } from "@prisma/client";
import { formatUtcDate, parseUtcDate } from "../parameters/parameter-service.js";
import {
  UNIT_PRICE_CAPACITY,
  parseParameterDecimalField,
} from "../parameters/parameter-validation.js";
import { checkNoOverlap } from "../parameters/parameter-version-engine.js";
import type { FieldError } from "../platform/errors.js";
import { AppError } from "../platform/errors.js";

// ---------------------------------------------------------------------------
// Prisma error detection (reused pattern, fuel-price-service.ts；T5 AR-3/AR-4
// 擴充見下方兩個具名判定函式)
// ---------------------------------------------------------------------------

function isPrismaErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * T5 AR-3：`userId` 存在性檢查（見 `createFuelConsumptionVersion` 步驟 6）發生於
 * `$transaction` **之外**，故理論上存在極窄的 TOCTOU 競態視窗——檢查通過後、
 * `create()` 執行前，該使用者列被刪除（`onDelete: Restrict` 通常會擋下有引用
 * 的刪除，但本筆尚未建立引用前仍可能被刪）。
 *
 * 選擇「於 catch 加 P2003→404 映射」（Packet AR-3 兩擇一之一），而非把存在性
 * 檢查移入交易：既有 T4 測試（AC-07 之 404 案例）已針對「交易外預檢查」路徑
 * 撰寫斷言，移入交易將改變其可觀察行為並需同步修改該檔（不在本 Task
 * Files Allowed 範圍內）；而 catch 端點加一道 P2003 映射為純粹的
 * defense-in-depth，不改變任何既有測試之可觀察行為，diff 最小。
 * `UserFuelConsumptionVersion.userId` 為外鍵，違反時 Prisma 回 P2003
 * （foreign key constraint failed）。
 */
function isPrismaForeignKeyConstraintError(err: unknown): boolean {
  return isPrismaErrorWithCode(err, "P2003");
}

/**
 * T5 AR-4：本檔之 `create()` 於 T5 起與 `AuditLog.create()` 同在一個
 * `$transaction` 內執行（稽核寫入失敗須使整筆建立回滾，見 route 層）。若未來
 * `AuditLog` 或其他寫入新增唯一鍵，同一交易內任何 P2002 都會被本函式捕捉，
 * 若不加區辨會被誤譯為 `PARAMETER_PERIOD_OVERLAP`（409）。
 *
 * 因此僅在錯誤 `meta` 明確指向本表之唯一鍵
 * （`UserFuelConsumptionVersion_userId_effectiveFrom_key`，或 Postgres 連線下
 * Prisma 回傳之欄位陣列 `["userId","effectiveFrom"]`）時才轉譯为 409；
 * `meta` 缺失時（T4 既有 stub 測試之情境，見
 * `test/integration/phase5a-fuel-consumption.test.ts` 之 P2002 stub）視為
 * 「來源不明但目前系統中唯一會拋出 P2002 的路徑正是本表唯一鍵」，維持既有
 * 行為（409），不弱化該既有測試；若 `meta` 存在但指向其他鍵，一律原樣拋出
 * （不得誤譯為版本重疊）。
 */
const FUEL_CONSUMPTION_UNIQUE_CONSTRAINT_NAME =
  "UserFuelConsumptionVersion_userId_effectiveFrom_key";

function isFuelConsumptionUniqueConstraintError(err: unknown): boolean {
  if (!isPrismaErrorWithCode(err, "P2002")) return false;

  const meta = (err as { meta?: unknown }).meta;
  if (meta === undefined || meta === null) {
    // 無 meta 可供辨識——維持既有行為（409），見上方 JSDoc。
    return true;
  }

  const target = (meta as { target?: unknown }).target;
  if (typeof target === "string") {
    return target.includes(FUEL_CONSUMPTION_UNIQUE_CONSTRAINT_NAME);
  }
  if (Array.isArray(target)) {
    return target.includes("userId") && target.includes("effectiveFrom");
  }

  // 未知的 meta 形狀——保守處理，不轉譯（避免把不相關的唯一鍵違反誤判為
  // 版本重疊）。
  return false;
}

// ---------------------------------------------------------------------------
// Fuel type enum gate（同 fuel-price-service.ts 之 AC-05 同形套用）
// ---------------------------------------------------------------------------

const VALID_FUEL_TYPES: readonly string[] = [
  FuelType.GASOLINE_92,
  FuelType.GASOLINE_95,
  FuelType.GASOLINE_98,
  FuelType.DIESEL,
];

const REASON_FUEL_TYPE = "油種必須為 GASOLINE_92、GASOLINE_95、GASOLINE_98 或 DIESEL 之一";

function validateFuelType(value: unknown): value is FuelType {
  return typeof value === "string" && VALID_FUEL_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// basisNote 驗證（AC-09／Q6／§16 D3(c-1)：長度上限 500 字）
// ---------------------------------------------------------------------------

const REASON_BASIS_NOTE_REQUIRED = "請填寫核對依據";
const REASON_BASIS_NOTE_TOO_LONG = "依據備註長度不得超過 500 字";
const BASIS_NOTE_MAX_LENGTH = 500;

/**
 * 驗證並回傳 trim 後之 `basisNote`（B-13：儲存值為 trim 後之字串）。
 * 缺欄位／`null`／`""`／全空白 → 必填錯誤；trim 後長度 > 500 → 長度錯誤。
 */
function validateBasisNote(
  value: unknown
): { ok: true; value: string } | { ok: false; error: FieldError } {
  if (typeof value !== "string") {
    return { ok: false, error: { field: "basisNote", reason: REASON_BASIS_NOTE_REQUIRED } };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { field: "basisNote", reason: REASON_BASIS_NOTE_REQUIRED } };
  }
  if (trimmed.length > BASIS_NOTE_MAX_LENGTH) {
    return { ok: false, error: { field: "basisNote", reason: REASON_BASIS_NOTE_TOO_LONG } };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// DTO types（§7.2 FuelConsumptionVersionDto，`state` 由 T5 附加，本檔不含）
// ---------------------------------------------------------------------------

export interface FuelConsumptionVersionDto {
  id: string;
  userId: string;
  fuelType: FuelType;
  kmPerLiter: string; // toFixed(4)，Decimal(10,4)
  effectiveFrom: string; // YYYY-MM-DD
  basisNote: string;
  createdAt: string; // ISO
  createdById: string;
}

type FuelConsumptionRow = {
  id: string;
  userId: string;
  fuelType: FuelType;
  kmPerLiter: Prisma.Decimal;
  effectiveFrom: Date;
  basisNote: string;
  createdAt: Date;
  createdById: string;
};

export function toFuelConsumptionDto(row: FuelConsumptionRow): FuelConsumptionVersionDto {
  return {
    id: row.id,
    userId: row.userId,
    fuelType: row.fuelType,
    kmPerLiter: row.kmPerLiter.toFixed(4),
    effectiveFrom: formatUtcDate(row.effectiveFrom),
    basisNote: row.basisNote,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
  };
}

// ---------------------------------------------------------------------------
// T5-style audit hook（比照 fuel-price-service.ts 之既有介面）
// ---------------------------------------------------------------------------

export type OnFuelConsumptionCreated = (
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  version: FuelConsumptionVersionDto
) => Promise<void>;

// ---------------------------------------------------------------------------
// createFuelConsumptionVersion（AC-07/08/09/10/11）
// ---------------------------------------------------------------------------

export interface CreateFuelConsumptionVersionInput {
  userId: string;
  fuelType: unknown;
  kmPerLiter: unknown;
  effectiveFrom: unknown;
  basisNote: unknown;
  createdById: string;
}

/**
 * 建立一筆使用者車輛油種＋油耗版本。
 *
 * 驗證順序：
 *   1. `fuelType` 列舉封閉（同 AC-05 同形）
 *   2. `kmPerLiter` 格式層四道（複用 `parseParameterDecimalField`／
 *      `UNIT_PRICE_CAPACITY`）
 *   3. `kmPerLiter` 值域層（`> 0`，AC-08）
 *   4. `effectiveFrom` 合法日期
 *   5. `basisNote` 必填 ＋ 長度上限（AC-09）
 *   6. `userId` 存在性（AC-07：不存在 → 404 `NOT_FOUND`，訊息不洩漏帳號
 *      存在與否以外之資訊；B-12：允許為 `isActive=false` 之使用者建立）
 *   7. 同使用者重疊檢查（`checkNoOverlap`，AC-10；`existing` 以 `userId`
 *      收斂查詢，使跨使用者時間軸互不干涉）
 *
 * 欄位格式驗證（1~5）為純函式判定，優先於 DB 往返判定（6~7），
 * 故格式錯誤與 `userId` 不存在同時成立時，回報格式錯誤（400）。
 *
 * DB `@@unique([userId, effectiveFrom])` 為併發最後防線（AC-10 鑑別力）：
 * 併發衝突一律轉譯為 409 `PARAMETER_PERIOD_OVERLAP`，絕不 500。
 */
export async function createFuelConsumptionVersion(
  prisma: PrismaClient,
  input: CreateFuelConsumptionVersionInput,
  onCreated?: OnFuelConsumptionCreated
): Promise<FuelConsumptionVersionDto> {
  // 1. fuelType 列舉封閉
  if (!validateFuelType(input.fuelType)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "fuelType", reason: REASON_FUEL_TYPE },
    ]);
  }
  const fuelType = input.fuelType;

  // 2/3. kmPerLiter：格式層（複用）→ 值域層（>0，AC-08）
  const kmResult = parseParameterDecimalField(input.kmPerLiter, "kmPerLiter", UNIT_PRICE_CAPACITY);
  if (!kmResult.ok) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [kmResult.error]);
  }
  const kmPerLiterDecimal = kmResult.value;

  if (kmPerLiterDecimal.lessThanOrEqualTo(0)) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "kmPerLiter", reason: "油耗必須大於 0" },
    ]);
  }

  // 4. effectiveFrom：合法 YYYY-MM-DD（複用 parameter-service.ts:parseUtcDate）
  if (typeof input.effectiveFrom !== "string") {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }
  const effectiveFromDate = parseUtcDate(input.effectiveFrom);
  if (!effectiveFromDate) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      { field: "effectiveFrom", reason: "生效日期必須為合法日期（格式：YYYY-MM-DD）" },
    ]);
  }

  // 5. basisNote：必填 ＋ 長度上限（AC-09；trim 後值即為儲存值，B-13）
  const basisNoteResult = validateBasisNote(input.basisNote);
  if (!basisNoteResult.ok) {
    throw new AppError("VALIDATION_ERROR", 400, "輸入資料有誤，請檢查標示欄位。", [
      basisNoteResult.error,
    ]);
  }
  const basisNote = basisNoteResult.value;

  // 6. userId 存在性（AC-07）——不洩漏帳號存在與否以外之資訊；
  // B-12：不檢查 isActive（允許為已停用使用者建立）。
  const targetUser = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!targetUser) {
    throw new AppError("NOT_FOUND", 404, "使用者不存在");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 7. 同使用者重疊檢查（AC-10）：existing 以 userId 收斂查詢，使跨
      // 使用者時間軸互不干涉。
      const existing = await tx.userFuelConsumptionVersion.findMany({
        where: { userId: input.userId },
        select: { id: true, effectiveFrom: true },
      });

      const overlapResult = checkNoOverlap(existing, effectiveFromDate);
      if (!overlapResult.ok) {
        throw new AppError(
          "PARAMETER_PERIOD_OVERLAP",
          409,
          "新版本的生效期間與現有版本重疊，請調整生效日期。",
          undefined,
          { conflictVersion: overlapResult.conflict }
        );
      }

      const version = await tx.userFuelConsumptionVersion.create({
        data: {
          userId: input.userId,
          fuelType,
          kmPerLiter: kmPerLiterDecimal,
          effectiveFrom: effectiveFromDate,
          basisNote,
          createdById: input.createdById,
        },
      });

      const dto = toFuelConsumptionDto(version);

      if (onCreated) {
        await onCreated(tx, dto);
      }

      return dto;
    });

    return result;
  } catch (err) {
    if (err instanceof AppError) throw err;

    // T5 AR-3：交易內 create() 之外鍵違反（userId 於預檢查之後、create() 之前
    // 被刪除的窄競態視窗）→ 404，語意與步驟 6 之預檢查一致，絕不 500。
    if (isPrismaForeignKeyConstraintError(err)) {
      throw new AppError("NOT_FOUND", 404, "使用者不存在");
    }

    // 併發最後防線（DB @@unique([userId, effectiveFrom]))）→ 409，絕不 500。
    // T5 AR-4：僅在 meta 指向本表唯一鍵（或 meta 缺失，維持既有行為）時轉譯；
    // 指向其他鍵之 P2002 原樣拋出（見 isFuelConsumptionUniqueConstraintError JSDoc）。
    if (isFuelConsumptionUniqueConstraintError(err)) {
      throw new AppError(
        "PARAMETER_PERIOD_OVERLAP",
        409,
        "新版本的生效期間與現有版本重疊（系統偵測到並發衝突）。",
        undefined,
        {
          conflictVersion: {
            userId: input.userId,
            effectiveFrom: input.effectiveFrom,
          },
        }
      );
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// listFuelConsumptionVersions（§7.2 GET /users/:userId/fuel-consumption 之
// 底層資料來源；`state` 欄位由 T5 附加，本函式僅回傳裸版本清單）
// ---------------------------------------------------------------------------

/**
 * 依 `effectiveFrom` 升冪回傳指定使用者之全部油耗版本；無版本 → 空陣列
 * （合法，非錯誤——AC-12 之「200 空陣列」由 T5 之 route 層落實，本函式
 * 本身即為該行為之資料層基礎）。
 */
export async function listFuelConsumptionVersions(
  prisma: PrismaClient,
  userId: string
): Promise<FuelConsumptionVersionDto[]> {
  const rows = await prisma.userFuelConsumptionVersion.findMany({
    where: { userId },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map(toFuelConsumptionDto);
}
