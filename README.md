[中文](README.zh.md) | **English**

# 长庚POLAR (Changeng POLAR) · A Local Computer Butler

A personal computer butler for Windows 11: a desktop window, real tool-calling, and every write going through an authorization card. Chinese-first.

**The point of this project isn't to look good. It's to kill three uncertainties that would make the rest of the work pointless:**

| Risk | What it answered |
|---|---|
| R1 — Can the model run tool calls reliably? | Yes. `deepseek-v4-flash` via a local LiteLLM gateway, ~6 s per turn. One real trap hit (`tool_calls` missing the `type` field → HTTP 422), fixed |
| R2 — Is local read-only access fast enough, and is the data correct? | Yes. First scan of 129 programs in **825 ms**; 34 startup items in **2 s**; matches Settings → Apps |
| R3 — Can "don't fabricate / don't flatter" be judged automatically? | **Yes, but the evidence is limited.** 36 cases across 7 groups, scored by a different model from a different vendor. Details, deductions and the cases that had to be fixed are in [Evaluation](docs/en/evaluation.md) |

## What it does

- **Reports on your projects.** Register a project once (name, root directory, log location) in Settings → 权限与安全; later "how far along is it" makes it list the directory, read the tail of the log, and answer with what changed, what is blocked, and what is next — stating what it did *not* read.
- **Organises material and plans work.** Three deliverable shapes live in the prompt: progress report, material summary, project plan. The plan is labelled as judgement rather than a looked-up fact, because that is what it is.
- **Reads real documents.** `.docx/.xlsx/.pptx`, PDF text layers, and legacy 2003 `.doc/.xls/.ppt` — by parsing the format itself, with no Office install and no third-party library.
- **Writes documents.** `.md/.txt/.csv/.json/.html/.docx/.pptx` into `长庚产出\` on the Desktop. Never overwrites; a taken name becomes `name (2).md`.
- **Handles the machine.** Install via winget, uninstall by launching the vendor's own uninstaller, list installed programs and startup items, open apps and folders.
- **Search and mail.** Web search/fetch, and IMAP **read-only** mail.
- **Simulates mouse and keyboard** behind three gates: a destroy-tier card every time, a per-process allow-list checked *before* the mouse moves, and a screenshot on the card so you approve something you can see.

The main process registers 29 tools. The read-only ones pass silently and are audited; everything that changes the machine needs a card. Full list and per-tool constraints: [Boundaries](docs/en/boundaries.md).

## Quick start

```powershell
npm install                      # first install of electron can use a mirror: $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm run dev                      # dev mode (hot reload)
npm run build                    # produce the three out/ bundles
npm run typecheck                # typecheck main + renderer against both tsconfigs
npm test                         # unit tests (vitest, no network, no registry access)
npm run gate                     # offline acceptance for the auth gate (no model, 69 assertions)
npm run smoke                    # model-free: verify registry reads + web search
npm run mock                     # local fake model (exercise the chat path with no API key)
npm run eval                     # 36 eval cases, no network; writes evals/report.json
npm run eval -- --with-search    # also the 3 S cases: real live search, 39 in total
npm run pack                     # NSIS installer + portable build into release/
```

Project-related checks, all read-only and safe to run any time:

```powershell
npm run check:projects                  # archive: validate → persist → read back → print the exact prompt paragraph
npm run check:list [project] [subdir]   # run list_files against a real project
npm run check:log [project] [lines]     # run read_log_tail against a real project log
npm run check:report [project]          # the two steps the progress-report skeleton needs
npm run check:remote                    # remote entry over the LAN IP, then print the self-check verdicts
npm run check:input                     # simulated mouse/keyboard: moves your mouse, restores it afterwards
```

Models are configured inside the app under **Settings**, and any OpenAI-compatible endpoint works:

- Cloud gateway: set `baseUrl` (either `/v1` or the full `/v1/chat/completions`) + `apiKey` + `model`
- Local Ollama: `http://127.0.0.1:11434/v1`, API key can be left empty
- Just want to see the UI: `npm run mock`, then point baseUrl at `http://127.0.0.1:8123/v1`

All data lands in `%APPDATA%\changeng-polar\`: `config.json` (credentials, encrypted with safeStorage before hitting disk), `records.jsonl` (append-only action log), `memory.json` (cross-session memory), `project-archive.json` (name / root / log path per project), plus one JSON each for tasks and sessions.

The **portable build** (`changgeng-polar-*-portable.exe`) moves `config.json` next to the exe so the configuration travels on a USB stick. Secrets do not travel — DPAPI is bound to the current user. Mechanism and the three limits: [Architecture](docs/en/architecture.md).

## Docs

| | |
|---|---|
| [Boundaries](docs/en/boundaries.md) | Every tool, its tier, and the constraints enforced in code rather than in the prompt |
| [Evaluation](docs/en/evaluation.md) | Measured results, scoring criteria, how the cases themselves were stabilised |
| [Architecture](docs/en/architecture.md) | Project layout and what each file is responsible for |
| [Remote access](docs/en/remote.md) | Phone access over LAN or Tailscale, pairing, and the self-check |
| [Known gaps](docs/en/known-gaps.md) | What is unverified, undone, or deliberately left alone |

## Deliberately not built

Real MCP connections, repository operations beyond GitHub search/upload, full-text indexing, speech recognition, sending mail (mail is read-only), writing PDF and Excel. Packaging and distribution are wired up, but **builds are unsigned**.
