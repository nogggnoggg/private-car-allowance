/**
 * ParametersPage — PHASE-003a-T6
 *
 * 管理員專屬補助參數維護頁。
 * 三類（油資 / ETC / 折舊）各有：建立表單 + 版本列表。
 * 五態：Loading / Empty / Error / Success / Permission denied（AC-20）。
 *
 * 折舊 derived（每年折舊費用、每公里單價）一律顯示後端回傳值，前端不自行計算。
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  apiCreateDepreciationVersion,
  apiCreateEtcVersion,
  apiCreateFuelPriceVersion,
  apiGetDepreciationVersions,
  apiGetEtcVersions,
  apiGetFuelPriceVersions,
} from "../api/parameters.js";
import { useAuth } from "../context/AuthContext.js";
import type {
  ApiError,
  DepreciationParameterDto,
  EtcParameterDto,
  FuelPriceVersionDto,
  FuelType,
} from "../types/api.js";

// ---- Shared section states ----

type SectionState<T> =
  | { kind: "loading" }
  | { kind: "permission-denied" }
  | { kind: "error"; message: string }
  | { kind: "ready"; versions: T[] };

// ---- Shared helpers ----

/**
 * 格式化日期為 YYYY-MM-DD（補零、本地時區）。
 * UI-FIX-001-T1：取代 toLocaleDateString("zh-TW")（輸出 2026/8/2，無補零，
 * 與生效日期欄格式不一致）。刻意使用本地時區的 getFullYear/getMonth/getDate
 * （而非 toISOString 的 UTC 方法），避免時區邊界日期錯位。
 */
export function formatDateYmd(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse ApiError.details.conflictVersion if available (PARAMETER_PERIOD_OVERLAP, §4.8) */
function getConflictVersionInfo(err: ApiError): string | null {
  const details = err.details;
  if (details?.conflictVersion) {
    const cv = details.conflictVersion as Record<string, unknown>;
    if (cv.effectiveFrom) {
      return String(cv.effectiveFrom);
    }
  }
  return null;
}

// ---- FuelSection (PHASE-005a-T9／AC-29：油種＋每公升油價，取代舊制每公里單價模型) ----

/** 固定四項油種（Q4／D2(a)），zh-TW 標籤逐字（AC-29）。 */
const FUEL_TYPE_OPTIONS: ReadonlyArray<{ value: FuelType; label: string }> = [
  { value: "GASOLINE_92", label: "92 無鉛汽油" },
  { value: "GASOLINE_95", label: "95 無鉛汽油" },
  { value: "GASOLINE_98", label: "98 無鉛汽油" },
  { value: "DIESEL", label: "柴油" },
];

function FuelSection(): React.ReactElement {
  const [sectionState, setSectionState] = useState<SectionState<FuelPriceVersionDto>>({
    kind: "loading",
  });
  const [fuelType, setFuelType] = useState<FuelType>("GASOLINE_92");
  const [pricePerLiter, setPricePerLiter] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSectionState({ kind: "loading" });
    try {
      const { versions } = await apiGetFuelPriceVersions();
      setSectionState({ kind: "ready", versions });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
        setSectionState({ kind: "permission-denied" });
      } else {
        setSectionState({
          kind: "error",
          message: apiErr.message ?? "載入失敗，請稍後重試。",
        });
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);
    try {
      await apiCreateFuelPriceVersion({ fuelType, pricePerLiter, effectiveFrom });
      setFormSuccess("油價版本建立成功。");
      setPricePerLiter("");
      setEffectiveFrom("");
      await load();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setFieldErrors(fErrs);
      } else if (apiErr.code === "PARAMETER_PERIOD_OVERLAP") {
        const conflictDate = getConflictVersionInfo(apiErr);
        if (conflictDate) {
          setFormError(`生效期間重疊，與版本（生效日：${conflictDate}）衝突，請調整生效日期。`);
        } else {
          setFormError(apiErr.message ?? "生效期間與現有版本重疊，請調整生效日期。");
        }
      } else {
        setFormError(apiErr.message ?? "建立失敗，請稍後再試。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="param-section" aria-labelledby="fuel-heading">
      <h2 id="fuel-heading">油資參數（油價）</h2>

      {/* Create form */}
      <div className="param-form-card">
        <h3>新增油價版本</h3>
        {formError && (
          <div className="error-block" role="alert">
            {formError}
          </div>
        )}
        {formSuccess && <output className="success-block">{formSuccess}</output>}
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="fuel-fuelType">油種 *</label>
            <select
              id="fuel-fuelType"
              value={fuelType}
              onChange={(e) => setFuelType(e.target.value as FuelType)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.fuelType ? "fuel-fuelType-err" : undefined}
            >
              {FUEL_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {fieldErrors.fuelType && (
              <span id="fuel-fuelType-err" className="field-error" role="alert">
                {fieldErrors.fuelType}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="fuel-pricePerLiter">每公升油價（元／公升）*</label>
            <input
              id="fuel-pricePerLiter"
              type="number"
              step="0.0001"
              min="0"
              value={pricePerLiter}
              onChange={(e) => setPricePerLiter(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.pricePerLiter ? "fuel-pricePerLiter-err" : undefined}
            />
            {fieldErrors.pricePerLiter && (
              <span id="fuel-pricePerLiter-err" className="field-error" role="alert">
                {fieldErrors.pricePerLiter}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="fuel-effectiveFrom">生效日期 *</label>
            <input
              id="fuel-effectiveFrom"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.effectiveFrom ? "fuel-effectiveFrom-err" : undefined}
            />
            {fieldErrors.effectiveFrom && (
              <span id="fuel-effectiveFrom-err" className="field-error" role="alert">
                {fieldErrors.effectiveFrom}
              </span>
            )}
          </div>
          <div className="btn-row">
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? "建立中…" : "建立"}
            </button>
          </div>
        </form>
      </div>

      {/* Version list — 依油種分組，各自時間軸可辨識（AC-29） */}
      <div className="param-list-card">
        <h3>歷史版本（依油種）</h3>
        {sectionState.kind === "loading" && (
          <div className="loading-block" aria-busy="true">
            <span className="spinner" aria-label="載入中" />
            <p>載入中…</p>
          </div>
        )}
        {sectionState.kind === "error" && (
          <div className="error-block" role="alert">
            <p>{sectionState.message}</p>
            <button type="button" className="btn btn-secondary" onClick={load}>
              重試
            </button>
          </div>
        )}
        {sectionState.kind === "permission-denied" && (
          <div className="permission-denied-block" role="alert">
            <p>無權限存取此資料。</p>
          </div>
        )}
        {sectionState.kind === "ready" && (
          <div className="fuel-price-groups">
            {FUEL_TYPE_OPTIONS.map((opt) => {
              const groupVersions = sectionState.versions.filter((v) => v.fuelType === opt.value);
              return (
                <div className="fuel-price-group" key={opt.value}>
                  <h4>{opt.label}</h4>
                  {groupVersions.length === 0 ? (
                    <div className="empty-block">
                      <p>尚未建立此油種的油價版本</p>
                    </div>
                  ) : (
                    <table className="param-table" aria-label={`${opt.label} 油價版本清單`}>
                      <thead>
                        <tr>
                          <th>生效日期</th>
                          <th className="num-col">每公升油價（元／公升）</th>
                          <th>建立時間</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupVersions.map((v) => (
                          <tr key={v.id}>
                            <td>{v.effectiveFrom}</td>
                            <td className="num-col">{v.pricePerLiter}</td>
                            <td>{formatDateYmd(v.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---- EtcSection ----

function EtcSection(): React.ReactElement {
  const [sectionState, setSectionState] = useState<SectionState<EtcParameterDto>>({
    kind: "loading",
  });
  const [unitPrice, setUnitPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSectionState({ kind: "loading" });
    try {
      const { versions } = await apiGetEtcVersions();
      setSectionState({ kind: "ready", versions });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
        setSectionState({ kind: "permission-denied" });
      } else {
        setSectionState({
          kind: "error",
          message: apiErr.message ?? "載入失敗，請稍後重試。",
        });
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);
    try {
      await apiCreateEtcVersion({ unitPrice, effectiveFrom });
      setFormSuccess("ETC 參數版本建立成功。");
      setUnitPrice("");
      setEffectiveFrom("");
      await load();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setFieldErrors(fErrs);
      } else if (apiErr.code === "PARAMETER_PERIOD_OVERLAP") {
        const conflictDate = getConflictVersionInfo(apiErr);
        if (conflictDate) {
          setFormError(`生效期間重疊，與版本（生效日：${conflictDate}）衝突，請調整生效日期。`);
        } else {
          setFormError(apiErr.message ?? "生效期間與現有版本重疊，請調整生效日期。");
        }
      } else {
        setFormError(apiErr.message ?? "建立失敗，請稍後再試。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="param-section" aria-labelledby="etc-heading">
      <h2 id="etc-heading">ETC 參數</h2>

      {/* Create form */}
      <div className="param-form-card">
        <h3>新增 ETC 參數版本</h3>
        {formError && (
          <div className="error-block" role="alert">
            {formError}
          </div>
        )}
        {formSuccess && <output className="success-block">{formSuccess}</output>}
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="etc-unitPrice">ETC 單價（元/公里）*</label>
            <input
              id="etc-unitPrice"
              type="number"
              step="0.0001"
              min="0"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.unitPrice ? "etc-unitPrice-err" : undefined}
            />
            {fieldErrors.unitPrice && (
              <span id="etc-unitPrice-err" className="field-error" role="alert">
                {fieldErrors.unitPrice}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="etc-effectiveFrom">生效日期 *</label>
            <input
              id="etc-effectiveFrom"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.effectiveFrom ? "etc-effectiveFrom-err" : undefined}
            />
            {fieldErrors.effectiveFrom && (
              <span id="etc-effectiveFrom-err" className="field-error" role="alert">
                {fieldErrors.effectiveFrom}
              </span>
            )}
          </div>
          <div className="btn-row">
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? "建立中…" : "建立"}
            </button>
          </div>
        </form>
      </div>

      {/* Version list */}
      <div className="param-list-card">
        <h3>歷史版本</h3>
        {sectionState.kind === "loading" && (
          <div className="loading-block" aria-busy="true">
            <span className="spinner" aria-label="載入中" />
            <p>載入中…</p>
          </div>
        )}
        {sectionState.kind === "error" && (
          <div className="error-block" role="alert">
            <p>{sectionState.message}</p>
            <button type="button" className="btn btn-secondary" onClick={load}>
              重試
            </button>
          </div>
        )}
        {sectionState.kind === "permission-denied" && (
          <div className="permission-denied-block" role="alert">
            <p>無權限存取此資料。</p>
          </div>
        )}
        {sectionState.kind === "ready" && sectionState.versions.length === 0 && (
          <div className="empty-block">
            <p>尚無任何 ETC 版本，請使用上方表單建立第一個版本。</p>
          </div>
        )}
        {sectionState.kind === "ready" && sectionState.versions.length > 0 && (
          <table className="param-table" aria-label="ETC 參數版本清單">
            <thead>
              <tr>
                <th>生效日期</th>
                <th className="num-col">每公里單價（元）</th>
                <th>建立時間</th>
              </tr>
            </thead>
            <tbody>
              {sectionState.versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.effectiveFrom}</td>
                  <td className="num-col">{v.unitPrice}</td>
                  <td>{formatDateYmd(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// ---- DepreciationSection ----

function DepreciationSection(): React.ReactElement {
  const [sectionState, setSectionState] = useState<SectionState<DepreciationParameterDto>>({
    kind: "loading",
  });
  const [vehiclePrice, setVehiclePrice] = useState("");
  const [usefulLifeYears, setUsefulLifeYears] = useState("");
  const [estimatedAnnualKm, setEstimatedAnnualKm] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSectionState({ kind: "loading" });
    try {
      const { versions } = await apiGetDepreciationVersions();
      setSectionState({ kind: "ready", versions });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "FORBIDDEN" || apiErr.code === "UNAUTHORIZED") {
        setSectionState({ kind: "permission-denied" });
      } else {
        setSectionState({
          kind: "error",
          message: apiErr.message ?? "載入失敗，請稍後重試。",
        });
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);
    try {
      await apiCreateDepreciationVersion({
        vehiclePrice,
        usefulLifeYears: Number(usefulLifeYears),
        estimatedAnnualKm: Number(estimatedAnnualKm),
        effectiveFrom,
      });
      setFormSuccess("折舊參數版本建立成功。");
      setVehiclePrice("");
      setUsefulLifeYears("");
      setEstimatedAnnualKm("");
      setEffectiveFrom("");
      await load();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === "VALIDATION_ERROR" && apiErr.fields && apiErr.fields.length > 0) {
        const fErrs: Record<string, string> = {};
        for (const f of apiErr.fields) {
          fErrs[f.field] = f.reason;
        }
        setFieldErrors(fErrs);
      } else if (apiErr.code === "PARAMETER_PERIOD_OVERLAP") {
        const conflictDate = getConflictVersionInfo(apiErr);
        if (conflictDate) {
          setFormError(`生效期間重疊，與版本（生效日：${conflictDate}）衝突，請調整生效日期。`);
        } else {
          setFormError(apiErr.message ?? "生效期間與現有版本重疊，請調整生效日期。");
        }
      } else {
        setFormError(apiErr.message ?? "建立失敗，請稍後再試。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="param-section" aria-labelledby="depreciation-heading">
      <h2 id="depreciation-heading">折舊參數</h2>

      {/* Create form */}
      <div className="param-form-card">
        <h3>新增折舊參數版本</h3>
        {formError && (
          <div className="error-block" role="alert">
            {formError}
          </div>
        )}
        {formSuccess && <output className="success-block">{formSuccess}</output>}
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="dep-vehiclePrice">車價（元）*</label>
            <input
              id="dep-vehiclePrice"
              type="number"
              step="0.01"
              min="0.01"
              value={vehiclePrice}
              onChange={(e) => setVehiclePrice(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.vehiclePrice ? "dep-vehiclePrice-err" : undefined}
            />
            {fieldErrors.vehiclePrice && (
              <span id="dep-vehiclePrice-err" className="field-error" role="alert">
                {fieldErrors.vehiclePrice}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="dep-usefulLifeYears">折舊年限（年）*</label>
            <input
              id="dep-usefulLifeYears"
              type="number"
              step="1"
              min="1"
              value={usefulLifeYears}
              onChange={(e) => setUsefulLifeYears(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.usefulLifeYears ? "dep-usefulLifeYears-err" : undefined}
            />
            {fieldErrors.usefulLifeYears && (
              <span id="dep-usefulLifeYears-err" className="field-error" role="alert">
                {fieldErrors.usefulLifeYears}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="dep-estimatedAnnualKm">預估年度行駛公里數（公里）*</label>
            <input
              id="dep-estimatedAnnualKm"
              type="number"
              step="1"
              min="1"
              value={estimatedAnnualKm}
              onChange={(e) => setEstimatedAnnualKm(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={
                fieldErrors.estimatedAnnualKm ? "dep-estimatedAnnualKm-err" : undefined
              }
            />
            {fieldErrors.estimatedAnnualKm && (
              <span id="dep-estimatedAnnualKm-err" className="field-error" role="alert">
                {fieldErrors.estimatedAnnualKm}
              </span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="dep-effectiveFrom">生效日期 *</label>
            <input
              id="dep-effectiveFrom"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              disabled={submitting}
              required
              aria-describedby={fieldErrors.effectiveFrom ? "dep-effectiveFrom-err" : undefined}
            />
            {fieldErrors.effectiveFrom && (
              <span id="dep-effectiveFrom-err" className="field-error" role="alert">
                {fieldErrors.effectiveFrom}
              </span>
            )}
          </div>
          <div className="btn-row">
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? "建立中…" : "建立"}
            </button>
          </div>
        </form>
      </div>

      {/* Version list */}
      <div className="param-list-card">
        <h3>歷史版本</h3>
        {sectionState.kind === "loading" && (
          <div className="loading-block" aria-busy="true">
            <span className="spinner" aria-label="載入中" />
            <p>載入中…</p>
          </div>
        )}
        {sectionState.kind === "error" && (
          <div className="error-block" role="alert">
            <p>{sectionState.message}</p>
            <button type="button" className="btn btn-secondary" onClick={load}>
              重試
            </button>
          </div>
        )}
        {sectionState.kind === "permission-denied" && (
          <div className="permission-denied-block" role="alert">
            <p>無權限存取此資料。</p>
          </div>
        )}
        {sectionState.kind === "ready" && sectionState.versions.length === 0 && (
          <div className="empty-block">
            <p>尚無任何折舊版本，請使用上方表單建立第一個版本。</p>
          </div>
        )}
        {sectionState.kind === "ready" && sectionState.versions.length > 0 && (
          <div className="table-scroll">
            <table className="param-table" aria-label="折舊參數版本清單">
              <thead>
                <tr>
                  <th>生效日期</th>
                  <th className="num-col">車價（元）</th>
                  <th className="num-col">折舊年限（年）</th>
                  <th className="num-col">預估年里程（公里）</th>
                  <th className="num-col">每年折舊費用（元）</th>
                  <th className="num-col">每公里單價（元）</th>
                  <th>建立時間</th>
                </tr>
              </thead>
              <tbody>
                {sectionState.versions.map((v) => (
                  <tr key={v.id}>
                    <td>{v.effectiveFrom}</td>
                    <td className="num-col">{v.vehiclePrice}</td>
                    <td className="num-col">{v.usefulLifeYears}</td>
                    <td className="num-col">{v.estimatedAnnualKm}</td>
                    {/* derived — displayed from backend response, NOT calculated by frontend (AC-20) */}
                    <td className="num-col">{v.derived.annualDepreciation}</td>
                    <td className="num-col">{v.derived.perKmUnitPrice}</td>
                    <td>{formatDateYmd(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- Main page ----

export default function ParametersPage(): React.ReactElement {
  const { authState } = useAuth();

  // Permission check: only ADMIN can access this page (AC-16, AC-20)
  if (authState.status === "loading") {
    return (
      <div className="page-container">
        <div className="loading-block" aria-busy="true">
          <span className="spinner" aria-label="載入中" />
          <p>載入中…</p>
        </div>
      </div>
    );
  }

  if (
    authState.status === "unauthenticated" ||
    (authState.status === "authenticated" && authState.user.role !== "ADMIN")
  ) {
    return (
      <div className="page-container">
        <div className="permission-denied-block" role="alert">
          <h2>存取被拒</h2>
          <p>您沒有權限存取補助參數維護頁面。</p>
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>補助參數維護</h1>
        <div className="header-actions">
          <Link to="/" className="btn btn-secondary">
            返回首頁
          </Link>
        </div>
      </header>

      <main className="page-main">
        <FuelSection />
        <EtcSection />
        <DepreciationSection />
      </main>
    </div>
  );
}
