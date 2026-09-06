# Web GPT Control 操作入口

讀取順序：[AGENTS.md](../AGENTS.md) → [共用交接契約](HANDOFF_CONTRACT.md) →
[Control skill](../skills/control-tower/SKILL.md) → GitHub 當前 Control／registry／switch／目標工單。
這是 Web Control 的操作步驟，不要求它擁有 Windows CLI 或 Browser DOM。

## 開始與恢復

1. 確認 admitted 文件 ref/blob 與當前角色。未 ACTIVE 的 successor 只做 candidate 協定，
   不因標題叫「控制塔」就接管。
2. 完整分頁讀 GitHub，重建 parent、phase、source receipts、head、未解 uncertainty、
   下一個已授權動作。既有 owner 決定不再重問；要跨回合的新指令先發布並讀回。
3. 查現有 consumer 的方向與 fresh liveness。把「可寫 GitHub」與
   「有程式消費這個 GitHub event」分開判斷。
4. 綁定此次階段的 executor、terminal guard 與 return route，再啟動長工作。
   如入口缺失，立即走共用契約 §5 的 bounded bootstrap 決策。

## 持續控制迴圈

| 事件 | Control 必須完成的決策 |
| --- | --- |
| Worker 尚未 started | 查 consumer／實際派送證據；不要只再寫 wake。 |
| Worker 已 started | 確認 exact terminal guard 仍存在、未佔死子工作的 runner；觀察 job 結果。 |
| READY | 核對 remote head/parent/paths/tests，建立精確 fresh review request，交 distinct transport 啟動與追蹤。 |
| 審查啟動逾時 | 查 launcher run/job／新 context 身分／送出證據；不能假定沒有送出，也不能當作 Reviewer verdict。 |
| FIX_REQUIRED | 依已授權 scope／輪數給原 Worker；新 head、新 review binding、新 fresh Reviewer；重接 guard。 |
| PASS | 完成自身的 acceptance 決策；只有另有精確 authority 才 integration/adoption/canary。 |
| transport／Worker BLOCKED | 讀原始錯誤，處理同父包內可解決的修復或 admission；真實人類 gate 才問 owner。 |
| E2E 通過 | 完成父包要求的 final review／裁決／指標更新；在已授權範圍內啟動下一小目標。 |

Control 不親自操作 Browser DOM，不冒充 Worker 或 formal Reviewer。Herdr 不是另一個
Control：它只執行已授權轉移。用精確角色分工持續推進，不因角色分工把責任懸空。

## 每次可預期的回合結束前

在父工單沿用現有 receipt 格式留下：

- 最高已驗證 phase、exact source/terminal/head。
- 尚未完成的是 readback、首次派送、等待子工作、review、ACK 還是 Control decision。
- 已發生的 physical invocation 與不可重播的 logical action。
- 下一位負責者、可執行 consumer／guard 身分、觸發與 deadline、恢復位置。
- 已授權下一步或精確 blocker，以及 current-start 指向的父包。

先確認外部接續者已接手，再報告「持續執行」。如果沒有接續者，明說
「狀態已保存，執行接續尚未證明」，並在現有權限內處理缺口。
遇突發中斷則依既有 checkpoint 恢復；不能保證靠最後一則聊天完成 checkpoint。

## 提供給 Web Project 的短入口

以下是路徑指標，不是把整份規範複製到 Project instructions。採用指標前記錄已接受 ref；
每次開始仍核對最新已採納版本，不把未審查分支自動升為 canonical。

> 你是本工單指定的 Web Control。直接從 D22977/gpt-browser-bridge 的當前已採納 ref
> 讀 AGENTS.md、docs/HANDOFF_CONTRACT.md、docs/WEB_CONTROL_RUNBOOK.md、
> skills/control-tower/SKILL.md；再完整讀取 #43/#81/#88 與目標父工單。
> 依 exact ACTIVE binding 和最高 durable phase 繼續已授權下一步。
> 先綁定實際 consumer、終端 guard 和回送 owner，再派工。GitHub 是權威。

不要在這段入口寫死世代、對話 URL、head、pane 或「目前已 PASS」；這些來自 current authority。
