/**
 * Unit tests: PHASE-004-T4 — computeSegmentDiff (segment-diff.ts)
 *
 * Pure function, no DB. Spec §2 AC-08/10/11/13, §11.1「段落 diff / sortOrder
 * 重寫 ≥ 10 案例」.
 */
import { describe, expect, it } from "vitest";
import { computeSegmentDiff } from "../../src/applications/segment-diff.js";
import { AppError } from "../../src/platform/errors.js";

interface Fields {
  origin?: string | null;
}

describe("PHASE-004-T4 — computeSegmentDiff", () => {
  it("純新增：existing=[] → 全部進 toCreate，sortOrder 依索引 0..n-1", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [],
      submitted: [{ origin: "A" }, { origin: "B" }, { origin: "C" }],
    });
    expect(result.toCreate).toEqual([
      { sortOrder: 0, data: { origin: "A" } },
      { sortOrder: 1, data: { origin: "B" } },
      { sortOrder: 2, data: { origin: "C" } },
    ]);
    expect(result.toUpdate).toEqual([]);
    expect(result.toDeleteIds).toEqual([]);
  });

  it("純刪除：submitted=[] → 全部既有 id 進 toDeleteIds", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }],
      submitted: [],
    });
    expect(result.toCreate).toEqual([]);
    expect(result.toUpdate).toEqual([]);
    expect(result.toDeleteIds.sort()).toEqual(["S1", "S2"]);
  });

  it("純更新：全部既有 id 皆再次提交 → 全進 toUpdate，無新增無刪除", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }],
      submitted: [
        { id: "S1", origin: "A2" },
        { id: "S2", origin: "B2" },
      ],
    });
    expect(result.toUpdate).toEqual([
      { id: "S1", sortOrder: 0, data: { origin: "A2" } },
      { id: "S2", sortOrder: 1, data: { origin: "B2" } },
    ]);
    expect(result.toCreate).toEqual([]);
    expect(result.toDeleteIds).toEqual([]);
  });

  it("純重排：existing=[S1,S2] → submitted=[{id:S2},{id:S1}] → sortOrder 對調", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }],
      submitted: [{ id: "S2" }, { id: "S1" }],
    });
    expect(result.toUpdate).toEqual([
      { id: "S2", sortOrder: 0, data: {} },
      { id: "S1", sortOrder: 1, data: {} },
    ]);
    expect(result.toDeleteIds).toEqual([]);
  });

  it("AC-13 具體案例：existing=[S1,S2,S3], submitted=[{id:S2},{新},{id:S1}] → S2.sortOrder=0、新段 sortOrder=1、S1.sortOrder=2、toDeleteIds=[S3]", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }, { id: "S3" }],
      submitted: [
        { id: "S2", origin: "existing-2" },
        { origin: "new" },
        { id: "S1", origin: "existing-1" },
      ],
    });
    expect(result.toUpdate).toEqual([
      { id: "S2", sortOrder: 0, data: { origin: "existing-2" } },
      { id: "S1", sortOrder: 2, data: { origin: "existing-1" } },
    ]);
    expect(result.toCreate).toEqual([{ sortOrder: 1, data: { origin: "new" } }]);
    expect(result.toDeleteIds).toEqual(["S3"]);
  });

  it("混合案例：新增 + 更新 + 刪除同時發生", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }, { id: "S3" }, { id: "S4" }],
      submitted: [{ id: "S3" }, { origin: "brand-new" }, { id: "S4" }],
    });
    expect(result.toUpdate.map((u) => u.id)).toEqual(["S3", "S4"]);
    expect(result.toCreate).toHaveLength(1);
    expect(result.toDeleteIds.sort()).toEqual(["S1", "S2"]);
  });

  it("sortOrder 結果恆為 0..n-1 連續無洞（混合大量案例）", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }, { id: "S2" }, { id: "S3" }, { id: "S4" }, { id: "S5" }],
      submitted: [
        { id: "S5" },
        { origin: "new-1" },
        { id: "S2" },
        { origin: "new-2" },
        { id: "S1" },
        { id: "S3" },
      ],
    });
    const allSortOrders = [
      ...result.toCreate.map((c) => c.sortOrder),
      ...result.toUpdate.map((u) => u.sortOrder),
    ].sort((a, b) => a - b);
    expect(allSortOrders).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("未知 id（不存在於 existing）→ 拒絕（AppError FORBIDDEN 403），不回傳部分結果", () => {
    expect(() =>
      computeSegmentDiff<Fields>({
        existing: [{ id: "S1" }],
        submitted: [{ id: "S1" }, { id: "SOMEONE_ELSES_SEGMENT" }],
      })
    ).toThrow(AppError);

    try {
      computeSegmentDiff<Fields>({
        existing: [{ id: "S1" }],
        submitted: [{ id: "SOMEONE_ELSES_SEGMENT" }],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("FORBIDDEN");
      expect((err as AppError).httpStatus).toBe(403);
    }
  });

  it("完全不存在的 id（existing 為空）→ 亦拒絕", () => {
    expect(() =>
      computeSegmentDiff<Fields>({
        existing: [],
        submitted: [{ id: "GHOST" }],
      })
    ).toThrow(AppError);
  });

  it("重複 id → 拒絕（AppError VALIDATION_ERROR 400）", () => {
    try {
      computeSegmentDiff<Fields>({
        existing: [{ id: "S1" }],
        submitted: [
          { id: "S1", origin: "first" },
          { id: "S1", origin: "second" },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("VALIDATION_ERROR");
      expect((err as AppError).httpStatus).toBe(400);
    }
  });

  it("空 existing + 空 submitted → 三個陣列皆空、不拋錯", () => {
    const result = computeSegmentDiff<Fields>({ existing: [], submitted: [] });
    expect(result).toEqual({ toCreate: [], toUpdate: [], toDeleteIds: [] });
  });

  it("純函式：相同輸入呼叫兩次得到相同（deep-equal）結果", () => {
    const inputA = {
      existing: [{ id: "S1" }, { id: "S2" }],
      submitted: [{ id: "S2", origin: "x" }, { origin: "y" }],
    };
    const inputB = {
      existing: [{ id: "S1" }, { id: "S2" }],
      submitted: [{ id: "S2", origin: "x" }, { origin: "y" }],
    };
    const r1 = computeSegmentDiff<Fields>(inputA);
    const r2 = computeSegmentDiff<Fields>(inputB);
    expect(r1).toEqual(r2);
  });

  it("data payload 不含 id 鍵（id 已被拆出，不洩漏進 data）", () => {
    const result = computeSegmentDiff<Fields>({
      existing: [{ id: "S1" }],
      submitted: [{ id: "S1", origin: "keep-me" }],
    });
    expect(result.toUpdate[0].data).not.toHaveProperty("id");
    expect(result.toUpdate[0].data).toEqual({ origin: "keep-me" });
  });
});
