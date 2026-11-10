# 项目编排

长庚把项目切成任务，派给外部工作体跑，验收后收结果。
这一层解决的是长庚原本「会话式」的问题：状态要跨天存在、进程死了能续。

```
<项目根>/
  .orchestrator/project.json     项目、任务、依赖、验收、每步状态
  .orchestrator/runs.jsonl       每次派发一行记录（append-only）
  tasks/<id>/                    每个任务的工作目录（工作体只能在这里动手）
  tasks/<id>/output.txt          工作体的原文回答
  tasks/<id>/_upstream/          上游产出在这里，由长庚搬过来
```

## 工作体后端：四个，各有各的边界

`src/main/orchestrator/backends/` 下每个后端一个文件，都实现 `WorkerBackend`。
差异关在各自的实现里，编排层一行都不用改。

| 后端 | 入口 | 实测（2026-11-10） | 限制 |
|---|---|---|---|
| **pi** | `pi --mode rpc` | ✅ 回话 1.1s / 干活 4.1s | **必须填 provider + model**（默认会落到 anthropic，401）；provider 名是 `eepseek`，少一个 d |
| **codex** | `codex exec` | ✅ 回话 2.4s / 干活 12.5s | 可执行文件在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\`，升级会改目录名，**不能写死路径** |
| **codebuddy** | 独立版 `codebuddy` 命令 | ✅ 回话 5.5s / 干活 12.1s / 编排 4/4 | 这台机器上有**两个** codebuddy，登录态不共用（见下）；写文件要 `--permission-mode acceptEdits` |
| **claude** | `claude -p` | ✅ 回话 3.7s / 干活 5.1s | **按订阅计费**（一次极短问答 $0.009~0.08）；默认不选 |

**ChatGPT 桌面版接不了**：它是纯 GUI，没有命令行入口，程序喂不进提示词。
OpenAI 那一边能自动化的是 **codex CLI**，上表里已经有了。

验证命令：

```bash
npm run backends            # 各后端能不能回话
npm run backends:work       # 各后端能不能真读文件、写文件（编排真正依赖这个）
```

换后端不改代码：

```bash
WORKER_BACKEND=codex npm run project     # 同一份计划，换 codex 跑
```

配置在设置页「模型 → 工作体」，或 `ButlerConfig.worker`（config.json）。

### codex 为什么现在用不了：网关的 Responses 转换有问题（2026-11-10 实测）

codex 这个版本 `wire_api` **只认 `responses`**（写 `chat` 直接报 unknown variant），
而 `192.168.8.174:18300` 那个网关是 LiteLLM，它把 Responses 请求转成 chat completions
再发上游，这一步会出错。同一个网关、同一个 codex，两个模型两种错法：

```
deepseek-v4-flash  →  Tool names must be unique            （工具定义被重复发了一遍）
Qwen3.8-Flash      →  System message must be at the beginning （消息顺序被转错）
```

试过但都不管用的：关掉全部 10 个 plugin、`include_apply_patch_tool=false`、
`tools.web_search=false`、换 `model_reasoning_effort`、
**重装成 npm 稳定版 0.167.0**（原来是桌面版自带的 0.167.0-alpha.3.2）。
新版同样只认 `responses`，错误一字不差。
**这不是配置能绕过的，也不是 codex 版本或我们代码的问题。**

`explainGatewayError()` 会把这类报错翻成人话，免得用户以为是 Key 填错或代码坏了。

要真正用上 codex，只有三条路：
1. 升级/换掉那个网关的 Responses 实现
2. 把 codex 指向一个原生支持 Responses 协议的服务（**注意：DeepSeek 官方 API 只有
   chat completions，直连也不行**）
3. 不用 codex——pi / codebuddy / claude 三条都已经能用

### codebuddy 有两个，登录态不共用（2026-11-10 实测）

| 是什么 | 位置 | 状态 |
|---|---|---|
| 独立 npm 包 `codebuddy` v2.182+ | PATH 上 | ✅ **用它**，登录态独立可用 |
| WorkBuddy 内置 CLI | `D:\WorkBuddy\...\codebuddy-lite-wb.mjs` | ❌ 即使独立版已登录，它仍报 `Authentication required` |

后端默认走独立版；`binPath` 指向 `.mjs` 时才切到内置版（那样会过 `node` 跑）。

另外**非交互模式下写文件会被权限拦住**：实测它确实调了 `Write`，然后回一句
"Write 工具被拒绝…请用 -y 或 --permission-mode bypassPermissions"。
这里用 `acceptEdits`——**只自动放行文件编辑，不放行危险命令**，比
`bypassPermissions` 窄得多，更不碰 `--dangerously-skip-permissions`。
只给了 write 工具时才加这个档，纯只读任务不加。

### 四个踩过的坑（改后端代码前必看）

1. **提示词不能进命令行参数。** Windows 上这些 CLI 是 `.cmd`，过 shell 才能起；
   过了 shell，带空格和中文的参数会被 cmd.exe 拆碎——实测表现为"模型只看到前半句，
   回一句客套话就结束"。**统一走 stdin**（`spawnCollect` 的 `stdin` 选项）。
2. **`--allowedTools` / `--tools` 是变参**，会吞掉后面紧跟的位置参数。
   曾经把提示词放在它们后面，提示词被当成工具名吃掉，报
   `Input must be provided either through stdin or as a prompt argument`。
3. **claude 的 `--allowedTools` 要空格分隔的多个参数**，逗号连成一个
   （`Read,Write`）会被当成一个不存在的工具名，结果一个工具都用不了——
   表现为"回答里说已经写好了，磁盘上什么都没有"。codebuddy 相反，要逗号连。
4. **警告不等于失败。** codex 会把"配置里有不认识的字段"发成 `item.type === 'error'`；
   把它当失败会把正常跑完的任务判成失败。只有 message 含 `failed`/`authentication`
   之类才算硬错。

## 四个入口

```bash
npm run orchestrate              # 串行跑一个三任务的真项目
npm run orchestrate:parallel     # 串行 vs 并行对比（实测 1.4~2×）
npm run delegate                 # 委派冒烟：一个任务
npm run project                  # 派发冒烟：候选卡 + 一组任务 + 读回界面数据
```

## 在对话里用

两个工具（`tools.ts`），分工是「一件事」和「一组事」：

| 工具 | 用途 | 边界 |
|---|---|---|
| `delegate_to_agent` | **一个**任务 | 做完这一件就收 |
| `run_project` | **一组**有依赖的任务 | 跑完整个项目，逐条验收 |

两个都带 `requiresConfirmation: true`，所以：

- **必须过卡**，不会因为 effect 是 `write` 就自动放行；
- **永远没有「始终允许」**，记忆里有这条也照样弹卡；
- 卡上如实写「会把提示词和读到的文件内容交给本机之外的工作体，过程中不会回来问你」。

### 派发方式的候选卡

`run_project` 在派发前弹一张候选卡让用户选串行还是并行几路。**只有真的存在
同层多任务时才摆并行选项**——链式计划（A→B→C）开多少路都一样快，摆上去是骗人的。

选项由 `dispatchOptions(previewDispatch(tasks))` 算出来，实测长这样：

```
计划：4 个任务，分层宽度 3 / 1
  [serial]     串行        — 一次跑一个，最稳。共 4 个任务
  [parallel:3] 并行 3 路   — 最多 3 个任务同时在跑（3 倍并发）。慢的只剩最宽那一层
```

为什么不把这个交给模型决定：并行 = 多倍并发打到同一个网关，那是用户的时间和额度。
模型看不到这代价，用户看得到。

## 界面：编排页

左侧栏「编排」页只读展示所有派发过的项目：进度条、每个任务的状态与验收项、真实存在的产出文件。

- 状态里 `unknown` 单独标出来——它既不是成功也不是失败
- 「重新核对验收」按磁盘现状再查一遍，**不改任务状态**：它是复核，不是修状态
- 点产出文件名在资源管理器里定位（只允许编排目录内的路径）

数据来自 `src/main/orchestrator/view.ts`，IPC 在 `src/main/ipc/orchestration.ts`。

配置在 `ButlerConfig.worker`（设置里那份 config.json），**没有默认值**：
没填 provider/model 时工具直接报「没配置」，不会去猜——pi 的默认模型是 anthropic，
没 Key 就是 401。

## 四条不能破的规则

1. **模型必须显式传。** `worker.ts` 的 `assertWorkerConfig` 直接拒绝空配置。
2. **验收是硬门。** 工作体说做完了不算，`acceptance.ts` 只看文件系统：
   存在、够大、含该有的字。判断性验收只能用来排序，不能判定通过。
3. **隔离目录是硬边界。** 下游要读上游产出，由长庚复制到 `_upstream/`，
   不让工作体跨目录读——今天能读，明天就能写到别人家里。
4. **同一目录不许并发。** 同批里抢同一个 `workDir` 的任务会被推到下一批
   （`pickBatch`），并发上限夹在 1~8。

## 状态里那个 `unknown` 别改成 failed

派发后被中断（超时、应用退出、进程被杀），任务做没做完是**未知**的。
重启时 `store.ts` 会对账：`running` 但没留下 run 记录的任务标 `unknown`。
既不能当成功，也不能当失败——只能重跑或人工确认。

## 一个 pi 的坑，改 worker.ts 之前必看

**模型调用失败时 pi 仍然会发 `agent_settled`。** 第一版没检查 `stopReason === 'error'`，
结果任务什么都没做却汇报成成功。现在 `lastError` 会把它抓出来判失败。
另外"零工具调用 + 零输出"也判失败——那同样不是成功。

## 还没做的

- 后端之间的负载分配：现在一次派发全用同一个后端（`ButlerConfig.worker.backend`），
  还不能"这个任务给 codex、那个给 claude"
- 花费上限：pi 走内网网关 `cost` 全是 0；claude 的 `total_cost_usd` 已经在 usage 里，
  但还没有"超了就不派"的闸门
- PDF 直读：工作体读不了扫描件（那是另一条线，不在编排层）
