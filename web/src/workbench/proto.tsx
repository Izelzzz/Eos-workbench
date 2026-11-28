// 工作台高保真原型的入口：只渲染工作台，数据是假的。不是正式页面
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import './workbench.css'
import { Workbench } from './Workbench.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
)
