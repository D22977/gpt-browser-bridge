# Herdr／桌面執行端操作入口

讀取順序：[AGENTS.md](../AGENTS.md) → [共用交接契約](HANDOFF_CONTRACT.md) →
本文件 → exact dispatch／registry → 本次 executor 的 canonical skill。

本文件供操作 Herdr 的桌面 agent 與 transport 維護者使用；Herdr 程式本身不會因為
GitHub 多了一份 Markdown 就自動讀取或實作規則。admission 必須驗證實際載入方式與 consumer。
操作者、deterministic transport、Worker、Reviewer 的身分分開綁定。

## 1. 先證明入口適用

從 current registry／工單取得 consumer，不靠 workflow 檔名猜方向：

| 交接方向 | 查核 |
| --- | --- |
| GitHub event -> Herdr -> Worker | accepted marker、issue/card/generation/base guards、runner、exact eligibility、prompt admission。 |
| Worker/Reviewer terminal -> Web Control | terminal observer、return request、browser sender、exact ACTIVE target、semantic ACK observer。 |
| review request -> fresh Reviewer | admitted surface、NEW context 證據、request/head binding、結果發布能力、launch/result guard。 |

記錄實際執行的 entrypoint/ref/blob、所用依賴 blob、host/runner/run/job；歷史 PASS 不代表
現在這條程式路徑可用。缺少適用入口時回 Control 綁定 bootstrap，不自行另造服務或改事件格式。

## 2. Fresh executor admission

使用已登錄的本機入口，先做唯讀盤點；目前 CLI 支援的參數須從 live help 確認：

```powershell
herdr --help
herdr agent list
```

對 pane/workspace 操作先讀對應 help 並取得 current workspace；環境變數、logical name、
歷史 pane ID 都不是唯一執行者證據。核對 role、pane/session/process、cwd、base、模型／費用
與 eligibility。零個或多個合格目標時依工單處理，不能猜一個送。

可建立替代 Worker 只在目前工單明確允許時執行；必須記錄新身分，避免重複執行既有任務。
角色 skill adapter 與 canonical 不一致時，直接讀已採納的 canonical；不能默默套用舊規則。
Herdr 與 Worker 使用同一 repo/card/ref 指標，不在 CLI prompt 重建一份工單。

## 3. 單次傳遞與開始證據

1. 重讀 exact card、head、ACTIVE switch、logical action，查完整 receipt/run/local attempt state。
2. 綁定／啟動 child-terminal guard；若需要同一 self-hosted runner，guard 不可佔住子工作所需容量。
3. 依共用契約 §4 判定：first send、duplicate NO_OP、publication-only recovery 或 UNCERTAIN。
4. 對 admitted exact executor 傳遞最小指標；在跨越物理邊界前持久記錄 attempt identity。
5. transport 發布並讀回自己的 delivery receipt；Worker 自己讀 GitHub、核對 scope、
   發布並讀回 CONSUMED_STARTED。工具回傳成功／working 狀態不能替代 Worker 收據。

最小指標形狀：

> Read GitHub directly: repository + issue + exact dispatch receipt/card identity.
> Read AGENTS.md and the current role guide at the admitted ref, then the live card.
> Execute only the bound role/scope; publish and read back the card's required terminal.
> GitHub is authority.

此處 repository／issue／receipt 必須由當前 dispatch 填入；不要貼證據摘要當權威，
也不要為同一已存在 wake 再產生一張內容相同的新 wake。

## 4. Guard 追到 terminal 與交接

- 觀察 exact run/job/process 與 GitHub terminal；只看到 started 不結束責任。
- 子工作早死／取消／跳過／未啟動：在約定期限內發 transport error，附原始原因；
  不代 Worker 或 Reviewer 寫語意結論。
- 收到 terminal 後讀回精確內容，依已授權 return route 送達當前 Control；追到工單要求的
  Control reread/ACK/decision，或記錄明確 unresolved return obligation。
- 每次 authorized repair/review wake 都重新接 guard；讀回失敗不能靠步驟 exit 0 報 PASS。
- 重啟先恢復觀察與未讀回收據；不要重新執行整段帶有 send 的 shell/script。
- Web Control idle／回合結束不是「已決策」。guard 的生命週期、restart 與 target binding
  要有證據，不能只有一個開著的 LLM pane。

## 5. 失敗處理責任

Herdr 執行已授權的有限恢復；新的 scope／路徑採納／世代選擇交 ACTIVE Control。
CONTROL_REQUIRED 不等於 HUMAN_REQUIRED。沒有 consumer 的問題要提供入口盤點、第一個缺口
和可執行修復入口候選，不只回報工具不存在。

不確定送出鎖住該 logical action；不因新 receipt ID、missing ACK 或換世代而解鎖。
登入／權限／帳戶額度等需要人處理時提供最小操作與證據，不要求人搬 Worker／Reviewer 結果。
不得自行花費、升級、取得秘密、merge/release、建立新 Control、或放寬正式 fresh review。

舊 ORCA 操作僅在該 lane 被目前工單選用時讀 [RECOVERY_RUNBOOK.md](RECOVERY_RUNBOOK.md)。
原始機器路徑、重試次數與 runtime schema 是該舊 lane 的實作資料，不是所有 Herdr 任務的預設授權。
