/**
 * Segment diff — PHASE-004-T4
 *
 * Pure function computing the `PUT` diff for a `TripSegment[]` array (Spec
 * §8.2 SegmentInput 附註「PUT 語意（D15）」、§17.1 D15): align existing vs
 * submitted segments by `id`, rewrite `sortOrder` to the submitted array's
 * index (`0..n-1`), and report which existing ids were dropped (the caller
 * — `travel-service.ts` — is responsible for deleting those rows AND
 * detaching their `LINKED` attachments in the SAME DB transaction; this
 * module itself performs no IO of any kind).
 *
 * Zero IO: no prisma import, no network/filesystem/env access. Same input →
 * same output (or the same throw) on every call — required by the Packet's
 * "純函式：無 DB、無 IO、相同輸入恆同輸出" contract.
 *
 * ── Foreign / unknown segment id (Packet §Done When 1, 明文要求偵測並拒絕) ──
 * A `submitted` item carrying an `id` that is NOT present in `existing` is
 * rejected by throwing `AppError("FORBIDDEN", 403, ...)`. This function only
 * ever receives `existing` scoped to the ONE application currently being
 * saved (see `travel-service.ts`'s call site), so "id not in existing" is
 * indistinguishable between "this segment belongs to a DIFFERENT
 * application" and "no segment with this id exists anywhere" — collapsing
 * both into a single 403 (rather than trying to tell them apart and
 * returning 404 for one of them) avoids leaking which case occurred,
 * consistent with Spec §6.2 資料隔離不變式 4 ("他人資源一律 403，不因資源
 * 存在與否洩漏") and the PHASE-003 D6 precedent (403 over 404 for
 * cross-owner resources). The concrete HTTP mapping is re-documented at the
 * `routes.ts` call site.
 *
 * ── Duplicate id within `submitted` ──
 * The same `id` appearing twice in one `PUT` body is rejected with
 * `AppError("VALIDATION_ERROR", 400, ...)` — this is a malformed-request
 * problem (which of the two would "win" the sortOrder?), not an
 * authorization problem, so it reuses the existing format-error code rather
 * than FORBIDDEN.
 *
 * Neither error code is new — both already exist in `platform/errors.ts`
 * (Packet Stop Condition: 不得新增任何 ErrorCode).
 */

import { AppError } from "../platform/errors.js";

export interface SegmentDiffInput<T> {
  /** DB 現有段落（含 id）。 */
  existing: ReadonlyArray<{ id: string }>;
  /** 提交的段落陣列，順序即為期望的 sortOrder 順序。 */
  submitted: ReadonlyArray<{ id?: string } & T>;
}

export interface SegmentDiffResult<T> {
  toCreate: Array<{ sortOrder: number; data: T }>;
  toUpdate: Array<{ id: string; sortOrder: number; data: T }>;
  /** 未出現於 submitted 的既有段落 id（須刪除並 detach 其附件）。 */
  toDeleteIds: string[];
}

export function computeSegmentDiff<T>(input: SegmentDiffInput<T>): SegmentDiffResult<T> {
  const { existing, submitted } = input;
  const existingIds = new Set(existing.map((e) => e.id));

  const toCreate: Array<{ sortOrder: number; data: T }> = [];
  const toUpdate: Array<{ id: string; sortOrder: number; data: T }> = [];
  const seenIds = new Set<string>();

  submitted.forEach((item, index) => {
    const { id, ...rest } = item;
    // `rest` is `Omit<{id?: string} & T, "id">`, which is structurally `T`
    // (T never declares its own `id` — the segment payload types used by
    // callers keep `id` as a sibling, not a field of the data payload).
    const data = rest as unknown as T;

    if (id === undefined) {
      toCreate.push({ sortOrder: index, data });
      return;
    }

    if (!existingIds.has(id)) {
      throw new AppError("FORBIDDEN", 403, "提交的行程段不屬於此申請");
    }
    if (seenIds.has(id)) {
      throw new AppError("VALIDATION_ERROR", 400, "同一行程段 id 於本次提交中重複出現", [
        { field: "segments", reason: `重複的行程段 id: ${id}` },
      ]);
    }
    seenIds.add(id);
    toUpdate.push({ id, sortOrder: index, data });
  });

  const toDeleteIds = existing.map((e) => e.id).filter((existingId) => !seenIds.has(existingId));

  return { toCreate, toUpdate, toDeleteIds };
}
