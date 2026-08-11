/**
 * Unit test: PHASE-011-T7 — Session Cookie 選項之純函式守門
 * （`docs/specs/PHASE-011.md` **AC-09(a)(b)(c)**、**AC-10(a)** 之單元面；
 * §16 **D7**=(a)「維持現況並釘死」、**D8**=(a)「不信任反向代理標頭」）
 *
 * ---------------------------------------------------------------------------
 * 本檔存在的理由（Spec §16 D7 逐字：「本 AC 之價值在於『從此不可退化』」）
 * ---------------------------------------------------------------------------
 * 本 Task **零行為變更**：production 之 Cookie 屬性集在 PHASE-002 即已是
 * `HttpOnly ∧ SameSite=Lax ∧ Path=/ ∧ Secure`。缺的是**守門**——實查至本
 * Task 開工為止，`auth.test.ts` :350 只覆蓋 **non-production** 分支，
 * production 分支**無任何測試覆蓋**，任何人拿掉 `secure` 或 `httpOnly` 都不會
 * 有一格轉紅。本檔以 `toEqual` 做**封閉**比對（多一屬性／少一屬性皆必紅），
 * 把現況釘死。
 *
 * ---------------------------------------------------------------------------
 * 為何是單元測試而非「設定 NODE_ENV=production 後跑整合測試」
 * ---------------------------------------------------------------------------
 * Spec §11.0 #5 逐字禁止：「亦**不得**設定 `NODE_ENV=production`（會撞
 * `global-setup.ts` :304 護欄）——production 分支一律以**參數注入**測試
 * （AC-09(a) 已釘死此形狀）」。`buildCookieOptions`／`buildClearCookieOptions`
 * 以 `isProduction` 為**參數**（非讀 `process.env`），故 production 分支可被
 * 直接呼叫覆蓋。本檔全程**零 `process.env` 讀寫**。
 *
 * ---------------------------------------------------------------------------
 * 涵蓋
 * ---------------------------------------------------------------------------
 *   · **AC-09(a)** 兩具 builder 為純函式（同輸入同輸出、不依賴 `process.env`）；
 *   · **AC-09(b)** `isProduction=true` 之屬性集 `toEqual` 封閉（多一／少一必紅）；
 *   · **AC-09(c)** `isProduction=false` 逐字同既有 `AC-28`
 *     （`HttpOnly` ∧ `SameSite=Lax` ∧ `Path=/` ∧ **無** `Secure`）；
 *   · **AC-10(a)** 之單元面：安全連線判定之**單一來源** `resolveSecureCookies`
 *     ——僅依 `NODE_ENV`，且測試注入之 `forceSecureCookies` 為**單向加嚴**
 *     （`production` 下傳 `false` **不得**把 `Secure` 關掉；防「注入點成為
 *     正式環境的降級後門」）。
 *
 * wire 面（`Set-Cookie` 標頭）與代理標頭偽造之驗證於
 * `test/integration/phase11-cookie-proxy.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClearCookieOptions,
  buildCookieOptions,
  resolveSecureCookies,
} from "../../src/auth/routes.js";

// 固定時鐘：`buildCookieOptions` 之 `maxAge` 由 `expiresAt - Date.now()` 導出，
// 不固定時鐘則 `toEqual` 之封閉比對會因毫秒漂移而偶紅（floor 邊界）。
const FIXED_NOW = new Date("2026-08-12T00:00:00.000Z");
const TTL_HOURS = 8;
const EXPIRES_AT = new Date(FIXED_NOW.getTime() + TTL_HOURS * 60 * 60 * 1000);
const EXPECTED_MAX_AGE = TTL_HOURS * 60 * 60; // 28800

describe("PHASE-011-T7 — AC-09: Cookie 安全屬性（§16 D7=(a) 封閉守門）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) 兩具 builder 為純函式：以 isProduction 為參數、同輸入同輸出", () => {
    // 同一組輸入呼叫兩次 → 深度相等（無隱藏狀態、無 process.env 讀取）。
    const first = buildCookieOptions(EXPIRES_AT, "sid", true);
    const second = buildCookieOptions(EXPIRES_AT, "sid", true);
    expect(first).toEqual(second);

    const firstClear = buildClearCookieOptions(true);
    const secondClear = buildClearCookieOptions(true);
    expect(firstClear).toEqual(secondClear);

    // production 分支之取得**不需要**設定 process.env.NODE_ENV（Spec §11.0 #5）：
    // 兩個分支在同一個測試行程內、同一時刻皆可取得，且結果相異。
    expect(buildCookieOptions(EXPIRES_AT, "sid", true)).not.toEqual(
      buildCookieOptions(EXPIRES_AT, "sid", false)
    );
  });

  it("(b) isProduction=true 之屬性集 toEqual 封閉（多一／少一必紅）", () => {
    // ★ 封閉比對 ★ —— 這一格是本 Task 的核心守門：
    //   · 少一屬性（例如有人拿掉 `secure` 或 `httpOnly`）→ 必紅；
    //   · 多一屬性（例如有人偷加 `domain`／改 `sameSite`）→ 必紅。
    // 屬性集之來源：§16 D7=(a)「維持現況並釘死：HttpOnly ∧ SameSite=Lax ∧
    // Path=/ ∧ Secure」。
    expect(buildCookieOptions(EXPIRES_AT, "sid", true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      maxAge: EXPECTED_MAX_AGE,
    });
  });

  it("(b) clear-cookie 之 production 屬性集同樣封閉（maxAge=0，其餘逐項相同）", () => {
    // 登出所清的 Cookie 必須帶**與寫入時相同**的屬性，否則瀏覽器可能不視為
    // 同一個 Cookie 而清不掉（殘留可用 session cookie 是實質安全缺口）。
    expect(buildClearCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      maxAge: 0,
    });
  });

  it("(c) isProduction=false 逐字同既有 AC-28：HttpOnly ∧ SameSite=Lax ∧ Path=/ ∧ 無 Secure", () => {
    // 非 production 行為**不得**因本 Phase 改變（Spec AC-09(c)：開發環境為
    // HTTP，若加上 Secure 則瀏覽器不會回送 Cookie，登入將整體失效）。
    // `secure: false` 於 @fastify/cookie 序列化時不輸出 `Secure` 屬性——wire
    // 面之「無 Secure」由 auth.test.ts :350（零改動）與本 Phase 之
    // phase11-cookie-proxy.test.ts 背書。
    expect(buildCookieOptions(EXPIRES_AT, "sid", false)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
      maxAge: EXPECTED_MAX_AGE,
    });

    expect(buildClearCookieOptions(false)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
      maxAge: 0,
    });
  });

  it("(b) maxAge 由 expiresAt 導出（非寫死常數）", () => {
    // 防「屬性集釘死」被誤實作成整包硬編碼字面值——換一個 expiresAt 必須換一個
    // maxAge，其餘屬性不動。
    const shorter = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    expect(buildCookieOptions(shorter, "sid", true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      maxAge: 3600,
    });
  });
});

describe("PHASE-011-T7 — AC-10(a): 安全連線判定之單一來源（§16 D8=(a)）", () => {
  it("僅依 NODE_ENV 判定：production → true，其餘 → false", () => {
    expect(resolveSecureCookies("production")).toBe(true);
    expect(resolveSecureCookies("development")).toBe(false);
    expect(resolveSecureCookies("test")).toBe(false);
  });

  it("測試注入之 forceSecureCookies 為單向加嚴：可開不可關", () => {
    // ↑ 這一格守的是**注入點本身**的安全性質。AC-09(d) 之 wire 面驗證需要一個
    // 「不改 NODE_ENV 也能取得 production Cookie 行為」的注入點（Spec §11.0 #5
    // 強制），而任何注入點都同時是潛在後門：若實作寫成
    // `isProduction = options.forceSecureCookies ?? (env.NODE_ENV === "production")`，
    // 則正式環境下任何傳入 `false` 的呼叫端都會**靜默關閉 Secure**。
    // 故實作必須是布林或（`||`）而非覆寫（`??`），此格即其守門。

    // 加嚴：非 production 環境注入 true → 取得 production 行為（測試用）
    expect(resolveSecureCookies("development", true)).toBe(true);
    expect(resolveSecureCookies("test", true)).toBe(true);

    // ★ 不可放寬 ★：production 環境傳入 false → 仍為 true
    expect(resolveSecureCookies("production", false)).toBe(true);
    expect(resolveSecureCookies("production", undefined)).toBe(true);

    // 未注入時之非 production 行為不變
    expect(resolveSecureCookies("development", false)).toBe(false);
    expect(resolveSecureCookies("development", undefined)).toBe(false);
  });

  it("buildCookieOptions 之 secure 恰為 resolveSecureCookies 之輸出（兩者不得各自為政）", () => {
    for (const nodeEnv of ["production", "development", "test"] as const) {
      for (const force of [undefined, true, false] as const) {
        const expected = resolveSecureCookies(nodeEnv, force);
        const options = buildCookieOptions(EXPIRES_AT, "sid", expected);
        expect(options.secure).toBe(expected);
        expect(buildClearCookieOptions(expected).secure).toBe(expected);
      }
    }
  });
});
