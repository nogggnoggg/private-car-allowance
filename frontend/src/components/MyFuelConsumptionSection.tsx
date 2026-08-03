/**
 * MyFuelConsumptionSection — PHASE-005a-T11
 *
 * 員工個人油耗檢視（AC-31，FE-US-28 全四條）。呼叫 `GET /me/fuel-consumption`
 * （backend T6：`backend/src/users/fuel-consumption-routes.ts`，經
 * `frontend/src/api/fuelConsumption.ts` 之 `apiGetMyFuelConsumption`）。
 *
 * AC-31 ③：本元件唯讀 —— 明文禁止任何新增／修改／刪除入口，整份檔案不含
 * 任何 <form>／可寫入的 <button>／<a>（僅「重試」——純重新查詢，非寫入）。
 *
 * 五態（Spec §4）：
 *   - Loading：「載入中…」
 *   - Empty（`current === null`）：「尚未建立車輛油耗資料，請聯絡管理員建立」
 *   - Error（5xx／網路失敗）：zh-TW 錯誤訊息 + 「重試」
 *   - Success：顯示油種／油耗／生效日期
 *   - 401（`UNAUTHORIZED`）：導向 `/login`
 *
 * AC-31 ④：固定顯示「如與實際車輛不符，請聯絡管理員核對後更新」——無論上述
 * 何種狀態皆顯示（故置於狀態切換區塊之外）。
 *
 * T5R AR-1 取捨（供 T13 文案總盤點）：生效日為伺服器 UTC 日粒度語意；本元件
 * 顯示生效日不額外加註時區說明——沿用既有 `FuelConsumptionVersionDto`
 * 呈現慣例（`AdminFuelConsumptionPage.tsx` 對 `effectiveFrom` 亦無時區註記）。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGetMyFuelConsumption } from "../api/fuelConsumption.js";
import type { ApiError, FuelType, MyFuelConsumptionDto } from "../types/api.js";

const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  GASOLINE_92: "92 無鉛汽油",
  GASOLINE_95: "95 無鉛汽油",
  GASOLINE_98: "98 無鉛汽油",
  DIESEL: "柴油",
};

type SectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "success"; data: MyFuelConsumptionDto };

export default function MyFuelConsumptionSection(): React.ReactElement {
  const navigate = useNavigate();
  const [state, setState] = useState<SectionState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { current } = await apiGetMyFuelConsumption();
      setState(current ? { kind: "success", data: current } : { kind: "empty" });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "UNAUTHORIZED") {
        navigate("/login", { replace: true });
        return;
      }
      setState({ kind: "error", message: apiErr.message ?? "載入失敗，請稍後重試。" });
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="my-fuel-consumption-section" aria-labelledby="my-fuel-consumption-heading">
      <h2 id="my-fuel-consumption-heading">我的車輛油耗</h2>

      {state.kind === "loading" && (
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="error-block" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            重試
          </button>
        </div>
      )}

      {state.kind === "empty" && (
        <div className="empty-block">
          <p>尚未建立車輛油耗資料，請聯絡管理員建立</p>
        </div>
      )}

      {state.kind === "success" && (
        <dl className="detail-list">
          <dt>油種</dt>
          <dd>{FUEL_TYPE_LABELS[state.data.fuelType]}</dd>
          <dt>油耗（km/公升）</dt>
          <dd>{state.data.kmPerLiter}</dd>
          <dt>生效日期</dt>
          <dd>{state.data.effectiveFrom}</dd>
        </dl>
      )}

      {/* AC-31 ④：固定顯示，不隨狀態變化 */}
      <p>如與實際車輛不符，請聯絡管理員核對後更新</p>
    </section>
  );
}
