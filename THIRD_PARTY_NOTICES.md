# THIRD_PARTY_NOTICES.md

GPT Browser Bridge uses the following third-party packages (as of GBB-001). Only
packages explicitly allowed by `plans/GBB_PARENT_WORK_ORDER.md` §3.1 are used. This
file is the license record required by the parent work order.

## Runtime dependencies

| Package | Version | License | Purpose | Allowed by |
| ------- | ------- | ------- | ------- | ---------- |
| `playwright-core` | 1.62.1 | Apache-2.0 | Drive a dedicated Chrome via CDP (no browser writes in Watcher) | Parent work order §3.1 |
| `write-file-atomic` | 8.0.0 | ISC | Atomic writes for `reply.md` / `result.json` / `project_state.json` / heartbeat | Parent work order §3.1 |
| `zod` | 4.4.3 | MIT | Runtime validation of `job.json` / `result.json` / `project_state.json` / agent reports | Parent work order §3.1 |

Dev/test tooling uses Node.js built-ins only (`node:test`, `crypto`, `fs`, `path`,
`child_process`, `AbortController`). No additional test framework is installed.

## License texts

### playwright-core (Apache License 2.0)

`playwright-core` is Copyright (c) Microsoft Corporation and contributors, licensed
under the Apache License 2.0. Full text:

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
```

The complete license text ships in the package at
`node_modules/playwright-core/LICENSE`. Summary of terms: you may use, copy, modify
and redistribute the software, provided a copy of the license and the NOTICE
(if any) accompany the redistribution; works derived from it must not use the
"Playwright" name in a way that implies endorsement without permission.

### write-file-atomic (ISC License)

```text
Copyright (c) 2015, Rebecca Turner

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice and
this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD
TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN
NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The full text ships in the package at `node_modules/write-file-atomic/LICENSE`.

### zod (MIT License)

```text
MIT License

Copyright (c) 2020 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The full text ships in the package at `node_modules/zod/LICENSE`.

## Design borrowings (not vendored code)

The project borrows behavioral patterns from `yxhpy/chatgpt-pro-browser` (Stop
button disappearance detection, text-stability detection, conversation-URL resume,
resume-on-timeout instead of resend) and evaluates `microsoft/playwright-cli`
for compatibility. Neither project's source is copied into this repository; see
`plans/GBB_PARENT_WORK_ORDER.md` §3.2–§3.3 for the borrowing boundaries.

## Electron (Orca app, runtime only)

The Orca application embeds Electron/Chromium binaries in
`%LOCALAPPDATA%\Programs\orca\resources`. These are runtime assets of a separate
application, are **not** part of this repository's `node_modules` and are not
distributed by this project. They are recorded here only for completeness of the
environment inventory (see `docs/ARCHITECTURE.md`).
