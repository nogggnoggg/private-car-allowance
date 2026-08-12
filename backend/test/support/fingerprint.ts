/**
 * PHASE-011-T17／AC-29(c)（D16-2）：`fingerprintRow` 全欄指紋法之單一共用來源。
 *
 * ---------------------------------------------------------------------------
 * 收斂前之重複（`KNOWN_ISSUES.md` :52 D-7「fingerprint 收斂」實查結果）
 * ---------------------------------------------------------------------------
 * `phase9-void.test.ts`（PHASE-009-T3／SF-2、T3R）與 `phase9-revision.test.ts`
 * （PHASE-009-T5，其檔內註解自陳：`phase7-depreciation-draft.test.ts`／
 * `phase9-void.test.ts` 於當時皆為該 Task 之 Files Forbidden，故「依裁定於本
 * 新檔就地複製第三份，維持三處語意逐字一致」）各自宣告一份**可執行邏輯逐字
 * 相同**之 `fingerprintRow`（僅行內註解份量不同）。本檔為該複製之單一收斂
 * 點，兩檔皆改為 import 本檔，簽章與行為逐字不變。
 *
 * `phase7-depreciation-draft.test.ts` 之 `fingerprint`／`fingerprintOf` 兩個
 * inline 函式**不**併入本次收斂——其邏輯與本函式不同形（無 `excludeKeys`
 * 參數、且分屬「逐欄手選＋格式化」與「全欄字串化不排他」兩種不同設計），併
 * 入將改變其行為，牴觸「收斂後鑑別力不得下降／語意逐字不變」之硬條件，故
 * 依保守原則不動。
 *
 * ---------------------------------------------------------------------------
 * 用途
 * ---------------------------------------------------------------------------
 * 將一列 Prisma 查詢結果轉為可 `toEqual` 比較之「全欄指紋」——逐鍵轉字串後
 * 依鍵排序，避免 Decimal／Date 物件之 `toEqual` 結構比對細節干擾，同時（相
 * 較逐欄手選斷言）不會漏掉任何「新增之允許外欄位」。
 *
 *   · Date → `toISOString()`（保留毫秒；`String(Date)` 會截斷至秒，使「同秒
 *     內毫秒位移之竄改」不可鑑別）。
 *   · `Prisma.Decimal` → `String()`（維持既有數值序列化行為；需 scale 保真
 *     時另以 `toFixed` 逐欄斷言）。
 *   · 其餘物件（含陣列，如巢狀 segments）→ `JSON.stringify`（避免
 *     `String(object)` 退化為 `[object Object]` 而掩蓋內容差異）。
 *
 * `excludeKeys`：供呼叫端排除已知會變動之欄位（如作廢欄／`updatedAt`）；不
 * 傳則整列逐欄比對，零例外。
 */
import { Prisma } from "@prisma/client";

export function fingerprintRow(
  row: Record<string, unknown>,
  excludeKeys: string[] = []
): Array<[string, string | null]> {
  return Object.entries(row)
    .filter(([key]) => !excludeKeys.includes(key))
    .map(([key, value]): [string, string | null] => {
      if (value === null || value === undefined) return [key, null];
      if (value instanceof Date) return [key, value.toISOString()];
      if (typeof value === "object" && !(value instanceof Prisma.Decimal)) {
        return [key, JSON.stringify(value)];
      }
      return [key, String(value)];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
