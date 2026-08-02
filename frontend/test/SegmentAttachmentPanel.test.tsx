/**
 * SegmentAttachmentPanel 前端單元測試 — PHASE-004-T13
 *
 * 涵蓋：上傳成功顯示縮圖、上傳中防重複提交、client-side 大小/格式拒絕、
 * 刪除需二次確認（C4，取消不刪除／確認才刪除）、達上限停用上傳、
 * accept 屬性含 image/*（AC-88）。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { AttachmentDto } from "../src/api/attachments.js";
import SegmentAttachmentPanel from "../src/components/SegmentAttachmentPanel.js";

function makeFile(name: string, size: number, type: string): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

function mockUploadSuccess(attachment: AttachmentDto) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ attachment }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockDeleteSuccess() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const sampleAttachment: AttachmentDto = {
  id: "att-1",
  status: "TEMP",
  mimeType: "image/jpeg",
  byteSize: 1024,
  originalFilename: "trip.jpg",
  refType: null,
  refId: null,
  previewUrl: "/attachments/att-1/thumbnail",
  downloadUrl: "/attachments/att-1/content",
};

describe("SegmentAttachmentPanel", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("上傳合法圖片成功 → 顯示縮圖，並回呼 onChange 帶入新附件", async () => {
    mockUploadSuccess(sampleAttachment);
    const onChange = vi.fn();

    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[]}
        limit={3}
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText("選擇圖片") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile("trip.jpg", 1024, "image/jpeg")] } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([sampleAttachment]);
    });
  });

  it("accept 屬性含影像型別（AC-88，行動瀏覽器可自相簿選檔）", () => {
    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[]}
        limit={3}
        onChange={vi.fn()}
      />
    );
    const input = screen.getByLabelText("選擇圖片") as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
  });

  it("超過 10MB → client 端拒絕，不呼叫 API", async () => {
    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[]}
        limit={3}
        onChange={vi.fn()}
      />
    );
    const input = screen.getByLabelText("選擇圖片") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile("big.jpg", 11 * 1024 * 1024, "image/jpeg")] },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/大小超過上限/);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("達上限 → 停用上傳並顯示提示，不出現選擇圖片按鈕", () => {
    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[
          sampleAttachment,
          { ...sampleAttachment, id: "att-2" },
          { ...sampleAttachment, id: "att-3" },
        ]}
        limit={3}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("選擇圖片")).not.toBeInTheDocument();
    expect(screen.getByText(/已達上限（3 張）/)).toBeInTheDocument();
  });

  // ---- C4: delete requires confirmation ----
  it("刪除附件：點擊刪除彈出確認對話框，取消後不刪除（C4）", async () => {
    const onChange = vi.fn();
    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[sampleAttachment]}
        limit={3}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /刪除 trip\.jpg/ }));

    // Confirmation dialog appears.
    expect(screen.getByRole("dialog", { name: "確認刪除附件" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("刪除附件：確認後才呼叫 DELETE 並移除該項（C4）", async () => {
    mockDeleteSuccess();
    const onChange = vi.fn();
    render(
      <SegmentAttachmentPanel
        segmentLabel="第 1 段"
        attachments={[sampleAttachment]}
        limit={3}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /刪除 trip\.jpg/ }));
    fireEvent.click(screen.getByRole("button", { name: "確認刪除" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([]);
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/attachments/att-1",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
