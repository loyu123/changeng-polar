import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SnapshotDiff } from '../../../shared/types'

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function Fact({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }): ReactNode {
  return (
    <div className="diff-fact">
      <span className="k">{label}</span>
      <span className={ok ? 'v ok' : 'v no'}>{ok ? okText : badText}</span>
    </div>
  )
}

/**
 * 卸载前后对比卡：拿记录里留的快照 id，即时与当下比一次。
 * 只陈述现状（注册表项/目录/自启项还在不在、文件数变化），
 * 不推断卸载程序做得对不对，也不提供任何"还原"。
 */
export function SnapshotDiffCard({ snapshotId }: { snapshotId: string }) {
  const [diff, setDiff] = useState<SnapshotDiff | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const d = await window.butler.snapshot.diff(snapshotId)
      if (d) {
        setDiff(d)
        setState('ok')
      } else {
        setDiff(null)
        setState('missing')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [snapshotId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="diff-card">
      <div className="diff-h">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#6B4FBB" strokeWidth="1.5">
          <rect x="2" y="2.6" width="12" height="10.8" rx="1.6" />
          <path d="M5.2 8h5.6" />
        </svg>
        卸载前后对比
        <span className="diff-when">
          {diff ? `快照时间 ${new Date(diff.takenAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button className="btn btn-ghost btn-sm diff-re" onClick={() => void load()}>
          重新比对
        </button>
      </div>

      {state === 'loading' && <div className="diff-line">正在读取当下状态…</div>}
      {state === 'missing' && <div className="diff-line">找不到这条快照（可能是旧版本留的记录），对比做不了</div>}
      {state === 'error' && <div className="diff-line">对比失败：{error}</div>}

      {state === 'ok' && diff && (
        <>
          <div className="diff-verdict">{diff.verdict}</div>
          <div className="diff-grid">
            <Fact label="注册表卸载项" ok={!diff.registryStillThere} okText="已消失" badText="还在（可能没卸完）" />
            <Fact label="安装目录" ok={!diff.installDirStillThere} okText="已不存在" badText="还在" />
            <div className="diff-fact">
              <span className="k">文件数</span>
              <span className="v">
                {diff.filesBefore} → {diff.filesNow}
                {diff.filesBefore > diff.filesNow ? `（少了 ${diff.filesBefore - diff.filesNow}）` : ''}
              </span>
            </div>
            <div className="diff-fact">
              <span className="k">体积</span>
              <span className="v">
                {mb(diff.bytesBefore)} → {mb(diff.bytesNow)}
              </span>
            </div>
          </div>
          {diff.startupGone.length > 0 && (
            <div className="diff-line">
              <b>已消失的自启项：</b>
              {diff.startupGone.join('、')}
            </div>
          )}
          {diff.startupStillThere.length > 0 && (
            <div className="diff-line warn">
              <b>还在的自启项：</b>
              {diff.startupStillThere.join('、')}（要关去「设置 → 应用 → 启动」或任务管理器）
            </div>
          )}
          {(diff.residualLeft?.length ?? 0) > 0 && (
            <div className="diff-line warn">
              <b>数据残留（只报告，不代删）：</b>
              {diff.residualLeft.map((r, i) => (
                <div key={i} style={{ marginLeft: 14 }}>
                  {r.path}（{mb(r.totalBytes)} · {r.fileCount} 个文件）
                </div>
              ))}
              确认不要了可以自己删，或以后让管家在授权后清理。
            </div>
          )}
          {diff.residualCleaned > 0 && (
            <div className="diff-line">数据目录已清掉 {diff.residualCleaned} 处（卸载前记过账）</div>
          )}
        </>
      )}
    </div>
  )
}
