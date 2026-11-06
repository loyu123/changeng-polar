/**
 * 本地假模型：用来在拿到真实 Key 之前验证「流式 + 工具调用 + 引用」全链路。
 * 用法：node scripts/mock-llm.cjs  然后在设置里把 baseUrl 指到 http://127.0.0.1:8123/v1
 */
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PORT = Number(process.env.MOCK_PORT ?? 8123)

function sse(res, deltas, finish) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  for (const delta of deltas) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function streamText(res, text, finish = 'stop') {
  const chunks = []
  for (let i = 0; i < text.length; i += 12) chunks.push({ content: text.slice(i, i + 12) })
  sse(res, chunks, finish)
}

function toolCall(res, name, args) {
  sse(
    res,
    [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }
        ]
      }
    ],
    'tool_calls'
  )
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }
    const messages = payload.messages ?? []
    const last = messages[messages.length - 1] ?? {}
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

    // 已拿到工具结果 → 出结论
    if (last.role === 'tool') {
      let summary = ''
      try {
        const parsed = JSON.parse(last.content)
        summary = String(parsed.summary ?? '')
      } catch {
        summary = String(last.content).slice(0, 80)
      }
      if (/拒绝|取消/.test(summary)) {
        streamText(res, '这次没有执行：你在授权卡上点了拒绝，文件还在原处。要真删的话我再问你一次。')
        return
      }
      streamText(res, `查到了：${summary}\n以上来自本机只读读取，没有改动任何设置。`)
      return
    }

    // 演示授权闸门：只有命中「沙箱」才走删除，其余删除类请求照旧拒绝
    if (/沙箱/.test(userText) && /删/.test(userText)) {
      toolCall(res, 'delete_to_recycle', {
        path: path.join(os.tmpdir(), 'butler-sandbox', '会议记录-周会.txt'),
        reason: '演示删除要经用户授权'
      })
      return
    }
    if (/删|清空|卸载|覆盖/.test(userText)) {
      streamText(
        res,
        '我不能删除或卸载任何东西，管家没有删除权限。\n你可以自己打开「设置 → 应用」里处理，或者右键移到回收站再自己确认。'
      )
      return
    }
    if (/Notion|温度|密码|聊过天|花了多少钱|第几章/.test(userText)) {
      streamText(res, '查不到。我这边没有任何能读到这项信息的能力，也不知道该怎么编。')
      return
    }
    if (/启动|自启|开机/.test(userText)) {
      toolCall(res, 'list_startup_items', {})
      return
    }
    if (/装|程序|浏览器|版本/.test(userText)) {
      toolCall(res, 'list_installed_apps', { limit: 20 })
      return
    }
    if (/做一个|怎么写|工具|脚本/.test(userText)) {
      toolCall(res, 'web_search', { query: userText.slice(0, 30) })
      return
    }
    streamText(res, '我这边只回答这台电脑上的事。你可以问我装了哪些程序、开机自启了什么。')
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock llm listening on http://127.0.0.1:${PORT}/v1`)
})
