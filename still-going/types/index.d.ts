export type StillGoingRun = {
  isWorking: boolean;
  turnStartedAt: number;
  lastActionAt: number;
  lastAction: string;
  endedAt: number;
  wasAborted: boolean;
};
export type StillGoingLive = {
  at: number;
  agents: { id: string; label: string; firstSeen: number }[];
  captures: string[];
  freeGb: number | null;
};

declare module "claude-code" {
  interface PluginState {
    "still-going": { run: StillGoingRun; live: StillGoingLive };
  }
}
