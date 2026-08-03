/**
 * CHORE-003-T3 — AC-29 字串路徑保真且不經浮點中介（AR-5 閉環）
 *
 * PHASE-003a Spec §14.5 AC-29：
 *   Given 同一數值之字串與等值 number 兩種輸入 → Then 兩者存入與回傳之 DTO
 *   完全相同；且**字串路徑之程式路徑上不存在 `Number(...)` 對輸入的呼叫**。
 *
 * ---------------------------------------------------------------------------
 * 鑑別力來源：**結構性靜態斷言**（AC-29 明列的第一個選項）
 * ---------------------------------------------------------------------------
 * AC-29 明文警告「單純比較兩路徑結果無鑑別力（現行實作亦會通過）」，並要求
 * implementer 明確選定鑑別方式。本檔選 **結構性靜態斷言**，理由是另一選項
 * （行為鑑別：找一個「僅字串可表達、`Number()` 會失真」的值）在本回合的欄位
 * 容量內**不存在**——AR-5 的原判定「不可觀測」在此以 §3 的可執行證據段落
 * 就地實證，而非僅以文字宣稱：
 *
 *   - `unitPrice` 為 `Decimal(10, 4)`：|v| < 1e6 且 ≤4 位小數 ⇒ 最多 10 位
 *     有效數字；`vehiclePrice` 為 `Decimal(12, 2)`：|v| < 1e10 且 ≤2 位小數
 *     ⇒ 最多 12 位有效數字。
 *   - IEEE-754 double 對 ≤15 位有效十進位數字保證「最短往返」無損，故
 *     `new Decimal(String(Number(s)))` 與 `new Decimal(s)` 在**兩個欄位的容量
 *     上界（`"999999.9999"` / `"9999999999.99"`）都仍逐字元相同**。
 *   - 亦即：即使有人把 `Number()` 中介塞回字串路徑，也**無法**用任何合法輸入
 *     的存入值差異察覺 ⇒ 行為鑑別不可行 ⇒ 必須採結構性斷言。
 *
 * 結構性斷言的鑑別力本身以兩種方式自證：
 *   (i) §1 最後一條「掃描器自證」：把「舊實作」的合成程式碼片段餵給同一組
 *       掃描器，必須被抓出；並確認註解／字串字面中的 `Number(` **不會**被誤報
 *       （證明斷言既非恆真、也非恆假）。
 *   (ii) Task Handoff 記錄之 mutant 實測：在 `createFuelVersion` 還原
 *       `Number(input.unitPrice)` 後本檔 §1 轉紅，還原後轉綠。
 *
 * ---------------------------------------------------------------------------
 * 隔離：
 *   - `effectiveFrom` 哨兵區間 **2096-01-* / 2096-02-* / 2096-03-***（全套檢索
 *     顯示 2096 年未被任何既有測試使用；2097 為 T2、2098／2099 為
 *     chore002／phase3a 所佔）。清理僅針對該區間，無全域 `deleteMany`。
 *   - 合成資料，無真實個資／密碼／secrets。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "../../src/db/prisma.js";
import {
  createDepreciationVersion,
  createEtcVersion,
  createFuelVersion,
} from "../../src/parameters/parameter-service.js";

const DB_URL = process.env.DATABASE_URL;
const describeWithDb = DB_URL ? describe : describe.skip;

const SUFFIX = Date.now();
const CREATED_BY = `chore003_t3_actor_${SUFFIX}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARAMETERS_SRC_DIR = path.resolve(__dirname, "..", "..", "src", "parameters");

// ---------------------------------------------------------------------------
// 靜態掃描工具
// ---------------------------------------------------------------------------

/**
 * 將註解與字串／樣板字面「挖空」為等長空白（換行保留），使後續的語彙掃描
 * 只看得到**真正的程式碼**。
 *
 * 若不挖空，本回合的 `parameter-service.ts` 註解本身就含有
 * 「這一步取代了原本的 `Number(input.unitPrice)`」這類文字，會造成偽陽性；
 * 反之，把註解一併當成程式碼掃描則會讓斷言永遠紅、失去意義。
 *
 * 已知限制：不解析 regex 字面（本目錄現有的兩個 regex 均不含引號或 `//`
 * 序列，故不影響結果）。§1 的「掃描器自證」與下方 sanity 檢查會在此假設
 * 被打破時察覺。
 */
function blankCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += blank(src[i]);
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 由「已挖空註解／字串」的程式碼中，取出某個具名函式的**函式體**（含大括號），
 * 以大括號配對切出——挖空後不會有落在字串／註解中的假括號。
 */
function extractFunctionBody(blankedCode: string, functionName: string): string {
  const signature = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(blankedCode);
  if (!match) throw new Error(`function not found in source: ${functionName}`);
  const braceStart = blankedCode.indexOf("{", match.index + match[0].length);
  if (braceStart < 0) throw new Error(`function body not found: ${functionName}`);
  let depth = 0;
  for (let i = braceStart; i < blankedCode.length; i++) {
    if (blankedCode[i] === "{") depth++;
    else if (blankedCode[i] === "}") {
      depth--;
      if (depth === 0) return blankedCode.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces in function: ${functionName}`);
}

/**
 * 找出「對值做強制轉型」的呼叫：`Number(...)`／`parseFloat(...)`／`parseInt(...)`。
 *
 * `\bNumber\s*\(` **不會**匹配 `Number.isFinite(` / `Number.isInteger(`
 * （其後為 `.` 而非 `(`）——那兩者是既有整數值域層對 `usefulLifeYears`／
 * `estimatedAnnualKm`（`number` 型別欄位）的述詞判定，不是對金額輸入的轉型，
 * 依 AC-29 不在禁止範圍內。
 */
const COERCION_CALL_PATTERN = /\b(Number|parseFloat|parseInt)\s*\(([^)]*)\)/g;

function findCoercionCalls(blankedCode: string): string[] {
  return [...blankedCode.matchAll(COERCION_CALL_PATTERN)].map((m) => `${m[1]}(${m[2].trim()})`);
}

function readBlankedSource(fileName: string): string {
  return blankCommentsAndStrings(fs.readFileSync(path.join(PARAMETERS_SRC_DIR, fileName), "utf8"));
}

// ---------------------------------------------------------------------------
// §1 結構性斷言：字串路徑上不存在 Number(...) 對輸入的呼叫（AC-29 核心鑑別）
// ---------------------------------------------------------------------------

describe("CHORE-003-T3 §1 AC-29 結構性斷言：金額字串路徑無 Number() 中介", () => {
  const serviceBlanked = readBlankedSource("parameter-service.ts");
  const validationBlanked = readBlankedSource("parameter-validation.ts");

  it("掃描 sanity：挖空後仍保有可辨識的程式碼骨架（確保不是掃到空字串而空跑）", () => {
    expect(serviceBlanked).toContain("export async function createFuelVersion");
    expect(serviceBlanked).toContain("parseParameterDecimalField");
    expect(validationBlanked).toContain("export function parseParameterDecimalField");
    // 挖空後不應再看到只存在於註解／字串中的中文文案
    expect(validationBlanked).not.toContain("必須為有效的十進位數值");
  });

  it("parameter-validation.ts（金額輸入的唯一格式層）全檔無任何 Number()/parseFloat/parseInt 轉型", () => {
    expect(findCoercionCalls(validationBlanked)).toEqual([]);
  });

  it("三個建立路徑的函式體內，對金額輸入無任何 Number()/parseFloat/parseInt 轉型", () => {
    for (const fn of ["createFuelVersion", "createEtcVersion", "createDepreciationVersion"]) {
      const body = extractFunctionBody(serviceBlanked, fn);
      expect({ fn, coercions: findCoercionCalls(body) }).toEqual({ fn, coercions: [] });
    }
  });

  it("parameter-service.ts 全檔僅存的 Number() 呼叫為 parseUtcDate 的日期分段（與金額輸入無關）", () => {
    // 全檔白名單：任何新增的轉型呼叫（含把 Number(input.unitPrice) 改寫回來）
    // 都會讓這個集合改變而使本條轉紅。
    expect(findCoercionCalls(serviceBlanked)).toEqual([
      "Number(yStr)",
      "Number(mStr)",
      "Number(dStr)",
    ]);
    const parseUtcDateBody = extractFunctionBody(serviceBlanked, "parseUtcDate");
    expect(findCoercionCalls(parseUtcDateBody)).toEqual([
      "Number(yStr)",
      "Number(mStr)",
      "Number(dStr)",
    ]);
  });

  it("src/parameters/** 已無 `priceNum` 這個舊中介變數（CHORE-002 S-3 機制已消失）", () => {
    const offenders = fs
      .readdirSync(PARAMETERS_SRC_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        /\bpriceNum\b/.test(
          blankCommentsAndStrings(fs.readFileSync(path.join(PARAMETERS_SRC_DIR, f), "utf8"))
        )
      );
    expect(offenders).toEqual([]);
  });

  it("掃描器自證（鑑別力）：舊實作片段必被抓到；註解／字串中的 Number( 必不誤報", () => {
    const oldImplementation = blankCommentsAndStrings(
      [
        "function createFuelVersion(input) {",
        "  const priceNum = Number(input.unitPrice);",
        "  return new Prisma.Decimal(toDecimalConstructorArg(priceNum));",
        "}",
      ].join("\n")
    );
    // (a) 非恆真：真的有轉型時抓得到
    expect(findCoercionCalls(oldImplementation)).toEqual(["Number(input.unitPrice)"]);
    expect(/\bpriceNum\b/.test(oldImplementation)).toBe(true);

    // (b) 非恆假：只出現在註解／字串字面時不誤報
    const commentOnly = blankCommentsAndStrings(
      [
        "// 這一步取代了原本的 Number(input.unitPrice)",
        "/* 舊路徑：const priceNum = Number(x); */",
        'const message = "Number(unsafe) 與 priceNum 僅是文案";',
        "const safe = parseParameterDecimalField(input.unitPrice, field, capacity);",
      ].join("\n")
    );
    expect(findCoercionCalls(commentOnly)).toEqual([]);
    expect(/\bpriceNum\b/.test(commentOnly)).toBe(false);

    // (c) 述詞式 Number.isX 不在禁止範圍（避免誤擋既有整數值域層）
    expect(findCoercionCalls("if (!Number.isInteger(input.usefulLifeYears)) {}")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2 行為等價（AC-29 Then 前半）——需 DB
// ---------------------------------------------------------------------------

describeWithDb("CHORE-003-T3 §2 AC-29：字串輸入與等值 number 輸入之 DTO 完全相同", () => {
  const prisma = getPrismaClient(DB_URL);

  afterAll(async () => {
    await prisma.fuelParameterVersion.deleteMany({
      where: { effectiveFrom: { gte: new Date("2096-01-01"), lte: new Date("2096-01-31") } },
    });
    await prisma.etcParameterVersion.deleteMany({
      where: { effectiveFrom: { gte: new Date("2096-02-01"), lte: new Date("2096-02-28") } },
    });
    await prisma.depreciationParameterVersion.deleteMany({
      where: { effectiveFrom: { gte: new Date("2096-03-01"), lte: new Date("2096-03-31") } },
    });
    await prisma.$disconnect();
  });

  it('createFuelVersion："19.9" 與 19.9 存入與回傳完全相同（僅 id/日期/建立時間不同）', async () => {
    const byString = await createFuelVersion(prisma, {
      unitPrice: "19.9",
      effectiveFrom: "2096-01-01",
      createdById: CREATED_BY,
    });
    const byNumber = await createFuelVersion(prisma, {
      unitPrice: 19.9,
      effectiveFrom: "2096-01-02",
      createdById: CREATED_BY,
    });
    expect(byString.unitPrice).toBe("19.9000");
    expect(byString.unitPrice).toBe(byNumber.unitPrice);

    // 存入值（非僅 DTO）亦逐字元相同
    const rows = await prisma.fuelParameterVersion.findMany({
      where: { id: { in: [byString.id, byNumber.id] } },
      select: { unitPrice: true },
    });
    expect(rows.map((r) => r.unitPrice.toString())).toEqual(["19.9", "19.9"]);
  });

  it('createFuelVersion："0.1" 與 0.1 存入與回傳完全相同（典型二進位不可精確表示值）', async () => {
    const byString = await createFuelVersion(prisma, {
      unitPrice: "0.1",
      effectiveFrom: "2096-01-03",
      createdById: CREATED_BY,
    });
    const byNumber = await createFuelVersion(prisma, {
      unitPrice: 0.1,
      effectiveFrom: "2096-01-04",
      createdById: CREATED_BY,
    });
    expect(byString.unitPrice).toBe("0.1000");
    expect(byString.unitPrice).toBe(byNumber.unitPrice);
  });

  it('createFuelVersion：容量上界 "999999.9999" 與 999999.9999 完全相同（AR-5 不可觀測性之上界案例）', async () => {
    const byString = await createFuelVersion(prisma, {
      unitPrice: "999999.9999",
      effectiveFrom: "2096-01-05",
      createdById: CREATED_BY,
    });
    const byNumber = await createFuelVersion(prisma, {
      unitPrice: 999999.9999,
      effectiveFrom: "2096-01-06",
      createdById: CREATED_BY,
    });
    expect(byString.unitPrice).toBe("999999.9999");
    expect(byString.unitPrice).toBe(byNumber.unitPrice);
  });

  it('createEtcVersion："5.5" 與 5.5 存入與回傳完全相同', async () => {
    const byString = await createEtcVersion(prisma, {
      unitPrice: "5.5",
      effectiveFrom: "2096-02-01",
      createdById: CREATED_BY,
    });
    const byNumber = await createEtcVersion(prisma, {
      unitPrice: 5.5,
      effectiveFrom: "2096-02-02",
      createdById: CREATED_BY,
    });
    expect(byString.unitPrice).toBe("5.5000");
    expect(byString.unitPrice).toBe(byNumber.unitPrice);
  });

  it('createDepreciationVersion："9999999999.99" 與 9999999999.99 之 DTO 與 derived 完全相同（容量上界）', async () => {
    const byString = await createDepreciationVersion(prisma, {
      vehiclePrice: "9999999999.99",
      usefulLifeYears: 3,
      estimatedAnnualKm: 20000,
      effectiveFrom: "2096-03-01",
      createdById: CREATED_BY,
    });
    const byNumber = await createDepreciationVersion(prisma, {
      vehiclePrice: 9999999999.99,
      usefulLifeYears: 3,
      estimatedAnnualKm: 20000,
      effectiveFrom: "2096-03-02",
      createdById: CREATED_BY,
    });
    expect(byString.vehiclePrice).toBe("9999999999.99");
    expect(byString.vehiclePrice).toBe(byNumber.vehiclePrice);
    expect(byString.derived).toEqual(byNumber.derived);
  });
});

// ---------------------------------------------------------------------------
// §3 為何「行為鑑別」不可行——AR-5「不可觀測」判定的可執行證據（無 DB）
// ---------------------------------------------------------------------------

describe("CHORE-003-T3 §3 AR-5 實證：欄位容量內不存在 double 中介會失真之值", () => {
  /** 模擬「把 Number() 中介塞回字串路徑」：字串 → double → 最短往返字串 → Decimal。 */
  const viaDoubleMediation = (literal: string) =>
    new Prisma.Decimal(String(Number(literal))).toFixed(4);
  const direct = (literal: string) => new Prisma.Decimal(literal).toFixed(4);

  it("unitPrice `Decimal(10,4)` 容量內（含上下界與代表性值）：兩路徑逐字元相同", () => {
    for (const literal of [
      "0",
      "0.0001",
      "0.1",
      "19.9",
      "1.2345",
      "3.5000",
      "123456.7891",
      "999999.9999",
      "-999999.9999",
    ]) {
      expect({ literal, value: viaDoubleMediation(literal) }).toEqual({
        literal,
        value: direct(literal),
      });
    }
  });

  it("vehiclePrice `Decimal(12,2)` 容量內（含上界 12 位有效數字）：兩路徑逐字元相同", () => {
    const viaDouble2 = (l: string) => new Prisma.Decimal(String(Number(l))).toFixed(2);
    const direct2 = (l: string) => new Prisma.Decimal(l).toFixed(2);
    for (const literal of ["0.01", "600000", "600000.05", "9999999999.98", "9999999999.99"]) {
      expect({ literal, value: viaDouble2(literal) }).toEqual({ literal, value: direct2(literal) });
    }
  });

  it("鑑別力對照：容量**外**（>15 位有效數字）才會失真——證明上面兩條不是恆真的空斷言", () => {
    // 17 位有效數字：超出 double 的無損往返保證，亦超出兩個欄位的容量，
    // 故無法作為 AC-29 的行為鑑別案例（合法輸入永遠到不了這裡）。
    const beyondCapacity = "9999999999999999.9";
    expect(String(Number(beyondCapacity))).not.toBe(beyondCapacity);
  });
});
