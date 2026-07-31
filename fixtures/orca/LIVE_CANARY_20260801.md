# GBB-004 real ORCA terminal canary transcript

- Date/time: 2026-08-01 04:35-04:37 Asia/Taipei
- CLI: `C:\Users\Lupun\AppData\Local\Programs\orca\resources\bin\orca.exe`
- Run inspected only: `run_add39e4fbd37`
- Worktree selector used for writes: `path:C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1`
- Disposable title: `GBB-004-CANARY-20260801-043651-8f881525`
- Result: PASS; both canary incarnations were absent from the final fresh list.

Unrelated terminal previews and unrelated task bodies are omitted from this
committed transcript to comply with `docs/SECURITY.md`. Commands, exit codes,
canary stdout/stderr, envelope shapes, handles and parse decisions are retained.

## Preflight and real output shape

```text
COMMAND: orca orchestration terminal list --json
EXIT_CODE: 1
STDOUT_STDERR:
{"id":"local","ok":false,"error":{"code":"invalid_argument","message":"Unknown command: orchestration terminal list"},"_meta":{"runtimeId":null}}
PARSE_RESULT: this installed CLI exposes terminal commands at top level.

COMMAND: orca orchestration run-list --json
EXIT_CODE: 0
STDOUT_STDERR: JSON envelope keys=id,ok,result,_meta; result.runs contains
  id=run_add39e4fbd37
  objective=GBB-PKG-01: GPT Browser Bridge parent package. Serial GBB-001..005 with reviewer gates.
  coordinator_handle=term_6c479a7c-d622-458b-bd95-48a61863f9ca
PARSE_RESULT: requested run exists; it was inspected only.

COMMAND: orca orchestration task-list --run run_add39e4fbd37 --json
EXIT_CODE: 0
STDOUT_STDERR: JSON envelope keys=id,ok,result,_meta; result.runId=run_add39e4fbd37,
  result.count=7, GBB-004 task id=task_b0fed781dc09 status=ready.
PARSE_RESULT: no task-update or other mutation was called.

COMMANDS: orca orchestration terminal create|send|read|close --help
EXIT_CODE: 1 for each
STDOUT_STDERR: "Unknown command: orchestration terminal <verb>" followed by help
  listing `terminal list/create/send/read/close` as top-level commands.
PARSE_RESULT: production adapter's top-level `terminal` argv is correct.

COMMAND: orca worktree current --json
EXIT_CODE: 1
STDOUT_STDERR:
{"id":"local","ok":false,"error":{"code":"selector_not_found","message":"No Orca-managed worktree contains the current directory: C:\\Users\\Lupun\\orca\\workspaces\\GPT_BROWSER_BRIDGE\\gbb-004-a1"},"_meta":{"runtimeId":null}}

COMMAND: orca worktree list --limit 100 --json
EXIT_CODE: 0
STDOUT_STDERR: JSON envelope; the list includes the exact worktree id ending in
  `C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1`.
PARSE_RESULT: use an explicit `path:` selector rather than `active` from this shell.

COMMAND: orca terminal create --worktree active --title GBB-004-CANARY-20260801-043526-7027bc32 --command <token-only PowerShell> --json
EXIT_CODE: 1
STDOUT_STDERR: ok=false, error.code=selector_not_found; no terminal was created.
```

The actual step-1 list was scoped to the explicit canary worktree. Its raw
unrelated preview was not retained:

```text
COMMAND: orca terminal list --worktree path:C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1 --json
EXIT_CODE: 0
PARSE_RESULT: ok=True; envelope_keys=id,ok,result,_meta;
  result_keys=terminals,visualLayouts,topologyRevisions,totalCount,truncated;
  terminal_count=1 before canary creation.
```

## Create, send, read and checkpoint

```text
COMMAND: orca terminal create --worktree path:C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1 --title GBB-004-CANARY-20260801-043651-8f881525 --command <prints CANARY-BOOT-8f881525 and remains open> --json
EXIT_CODE: 0
STDOUT_STDERR:
{"ok":true,"result":{"terminal":{"handle":"term_d71b3f39-4f7f-42c8-b2ef-516d15769d38","tabId":"c87981f1-cbc4-445f-9319-f44c27106f97","worktreeId":"0a31e451-d937-43f2-8a8a-60f00ee4d490::C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1","title":"GBB-004-CANARY-20260801-043651-8f881525","hostPlatform":"win32","surface":"visible"}}}
PARSE_RESULT: result.terminal.handle=term_d71b3f39-4f7f-42c8-b2ef-516d15769d38

COMMAND: orca terminal send --terminal term_d71b3f39-4f7f-42c8-b2ef-516d15769d38 --text "Write-Output 'CANARY-SEND-8f881525'" --enter --json
EXIT_CODE: 0
STDOUT_STDERR:
{"ok":true,"result":{"send":{"handle":"term_d71b3f39-4f7f-42c8-b2ef-516d15769d38","accepted":true,"bytesWritten":36}}}
PARSE_RESULT: accepted=True

COMMAND: orca terminal read --terminal term_d71b3f39-4f7f-42c8-b2ef-516d15769d38 --limit 200 --json
EXIT_CODE: 0
STDOUT_STDERR result.terminal:
  status=running
  tail contains CANARY-BOOT-8f881525
  tail contains CANARY-SEND-8f881525
  returnedLineCount=9, truncated=false, limited=false
PARSE_RESULT: boot_token_seen=True send_token_seen=True
```

Checkpoint recorded after successful delivery (the `run_id/task_id/attempt/
worktree/roles` core is accepted by the Supervisor dispatch schema):

```json
{
  "run_id": "run_add39e4fbd37",
  "task_id": "GBB-004-CANARY",
  "attempt": 1,
  "worktree": "C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1",
  "roles": {
    "control": {
      "title": "GBB-004-CANARY-20260801-043651-8f881525",
      "command": "powershell.exe -NoProfile -NoExit -Command \"Write-Output 'CANARY-BOOT-8f881525'\"",
      "worktree": "C:/Users/Lupun/orca/workspaces/GPT_BROWSER_BRIDGE/gbb-004-a1"
    }
  },
  "active_terminal": {
    "role": "control",
    "handle": "term_d71b3f39-4f7f-42c8-b2ef-516d15769d38",
    "title": "GBB-004-CANARY-20260801-043651-8f881525"
  },
  "last_checkpoint": "2026-08-01T04:36:56.7413812+08:00"
}
```

## Handle invalidation, production re-resolution and resume delivery

```text
COMMAND: orca terminal close --terminal term_d71b3f39-4f7f-42c8-b2ef-516d15769d38 --tab --json
EXIT_CODE: 1
STDOUT_STDERR: ok=false, error.code=runtime_error, error.message=tab_not_found

COMMAND: orca terminal close --terminal term_d71b3f39-4f7f-42c8-b2ef-516d15769d38 --json
EXIT_CODE: 1
STDOUT_STDERR: ok=false, error.code=runtime_error, error.message=tab_not_found

COMMAND: orca terminal list --worktree <explicit selector> --json
EXIT_CODE: 0
PARSE_RESULT: exact title/handle matches=0. Despite the close response, the
  terminal was removed. Fresh list is authoritative.

COMMAND: node --input-type=module -e <imports OrcaAdapter and resolveActiveTerminal; real list> <orca> <title> <old-handle> <selector>
EXIT_CODE: 0
STDOUT_STDERR:
{"terminal_count":1,"result":{"found":false,"terminal":null,"method":"none"}}
PARSE_RESULT: expected not-found confirmed.

COMMAND: orca terminal create --worktree <explicit selector> --title GBB-004-CANARY-20260801-043651-8f881525 --command <same token-only PowerShell> --json
EXIT_CODE: 0
STDOUT_STDERR:
{"ok":true,"result":{"terminal":{"handle":"term_b1a24540-7dbc-4c69-be49-d29890296d9f","tabId":"fe3fae69-199a-4830-8631-73bda240fa17","title":"GBB-004-CANARY-20260801-043651-8f881525","hostPlatform":"win32"}}}
PARSE_RESULT: old_handle_changed=True

COMMAND: node --input-type=module -e <same production resolve script> <orca> <title> <old-handle> <selector>
EXIT_CODE: 0
STDOUT_STDERR:
{"terminal_count":2,"result":{"found":true,"terminal":{"handle":"term_b1a24540-7dbc-4c69-be49-d29890296d9f","title":"GBB-004-CANARY-20260801-043651-8f881525","connected":true,"writable":true},"method":"title"}}
PARSE_RESULT: found=True method=title resolved_handle=term_b1a24540-7dbc-4c69-be49-d29890296d9f

COMMAND: orca terminal send --terminal term_b1a24540-7dbc-4c69-be49-d29890296d9f --text "Write-Output 'CANARY-RESUME-8f881525'" --enter --json
EXIT_CODE: 0
STDOUT_STDERR: ok=true, result.send.accepted=true, bytesWritten=38

COMMAND: orca terminal read --terminal term_b1a24540-7dbc-4c69-be49-d29890296d9f --limit 200 --json
EXIT_CODE: 0
STDOUT_STDERR result.terminal.tail contains CANARY-BOOT-8f881525 and
  CANARY-RESUME-8f881525; status=running; returnedLineCount=9.
PARSE_RESULT: resume_token_seen=True

COMMAND: orca terminal close --terminal term_b1a24540-7dbc-4c69-be49-d29890296d9f --json
EXIT_CODE: 1
STDOUT_STDERR: ok=false, error.code=runtime_error, error.message=tab_not_found

COMMAND: orca terminal list --worktree <explicit selector> --json
EXIT_CODE: 0
PARSE_RESULT: exact title/handle matches=0; cleanup complete.
```

No command targeted the Control Tower handle
`term_6c479a7c-d622-458b-bd95-48a61863f9ca` or any other pre-existing handle.
