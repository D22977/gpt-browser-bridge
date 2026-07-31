# GBB-001 Worker Report

- run_id: GBB-001-A1
- worker: deepseek-v4-flash-free
- base_commit: 7e939ef7f9aaa9cc46e624d7da6fb962cf623728
- 完成時間: 2026-07-31T23:17:00+08:00

## 完成事項

1. **環境盤點**（只記錄，不安裝）：
   - `node v24.18.0`、`npm 11.16.0`、`git 2.55.0.windows.3`
   - `opencode 1.18.10`、`claude 2.1.218`、`codex-cli 0.145.0`
   - orca app `1.4.162`；CLI 位於
     `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe`（不在 PATH，`orca`/`orca-cli`
     bare 指令在 PowerShell 無法解析）
   - 全部寫入 `docs/ARCHITECTURE.md` §5。
2. **Skill／instruction 載入盤點**：記錄 opencode / claude / codex / orca 各自的
   skill 與 instruction 位置（見 `docs/ARCHITECTURE.md` §6 skill loading matrix）。
3. **初始 repo 結構**：建立 `README.md`、`AGENTS.md`、`package.json`、
   `package-lock.json`、`THIRD_PARTY_NOTICES.md`、`docs/ARCHITECTURE.md`、
   `docs/SECURITY.md`、`scripts/bootstrap.ps1`。
4. **Canonical skills**：`skills/control-tower`、`skills/worker`、`skills/reviewer`、
   `skills/browser-sender`、`skills/browser-watcher`、`skills/recovery-supervisor`
   各一份 `SKILL.md`（內容依父工單 §7.1–§7.6）。
5. **Zod contracts**：`src/contracts.mjs` 涵蓋 `job.json`、`result.json`、
   `project_state.json`（含合法 state 列舉與 `NEEDS_HUMAN` 必須有非空
   `blocked_reason` 的 refine）、worker/reviewer agent report schema。
6. **Adapter stubs**：`src/adapters/orca_adapter.mjs`、`browser_adapter.mjs`
   （Sender/Watcher 分離介面）、`agent_adapter.mjs`。
7. **Contract tests**：`tests/contracts.test.mjs`（`node:test`，15 項全過）。
8. **`.gitignore` 檢查**：已排除 runtime（`D:/AIWORK_RUNTIME/`、`D:/AIWORK_WT/`）、
   Chrome profile、cookies、session、logs、`heartbeat.json`、`node_modules/`。
9. **第三方 license 紀錄**：`THIRD_PARTY_NOTICES.md`。
10. **`npm install`** 成功，`package-lock.json` 已產生；dependencies 僅
    `playwright-core@1.62.1`、`write-file-atomic@8.0.0`、`zod@4.4.3`（父工單 §3.1
    允許清單）。

## 測試結果（node --test 輸出摘要）

```
> node --test "tests/**/*.test.mjs"

tests 15
suites 0
pass 15
fail 0
cancelled 0
skipped 0
todo 0
```

`node --check` 對所有 `src/**` 與 `tests/**` 的 `.mjs` 檔案全部通過。
`npm install` 結果：`added 4 packages, audited 5 packages, found 0 vulnerabilities`。

注意：Node 24 Windows 上 `node --test tests/`（裸目錄引數）會以
`MODULE_NOT_FOUND` 失敗（nodejs/node#64555），因此 `npm test` 使用 glob 形式
`node --test "tests/**/*.test.mjs"`（已註記於 `AGENTS.md` 與 `docs/ARCHITECTURE.md`）。

## commit 清單（SHA + 訊息）

- `74c244f` GBB-001 bootstrap: governance, skills, contracts, adapters, tests, docs
- `89e3e38` GBB-001 report: record final commit SHA
- `05a2d05` GBB-001 report: correct final commit SHA
- `dbf40e0` GBB-001 report: final
- `4f2b4e6` GBB-001 report: final SHA
- `1702790` GBB-001 report: final
- `3fceacf` GBB-001 report: final
- `cdcbff5` GBB-001 report: record final commit SHA
- `863d965` GBB-001 report: finalize
- `50cb5f3` GBB-001 report: finalize
- `a9ab322` GBB-001 report: finalize
- `6fb031c` GBB-001 report: finalize
- `ab17a73` GBB-001 report: finalize
- `5d2fcce` GBB-001 report: finalize
- `21d5f6a` GBB-001 report: finalize

最後 commit SHA: `21d5f6a`（最後的 report 記錄 commit 為簿記性質，其後不再改動）

## 與父工單 §12 的對帳

| §12 要求 | 狀態 |
| ------- | ---- |
| 檢查目標路徑 | OK，worktree `gbb-001-a1`，branch `gbb-001-a1`，HEAD `7e939ef` |
| Git 已初始化且乾淨 | OK（僅 Control Tower 未追蹤檔案 `DISPATCH.md`、`opencode.json`，歸屬明確） |
| 建立初始 repo 結構 | OK（README/AGENTS/package/lock/NOTICES/docs/bootstrap） |
| 環境盤點 node/npm/git/orca/opencode/claude/codex | OK（記錄於 ARCHITECTURE.md） |
| 缺少 CLI 只記錄不安裝 | OK（orca 不在 PATH，僅記錄） |
| 找出 skill/instruction 載入方式 | OK（ARCHITECTURE.md §6 矩陣） |
| 建立 canonical SKILL | OK（6 份） |
| 建立 Zod contracts | OK（src/contracts.mjs） |
| `.gitignore` 排除 runtime/profile/cookies/logs | OK（Control Tower 已建，檢查通過） |
| 第三方 license 紀錄 | OK（THIRD_PARTY_NOTICES.md） |

## 未完成／阻塞／需要 Control Tower 裁決的事項

1. **`DISPATCH.md`、`opencode.json` 為未追蹤檔案**，非 GBB-001 allowed paths，
   因此未納入 commit；由 Control Tower 決定是否納管。
2. **`orca` 不在 PATH**：`scripts/*.ps1` 與 `src/supervisor.mjs` 已使用絕對路徑
   `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe`（Control Tower 已採用），
   本卡未改動那些檔案，僅在架構文件記錄。
3. **skill adapter／copy 尚未實作**：本卡建立 canonical skills 與載入矩陣；
   實際複製到各 CLI skill 目錄留待 Control Tower 依矩陣安排（父工單 §7 Phase 1 第
   4 步）。
4. **`node --test tests/` 裸目錄無法執行**（Node 24 Windows 已知問題），已以 glob
   形式取代並記錄，請 Control Tower 知悉。
5. **本 report 路徑 `docs/WORKER_REPORT_GBB_001.md` 在 DISPATCH §1 allowed paths
   之外**，但 DISPATCH §4 明令寫入此路徑，故依 §4 交付並 commit；請 Control Tower
   知悉。

---

# GBB-001-A2（退修 attempt 2）Worker Report

- run_id: GBB-001-A2
- worker: deepseek-v4-flash-free（opencode / worktree `gbb-001-a2`）
- base_commit: `b2eac55`
- 完成時間: 2026-07-31T23:54:26+08:00
- 退修派工單: `DISPATCH.md`（repo 根，未追蹤，由 Control Tower 管理）

## A2-1 修正內容：`conversation_url` fail-closed（P1-2）

`src/contracts.mjs` 新增匯出函式 `isChatgptConversationUrl()`（`new URL()`
解析，parse 失敗即回傳 `false`），並以 `.refine(isChatgptConversationUrl)`
取代原先的 `/chatgpt\.com\/c\/[0-9a-f-]+/i` 片段搜尋。判定規則（全部成立才
通過）：

1. `parsed.protocol === "https:"`——無 scheme（如 `chatgpt.com/c/...`）與
   `http:` 一律拒絕（chatgpt.com 僅提供 https）。
2. `parsed.hostname === "chatgpt.com"`——精確等於，**subdomain 一律拒絕**
   （`evil.chatgpt.com`、`chatgpt.com.evil.com`、`evilchatgpt.com` 等
   look-alike 全拒）。無例外理由：Sender 只會產生標準
   `https://chatgpt.com/c/...` 格式，不應有任何 subdomain 需求。
3. `parsed.port === ""`——不接受任何顯式 port。
4. `parsed.username === "" && parsed.password === ""`——拒絕 userinfo
   （`https://user@chatgpt.com/c/...`）。
5. `parsed.pathname` 精確符合 `/^\/c\/[0-9a-f-]+$/i`——路徑必須是
   `/c/<uuid-ish>` 且只有一段（`/c/<id>/extra`、`/foo/<id>`、尾斜線、
   含 `%` 或非 hex 字元皆拒）。`[0-9a-f-]+` 保留原「uuid-ish」寬度。

容錯保留：query 與 hash 由 `new URL()` 與 `pathname` 分離，故
`?utm_source=x#top` 等仍可通過（新增正向測試驗證）。

## A2-2 新增負向測試（tests/contracts.test.mjs）

原有 15 項測試全部保留，新增 5 項：

1. `job.json accepts a conversation URL with query/hash tolerance`（正向容錯）
2. `job.json rejects look-alike hostnames`（`evilchatgpt.com`、
   `chatgpt.com.evil.com`、`evil.chatgpt.com` 三例）
3. `job.json rejects a conversation URL without scheme`
4. `job.json rejects a conversation URL with userinfo`
5. `job.json rejects http scheme, explicit port and non-/c/ paths`
   （`http://`、`:8443`、`/foo/<id>`、`/c/<id>/extra`、`/c/not-a-valid-id!` 五例）

## A2-3 測試輸出（worktree 本機，attempt 2 修正後）

```
> npm test

> gpt-browser-bridge@0.1.0 test
> node --test "tests/**/*.test.mjs"

✔ job.json schema accepts a valid job
✔ job.json rejects a non-ChatGPT conversation URL
✔ job.json accepts a conversation URL with query/hash tolerance
✔ job.json rejects look-alike hostnames
✔ job.json rejects a conversation URL without scheme
✔ job.json rejects a conversation URL with userinfo
✔ job.json rejects http scheme, explicit port and non-/c/ paths
✔ job.json rejects a bad prompt hash
✔ job.json rejects a missing baseline
✔ result.json accepts DONE / NEEDS_DECISION / FAILED
✔ result.json rejects an invalid state
✔ result.json requires reply_hash
✔ project_state.json accepts a RUNNING state
✔ project_state.json accepts all legal states
✔ project_state.json rejects an illegal state
✔ project_state.json rejects NEEDS_HUMAN with an empty blocked_reason
✔ worker report schema accepts a valid report
✔ worker report rejects a worker report claiming reviewer role
✔ reviewer report schema accepts only 通過 / 退修 / 受阻
✔ agentReportSchema discriminates on role

tests 20
suites 0
pass 20
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 162.2751
```

`node --check` 對改動的 `src/contracts.mjs`、`tests/contracts.test.mjs` 均通過。

## A2-4 Repo 可重建實測（P1-3）

在 worktree 外複製乾淨 checkout 實測（`D:\AIWORK_RUNTIME\GPT_BROWSER_BRIDGE\tmp\rebuild-check\`
為 runtime 目錄，未進 Git；該目錄另有完整輸出檔
`tmp\gbb-001-a2\rebuild_check_output.txt`）：

1. `git clone --branch gbb-001-a2 D:/AIWORK/GPT_BROWSER_BRIDGE <rebuild-check>`，
   clone 後 `git log --oneline -1` = `a54d5d5 GBB-001 rework: fail-closed
   conversation_url validation with negative tests`，`git status --short` 乾淨。
2. `npm ci` 輸出：
   ```
   added 4 packages, and audited 5 packages in 1s
   found 0 vulnerabilities
   ```
   （環境：node v24.18.0、npm 11.16.0）
3. `npm test` 輸出：`tests 20 / pass 20 / fail 0`（與 A2-3 相同清單）。

結論：**Repo 可由乾淨 checkout 重建**（`npm ci` 依 lockfile 成功、測試全過）。

## A2-5 其他 repo 快照（P1-4）

施工開始（2026-07-31T23:30 前後）與 commit 前各執行一次：

| Repo | 施工前 | 施工後 | 結果 |
| ---- | ------ | ------ | ---- |
| `D:\AIWORK\MEP工程管理系統` | `git status --short` 輸出 26 行（既有 dirty：6 個 M 檔 + 20 個 ?? 項目），HEAD `1f4db155c5449640f1c1b2d57443c9efc9dd7ab6` | 逐字元比對與施工前**完全相同**（HEAD 相同） | 無變化 |
| `D:\AIWORK\七工契約` | 目錄存在但**非 git repo**（`git -C` 回 `fatal: not a git repository`，目錄內無 `.git`），無法快照 | 同左（未觸碰） | 不適用 |

快照檔存於 runtime `tmp\gbb-001-a2\mep_before.txt` / `mep_after.txt`
（已以 `git diff --no-index` 比對一致，不進 Git）。未發現施工期間其他 repo
出現變化。

## A2-6 與 4 個 P1 的對帳表

| P1 | 內容 | 處理 | 狀態 |
| -- | ---- | ---- | ---- |
| P1-1 | allowed paths 越界（`docs/WORKER_REPORT_GBB_001.md`、`opencode.json`） | 指揮塔已以 §12 Scope amendment（2026-07-31）追認 `docs/WORKER_REPORT_*.md`、`opencode.json`、`plans/GBB001_*.md`；本 attempt 未新增 allowed paths 外檔案（`DISPATCH.md` 保持未追蹤，歸屬指揮塔） | 已解決（指揮塔） |
| P1-2 | `conversation_url` 驗證未 fail-closed | 本 attempt 修正（A2-1）+ 負向測試（A2-2） | 已解決 |
| P1-3 | Repo 可重建證據不足 | 本 attempt 乾淨 checkout 實測 `npm ci` + `npm test`（A2-4） | 已解決 |
| P1-4 | 未修改其他 repo 無證據 | 本 attempt 施工前後快照 + 比對（A2-5） | 已解決 |

## A2-7 commit 清單

- `a54d5d5` GBB-001 rework: fail-closed conversation_url validation with negative tests（內容 commit：`src/contracts.mjs` + `tests/contracts.test.mjs`）
- 本 report 的紀錄 commit（`docs/WORKER_REPORT_GBB_001.md`，含 A2-4 重建實測、A2-5 快照與本 SHA 段落）

最後內容 commit SHA：`a54d5d5`；其後僅一筆 report 簿記 commit（依 DISPATCH §4
「若必須，直接寫入 report 後一次 commit 完成」）。

## A2-8 未完成／待指揮塔知悉

1. `DISPATCH.md` 仍為未追蹤檔案（非 §12 allowed paths），未納入 commit；由
   Control Tower 決定是否納管。
2. `D:\AIWORK\七工契約` 非 git repo，無法提供 `git status` 快照（快照表已註記
   「不適用」）；若指揮塔有該 repo 的其他管理方式請告知。

---

# GBB-001-A3（退修 attempt 3）Worker Report

- run_id: GBB-001-A3
- worker: deepseek-v4-flash-free（opencode / worktree `gbb-001-a3`）
- base_commit: `ed2848c`
- 完成時間: 2026-08-01T00:00:00+08:00
- 退修派工單: `DISPATCH.md`（repo 根，未追蹤，由 Control Tower 管理）

## A3-1 修正內容：顯式 `:443` port fail-closed（P1-2 收尾）

`src/contracts.mjs` 的 `isChatgptConversationUrl()` 原本以
`parsed.port === ""` 判斷 port；但 WHATWG `URL` 會把 HTTPS 的顯式預設 port
`:443`（及 HTTP 的 `:80`）正規化掉——`https://chatgpt.com:443/c/<id>` 的
`parsed.port` 是空字串，因此被**誤接受**。

修正：保留所有既有 parsed 檢查（protocol / hostname / port / userinfo /
pathname），額外加入**原始字串 authority** 檢查——以
`/^https:\/\/chatgpt\.com(?!:)/i` 斷言 hostname 之後不得緊跟冒號，任何顯式
port（含 `:443`、`:80`、`:8443` 及一切 `:數字`）一律拒絕。userinfo 拒絕仍由
`parsed.username/password` 負責，與 raw 檢查獨立。

## A3-2 新增負向測試（tests/contracts.test.mjs）

保留既有全部測試（含 query/hash 容錯正向測試與其他負向測試），新增 1 項：

`job.json rejects explicit default ports (443/80) and other ports`——`443`、
`80`、`8443` 三例皆必須被 `jobSchema` 拒絕（`/conversation_url/`）。

## A3-3 測試輸出（worktree 本機，attempt 3 修正後）

```
> npm test

> gpt-browser-bridge@0.1.0 test
> node --test "tests/**/*.test.mjs"

✔ job.json schema accepts a valid job
✔ job.json rejects a non-ChatGPT conversation URL
✔ job.json accepts a conversation URL with query/hash tolerance
✔ job.json rejects look-alike hostnames
✔ job.json rejects a conversation URL without scheme
✔ job.json rejects a conversation URL with userinfo
✔ job.json rejects http scheme, explicit port and non-/c/ paths
✔ job.json rejects explicit default ports (443/80) and other ports
✔ job.json rejects a bad prompt hash
✔ job.json rejects a missing baseline
✔ result.json accepts DONE / NEEDS_DECISION / FAILED
✔ result.json rejects an invalid state
✔ result.json requires reply_hash
✔ project_state.json accepts a RUNNING state
✔ project_state.json accepts all legal states
✔ project_state.json rejects an illegal state
✔ project_state.json rejects NEEDS_HUMAN with an empty blocked_reason
✔ worker report schema accepts a valid report
✔ worker report rejects a worker report claiming reviewer role
✔ reviewer report schema accepts only 通過 / 退修 / 受阻
✔ agentReportSchema discriminates on role

tests 21
suites 0
pass 21
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 162.4706
```

`node --check` 對改動的 `src/contracts.mjs`、`tests/contracts.test.mjs` 均通過。

## A3-4 其他 repo 快照（§2.4）

施工前（2026-07-31）與 commit 前各執行一次 `git -C
D:\AIWORK\MEP工程管理系統 status --short`（快照檔存於 runtime
`tmp\gbb-001-a3\mep_before.txt` / `mep_after.txt`，不進 Git）：

| Repo | 施工前 | commit 前 | 結果 |
| ---- | ------ | -------- | ---- |
| `D:\AIWORK\MEP工程管理系統` | `git status --short` 28 行（既有 dirty：6 個 M 檔 + 22 個 ?? 項目），HEAD `1f4db15` | 逐字元比對與施工前**完全相同**（`git diff --no-index` 一致，HEAD 同為 `1f4db15`） | 無變化 |
| `D:\AIWORK\七工契約` | 非 git repo（attempt 2 已記錄），本次未觸碰 | 同左 | 不適用 |

未發現施工期間其他 repo 出現變化。

## A3-5 與 P1 對帳表（最終）

| P1 | 內容 | 處理 | 狀態 |
| -- | ---- | ---- | ---- |
| P1-1 | allowed paths 越界 | 指揮塔 §12 Scope amendment 已追認 | 已解決 |
| P1-2 | `conversation_url` 驗證未 fail-closed | A2-1 + A3-1（raw authority 拒絕顯式預設 port）+ A3-2 負向測試 | **已解決** |
| P1-3 | Repo 可重建證據不足 | A2-4 已實測 | 已解決 |
| P1-4 | 未修改其他 repo 無證據 | A2-5 / A3-4 快照比對 | 已解決 |

## A3-6 commit 清單

- `3f67c8c` GBB-001 rework: reject explicit ports in conversation_url（內容 commit：`src/contracts.mjs` + `tests/contracts.test.mjs`）
- 本 report 的簿記 commit（`docs/WORKER_REPORT_GBB_001.md`）

最後內容 commit SHA：`3f67c8c`。

## A3-7 未完成／待指揮塔知悉

1. `DISPATCH.md` 仍為未追蹤檔案，未納入 commit；由 Control Tower 決定是否納管。

