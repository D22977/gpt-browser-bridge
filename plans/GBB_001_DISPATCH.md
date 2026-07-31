# GBB-001 派工單（DISPATCH）

> 你是 GPT_BROWSER_BRIDGE 專案的 **GBB-001 Worker**（opencode / deepseek-v4-flash-free）。
> 先讀完本檔再動手。所有規則以父工單 `plans/GBB_PARENT_WORK_ORDER.md` §12（GBB-001）與 §17（Git 治理）為準，本檔是摘要與本 run 的具體指令。

## 0. 你的身分與邊界

- 你只做 **GBB-001：Bootstrap、治理與 Skills**。不碰 GBB-002～GBB-005 的內容。
- 你在 orca worktree `gbb-001-a1` 內施工（branch: `gbb-001-a1`）。
- **禁止修改任何其他 repo**，尤其是 `D:\AIWORK\MEP工程管理系統`、`D:\AIWORK\七工契約`。
- 禁止 `git reset --hard`、`git clean`、`git stash`、force push、刪除不明檔案、移動其他專案檔案。
- 禁止把 credential、cookie、Chrome profile、runtime 路徑送進 Git。
- 你的回報以檔案形式寫出，最後 commit 你的成果。

## 1. GBB-001 Allowed paths（只能動這些）

```
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

注意：`.gitignore`、`plans/`、`src/supervisor.mjs`、`scripts/start-supervisor.ps1`、`scripts/resume.ps1`、`scripts/keep-awake.ps1`、`scripts/register-resume-task.ps1`、`scripts/unregister-resume-task.ps1` 已由 Control Tower 建立。你可以**讀取**，但除了明確在 allowed paths 內的（`.gitignore`、`plans/**`、`scripts/bootstrap.ps1`）外，不得改動。若是必要修正，寫進 worker report 由 Control Tower 裁決。

## 2. 必做事項（依父工單 §12）

1. 確認目標路徑 = 本 worktree（branch `gbb-001-a1`，head `7e939ef`）。
2. 確認 Git 已初始化且工作區乾淨（`git status --short`）。
3. 建立初始 repo 結構中仍缺的部分：
   - `README.md`
   - `AGENTS.md`（本 repo 的施工代理規則）
   - `package.json`（**只能加入父工單 §3.1 允許的套件**：`playwright-core`、`write-file-atomic`、`zod`；不要加功能重複的套件）
   - `package-lock.json`
   - `THIRD_PARTY_NOTICES.md`
   - `docs/ARCHITECTURE.md`
   - `docs/SECURITY.md`
   - `scripts/bootstrap.ps1`
4. 環境盤點（只記錄、不安裝缺者）：
   - `node --version`、`npm --version`、`git --version`
   - `orca --help`、`opencode --help`、`claude --help`、`codex --help`
   - 把結果寫入 repo 內（可在 `docs/ARCHITECTURE.md` 或 `README.md` 的環境段落）。
5. 找出本機 skill／instruction 載入方式（opencode / claude / codex / orca 各自如何載入 skill），並在 `docs/ARCHITECTURE.md` 記錄。
6. 建立 canonical SKILL：`skills/control-tower/SKILL.md`、`skills/worker/SKILL.md`、`skills/reviewer/SKILL.md`、`skills/browser-sender/SKILL.md`、`skills/browser-watcher/SKILL.md`、`skills/recovery-supervisor/SKILL.md`（內容依父工單 §7.1～§7.6）。
7. 建立 Zod contracts：`src/contracts.mjs`（涵蓋 `job.json`、`result.json`、`project_state.json`、agent report schema）。
8. 建立 `src/adapters/**`（可先做 interface/stub 與目錄）。
9. 建立 `tests/contracts.test.mjs`（用 `node:test`，不可引入其他測試框架）。
10. 確認 `.gitignore` 已排除 runtime、Chrome profile、cookies、logs（Control Tower 已建立，檢查即可）。
11. 第三方使用與 license 紀錄寫入 `THIRD_PARTY_NOTICES.md`。

## 3. 完成前驗證

- `node --check` 所有 `.mjs` 檔通過。
- `node --test tests/` 通過（contracts test）。
- `npm install` 成功且 `package-lock.json` 已更新。
- `git status --short` 乾淨（或只剩預期檔案）。
- 沒有 credential／cookie／runtime 進 Git。
- 未修改其他 repo。

## 4. 交付物

- 你的 worker report：寫在 repo 內 `docs/WORKER_REPORT_GBB_001.md`（格式見下）。
- 每個 commit 訊息開頭用 `GBB-001 ...`。
- commit 完成後，把最後一筆 commit SHA 寫進 report。

Worker report 格式：

```markdown
# GBB-001 Worker Report
- run_id: GBB-001-A1
- worker: deepseek-v4-flash-free
- base_commit: <開始時的 HEAD>
- 完成時間: <ISO>
## 完成事項
## 測試結果（node --test 輸出摘要）
## commit 清單（SHA + 訊息）
## 與父工單 §12 的對帳
## 未完成／阻塞／需要 Control Tower 裁決的事項
```

## 5. 停止條件（遇到就停，不要硬做）

- allowed path 外出現修改。
- 基礎測試已失敗且與本卡無關。
- repo dirty 歸屬不明。
- 需要 destructive Git 操作。
- 缺少必要依賴或登入。

遇到停止條件：把情況寫入 `docs/WORKER_REPORT_GBB_001.md`，commit 你的進度（能 commit 的部分），然後輸出最後一行 `GBB-001 WORKER STOPPED: <原因>`。
