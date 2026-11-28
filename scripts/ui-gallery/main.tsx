/// <reference types="vite/client" />
// 基础组件样张：只给 scripts/web-ui-gallery.ts 截图和操作用，不进网页构建。
// 引入和网页一样的样式（令牌、工具类、现有页面的 styles.css），确认组件在真实的层叠顺序下显示正确。
import { type ReactNode, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../web/src/index.css'
import '../../web/src/styles.css'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '../../web/src/ui/index.ts'

// 样张本身的布局用内联样式（scripts/ 不在 Tailwind 的扫描范围里），取值引用令牌
const page = { display: 'flex', flexDirection: 'column', gap: 44, maxWidth: 700, margin: '0 auto', padding: '40px 16px' } as const
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const
const stack = { display: 'flex', flexDirection: 'column', gap: 12 } as const
const meta = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-code)', color: 'var(--ink-3)' } as const

/** 区块标题：小号灰字，不抢内容 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={stack}>
      <h3 style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 'var(--font-weight-medium)', color: 'var(--ink-2)' }}>{title}</h3>
      {children}
    </section>
  )
}

function Gallery() {
  const [confirmed, setConfirmed] = useState(0)
  return (
    <main style={page}>
      {/* 一屏只有一张浮起来的卡片：和设计稿里「等你处理」的当前卡片对照 */}
      <Card>
        <CardHeader>
          <div style={meta}>
            <Badge variant="accent">提问</Badge>
            <span>eos-workbench</span>
            <span>规格阶段</span>
            <span>12 分钟前</span>
          </div>
          <CardTitle>导出任务列表为 CSV</CardTitle>
          <CardDescription>规格 agent 在写验收标准。你的需求里有两处没有说：导出的范围，和文件的编码。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="g-name">App 名字</FieldLabel>
              <Input id="g-name" defaultValue="eos-team" spellCheck={false} />
              <FieldDescription>最多 34 个字符，不能和 GitHub 上已有的 App 重名。</FieldDescription>
            </Field>
            <Field data-invalid>
              <FieldLabel htmlFor="g-org">组织</FieldLabel>
              <Input id="g-org" aria-invalid defaultValue="no such org" />
              <FieldError>找不到这个组织，检查拼写或留空。</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button variant="outline">稍后</Button>
          <Button>保存</Button>
        </CardFooter>
      </Card>

      <Section title="按钮">
        <div style={row}>
          <Button>主操作</Button>
          <Button variant="outline">次要</Button>
          <Button variant="destructive">删除</Button>
          <Button variant="ghost" size="sm">
            文字按钮
          </Button>
          <Button variant="link">查看日志</Button>
          <Button disabled>正在保存…</Button>
        </div>
      </Section>

      <Section title="标签">
        <div style={row}>
          <Badge>推荐</Badge>
          <Badge variant="accent">等你处理</Badge>
          <Badge variant="outline">dsh</Badge>
          <Badge variant="running">进行中</Badge>
          <Badge variant="success">完成</Badge>
          <Badge variant="warning">等验收</Badge>
          <Badge variant="destructive">失败</Badge>
          <Badge variant="pending">未开始</Badge>
        </div>
      </Section>

      <Section title="表单">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="g-flow">工作流</FieldLabel>
            <Select id="g-flow" defaultValue="feature">
              <option value="feature">feature</option>
              <option value="feature-pr">feature-pr</option>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="g-req">需求</FieldLabel>
            <Textarea id="g-req" rows={3} placeholder="例如：给 sum 加上参数校验…" />
          </Field>
        </FieldGroup>
      </Section>

      <Section title="提示">
        <Alert>
          <AlertDescription>导出的行数会和列表页不一样。</AlertDescription>
        </Alert>
        <Alert variant="success">
          <AlertTitle>已保存</AlertTitle>
        </Alert>
        <Alert variant="warning">
          <AlertTitle>平台没有主密钥</AlertTitle>
          <AlertDescription>保存后存不了凭据。</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>推送失败</AlertTitle>
          <AlertDescription>令牌没有这个仓库的写权限。</AlertDescription>
        </Alert>
      </Section>

      <Section title="表格">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>需求</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>t261128065144in1</TableCell>
              <TableCell>
                <Badge variant="success">完成</Badge>
              </TableCell>
              <TableCell>给 sum 加上参数校验，非数字时抛 TypeError</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>t261128070101ab2</TableCell>
              <TableCell>
                <Badge variant="running">进行中</Badge>
              </TableCell>
              <TableCell>README 补用法示例</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="对话框">
        <div style={row}>
          <Dialog>
            <DialogTrigger render={<Button variant="destructive" />}>删除凭据</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>删除 github.com 的令牌？</DialogTitle>
                <DialogDescription>删除后，用到它的任务推送会失败，直到重新保存。</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
                <DialogClose render={<Button variant="destructive" />} onClick={() => setConfirmed(n => n + 1)}>
                  删除
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <span id="confirmed">已确认 {confirmed} 次</span>
          <Button id="bare-ghost" variant="ghost" size="sm">
            在页面底色上的文字按钮
          </Button>
          <Button id="bare-link" variant="link">
            链接按钮
          </Button>
        </div>
      </Section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
