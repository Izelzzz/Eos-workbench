// 契约测试：部署镜像（Dockerfile）设的环境变量和 dsh 的环境白名单（src/executor/dsh.ts 的 AGENT_ENV_KEEP）要对得上。
// - 镜像里每个 ENV 都要有归属：要么 agent 那边要用、在白名单里；要么只给平台用、在下面 PLATFORM_ONLY 里写明理由。
//   以后在 Dockerfile 加一个 ENV，这里先失败，逼着决定它该不该交给 dsh 和 agent。
// - 白名单里不能有像凭据的名字：白名单里的变量会原样进 agent 的工具子进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_ENV_KEEP, agentEnv, agentEnvAllowed } from '../src/executor/dsh.ts'

const ROOT = join(import.meta.dirname, '..')

/** 只给平台进程用、不交给 dsh 的镜像变量，以及为什么 */
const PLATFORM_ONLY: Record<string, string> = {
  EOS_HOME: '平台的数据目录；agent 只该看到自己的 worktree',
  EOS_CHECK_USER: '平台切换到检查命令用户时用；agent 用不到',
  EOS_DSH_LAUNCHER: '平台启动 dsh 的入口脚本路径；由平台自己读',
  TSX_DISABLE_CACHE: '只管平台自己的 tsx 编译缓存（平台用 tsx 跑源码）',
}

/** 最后一个 FROM 之后（运行镜像）的 ENV，支持一行写多个 KEY=VALUE 和行尾续行 */
function runtimeEnv(dockerfile: string): Record<string, string> {
  const joined = dockerfile.replace(/\\\n/g, ' ')
  const lines = joined.split('\n')
  const lastFrom = lines.findLastIndex(l => /^FROM\s/i.test(l))
  assert.ok(lastFrom >= 0, 'Dockerfile 里找不到 FROM')
  const env: Record<string, string> = {}
  for (const line of lines.slice(lastFrom + 1)) {
    const m = /^ENV\s+(.+)$/i.exec(line.trim())
    if (m === null) continue
    for (const pair of m[1]!.trim().split(/\s+/)) {
      // 解析得严：认不出的写法（旧的 ENV KEY VALUE、带引号或空格的值、变量替换）直接失败，不静默跳过，免得漏掉一个变量
      const m2 = /^([A-Za-z_][A-Za-z0-9_]*)=([^"'$\s]*)$/.exec(pair)
      assert.ok(m2 !== null, `Dockerfile 的 ENV 只认 KEY=VALUE（值里不带引号、空格、$），这一行要么改写法、要么同步改这个测试的解析：${line}`)
      assert.ok(!(m2[1]! in env), `Dockerfile 的 ENV 里 ${m2[1]} 设了两次`)
      env[m2[1]!] = m2[2]!
    }
  }
  return env
}

const env = runtimeEnv(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))

test('解析得到运行镜像的 ENV（防止解析出错时下面的测试空跑）', () => {
  assert.ok(Object.keys(env).length >= 10, JSON.stringify(env))
  assert.equal(env.EOS_AGENT_USER, 'eos-agent')
  assert.equal(env.npm_config_cache, '/tmp/cache/npm')
})

test('镜像里的每个 ENV 都有归属：在 dsh 的白名单里，或者明确只给平台用', () => {
  const orphan = Object.keys(env).filter(k => !agentEnvAllowed(k) && !(k in PLATFORM_ONLY))
  assert.deepEqual(orphan, [], '新加的 ENV 要决定：agent 要用就加进 src/executor/dsh.ts 的 AGENT_ENV_KEEP，只给平台用就加进这里的 PLATFORM_ONLY 并写理由')
  const both = Object.keys(PLATFORM_ONLY).filter(agentEnvAllowed)
  assert.deepEqual(both, [], '既在白名单里又标成只给平台用，两边说法矛盾')
  const stale = Object.keys(PLATFORM_ONLY).filter(k => !(k in env))
  assert.deepEqual(stale, [], 'PLATFORM_ONLY 里有 Dockerfile 已经不设的变量，删掉')
})

test('镜像里给 agent 的变量真的会交给 dsh，只给平台的不会', () => {
  const passed = agentEnv(env, 'k')
  for (const k of Object.keys(env)) {
    if (k in PLATFORM_ONLY) assert.equal(passed[k], undefined, k)
    else assert.equal(passed[k], env[k], k)
  }
})

test('白名单里没有像凭据的名字（白名单里的变量会进 agent 的工具子进程）', () => {
  const secretish = /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION/i
  assert.deepEqual(
    AGENT_ENV_KEEP.filter(k => secretish.test(k)),
    [],
  )
  // 平台持有的凭据都不在白名单里（模型 key 由 agentEnv 单独加给 dsh 进程，见 dsh.ts 的说明）
  for (const k of ['DEEPSEEK_API_KEY', 'EOS_MASTER_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_ASKPASS', 'NPM_TOKEN', 'npm_config__authToken']) {
    assert.equal(agentEnvAllowed(k), false, k)
  }
})
