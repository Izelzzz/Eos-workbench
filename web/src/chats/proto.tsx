// 对话页的原型：导航加对话页，数据是假的。不是正式页面
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../shell/proto.css'
import { Nav } from '../shell/Nav.tsx'
import { ChatsPage } from './ChatsPage.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="flex min-h-screen flex-col bg-bg font-sans text-base text-ink md:h-screen md:flex-row">
      <Nav current="chats" waiting={3} hrefOf={id => `#${id}`} onNavigate={(_, e) => e.preventDefault()} />
      <ChatsPage />
    </div>
  </StrictMode>,
)
