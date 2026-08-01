import { type UserDto, parseApiResponse } from "../types/api.js";

export interface LoginRequest {
  loginName: string;
  password: string;
}

export interface LoginResponse {
  user: UserDto;
  redirect: "home" | "change-password-forced";
}

export async function apiLogin(data: LoginRequest): Promise<LoginResponse> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<LoginResponse>(res);
}

export async function apiLogout(): Promise<void> {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  await parseApiResponse<{ ok: boolean }>(res);
}

export async function apiGetMe(): Promise<{ user: UserDto }> {
  const res = await fetch("/api/me", {
    credentials: "include",
  });
  return parseApiResponse<{ user: UserDto }>(res);
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export async function apiChangePassword(data: ChangePasswordRequest): Promise<void> {
  const res = await fetch("/api/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  await parseApiResponse<{ ok: boolean }>(res);
}
