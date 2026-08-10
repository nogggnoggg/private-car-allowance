/**
 * `errorLabel` — 零內容之錯誤標籤（單一葉節點模組）
 *
 * PHASE-010-T10／AC-22(b)（§16 D7）：收斂 `KNOWN_ISSUES.md` §3 D-3 登記之
 * 同形重複實作。本模組**無任何專案內部相依**（葉節點），故可被任何層級匯入
 * 而不製造迴圈。
 *
 * ---------------------------------------------------------------------------
 * 用途與紀律
 * ---------------------------------------------------------------------------
 * 只取錯誤的**類別名稱**，**不含訊息**。理由（PHASE-009 AC-38／AR-7 之修復根
 * 據，逐字沿用原兩份實作之檔內說明）：storage／fs 層之錯誤訊息**逐字含
 * storage key 與絕對路徑**（`LocalVolumeStorage` 自拋之
 * `Storage key not found: "att/…/original"`、`fs` 之
 * `EPERM: operation not permitted, unlink '<root>/att/…'`），而
 * `sanitizeForLog` 只遮蔽連線字串與 `password=` 形式之憑證，**不會**遮蔽
 * storage key 或絕對路徑。故補償刪檔與非預期錯誤等路徑一律只記本函式之標
 * 籤，不記 `err.message`。
 *
 * ---------------------------------------------------------------------------
 * 收斂範圍（實查結果；與 D-3 之「三份同形實作」措辭之差異已交審）
 * ---------------------------------------------------------------------------
 * 實際重複者為**兩份逐字相同**之 `function errorLabel`：
 *   · `attachment/attachment-copy.ts`（PHASE-009-T6 引入）
 *   · `attachment/upload-service.ts`（PHASE-009-T18 引入）
 * 兩者已改為匯入本模組。
 *
 * `platform/health.ts` 之 `errName: err instanceof Error ? err.name : "UnknownError"`
 * **不**納入收斂——它並非同形實作：本模組取 `err.constructor.name`，health 探
 * 針取 `err.name`，兩者對「未自行設定 `name` 之 Error 子類」回傳不同值
 * （`class Foo extends Error {}` → `name === "Error"`、
 * `constructor.name === "Foo"`）。改用本模組將改變該探針之日誌值，屬**行為變
 * 更**，牴觸 AC-22(b) 同句之「三處呼叫端行為零變更」硬約束，故維持原樣。
 * 同理，`platform/error-handler.ts` 之 `errName: error.name` 亦屬 `err.name`
 * 慣例，不在本模組之收斂範圍。兩者與本模組同屬「零內容標籤」之**慣例家族**
 * （`upload-service.ts` 原檔頭所稱之「同型」即指此），但非同一實作。
 */

/**
 * 取錯誤之類別名稱作為零內容日誌標籤；非 `Error` 者回 `"UnknownError"`。
 *
 * 行為與收斂前之兩份實作**逐字相同**（`err.constructor.name`），故三處呼叫
 * 端之日誌輸出零變更。
 */
export function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return "UnknownError";
}
