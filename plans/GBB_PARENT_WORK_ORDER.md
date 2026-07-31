# GPT Browser Bridge 專案父工單

## 0. 工單摘要

* **專案名稱**：GPT Browser Bridge
* **專案代號**：`GBB`
* **父包 task_id**：`GBB-PKG-01`
* **看板 queue**：使用下一個未占用的 Q 編號，不預占既有 MR／MP 卡號
* **專案性質**：獨立自動化基礎設施專案
* **目標平台**：Windows 11 本機
* **主要整合**：

  * ORCA CLI
  * OpenCode／Claude／Codex CLI
  * Chrome automation profile
  * CDP `127.0.0.1:9225`
  * Node.js
  * Playwright
  * 網頁版 ChatGPT
* **執行模式**：單線串行，不追求並行
* **決策角色**：指揮塔 Agent 是唯一自動化決策點
* **預估工程量**：

  * 核心 MVP：約 4–6 小時
  * 技能、治理、恢復與 overnight supervisor：約 4–7 小時
  * 完整父包：約 8–13 工時
* **可接受結果**：

  * 明早未全部完成也可以。
  * 必須留下可辨識的進度、測試結果、阻塞原因與可自動恢復的 checkpoint。
  * 不得因追求完成而自動重送 ChatGPT、修改看板或越權操作其他 repo。

---

# 1. 專案目標

建立一個獨立、可版本控制、可被 ORCA 與多種 CLI agent 使用的瀏覽器協作橋接專案。

完成後應支援：

1. 指揮塔建立一個網頁 GPT 審查 job。
2. Sender 將 pack 送入指定 ChatGPT conversation。
3. Watcher 在不占用 LLM agent 的情況下監看回答。
4. 回答完成後保存內容、metadata 與固定格式事件。
5. 指揮塔收到事件後讀取結果並作唯一裁決。
6. Worker、Reviewer、Watcher、Sender 權限分離。
7. ORCA、CLI agent、Chrome 或 watcher 單點崩潰後，可以從 durable checkpoint 繼續。
8. 電腦整夜保持登入且未斷電時，Supervisor 能持續推動尚未完成的施工階段。
9. 若無法安全繼續，必須停在 `NEEDS_HUMAN`，並留下明確晨間摘要。

---

# 2. 明確不保證事項

以下情況無法承諾整夜繼續：

* 電腦關機或斷電。
* Windows 使用者登出。
* 筆電闔蓋導致睡眠或休眠。
* Chrome 帳號被登出或出現 CAPTCHA／驗證牆。
* 網頁 ChatGPT 要求人類確認。
* Git repo 發生來源不明的 dirty／untracked 變更。
* ORCA CLI 本身無法啟動或登入。
* 所有可用施工／審查 agent 額度耗盡。
* 重複錯誤超過本工單允許的自動重試次數。

對這些狀況，正確行為不是猜測或重送，而是：

```text
NEEDS_HUMAN
+ 保存 checkpoint
+ 保存 blocker
+ 明確列出下一個安全操作
```

---

# 3. 不再造輪子的採用策略

## 3.1 直接使用

### Playwright

繼續使用現有已驗證的 `playwright-core` 與 CDP 9225。

### `write-file-atomic`

用於 `reply.md`、`result.json`、`project_state.json` 與 heartbeat 的原子寫入，避免自行重寫暫存檔與 rename 細節。

### Zod

只用於驗證：

* `job.json`
* `result.json`
* `project_state.json`
* agent report schema

### Node.js 內建功能

直接使用：

* `crypto.randomUUID()`
* SHA-256
* `node:test`
* `AbortController`
* `child_process`
* `fs`
* `path`

不得再加入功能重複的套件。

## 3.2 移植設計，不整套導入

### `yxhpy/chatgpt-pro-browser`

只借用：

* Stop 按鈕消失判定。
* 回答文字穩定判定。
* conversation URL 恢復監看。
* timeout 後 resume，而不是重送 prompt。
* generation stalled 判定。

不移植：

* macOS Keychain cookie 解密。
* 自行啟動 Chrome。
* 最後一則 assistant 直接作為 candidate。
* Watcher 按 Copy 按鈕。
* 剪貼簿讀取。
* Pro 專屬登入與方案判斷。

該專案確實已有斷線後依 conversation URL resume、Stop 按鈕與文字穩定判定等功能，但主要平台是 macOS，不能整套直接搬到 Windows。

## 3.3 只做相容性 Spike

### `microsoft/playwright-cli`

它已提供：

* named sessions
* CDP attach
* tab commands
* `run-code --filename`
* session dashboard
* attach／detach

因此不得自行建立 browser session daemon，除非相容性 Spike 證明官方工具不適用。

目前工具仍是 0.1.x 且使用快速更新中的 Playwright 版本，必須固定版本、先測再決定。

## 3.4 明確不採用

MVP 不加入：

* Redis
* BullMQ
* Crawlee
* Stagehand
* Browserless
* Steel Browser
* SQLite
* Playwright MCP
* LLM watcher agent
* CDP filtering proxy
* 自建中央 queue
* 自建 browser daemon

---

# 4. 專案路徑與邊界

## 4.1 Git repo

```text
D:\AIWORK\GPT_BROWSER_BRIDGE\
```

若該路徑已存在：

1. 不得覆寫。
2. 先檢查是否為 Git repo。
3. 產生 inventory report。
4. 若存在來源不明內容，停止並標記 `NEEDS_HUMAN / TARGET_PATH_OCCUPIED`。

## 4.2 Runtime

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\
```

Runtime 不進 Git。

## 4.3 Worktree

```text
D:\AIWORK_WT\GPT_BROWSER_BRIDGE\<TASK_ID>\
```

每張施工子卡使用自己的 worktree。

## 4.4 禁止影響

不得修改：

```text
D:\AIWORK\MEP工程管理系統\
D:\AIWORK\七工契約\
其他既有 Git repo
現有 Chrome 日常使用 profile
現有 ORCA 設定，除非本工單明確允許
```

可以唯讀盤點既有 `gpt_send.mjs`、`gpt_watch.mjs` 等腳本，但：

* 不移動。
* 不刪除。
* 不覆寫。
* 若要使用，複製到新 repo 並記錄來源 hash。

---

# 5. 整體架構

```text
Windows Task Scheduler
        │
        ▼
resume.ps1
        │
        ▼
Supervisor Node process
        │
        ├─ heartbeat
        ├─ checkpoint
        ├─ ORCA health
        ├─ Control Tower terminal health
        └─ crash recovery
                 │
                 ▼
        Control Tower Agent
        唯一自動決策點
                 │
        ┌────────┼────────┐
        ▼        ▼        ▼
      Worker   Reviewer  Browser Action Runner
        │        │          │
        │        │          ├─ send
        │        │          └─ approved continue action
        │        │
        └────────┴──────────────┐
                                ▼
                         Read-only Watcher
                                │
                                ▼
                          ChatGPT Web
                                │
                                ▼
                     reply.md + result.json
                                │
                                ▼
                         Control Tower 裁決
```

---

# 6. Agent 角色

## 6.1 Supervisor

類型：確定性 Node／PowerShell 程序，不使用模型。

職責：

* 保持 heartbeat。
* 檢查 project state。
* 檢查 Control Tower terminal 是否仍存在。
* ORCA 重啟後重新尋找 terminal。
* 必要時重建 Control Tower terminal。
* 將 resume prompt 投遞給 Control Tower。
* 執行有限次重試。
* 產生晨間摘要。

禁止：

* 修改產品程式。
* 判斷測試是否可以忽略。
* 決定通過／退修。
* 自動重送 ChatGPT。
* 自動按 Continue。
* 自動修復 Git 衝突。
* 自動 reset、stash、clean 或刪檔。

## 6.2 Control Tower Agent

建議：

```text
OpenCode CLI
模型：deepseek-v4-flash-free
```

職責：

* 讀取父工單。
* 讀取 `project_state.json`。
* 決定當前下一張子卡。
* 建立 Worker／Reviewer terminal。
* 驗證回報。
* 更新專案 runtime state。
* 決定重試、退修、前進或 `NEEDS_HUMAN`。
* 是唯一可以更新專案子卡狀態的 agent。

禁止：

* 直接修改 source code。
* 直接執行大範圍格式化。
* 直接操作 Browser DOM。
* 修改 MEP 看板。
* 擅自擴張專案目標。

## 6.3 Worker Agent

可用：

* OpenCode
* Claude CLI
* Codex CLI

規則：

* 一張卡一個 Worker。
* 只修改 allowed paths。
* 必須執行測試。
* 必須產生 worker report。
* 必須提交獨立 commit。
* 不得自行更新卡片為通過。

## 6.4 Reviewer Agent

必須和 Worker 不同 agent／不同模型家族。

職責：

* fresh-context 審查。
* 查 allowed paths。
* 查測試。
* 查禁止操作。
* 只能結論：

  * 通過
  * 退修
  * 受阻

禁止：

* 修改程式。
* 幫 Worker 直接修正。
* 擅自擴大審查範圍。

## 6.5 Browser Action Runner

這是瀏覽器寫入角色。

可做：

* fill
* send
* 經指揮塔批准後按 Continue
* 經指揮塔批准後重新開 conversation URL

不可做：

* 判斷是否應繼續。
* 修改 repo。
* 自動重送。
* 更新看板。

## 6.6 Watcher

只能：

* 讀 URL。
* 讀 DOM。
* 讀 assistant message。
* 讀 Stop／錯誤 UI。
* 計算 hash。
* 保存回答。
* 發出結果事件。

不得出現：

```text
.click(
.fill(
.press(
.keyboard
.mouse
.goto(
.newPage(
.bringToFront(
```

`evaluate()` 只能讀 DOM，不得修改。

---

# 7. Agent SKILL 設計

Canonical skills 全部保存在 repo：

```text
skills/
├─ control-tower/
│  └─ SKILL.md
├─ worker/
│  └─ SKILL.md
├─ reviewer/
│  └─ SKILL.md
├─ browser-sender/
│  └─ SKILL.md
├─ browser-watcher/
│  └─ SKILL.md
└─ recovery-supervisor/
   └─ SKILL.md
```

不得先假設 OpenCode、Claude、Codex 或 ORCA 的實際安裝位置。

Phase 1 必須：

1. 執行各 CLI 的 `--help`。
2. 找出各工具官方或本機已使用的 skill／instruction 載入方式。
3. Canonical skill 留在 repo。
4. 依工具建立 adapter、copy 或 symlink。
5. 不把同一份規則手工維護成多份不同版本。

## 7.1 Control Tower SKILL 必含

* 父工單位置。
* state schema。
* 子卡依賴。
* Worker／Reviewer 分離。
* 最大自動重試次數。
* Git 禁止操作。
* Browser 角色分離。
* resume 流程。
* `NEEDS_HUMAN` 條件。
* 晨間摘要格式。

## 7.2 Worker SKILL 必含

輸入：

* task_id
* base commit
* allowed paths
* acceptance gates
* worktree path
* report path

輸出：

```text
worker_report.md
test_report.json
commit_sha
changed_files.txt
```

停止條件：

* allowed path 外出現修改。
* 基礎測試已失敗且與本卡無關。
* repo dirty 歸屬不明。
* 需要 destructive Git 操作。
* 缺少必要依賴或登入。

## 7.3 Reviewer SKILL 必含

* 不相信 Worker 自述。
* 必須以 commit diff、tests、source 為準。
* 查禁止 API。
* 查 runtime 不得進 Git。
* 查 license。
* 查 fail-closed。
* 結論格式固定。

## 7.4 Sender SKILL 必含

* Enter 前取得 baseline。
* prompt hash。
* conversation URL。
* 不得重送同一 attempt。
* 一 conversation 一 active job。
* 發出 job 後不得自行監看。

## 7.5 Watcher SKILL 必含

* candidate index 固定。
* Stop 消失＋hash 穩定。
* 不使用 `last()` 作唯一身分。
* 不操作 Browser。
* timeout 後只 resume。
* 結果先落盤再通知。

## 7.6 Recovery SKILL 必含

* 不重送。
* 不 reset。
* 不 clean。
* 不自行解衝突。
* 只恢復 Supervisor、Control Tower、Worker／Reviewer terminal。
* 每次恢復記錄原因、時間、舊 terminal、新 terminal。

---

# 8. Repo 建議結構

```text
GPT_BROWSER_BRIDGE/
├─ README.md
├─ AGENTS.md
├─ package.json
├─ package-lock.json
├─ THIRD_PARTY_NOTICES.md
├─ .gitignore
│
├─ plans/
│  ├─ GBB_PARENT_WORK_ORDER.md
│  ├─ GBB_001_BOOTSTRAP_SKILLS.md
│  ├─ GBB_002_PLAYWRIGHT_CLI_SPIKE.md
│  ├─ GBB_003_WATCHER_MVP.md
│  ├─ GBB_004_RECOVERY_SUPERVISOR.md
│  └─ GBB_005_PILOT_REVIEW.md
│
├─ skills/
│  ├─ control-tower/SKILL.md
│  ├─ worker/SKILL.md
│  ├─ reviewer/SKILL.md
│  ├─ browser-sender/SKILL.md
│  ├─ browser-watcher/SKILL.md
│  └─ recovery-supervisor/SKILL.md
│
├─ src/
│  ├─ gpt_send.mjs
│  ├─ gpt_watch.mjs
│  ├─ contracts.mjs
│  ├─ result_store.mjs
│  ├─ supervisor.mjs
│  ├─ morning_summary.mjs
│  └─ adapters/
│     ├─ orca_adapter.mjs
│     ├─ browser_adapter.mjs
│     └─ agent_adapter.mjs
│
├─ scripts/
│  ├─ bootstrap.ps1
│  ├─ start-supervisor.ps1
│  ├─ resume.ps1
│  ├─ register-resume-task.ps1
│  ├─ unregister-resume-task.ps1
│  ├─ keep-awake.ps1
│  └─ start-automation-chrome.example.ps1
│
├─ tests/
│  ├─ contracts.test.mjs
│  ├─ baseline.test.mjs
│  ├─ completion.test.mjs
│  ├─ result_store.test.mjs
│  ├─ supervisor.test.mjs
│  └─ recovery.test.mjs
│
├─ fixtures/
│  ├─ chatgpt/
│  └─ orca/
│
└─ docs/
   ├─ ARCHITECTURE.md
   ├─ ORCA_RUNBOOK.md
   ├─ BROWSER_PROTOCOL.md
   ├─ RECOVERY_RUNBOOK.md
   ├─ SECURITY.md
   └─ MORNING_CHECKLIST.md
```

---

# 9. Runtime 結構

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\
├─ state/
│  ├─ project_state.json
│  ├─ heartbeat.json
│  └─ morning_summary.md
│
├─ locks/
│  └─ supervisor.lock
│
├─ jobs/
│  └─ <job_id>/
│     ├─ job.json
│     ├─ reply.md
│     ├─ result.json
│     ├─ watcher.log
│     └─ diagnostics/
│
├─ runs/
│  └─ <run_id>/
│     ├─ dispatch.json
│     ├─ worker_report.md
│     ├─ reviewer_report.md
│     └─ recovery.log
│
├─ events/
│  └─ events.ndjson
│
└─ logs/
   ├─ supervisor.log
   ├─ control_tower.log
   └─ scheduler.log
```

---

# 10. Project State

`project_state.json` 是專案進度唯一真相。

最小範例：

```json
{
  "schema_version": 1,
  "project_id": "GBB-PKG-01",
  "state": "RUNNING",
  "current_task": "GBB-002",
  "current_phase": "SPIKE",
  "attempt": 1,
  "base_commit": "abc123",
  "active_run_id": "GBB-002-A1",
  "active_terminal": {
    "role": "worker",
    "handle": "runtime-scoped-handle",
    "title": "GBB-002-A1-worker"
  },
  "last_checkpoint": "2026-07-31T23:10:00+08:00",
  "last_successful_step": "PLAYWRIGHT_CLI_ATTACHED",
  "next_action": "TEST_DETACH",
  "retry_count": 0,
  "blocked_reason": null,
  "updated_at": "2026-07-31T23:10:00+08:00"
}
```

合法 project states：

```text
INITIALIZING
RUNNING
WAITING_WORKER
WAITING_REVIEWER
WAITING_BROWSER
REWORK
NEEDS_HUMAN
COMPLETED
CANCELLED
```

Supervisor 不得自行把：

```text
NEEDS_HUMAN → RUNNING
```

只有 Control Tower 或人類可以。

---

# 11. 子卡與依賴

```text
GBB-001
  ↓ Reviewer
GBB-002
  ↓ Reviewer
GBB-003
  ↓ Reviewer
GBB-004
  ↓ Reviewer
GBB-005
  ↓ Final Reviewer
GBB-PKG-01 完成
```

不平行施工。

---

# 12. 子卡 GBB-001：Bootstrap、治理與 Skills

## 目標

建立新 repo、runtime、技能契約、agent adapter 盤點與基礎測試。

## Allowed paths

```text
README.md
AGENTS.md
package.json
package-lock.json
.gitignore
THIRD_PARTY_NOTICES.md
plans/**
skills/**
src/contracts.mjs
src/adapters/**
scripts/bootstrap.ps1
tests/contracts.test.mjs
docs/ARCHITECTURE.md
docs/SECURITY.md
```

## 必做

1. 檢查目標路徑。
2. 初始化 Git。
3. 建立初始 repo 結構。
4. 檢查：

   * `node --version`
   * `npm --version`
   * `git --version`
   * `orca --help`
   * `opencode --help`
   * `claude --help`
   * `codex --help`
5. 缺少的 CLI 只能記錄，不得擅自全域安裝。
6. 找出本機 skill／instruction 載入方式。
7. 建立 canonical SKILL。
8. 建立 Zod contracts。
9. 建立 `.gitignore` 排除 runtime、Chrome profile、cookies、logs。
10. 建立第三方使用與 license 紀錄。

## 驗收

* Repo 可重建。
* Skills 有明確角色邊界。
* Contract tests 通過。
* 沒有 credential、cookie 或 runtime 進 Git。
* 未修改其他 repo。
* Reviewer 通過。

### §12 Scope amendment（指揮塔裁定，2026-07-31）

依網頁版 GPT 功能驗收（對話 `https://chatgpt.com/c/6a6cc0dc-3704-83e8-8b1f-ed2a97b9316f`）P1-1/P1-4，正式擴充 §12 allowed paths 與驗收證據要求：

```text
# 新增 allowed paths（追認）
docs/WORKER_REPORT_*.md      # §7.2 明文要求的 worker 產出，repo 內固定報告位置
opencode.json                # 指揮塔治理檔（權限/permission 設定），由指揮塔維護
plans/GBB001_*.md            # 指揮塔審查紀錄（含網頁 GPT 審查紀錄）
```

* `docs/WORKER_REPORT_*.md`、`opencode.json`、`plans/GBB001_*.md` 由指揮塔正式授權，非 Worker 越界。
* 驗收「未修改其他 repo」需在 Worker report 附證據：施工前後各一次 `git status --short` 快照（MEP、七工契約等相關 repo），或說明目標路徑檢查結果。
* 驗收「Repo 可重建」需附乾淨 checkout 實測：`npm ci && npm test` 輸出（GBB-001-A2 補測）。

---

# 13. 子卡 GBB-002：Playwright CLI 相容性 Spike

## 目標

驗證官方 Playwright CLI 是否可取代自建 session daemon。

## 規則

* 固定版本，不使用浮動 `latest` 作正式依賴。
* 不修改 Playwright CLI source。
* Spike 失敗不得阻塞 GBB-003。
* 若不適用，正式記錄 fallback 為現有 direct CDP。

## 測試矩陣

1. attach `127.0.0.1:9225`
2. 不建立第二個 Chrome profile
3. 不關閉外部 Chrome
4. 能列出多個 tabs
5. 能定位指定 conversation URL
6. 能執行只讀 `run-code --filename`
7. 長執行至少 10 分鐘
8. ORCA 可 wait/read stdout
9. detach 後 Chrome 仍存在
10. Page close 行為
11. CDP disconnect 行為
12. CLI 程序 crash 後 session 行為
13. 兩個 tab 是否可能抓錯
14. Dashboard 是否會意外取得寫入控制

## 決策 Gate

### ACCEPT

只有在以下全部成立時：

* attach 穩定
* detach 不殺 Chrome
* 長執行穩定
* 多 tab 定位可信
* ORCA 能追蹤
* 固定版本可重現

### REJECT

任一核心項目失敗：

* 正式架構改用 direct Playwright CDP。
* 不再投入修 Playwright CLI。
* 保留 Spike 報告。

## GBB-002 執行紀錄（Control Tower）

* 施工：attempt 1 = DeepSeek/opencode（兩次 transcript 停滯被棄置，task failed）；attempt 2 = Claude Code（`-p --dangerously-skip-permissions` 非互動模式）。
* Spike 報告：`docs/GBB002_SPIKE_REPORT.md`（worker worktree gbb-002-a2，commits `0acebdf` 初版、`6c507e6` rework）。
* main merges：`8bde172`（初版）、`a2d4b31`（rework）。
* 網頁版 GPT 第一意見（fresh-context Reviewer）：
  * attempt 1 退修（`https://chatgpt.com/c/6a6ce5e6-92a8-83ee-94ba-c5e7067c8a0f`）：Test 11 中途斷線證據不足、Test 13 須維持正式 FAIL、Test 14 升級禁令、Test 10 PARTIAL、Test 6 有限度可信、Gate A–H 擴充。
  * attempt 2 **通過**（`https://chatgpt.com/c/6a6ce922-741c-83e8-b863-b9c9790b6613`）：Test 11 以本機 TCP proxy 補測（`%TEMP%\gbb002-spike2`，`127.0.0.1:19226 → 9225`，kill proxy 模擬中途斷線，驗證無殘缺輸出、session 乾淨移除、可重新 attach、current-tab 重新初始化）；Gate A–H 全數採納。
* 最終判定：**ACCEPT（附條件）**。條件 = Gate A–H（單一受控入口、每次操作重新定位、select 後 URL 二次驗證、失效規則、併發 mutex、Watcher 寫入禁令、Dashboard 全面禁用、斷線恢復/重試規則），並由 GBB-003 實作時落實兩項非阻斷補充：verify/read 的 TOCTOU 防護（固定唯讀 eval 同次呼叫回傳 URL+資料）、timeout 後確認舊 child process 已終止才重試（不得重疊操作）。
* Reviewer 報告：`runs/reviewer_report_gbb002_webgpt_a2.md`（runtime 目錄）。

---

# 14. 子卡 GBB-003：Watcher MVP

## 目標

完成可用的 send／watch／capture／result 流程。

## Allowed paths

```text
src/gpt_send.mjs
src/gpt_watch.mjs
src/contracts.mjs
src/result_store.mjs
tests/baseline.test.mjs
tests/completion.test.mjs
tests/result_store.test.mjs
fixtures/chatgpt/**
docs/BROWSER_PROTOCOL.md
```

## Sender 必做

送出前：

* 讀 assistant count。
* 讀最後舊 assistant hash。
* 計算 prompt SHA-256。
* 設定 attempt。
* 取得唯一 job ID。

送出後：

* 等 conversation URL 出現。
* 寫 immutable `job.json`。
* 不自行監看。

## Watcher 必做

* 依 conversation URL 找 Page。
* candidate index：

  ```text
  baseline.assistant_count
  ```

* 不使用最後一則回答作唯一判定。
* Stop 按鈕存在時不得 DONE。
* Stop 消失後：

  * 至少 3 次相同 hash。
  * 穩定期間至少 15 秒。

* 逾時：

  * 保存 partial。
  * 重新 attach 原 URL。
  * 不重送。

* 偵測：

  * Continue
  * network error
  * login wall
  * odd code fence
  * missing end marker
  * abrupt tail
  * baseline invalid

## Durable output

順序：

```text
write reply.md atomically
→ calculate reply hash
→ write result.json atomically
→ emit stdout event
```

只有 `result.json` 存在才算終態。

## Result states

```text
DONE
NEEDS_DECISION
FAILED
```

## 驗收

* 第 5／第 6 則回答不會混淆。
* 快速回答不漏判。
* 中途停頓不假完成。
* Stop 存在時不完成。
* 斷線不重送。
* 結果 hash 可重算。
* Watcher source 沒有 Browser write API。
* 測試通過。
* Reviewer 通過。

---

# 15. 子卡 GBB-004：Overnight Supervisor 與 Crash Recovery

## 目標

讓專案在 Control Tower、Worker、Reviewer、Watcher 或 ORCA terminal 崩潰後，可以在安全範圍內繼續。

## Allowed paths

```text
src/supervisor.mjs
src/morning_summary.mjs
src/adapters/orca_adapter.mjs
scripts/start-supervisor.ps1
scripts/resume.ps1
scripts/register-resume-task.ps1
scripts/unregister-resume-task.ps1
scripts/keep-awake.ps1
tests/supervisor.test.mjs
tests/recovery.test.mjs
fixtures/orca/**
docs/ORCA_RUNBOOK.md
docs/RECOVERY_RUNBOOK.md
docs/MORNING_CHECKLIST.md
```

## Supervisor loop

每 15 秒：

1. 更新 heartbeat。
2. 確認 lock owner。
3. 讀 project state。
4. 若 `COMPLETED／CANCELLED／NEEDS_HUMAN`：

   * 不啟動新 agent。

5. 檢查 ORCA 是否可用。
6. 檢查 active terminal。
7. 若 terminal handle 失效：

   * 重新 list terminals。
   * 依 terminal title／run ID 尋找。

8. 若找不到：

   * 依 checkpoint 重建該 role terminal。

9. 投遞 resume prompt。
10. 監看 durable report。
11. 將事件交給 Control Tower。
12. 不自行裁決。

## Terminal 命名

```text
GBB-<TASK>-A<ATTEMPT>-control
GBB-<TASK>-A<ATTEMPT>-worker
GBB-<TASK>-A<ATTEMPT>-reviewer
GBB-<TASK>-A<ATTEMPT>-watcher
```

不使用 terminal handle 作永久 ID。

## Retry policy

### Process crash

同一 step：

```text
最多自動重啟 3 次
```

退避：

```text
10 秒
30 秒
120 秒
```

### Agent 任務失敗

同一張卡：

```text
Worker 自動修正 attempt 最多 2 次
```

第 3 次：

```text
NEEDS_HUMAN / REPEATED_REWORK
```

### ORCA 不可用

重試：

```text
30 秒
60 秒
180 秒
300 秒
```

連續 20 分鐘不可用：

```text
NEEDS_HUMAN / ORCA_UNAVAILABLE
```

### Chrome／CDP 不可用

* 不重送。
* 不自行登入。
* 可執行已核准的 automation Chrome 啟動腳本。
* 重開後依 conversation URL 恢復。
* 若登入牆：

  ```text
  NEEDS_HUMAN / AUTH_REQUIRED
  ```

## Windows Task Scheduler

允許建立一個專案專用 Task：

```text
GPT_BROWSER_BRIDGE_RESUME
```

限制：

* 僅在目前使用者登入時執行。
* 不要求管理員權限。
* 每 5 分鐘執行 `resume.ps1`。
* `resume.ps1` 只在 heartbeat stale 時重啟 Supervisor。
* Supervisor lock 防止重複程序。
* 不修改全域 PATH。
* 不修改 Windows Update。
* 不修改防毒。
* 不修改永久電源計畫。

## Keep-awake

允許 `keep-awake.ps1` 在 Supervisor 執行期間呼叫 Windows execution state，暫時阻止系統睡眠。

要求：

* Supervisor 結束時清除 execution state。
* 不永久修改 power plan。
* 不阻止螢幕關閉。
* 筆電闔蓋、斷電與登出仍無法保證繼續。

## Crash recovery matrix

| 故障 | 自動處理 | 不可做 |
| ---- | ---- | ---- |
| Worker CLI crash | 同 worktree 重建 terminal，讀 checkpoint | 不 reset |
| Reviewer crash | 重建 fresh-context reviewer | 不沿用未完成結論 |
| Control Tower crash | 重建 control terminal，投遞 resume prompt | Supervisor 不代替裁決 |
| Watcher crash | 重啟同一 job watcher | 不重送 prompt |
| ORCA restart | 重新列 terminals、找 run ID | 不相信舊 handle |
| Chrome crash | 啟動專用 Chrome、依 URL 恢復 | 不自動重新登入 |
| 網路中斷 | 退避重試 | 不重送 |
| Git dirty | 暫停、寫 attribution report | 不 clean/stash/reset |
| 測試失敗 | 回 Worker 修正 | 不忽略 |
| 重複 crash | NEEDS_HUMAN | 不無限循環 |

## 驗收

必須模擬：

* Supervisor 被 kill。
* Worker terminal 被 kill。
* Control Tower terminal 被 kill。
* Watcher 被 kill。
* ORCA handle 失效。
* heartbeat stale。
* 重複 scheduler invocation。
* Chrome CDP 暫時不可用。
* Git dirty 來源不明。

每項都必須：

* 不遺失 checkpoint。
* 不重送 prompt。
* 不重複建立無限 terminal。
* 不誤標完成。

---

# 16. 子卡 GBB-005：Pilot、Shadow Review 與最終 Gate

## Pilot 建議

使用已有人工作為基準的：

```text
Q128 fresh-context T2 review pack
```

只做 shadow replay。

不得：

* 修改 Q128 看板狀態。
* 把 shadow 結果當正式重新裁決。
* 影響 MR／MP 主線。

## Pilot 流程

1. 建立 fresh conversation。
2. Sender 建 job。
3. Watcher 捕捉回答。
4. 模擬一次 watcher crash。
5. 恢復 watcher。
6. 捕捉完成內容。
7. 驗證 reply hash。
8. 模擬 Control Tower terminal crash。
9. Supervisor 恢復 Control Tower。
10. Control Tower 讀 result。
11. 建立 pilot report。
12. Fresh-context Reviewer 審查整個 package。

## 最終 Gate

必須全部通過：

* 技術測試。
* 權限測試。
* 恢復測試。
* Shadow pilot。
* Git scope。
* License。
* Reviewer。
* 晨間摘要。

---

# 17. Git 與 Worktree 治理

## 每張卡開始前

執行：

```text
git status --short
git diff --name-only
git ls-files
```

記錄：

* base commit
* dirty tracked
* untracked
* worktree path
* allowed paths

若來源不明：

```text
NEEDS_HUMAN / DIRTY_ATTRIBUTION_UNKNOWN
```

## 禁止

```text
git reset --hard
git clean
git stash
force push
刪除不明檔案
移動其他專案檔案
全專案格式化
```

## 每張卡完成

必須產生：

```text
commit SHA
changed_files.txt
test_report.json
worker_report.md
reviewer_report.md
```

## Commit 建議

```text
GBB-001 bootstrap governance and skills
GBB-002 evaluate playwright CLI CDP sessions
GBB-003 implement durable ChatGPT watcher
GBB-004 add supervisor and crash recovery
GBB-005 validate shadow pilot and runbook
```

---

# 18. Security

## CDP

* 只能綁定：

  ```text
  127.0.0.1
  ```

* 不得使用：

  ```text
  0.0.0.0
  ```

* 不得開 Windows Firewall 外部規則。
* 不得把 CDP URL 發送到外部服務。

## Credentials

不得記錄：

* Cookies
* session token
* Authorization header
* Chrome profile 內容
* ChatGPT 帳號資訊

## Logs

可以記錄：

* URL 中的 conversation ID
* page title
* message count
* hashes
* error code
* timestamps

不得預設保存完整 HTML。

## File paths

`output_dir` 必須經驗證，且只能位於：

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\
```

防止 path traversal。

---

# 19. 晨間摘要

無論是否完成，每天早上可依以下檔案判讀：

```text
D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\state\morning_summary.md
```

Supervisor 每次重大事件後更新，最晚每 30 分鐘更新一次。

格式：

```markdown
# GPT Browser Bridge Morning Summary

- generated_at:
- project_state:
- current_task:
- current_attempt:
- last_successful_checkpoint:
- active_processes:
- latest_commit:
- tests:
- reviewer_status:
- browser_status:
- ORCA_status:

## Completed overnight

## In progress

## Automatic recoveries performed

## Blockers

## Human actions required

## Exact resume command

## Files to inspect
```

若專案已完成：

```text
project_state=COMPLETED
```

若未完成但可繼續：

```text
project_state=RUNNING
next_action=<明確步驟>
```

若需要人類：

```text
project_state=NEEDS_HUMAN
blocked_reason=<明確原因>
```

---

# 20. Control Tower 的啟動 Prompt

將以下內容與本父工單一起交給本機 Control Tower：

```text
你是 GPT_BROWSER_BRIDGE 專案的 Control Tower。

你的唯一任務是依 plans/GBB_PARENT_WORK_ORDER.md 串行推進
GBB-001 → Reviewer → GBB-002 → Reviewer → GBB-003 → Reviewer
→ GBB-004 → Reviewer → GBB-005 → Final Reviewer。

硬性規則：

1. 你是唯一自動決策點，但不得直接修改 source code。
2. 每張卡只能有一個 Worker，完成後由不同 agent／不同模型家族 Reviewer 審查。
3. 不平行施工。
4. 不修改 D:\AIWORK\MEP工程管理系統 或其他既有專案。
5. 不 reset、stash、clean、刪除或移動來源不明檔案。
6. 不自動重送網頁 GPT prompt。
7. 不自動按 Continue。
8. Watcher 必須只讀。
9. 所有進度先寫入 durable project_state.json，再輸出 terminal 訊息。
10. terminal handle 不是永久 ID，使用 run_id 與 terminal title 恢復。
11. 同一卡 Worker 自動修正最多兩次；第三次標記 NEEDS_HUMAN。
12. 任何登入牆、CAPTCHA、dirty attribution 不明、權限不足或反覆 crash 都必須 fail closed。
13. 即使今晚未完成，也必須維持 heartbeat、checkpoint 與 morning_summary.md。
14. 如果 Supervisor 或 terminal 曾中斷，先讀 project_state.json、events.ndjson、
    worktree git status 與既有 reports，再決定是否恢復。
15. 不得重複詢問父工單已提供的資訊。

開始時：

A. 執行 GBB-001 的環境盤點。
B. 建立新 repo 與 runtime，不碰其他 repo。
C. 建立 project_state.json。
D. 建立 Supervisor 與 keep-awake 的最小骨架。
E. 再派出第一個 Worker。
```

---

# 21. Reviewer 的最終審查問題

Final Reviewer 必須逐項回答：

1. 是否真的建立在獨立 repo？
2. 是否修改到其他專案？
3. 是否重用了 Playwright／現有腳本／成熟套件？
4. 是否避免自建不必要 daemon／queue／database？
5. Watcher 是否真正沒有 write API？
6. Sender 與 Watcher 是否分離？
7. 是否能防止抓到舊回答？
8. 是否能防止未落盤先通知？
9. 斷線後是否只 resume、不重送？
10. Supervisor 是否只是恢復器，不是決策者？
11. Control Tower 崩潰後是否能依 checkpoint 重建？
12. ORCA 重啟後是否不依賴舊 terminal handle？
13. Task Scheduler 是否防止重複 Supervisor？
14. 是否有 crash-loop 上限？
15. 是否有 `NEEDS_HUMAN` 安全停止？
16. 是否留下 morning summary？
17. 是否有第三方 license 紀錄？
18. Q128 pilot 是否僅為 shadow？
19. 是否所有測試有實際證據？
20. 是否符合「指揮塔是唯一決策點」？

最終結論只允許：

```text
通過
退修
受阻
```

---

# 22. 父包完成定義

只有以下全部成立，`GBB-PKG-01` 才能完成：

* GBB-001 Reviewer 通過。
* GBB-002 有明確 ACCEPT／REJECT 技術決策。
* GBB-003 Reviewer 通過。
* GBB-004 Supervisor recovery tests 通過。
* GBB-005 Shadow pilot 通過。
* Final Reviewer 通過。
* 所有 commit scope 清楚。
* 沒有 credential 進 Git。
* 沒有修改其他 repo。
* 沒有自動重送。
* 沒有自動 Continue。
* 沒有 LLM watcher。
* `morning_summary.md` 可直接供人類判讀。
* `scripts/resume.ps1` 能在 interruption 後安全恢復。
* project state 最終為：

  ```text
  COMPLETED
  ```

---

# 23. 今晚最低成功標準

即使整個父包尚未完成，今晚至少必須達成：

1. 新 repo 已安全建立。
2. 父工單與五張子卡已寫入 repo。
3. `project_state.json` 已建立。
4. Supervisor heartbeat 已運作。
5. `resume.ps1` 已建立。
6. Task Scheduler 設定成功，或已留下不能設定的明確 blocker。
7. Keep-awake 已運作，或明確記錄無法運作原因。
8. GBB-001 已完成或正在施工。
9. 每次 crash 都有 recovery log。
10. `morning_summary.md` 已產生。

如果以上十項完成，即使核心 watcher 明早尚未完成，專案仍屬於：

```text
可持續施工
而不是失去狀態或必須從頭開始
```

這版可直接作為父包工單交給本機 agent。明早優先查看 `morning_summary.md`、`project_state.json`、最新 commit 與 Reviewer report；不要只看 ORCA terminal 是否仍開著。
