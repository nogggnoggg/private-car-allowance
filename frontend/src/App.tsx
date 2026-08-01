import { useEffect, useState } from "react";
import type React from "react";
import { type HealthResult, fetchHealth } from "./api/health.js";

export default function App(): React.ReactElement {
  const [health, setHealth] = useState<HealthResult | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => {
        setHealth({ kind: "unreachable" });
      });
  }, []);

  return (
    <div>
      <h1>油資管理系統</h1>
      <HealthDisplay health={health} />
    </div>
  );
}

function HealthDisplay({ health }: { health: HealthResult | null }): React.ReactElement {
  if (health === null) {
    return <p>檢查中…</p>;
  }

  if (health.kind === "unreachable") {
    return <p>無法連線至後端</p>;
  }

  const backendStatus = "後端：正常";
  const dbStatus = health.data.checks.db === "up" ? "資料庫：連線正常" : "資料庫：無法連線";

  return (
    <div>
      <p>{backendStatus}</p>
      <p>{dbStatus}</p>
    </div>
  );
}
