/**
 * INFRA-001-T1 — `maxForks` 的單一事實來源。
 *
 * 修法前 `backend/vitest.config.ts:37` 就地計算 `maxForks`（PHASE-004-R3 的
 * 容量緩解，見該檔 L4-L36 的完整因果證據，此處不重複）。INFRA-001 的
 * `global-setup.ts` 需要為 `1..maxForks` 每個編號供裝一個 schema，若各處各
 * 算一次會有漂移風險（例如兩處對 `os.availableParallelism` 的呼叫時機不同、
 * 或未來只改一處），因此抽到這個共用模組，由 `vitest.config.ts` 與
 * `global-setup.ts` 共同 import（Spec §4.3「`maxForks` 的單一事實來源」）。
 *
 * 計算公式與 R3 原本的就地計算完全相同，僅搬移位置，不改變數值行為。
 */
import os from "node:os";

/**
 * 計算本機/CI 應使用的 `maxForks` 上限。
 *
 * 公式：`max(2, floor(可用邏輯核心數 / 2))`——見 `vitest.config.ts` 的 R3 註解
 * 對「為何減半、為何不是序列化到 1」的完整實測因果說明。這裡不重述理由，
 * 只保留單一計算實作。
 */
export function computeMaxForks(): number {
  const availableParallelism =
    (os as { availableParallelism?: () => number }).availableParallelism?.() ?? os.cpus().length;
  return Math.max(2, Math.floor(availableParallelism / 2));
}
