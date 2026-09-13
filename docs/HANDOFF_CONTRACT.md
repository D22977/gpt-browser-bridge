# GBB 共用交接契約

適用：Web Control、桌面端 Herdr 操作者／transport、Worker、Reviewer、Supervisor。
本文件定義交接責任；不會安裝 consumer，也不是任何流程已通過的證據。
候選分支上的修改須完成所需獨立審查與明確採納，才可作為正式指引。

## 1. 共用入口與權威

每個角色先讀 [AGENTS.md](../AGENTS.md)，再讀本文件及自己的角色指南。
Web Control 讀 [WEB_CONTROL_RUNBOOK.md](WEB_CONTROL_RUNBOOK.md)；Herdr 端讀
[HERDR_RUNBOOK.md](HERDR_RUNBOOK.md)。不同角色共用契約，不共用決策權。

1. 本輪明確 owner 指令優先；需要跨回合生效的變更先寫入 GitHub 並讀回。
2. GitHub 上當前、未被取代的 Control 決策與精確工單是執行權威。
3. 從 [#43](https://github.com/D22977/gpt-browser-bridge/issues/43)、
   [#81](https://github.com/D22977/gpt-browser-bridge/issues/81)、
   [#88](https://github.com/D22977/gpt-browser-bridge/issues/88) 找到當前入口、能力登錄與
   ACTIVE switch，再讀目標工單。讀取完整分頁；回寫／送出前重查邏輯 tip、head 與 scope。
4. 後發留言不自動取代所有舊規則。確認作者角色、目標、supersedes 範圍與精確綁定；
   真正衝突回 Control 裁決，不自行選擇最寬鬆的版本。
5. runtime、Project instructions、聊天摘要、HANDOFF、舊父工單都是定位／恢復資料；
   不能覆蓋 GitHub 權威。本機 SENDING／UNCERTAIN 等物理證據也不能因 GitHub 尚無收據而忽略。

使用 admitted canonical ref 的文件。角色 adapter 必須記錄來源 ref/blob，並與實際讀取的
canonical bytes 比對；不一致可直接讀 canonical，不能悄悄使用舊副本或覆寫使用者設定。
固定世代、對話 URL、pane、session、CDP port 與歷史 workflow 名稱均不代表 current liveness。

完整分頁不代表每次把全部歷史留言塞入模型上下文。先列完頁面並按首行 marker、
repo/card/generation、supersession 找出適用 receipts，再精讀這些 receipt 與其必要證據。
保存讀取 checkpoint／tip；同輪未變的 immutable blob 可重用，action 前確認最新 tip 與
可變綁定。避免重複全文重建歷史，耗盡真正派工和接續所需的回合時間。

## 2. 每一段交接先綁定執行者

Control 可以先記錄需求；**要宣告可執行派工，必須先確認 outbound consumer 與終端 guard**。
在同一工單／現有 dispatch schema 記錄以下資訊，缺項明確標示未就緒：

| 必備資訊 | 必須能回答的問題 |
| --- | --- |
| parent、card、phase、authority receipts | 哪個父目標負責到完成？現在處於哪一段？ |
| exact base/head、paths、branch、source terminal | 本次允許操作什麼版本、哪些檔案？ |
| event protocol、logical action、idempotency key | 哪個事件觸發？是否已送過同一動作？ |
| consumer entrypoint、ref/blob、runner／host | 哪個現有程式真正讀這種事件？方向與目標是否適用？ |
| executor role、fresh identity、eligibility rule | 誰執行？pane/session 如何當場確認？ |
| terminal protocol、return target、semantic ACK | 誰回報、回哪裡、誰負責下一個決策？ |
| guard owner、trigger、checkpoint、deadline、restart evidence | Web 回合結束後，誰繼續觀察？程序重啟如何恢復？ |
| bounded recovery、attempt/cost limits、escalation owner | 失敗後可做哪些已授權恢復？何時交 Control／人類？ |

這是既有工單的內容要求，不是新 runtime protocol／資料庫。實際 producer／consumer
必須使用相容的既有 schema；寫了欄位不能當作程式已支援它。

分別驗證 `Control -> Herdr -> Worker`、`terminal -> Control`、`Control -> fresh Reviewer`
三個方向。檔名含 control／bridge 不代表三者都支援。歷史能力 PASS 只需做最小 current
liveness/applicability 檢查；不因 Web tool list 沒有 Herdr 就否定已登錄的外部路徑。
C2C/custom MCP 與 Pro 升級不構成所有 GBB 生產工作的共同前置條件。

## 3. 狀態與責任

只報告證據支持的狀態；transport 的 PASS 不等於 Worker 或產品 PASS。

| 觀察到的狀態 | 當下負責人與下一步 |
| --- | --- |
| CARD_EXISTS | Control 補齊派工與通道 admission；尚未啟動執行。 |
| DISPATCH_REQUEST_WRITTEN | 已綁定的 consumer 讀回、去重、確認 fresh executor，才進行首次物理派送。 |
| SENT／delivery receipt | guard 等 executor 自己發布精確 CONSUMED_STARTED；不能代寫成 Worker 已開工。 |
| CONSUMED_STARTED | Worker 執行；guard 追 exact run/job/session 的 terminal，不只追「開始」。 |
| READY／TERMINAL_RESULT | Worker 停止 mutation 並保留可恢復 identity；guard 送 Control-return，Control 讀回並裁決下一段。 |
| fresh review FIX_REQUIRED | Control／已授權 transition 綁定有限修復給原 Worker；新 head 要新 fresh review。 |
| fresh review PASS | Control 驗證精確 head；依另外的 integration/adoption/canary authority 前進。PASS 本身不授權 merge。 |
| BLOCKED／CONTROL_REQUIRED／STALE | guard 回報具體錯誤；Control 立即處理可解決的綁定、範圍與有限恢復，不預設等 owner 說繼續。 |
| DONE | Control 核對父包全部驗收、必要外部審查與下一步，更新 durable 指標後才結案。 |

Worker 到 READY 停止修改，**父工作不因此停止**。Control 負責從當前階段推進到已授權的
下一小目標；超出 owner 授權範圍時取得決策，不把「持續執行」解讀為無限擴張。

回送完成依精確工單驗證：

`terminal publication + readback -> bound return request -> physical doorbell -> Control reread + semantic ACK -> durable decision -> next admitted transition`

採用工單已定義的 marker／欄位。沒有所需 consumer、ACK 或 guard，就記為缺口，
不能把「通知已寫入」「workflow 綠燈」「沒有新訊息」當成完成。

## 4. 中斷、逾時與不確定送出

- **回合即將結束：** 先保存 phase、未完成動作、exact bindings、最後已讀回 receipt、
  physical boundary、next owner 與 guard/run/deadline。外部 guard 已存在且可恢復，才可聲稱
  無人值守接續；僅有 GitHub checkpoint 只能聲稱狀態可重建。無法保證每輪時間都足夠，
  因此先接 guard，再執行長工作，不將關鍵派工留在最後一句。
- **子工作提早 failed/cancelled/skipped／沒有 job：** guard 同時查 exact run/job 與收據，
  在工單的有限觀察時間內回報原始錯誤，不等一份已死程序不會寫出的留言。
  缺失的是 transport terminal 時由 transport 報告；不得冒充 Worker／Reviewer 的結論。
- **只寫了 wake、確實尚未物理送出：** 保留原 logical action；先重查 GitHub、run、
  本機狀態與進行中的嘗試。正面證據證明未送且 admission 有效，才可執行第一次送出。
  「沒有 CONSUMED_STARTED」本身不是未送證據，也不需要另貼一張重複 wake。
- **SENDING／CLICK／UNCERTAIN：** 鎖住同一物理動作；唯讀查 exact target、marker、
  receipt、run/log。換 comment ID、世代或 key 不能洗掉舊嘗試。不影響有獨立 authority、
  不重播舊副作用的診斷／修復。沒有送達證據也沒有未送證據時交 Control，禁止猜測重送。
- **已送達但 publication/readback 失敗：** 恢復發布與讀回，不重新送 prompt；
  網路中斷時保留 unresolved obligation。缺 receipt 或讀回內容不符均不能記 readback PASS。
- **重啟／換代：** 重讀當前權威和 exact phase；重建 guard，不重播已執行的 physical step。
  舊 Control 保持 ACTIVE 直到 successor rehydration、ACK、所需 canary、atomic switch；
  retired wake 為 NO_OP_RETIRED。已未送的工作需明確 rebinding；uncertain 歷史仍受鎖定。

## 5. 修復啟動通道，避免循環依賴

當 dispatch 所需 consumer 缺失，Control 在同一父包內完成下列判斷：

1. 列出現有 admitted 入口的方向、event、target、執行權限及 current liveness；
   搜尋沒命中不能單獨證明所有入口不存在。
2. 有可用且已授權的現成路徑：綁定到同一未完成 obligation 並繼續。
3. 需要小修：綁定**能實際啟動的**獨立修復 executor／入口、exact base、paths、
   terminal、guard 與有限權限。Control 作決策，Worker 作修改；修復入口不能依賴正在修的壞入口。
4. 目前 scope 不涵蓋該修改：Control 在 owner 授權範圍內發精確 amendment／子步驟，
   不偷偷擴權、不換父包、不再造 router/service/scheduler/control plane。
5. 只有逐一檢查後無可用執行入口、外部登入／權限必須人處理、超出費用／修復額度，
   或真正重大產品／架構決策，才提最小 HUMAN_REQUIRED。不要要求 owner 搬運結果。

CONTROL_REQUIRED 是給 Control 的工作，不是自動丟給人類的終點。Advisory review 也需要
可用的獨立入口、有限 scope 與回傳 owner；審查 launcher 壞掉時，不可無限遞迴開審查。

## 6. 驗收分開，責任連續

文件一致性、Worker 實作、fresh review、路徑採納、live E2E、未來 migration/deletion 各自驗收。
正常路徑 PASS 不能替代 abrupt turn-end／process restart 測試。最終證據要指出**實際執行**
的 workflow/sender/dependency blobs、精確 ACTIVE target、semantic ACK 和後續合法動作。
需要的每輪 fresh Reviewer 由真正新 context 自行讀 GitHub、發布並讀回；內部文件檢查不是正式審查。

本契約不解除任何舊 UNCERTAIN，不授權 merge/release、帳戶升級、秘密取得、新世代啟用或
生產遷移。對現有事件的適用範圍與採納時點由當前 durable authority 精確綁定。
