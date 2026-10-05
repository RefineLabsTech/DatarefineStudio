import { api } from "../ipc/client";

export type DbKind = "postgres" | "mysql" | "sqlite" | "duckdb" | "sqlserver" | "snowflake";

export type SshCfg = {
  enabled: boolean;
  host: string;
  port: string;
  user: string;
  password: string;
  key: string;
};

export type ConnForm = {
  kind: DbKind;
  mode: "host" | "url" | "file";
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  path: string;
  uri: string;
  ssl: boolean;
  ssh: SshCfg;
  query: string;
  table: string;
};

export type SavedConn = {
  id: string;
  name: string;
  color: string;
  savePassword: boolean;
  form: ConnForm;
};

export const KINDS: { id: DbKind; label: string; port: string }[] = [
  { id: "postgres", label: "Postgres", port: "5432" },
  { id: "mysql", label: "MySQL", port: "3306" },
  { id: "sqlserver", label: "SQL Server", port: "1433" },
  { id: "sqlite", label: "SQLite", port: "" },
  { id: "duckdb", label: "DuckDB", port: "" },
  { id: "snowflake", label: "Snowflake", port: "443" },
];

export const COLORS = ["#9ca3af", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"];

export const EMPTY_FORM: ConnForm = {
  kind: "postgres",
  mode: "host",
  host: "localhost",
  port: "5432",
  user: "",
  password: "",
  database: "",
  path: "",
  uri: "",
  ssl: false,
  ssh: { enabled: false, host: "", port: "22", user: "", password: "", key: "" },
  query: "SELECT * FROM my_table LIMIT 1000",
  table: "",
};

export function formToConfig(f: ConnForm): Record<string, unknown> {
  return {
    host: f.host,
    port: f.port,
    user: f.user,
    password: f.password,
    database: f.database,
    path: f.path,
    uri: f.mode === "url" ? f.uri : "",
    ssl: f.ssl,
    ssh: f.ssh.enabled ? { ...f.ssh } : { enabled: false },
  };
}

export function parseDbUrl(raw: string): Partial<ConnForm> {
  const s = raw.trim();
  try {
    const u = new URL(s.replace(/^jdbc:/, ""));
    const proto = u.protocol.replace(":", "").toLowerCase();
    let kind: DbKind = "postgres";
    if (proto.includes("mysql") || proto.includes("mariadb")) kind = "mysql";
    else if (proto.includes("sqlite")) kind = "sqlite";
    else if (proto.includes("duckdb")) kind = "duckdb";
    else if (proto.includes("mssql") || proto.includes("sqlserver")) kind = "sqlserver";
    else if (proto.includes("snowflake")) kind = "snowflake";
    const port = u.port || KINDS.find((k) => k.id === kind)?.port || "";
    return {
      kind,
      mode: kind === "sqlite" || kind === "duckdb" ? "file" : "host",
      host: u.hostname || "localhost",
      port,
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database: decodeURIComponent((u.pathname || "").replace(/^\//, "")),
      uri: s,
      path: kind === "sqlite" || kind === "duckdb" ? decodeURIComponent(u.pathname || "") : "",
    };
  } catch {
    return { uri: s, mode: "url" };
  }
}

export async function loadConnections(): Promise<SavedConn[]> {
  try {
    const s = await api.settings();
    const rows = s.connections;
    return Array.isArray(rows) ? (rows as SavedConn[]) : [];
  } catch {
    return [];
  }
}

export async function saveConnections(rows: SavedConn[]): Promise<void> {
  const s = await api.settings();
  await api.saveSettings({ ...s, connections: rows });
}
