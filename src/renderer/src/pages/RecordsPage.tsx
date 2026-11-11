import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RecordEntry, VerifyState } from '../../../shared/types'
import { SnapshotDiffCard } from '../components/SnapshotDiffCard'

type Filter = 'all' | 'confirmed' | 'rejected'

const KIND_ICON: Record<RecordEntry['kind'], { bg: string; stroke: string; path: ReactNode }> = {
  task: {
    bg: '#EEF3F8',
    stroke: '#3F6E9C',
    path: (
      <>
        <circle cx="8" cy="8" r="5.8" />
        <path d="M8 4.8V8l2.2 1.5" />
      </>
    )
  },
  read: {
    bg: '#F2F2F2',
    stroke: '#616161',
    path: (
      <>
        <rect x="2" y="2.6" width="12" height="10.8" rx="1.6" />
        <path d="M5.2 8h5.6" />
      </>
    )
  },
  web: {
    bg: '#EEF4FB',
    stroke: '#0067C0',
    path: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2.2 8h11.6M8 2.2c3.2 3.4 3.2 8.2 0 11.6M8 2.2c-3.2 3.4-3.2 8.2 0 11.6" />
      </>
    )
  },
  ui: {
    bg: '#FFF4CE',
    stroke: '#8A6100',
    path: (
      <>
        <path d="M8 10.6V3.4M4.6 6.6L8 3.2l3.4 3.4" />
        <path d="M3 11.4v1.2h10v-1.2" />
      </>
    )
  },
  write: {
    bg: '#EEF4FB',
    stroke: '#0067C0',
    path: (
      <>
        <path d="M3 13h2.4l7-7-2.4-2.4-7 7z" />
        <path d="M10.6 4.4l1 1" />
      </>
    )
  },
  destroy: {
    bg: '#FDECEA',
    stroke: '#C42B1C',
    path: (
      <>
        <path d="M3.4 5.2h9.2M6.4 5.2V3.6h3.2v1.6" />
        <path d="M4.8 5.2l.7 7.4h5l.7-7.4" />
      </>
    )
  },
  refuse: {
    bg: '#FDECEA',
    stroke: '#C42B1C',
    path: <path d="M4 4l8 8M12 4l-8 8" />
  },
  memory: {
    bg: '#F3F0FB',
    stroke: '#6B4FBB',
    path: (
      <>
        <path d="M5.4 5.6a2.6 2.6 0 015.2 0v4.8a2.6 2.6 0 01-5.2 0z" />
        <path d="M3.2 8h2.2M10.6 8h2.2" />
      </>
    )
  }
}

const RESULT_LABEL: Record<RecordEntry['result'], { tag: string; note: string }> = {
  ok: { tag: 'tag-ok', note: '已执行' },
  rejected: { tag: 'tag-red', note: '已拒绝' },
  partial: { tag: 'tag-gray', note: '部分完成' }
}

/**
 * 事后核对的三态。
 *
 * 只给"重新查过"和"查了对不上"上标签：unavailable 是"这类动作当场查不到"
 * （卸载要等用户自己点完），它不是结论，标成绿的或红的都是在替它下结论——
 * 那句话放在下面的核对行里，让人自己读。
 */
const VERIFY_TAG: Record<Exclude<VerifyState, 'unavailable'>, { tag: string; note: string }> = {
  confirmed: { tag: 'tag-ok', note: '核对通过' },
  mismatch: { tag: 'tag-red', note: '核对不符' }
}

export default function RecordsPage({ active }: { active: boolean }) {
  const [records, setRecords] = useState<RecordEntry[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  /** 展开了对比卡的销毁记录 id */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleDiff = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const load = async (): Promise<void> => {
    setRecords(await window.butler.records.list(200))
  }

  useEffect(() => {
    if (active) void load()
  }, [active])

  const counts = useMemo(
    () => ({
      all: records.length,
      confirmed: records.filter((r) => r.result === 'ok').length,
      rejected: records.filter((r) => r.result === 'rejected').length
    }),
    [records]
  )

  const shown = useMemo(() => {
    if (filter === 'confirmed') return records.filter((r) => r.result === 'ok')
    if (filter === 'rejected') return records.filter((r) => r.result === 'rejected')
    return records
  }, [records, filter])

  const filters: Array<{ key: typeof filter; label: string; n: number }> = [
    { key: 'all', label: '全部', n: counts.all },
    { key: 'confirmed', label: '成功执行', n: counts.confirmed },
    { key: 'rejected', label: '被拒绝', n: counts.rejected }
  ]

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>记录</h2>
          <button className="icobtn" onClick={() => void load()} title="刷新">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4.6V10h-5.4" />
            </svg>
          </button>
        </div>
        <div className="seclabel">
          过滤<span className="cnt">{records.length} 条</span>
        </div>
        {filters.map((f) => (
          <button key={f.key} className={`item${filter === f.key ? ' sel' : ''}`} onClick={() => setFilter(f.key)}>
            <span className="t">{f.label}</span>
            <span className="tm">{f.n}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div className="hint" style={{ fontSize: 11, color: '#A5A59D', padding: '8px 6px 0' }}>
          全部留痕 · 拒绝的不会执行
        </div>
      </aside>

      <main className="content">
        <div className="card log">
        <div className="lhead">
          <div>时间</div>
          <div>动作</div>
          <div>结果</div>
          <div style={{ textAlign: 'right' }}>撤回</div>
        </div>
        <div className="lwrap">
          {shown.length === 0 && <div className="empty">还没有记录。去对话里问一句试试。</div>}
          {shown.map((record) => {
            const icon = KIND_ICON[record.kind]
            // 超时的卡在审计里 result=rejected + authz=expired，单独标出与主动拒绝区分
            const label =
              record.authz === 'expired' ? { tag: 'tag-gray', note: '超时未响应' } : RESULT_LABEL[record.result]
            const hasDiff = Boolean(record.snapshot) && record.result !== 'rejected'
            return (
              <Fragment key={record.id}>
                <div className="lrow">
                  <div className="ltime">
                    {new Date(record.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div className="lact">
                    <div className="ic" style={{ background: icon.bg }}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={icon.stroke} strokeWidth="1.5">
                        {icon.path}
                      </svg>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="tx">{record.title}</div>
                      <div className="sub">{record.sub}</div>
                      {/* 写操作的事后核对：查了什么、查到什么。没有这一行就是当时没核对 */}
                      {record.verifyFact && <div className="sub verify">核对：{record.verifyFact}</div>}
                    </div>
                  </div>
                  <div className="res">
                    <span className={`tag ${label.tag}`}>{label.note}</span>
                    {record.verified && record.verified !== 'unavailable' && (
                      <span className={`tag ${VERIFY_TAG[record.verified].tag}`}>{VERIFY_TAG[record.verified].note}</span>
                    )}
                    <span className="note">
                      {record.result === 'rejected' ? '文件未动' : record.undo ? `撤回：${record.undo}` : ''}
                    </span>
                  </div>
                  {/* 能撤回的只有回收站，而且必须用户自己点；应用内不做「一键撤销」 */}
                  {record.reversible && record.undo === '回收站还原' ? (
                    <button className="undo" onClick={() => void window.butler.shell.recycleBin()}>
                      去还原
                    </button>
                  ) : hasDiff ? (
                    <button
                      className="undo"
                      style={{ justifySelf: 'end' }}
                      onClick={() => toggleDiff(record.id)}
                      title="对比卸载前后的注册表 / 安装目录 / 自启项"
                    >
                      {expanded.has(record.id) ? '收起对比' : '卸载对比'}
                    </button>
                  ) : (
                    <span className="undo off" style={{ justifySelf: 'end' }} title={record.undo ?? undefined}>
                      —
                    </span>
                  )}
                </div>
                {hasDiff && expanded.has(record.id) && (
                  <div className="lrow-diff">
                    <SnapshotDiffCard snapshotId={record.snapshot!} />
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      </div>

        <div className="note-bar">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#7A7A7A" strokeWidth="1.4">
            <path d="M8 2.6l4.6 2v3.6c0 2.6-1.9 4.5-4.6 5.2-2.7-.7-4.6-2.6-4.6-5.2V4.6z" />
          </svg>
          <span>
            <b>销毁类操作没有你的点按就不执行</b>：目前只有演示沙箱里的删除，且走回收站。
            你拒绝、超时、或这次请求结束时还没点，都按「拒绝」收口，文件不动；走了回收站的记录，撤回列给的是「去还原」——本应用不代你还原，免得假装可撤销。
          </span>
        </div>
      </main>
    </div>
  )
}
