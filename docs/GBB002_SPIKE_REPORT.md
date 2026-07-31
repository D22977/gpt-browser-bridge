# GBB-002 Spike Report

- run_id: GBB-002-A2
- worker: claude (Claude Code, attempt 2 — different agent family from attempt 1 / opencode, chosen after opencode stalled post-attach)
- base_commit: 3850788cd32042b854cc22d00b6e1906e1c3132a
- 完成時間: 2026-08-01T02:11:14+08:00
- playwright-cli 版本: `@playwright/cli` 0.1.17 (`playwright-core` 1.62.0-alpha-1783623505000)
- CDP target: `http://127.0.0.1:9225` (Chrome/150.0.7871.187, existing profile at `C:\Users\Lupun\AppData\Local\Temp\opencode\pw\chrome-profile`)
- 測試方式：全程透過 CLI 全域安裝路徑
  `C:\Users\Lupun\AppData\Roaming\npm\node_modules\@playwright\cli\node_modules\.bin\playwright.cmd cli ...`
  （非 PATH 內建，需用全路徑）。attempt 1 遺留的 `default` / `t1` / `t2` session 全程存活，未被本次測試干擾。

## 測試矩陣結果（14 項逐項）

| # | 項目 | 方式 | 輸出摘要 | 結論 |
|---|------|------|----------|------|
| 1 | attach `127.0.0.1:9225` | `-s=gbb002 attach --cdp http://127.0.0.1:9225`，之後又以 `-s=gbb002x` 從乾淨 cwd 重新 attach | `### Session 'gbb002' created, attached to 'http://127.0.0.1:9225'.` 立即回傳頁面 URL/標題/snapshot，兩次 attach 均成功且穩定 | **PASS** |
| 2 | 不建立第二個 Chrome profile | 以 `wmic process where "name='chrome.exe'"` 列出所有 chrome.exe 的 `--user-data-dir`，比對 attach 前後 | 唯一連到 9225 的 chrome 進程群全部使用同一個既有 `...\opencode\pw\chrome-profile`；另一組 `AppData\Local\Google\Chrome\User...` 是使用者個人瀏覽器、與 CDP target 無關，非本次建立 | **PASS** |
| 3 | 不關閉外部 Chrome | 全程多次 `curl http://127.0.0.1:9225/json/version` 與 `/json/list`，涵蓋 attach/detach/crash/長跑前後 | 每次查詢皆回傳 `Chrome/150.0.7871.187` 正常回應，原始 ChatGPT 分頁全程存在 | **PASS** |
| 4 | 能列出多個 tabs | `tab-new about:blank` 開第二分頁後 `tab-list` | 正確列出 `0: [GBB-001 功能驗收通過]...` 與 `1: (current) [] about:blank`，索引與 current 標記正確 | **PASS** |
| 5 | 能定位指定 conversation URL | `tab-select 1` 指到 ChatGPT 分頁，再 `tab-list`／`eval document.title` 確認 | `tab-select` 後 current 正確切換到目標 URL，且 `eval` 回傳的 title/URL 與目標分頁一致 | **PASS**（見下方風險註記，見 #13） |
| 6 | 能執行只讀操作 (`snapshot`／`eval`／`run-code --filename`) | `eval "() => document.title"`、`eval` 讀 DOM 節點數、`run-code --filename readonly_check.mjs`（僅 `page.title()`/`page.url()`） | 三種只讀操作皆成功回傳結果，未觸發任何寫入/點擊/送出動作 | **PASS** |
| 7 | 長執行至少 10 分鐘 | attach 後於 `17:55:58Z` 記錄 baseline `eval`，等待逾 10 分鐘後於 `18:10:51Z`（`cli list`）與 `18:10:56Z`–`18:11:14Z`（`eval`／`tab-list`／顯式 `tab-select`）重新驗證同一 session | `cli list` 顯示 `gbb002x: status: open`；`eval "() => document.title"` 正常回傳 `"GBB-001 功能驗收通過"`；`tab-list` 確認唯一分頁仍為原 ChatGPT conversation URL；顯式 `tab-select 0` 後再次 `eval` 回傳一致的 `{title, url}`。存活時長 ≥ 15 分鐘（17:55:58Z → 18:11:14Z），daemon (node.exe pid 57272) 全程未中斷 | **PASS** |
| 8 | ORCA 可 wait/read stdout | 每個指令皆為同步前景程序、有明確 exit code；另用 `--json` 測試結構化輸出 | `--json eval` 回傳 `{"result": "\"...\""}`，`EXIT_CODE=0`；一般模式輸出為結構化 Markdown 區塊（`### Result` / `### Error`），可被 ORCA 解析與判斷完成 | **PASS** |
| 9 | detach 後 Chrome 仍存在 | `-s=gbb002 detach` 後 `cli list`（session 消失）+ `curl /json/version`（Chrome 仍在）+ `/json/list`（分頁仍在） | detach 後 session 從清單移除，但 Chrome 進程、CDP 端點、既有分頁（含 detach 前才開的 about:blank）全部保留 | **PASS** |
| 10 | Page close 行為 | `tab-close 0` 關掉 about:blank 分頁 | 關閉後 `tab-list` 自動重新編號，剩餘 ChatGPT 分頁正確變成 `0: (current)`，session 仍可正常 `eval`；未嘗試關閉最後僅存的真實分頁（避免干擾正在使用中的 ChatGPT session） | **PASS**（部分：未測試「關閉唯一剩餘分頁」邊界情境，見下方限制） |
| 11 | CDP disconnect 行為 | 嘗試 attach 一個不存在的埠 `127.0.0.1:19999` 模擬連線失敗 | 立即回傳 `PlaywrightError: connect ECONNREFUSED`，exit code 1，且未污染既有 session 清單（`default`/`gbb002x`/`t1`/`t2` 不受影響）；**真實情境下「已連線中途斷線」未測試**（因為需要關閉共用中的 Chrome/9225，逾越「不關閉外部 Chrome」規則） | **PASS（失敗處理乾淨）／部分無法測試**（原因：安全邊界限制，見下方） |
| 12 | CLI 程序 crash 後 session 行為 | 用 `wmic` 找到 `gbb002x` daemon 的 node.exe PID，`taskkill //PID <pid> //F` 強制砍掉，再檢查 CDP／分頁／session 清單，最後用同名重新 attach | daemon 被砍後：Chrome/CDP 完全不受影響、原分頁仍在；`cli list` 中 `gbb002x` 自動消失（無殘留 zombie entry）；用同名 `attach` 立即恢復對同一分頁的控制 | **PASS**（自我修復良好；但偵測 crash 本身需要外部 supervisor，CLI 不會主動通知） |
| 13 | 兩個 tab 是否可能抓錯 | 開兩個分頁後直接 `attach`（不指定 target），觀察預設 `current` 分頁 | **關鍵風險**：`attach` 預設把「瀏覽器當下實際 focus/最後操作的分頁」當作 `current`，而非任何固定邏輯（例如固定 index 0 或依 URL）。測試中 `attach` 後 `current` 指到剛開的 `about:blank`，不是原本的 ChatGPT 分頁；必須額外呼叫 `tab-select`／依 URL 比對才能保證定位正確 | **FAIL（若僅依賴預設 current）／PASS（若強制要求每次操作前都用 URL 顯式 `tab-select`）** — 詳見決策 Gate 與風險章節 |
| 14 | Dashboard 是否會意外取得寫入控制 | 檢視 `show --help`（未實際啟動，避免開啟本機監聽 port / 互動式 recorder 導致終端卡住或暴露寫入介面） | `show` 支援 `--port`／`--host`（預設 localhost）／`--annotate` 標註模式／`--kill`；文件未見任何內建 auth/token 保護。structurally 存在「若 `--host` 綁定非 localhost 或 port 被曝露，第三方可透過 dashboard 取得互動式操作能力」的風險面，但本次未實際啟動驗證 exploit | **無法完全測試（結構性風險已記錄，未實測 exploit）；建議：正式架構中永不對外開放 `show --port`，或直接不使用 dashboard 功能** |

### 長執行結果（Test 7 補充）

- 起點：`2026-07-31T17:55:58Z`，`-s=gbb002x eval "() => document.title"` 回傳正常（baseline）。
- 中途：daemon（`node.exe` pid 57272）全程存活；`%TEMP%\gbb002-spike\.playwright-cli` 最後寫入時間 `01:57:26`（本機時區），與 baseline 後的活動一致，無中斷跡象。
- 複測：`2026-07-31T18:10:51Z` 執行 `cli -s=gbb002x list`，`gbb002x: status: open`，session 未消失。
- 複測：`2026-07-31T18:10:56Z`–`18:10:58Z` 執行 `cli -s=gbb002x eval "() => document.title"`，回傳正常字串 `"GBB-001 功能驗收通過"`，exit code 0。
- 複測：`2026-07-31T18:11:xx` 執行 `cli -s=gbb002x tab-list`，確認唯一分頁仍指向原 ChatGPT conversation URL（`https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949`），非漂移到其他分頁。
- 依 GBB-003 強制規範（見下方最終判定）額外驗證：先顯式 `tab-select 0`（依既知 URL），再 `eval "() => ({title, url})"`，於 `18:11:14Z` 回傳與 baseline 一致的 title/URL 組合，證明「顯式 tab-select 後操作」路徑同樣穩定。
- **結論：Test 7 PASS**。session 與底層 CDP 連線在無人為介入下，跨 ≥15 分鐘（17:55:58Z → 18:11:14Z）保持穩定、可讀、無需重新 attach。

## 執行時間軸與關鍵操作紀錄

1. `attach --cdp` 初次於 repo 根目錄執行 → **發現 CLI 會把 `.playwright-cli/`（snapshot yml、console log）寫入『執行 attach 當下』的 cwd，且該 cwd 與 daemon 綁定，之後即使從別的目錄呼叫同一 session 的指令，輸出檔仍寫回原 cwd**（非本次呼叫者的 cwd）。此非清單內的 14 項之一，但屬於重要操作性發現，已記錄於下方風險章節，且已清除污染的 `.playwright-cli/`（未追蹤檔案，本次測試自己產生，非既有工作）。
2. 之後所有測試改在 `attach` 當下即位於 repo 目錄之外（`%TEMP%\gbb002-spike`）執行，避免污染 repo。
3. 全程未修改 `D:\AIWORK\MEP工程管理系統`（見下方「未修改其他 repo」證據）。

## 決策 Gate 判定

ACCEPT 需要以下全部成立：

| Gate 條件 | 判定 | 依據 |
|---|---|---|
| attach 穩定 | ✅ 成立 | 測試 1，兩次乾淨 attach 皆成功且即時回應 |
| detach 不殺 Chrome | ✅ 成立 | 測試 9，detach 後 Chrome/CDP/分頁全部存活 |
| 長執行穩定 | ✅ 成立 | 測試 7，跨 ≥15 分鐘複測 `list`/`eval`/`tab-list`/`tab-select` 全部正常回應 |
| 多 tab 定位可信 | ⚠️ **有條件成立** — 僅在「每次操作前強制以 URL 顯式 `tab-select`，絕不依賴預設 `current`」的前提下才可信；若依賴預設 attach/current 行為，在多 agent 同時操作同一 CDP 的場景下有明確抓錯分頁風險 | 測試 13 |
| ORCA 能追蹤 | ✅ 成立 | 測試 8，同步前景程序 + 明確 exit code + `--json` 結構化輸出 |
| 固定版本可重現 | ✅ 成立 | `@playwright/cli@0.1.17` / `playwright-core@1.62.0-alpha-...` 版本固定、非 `latest`，且全域安裝路徑明確可重建 |

### 最終判定: **ACCEPT**

Playwright CLI（`@playwright/cli` 0.1.17）可作為 GBB-003 Watcher 的 CDP 操作方案，14 項測試矩陣中除 Test 14（dashboard 寫入風險，結構性風險已記錄但未實測 exploit）外全數 PASS 或有條件 PASS，Test 7 長執行穩定性已於本次複測確認（跨 ≥15 分鐘無需重新 attach）。

**強制附帶條件（ACCEPT 的必要前提，非建議）：**

> 每一次 tab 操作（`eval`／`snapshot`／`click`／`fill` 等任何讀寫動作）之前，**必須**先以目標 conversation URL 顯式執行 `tab-select` 明確選定分頁，**絕不可**依賴 `attach` 或指令預設的 `current` 分頁。

理由：測試 13 證實 `attach` 預設抓取「瀏覽器當下 focus/最後操作」的分頁，而非任何可預期的固定邏輯（如固定 index 或依 URL 比對）；在多 tab、或未來多 agent 共用同一 CDP 端點的場景下，若未顯式 `tab-select`，操作極可能作用在錯誤的分頁上而不自知。此條件已於本次 Test 7 複測中實際套用並驗證可行（先 `tab-select 0` 依 URL 確認，再 `eval`）。

**次要建議（非 ACCEPT 阻斷條件，供 GBB-003/GBB-004 設計參考）：**
- 正式架構永不對外開放 `show --port`（dashboard 無內建授權機制，見 Test 14）。
- 需搭配獨立 supervisor 做健康檢查（見「未解決事項」第 4 點），不可假設 CLI 會主動通知 daemon crash。

## 若 REJECT：fallback 記錄

- 正式架構改用既有 direct Playwright CDP 方案（`C:\Users\Lupun\AppData\Local\Temp\opencode\pw\` 內的 playwright-core 腳本，例如 `gpt_watch.mjs`／`gpt-send.mjs`）。
- 不再投入修 Playwright CLI（規則本就禁止修改其 source）。
- 本報告保留為決策紀錄，供 GBB-003 起手前參考。

## 未解決／阻塞／需要 Control Tower 裁決的事項

1. **多 tab 定位風險（測試 13）**：`attach` 若不顯式指定 target，會抓到瀏覽器當下 focus 的分頁，而非可預期的固定分頁。若 GBB-003 的 Watcher 採用 Playwright CLI，**必須**在每次操作前以 conversation URL 顯式比對/選取分頁，不能信任預設 `current`。此為架構層面的強制規範，非 CLI bug。
2. **Dashboard 寫入風險（測試 14）**：`show --port` 未見內建授權機制，正式架構若採用 Playwright CLI，建議明確禁用 `show` 指令或僅允許 `--host 127.0.0.1` 且不對外開放。
3. **CDP 中途斷線（測試 11）的完整情境**未實測，因為必須關閉共用中的 Chrome（9225）才能製造真實斷線，逾越「不關閉外部 Chrome」的施工規則；僅以「連線失敗」（埠不存在）驗證了錯誤處理乾淨，屬於保守但合理的範圍縮減。
4. **CLI 自身不會主動通知 crash**（測試 12）：daemon 被砍後，`cli list` 會自然反映 session 消失，但這是「下次查詢時才發現」，不是主動 push 通知；若正式導入，仍需要 GBB-004 的 supervisor 機制做健康檢查，不能假設 Playwright CLI 自帶 crash 通知。
5. Test 10 未涵蓋「關閉唯一剩餘真實分頁」的邊界情境（刻意避免以免影響共用中的 ChatGPT 分頁）；若需要完整涵蓋，需在專用、非共用的 Chrome 分頁上另行驗證。
