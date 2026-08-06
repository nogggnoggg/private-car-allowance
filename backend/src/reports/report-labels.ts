/**
 * 報表呈現面標籤映射 — PHASE-008-MOCK-R1（Mock Gate 三裁定之裁-1／裁-3 落地）
 *
 * Pure functions: no DB, no IO, no side effects, no implicit host-timezone
 * dependency（一律使用 `getUTC*` 系方法，**不得**使用會受執行主機時區污染的
 * `getFullYear`／`getHours` 等區域方法），**零 `Intl` 依賴**（Node 之
 * small-icu 建置會使 `zh-TW` locale 資料靜默回退為 `en-US`，屬「開發機綠、
 * 容器紅」之型態——見 §16 T14 字型分歧同類風險）。
 * Spec `docs/specs/PHASE-008.md` §2.D AC-11 之【修訂（2026-08-07 Mock Gate
 * 三裁定）】⒝【裁-1】、⒞【裁-3】、契約不變式④；§2.H AC-30 之修訂 ②。
 *
 * ---------------------------------------------------------------------------
 * 裁-1：時間欄位在地化（`formatTaipeiDateTime`）
 * ---------------------------------------------------------------------------
 * 目標呈現＝與前端既有「計算時間」同一長相（`toLocaleString("zh-TW")` 之
 * 預設輸出形狀）：`{YYYY}/{M}/{D} {上午|下午}{h}:{mm}`（月／日／12 小時制之
 * 時皆不補零；分鐘固定 2 位補零）。實作沿 `report-number.ts` 既有作法——固定
 * `TAIPEI_OFFSET_MS = 8h` 偏移後一律以 `getUTC*` 讀出並自行組字，不呼叫
 * `Date.prototype.toLocaleString`／`Intl.DateTimeFormat`，故格式化為決定性
 * （不受執行主機時區與 ICU locale 資料在場與否影響）。
 * 12 小時制邊界（與 Intl `zh-TW` 預設慣例一致，僅「上午」／「下午」兩值，不
 * 使用「中午」／「凌晨」等擴充日間區段）：`hour24 ∈ [0,11]` → 上午；
 * `hour24 ∈ [12,23]` → 下午；`hour24 % 12 === 0` 時 12 小時制之時顯示為 12
 * （凌晨 0 時＝「上午12」、正午 12 時＝「下午12」）。
 * 呼叫端負責 `null` 判別（「尚未產生」佔位）——本函式僅接受已存在之 ISO 字串，
 * 不處理 `null`（§2.D AC-11 修訂引註 ⒝ 末句）。
 *
 * ---------------------------------------------------------------------------
 * 裁-3：油種中文映射（`FUEL_TYPE_LABEL` ／ `getFuelTypeLabel`）
 * ---------------------------------------------------------------------------
 * 與前端既有下拉選項用字逐字一致（`frontend/src/components/
 * MyFuelConsumptionSection.tsx` :33-36）。以 `Record<FuelType, string>` 承載
 * ——比照 `report-number.ts` 之 `REPORT_NUMBER_PREFIX`：`FuelType` 未來新增
 * 成員時，若未同步在此補上對應中文標籤，型別檢查將於**編譯期**失敗
 * （`Record<K, V>` 強制窮盡 `K` 之每個成員）。呼叫端（`report-html.ts`）負責
 * `null`（LEGACY）判別——`dash()` 語意優先於翻譯，值為 `null` 時恆為「—」，
 * 不進入本函式、不譯出任何文字。版型層不得就地 `if`／`switch` 另立映射。
 */

import type { FuelType } from "@prisma/client";

/** Asia/Taipei 固定偏移（UTC+08:00，無日光節約）。沿 `report-number.ts` D2 選項 (a)。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 裁-1：`ReportCommon` 之 `generatedAt`／`createdAt`（ISO 8601 字串）→ 台北時區中文在地化字串。 */
export function formatTaipeiDateTime(isoString: string): string {
  const taipeiInstant = new Date(new Date(isoString).getTime() + TAIPEI_OFFSET_MS);
  const year = taipeiInstant.getUTCFullYear();
  const month = taipeiInstant.getUTCMonth() + 1;
  const day = taipeiInstant.getUTCDate();
  const hour24 = taipeiInstant.getUTCHours();
  const minute = String(taipeiInstant.getUTCMinutes()).padStart(2, "0");
  const period = hour24 < 12 ? "上午" : "下午";
  const hour12Raw = hour24 % 12;
  const hour12 = hour12Raw === 0 ? 12 : hour12Raw;
  return `${year}/${month}/${day} ${period}${hour12}:${minute}`;
}

/** 裁-3：油種 → 中文名稱之窮舉映射。 */
export const FUEL_TYPE_LABEL: Record<FuelType, string> = {
  GASOLINE_92: "92 無鉛汽油",
  GASOLINE_95: "95 無鉛汽油",
  GASOLINE_98: "98 無鉛汽油",
  DIESEL: "柴油",
};

/** 裁-3：依油種取得中文名稱（呼叫端須自行處理 `null`——LEGACY 之「—」）。 */
export function getFuelTypeLabel(fuelType: FuelType): string {
  return FUEL_TYPE_LABEL[fuelType];
}
