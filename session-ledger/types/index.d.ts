export type LedgerFile = { path: string; by: string; at: number };
export type LedgerCheck = { what: string; ok: boolean; at: number };
export type LedgerCommit = { hash: string; subject: string; at: number };
export type LedgerRequest = {
  ask: string;
  at: number;
  files: LedgerFile[];
  checks: LedgerCheck[];
  commits: LedgerCommit[];
};

declare module "claude-code" {
  interface PluginState {
    "session-ledger": { requests: LedgerRequest[] };
  }
}
