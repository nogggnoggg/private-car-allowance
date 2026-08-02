import { defineConfig } from "vitest/config";
import { computeMaxForks } from "./test/setup/max-forks.js";

// PHASE-004-R3（測試套件決定性修復）— maxForks 上限，見 Task Handoff「機制 A
// 根因與證據」完整說明，這裡只留精簡版：
//
// 根因：本套件內多個 integration 測試檔對同一個共用 Postgres 執行個體開真正
// 的 SERIALIZABLE 交易（`completeTravelApplication` 的 `resolveTravelParameters`
// 全表掃描、`updateTravelDraft` 的 D19 併發整份 PUT 競賽等）。這些交易的重試
// 預算（`COMPLETE_MAX_RETRIES`/`UPDATE_DRAFT_MAX_RETRIES` = 6 次，退避上限
// 200ms）是依「無競爭時單次查詢約個位數毫秒」的寫實延遲設計的。Vitest 預設
// `pool:"forks"` 不設上限時，同時起的 OS 工作程序數 = 邏輯核心數（本機 16），
// 全部同時對同一個 Postgres 執行個體發真交易；一旦這台機器的 CPU 有任何額外
// 負載（其他進程、資源受限的 CI/容器），實際查詢延遲會被排隊時間大幅拉長，
// 遠超過退避視窗，導致原本該在 1~2 次重試內收斂的交易偶爾把 6 次重試預算用
// 完，浮現一次性、看似隨機的 503 SERVICE_UNAVAILABLE。
//
// 實測驗證（見 Handoff）：以 `docker update --cpus 1` 把測試用 Postgres 容器
// 人為限制在 1 顆核心（模擬「主機當下有額外負載」的最壞情況）重現，
// 15 輪全套回歸見到 4 次 503（跨 `phase4-travel-complete.test.ts`／
// `phase4-attachment-ard.test.ts`／`phase3-lifecycle.test.ts` 三個檔案，
// 與 Packet 描述的失敗特徵完全吻合）；同一顆被限制的 Postgres 容器下，僅將
// `maxForks` 從預設的 16 降到 8（一半，仍是高度平行，非序列化）即讓
// 15＋10 共 25 輪全部轉綠——證實瓶頸是「有多少個工作程序同時對 DB 開真交易」
// 而非任何個別測試的邏輯錯誤，且降到一半即已足夠、不需要序列化到 1。
//
// 為何不是「降低平行度換綠燈」（Packet 明文禁止的做法）：這裡刻意保留高度
// 平行（僅減半，非降到 1），且改動理由建立在上述受控實驗的因果證據上，而非
// 「調小數字直到不再看到紅燈」的盲改；未觸碰任何重試次數／退避／隔離等級／
// 交易邊界（那些改動的風險見 Packet「機制 A 的關鍵設計張力」）。
//
// 殘餘風險（誠實揭露，非過度宣稱已徹底解決）：這是容量餘裕，不是數學上的
// 不可能證明——若這台機器同時承受遠超過本次實驗（1 顆核心）的额外負載，同一
// 類重試耗盡理論上仍可能重現，只是門檻已大幅提高。要做到與負載完全無關的
// 決定性，需要 per-worker 獨立 DB schema 等基礎設施層隔離，超出本 Task
// Files Allowed 範圍（會動到 migration／CI 設定）。
// INFRA-001-T1: the calculation above was moved verbatim into
// `./test/setup/max-forks.ts` (`computeMaxForks()`) so that `global-setup.ts`
// (per-worker schema provisioning, see below) and this config share a single
// source of truth for `maxForks` instead of each computing it separately and
// risking drift (Spec §4.3 "maxForks 的單一事實來源"). The formula itself is
// unchanged — only its location moved.
const maxForks = computeMaxForks();

// INFRA-001-T3 — 為何 maxForks 上限在 per-worker schema 隔離之後仍保留
// （Spec docs/specs/INFRA-001.md §7 表列第 1 項，逐字對應如下）：
//
// 「`maxForks = cores/2` — 仍有效、仍必要。它對付的是容量型延遲（成因 b，
// §4.7），per-schema 完全不覆蓋」。
//
// 換句話說：上面 L4-42 的 R3 因果證據把 503 SERVICE_UNAVAILABLE 的根因拆成
// 兩個獨立成因——(a) 跨 worker 的 SSI 序列化衝突（不同 worker 對同一張全域
// 共用表如 FuelParameterVersion/EtcParameterVersion 的謂詞鎖互撞）與 (b)
// CPU/IO 排隊延遲（多 worker 同時對同一個 Postgres 執行個體發真交易，查詢
// 排隊時間被拉長到超出重試退避視窗）。INFRA-001 的 per-worker schema +
// per-file TRUNCATE（見下方 globalSetup/setupFiles）讓不同 worker 觸及不同
// 的 relation，結構上消滅成因 (a)；但它完全不降低 DB 主機的 CPU 負載，對
// 成因 (b) 沒有任何緩解——這正是 R3 的 maxForks 減半機制存在的理由，兩者是
// 互補而非互斥的兩道防線，不因新增隔離而讓舊防線變冗餘（Spec AC-25：本回合
// 一行既有防線都不刪，也不調整 maxForks 的計算公式）。實測結果見 Task
// Handoff 的 AC-24（14 輪量測）與 AC-23（wall time 前後對照）。

export default defineConfig({
  test: {
    environment: "node",
    // Include all tests by default; use --project flag to filter
    include: ["test/**/*.test.ts"],
    // Integration tests may take longer due to DB operations
    testTimeout: 30000,
    hookTimeout: 30000,
    // Pool configuration for Node ESM modules
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks,
      },
    },
    // INFRA-001-T1: per-worker PostgreSQL schema isolation (Spec
    // docs/specs/INFRA-001.md §5.2/§5.3). `globalSetup` provisions one schema
    // per pool slot (1..maxForks) once, before any test file runs;
    // `setupFiles` rewrites `process.env.DATABASE_URL` inside each fork
    // worker — before that worker's test file module is imported (confirmed
    // by a real R-1 execution experiment, see Task Handoff) — to point at
    // that worker's own schema, and fails closed if the schema isn't there.
    // Toggle: `TEST_DB_ISOLATION=off` reverts to the pre-INFRA-001 shared
    // `public` behavior with zero code changes (G5, one-key rollback).
    globalSetup: ["./test/setup/global-setup.ts"],
    setupFiles: ["./test/setup/setup-file.ts"],
  },
});
