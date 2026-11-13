> Split out of the [README](../../README.md) so the front page stays an introduction.

# Project layout

```
src/
  shared/
    types.ts               cross-process types (no electron dependency)
    desktop.ts             desktop preference defaults + normalization (close-to-tray / autostart / task notifications)
    orb.ts                 floating-orb preference defaults + normalization
    mail-hosts.ts          IMAP server inference for common mail providers
  main/
    index.ts               main-process entry: assembly only (window / runtime / IPC / tray / orb)
    window.ts              window and navigation security
    runtime.ts             tool assembly, auth-gate implementation (AuthBroker), running one turn
    tray.ts                persistent tray, menu, status line
    orb.ts                 the two orb windows: creation, positioning, dragging, visibility
    notify.ts              system notifications (task done / tray idle)
    verify.ts              A4: app name → candidate official site → body verification → one-line explanation
    agent/
      agent.ts             tool-calling loop + runtime interception + step budget
      gate.ts              auth gate: read/ui pass through, write backs up first, install/destroy require a card
      budget.ts            pre-request context budget: system uncut, tool_calls kept in pairs, per-item truncation
      llm.ts               OpenAI-compatible client (streaming / non-streaming / SSE compatible)
      prompt.ts            system prompt: behavioral phrasing of H1–H4; the capability section is generated from the registry
      tools.ts             29 tools (full list and constraints in [Boundaries](boundaries.md))
      tool-types.ts        tool definition, ToolPlan, ToolResult types
    ipc/                   IPC split by domain: app / chat / config / work / orb
    node/
      registry.ts          PowerShell registry / startup-item reads; StartupDiff set difference
      install.ts           winget search / install / post-install verification (execFile with argv, never through a shell)
      uninstall.ts         uninstall: parse the command, reject script hosts, only launch the app's own uninstaller
      mail.ts              multi-account read-only IMAP: list / read body / typed errors
      sandbox.ts           demo sandbox: scope hard-coded to %TEMP%\butler-sandbox, deletion goes to the recycle bin
      snapshot.ts          capture state before uninstall, diff it after
      document.ts          writing files: where it lands, name, format, never overwrite
      markdown.ts          parses the model's Markdown into blocks (headings/lists/tables/code)
      docx.ts              blocks → .docx (assembles OOXML itself; no Office needed)
      pptx.ts              blocks → .pptx (blank layout + own text boxes, no placeholder inheritance)
      zip-write.ts         minimal ZIP writer for OOXML (CRC32 + deflate)
      xml.ts               the two XML escapes (one wrong character = a file that won't open)
      memory.ts            cross-session memory merge and dedupe
      projects.ts          project archive: path validation (no UNC / relative) + the prompt block
      projects-probe.ts    "do the registered paths still exist" (UI red/green only, never in the prompt)
      list-tree.ts         project directory listing: scope rule, symlinks not followed, truncation and skips reported
      log-tail.ts          log tail: by lines, reuses the decode ladder, truncation stated, binary refused
      search.ts            global search (done in the main process; only the few dozen hits reach the renderer)
      secrets.ts           credential encryption at rest (safeStorage/DPAPI injected by the main process)
      tasks.ts             scheduled task runner
      web.ts               Bing(cn) / DDG / Tavily / Serper / BingAPI chained search + page fetch
      html.ts              strip tags, decode entities, locate the body component
      ps.ts                PowerShell invocation and JSON output parsing
      store.ts             serialized queues for config / append-only log / per-domain JSON
  preload/index.ts         exposes only whitelisted methods (including answering auth cards)
  renderer/
    index.html             main window
    orb.html               floating-orb window
    src/pages/             seven pages: chat / records / tasks / orchestration / accounts / plugins / settings
    src/orb/               renderer for the orb and its panel
    src/components/        global search, markdown, snapshot diff card
    src/utils/speech.ts    speech output (reads the conclusion only, triggered on demand)
scripts/
  eval.ts                  the 36 eval cases + scoreboard
  judge.ts                 scorer (scoring model configured independently; scoreCase is shared by full runs and rejudges)
  rejudge.ts               rejudge only: freeze the previous answers, rescore
  rejudge-plan.ts          rejudge arguments, wobble stats, multi-report comparison table
  answer-set.ts            reads answers out of a report, computes the answer fingerprint
  lib/repeat.ts            --repeat parsing + stability, shared by eval and rejudge
  lib/load-config.ts       script config loading: env vars > decrypted plaintext > on-disk plaintext
  lib/decrypt-config.cjs   Electron child process; decrypts credentials with the key from <userData>\Local State
  smoke.ts                 local reads + search smoke test
  gate-check.ts            offline acceptance for the auth gate (no model, 69 assertions)
  check-h1.ts / e3-check.ts / view-check.ts     one-off verification scripts
  orchestrator-*.ts / delegate-smoke.ts / project-smoke.ts   orchestrator bus smoke tests
  backends-*.ts / mixed-backends.ts / github-smoke.ts       external worker backend checks
  make-icon.py             app icon generation
  mock-llm.cjs             local fake model
evals/cases.json           the eval set (36 default + 3 live-search cases / 8 groups)
tests/                     unit tests (vitest, no network, no registry access)
```

---
