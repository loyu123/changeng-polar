import os from 'node:os'
import { listInstalledApps, listStartupItems } from '../src/main/node/registry'
import { fetchPage, searchWeb } from '../src/main/node/web'
import { DEFAULT_CONFIG } from '../src/main/node/store'

/** 不依赖模型的冒烟测试：本机读取 + 联网检索链路 */
async function main(): Promise<void> {
  console.log('=== V2 本机只读读取 ===')
  const appsStart = Date.now()
  const { apps } = await listInstalledApps(true)
  const appsMs = Date.now() - appsStart
  console.log(`程序清单：${apps.length} 条，首扫 ${appsMs} ms`)
  console.log(`系统组件：${apps.filter((a) => a.systemComponent === 1).length} 条`)
  for (const app of apps.slice(0, 5)) {
    console.log(`  - ${app.name} | ${app.version || '无版本'} | ${app.publisher || '无发布者'}`)
  }

  const startupStart = Date.now()
  const { items } = await listStartupItems(true)
  const startupMs = Date.now() - startupStart
  const count = (kind: string): number => items.filter((i) => i.kind === kind).length
  console.log(
    `启动项：${items.length} 条（注册表 ${count('registry')} / 启动文件夹 ${count('startup-folder')} / 计划任务 ${count('scheduled-task')}），耗时 ${startupMs} ms`
  )
  for (const item of items.slice(0, 5)) {
    console.log(`  - [${item.kind}] ${item.name}`)
  }

  console.log('\n=== 联网检索链路 ===')
  const query = '微信 Windows 客户端 官方 功能介绍'
  const outcome = await searchWeb(query, DEFAULT_CONFIG)
  console.log(`检索「${query}」→ ok=${outcome.ok} provider=${outcome.provider} 结果 ${outcome.hits.length} 条 ${outcome.durationMs} ms`)
  if (outcome.error) console.log(`  error: ${outcome.error}`)
  for (const hit of outcome.hits.slice(0, 3)) {
    console.log(`  - ${hit.title.slice(0, 50)} | ${hit.url.slice(0, 70)}`)
  }

  if (outcome.hits[0]) {
    try {
      const page = await fetchPage(outcome.hits[0].url)
      console.log(`\n抓取首条：${page.title.slice(0, 50)}（正文 ${page.text.length} 字）`)
      console.log(`  预览：${page.text.slice(0, 120).replace(/\n/g, ' ')}`)
    } catch (err) {
      console.log(`\n抓取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n主机：${os.hostname()}  系统：Windows ${os.release()}  用户：${os.userInfo().username}`)
}

void main()
