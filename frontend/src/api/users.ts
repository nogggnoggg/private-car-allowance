import { type UserDto, parseApiResponse } from "../types/api.js";

export async function apiGetUsers(): Promise<{ users: UserDto[] }> {
  const res = await fetch("/api/admin/users", {
    credentials: "include",
  });
  return parseApiResponse<{ users: UserDto[] }>(res);
}

export interface CreateUserRequest {
  loginName: string;
  displayName: string;
  employeeNumber?: string;
  temporaryPassword: string;
}

export async function apiCreateUser(data: CreateUserRequest): Promise<{ user: UserDto }> {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return parseApiResponse<{ user: UserDto }>(res);
}

export async function apiDeactivateUser(id: string): Promise<{ user: UserDto }> {
  const res = await fetch(`/api/admin/users/${id}/deactivate`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ user: UserDto }>(res);
}

export async function apiActivateUser(id: string): Promise<{ user: UserDto }> {
  const res = await fetch(`/api/admin/users/${id}/activate`, {
    method: "POST",
    credentials: "include",
  });
  return parseApiResponse<{ user: UserDto }>(res);
}

export async function apiResetPassword(
  id: string,
  temporaryPassword: string
): Promise<{ user: UserDto }> {
  const res = await fetch(`/api/admin/users/${id}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ temporaryPassword }),
  });
  return parseApiResponse<{ user: UserDto }>(res);
}

export async function apiDeleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  await parseApiResponse<{ ok: boolean }>(res);
}
