/// <reference types="vite/client" />
// 基础组件样张：只给 scripts/web-ui-gallery.ts 截图和操作用，不进网页构建。
// 引入和网页一样的样式（令牌、工具类、现有页面的 styles.css），确认组件在真实的层叠顺序下显示正确。
import { StrictMode, useState } from 'react'
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

const stack = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', padding: 16 } as const
const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const

function Gallery() {
  const [confirmed, setConfirmed] = useState(0)
  return (
    <main style={stack}>
      <Card>
        <CardHeader>
          <CardTitle>按钮</CardTitle>
        </CardHeader>
        <CardContent style={row}>
          <Button>保存</Button>
          <Button variant="outline">取消</Button>
          <Button variant="secondary">次要</Button>
          <Button variant="ghost">更多</Button>
          <Button variant="destructive">删除</Button>
          <Button variant="link">查看日志</Button>
          <Button size="sm">小按钮</Button>
          <Button disabled>正在保存…</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>状态</CardTitle>
        </CardHeader>
        <CardContent style={row}>
          <Badge variant="running">进行中</Badge>
          <Badge variant="success">完成</Badge>
          <Badge variant="warning">等验收</Badge>
          <Badge variant="destructive">失败</Badge>
          <Badge variant="pending">未开始</Badge>
          <Badge>草稿</Badge>
          <Badge variant="outline">dsh</Badge>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>表单</CardTitle>
          <CardDescription>说明文字只在有限制或后果时写。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="g-name">App 名字</FieldLabel>
              <Input id="g-name" defaultValue="eos-team" spellCheck={false} />
              <FieldDescription>注册后在 GitHub 上还能改。</FieldDescription>
            </Field>
            <Field data-invalid>
              <FieldLabel htmlFor="g-org">组织</FieldLabel>
              <Input id="g-org" aria-invalid defaultValue="no such org" />
              <FieldError>找不到这个组织，检查拼写或留空。</FieldError>
            </Field>
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
        </CardContent>
        <CardFooter>
          <Button type="button">创建任务</Button>
        </CardFooter>
      </Card>
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
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
