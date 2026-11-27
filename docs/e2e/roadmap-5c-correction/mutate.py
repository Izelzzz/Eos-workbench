# 修正入口的变异测试：逐个改坏 src/engine/machine.ts，跑 tests/engine.state-space.test.ts 和 tests/engine.correction.test.ts，每个都必须失败。
# 用法（仓库根目录）：python3 docs/e2e/roadmap-5c-correction/mutate.py
import subprocess
P = 'src/engine/machine.ts'
TESTS = ['tests/engine.state-space.test.ts', 'tests/engine.correction.test.ts']
M = [
    ('没完成的任务也接受修正', "if (task.status !== 'done') return ignore(task, '只有已完成的任务可以提交改正或补充')", 'if (false) return ignore(task, "")'),
    ('修正可以交给对话节点', "if (n?.kind !== 'agent') return ignore(task, `「${event.node}」不是这个工作流里的 agent 节点", "if (n === undefined) return ignore(task, `「${event.node}」不是这个工作流里的 agent 节点"),
    ('接受空的修正', "if (text === '') return ignore(task, '改正或补充的内容不能为空')", 'if (false) return ignore(task, "")'),
    ('修正发到别的会话', "{ node: n.id, session: n.id, role: n.role, purpose: 'correct', prompt }", "{ node: n.id, session: task.workflow.nodes[0]!.id, role: n.role, purpose: 'correct', prompt }"),
    ('改完不重跑检查', 'if (checks.length === 0) return finishCorrection(task, at)', 'return finishCorrection(task, at)'),
    ('检查没过也结束修正', 'if (allPassed(results)) return finishCorrection(task, at)', 'return finishCorrection(task, at)'),
    ('修正后不推送（漏掉平台动作）', "const platform = wf.nodes.flatMap(n => (n.kind === 'gate' ? [] : n.checks)).filter(c => c.kind === 'platform')", 'const platform: Check[] = []'),
    ('修正的补齐多一次', 'if (task.correction!.fixes < n.maxFixes)', 'if (task.correction!.fixes <= n.maxFixes)'),
]
src = open(P).read()
run = lambda: subprocess.run(['node', '--import', 'tsx', '--test', *TESTS], capture_output=True, text=True)
r = run()
print('原始代码：', 'pass' if r.returncode == 0 else 'FAIL')
try:
    for name, a, b in M:
        assert src.count(a) == 1, name
        open(P, 'w').write(src.replace(a, b))
        r = run()
        fails = [l for l in r.stdout.splitlines() if l.startswith('not ok')]
        print('抓住' if r.returncode != 0 else '漏掉', name, f'（{len(fails)} 个测试失败）', '；'.join(f[:50] for f in fails[:2]))
finally:
    open(P, 'w').write(src)
