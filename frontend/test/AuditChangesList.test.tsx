/**
 * AuditChangesList 元件單元測試 — PHASE-010-T6
 *
 * 涵蓋 AC-18(a)(b)(c)（呈現安全；§12 三列預定測試名逐字對應）＋ D3=(c) 中文
 * 欄名對照（§18 Gate 固化，T3 即審 FW-5／T1 即審 FW-4／T1 即審 FW-5 三項上游
 * FW 義務）。本檔為 AuditChangesList 之**唯一**測試檔——AC-18(b) 之
 * `[object Object]` 負向守門依 Spec §11.0 紀律 6／PHASE-009 T15c FW 前端
 * 自帶，不倚賴 `backend/test/unit/audit-summary-flatten.test.ts`（僅借用其
 * 真實 fixture 之值以貼近真實資料，見下方 FUEL_CONSUMPTION_NESTED_CHANGES）。
 *
 * 範圍界定：本元件只吃 `changes: AuditChangeDto[]`，不接收 `targetLabel`
 * （T7 之 `AuditLogPage` 渲染該欄位處另行涵蓋，見 `AuditChangesList.tsx`
 * 檔頭「範圍界定」段落）。
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuditChangesList from "../src/components/AuditChangesList.js";
import type { AuditChangeDto } from "../src/types/api.js";

/**
 * 真實 fixture：`USER_FUEL_CONSUMPTION_VERSION_CREATED` 巢狀混合形，逐值抄錄
 * 自 `backend/test/unit/audit-summary-flatten.test.ts` 之 `FUEL_CONSUMPTION_NESTED`
 * ── 經後端 `flattenAuditSummary` 之真實輸出形狀：頂層 `before`／`after` 各自
 * 為物件，已由後端 `JSON.stringify` 字串化；`basisNote` 為純量字串
 * （AC-06(f) 之最高密度案例；T3 即審 FW-6：以真實字串長度為 fixture，非短純量）。
 */
const FUEL_CONSUMPTION_NESTED_CHANGES: AuditChangeDto[] = [
  {
    field: "before",
    before: null,
    after: '{"fuelType":"GASOLINE_95","kmPerLiter":"12.3400","effectiveFrom":"2026-01-01"}',
  },
  {
    field: "after",
    before: null,
    after: '{"fuelType":"GASOLINE_98","kmPerLiter":"13.5000","effectiveFrom":"2026-08-01"}',
  },
  { field: "basisNote", before: null, after: "原廠油耗數據（合成資料）" },
];

/** Spec §16 D3／PHASE-010-T6 Packet FW-5：T3 已實證推上 wire 之 17 個真實頂層鍵。 */
const REQUIRED_17_FIELDS = [
  "applicationId",
  "type",
  "reason",
  "voidedAt",
  "revisionOf",
  "tripDate",
  "purpose",
  "before",
  "after",
  "basisNote",
  "parameterType",
  "isActive",
  "mustChangePassword",
  "role",
  "employeeNumber",
  "deletedLoginName",
  "deletedDisplayName",
];

describe("AuditChangesList", () => {
  describe("AC-18: 呈現安全", () => {
    it("AC-18(a): XSS payload 三型跳脫；DOM 零新增 script 節點", () => {
      const scriptPayload = "<script>document.title = 'xss-1'</script>";
      const imgOnerrorPayload = '"><img src=x onerror="document.title = \'xss-2\'">';
      const javascriptUriPayload = "javascript:document.title = 'xss-3'";

      const changes: AuditChangeDto[] = [
        { field: "reason", before: null, after: scriptPayload },
        { field: "purpose", before: null, after: imgOnerrorPayload },
        { field: "basisNote", before: null, after: javascriptUriPayload },
      ];

      const scriptCountBefore = document.querySelectorAll("script").length;
      render(<AuditChangesList changes={changes} />);

      // 正向：三種 payload 皆逐字以純文字節點呈現（未被解析為標籤／屬性）
      expect(screen.getByText(scriptPayload)).toBeInTheDocument();
      expect(screen.getByText(imgOnerrorPayload)).toBeInTheDocument();
      expect(screen.getByText(javascriptUriPayload)).toBeInTheDocument();

      // 負向：全頁 DOM 無新增 <script> 節點；無新增 <img>／<a> 元素
      expect(document.querySelectorAll("script").length).toBe(scriptCountBefore);
      expect(document.querySelectorAll("img").length).toBe(0);
      expect(document.querySelectorAll("a").length).toBe(0);
      // 標題未被竄改（若 payload 真被執行，document.title 會變成 xss-1/2/3）
      expect(document.title).not.toMatch(/^xss-/);
    });

    it("AC-18(b): 巢狀混合 summary 渲染零 [object Object]（前端自帶負向）", () => {
      const { container } = render(<AuditChangesList changes={FUEL_CONSUMPTION_NESTED_CHANGES} />);

      // 負向：全渲染結果零 "[object Object]"（前端自帶，不倚賴後端測試）
      expect(container.textContent).not.toContain("[object Object]");

      // 正向：巢狀物件已字串化之 JSON 內容逐字可見
      expect(
        screen.getByText(
          '{"fuelType":"GASOLINE_95","kmPerLiter":"12.3400","effectiveFrom":"2026-01-01"}'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          '{"fuelType":"GASOLINE_98","kmPerLiter":"13.5000","effectiveFrom":"2026-08-01"}'
        )
      ).toBeInTheDocument();
      expect(screen.getByText("原廠油耗數據（合成資料）")).toBeInTheDocument();
    });

    it("AC-18(c): 時間在地化單一形式；同頁不並存 ISO 原字串", () => {
      const isoVoidedAt = "2026-08-09T03:21:00.000Z";
      const changes: AuditChangeDto[] = [
        { field: "voidedAt", before: null, after: isoVoidedAt },
        // 純日期字串（無時間成分）不屬本條守門對象，逐字顯示，不做在地化轉換。
        { field: "tripDate", before: null, after: "2026-08-01" },
      ];

      render(<AuditChangesList changes={changes} />);

      // 負向：完整 ISO 時間原字串不得逐字出現在畫面（同頁不並存兩形式）
      expect(screen.queryByText(isoVoidedAt)).not.toBeInTheDocument();

      // 正向：改以與既有「計算時間」同型之台北在地化字串呈現（不硬編字面，
      // 避免主機時區／ICU 資料相依——比照 ReportSection.test.tsx 既有寫法）。
      expect(
        screen.getByText(new Date(isoVoidedAt).toLocaleString("zh-TW").replace(/\s+/g, " ").trim())
      ).toBeInTheDocument();

      // 純日期字串維持原字面（非本條守門對象，不應被誤轉換）
      expect(screen.getByText("2026-08-01")).toBeInTheDocument();
    });
  });

  describe("D3=(c): 中文欄名對照（§18 Gate 固化）", () => {
    it("中文對照表涵蓋 T3 實證之 17 個真實 summary 頂層鍵，逐鍵顯示中文標籤（非原始英文鍵名）", () => {
      const changes: AuditChangeDto[] = REQUIRED_17_FIELDS.map((field) => ({
        field,
        before: null,
        after: "x",
      }));

      render(<AuditChangesList changes={changes} />);

      // 逐鍵：畫面上不得出現原始英文鍵名字面（已被翻譯覆蓋，非缺表回退）
      for (const field of REQUIRED_17_FIELDS) {
        expect(screen.queryByText(field)).not.toBeInTheDocument();
      }
    });

    it("缺表鍵不得崩、不得空白——回退顯示原始英文鍵名（可接受回退）", () => {
      const changes: AuditChangeDto[] = [
        { field: "unmappedFutureField", before: null, after: "value" },
      ];

      expect(() => render(<AuditChangesList changes={changes} />)).not.toThrow();
      expect(screen.getByText("unmappedFutureField")).toBeInTheDocument();
      expect(screen.getByText("value")).toBeInTheDocument();
    });

    it('before/after 同名陷阱：field="before"／"after" 之中文標籤不得與表頭「改前」／「改後」同名（T1 即審 FW-4）', () => {
      render(<AuditChangesList changes={FUEL_CONSUMPTION_NESTED_CHANGES} />);

      // 表頭固定為「欄位」／「改前」／「改後」三欄
      expect(screen.getByRole("columnheader", { name: "欄位" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "改前" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "改後" })).toBeInTheDocument();

      // field="before"／"after" 之「欄位」欄中文標籤不得逐字等於「改前」／「改後」
      // ——否則會與表頭同名，讀者會誤讀成「欄位＝改前」。
      expect(screen.queryByRole("cell", { name: "改前" })).not.toBeInTheDocument();
      expect(screen.queryByRole("cell", { name: "改後" })).not.toBeInTheDocument();
    });

    it("isActive（USER_DEACTIVATED／USER_ACTIVATED 之 {from,to} 兩鍵物件）在對照表中且缺表不崩（T1 即審 FW-5）", () => {
      const changes: AuditChangeDto[] = [
        { field: "isActive", before: null, after: '{"from":true,"to":false}' },
      ];

      render(<AuditChangesList changes={changes} />);

      expect(screen.queryByText("isActive")).not.toBeInTheDocument();
      expect(screen.getByText('{"from":true,"to":false}')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("[object Object]");
    });
  });
});
