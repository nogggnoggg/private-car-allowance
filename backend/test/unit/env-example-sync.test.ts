/**
 * PHASE-011-T8 — `.env.example` 與 env schema 之機械一致性（Spec AC-13）
 *
 * 涵蓋（`docs/specs/PHASE-011.md` §2 D 段 AC-13 三段逐字）：
 *   · AC-13(a) `.env.example` 所列變數名集合 ⊇ `envSchema` 之全部鍵（缺一即紅
 *     ——防新增變數忘了寫進範本，使部署者無從得知）。
 *   · AC-13(b) `.env.example` **不得**含 schema 未知之變數名（除明示標註為
 *     「compose only」之四項，以常數白名單宣告）。
 *   · AC-13(c) `.env.example` 之每個值皆為**佔位值**。
 *
 * 零 DB、零網路、零磁碟寫入：本檔只**讀取**倉庫內的 `.env.example`，突變一律
 * 在記憶體字串上施行，並以「磁碟原檔位元組全等」之 it 自證未污染工作樹
 * （沿 `phase10-error-handler-leak.test.ts` 之真實檔暫改紀律）。
 *
 * ---------------------------------------------------------------------------
 * 為何 schema 鍵集不在本檔硬編
 * ---------------------------------------------------------------------------
 * `ENV_SCHEMA_KEYS` 由 `config/env.ts` 以 `Object.keys(envSchema.shape)` 導出
 * ——**由真實 schema 導出而非另抄一份**。故日後任何人在 schema 加一個鍵，
 * (a) 會自動進入本檔的比對左邊、(b) 若忘了寫進 `.env.example` 就必紅。若改成
 * 在測試裡另列一份清單，就變成「兩份清單互比」——兩份一起漏掉時全綠，守門歸零。
 * （schema 鍵集之**封閉性**另由 `env.test.ts` 之 `ENV_SCHEMA_KEYS toEqual` 一格
 * 承擔：那一格的作用相反，是讓「悄悄新增 env 鍵」這件事本身必紅。）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA_KEYS } from "../../src/config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 倉庫根（`backend/test/unit` → 上溯三層）。 */
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

/**
 * `.env.example` 中**刻意**不屬於後端 env schema 的變數名（AC-13(b) 逐字之
 * 「compose only」四項），逐筆理由：
 *
 *   · `POSTGRES_USER`／`POSTGRES_PASSWORD`／`POSTGRES_DB`
 *       — `postgres:16` 映像檔於**首次初始化**時讀取，用來建立初始資料庫；
 *         由 `docker-compose.yml` 的 `db` 服務消費，後端行程從不讀取（後端
 *         只認完整的 `DATABASE_URL`）。故它們不該進 `envSchema`。
 *   · `VITE_API_PROXY_TARGET`
 *       — Vite **開發伺服器**的 `/api` proxy 目標，建置期由前端工具鏈消費；
 *         production 由 nginx 轉發，後端行程同樣從不讀取。
 *
 * 這四項是**封閉集合**：任何第五個「schema 不認得」的變數名出現在範本裡，
 * 就是「有人加了變數但沒進 schema」或「範本殘留死變數」，兩者都必須被看見。
 */
const COMPOSE_ONLY_TEMPLATE_KEYS = [
  "POSTGRES_DB",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "VITE_API_PROXY_TARGET",
];

/**
 * AC-13(c) 之**具名佔位值契約**：對「值本身帶憑證語意」的鍵，逐鍵釘死其
 * 佔位字面。理由逐筆：
 *
 *   · `DATABASE_URL`／`POSTGRES_PASSWORD`：範本裡唯二會被誤當成真憑證的值。
 *     `changeme` 是**刻意的自我揭露式佔位詞**——部署者一眼看得出必須換掉，
 *     且它同時是 AC-12 secrets 掃描白名單的唯一理由（見
 *     `phase11-env-secrets.test.ts` 之 `SECRET_SCAN_WHITELIST`）。這一格與那份
 *     白名單是**同一件事的兩面**：這裡保證範本裡的憑證值就是那個佔位詞，那裡
 *     保證掃描器對它放行的理由僅限於「它是那個佔位詞」。
 *
 * 其餘鍵之佔位性由下方「零高熵值」一格以形狀承擔（不逐鍵硬編，否則範本每改
 * 一個無關的預設值都要回頭改測試，會誘發把斷言改鬆的壓力）。
 */
const CREDENTIAL_PLACEHOLDER_CONTRACT: ReadonlyArray<readonly [string, string]> = [
  ["DATABASE_URL", "postgresql://appuser:changeme@db:5432/appdb"],
  ["POSTGRES_PASSWORD", "changeme"],
];

/**
 * 「高熵值」形狀：長度 ≥32 之連續 base64／hex 字元。真實的 API 金鑰、
 * session secret、access token 幾乎必然落在此形狀內；本範本的所有合法值
 * （路徑、埠號、列舉字、佔位連線字串）都不會。與 AC-12(a) 第四樣式同源，
 * 但此處**不看鍵名**——範本裡任何鍵都不該有這種值。
 */
const HIGH_ENTROPY_VALUE = /^[A-Za-z0-9+/=]{32,}$/;

// ---------------------------------------------------------------------------
// 範本解析
// ---------------------------------------------------------------------------

/**
 * 解析 `.env` 形式之文字，回傳 `[鍵, 值]` 之序列（保留出現序）。
 *
 * 刻意**不**支援 `export ` 前綴、行內註解剝除、引號剝除或多行值——`.env.example`
 * 是本專案自己維護的範本，形狀單純（`KEY=value`，註解整行以 `#` 開頭）。多支援
 * 一種語法就多一條「掃描器看不懂於是靜默放行」的路；看不懂的行寧可讓它落在
 * 鍵集之外而被 AC-13(a) 抓成缺鍵，也不要猜。
 */
function parseEnvTemplate(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) entries.push([match[1] as string, match[2] as string]);
  }
  return entries;
}

const DISK_CONTENT = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");

function keysOf(content: string): string[] {
  return parseEnvTemplate(content)
    .map(([key]) => key)
    .sort();
}

describe("PHASE-011-T8 — AC-13: `.env.example` 與 env schema 之機械一致性", () => {
  it("(a) 範本之變數名集合 ⊇ envSchema 全鍵（缺一必紅）", () => {
    const templateKeys = new Set(keysOf(DISK_CONTENT));
    const missing = ENV_SCHEMA_KEYS.filter((key) => !templateKeys.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("(b) 範本零未知變數 — 差集恰等於 compose-only 白名單四項", () => {
    const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
    const unknown = keysOf(DISK_CONTENT)
      .filter((key) => !schemaKeys.has(key))
      .sort();
    expect(unknown).toEqual([...COMPOSE_ONLY_TEMPLATE_KEYS].sort());
  });

  it("(b) 範本零重複鍵（同名兩行會讓 dotenv 靜默取後者，是設定漂移的溫床）", () => {
    const keys = parseEnvTemplate(DISK_CONTENT).map(([key]) => key);
    const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index).sort();
    expect(duplicated).toEqual([]);
  });

  it("(c) 帶憑證語意之鍵，其值逐鍵等於宣告之佔位字面", () => {
    const entries = new Map(parseEnvTemplate(DISK_CONTENT));
    for (const [key, placeholder] of CREDENTIAL_PLACEHOLDER_CONTRACT) {
      expect(entries.get(key), `${key} 之範本值`).toBe(placeholder);
    }
  });

  it("(c) 範本零高熵值（長度 ≥32 之 base64／hex 字面）", () => {
    const offenders = parseEnvTemplate(DISK_CONTENT)
      .filter(([, value]) => HIGH_ENTROPY_VALUE.test(value.trim()))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 鑑別力自證（mutant）——證明上列三格不是恆真
  //
  // 全部在**記憶體字串**上施行，最後一格斷言磁碟原檔位元組全等。刻意不寫回
  // 磁碟：平行測試或中途失敗都可能把一個被改壞的 `.env.example` 留在工作樹裡。
  // -------------------------------------------------------------------------
  describe("鑑別力自證（記憶體突變，零磁碟寫入）", () => {
    it("mutant：範本刪掉一個 schema 鍵 → (a) 必紅", () => {
      const victim = "ATTACHMENT_CLEANUP_BATCH_LIMIT";
      expect(ENV_SCHEMA_KEYS).toContain(victim);
      const mutated = DISK_CONTENT.split(/\r?\n/)
        .filter((line) => !line.startsWith(`${victim}=`))
        .join("\n");

      const templateKeys = new Set(keysOf(mutated));
      const missing = ENV_SCHEMA_KEYS.filter((key) => !templateKeys.has(key));
      expect(missing).toEqual([victim]);
    });

    it("mutant：範本新增一個 schema 未知的變數 → (b) 必紅", () => {
      const mutated = `${DISK_CONTENT}\nSOME_NEW_KNOB=1\n`;
      const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
      const unknown = keysOf(mutated)
        .filter((key) => !schemaKeys.has(key))
        .sort();
      expect(unknown).not.toEqual([...COMPOSE_ONLY_TEMPLATE_KEYS].sort());
      expect(unknown).toContain("SOME_NEW_KNOB");
    });

    it("mutant：把佔位密碼換成真實形狀之高熵值 → (c) 兩格必紅", () => {
      const realShaped = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdI";
      expect(realShaped.length).toBeGreaterThanOrEqual(32);
      const mutated = DISK_CONTENT.replace(
        "POSTGRES_PASSWORD=changeme",
        `POSTGRES_PASSWORD=${realShaped}`
      );
      expect(mutated).not.toBe(DISK_CONTENT);

      const entries = new Map(parseEnvTemplate(mutated));
      expect(entries.get("POSTGRES_PASSWORD")).not.toBe("changeme");

      const offenders = parseEnvTemplate(mutated)
        .filter(([, value]) => HIGH_ENTROPY_VALUE.test(value.trim()))
        .map(([key]) => key);
      expect(offenders).toEqual(["POSTGRES_PASSWORD"]);
    });

    it("還原自證：突變後磁碟上的 `.env.example` 位元組全等（零污染工作樹）", () => {
      expect(fs.readFileSync(ENV_EXAMPLE_PATH, "utf8")).toBe(DISK_CONTENT);
    });
  });
});
