import { OrbBall } from './OrbBall'
import { OrbPanel } from './OrbPanel'

/**
 * 悬浮助手的根组件。
 *
 * 同一个 orb.html 承担两个角色（主进程建窗口时带 ?view=）：
 * - ball  桌面上的那颗球，72×72 透明窗口
 * - panel 点开后弹出的面板，380×560
 * 放一个页面里是因为两者共用 preload、共用主题令牌与标记绘制，拆两套反而重复。
 */
export function OrbApp({ role }: { role: 'ball' | 'panel' }): React.ReactNode {
  return role === 'panel' ? <OrbPanel /> : <OrbBall />
}
