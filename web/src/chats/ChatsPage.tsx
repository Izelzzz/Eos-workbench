import { useState } from 'react'
import { ChatList } from './ChatList.tsx'
import { Conversation } from './Conversation.tsx'
import { conversations as seed, type Conversation as Chat, type WorkflowChange } from './mock.ts'

/** 对话页：一个居中的对话，或者全部对话的列表。不依赖页面上的其他部分 */
export function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>(seed)
  const [view, setView] = useState<'chat' | 'list'>('chat')
  const [id, setId] = useState<string>()
  const [waiting, setWaiting] = useState(false)
  const chat = chats.find(c => c.id === id)

  const open = (cid: string) => {
    setId(cid)
    setView('chat')
  }
  const send = (text: string) => {
    let cid = id
    if (chat === undefined) {
      cid = `n${Date.now()}`
      setChats(cs => [{ id: cid!, title: text.slice(0, 16), when: '刚刚', group: '最近 7 天', outcome: '准备了 1 个任务，还没创建', messages: [] }, ...cs])
      setId(cid)
    }
    setChats(cs => cs.map(c => (c.id === cid ? { ...c, messages: [...c.messages, { from: 'me', text }] } : c)))
    setWaiting(true)
    // 原型：代理人的回复是写死的
    setTimeout(() => {
      setWaiting(false)
      setChats(cs =>
        cs.map(c =>
          c.id === cid ? { ...c, messages: [...c.messages, { from: 'agent', text: '我按这个需求准备了一个任务。', card: { kind: 'task', title: text.slice(0, 16), repo: 'eos-workbench', workflow: 'standard', need: text } }] } : c,
        ),
      )
    }, 700)
  }

  // 原型：重新提的一版只是在原来的基础上标一处「按你说的改了」
  const revise = (text: string, of: WorkflowChange) => {
    const cid = id
    setChats(cs => cs.map(c => (c.id === cid ? { ...c, messages: [...c.messages, { from: 'me', text }] } : c)))
    setWaiting(true)
    setTimeout(() => {
      setWaiting(false)
      const last = of.stages.findLast(s => s.summary !== undefined)
      const stages = of.stages.map(s => (s === last ? { ...s, summary: '按你说的改了', detail: `按「${text}」调整。` } : s))
      setChats(cs => cs.map(c => (c.id === cid ? { ...c, messages: [...c.messages, { from: 'agent', text: '改好了，这是新的一版。', card: { ...of, stages } }] } : c)))
    }, 700)
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface max-md:min-h-screen">
      {view === 'list' ? (
        <ChatList
          chats={chats}
          onOpen={open}
          onNew={() => {
            setId(undefined)
            setView('chat')
          }}
          onDelete={cid => {
            setChats(cs => cs.filter(c => c.id !== cid))
            if (cid === id) setId(undefined)
          }}
          onBack={() => setView('chat')}
        />
      ) : (
        <Conversation chat={chat} recent={chats.slice(0, 5)} onOpen={open} onNew={() => setId(undefined)} onAll={() => setView('list')} onSend={send} onRevise={revise} waiting={waiting} />
      )}
    </main>
  )
}
