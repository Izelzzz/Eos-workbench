// 任务详情页的原型：导航加任务详情，数据是假的。不是正式页面
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../shell/proto.css'
import { Nav } from '../shell/Nav.tsx'
import { TaskDetailPage } from './TaskDetailPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="flex min-h-screen flex-col bg-bg font-sans text-base text-ink md:h-screen md:flex-row">
      <Nav current="tasks" waiting={3} hrefOf={id => `#${id}`} onNavigate={(_, e) => e.preventDefault()} />
      <TaskDetailPage />
    </div>
  </StrictMode>,
)
