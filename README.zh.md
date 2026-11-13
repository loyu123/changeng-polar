**中文** | [English](README.md)

# 长庚POLAR · 本地电脑管家

Windows 11 上的私人电脑管家：桌面窗口 + 真实工具调用，**每一个会改动机器的动作都走授权卡**。中文优先。

**这个项目的目的不是好看，是把三件不确定的事问清楚**——它们不确定，后面所有工作都没意义：

| 风险 | 结论 |
|---|---|
| R1 模型能可靠地调工具吗？ | 能。本机 LiteLLM 网关上的 `deepseek-v4-flash`，每轮约 6 秒。踩到一个真坑（`tool_calls` 缺 `type` 字段 → HTTP 422），已修 |
| R2 本机只读访问够快吗？数据对吗？ | 够。129 个程序首次扫描 **825 ms**，34 个启动项 **2 s**，与「设置 → 应用」逐条对得上 |
| R3 「不编造 / 不讨好」能自动判吗？ | **能，但证据有限。** 36 条用例 7 组，由**另一家厂商的模型**判分（不是自己给自己打分）。扣分项、判据口径、以及被迫返工的两条用例，都在[评测](docs/zh/evaluation.md)里 |

## 它能做什么

- **汇报项目进展。** 项目登记一次（名字、根目录、日志位置，在「设置 → 权限与安全」里），之后问一句「进展到哪了」，它会列目录、读日志尾部，答出**最近改了什么、卡在哪、下一步做什么**，并且说清**哪些内容它没读到**。
- **整理资料、准备材料、规划项目。** 三种交付物的骨架写在提示词里：进展汇报 / 资料摘要 / 项目计划。计划明确标成**判断**而不是查到的事实——它本来就是判断。
- **读真实文档。** `.docx/.xlsx/.pptx`、PDF 文字层、2003 老格式 `.doc/.xls/.ppt`——自己解析格式，不装 Office、不引第三方库。
- **写文档。** `.md/.txt/.csv/.json/.html/.docx/.pptx`，落点是桌面上的 `长庚产出\`。**永不覆盖**，重名变成 `名称 (2).md`。
- **管机器。** winget 装、拉起程序自己的卸载程序来卸、列已装程序与开机自启、打开程序和文件夹。
- **检索与邮件。** 联网检索/抓页，以及 IMAP **只读**邮件。
- **模拟键鼠**，三道闸：销毁档逐次弹卡、**动鼠标之前**先按进程名核对白名单、卡上带当前屏幕截图——你批准的是看得见的东西。

主进程注册 29 个工具。只读的自动放行并留痕，会改动机器的一律要卡。完整清单与逐条约束见[边界](docs/zh/boundaries.md)。

## 快速开始

```powershell
npm install                      # 首次装 electron 可从镜像下：$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm run dev                      # 开发模式（热更新）
npm run build                    # 产出 out/ 三端产物
npm run typecheck                # 主进程 + 渲染层两份 tsconfig 各查一遍
npm test                         # 单测（vitest，不连网、不读注册表）
npm run gate                     # 授权闸门离线验收（不接模型，69 条）
npm run smoke                    # 不依赖模型：验证注册表读取 + 联网检索
npm run mock                     # 本地假模型（无 Key 时验证对话链路）
npm run eval                     # 跑 36 条评测（不含联网），结果写 evals/report.json
npm run eval -- --with-search    # 额外跑 S 组 3 条：真的联网检索，共 39 条
npm run pack                     # 出 NSIS 安装包 + 便携版到 release/
```

项目相关的自检，都是只读、随时可跑：

```powershell
npm run check:projects                  # 项目档案：校验 → 落盘 → 读回 → 打印模型下一轮会看到的那一段
npm run check:list [项目名] [子目录]     # 拿真实项目跑一遍 list_files
npm run check:log [项目名] [行数]        # 拿真实项目的日志跑一遍 read_log_tail
npm run check:report [项目名]           # 走一遍「进展汇报」骨架要用的两步
npm run check:remote                    # 远程入口：经局域网 IP 走完整条链路（该方向已归档，仅保留自检）
npm run check:input                     # 模拟键鼠真机验证：会真的移动鼠标（结束恢复原位）
```

模型在应用内「设置」里填，支持任意 OpenAI 兼容端点：

- 云端网关：填 `baseUrl`（`/v1` 或完整 `/v1/chat/completions` 都行）+ `apiKey` + `model`
- 本机 Ollama：`http://127.0.0.1:11434/v1`，Key 可留空
- 只想看界面：`npm run mock`，然后把 baseUrl 指到 `http://127.0.0.1:8123/v1`

数据都落在 `%APPDATA%\changeng-polar\`：`config.json`（凭据，落盘前经 safeStorage 加密）、`records.jsonl`（append-only 动作记录）、`memory.json`（跨会话记忆）、`project-archive.json`（项目档案：项目名 / 根目录 / 日志位置），以及任务/会话各一份 JSON。

**便携版**（`changgeng-polar-*-portable.exe`）把 `config.json` 挪到 exe 同级，配置跟着 U 盘走。**密钥不跟着走**——DPAPI 绑当前用户。机制与三条边界见[架构](docs/zh/architecture.md)。

## 文档

| | |
|---|---|
| [边界](docs/zh/boundaries.md) | 每个工具的档位，以及哪些约束写在代码里而不是提示词里 |
| [评测](docs/zh/evaluation.md) | 实测数字、打分口径、以及用例本身是怎么被补稳的 |
| [架构](docs/zh/architecture.md) | 目录结构，每个文件负责什么 |
| [手机端（历史）](docs/zh/remote.md) | **已作废**：局域网 / Tailscale / frp，留作记录 |
| [已知待改进](docs/zh/known-gaps.md) | 没验的、没做的、以及刻意不做的 |

## Demo 明确没做

MCP 真实连接、GitHub 话题检索之外的仓库操作、全文索引、语音识别、邮件发送（邮箱只读）、PDF 与 Excel 的**写出**。打包与分发已接通，但**产物未签名**。
