import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AlwaysAllowedEntry,
  AppSnapshot,
  ButlerConfig,
  ChatSession,
  MemoryEntry,
  ProjectEntry,
  RecordEntry,
  TaskDef
} from '../../shared/types'
import { decodeConfigSecrets, encodeConfigSecrets, ENC_PREFIX, PLAIN_CODEC, type SecretCodec } from './secrets'

export const DEFAULT_CONFIG: ButlerConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  stream: true,
  temperature: 0.2,
  // 默认 Bing（抓 cn.bing.com）而不是 DuckDuckGo：国内网络下 DDG 基本直接回人机验证页，
  // 拿它当默认等于每次检索都先失败一次。Bing 实测 150–300ms 且中英文都出得来
  searchProvider: 'bing',
  searchKey: '',
  mail: { address: '', authCode: '', host: 'imap.qq.com', port: 993 },
  mailAccounts: [],
  desktop: { closeToTray: true, launchAtLogin: false, notifyOnTask: true }
}

/** 动作记录单文件上限：超过就轮转成 .1，只保留最近两份 */
const RECORDS_MAX_BYTES = 5 * 1024 * 1024

/** 桌面悬浮助手的会话文件：和主窗口的 sessions.json 刻意分开 */
const ORB_SESSIONS_FILE = 'orb-sessions.json'

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 记事本存 UTF-8 默认带 BOM，而 JSON.parse 遇到 BOM 会直接抛错，
 * 被 getConfig 的 catch 吞掉之后整份配置回落成默认值——用户的 Key、模型地址
 * 全被静默丢掉，界面上看不出任何异常。手改过一次配置就会踩到。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 本地存储：配置 json + 记录 jsonl（append-only）+ 查证结果 json */
export class Store {
  /**
   * 每个文件一条串行队列。
   *
   * 这里的写操作几乎都是「读全量 → 改 → 写回」。两个调用方撞在同一文件上时
   * （最典型：定时任务跑完在写 lastRun，用户同时点了保存），后写的会把先写的
   * 整个覆盖掉。按文件名排队，读-改-写就在同一段临界区里，不会再互相丢数据。
   */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly dir: string,
    /** 密钥加解密；评测脚本不注入时按明文读写 */
    private readonly codec: SecretCodec = PLAIN_CODEC,
    /**
     * config.json 的落点。默认与其它数据同目录；便携版传 U 盘上的目录进来，
     * 于是会话、记录、记忆仍在本机，只有配置跟着 exe 走。
     */
    private readonly configDir: string = dir
  ) {}

  /** 配置实际所在目录（设置页要如实显示"配置到底存哪了"） */
  configPath(): string {
    return this.configDir
  }

  /** 密钥是否真的在加密（设置页据此决定提示文案） */
  secretsEncrypted(): boolean {
    return this.codec.active
  }

  private enqueue<T>(name: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(name) ?? Promise.resolve()
    // 前一个任务失败也要继续排队，否则一次异常会把该文件的写全卡死
    const next = prev.then(task, task)
    this.queues.set(
      name,
      next.catch(() => undefined)
    )
    return next
  }

  private p(name: string): string {
    return path.join(this.dir, name)
  }

  private cfg(name: string): string {
    return path.join(this.configDir, name)
  }

  /** 先写 .tmp 再改名：进程被强杀时不会留下半截 JSON 把旧数据一起带走 */
  private async writeAtomic(name: string, text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = this.p(`${name}.tmp`)
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, this.p(name))
  }

  /** 配置的原子写：目录可能是 U 盘，和上面那份不是同一个 */
  private async writeConfigAtomic(name: string, text: string): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true })
    const tmp = this.cfg(`${name}.tmp`)
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, this.cfg(name))
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
  }

  async getConfig(): Promise<ButlerConfig> {
    try {
      const raw = await fs.readFile(this.cfg('config.json'), 'utf8')
      const parsed = { ...DEFAULT_CONFIG, ...(JSON.parse(stripBom(raw)) as Partial<ButlerConfig>) }
      // 盘上是密文，内存里一律明文：调用方（模型请求、IMAP 登录）拿到的都是能直接用的值
      return decodeConfigSecrets(parsed, this.codec)
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  /**
   * 哪几个密钥在这台机器上解不开。
   *
   * 存在的理由：密钥用 Windows DPAPI 加密，绑当前用户。便携版的配置被拿到另一台
   * 电脑上时，JSON 读得出来、密文解不开——而 decrypt 现在的处理是**静默返回空串**，
   * 用户只会看到设置页里 Key 一片空白，不知道是丢了还是本来就没填。
   *
   * 判据是「盘上是密文（enc:v1: 前缀）但解出来是空」：空值在编码时就不会加密，
   * 所以非空密文解出空串只可能是解不开，不会是"本来就是空的"。
   */
  async undecryptableSecrets(): Promise<string[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.cfg('config.json'), 'utf8')
    } catch {
      return []
    }
    let parsed: Partial<ButlerConfig>
    try {
      parsed = JSON.parse(stripBom(raw)) as Partial<ButlerConfig>
    } catch {
      return []
    }
    const broken = (value: string | undefined): boolean =>
      typeof value === 'string' && value.startsWith(ENC_PREFIX) && this.codec.decrypt(value) === ''

    const names: string[] = []
    if (broken(parsed.apiKey)) names.push('模型 API Key')
    if (broken(parsed.searchKey)) names.push('检索 Key')
    if (broken(parsed.judge?.apiKey)) names.push('判分模型 Key')
    if (broken(parsed.mail?.authCode)) names.push('邮箱授权码')
    if ((parsed.mailAccounts ?? []).some((acc) => broken(acc?.authCode))) names.push('邮箱授权码（多账号）')
    return names
  }

  async saveConfig(patch: Partial<ButlerConfig>): Promise<ButlerConfig> {
    return this.enqueue('config.json', async () => {
      const next = { ...(await this.getConfig()), ...patch }
      await this.writeConfigAtomic('config.json', JSON.stringify(encodeConfigSecrets(next, this.codec), null, 2))
      return next
    })
  }

  async appendRecord(entry: Omit<RecordEntry, 'id' | 'ts'>): Promise<RecordEntry> {
    const record: RecordEntry = {
      ...entry,
      id: randomUUID(),
      ts: new Date().toISOString()
    }
    return this.enqueue('records.jsonl', async () => {
      await fs.mkdir(this.dir, { recursive: true })
      await this.rotateRecordsIfNeeded()
      await fs.appendFile(this.p('records.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
      return record
    })
  }

  /**
   * 记录只追加、不清理，几个月的日常使用之后单文件会到几十兆，
   * 而 listRecords 每次都要整读进内存逐行解析——记录页会肉眼可见变慢。
   * 超过阈值就整段改名成 .1，旧 .1 顺延成 .2，只留最近两份。
   * 上限按"条数 × 每条约 300 字节"估，5MB 大约是一万六千条动作。
   */
  private async rotateRecordsIfNeeded(): Promise<void> {
    const current = this.p('records.jsonl')
    try {
      const st = await fs.stat(current)
      if (st.size < RECORDS_MAX_BYTES) return
    } catch {
      return // 还没有文件，不用轮转
    }
    try {
      await fs.rm(`${current}.2`, { force: true })
      await fs.rename(`${current}.1`, `${current}.2`).catch(() => undefined)
      await fs.rename(current, `${current}.1`)
    } catch {
      /* 轮转失败不影响本次追加：大不了这次不转 */
    }
  }

  /**
   * 读最近的动作记录（最新的在前）。
   * 跨轮转边界要接着往前读，否则刚轮转完的那一次记录页会突然空掉。
   * 顺序上必须"从最新那个文件开始取"：先读 records.jsonl，不够再补 .1、.2，
   * 凑够 limit 就停——反过来的话，限流截到的会是最旧的那批。
   */
  async listRecords(limit = 200): Promise<RecordEntry[]> {
    const files = [this.p('records.jsonl'), `${this.p('records.jsonl')}.1`, `${this.p('records.jsonl')}.2`]
    const out: RecordEntry[] = []
    for (const file of files) {
      if (out.length >= limit) break
      let raw = ''
      try {
        raw = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const block: RecordEntry[] = []
      for (const line of raw.split('\n')) {
        const text = line.trim()
        if (!text) continue
        let parsed: any
        try {
          parsed = JSON.parse(text)
        } catch {
          continue
        }
        // 老版本写过 {t:'revert'} 标记：那条标记只改日志、不动文件，不承认它是撤销，当废行跳过
        if (parsed.t === 'revert' || !parsed.kind) continue
        block.push(parsed as RecordEntry)
      }
      // 文件内部是追加顺序（旧→新），取的时候要倒着走
      for (let i = block.length - 1; i >= 0 && out.length < limit; i--) out.push(block[i])
    }
    return out
  }

  /** 卸载前抓的快照：按 id 存取，卸载后的对比（diff）凭这条记录回查 */
  private async readSnapshots(): Promise<Record<string, AppSnapshot>> {
    try {
      const raw = await fs.readFile(this.p('snapshots.json'), 'utf8')
      return JSON.parse(stripBom(raw)) as Record<string, AppSnapshot>
    } catch {
      return {}
    }
  }

  async saveSnapshot(snapshot: AppSnapshot): Promise<void> {
    await this.enqueue('snapshots.json', async () => {
      const map = await this.readSnapshots()
      map[snapshot.id] = snapshot
      await fs.mkdir(this.dir, { recursive: true })
      await this.writeAtomic('snapshots.json', JSON.stringify(map, null, 2))
    })
  }

  async getSnapshot(id: string): Promise<AppSnapshot | null> {
    return (await this.readSnapshots())[id] ?? null
  }

  /**
   * 所有卸载前快照，最近的在前。
   *
   * 存在的理由：卸载类工具当场核对不了（要等用户点完它自己的卸载窗口），
   * 于是那句 unavailable 承诺了"点完再问我"。要兑现这个承诺，
   * 模型得能在之后自己找到刚才那一份快照——而不是让用户去记录页点按钮。
   */
  async listSnapshots(): Promise<AppSnapshot[]> {
    const map = await this.readSnapshots()
    return Object.values(map).sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)))
  }

  /** 「始终允许」的记忆：持久化，才能在设置页看见并撤销 */
  async listAlwaysAllowed(): Promise<AlwaysAllowedEntry[]> {
    try {
      const raw = await fs.readFile(this.p('auth-memory.json'), 'utf8')
      const list = JSON.parse(stripBom(raw)) as AlwaysAllowedEntry[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  private async writeAlwaysAllowed(list: AlwaysAllowedEntry[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await this.writeAtomic('auth-memory.json', JSON.stringify(list, null, 2))
  }

  async addAlwaysAllowed(entry: AlwaysAllowedEntry): Promise<void> {
    await this.enqueue('auth-memory.json', async () => {
      const list = await this.listAlwaysAllowed()
      if (list.some((item) => item.key === entry.key)) return
      await this.writeAlwaysAllowed([...list, entry])
    })
  }

  async revokeAlwaysAllowed(key: string): Promise<AlwaysAllowedEntry[]> {
    return this.enqueue('auth-memory.json', async () => {
      const list = (await this.listAlwaysAllowed()).filter((item) => item.key !== key)
      await this.writeAlwaysAllowed(list)
      return list
    })
  }

  async clearAlwaysAllowed(): Promise<void> {
    await this.enqueue('auth-memory.json', () => this.writeAlwaysAllowed([]))
  }

  /** 通用 JSON 列表读写：定时任务、会话、记忆共用 */
  private async readJsonList<T>(name: string): Promise<T[]> {
    const file = this.p(name)
    let raw = ''
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return []
    }
    try {
      const list = JSON.parse(stripBom(raw)) as T[]
      return Array.isArray(list) ? list : []
    } catch {
      // 文件被写坏（例如进程被强杀留下半截）：先留个 .corrupt 备份，别让仅有的数据被空值覆盖掉
      try {
        await fs.copyFile(file, `${file}.corrupt`)
      } catch {
        /* 备份失败也不影响启动 */
      }
      return []
    }
  }

  private async writeJsonList<T>(name: string, list: T[]): Promise<void> {
    await this.writeAtomic(name, JSON.stringify(list, null, 2))
  }

  async listTasks(): Promise<TaskDef[]> {
    return this.readJsonList<TaskDef>('tasks.json')
  }

  /** 新增或整条替换一条任务（读-改-写都在队列里，不会被界面的保存覆盖） */
  async upsertTask(task: TaskDef): Promise<TaskDef[]> {
    return this.enqueue('tasks.json', async () => {
      const list = await this.readJsonList<TaskDef>('tasks.json')
      const idx = list.findIndex((t) => t.id === task.id)
      if (idx >= 0) list[idx] = task
      else list.push(task)
      await this.writeJsonList('tasks.json', list)
      return list
    })
  }

  /** 只改一条任务的指定字段：后台任务回写 lastRun/lastResult 走这里，避免整表覆盖 */
  async updateTask(id: string, patch: Partial<TaskDef>): Promise<TaskDef | null> {
    return this.enqueue('tasks.json', async () => {
      const list = await this.readJsonList<TaskDef>('tasks.json')
      const idx = list.findIndex((t) => t.id === id)
      if (idx < 0) return null
      const updated: TaskDef = { ...list[idx], ...patch }
      list[idx] = updated
      await this.writeJsonList('tasks.json', list)
      return updated
    })
  }

  async deleteTask(id: string): Promise<TaskDef[]> {
    return this.enqueue('tasks.json', async () => {
      const list = (await this.readJsonList<TaskDef>('tasks.json')).filter((t) => t.id !== id)
      await this.writeJsonList('tasks.json', list)
      return list
    })
  }

  async listSessions(): Promise<ChatSession[]> {
    return this.readJsonList<ChatSession>('sessions.json')
  }

  async saveSessions(list: ChatSession[]): Promise<void> {
    await this.enqueue('sessions.json', () => this.writeJsonList('sessions.json', list))
  }

  // ---- 跨会话记忆 ----
  async listMemory(): Promise<MemoryEntry[]> {
    return this.readJsonList<MemoryEntry>('memory.json')
  }

  async saveMemory(list: MemoryEntry[]): Promise<void> {
    await this.enqueue('memory.json', () => this.writeJsonList('memory.json', list))
  }

  /** 记忆的读-改-写也在临界区内完成，避免两次并发保存互相覆盖 */
  async mutateMemory(
    mutate: (list: MemoryEntry[]) => { list: MemoryEntry[]; result: MemoryEntry[] }
  ): Promise<MemoryEntry[]> {
    return this.enqueue('memory.json', async () => {
      const { list, result } = mutate(await this.readJsonList<MemoryEntry>('memory.json'))
      await this.writeJsonList('memory.json', list)
      return result
    })
  }

  // ---- 项目档案（见 projects.ts 的说明：与记忆分开存） ----
  async listProjects(): Promise<ProjectEntry[]> {
    return this.readJsonList<ProjectEntry>('project-archive.json')
  }

  async saveProjects(list: ProjectEntry[]): Promise<void> {
    await this.enqueue('project-archive.json', () => this.writeJsonList('project-archive.json', list))
  }

  /** 读-改-写在一个临界区里完成，避免两次并发保存互相覆盖 */
  async mutateProjects(
    mutate: (list: ProjectEntry[]) => { list: ProjectEntry[]; result: ProjectEntry[] }
  ): Promise<ProjectEntry[]> {
    return this.enqueue('project-archive.json', async () => {
      const { list, result } = mutate(await this.readJsonList<ProjectEntry>('project-archive.json'))
      await this.writeJsonList('project-archive.json', list)
      return result
    })
  }

  /** 同 mutateProjects：会话的插入/删除也在临界区内完成 */
  async mutateSessions(
    mutate: (list: ChatSession[]) => { list: ChatSession[]; result: ChatSession[] }
  ): Promise<ChatSession[]> {
    return this.enqueue('sessions.json', async () => {
      const { list, result } = mutate(await this.readJsonList<ChatSession>('sessions.json'))
      await this.writeJsonList('sessions.json', list)
      return result
    })
  }

  // ---- 桌面悬浮助手的会话（与主窗口分开，见 shared/orb.ts 的说明）----
  async listOrbSessions(): Promise<ChatSession[]> {
    return this.readJsonList<ChatSession>(ORB_SESSIONS_FILE)
  }

  /** 插入/删除都在临界区内：面板与「移到主窗口」可能同时动这份文件 */
  async mutateOrbSessions(
    mutate: (list: ChatSession[]) => { list: ChatSession[]; result: ChatSession[] }
  ): Promise<ChatSession[]> {
    return this.enqueue(ORB_SESSIONS_FILE, async () => {
      const { list, result } = mutate(await this.readJsonList<ChatSession>(ORB_SESSIONS_FILE))
      await this.writeJsonList(ORB_SESSIONS_FILE, list)
      return result
    })
  }
}
