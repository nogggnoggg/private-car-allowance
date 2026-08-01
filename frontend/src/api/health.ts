export type HealthStatus = "ok" | "error";
export type DbStatus = "up" | "down";

export interface HealthResponse {
  status: HealthStatus;
  checks: {
    db: DbStatus;
  };
  uptimeSeconds?: number;
  timestamp?: string;
}

export type HealthResult =
  | { kind: "ok"; data: HealthResponse }
  | { kind: "error"; data: HealthResponse }
  | { kind: "unreachable" };

export async function fetchHealth(): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetch("/api/health");
  } catch {
    return { kind: "unreachable" };
  }

  const data = (await response.json()) as HealthResponse;

  if (data.status === "ok") {
    return { kind: "ok", data };
  }
  return { kind: "error", data };
}
