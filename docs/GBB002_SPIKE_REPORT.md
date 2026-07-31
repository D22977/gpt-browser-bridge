# GBB-002 Spike Report

- run_id: GBB-002-A2
- worker: claude (Claude Code, attempt 2 — different agent family from attempt 1 / opencode, chosen after opencode stalled post-attach)
- base_commit: 3850788cd32042b854cc22d00b6e1906e1c3132a
- 完成時間: 2026-08-01T02:19:30+08:00（rework：依 web GPT 第一意見退修後修正，補測 Test 11 mid-session disconnect）
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
| 6 | 能執行只讀操作 (`snapshot`／`eval`／`run-code --filename`) | `eval "() => document.title"`、`eval` 讀 DOM 節點數、`run-code --filename readonly_check.mjs`（僅 `page.title()`/`page.url()`） | 三種只讀操作皆成功回傳結果，未觸發任何寫入/點擊/送出動作 | **有限度可信 PASS**（重要區分：本次測試只證明「這次執行的程式碼恰好是唯讀的」，不能證明「`eval`／`run-code` 這兩個指令本身天生唯讀」——兩者都可執行任意 JS，一樣能呼叫 DOM 寫入、`fetch`、`localStorage` 等副作用 API；唯讀與否完全取決於呼叫者傳入的程式碼，CLI 層面沒有任何強制。此區分即為 Gate F 的依據：唯讀保證必須靠上層 whitelist 強制，而非「worker 承諾只讀」） |
| 7 | 長執行至少 10 分鐘 | attach 後於 `17:55:58Z` 記錄 baseline `eval`，等待逾 10 分鐘後於 `18:10:51Z`（`cli list`）與 `18:10:56Z`–`18:11:14Z`（`eval`／`tab-list`／顯式 `tab-select`）重新驗證同一 session | `cli list` 顯示 `gbb002x: status: open`；`eval "() => document.title"` 正常回傳 `"GBB-001 功能驗收通過"`；`tab-list` 確認唯一分頁仍為原 ChatGPT conversation URL；顯式 `tab-select 0` 後再次 `eval` 回傳一致的 `{title, url}`。存活時長 ≥ 15 分鐘（17:55:58Z → 18:11:14Z），daemon (node.exe pid 57272) 全程未中斷 | **PASS** |
| 8 | ORCA 可 wait/read stdout | 每個指令皆為同步前景程序、有明確 exit code；另用 `--json` 測試結構化輸出 | `--json eval` 回傳 `{"result": "\"...\""}`，`EXIT_CODE=0`；一般模式輸出為結構化 Markdown 區塊（`### Result` / `### Error`），可被 ORCA 解析與判斷完成 | **PASS** |
| 9 | detach 後 Chrome 仍存在 | `-s=gbb002 detach` 後 `cli list`（session 消失）+ `curl /json/version`（Chrome 仍在）+ `/json/list`（分頁仍在） | detach 後 session 從清單移除，但 Chrome 進程、CDP 端點、既有分頁（含 detach 前才開的 about:blank）全部保留 | **PASS** |
| 10 | Page close 行為 | `tab-close 0` 關掉 about:blank 分頁 | 關閉後 `tab-list` 自動重新編號，剩餘 ChatGPT 分頁正確變成 `0: (current)`，session 仍可正常 `eval`；未嘗試關閉最後僅存的真實分頁（避免干擾正在使用中的 ChatGPT session） | **PARTIAL**（`tab-close` 對「非目標分頁」的行為正常，但索引會重新編號一事本身就是風險來源；對純 Watcher 而言，可接受的收斂方式**不是**去補測「關閉唯一剩餘分頁」的邊界情境，而是 GBB-003 **必須直接禁用 `tab-close`**——Watcher 沒有正當理由需要關閉任何分頁，禁用即可消除整類風險，見下方 Gate F） |
| 11 | CDP disconnect 行為 | (a) attach 一個不存在的埠 `127.0.0.1:19999` 模擬初始連線失敗；(b) **補測**：在 repo 外（`%TEMP%\gbb002-spike2`，非 repo cwd）架設一個純轉發用的本機 TCP proxy（`127.0.0.1:19226` → `127.0.0.1:9225`，程式碼見 `proxy.mjs`），CLI 透過 proxy attach（`-s=gbb002proxy`），baseline `eval` 成功後，用 `taskkill //PID <proxy_pid> //F` 砍掉 proxy 本身（不動 Chrome/9225），模擬「已連線中途斷線」，再嘗試操作、檢查 session 狀態、重啟 proxy 後再 attach 驗證復原 | (a) 立即回傳 `PlaywrightError: connect ECONNREFUSED`，exit code 1，未污染既有 session 清單——但這**只證明「初始連線失敗」的處理乾淨，不能代表「已連線後中途斷線」也一樣**（原報告的關鍵缺陷）。(b) 補測結果：① proxy 存活時 baseline `eval --json` 正常回傳 `{title, url}`；② 砍掉 proxy 後，`eval` 立即回傳結構化錯誤 `{"isError": true, "error": "The browser 'gbb002proxy' is not open, please run open first"}`，exit code 1，**非掛起、非殘缺 JSON**（`.playwright-cli/` 目錄內只有斷線前的 baseline snapshot/console 檔，無任何殘缺/半寫入輸出）；③ `cli list` 顯示 `gbb002proxy` 已完全從清單消失（乾淨移除，非殘留 zombie 或卡在某個中間狀態）；④ 重啟 proxy 後，以**同一 session 名稱**重新 `attach --cdp http://127.0.0.1:19226`，CLI 回應「Session created」（等同全新 attach，非「resume」），且立即 `eval` 回傳的 `{title, url}` 與 Chrome 實際頁面一致，證明 current-tab 會在重新 attach 時正確重新初始化，不會殘留斷線前的錯誤分頁狀態；⑤ 全程 `curl http://127.0.0.1:9225/json/version` 確認真實 Chrome 完全未受影響 | **PARTIAL → 已補測，維持 PARTIAL 標記但復原行為已驗證**：初始連線失敗（PASS，處理乾淨）＋ mid-session 斷線（本次補測 PASS：無殘缺輸出、session 乾淨移除、重新 attach 可復原、current-tab 正確重新初始化）。標記為 PARTIAL 而非全 PASS 的原因：本次只驗證「proxy 層斷線」這一種斷線模式與一次復原路徑，未涵蓋斷線發生在「操作執行中途」（而非操作前）的競態、也未涵蓋反覆斷線/重連的長期穩定性；Gate D／H 的 invalidation／重試規則即為此殘餘風險的正式收斂 |
| 12 | CLI 程序 crash 後 session 行為 | 用 `wmic` 找到 `gbb002x` daemon 的 node.exe PID，`taskkill //PID <pid> //F` 強制砍掉，再檢查 CDP／分頁／session 清單，最後用同名重新 attach | daemon 被砍後：Chrome/CDP 完全不受影響、原分頁仍在；`cli list` 中 `gbb002x` 自動消失（無殘留 zombie entry）；用同名 `attach` 立即恢復對同一分頁的控制 | **PASS**（自我修復良好；但偵測 crash 本身需要外部 supervisor，CLI 不會主動通知） |
| 13 | 兩個 tab 是否可能抓錯 | 開兩個分頁後直接 `attach`（不指定 target），觀察預設 `current` 分頁 | **關鍵風險**：`attach` 預設把「瀏覽器當下實際 focus/最後操作的分頁」當作 `current`，而非任何固定邏輯（例如固定 index 0 或依 URL）。測試中 `attach` 後 `current` 指到剛開的 `about:blank`，不是原本的 ChatGPT 分頁；必須額外呼叫 `tab-select`／依 URL 比對才能保證定位正確 | **正式 FAIL**（不軟化為「有條件 PASS」）。CLI 本身的預設定位行為在多分頁情境下不可信、會抓錯分頁，這是這顆元件的真實缺陷，必須如實記錄為 FAIL；其可用性完全依賴 GBB-003 在外層強制套用 Gate B／C（每次操作前 `tab-list` 依 canonical URL 重新比對＋`tab-select`＋`location.href` 二次驗證）來緩解，緩解措施的存在不能反過來把底層測試結果美化成 PASS — 詳見決策 Gate 與風險章節 |
| 14 | Dashboard 是否會意外取得寫入控制 | 檢視 `show --help`（未實際啟動，避免開啟本機監聽 port / 互動式 recorder 導致終端卡住或暴露寫入介面） | `show` 支援 `--port`／`--host`（預設 localhost）／`--annotate` 標註模式／`--kill`；文件未見任何內建 auth/token 保護。structurally 存在「若 `--host` 綁定非 localhost 或 port 被曝露，第三方可透過 dashboard 取得互動式操作能力」的風險面，但本次未實際啟動驗證 exploit | **NOT TESTED / 能力風險（capability risk）**。未實測 exploit，因此不能標記任何程度的 PASS；緩解措施也不是「建議」而是**強制禁令**：GBB-003 **絕不可**啟動 `show` 或任何 dashboard server（見 Gate G）。若未來確有需求要用 dashboard，必須作為獨立卡片重新走一次完整安全審查（bind address、認證機制、CSRF、可寫入操作面），不可沿用本次 spike 的 ACCEPT 結論 |

### 長執行結果（Test 7 補充）

- 起點：`2026-07-31T17:55:58Z`，`-s=gbb002x eval "() => document.title"` 回傳正常（baseline）。
- 中途：daemon（`node.exe` pid 57272）全程存活；`%TEMP%\gbb002-spike\.playwright-cli` 最後寫入時間 `01:57:26`（本機時區），與 baseline 後的活動一致，無中斷跡象。
- 複測：`2026-07-31T18:10:51Z` 執行 `cli -s=gbb002x list`，`gbb002x: status: open`，session 未消失。
- 複測：`2026-07-31T18:10:56Z`–`18:10:58Z` 執行 `cli -s=gbb002x eval "() => document.title"`，回傳正常字串 `"GBB-001 功能驗收通過"`，exit code 0。
- 複測：`2026-07-31T18:11:xx` 執行 `cli -s=gbb002x tab-list`，確認唯一分頁仍指向原 ChatGPT conversation URL（`https://chatgpt.com/c/6a6cc7f7-6ec8-83ee-8c86-8fe600980949`），非漂移到其他分頁。
- 依 GBB-003 強制規範（見下方最終判定）額外驗證：先顯式 `tab-select 0`（依既知 URL），再 `eval "() => ({title, url})"`，於 `18:11:14Z` 回傳與 baseline 一致的 title/URL 組合，證明「顯式 tab-select 後操作」路徑同樣穩定。
- **結論：Test 7 PASS**。session 與底層 CDP 連線在無人為介入下，跨 ≥15 分鐘（17:55:58Z → 18:11:14Z）保持穩定、可讀、無需重新 attach。

### CDP 中途斷線補測（Test 11 補充，依 web GPT 退修要求執行）

- 前提：完全在 repo 外執行（cwd = `%TEMP%\gbb002-spike2`，非本 repo），避免 `.playwright-cli/` 寫回 repo；全程未關閉共用 Chrome（9225），僅操作自建的一次性 proxy。
- 架設：`%TEMP%\gbb002-spike2\proxy.mjs`，純 TCP 轉發 `127.0.0.1:19226` → `127.0.0.1:9225`，非修改任何既有元件。啟動後以 `netstat -ano` 確認 proxy PID（36268），並以 `curl http://127.0.0.1:19226/json/version` 確認轉發正常（回傳與直連 9225 相同的 `Chrome/150.0.7871.187`）。
- Baseline：透過 proxy `attach --cdp http://127.0.0.1:19226`（session 名稱 `gbb002proxy`），`eval "() => ({title, url})" --json` 正常回傳目前分頁的 title/url，exit code 0。
- 模擬中途斷線：`taskkill //PID 36268 //F` 砍掉 proxy 本身（不動 Chrome/9225），以 `curl -m 2` 確認 `127.0.0.1:19226` 已無法連線（timeout, exit 28）。
- 斷線後嘗試操作：`eval "() => document.title" --json` 立即回傳結構化錯誤 `{"isError": true, "error": "The browser 'gbb002proxy' is not open, please run open first"}`，exit code 1——**非掛起、非殘缺輸出**。
- 檢查 session 狀態：`cli list` 顯示 `gbb002proxy` 已完全從清單移除（`default`/`gbb002x`/`t1`/`t2` 均不受影響），非殘留 zombie entry、非卡在中間狀態。
- 檢查輸出檔完整性：`.playwright-cli/` 目錄內只有斷線前 baseline 產生的 snapshot/console 檔（時間戳早於 kill 動作），沒有任何斷線後產生的殘缺/半寫入檔案。
- 復原驗證：重新啟動 proxy（新 PID 53500，仍監聽 19226），以**同一 session 名稱** `gbb002proxy` 重新 `attach --cdp http://127.0.0.1:19226`——CLI 回應「Session `gbb002proxy` created」（視為全新建立，非續傳舊狀態），隨即 `eval --json` 回傳的 `{title, url}` 與 Chrome 實際當下頁面一致，證明 current-tab 在重新 attach 時會正確重新初始化，不會殘留斷線前的錯誤分頁狀態。
- 清理：`detach` 該 session、`taskkill` 收掉 proxy 進程；全程以 `curl http://127.0.0.1:9225/json/version` 覆核，確認真實 Chrome/CDP 端點未受任何影響。
- **結論：Test 11 中途斷線行為 PASS（但整體仍標記 PARTIAL）**——本次驗證了「乾淨偵測斷線、無殘缺輸出、session 正確清除、重新 attach 可完整復原、current-tab 正確重新初始化」，但只涵蓋 proxy 層單一斷線模式與一次復原路徑，未涵蓋操作執行中途（而非操作之間）斷線的競態、反覆斷線/重連的長期穩定性，故整體仍列 PARTIAL，殘餘風險交由 Gate D／H 收斂。

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
| 多 tab 定位可信 | ❌ **不成立（CLI 底層行為為 FAIL）** — `attach` 預設抓取瀏覽器當下 focus 分頁，非固定邏輯；僅在 GBB-003 外層強制套用 Gate B／C 緩解措施後，整體系統才可信 | 測試 13 |
| ORCA 能追蹤 | ✅ 成立 | 測試 8，同步前景程序 + 明確 exit code + `--json` 結構化輸出 |
| 固定版本可重現 | ✅ 成立 | `@playwright/cli@0.1.17` / `playwright-core@1.62.0-alpha-...` 版本固定、非 `latest`，且全域安裝路徑明確可重建 |
| 只讀操作可強制 | ⚠️ **有條件成立** — `eval`／`run-code` 本身可執行任意 JS、非天生唯讀，唯讀保證必須靠 Gate F 的 whitelist 強制 | 測試 6 |
| Dashboard 不可意外開啟寫入面 | ⚠️ **未實測，改採強制禁用** — 結構性風險（無內建 auth）已記錄，緩解方式是 Gate G 全面禁止啟動，而非驗證後開放 | 測試 14 |
| 中途斷線可乾淨復原 | ✅ **有條件成立** — 本次補測（proxy kill）證實斷線偵測乾淨、無殘缺輸出、重新 attach 可復原、current-tab 正確重新初始化；但僅涵蓋一種斷線模式與一次復原路徑，長期/反覆斷線的穩定性仍需 Gate D／H 收斂 | 測試 11 |

### 最終判定: **ACCEPT（有條件）**

Playwright CLI（`@playwright/cli` 0.1.17）可作為 GBB-003 Watcher 的 CDP 操作方案。本次 rework 依 web GPT 第一意見退修後修正：Test 13（多 tab 定位）維持正式 **FAIL**，Test 14（dashboard 寫入風險）改列 **NOT TESTED / 能力風險**，Test 10（page close）改列 **PARTIAL**，Test 11（CDP 中途斷線）已補測並改列 **PARTIAL（復原行為已驗證，但涵蓋範圍有限）**，Test 6（唯讀操作）改列 **有限度可信 PASS**。ACCEPT 的成立**完全依賴**以下 GBB-003 強制安全護欄（A–H）被如實實作，而非 Playwright CLI 本身天生安全。

**強制附帶條件（Gate A–H，ACCEPT 的必要前提，非建議）：**

- **A. 單一受控入口**：所有 CLI 呼叫都必須經過 GBB-003 的 wrapper/adapter；業務程式碼**不得**直接呼叫底層的 `tab-select`／`eval`／`snapshot`／`click`／`fill`／`run-code`。
- **B. 每次操作重新定位分頁**：每次操作前執行 `tab-list`，依 GBB-001 canonical conversation URL 比對，要求**恰好一個**符合結果，零個或多個一律 fail-closed；**絕不快取** tab index。
- **C. select 後二次驗證**：`tab-select` 後、任何 `snapshot`／`eval`／寫入操作前，**必須**先讀取 `location.href` 並確認 conversation ID 相符；僅比對 title 不足以採信。
- **D. 失效規則（invalidation）**：daemon crash／重新 attach、CDP 斷線、逾時、非零 exit code、非法 JSON、分頁新增/關閉/導航、session 遺失、CDP 不可達——上述任一情況發生時，**一律**視當前分頁選定為失效，完整重跑 list → match → select → verify 全流程，不可沿用舊選定。
- **E. 併發控制**：所有 tab 操作以 mutex 序列化；不同 agent **不得**共用同一個可變 session 名稱。
- **F. Watcher 唯讀邊界**：禁止 `click`、`fill`、`tab-close`、任意 `run-code`、以及任何具 DOM/storage/navigation/network 副作用的 `eval`；僅允許 whitelist 內的 `snapshot` 與固定的唯讀 `eval` 樣板。此為強制程式碼層邊界，**不是**「worker 承諾只讀」這種口頭約定（依據測試 6：`eval`/`run-code` 本身可執行任意程式碼，唯讀與否無法從 CLI 層保證）。
- **G. Dashboard 全面禁用**：GBB-003 **絕不可**啟動 `show` 或任何 dashboard server（依據測試 14：無內建 auth/token 保護，結構性風險未經 exploit 驗證即不得視為安全）；若未來確有需求，須作為獨立卡片重新走一次完整安全審查（bind address、認證機制、CSRF、可寫入操作面）。
- **H. 斷線復原／重試規則**：讀取類操作在「重新 attach ＋重新定位（B）＋重新驗證（C）」完成後，可有限度重試；**非冪等的寫入操作絕不可在逾時後自動重送**，必須交由呼叫端明確決定是否重試。

**次要建議（非 ACCEPT 阻斷條件，供 GBB-003/GBB-004 設計參考）：**
- 需搭配獨立 supervisor 做健康檢查（見「未解決事項」第 4 點），不可假設 CLI 會主動通知 daemon crash。

## 若 REJECT：fallback 記錄

- 正式架構改用既有 direct Playwright CDP 方案（`C:\Users\Lupun\AppData\Local\Temp\opencode\pw\` 內的 playwright-core 腳本，例如 `gpt_watch.mjs`／`gpt-send.mjs`）。
- 不再投入修 Playwright CLI（規則本就禁止修改其 source）。
- 本報告保留為決策紀錄，供 GBB-003 起手前參考。

## 未解決／阻塞／需要 Control Tower 裁決的事項

1. **多 tab 定位為正式 FAIL（測試 13）**：`attach` 若不顯式指定 target，會抓到瀏覽器當下 focus 的分頁，而非可預期的固定分頁。這是 CLI 本身的真實缺陷，非測試方法問題；GBB-003 **必須**透過 Gate B／C（每次操作前重新 list → match → select → 讀 `location.href` 驗證）緩解，不能只靠「多數情況下不會抓錯」的僥倖。
2. **Dashboard 寫入風險（測試 14）改為強制禁令**：`show --port` 未見內建授權機制，且本次未實測 exploit，因此不能視為「可接受風險」；GBB-003 **必須**完全不啟動 `show`／dashboard（Gate G），未來若要用需獨立安全審查。
3. **CDP 中途斷線（測試 11）已補測，但涵蓋範圍有限**：本次以 `%TEMP%\gbb002-spike2` 下的一次性 TCP proxy（`127.0.0.1:19226` → `127.0.0.1:9225`）驗證了「proxy 被砍」這一種中途斷線模式——結果乾淨（無殘缺輸出、session 正確清除、重新 attach 可復原、current-tab 正確重新初始化）。但未涵蓋：斷線發生在單一操作**執行中途**（而非操作與操作之間）的競態、反覆斷線/重連的長期穩定性、以及多 session 同時斷線的情境。Gate D／H 是這些殘餘風險的正式收斂機制，不是「已完全驗證，無需再管」。
4. **CLI 自身不會主動通知 crash**（測試 12）：daemon 被砍後，`cli list` 會自然反映 session 消失，但這是「下次查詢時才發現」，不是主動 push 通知；若正式導入，仍需要 GBB-004 的 supervisor 機制做健康檢查，不能假設 Playwright CLI 自帶 crash 通知。
5. **Test 10 改列 PARTIAL**：未涵蓋「關閉唯一剩餘真實分頁」的邊界情境（刻意避免以免影響共用中的 ChatGPT 分頁）。對純 Watcher 而言，正確收斂方式不是補測這個邊界情境，而是 GBB-003 直接透過 Gate F 禁用 `tab-close`，從架構上消除這類風險，而非驗證它的邊界行為。
6. **Test 6 改列「有限度可信 PASS」**：唯讀操作的驗證只證明「本次執行的程式碼恰好唯讀」，不代表 `eval`／`run-code` 指令本身天生唯讀；GBB-003 必須靠 Gate F 的 whitelist 在呼叫層強制唯讀邊界。
