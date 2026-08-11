/**
 * Unit tests for config/env.ts — parseEnv()
 * TDD: written BEFORE implementation, expected to fail first.
 *
 * PHASE-003-T2: tests for ATTACHMENT_* env variables added at bottom.
 * PHASE-008-T7: tests for REPORT_* env variables added at bottom.
 * PHASE-011-T8: AC-11(a)(b) — 本 Phase 新增變數之型別／預設／必要性逐項、
 *   錯值訊息零值洩漏，以及 `ENV_SCHEMA_KEYS`／`PRODUCTION_REQUIRED_ENV_KEYS`
 *   兩份導出常數之封閉性（末段獨立 describe）。
 */
import { describe, expect, it } from "vitest";
import { ENV_SCHEMA_KEYS, PRODUCTION_REQUIRED_ENV_KEYS, parseEnv } from "../../src/config/env.js";

describe("parseEnv()", () => {
  it("throws an error containing the missing variable name when DATABASE_URL is absent", () => {
    const incompleteEnv = {
      // DATABASE_URL intentionally omitted
      NODE_ENV: "test",
      PORT: "3000",
    };
    expect(() => parseEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
  });

  it("returns a typed config object when all required env vars are present", () => {
    const validEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
      PORT: "3001",
      LOG_LEVEL: "info",
      STORAGE_PATH: "/data/storage",
    };
    const config = parseEnv(validEnv);
    expect(config.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/test_db");
    expect(config.PORT).toBe(3001);
    expect(config.NODE_ENV).toBe("test");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("uses default values for optional env vars when not provided", () => {
    const minimalEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
    };
    const config = parseEnv(minimalEnv);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("does not include DATABASE_URL value in error message (security)", () => {
    const incompleteEnv: Record<string, string> = {};
    expect(() => parseEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
    // Ensure no secrets leak in the error — the error should list the name, not a value
    // (Here we are checking missing-key scenario, so no value to leak, but the test
    // documents the intent: only variable names appear in errors, never values.)
  });

  // ── PHASE-003-T2: Attachment storage env variables (Spec §8) ────────────

  describe("PHASE-003-T2 attachment env vars", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
    };

    it("ATTACHMENT_STORAGE_ROOT is optional and parsed as string when provided", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_STORAGE_ROOT: "/data/attachments" });
      expect(config.ATTACHMENT_STORAGE_ROOT).toBe("/data/attachments");
    });

    it("ATTACHMENT_STORAGE_ROOT is undefined when not provided", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_STORAGE_ROOT).toBeUndefined();
    });

    it("ATTACHMENT_MAX_BYTES defaults to 10485760 (10 MiB)", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_MAX_BYTES).toBe(10485760);
    });

    it("ATTACHMENT_MAX_BYTES is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_MAX_BYTES: "5242880" });
      expect(config.ATTACHMENT_MAX_BYTES).toBe(5242880);
    });

    it("ATTACHMENT_TEMP_TTL_HOURS defaults to 24", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_TEMP_TTL_HOURS).toBe(24);
    });

    it("ATTACHMENT_TEMP_TTL_HOURS is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_TEMP_TTL_HOURS: "48" });
      expect(config.ATTACHMENT_TEMP_TTL_HOURS).toBe(48);
    });

    it("ATTACHMENT_THUMBNAIL_MAX_PX defaults to 512", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.ATTACHMENT_THUMBNAIL_MAX_PX).toBe(512);
    });

    it("ATTACHMENT_THUMBNAIL_MAX_PX is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, ATTACHMENT_THUMBNAIL_MAX_PX: "256" });
      expect(config.ATTACHMENT_THUMBNAIL_MAX_PX).toBe(256);
    });

    it("ATTACHMENT_MAX_BYTES rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, ATTACHMENT_MAX_BYTES: "0" })).toThrowError(
        /ATTACHMENT_MAX_BYTES/
      );
    });

    it("ATTACHMENT_TEMP_TTL_HOURS rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, ATTACHMENT_TEMP_TTL_HOURS: "0" })).toThrowError(
        /ATTACHMENT_TEMP_TTL_HOURS/
      );
    });
  });

  // ── PHASE-008-T7: Report generation env vars (Spec §8, §10-2) ───────────
  //
  // REPORT_STORAGE_ROOT mirrors ATTACHMENT_STORAGE_ROOT's shape exactly
  // (optional string, no schema-level default) — the NODE_ENV=production
  // fail-fast check itself lives in server.ts (see ATTACHMENT_STORAGE_ROOT's
  // precedent at server.ts :101-117), which is T8 scope (Files Forbidden for
  // T7); this file only covers the zod-schema parse/coercion layer.
  describe("PHASE-008-T7 report generation env vars", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
    };

    it("REPORT_STORAGE_ROOT is optional and parsed as string when provided", () => {
      const config = parseEnv({ ...baseEnv, REPORT_STORAGE_ROOT: "/data/storage/pdf" });
      expect(config.REPORT_STORAGE_ROOT).toBe("/data/storage/pdf");
    });

    it("REPORT_STORAGE_ROOT is undefined when not provided", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.REPORT_STORAGE_ROOT).toBeUndefined();
    });

    it("REPORT_PDF_TIMEOUT_MS defaults to 30000", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.REPORT_PDF_TIMEOUT_MS).toBe(30000);
    });

    it("REPORT_PDF_TIMEOUT_MS is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, REPORT_PDF_TIMEOUT_MS: "45000" });
      expect(config.REPORT_PDF_TIMEOUT_MS).toBe(45000);
    });

    it("REPORT_PDF_TIMEOUT_MS rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, REPORT_PDF_TIMEOUT_MS: "0" })).toThrowError(
        /REPORT_PDF_TIMEOUT_MS/
      );
    });

    it("REPORT_IMAGE_MAX_PX defaults to 1600", () => {
      const config = parseEnv({ ...baseEnv });
      expect(config.REPORT_IMAGE_MAX_PX).toBe(1600);
    });

    it("REPORT_IMAGE_MAX_PX is coerced from string to number", () => {
      const config = parseEnv({ ...baseEnv, REPORT_IMAGE_MAX_PX: "800" });
      expect(config.REPORT_IMAGE_MAX_PX).toBe(800);
    });

    it("REPORT_IMAGE_MAX_PX rejects zero (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv, REPORT_IMAGE_MAX_PX: "0" })).toThrowError(
        /REPORT_IMAGE_MAX_PX/
      );
    });
  });

  // ── PHASE-011-T8: AC-11(a)(b) ────────────────────────────────────────────
  //
  // 本 Phase 於 schema 新增之變數**恰一個**：`ATTACHMENT_CLEANUP_BATCH_LIMIT`
  // （T4 隨 `attachment/cleanup-cli.ts` 一併加入 schema；T7 零新增）。AC-11(a)
  // 要求「型別、預設值（或明示無預設）、production 是否必要」逐項有斷言，故
  // 下面三面各一組：型別／預設在此 describe，production 必要性在
  // `PRODUCTION_REQUIRED_ENV_KEYS` 一格（它**不在**必要清單內——有預設值 500，
  // 缺了不影響啟動）。
  describe("PHASE-011-T8 attachment cleanup env var (AC-11(a))", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
    };

    it("ATTACHMENT_CLEANUP_BATCH_LIMIT defaults to 500", () => {
      expect(parseEnv({ ...baseEnv }).ATTACHMENT_CLEANUP_BATCH_LIMIT).toBe(500);
    });

    it("ATTACHMENT_CLEANUP_BATCH_LIMIT is coerced from string to number", () => {
      expect(parseEnv({ ...baseEnv, ATTACHMENT_CLEANUP_BATCH_LIMIT: "50" })).toMatchObject({
        ATTACHMENT_CLEANUP_BATCH_LIMIT: 50,
      });
    });

    // int > 0 之四個拒絕面逐一釘死。這四格同時是 `attachment/cleanup-cli.ts`
    // 之 `invalidNumericEnvKeys` 具名檢查的**對照組**——兩者的規則必須同義，
    // 該一致性由 `phase11-env-secrets.test.ts` 之「T4R 移交」一格逐值比對。
    it.each([
      ["zero", "0"],
      ["negative", "-1"],
      ["non-integer", "1.5"],
      ["non-numeric", "abc"],
      ["empty string (coerces to 0, then fails .positive())", ""],
    ])("ATTACHMENT_CLEANUP_BATCH_LIMIT rejects %s", (_label, raw) => {
      expect(() => parseEnv({ ...baseEnv, ATTACHMENT_CLEANUP_BATCH_LIMIT: raw })).toThrowError(
        /ATTACHMENT_CLEANUP_BATCH_LIMIT/
      );
    });
  });

  describe("PHASE-011-T8 — AC-11(b): 錯值訊息含變數名、零含值", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      NODE_ENV: "test",
    };

    // 既有 AC-09 紀律之延伸：先前的 :45 一格只覆蓋「**缺**變數」（沒有值可洩
    // 漏，該格自己的註解也明說了這點）。這一格覆蓋真正有風險的那半——變數
    // **有值但無效**時，錯誤訊息會不會把值一起印出去。哨兵值刻意取一個絕不會
    // 自然出現在 zod 訊息裡的字面，避免「剛好沒撞到」的假綠。
    const SENTINEL = "9199-not-a-number-SENTINEL";

    it.each([
      "ATTACHMENT_CLEANUP_BATCH_LIMIT",
      "ATTACHMENT_MAX_BYTES",
      "SESSION_ABSOLUTE_TTL_HOURS",
      "LOGIN_MAX_FAILURES",
      "PORT",
    ])("%s 給錯值 → 訊息含變數名但不含該值", (key) => {
      let caught: unknown;
      try {
        parseEnv({ ...baseEnv, [key]: SENTINEL });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain(key);
      expect(message).not.toContain(SENTINEL);
    });

    it("DATABASE_URL 給錯值 → 訊息含變數名但不含該值（憑證面）", () => {
      // 哨兵刻意帶一段像密碼的字面：若實作改成把收到的值回印出來，洩漏的就
      // 會是真實部署裡的帳密。（不用 `xxx://user:pass@host` 之形狀——`z.url()`
      // 走 WHATWG 解析，任何自訂 scheme 都算合法 URL，那樣的值根本不會被拒，
      // 這一格就會變成永遠不執行斷言的假綠。實測確認過此點。）
      const badUrl = "leaked-user_leaked-pass_not-a-url";
      let caught: unknown;
      try {
        parseEnv({ ...baseEnv, DATABASE_URL: badUrl });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain("leaked-pass");
      expect(message).not.toContain(badUrl);
    });
  });

  describe("PHASE-011-T8 — env.ts 導出常數之封閉性", () => {
    // `ENV_SCHEMA_KEYS` 由 `Object.keys(envSchema.shape)` 導出（不是另抄一份），
    // 故本格的作用是讓「悄悄新增／移除一個 env 鍵」必紅：新增者必須回到這裡
    // 補一行，那一行就是他同時該去補 `.env.example`（AC-13(a)）與
    // `docker-compose.yml`（AC-11(e)）的提醒點。
    it("ENV_SCHEMA_KEYS 恰等於宣告之封閉鍵集", () => {
      expect([...ENV_SCHEMA_KEYS]).toEqual([
        "ATTACHMENT_CLEANUP_BATCH_LIMIT",
        "ATTACHMENT_MAX_BYTES",
        "ATTACHMENT_STORAGE_ROOT",
        "ATTACHMENT_TEMP_TTL_HOURS",
        "ATTACHMENT_THUMBNAIL_MAX_PX",
        "DATABASE_URL",
        "LOGIN_LOCK_MINUTES",
        "LOGIN_MAX_FAILURES",
        "LOG_LEVEL",
        "NODE_ENV",
        "PORT",
        "REPORT_IMAGE_MAX_PX",
        "REPORT_PDF_TIMEOUT_MS",
        "REPORT_STORAGE_ROOT",
        "SESSION_ABSOLUTE_TTL_HOURS",
        "SESSION_COOKIE_NAME",
        "STORAGE_PATH",
      ]);
    });

    it("PRODUCTION_REQUIRED_ENV_KEYS 恰等於宣告之三鍵（AC-11(c) 之常數面）", () => {
      // 「行為導出之集合 == 這份常數」的比對在
      // `phase11-env-secrets.test.ts`（AC-11(c)）；本格只釘常數本身，使常數被
      // 悄悄改動時，unit 與 integration 兩層會**各自**翻紅而非一起漂移。
      expect([...PRODUCTION_REQUIRED_ENV_KEYS]).toEqual([
        "ATTACHMENT_STORAGE_ROOT",
        "DATABASE_URL",
        "REPORT_STORAGE_ROOT",
      ]);
    });

    it("PRODUCTION_REQUIRED_ENV_KEYS ⊆ ENV_SCHEMA_KEYS", () => {
      const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
      expect(PRODUCTION_REQUIRED_ENV_KEYS.filter((key) => !schemaKeys.has(key))).toEqual([]);
    });
  });
});
