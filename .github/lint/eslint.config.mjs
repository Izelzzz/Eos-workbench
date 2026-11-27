// lint 配置。工具单独装在 .github/lint/（见 package.json 的说明），在仓库根目录运行：
//   npm ci --prefix .github/lint && .github/lint/node_modules/.bin/eslint -c .github/lint/eslint.config.mjs .
//
// 两类规则：
//   1. 架构规则：把 CLAUDE.md「代码约定」里能机器检查的部分写成禁止导入
//   2. 低噪音的通用规则：typescript-eslint 的 recommended，去掉和仓库写法冲突的
// 现有违规不改代码，在文件末尾的「例外」里逐条列出并写理由。新增例外要人批准。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// CLAUDE.md：src/workflow/、src/engine/ 是纯逻辑：不读写文件、不访问网络、不读时钟
const PURE_IO_MODULES = [
  'fs',
  'fs/promises',
  'os',
  'child_process',
  'net',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'tls',
  'worker_threads',
  'cluster',
  'readline',
  'process',
  'timers',
  'timers/promises',
  'perf_hooks',
  'vm',
  'inspector',
  'module',
  'v8',
  'tty',
  'async_hooks',
  // 随机数也会让纯逻辑不可重放
  'crypto',
]
  .flatMap(m => [m, `node:${m}`])
  // node:sqlite 只有带 node: 前缀的写法；仓库的存储层用它，纯逻辑目录里最可能这样读写磁盘
  .concat(['node:sqlite'])
  // 常见的联网 npm 包（全局 fetch 另外在下面禁止）
  .concat(['undici', 'ws', 'node-fetch', 'axios', 'got'])
const pureImports = {
  paths: PURE_IO_MODULES.map(name => ({ name, message: 'src/workflow、src/engine 是纯逻辑：不读写文件、不访问网络、不读时钟（CLAUDE.md 代码约定）' })),
}
// 纯逻辑目录的相对导入只能停在这两个目录之内：否则可以借 src/ 里别的模块间接做 I/O
const pureRelativeImports = {
  regex: '^\\.\\./(?!(engine|workflow)/)',
  message: 'src/workflow、src/engine 是纯逻辑：只能导入这两个目录里的模块，不能借别的模块间接读写文件、访问网络（CLAUDE.md 代码约定）',
}
const pureGlobals = [
  { name: 'globalThis', message: 'src/workflow、src/engine 是纯逻辑：不经 globalThis 取全局（CLAUDE.md 代码约定）' },
  ...['fetch', 'WebSocket', 'XMLHttpRequest', 'performance', 'setTimeout', 'setInterval', 'setImmediate', 'process'].map(name => ({
    name,
    message: 'src/workflow、src/engine 是纯逻辑：不访问网络、不读时钟、不碰进程（CLAUDE.md 代码约定）',
  })),
  { name: 'Date', message: 'src/workflow、src/engine 是纯逻辑：不读时钟。时间从参数传进来（CLAUDE.md 代码约定）' },
]

// CLAUDE.md：每种执行器只在 src/executor/ 下自己的文件里接入；别的模块只认 src/executor/types.ts 的 Executor 接口
const executorImports = {
  patterns: [
    { group: ['@deepseek-ai/*'], message: 'dsh 的包只在 src/executor/dsh.ts 里接入（CLAUDE.md 代码约定）' },
    { group: ['**/vendor/dsh-sdk-client', '**/vendor/dsh-sdk-client/**'], message: 'dsh 的客户端只在 src/executor/dsh.ts 里接入（CLAUDE.md 代码约定）' },
    { group: ['@anthropic-ai/*'], message: 'Claude Agent SDK 只在 src/executor/claude-code.ts 里接入（CLAUDE.md 代码约定）' },
    // executor 目录下除了 types 以外的任何路径（包括子目录和直接导入目录本身）；types 可以带 .ts/.js 等扩展名
    {
      regex: '(^|/)executor(/(?!types(\\.[cm]?[jt]s)?$).*)?$',
      message: '执行器的实现只在 src/executor/ 里，别的模块只认 src/executor/types.ts 的 Executor 接口（CLAUDE.md 代码约定）。执行器在 src/executor/registry.ts 登记，src/cli.ts 只建注册表',
    },
  ],
}

// CLAUDE.md：执行器是可以替换的部件，换一个执行器时 src/executor/ 以外的代码不用改。所以外面不能出现执行器的名字：
// 按名字判断（=== 'dsh'、switch）、按名字取默认值、按名字拼路径都算。执行器的名字只在 src/executor/registry.ts 登记。
// 新登记一个执行器时把名字加进来。
const EXECUTOR_NAMES = ['dsh', 'claude-code']
const executorNameMessage = '执行器的名字只出现在 src/executor/ 里：外面按 Executor 接口和注册表写，不按某个执行器的名字判断或取值（CLAUDE.md 代码约定）'
const executorNameSyntax = [
  { selector: `Literal[value=/^(${EXECUTOR_NAMES.join('|')})$/]`, message: executorNameMessage },
  { selector: `TemplateElement[value.cooked=/^(${EXECUTOR_NAMES.join('|')})$/]`, message: executorNameMessage },
]

export default tseslint.config(
  {
    // .eos/ 是平台数据目录（任务 worktree 是整仓副本），.claude/ 里也可能有 worktree；本地运行时不扫它们
    ignores: ['**/node_modules/**', '**/dist/**', 'web/dist/**', 'poc/**', 'docs/**', 'vendor/**', '.github/lint/**', '.eos/**', '.claude/**'],
  },
  {
    // 不许用 eslint-disable 之类的行内注释关掉规则：例外只能写在本文件里，改本文件时 pr-checklist 会提示要人确认
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,mjs,cjs,js}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Node 和浏览器的全局都允许，具体限制在下面按目录加
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        performance: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        EventSource: 'readonly',
        WebSocket: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
        crypto: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        NodeJS: 'readonly',
      },
    },
    rules: {
      // 仓库约定：_ 开头的参数和变量表示有意不用
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // TypeScript 已经检查未定义的变量，这条在 TS 里只会误报
      'no-undef': 'off',
      // 测试里匹配对齐的输出时，正则里的连续空格是有意的
      'no-regex-spaces': 'off',
    },
  },
  {
    // 验证用的代码（测试、E2E 和探针脚本）经常处理未知结构的 JSON，允许 any
    files: ['tests/**', 'scripts/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // 2. 执行器只在 src/executor/ 里接入；src/cli.ts 只建注册表
  {
    files: ['src/**', 'web/src/**'],
    ignores: ['src/executor/**', 'src/cli.ts'],
    rules: {
      'no-restricted-imports': ['error', executorImports],
      // 动态 import() 绕得过 no-restricted-imports
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression[source.value=/${executorImports.patterns[3].regex.replaceAll('/', '\\/')}/]`,
          message: executorImports.patterns[3].message,
        },
        {
          selector: 'ImportExpression[source.value=/^@deepseek-ai\\//]',
          message: executorImports.patterns[0].message,
        },
        { selector: 'ImportExpression[source.value=/^@anthropic-ai\\//]', message: executorImports.patterns[2].message },
        ...executorNameSyntax,
      ],
    },
  },
  // 执行器目录里：每种执行器的包只在它自己的文件里。landlock.ts 只用 node-addon-system 的 Landlock 启动器（给自己没有可用沙箱的执行器套沙箱）
  {
    files: ['src/executor/**'],
    ignores: ['src/executor/dsh.ts', 'src/executor/claude-code.ts', 'src/executor/landlock.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: executorImports.patterns.slice(0, 3) }] },
  },
  {
    files: ['src/executor/dsh.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [executorImports.patterns[2]] }] },
  },
  {
    files: ['src/executor/claude-code.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: executorImports.patterns.slice(0, 2) }] },
  },
  {
    files: ['src/executor/landlock.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@deepseek-ai/(?!node-addon-system/landlock-run$)', message: 'src/executor/landlock.ts 只用 Landlock 启动器（@deepseek-ai/node-addon-system/landlock-run）' },
            ...executorImports.patterns.slice(1, 3),
          ],
        },
      ],
    },
  },
  {
    files: ['src/cli.ts'],
    rules: {
      // cli 只建注册表：只能引用 src/executor/ 的接口和注册表，不直接引用某个执行器
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...executorImports.patterns.slice(0, 3),
            { regex: '(^|/)executor/(?!(types|registry)(\\.[cm]?[jt]s)?$)', message: 'src/cli.ts 只建执行器注册表（src/executor/registry.ts），不直接引用某个执行器（CLAUDE.md 代码约定）' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        // 动态 import() 绕得过 no-restricted-imports
        {
          selector: 'ImportExpression[source.value=/(^|\\/)executor\\/(?!(types|registry)(\\.[cm]?[jt]s)?$)/]',
          message: 'src/cli.ts 只建执行器注册表（src/executor/registry.ts），不直接引用某个执行器（CLAUDE.md 代码约定）',
        },
        { selector: 'ImportExpression[source.value=/^@deepseek-ai\\//]', message: executorImports.patterns[0].message },
        { selector: 'ImportExpression[source.value=/^@anthropic-ai\\//]', message: executorImports.patterns[2].message },
        ...executorNameSyntax,
      ],
    },
  },

  // 1. 纯逻辑目录（放在执行器规则后面：同一条规则后写的覆盖先写的，所以这里把两类限制合在一起）
  {
    files: ['src/workflow/**', 'src/engine/**'],
    rules: {
      'no-restricted-imports': ['error', { ...pureImports, patterns: [...executorImports.patterns, pureRelativeImports] }],
      'no-restricted-globals': ['error', ...pureGlobals],
      // 动态 import() 绕得过上面的导入限制；纯逻辑里也用不到它
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'src/workflow、src/engine 是纯逻辑：不用动态 import()（CLAUDE.md 代码约定）' }, ...executorNameSyntax],
      // 通过 globalThis 取全局，绕得过 no-restricted-globals
      'no-restricted-properties': ['error', ...pureGlobals.map(g => ({ object: 'globalThis', property: g.name, message: g.message }))],
    },
  },

  // ── 例外 ──────────────────────────────────────────────────────────────
  // 现有代码里的违规，CI 第二批上线时逐条列出，不改代码（改 src/ 要做真实模型 E2E）。
  // 每条写清楚：哪个文件、放开哪条规则、为什么、怎么收回。新增例外要人批准；修好后删掉对应的一条。
  // 例外只放开那一条规则，同一个文件里的其他规则照常检查。
  {
    // src/workflow/templates.ts 从磁盘读内置的工作流模板（readFileSync、readdirSync），违反「纯逻辑不读写文件」。
    // 收回：把读文件移到边界（例如 src/runner/），templates.ts 只解析传进来的文本。另开 PR。
    files: ['src/workflow/templates.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: pureImports.paths.filter(p => p.name !== 'node:fs'),
          patterns: [...executorImports.patterns, pureRelativeImports],
        },
      ],
    },
  },
  {
    // src/executor/dsh.ts:152 用了 any：dsh 的事件类型没有导出。收回：dsh 导出类型后改成具体类型。
    files: ['src/executor/dsh.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // 未使用的导入或变量，CI 上线前就有：src/improve/prompt.ts:2 的 TargetKind、tests/runner.test.ts:6 的 AskHandler、
    // tests/write-scope.test.ts:164 的 git。收回：删掉它们（顺手改的 PR 删掉这一条）。
    files: ['src/improve/prompt.ts', 'tests/runner.test.ts', 'tests/write-scope.test.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    // tests/supervisor.test.ts:165 的 sup 用 let 声明但没有重新赋值。收回：改成 const。
    files: ['tests/supervisor.test.ts'],
    rules: { 'prefer-const': 'off' },
  },
  {
    // scripts/deploy-e2e.ts:127 的空 catch：清理失败时有意忽略。收回：在块里写一句注释说明（no-empty 允许带注释的空块）。
    files: ['scripts/deploy-e2e.ts'],
    rules: { 'no-empty': 'off' },
  },
)
