> 从 [README](../../README.zh.md) 拆出来的详细内容，首页只留介绍。

# 目录结构

```
src/
  shared/
    types.ts               跨进程类型（无 electron 依赖）
    desktop.ts             桌面偏好（关窗收托盘 / 开机自启 / 任务通知）的默认值与归一化
    orb.ts                 悬浮球偏好的默认值与归一化
    mail-hosts.ts          常见邮箱服务商的 IMAP 服务器推导
  main/
    index.ts               主进程入口：只做装配（窗口 / 运行时 / IPC / 托盘 / 悬浮球）
    window.ts              窗口与导航安全
    runtime.ts             工具装配、授权闸门实现（AuthBroker）、跑一轮对话
    tray.ts                托盘常驻、菜单、状态行
    orb.ts                 悬浮球与面板两个窗口：创建、定位、拖拽、显隐
    notify.ts              系统通知（任务完成 / 托盘待命）
    verify.ts              A4：程序名 → 候选官网 → 正文核对 → 一句话说明
    agent/
      agent.ts             工具调用环路 + 运行时拦截 + 步数收口
      gate.ts              授权闸门：read/ui 直放、write 先备份、install/destroy 必须过卡
      budget.ts            请求前的上下文预算：system 不裁、成对保留 tool_calls、单条截断
      llm.ts               OpenAI 兼容客户端（流式 / 非流式 / SSE 兼容）
      prompt.ts            系统提示词：H1–H4 的行为化表述；能力段由注册表生成
      tools.ts             29 个工具（完整清单与约束见 [边界](boundaries.md)）
      tool-types.ts        工具定义、ToolPlan、ToolResult 的类型
    ipc/                   IPC 按领域拆：app / chat / config / work / orb
    node/
      registry.ts          PowerShell 读注册表 / 启动项；StartupDiff 求差集
      install.ts           winget 检索 / 安装 / 装后核对（execFile 走 argv，绝不经 shell）
      uninstall.ts         卸载：解析命令、拒绝脚本宿主、只拉起程序自己的卸载程序
      mail.ts              多账号 IMAP 只读：列邮件 / 读正文 / 分型报错
      sandbox.ts           演示沙箱：作用域写死 %TEMP%\butler-sandbox，删除走回收站
      snapshot.ts          卸载前抓状态快照，卸载后做对比
      document.ts          写文件：落点、文件名、格式、永不覆盖的规则都在这儿
      markdown.ts          把模型写的 Markdown 解析成块（标题/列表/表格/代码…）
      docx.ts              块 → .docx（自己拼 OOXML，不装 Office）
      pptx.ts              块 → .pptx（空白版式 + 独立文本框，不碰占位符继承）
      zip-write.ts         写 OOXML 用的最小 ZIP 打包器（CRC32 + deflate）
      xml.ts               写 XML 的两个转义（转错一个字符 = 文件打不开）
      memory.ts            跨会话记忆的合并与去重
      projects.ts          项目档案：路径校验（拒 UNC / 相对路径）+ 注入提示词那一段
      projects-probe.ts    「登记的路径现在还在不在」（只给界面显示红绿，不进提示词）
      list-tree.ts         列项目目录：作用域判据、链接不跟进、截断与跳过都要报出来
      log-tail.ts          读日志尾部：按行数、复用解码阶梯、截断要说清、二进制要拒
      search.ts            全局搜索（在主进程做，只把命中的几十条送到渲染层）
      secrets.ts           凭据落盘加解密（主进程注入 safeStorage/DPAPI）
      tasks.ts             定时任务调度器
      web.ts               Bing(cn) / DDG / Tavily / Serper / BingAPI 链式检索 + 网页抓取
      html.ts              剥标签、解实体、找正文部件
      ps.ts                PowerShell 调用与 JSON 输出解析
      store.ts             配置 / append-only 记录 / 查证缓存 / 各领域 JSON 的串行队列
  preload/index.ts         只暴露白名单方法（含授权卡作答）
  renderer/
    index.html             主窗口
    orb.html               悬浮球窗口
    src/pages/             七个页面：对话 / 记录 / 任务 / 编排 / 账号 / 插件 / 设置
    src/orb/               悬浮球与面板的渲染层
    src/components/        全局搜索、Markdown、快照对比卡
    src/utils/speech.ts    播报（只念结论，按需触发）
scripts/
  eval.ts                  36 条评测 + 记分板
  judge.ts                 判分器（可独立配置判分模型；scoreCase 是全跑与复判共用的那段）
  rejudge.ts               复判：固定上次的回答，只重判不重答
  rejudge-plan.ts          复判的参数、抖动统计、多报告对表
  answer-set.ts            从报告里读回答、算答案集指纹（复判的输入）
  lib/repeat.ts            --repeat 的解析与稳定性判断（eval 与 rejudge 共用）
  lib/load-config.ts       脚本读配置：环境变量 > 解密后的明文 > 盘上明文
  lib/decrypt-config.cjs   Electron 子进程，用 <userData>\Local State 的密钥解密凭据
  smoke.ts                 本机读取 + 检索冒烟
  gate-check.ts            授权闸门的离线验收（不接模型，69 条）
  check-h1.ts / e3-check.ts / view-check.ts     单项核对脚本
  orchestrator-*.ts / delegate-smoke.ts / project-smoke.ts   编排总线冒烟
  backends-*.ts / mixed-backends.ts / github-smoke.ts       外部工作体后端核对
  make-icon.py             应用图标生成
  mock-llm.cjs             本地假模型
evals/cases.json           评测集（默认 36 条 / 7 组，另有 3 条联网用例需 --with-search）
tests/                     单测（vitest，不连网、不读注册表）
```

---
