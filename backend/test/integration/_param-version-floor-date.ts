/**
 * Shared test helper — PHASE-004-R3（測試套件決定性修復，機制 B）
 *
 * 根因（見 Task Handoff「機制 B 根因與證據」）：`FuelParameterVersion`/
 * `EtcParameterVersion` 是全域表（`resolveTravelParameters` 依 Spec §10.2 對
 * 該類全部版本 `findMany`，不分測試檔），`@@unique([effectiveFrom])` 使其成為
 * PHASE-003a D2/D4 定案的「不重疊＝生效日唯一」全域單例式資料。過去「缺參數」
 * 測試（AC-45/46/47 等）靠「挑一個比『目前已知』所有版本都早/晚的日期」這種
 * 寫死假設來製造「查無版本」情境——但這假設從未被驗證過，只要另一個平行執行
 * 的測試檔在那個瞬間持有一個涵蓋該日期的版本（即使只是它自己 beforeAll/it
 * 建立、afterAll 才清掉的暫時 fixture），斷言就會依實際巧合的執行順序不定地
 * 紅／綠——這正是 reviewer 抓到的 S-4（`phase4-travel-preview.test.ts` AC-45
 * tripDate=2030-12-31 案例：2026 年的 `phase3a-parameter-model.test.ts` fixture
 * 若在同一瞬間存在，即會被 `findEffectiveVersion` 選中，`parameterAvailable`
 * 從預期的 false 變 true）。
 *
 * 修法：不再猜「哪個日期夠早/夠晚」，而是在斷言前**直接查當下 DB 的真實
 * 狀態**，取全表最早的 `effectiveFrom`，回傳一個保證更早（往前多留 1 年安全
 * 邊界，防止本查詢與後續 HTTP 呼叫之間的極短窗口內剛好有新 fixture 插入）的
 * 日期字串。這個日期「早於當下所有版本」是**當場驗證**的事實，不是對其他測試
 * 檔案日期慣例的假設——不論未來新增測試檔用什麼年份、不論平行 fork 排程如何，
 * 都不需要任何跨檔案協調或寫死的「全域安全年份」。
 *
 * 僅供 test/integration/** 使用；不得被 src/ 匯入。
 */
import type { PrismaClient } from "@prisma/client";

type ParamVersionQueryable = Pick<PrismaClient, "fuelParameterVersion" | "etcParameterVersion">;

/**
 * 回傳一個 `YYYY-MM-DD` 字串，保證早於呼叫當下 `FuelParameterVersion`／
 * `EtcParameterVersion` 兩表中「現存」的任何 `effectiveFrom`（往前再退 1 年
 * 做安全邊界）。若兩表當下皆無資料，回傳一個遠古 sentinel（`0100-01-01`）。
 *
 * 呼叫端應在發出「應查無版本」的請求「之前」呼叫本函式，兩者之間應盡量不要
 * 插入其他 await（縮小理論上的競態窗口——見上方檔頭說明，此窗口已從「整個
 * 測試套件執行期間」縮小到「這一次呼叫到下一行 HTTP 請求之間」，數量級差異
 * 巨大）。
 */
export async function dateBeforeAnyKnownParameterVersion(
  prisma: ParamVersionQueryable
): Promise<string> {
  const [earliestFuel, earliestEtc] = await Promise.all([
    prisma.fuelParameterVersion.findFirst({
      orderBy: { effectiveFrom: "asc" },
      select: { effectiveFrom: true },
    }),
    prisma.etcParameterVersion.findFirst({
      orderBy: { effectiveFrom: "asc" },
      select: { effectiveFrom: true },
    }),
  ]);

  const candidates: Date[] = [];
  if (earliestFuel) candidates.push(earliestFuel.effectiveFrom);
  if (earliestEtc) candidates.push(earliestEtc.effectiveFrom);

  if (candidates.length === 0) {
    // 兩表皆空——任何日期都「早於全部版本」，但仍給一個明確、可讀的遠古日期
    // 而非依賴呼叫端另行決定。
    return "0100-01-01";
  }

  const earliest = candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
  const floor = new Date(
    Date.UTC(earliest.getUTCFullYear() - 1, earliest.getUTCMonth(), earliest.getUTCDate())
  );
  return floor.toISOString().slice(0, 10);
}
