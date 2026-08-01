import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { AuthProvider } from "../src/context/AuthContext.js";
import AttachmentUploader from "../src/components/AttachmentUploader.js";
import type { AttachmentDto } from "../src/api/attachments.js";

// Helper: create a synthetic File with given size and type
function makeFile(name: string, size: number, type: string): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

const ADMIN_USER = {
  id: "admin-id",
  loginName: "admin",
  displayName: "管理員",
  employeeNumber: null,
  role: "ADMIN" as const,
  isActive: true,
  mustChangePassword: false,
};

function mockMeAsAdmin() {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ user: ADMIN_USER }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockUploadSuccess(attachment: AttachmentDto) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ attachment }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockUploadError(code: string, message: string, status: number) {
  (fetch as Mock).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
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
  originalFilename: "photo.jpg",
  refType: null,
  refId: null,
  previewUrl: "/api/attachments/att-1/thumbnail",
  downloadUrl: "/api/attachments/att-1/content",
};

function renderUploader(initialAttachments: AttachmentDto[] = []) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AttachmentUploader
          refType="TRIP_SEGMENT"
          refId="demo-1"
          limit={3}
          initialAttachments={initialAttachments}
        />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AttachmentUploader", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- 1. 前端先行拒絕：檔案過大 ----
  it("選擇超過 10MB 的檔案 → 顯示大小限制訊息，不發送請求（AC-20）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    const bigFile = makeFile("big.jpg", 11 * 1024 * 1024, "image/jpeg");

    fireEvent.change(input, { target: { files: [bigFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/大小超過上限/);
    });

    // fetch should only have been called for /api/me, NOT for upload
    const uploadCalls = (fetch as Mock).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/api/attachments")
    );
    expect(uploadCalls).toHaveLength(0);
  });

  // ---- 2. 前端先行拒絕：格式不支援 ----
  it("選擇非支援格式（PDF）→ 顯示格式限制訊息，不發送請求（AC-20）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    const pdfFile = makeFile("doc.pdf", 1024, "application/pdf");

    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/格式不支援/);
    });

    const uploadCalls = (fetch as Mock).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/api/attachments")
    );
    expect(uploadCalls).toHaveLength(0);
  });

  // ---- 3. 上傳成功 → 顯示縮圖 ----
  it("上傳合法圖片成功 → 渲染縮圖 img（AC-19）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    const validFile = makeFile("photo.jpg", 1024, "image/jpeg");

    mockUploadSuccess(sampleAttachment);

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      const img = screen.getByRole("img", { name: /photo\.jpg/ });
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "/api/attachments/att-1/thumbnail");
    });
  });

  // ---- 4. 上傳中按鈕 disabled（防重複提交）----
  it("上傳中（fetch 未 resolve）→ 上傳按鈕 disabled（防重複提交）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    const validFile = makeFile("photo.jpg", 1024, "image/jpeg");

    // Mock upload to hang
    (fetch as Mock).mockImplementationOnce(
      (url: string) => {
        if ((url as string).endsWith("/api/attachments") || (url as string).includes("/api/attachments")) {
          return new Promise(() => {});
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
    );

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      const uploadBtn = screen.getByRole("button", { name: /上傳中/ });
      expect(uploadBtn).toBeDisabled();
    });
  });

  // ---- 5. 刪除後項目消失 ----
  it("刪除已上傳項目 → 清單中移除（AC-21）", async () => {
    mockMeAsAdmin();
    renderUploader([sampleAttachment]);

    await waitFor(() => {
      expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    });

    mockDeleteSuccess();

    const deleteBtn = screen.getByRole("button", { name: /刪除.*photo\.jpg/ });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
    });
  });

  // ---- 6. 後端 415 錯誤 → 顯示對應訊息，不誤報成功 ----
  it("後端拒絕（415 UNSUPPORTED_MEDIA_TYPE）→ 顯示錯誤訊息，不誤報成功（AC-20）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    // Pass client validation but be rejected by backend
    const validLookingFile = makeFile("tricky.jpg", 1024, "image/jpeg");

    mockUploadError("UNSUPPORTED_MEDIA_TYPE", "檔案內容格式不支援（非 JPEG/PNG/WebP）。", 415);

    fireEvent.change(input, { target: { files: [validLookingFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/格式不支援|UNSUPPORTED_MEDIA_TYPE|檔案內容/);
    });

    // No thumbnail should appear
    expect(screen.queryByRole("img", { name: /tricky/ })).not.toBeInTheDocument();
  });

  // ---- 7. 後端 413 錯誤 → 顯示對應訊息 ----
  it("後端拒絕（413 PAYLOAD_TOO_LARGE）→ 顯示大小錯誤訊息，不誤報成功（AC-20）", async () => {
    mockMeAsAdmin();
    renderUploader();

    await waitFor(() => {
      expect(screen.getByLabelText(/選擇圖片/)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/選擇圖片/) as HTMLInputElement;
    const validLookingFile = makeFile("big_but_passes_client.jpg", 1024, "image/jpeg");

    mockUploadError("PAYLOAD_TOO_LARGE", "檔案超過大小上限（10 MB）。", 413);

    fireEvent.change(input, { target: { files: [validLookingFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/大小|PAYLOAD_TOO_LARGE|10 MB/);
    });
  });

  // ---- 8. 初始附件清單顯示 ----
  it("傳入 initialAttachments → 渲染現有附件清單（含縮圖和檔名）", async () => {
    mockMeAsAdmin();
    renderUploader([sampleAttachment]);

    await waitFor(() => {
      expect(screen.getByText("photo.jpg")).toBeInTheDocument();
      const img = screen.getByRole("img", { name: /photo\.jpg/ });
      expect(img).toHaveAttribute("src", "/api/attachments/att-1/thumbnail");
    });
  });
});
