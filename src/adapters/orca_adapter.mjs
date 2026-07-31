// GPT_BROWSER_BRIDGE - ORCA adapter (interface stub, GBB-001)
// GBB-004 implements terminal create/list/read/send/wait and worktree ops against
// the public `orca` CLI (see docs/ARCHITECTURE.md skill loading / environment notes).

// Resolve the orca executable. Prefer $ORCA_CLI_COMMAND when set (Orca exports it for
// managed sessions); otherwise fall back to the public CLI binary discovered on this
// machine. Never guess; report when missing.
export function resolveOrcaCli(env = process.env) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  const fallback = "C:\\Users\\Lupun\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe";
  return fallback;
}

export class OrcaAdapter {
  constructor({ orcaPath = resolveOrcaCli(), runId, runtimeRoot } = {}) {
    this.orcaPath = orcaPath;
    this.runId = runId;
    this.runtimeRoot = runtimeRoot;
  }

  // Stub — GBB-004.
  async listTerminals() {
    throw new Error("OrcaAdapter.listTerminals: not implemented (GBB-004)");
  }

  // Stub — GBB-004.
  async createTerminal({ title, command }) {
    void title;
    void command;
    throw new Error("OrcaAdapter.createTerminal: not implemented (GBB-004)");
  }

  // Stub — GBB-004.
  async readTerminal({ handle, cursor }) {
    void handle;
    void cursor;
    throw new Error("OrcaAdapter.readTerminal: not implemented (GBB-004)");
  }

  // Stub — GBB-004.
  async sendTerminal({ handle, text }) {
    void handle;
    void text;
    throw new Error("OrcaAdapter.sendTerminal: not implemented (GBB-004)");
  }
}
