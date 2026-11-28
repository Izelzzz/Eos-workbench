// 界面改动前后逐像素对比：用同一份数据目录启动 eos web，把每个页面按亮色、暗色和 1440、390 两种宽度截整页图，
// 时钟固定，相对时间（「3 分钟前」）不会因为两次截图的时间不同而变。
// 用法：
//   node --import tsx scripts/web-pixels.ts shoot <数据目录> <输出目录>   截图（用当前的 web/dist，先 npm run build:web）
//   node --import tsx scripts/web-pixels.ts compare <目录A> <目录B>       逐像素比较两次截图，有不同就退出码 1
// 数据目录可以用确定性 E2E（scripts/e2e-ci.ts）跑完后的 .eos/e2e/data；脚本会先复制一份，不改原目录。
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: (o?: unknown) => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const FIXED_TIME = new Date('2026-11-28T12:00:00Z')
const WIDTHS = [1440, 390]
const SCHEMES = ['light', 'dark'] as const

const [mode, a, b] = process.argv.slice(2)

// 在浏览器里解码两张 PNG 比较像素。写成字符串：tsx 编译函数时会插入浏览器里没有的辅助函数
const PIXEL_DIFF = `async (p, q) => {
  const load = async src => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, img.width, img.height)
  }
  const i = await load(p)
  const j = await load(q)
  if (i.width !== j.width || i.height !== j.height) return { size: [i.width, i.height, j.width, j.height] }
  let pixels = 0
  const box = [Infinity, Infinity, -1, -1]
  for (let k = 0; k < i.data.length; k += 4) {
    if (i.data[k] !== j.data[k] || i.data[k + 1] !== j.data[k + 1] || i.data[k + 2] !== j.data[k + 2] || i.data[k + 3] !== j.data[k + 3]) {
      pixels++
      const x = (k / 4) % i.width
      const y = Math.floor(k / 4 / i.width)
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y)
    }
  }
  return { pixels, box }
}`

if (mode === 'compare') {
  if (a === undefined || b === undefined) throw new Error('用法：compare <目录A> <目录B>')
  const names = (d: string) =>
    readdirSync(d)
      .filter(n => n.endsWith('.png'))
      .sort()
  const left = names(a)
  const right = names(b)
  const all = [...new Set([...left, ...right])].sort()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const result = []
  for (const n of all) {
    if (!left.includes(n) || !right.includes(n)) {
      result.push({ name: n, same: false, why: '只有一边有' })
      continue
    }
    const x = readFileSync(join(a, n))
    const y = readFileSync(join(b, n))
    if (x.equals(y)) {
      result.push({ name: n, same: true })
      continue
    }
    // 文件字节不同时解码比较像素，报告不同的像素数和范围
    const diff = (await page.evaluate(`(${PIXEL_DIFF})(${JSON.stringify(`data:image/png;base64,${x.toString('base64')}`)}, ${JSON.stringify(`data:image/png;base64,${y.toString('base64')}`)})`)) as {
      pixels?: number
      box?: number[]
      size?: number[]
    }
    result.push({ name: n, same: 'pixels' in diff && diff.pixels === 0, ...diff })
  }
  await browser.close()
  const different = result.filter(r => !r.same)
  console.log(JSON.stringify({ compared: all.length, different }, null, 1))
  process.exit(different.length === 0 ? 0 : 1)
}

if (mode !== 'shoot' || a === undefined || b === undefined) throw new Error('用法：shoot <数据目录> <输出目录> 或 compare <目录A> <目录B>')
const out = b
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'eos-pixels-'))
cpSync(a, data, { recursive: true })

let server: ChildProcess | undefined
process.on('exit', () => {
  server?.kill('SIGKILL')
  rmSync(data, { recursive: true, force: true })
})

// 端口固定：凭据页、代码托管页会显示本页地址，端口不同截图就不同
const port = 43917
const base = await new Promise<string>((resolve, reject) => {
  let output = ''
  const env: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: 'unused-in-this-script' }
  delete env.EOS_MASTER_KEY
  const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--port', String(port), '--data', data], { cwd: ROOT, env })
  server = p
  const on = (chunk: Buffer) => {
    output += chunk.toString()
    const m = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
    if (m) resolve(m[0])
  }
  p.stdout.on('data', on)
  p.stderr.on('data', on)
  p.on('exit', c => reject(new Error(`eos web 退出了（${c}）：${output}`)))
})

const tasks = (await (await fetch(`${base}/api/tasks`)).json()) as { id: string }[]
const taskId = tasks[0]?.id
if (taskId === undefined) throw new Error('数据目录里没有任务')

// 每个页面：名字、地址、等哪个元素出现、截图前要做的操作
type Shot = { name: string; hash: string; ready: string; act?: (page: any) => Promise<void> }
const shots: Shot[] = [
  { name: 'tasks', hash: '#/', ready: 'table.tasks tbody tr' },
  { name: 'new', hash: '#/new', ready: 'main form' },
  { name: 'detail', hash: `#/tasks/${taskId}`, ready: '.trace-row' },
  {
    name: 'detail-tool',
    hash: `#/tasks/${taskId}`,
    ready: '.trace-row',
    act: async page => {
      await page.getByRole('button', { name: '全部展开' }).click()
      await page.locator('.trace-row.kind-tool').first().click()
      await page.waitForSelector('.detail .block pre')
    },
  },
  { name: 'chat', hash: '#/chat', ready: 'main' },
  { name: 'insights', hash: '#/insights', ready: 'main' },
  { name: 'improve', hash: '#/improve', ready: 'main' },
  { name: 'conventions', hash: '#/conventions', ready: 'main' },
  { name: 'credentials', hash: '#/credentials', ready: 'main' },
  { name: 'forges', hash: '#/forges', ready: 'main' },
]

// 关掉 GPU 和分块并行光栅化：否则圆角的抗锯齿每次会差几个像素
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-partial-raster', '--disable-skia-runtime-opts', '--force-color-profile=srgb', '--num-raster-threads=1'] })
const errors: string[] = []
const files: string[] = []
for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme })
    const page = await context.newPage()
    await page.clock.setFixedTime(FIXED_TIME)
    // 页面里有随机生成的默认值（例如代码托管页的 App 名字），换成固定序列
    await page.addInitScript(() => {
      let x = 1
      Math.random = () => (x = (x * 16807) % 2147483647) / 2147483647
    })
    page.on('console', (m: any) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${scheme} ${width} ${m.type()}: ${m.text()}`)
    })
    page.on('pageerror', (e: Error) => errors.push(`${scheme} ${width} pageerror: ${e.message}`))
    for (const s of shots) {
      await page.goto(`${base}/${s.hash}`)
      await page.waitForSelector(s.ready)
      await page.waitForLoadState('networkidle')
      if (s.act) await s.act(page)
      await page.evaluate(() => document.fonts.ready)
      await page.mouse.move(0, 0)
      // 页面会轮询接口、分批渲染：连续两次截图一样才算稳定
      const file = `${s.name}-${scheme}-${width}.png`
      let last: Buffer | undefined
      for (let i = 0; ; i++) {
        await page.waitForTimeout(300)
        const shot: Buffer = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })
        if (last !== undefined && shot.equals(last)) break
        if (i === 20) throw new Error(`${file} 截图一直在变`)
        last = shot
      }
      writeFileSync(join(out, file), last)
      files.push(file)
    }
    await context.close()
  }
}
await browser.close()
writeFileSync(join(out, 'shots.json'), JSON.stringify({ base, taskId, fixedTime: FIXED_TIME.toISOString(), files, errors }, null, 1))
console.log(JSON.stringify({ shots: files.length, errors }, null, 1))
process.exit(errors.length === 0 ? 0 : 1)
