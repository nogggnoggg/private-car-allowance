/**
 * Completion blockers generator — PHASE-004-T3
 *
 * Spec §2 群組 A（AC-01~03/07）、D（AC-24）、G（AC-46）、§8.1 `BlockerDto`,
 * §11.1 完成項清單。Pure function, zero IO — no prisma client instance, no
 * env access, no DB/network/filesystem calls, same shape as
 * `application-state-machine.ts` (T2).
 *
 * Consumed by:
 *   - T3 差旅 GET/PUT DTO 建構（DRAFT 狀態的 `completionBlockers` 欄位）
 *   - T8 完成流程（`POST /applications/:id/complete` 之守門判斷）——本函式回傳
 *     的陣列非空即拒絕完成（AC-52：回傳全部未通過項，非只回第一項）
 *
 * Scope note (Packet 明文): 本 Task 只實作下列規則：
 *   TRIP_DATE_REQUIRED / PURPOSE_REQUIRED / SEGMENT_REQUIRED /
 *   SEGMENT_LOCATION_REQUIRED / SEGMENT_ATTACHMENT_REQUIRED /
 *   PARAMETER_NOT_AVAILABLE
 * 里程數值規則（totalKm ≤ 0、highwayKm < 0、highwayKm > totalKm）刻意不在本
 * Task 實作，留給 PHASE-004-T5 併入——見下方 TODO(PHASE-004-T5) 標記之擴充點。
 * `BlockerInput.segments[].totalKm`/`highwayKm` 欄位已預留，T5 不需要改動本
 * 函式簽章。
 *
 * 輸出順序（Packet 明文要求，供 UI 與測試穩定依賴）：
 *   1. 申請層級（依序）：TRIP_DATE_REQUIRED → PURPOSE_REQUIRED →
 *      SEGMENT_REQUIRED → PARAMETER_NOT_AVAILABLE
 *   2. 段落層級：依 `sortOrder` 由小到大；同一段內先 origin 後 destination
 *      的 SEGMENT_LOCATION_REQUIRED，再 SEGMENT_ATTACHMENT_REQUIRED
 *      （之後 T5 的里程 blockers 併入時，亦依此段落順序插入同一段的區塊內）
 */

/** 單一行程段的完成度判斷輸入。 */
export interface BlockerSegmentInput {
  id: string;
  sortOrder: number;
  origin: string | null;
  destination: string | null;
  /** Prisma.Decimal | null — 本 Task 不消費此欄位；為 T5 里程規則預留（勿移除）。 */
  totalKm: unknown | null;
  /** Prisma.Decimal | null — 同上，T5 預留。 */
  highwayKm: unknown | null;
  /** 該段目前 LINKED 附件數；T11 之前由呼叫端算出或給 0。 */
  attachmentCount: number;
}

export interface BlockerInput {
  tripDate: Date | null;
  purpose: string | null;
  segments: ReadonlyArray<BlockerSegmentInput>;
  /** 缺少的參數類別；T7 之前呼叫端一律傳空陣列。 */
  missingParameters: ReadonlyArray<"FUEL" | "ETC">;
}

export interface Blocker {
  code: string;
  field?: string;
  segmentId?: string;
  segmentIndex?: number;
  message: string; // zh-TW
}

/** 純空白／null／undefined 一律視為缺（PURPOSE_REQUIRED 的 AC-52 邊界案例）。 */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

const PARAMETER_LABELS: Record<"FUEL" | "ETC", string> = {
  FUEL: "油資",
  ETC: "ETC",
};

/**
 * 計算差旅草稿的「尚未完成項」清單（後端唯一權威，D7）。
 * 回傳全部未通過項（AC-52），不可只回第一項；輸出順序穩定可預期。
 */
export function computeCompletionBlockers(input: BlockerInput): Blocker[] {
  const blockers: Blocker[] = [];

  // ── 申請層級 ─────────────────────────────────────────────────────────
  if (input.tripDate === null) {
    blockers.push({
      code: "TRIP_DATE_REQUIRED",
      field: "tripDate",
      message: "請填寫出差日期",
    });
  }

  if (isBlank(input.purpose)) {
    blockers.push({
      code: "PURPOSE_REQUIRED",
      field: "purpose",
      message: "請填寫出差目的",
    });
  }

  if (input.segments.length === 0) {
    blockers.push({
      code: "SEGMENT_REQUIRED",
      message: "至少需要一個行程段",
    });
  }

  if (input.missingParameters.length > 0) {
    const labels = input.missingParameters.map((p) => PARAMETER_LABELS[p]).join("、");
    blockers.push({
      code: "PARAMETER_NOT_AVAILABLE",
      message: `出差日期缺少有效的${labels}補助參數，請聯絡管理員設定`,
    });
  }

  // ── 段落層級：依 sortOrder 由小到大（輸入陣列順序不保證，須自行排序） ──
  const orderedSegments = [...input.segments].sort((a, b) => a.sortOrder - b.sortOrder);

  orderedSegments.forEach((segment, segmentIndex) => {
    if (isBlank(segment.origin)) {
      blockers.push({
        code: "SEGMENT_LOCATION_REQUIRED",
        field: `segments[${segmentIndex}].origin`,
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少出發地點`,
      });
    }

    if (isBlank(segment.destination)) {
      blockers.push({
        code: "SEGMENT_LOCATION_REQUIRED",
        field: `segments[${segmentIndex}].destination`,
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少到達地點`,
      });
    }

    // TODO(PHASE-004-T5): 里程規則 blockers 於此併入
    //   - totalKm ≤ 0（含 0 與負值）→ SEGMENT_TOTAL_KM_INVALID
    //   - highwayKm < 0            → SEGMENT_HIGHWAY_KM_INVALID
    //   - highwayKm > totalKm      → SEGMENT_HIGHWAY_GT_TOTAL
    //   插入位置：同一段內，SEGMENT_LOCATION_REQUIRED 之後、
    //   SEGMENT_ATTACHMENT_REQUIRED 之前，以維持「同段內問題集中呈現」的順序。

    if (segment.attachmentCount < 1) {
      blockers.push({
        code: "SEGMENT_ATTACHMENT_REQUIRED",
        segmentId: segment.id,
        segmentIndex,
        message: `第 ${segmentIndex + 1} 段缺少 Google Maps 截圖`,
      });
    }
  });

  return blockers;
}
