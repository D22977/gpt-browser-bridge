// GPT_BROWSER_BRIDGE - Browser adapter (interface stub, GBB-001)
// Splits the browser surface into a Sender (write) and a Watcher (read-only).
// GBB-002/GBB-003 decide whether this is driven via playwright-core CDP attach
// (127.0.0.1:9225) or the official Playwright CLI spike. Watcher methods must stay
// read-only: no .click/.fill/.press/.goto etc.

// Read-only surface for the Watcher (GBB-003 implements).
export class BrowserWatcher {
  // Stub — GBB-003.
  async attachConversation(url) {
    void url;
    throw new Error("BrowserWatcher.attachConversation: not implemented (GBB-003)");
  }

  // Stub — GBB-003. Read-only; must never write to the DOM.
  async readCandidate({ baselineAssistantCount }) {
    void baselineAssistantCount;
    throw new Error("BrowserWatcher.readCandidate: not implemented (GBB-003)");
  }

  // Stub — GBB-003.
  async stopButtonVisible() {
    throw new Error("BrowserWatcher.stopButtonVisible: not implemented (GBB-003)");
  }

  // Stub — GBB-003. Must never .goto().
  async reattachConversation(url) {
    void url;
    throw new Error("BrowserWatcher.reattachConversation: not implemented (GBB-003)");
  }
}

// Write surface for the Sender (GBB-003 implements). Sender must not watch.
export class BrowserSender {
  // Stub — GBB-003.
  async readBaseline() {
    throw new Error("BrowserSender.readBaseline: not implemented (GBB-003)");
  }

  // Stub — GBB-003.
  async sendPrompt(prompt) {
    void prompt;
    throw new Error("BrowserSender.sendPrompt: not implemented (GBB-003)");
  }

  // Stub — GBB-003.
  async waitConversationUrl() {
    throw new Error("BrowserSender.waitConversationUrl: not implemented (GBB-003)");
  }
}
