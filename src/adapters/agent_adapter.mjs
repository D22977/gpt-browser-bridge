// GPT_BROWSER_BRIDGE - Agent adapter (interface stub, GBB-001)
// Abstracts how a Worker/Reviewer CLI is spawned (opencode / claude / codex) and how
// its durable report is collected. GBB-004 wires this to the ORCA terminal adapter.

export const AGENT_TYPES = Object.freeze(["opencode", "claude", "codex"]);

export class AgentAdapter {
  // Stub — GBB-004.
  async spawnWorker({ taskId, worktreePath, dispatch }) {
    void taskId;
    void worktreePath;
    void dispatch;
    throw new Error("AgentAdapter.spawnWorker: not implemented (GBB-004)");
  }

  // Stub — GBB-004.
  async spawnReviewer({ taskId, worktreePath }) {
    void taskId;
    void worktreePath;
    throw new Error("AgentAdapter.spawnReviewer: not implemented (GBB-004)");
  }

  // Stub — GBB-004.
  async readReport({ runId, reportPath }) {
    void runId;
    void reportPath;
    throw new Error("AgentAdapter.readReport: not implemented (GBB-004)");
  }
}
