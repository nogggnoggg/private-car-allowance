/**
 * Maintenance completion blockers — PHASE-006-T3
 *
 * Spec §2（AC-07/08/09/10/18）、§7.4（固定順序表，11 碼）、§9.3（兩段式呼叫，
 * `官方_km=null` 表尚未查詢期間公務里程）。Pure function, no DB, no IO, no
 * side effects — same shape/convention as
 * `backend/src/applications/completion-blockers.ts`（PHASE-004）。
 *
 * 兩段式語意（§9.3 步驟②③④、pseudocode 行 530/538 逐字）：
 *   第一段（結構性，1~8、10）：僅需「五欄」＋ `attachmentCount`，不需查詢
 *     期間公務里程即可判定；非空即拒絕，**不**執行後續聚合查詢（省一次
 *     query，且錯誤語意單一）。
 *   第二段（計算性，9、11）：僅在第一段（1~8）**全部**通過後才可能出現
 *     （§7.4 註記：「第 9、11 項僅在前 8 項全通過時才可能出現，否則無法
 *     計算」——與第 10 項無關，第 10 項屬結構性）。呼叫端以 `officialKm`
 *     是否為 `null` 表達「是否已完成第二段查詢」：`null` ⇒ 尚未查詢 ⇒
 *     完全抑制第 9、11 項；非 `null` ⇒ 已查詢 ⇒ 依值判定。
 *
 * 設計決定（偏離 pseudocode 行 530 字面參數清單，於此說明）：pseudocode 將
 * `intervalKm` 列為與 `officialKm` 並列的獨立參數，但 `intervalKm`
 * （`currentOdometerKm − lastOdometerKm`）在第一段（1~8）全通過後即可由
 * `lastOdometerKm`/`currentOdometerKm` 兩欄安全推導（此時两者已保證非
 * `null` 且順序合法）——本檔選擇**內部推導**而非另收一個可能與五欄矛盾的
 * 重複輸入（單一事實來源、零重複狀態），避免呼叫端傳入不一致的
 * `intervalKm` 造成的隱性錯誤。第 11 項（`AMOUNT_OUT_OF_RANGE`）之判定
 * 依賴 `calculateMaintenance`／`isMaintenanceCalculationOverCapacity`
 * 之輸出（金額換算，非本檔職責——本檔零接線、不 import T2 引擎），故以
 * 呼叫端算好的布林旗標 `amountOutOfRange` 傳入，沿用
 * `completion-blockers.ts`（PHASE-004/005a）之既有慣例
 * （`amountOutOfRange?: boolean`）。
 *
 * NaN／非有限值防禦（T2 即審前瞻警示①，逐字延續至本檔）：`Prisma.Decimal`
 * 的 `NaN` 比較全部回 `false`（`NaN.lessThanOrEqualTo(0) === false`），若
 * 直接以 `≤`/`>` 判定順序或值域，`NaN` 輸入會被**靜默放行**（看似合法）。
 * 本檔對日期（`Date#getTime()` 為 `NaN`）與 `Decimal`（`!isFinite()`）之
 * 非有限值一律視為「無法驗證為合法」而**視同違反對應規則**（保守失敗，
 * 而非靜默通過）——不變式：**任何非有限值輸入，必產生至少一個對應
 * blocker**，不得出現「零 blocker 但輸入實為垃圾值」的狀況。
 */

import type { Prisma } from "@prisma/client";

export interface Blocker {
  code: string;
  field?: string;
  message: string; // zh-TW
}

export interface ComputeMaintenanceBlockersInput {
  lastMaintenanceDate: Date | null;
  currentMaintenanceDate: Date | null;
  lastOdometerKm: Prisma.Decimal | null;
  currentOdometerKm: Prisma.Decimal | null;
  actualCost: Prisma.Decimal | null;
  /** 該申請目前 `LINKED` 附件數（AC-22）。 */
  attachmentCount: number;
  /**
   * 期間公務里程（AC-18）。`null` 表「尚未查詢」（第一段呼叫，§9.3 步驟②）
   * ——完全抑制第 9、11 項；非 `null` 表「已查詢」（第二段呼叫，步驟③④之
   * 後）——依值判定第 9、11 項（僅當第 1~8 項全通過時才會實際判定）。
   */
  officialKm: Prisma.Decimal | null;
  /**
   * 第 11 項旗標——`calculateMaintenance`/`isMaintenanceCalculationOverCapacity`
   * （T2）之容量判定結果，由呼叫端（T7/T8）算好傳入（本檔零接線，不 import
   * T2 引擎）。僅在 `officialKm !== null` 且第 1~8 項全通過時才會被採用；
   * 預設 `false`（既有呼叫端型態不受影響）。
   */
  amountOutOfRange?: boolean;
}

/** `Date#getTime()` 為 `NaN`（Invalid Date）視為「無法驗證」——保守失敗。 */
function isInvalidDate(value: Date): boolean {
  return Number.isNaN(value.getTime());
}

/**
 * 日期順序違規判定（AC-07）：`本次 ≤ 上次`（含相等）。任一值為 Invalid Date
 * 亦視為違規（NaN 防禦——見檔頭說明，不得被 native `<=` 的 NaN 恆 false
 * 行為靜默放行）。
 */
function isDateOrderInvalid(last: Date, current: Date): boolean {
  if (isInvalidDate(last) || isInvalidDate(current)) {
    return true;
  }
  return current.getTime() <= last.getTime();
}

/**
 * 里程表順序違規判定（AC-08）：`本次 ≤ 上次`（含相等）。任一值非有限
 * （`NaN`/`Infinity`）亦視為違規（同上 NaN 防禦）。
 */
function isOdometerOrderInvalid(last: Prisma.Decimal, current: Prisma.Decimal): boolean {
  if (!last.isFinite() || !current.isFinite()) {
    return true;
  }
  return current.lessThanOrEqualTo(last);
}

/** 費用值域違規判定（AC-09）：`≤ 0`。非有限值亦視為違規（同上）。 */
function isActualCostInvalid(cost: Prisma.Decimal): boolean {
  return !cost.isFinite() || cost.lessThanOrEqualTo(0);
}

/**
 * AC-18 共用 predicate（PHASE-006-T5R SF-1 修復）：`期間公務里程 > 保養區間里程`。
 * 單一事實來源——供本檔（第 9 項）與 `maintenance-service.ts`
 * （`computeMaintenanceComputed` 之 `blockingCodes` 組裝）共同呼叫，避免同一條
 * AC-18 規則出現兩份互相獨立、可各自漂移的實作（T5 即審 SF-1：`maintenance-
 * service.ts` 曾就地重寫 `result.officialKm.greaterThan(result.intervalKm)`，
 * 與本檔判定式各自獨立，mutant 可分別存活）。
 *
 * 非有限值（防禦性，官方里程理論上恆為有限）視同超出，保守失敗而非靜默放行
 * （同檔頭 NaN 防禦原則）。AC-18 明文要求以 `O`／`I` 之 Decimal 直接比較，
 * 不得以取整後之 ratio 比較。
 */
export function isOfficialKmExceedsInterval(
  officialKm: Prisma.Decimal,
  intervalKm: Prisma.Decimal
): boolean {
  return !officialKm.isFinite() || !intervalKm.isFinite() || officialKm.greaterThan(intervalKm);
}

/**
 * §7.4 第 1~8 項（結構性）判定——PHASE-006-T5R SF-2 修復：抽出為獨立可匯出
 * 函式，供 `maintenance-service.ts` 之 `computeMaintenanceComputed` 於「不可
 * 計算」分支（欄位未齊 / `intervalKm ≤ 0`）重用，填充 `MaintenanceComputedDto.
 * blockingCodes`（§7.2），避免對同一組結構性規則另寫第三份實作。
 *
 * 僅回傳第 1~8 項（不含第 9/10/11 項——這三項屬「計算性」或「附件」，與
 * 本函式「欄位是否齊備、順序是否合法」之結構性判定無關）。
 */
export function computeMaintenanceStructuralBlockers(
  input: Pick<
    ComputeMaintenanceBlockersInput,
    | "lastMaintenanceDate"
    | "currentMaintenanceDate"
    | "lastOdometerKm"
    | "currentOdometerKm"
    | "actualCost"
  >
): Blocker[] {
  const fieldLevelBlockers: Blocker[] = [];

  // ── 1~3：保養日期 ────────────────────────────────────────────────────
  const { lastMaintenanceDate, currentMaintenanceDate } = input;
  if (lastMaintenanceDate === null) {
    fieldLevelBlockers.push({
      code: "LAST_MAINTENANCE_DATE_REQUIRED",
      field: "lastMaintenanceDate",
      message: "請填寫上次保養日期",
    });
  }
  if (currentMaintenanceDate === null) {
    fieldLevelBlockers.push({
      code: "CURRENT_MAINTENANCE_DATE_REQUIRED",
      field: "currentMaintenanceDate",
      message: "請填寫本次保養日期",
    });
  }
  // AC-10 互斥規則：REQUIRED 在場時不重複回報同組之 ORDER_INVALID。
  if (
    lastMaintenanceDate !== null &&
    currentMaintenanceDate !== null &&
    isDateOrderInvalid(lastMaintenanceDate, currentMaintenanceDate)
  ) {
    fieldLevelBlockers.push({
      code: "MAINTENANCE_DATE_ORDER_INVALID",
      field: "currentMaintenanceDate",
      message: "本次保養日期必須晚於上次保養日期",
    });
  }

  // ── 4~6：里程表 ──────────────────────────────────────────────────────
  const { lastOdometerKm, currentOdometerKm } = input;
  if (lastOdometerKm === null) {
    fieldLevelBlockers.push({
      code: "LAST_ODOMETER_REQUIRED",
      field: "lastOdometerKm",
      message: "請填寫上次里程表數值",
    });
  }
  if (currentOdometerKm === null) {
    fieldLevelBlockers.push({
      code: "CURRENT_ODOMETER_REQUIRED",
      field: "currentOdometerKm",
      message: "請填寫本次里程表數值",
    });
  }
  if (
    lastOdometerKm !== null &&
    currentOdometerKm !== null &&
    isOdometerOrderInvalid(lastOdometerKm, currentOdometerKm)
  ) {
    fieldLevelBlockers.push({
      code: "ODOMETER_ORDER_INVALID",
      field: "currentOdometerKm",
      message: "本次里程表數值必須大於上次里程表數值",
    });
  }

  // ── 7~8：實際保養費用 ────────────────────────────────────────────────
  const { actualCost } = input;
  if (actualCost === null) {
    fieldLevelBlockers.push({
      code: "ACTUAL_COST_REQUIRED",
      field: "actualCost",
      message: "請填寫本次實際保養費用",
    });
  } else if (isActualCostInvalid(actualCost)) {
    fieldLevelBlockers.push({
      code: "ACTUAL_COST_INVALID",
      field: "actualCost",
      message: "本次實際保養費用必須大於 0",
    });
  }

  return fieldLevelBlockers;
}

/**
 * 計算保養申請草稿的「尚未完成項」清單（§7.4 固定順序，AC-07/08/09/10/18）。
 * 回傳全部未通過項（AC-10），不可只回第一項；輸出順序穩定可預期，逐項對應
 * §7.4 表格 1~11 之固定順序。
 */
export function computeMaintenanceBlockers(input: ComputeMaintenanceBlockersInput): Blocker[] {
  // 先依 1~8 之判定填入 fieldLevelBlockers（決定 9/11 之啟用閘門），
  // 最終輸出時再依 §7.4 固定順序（1..11）組裝——第 10 項雖與 1~8 同屬
  // 「結構性」（判定不需 officialKm），但**輸出順序**仍須排在第 9 項之後
  // （§7.4 表格順序），故不可直接 append 在 1~8 之後即回傳。
  const fieldLevelBlockers = computeMaintenanceStructuralBlockers(input);
  const { lastOdometerKm, currentOdometerKm } = input;

  // 第 9、11 項僅在第 1~8 項全通過時才可能出現（§7.4 註記逐字：「否則
  // 無法計算」）——與第 10 項（結構性，判斷本身不需 1~8 通過）無關。
  const fieldLevelPassed = fieldLevelBlockers.length === 0;

  // ── 9：期間公務里程 > 保養區間里程（AC-18） ─────────────────────────
  // 兩段式：officialKm===null 表尚未查詢（第一段呼叫）→ 完全抑制本項。
  // intervalKm 由 currentOdometerKm − lastOdometerKm 內部推導（見檔頭
  // 設計決定說明）；此時 fieldLevelPassed 已保證兩者皆非 null 且順序合法。
  let item9: Blocker | null = null;
  let item11: Blocker | null = null;
  if (fieldLevelPassed && input.officialKm !== null) {
    const intervalKm = (currentOdometerKm as Prisma.Decimal).minus(
      lastOdometerKm as Prisma.Decimal
    );
    const officialKm = input.officialKm;
    // AC-18 明文要求：必須以 O 與 I 之 Decimal 直接比較，不得以取整後之
    // ratio 比較——共用 predicate（見上方 `isOfficialKmExceedsInterval`
    // 文件註解，PHASE-006-T5R SF-1：單一事實來源，供本檔與
    // `maintenance-service.ts` 共同呼叫）。
    const officialExceedsInterval = isOfficialKmExceedsInterval(officialKm, intervalKm);
    if (officialExceedsInterval) {
      item9 = {
        code: "OFFICIAL_KM_EXCEEDS_INTERVAL",
        message: "期間公務里程大於保養區間里程，請檢查差旅、日期或里程資料",
      };
    }

    // ── 11：計算結果超出欄位容量 ───────────────────────────────────────
    if (input.amountOutOfRange) {
      item11 = {
        code: "AMOUNT_OUT_OF_RANGE",
        message: "計算結果超出可儲存之金額範圍，請檢查里程與費用",
      };
    }
  }

  // ── 10：保養證明附件（結構性；輸出順序排在第 9 項之後——§7.4 表格順序） ──
  const item10: Blocker | null =
    input.attachmentCount < 1
      ? { code: "MAINTENANCE_ATTACHMENT_REQUIRED", message: "請至少上傳 1 張保養證明" }
      : null;

  // 依 §7.4 固定順序（1..11）組裝最終輸出。
  const result: Blocker[] = [...fieldLevelBlockers];
  if (item9 !== null) result.push(item9);
  if (item10 !== null) result.push(item10);
  if (item11 !== null) result.push(item11);
  return result;
}
