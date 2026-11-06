import React from 'react'
import { createRoot } from 'react-dom/client'
import { OrbApp } from './OrbApp'
import './orb.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

// 同一个页面文件承担两个角色：主进程建窗口时会带上 ?view=ball 或 ?view=panel
const role = new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'ball'

createRoot(container).render(
  <React.StrictMode>
    <OrbApp role={role} />
  </React.StrictMode>
)
