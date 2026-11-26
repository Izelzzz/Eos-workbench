# 改进提案核对（评审到交付那一段）的变异测试：逐个改坏 src/improve/guard.ts，跑 tests/improve.test.ts，每个都必须失败。
# 用法（仓库根目录）：python3 docs/e2e/guard-review-delivery/mutate.py
import subprocess
P = 'src/improve/guard.ts'
M = [
    ('不比较评审到交付那一段', 'if (x.length > 0 && JSON.stringify(x) !== JSON.stringify(y)) {', 'if (false) {'),
    ('从交付节点开始算（漏掉评审和中间的节点）', '.slice(first < 0 ? last : first, last + 1)', '.slice(last, last + 1)'),
    ('只算到第一个交付节点', "const last = w.nodes.findLastIndex(n => n.checks.some(c => c.kind === 'platform'))", "const last = w.nodes.findIndex(n => n.checks.some(c => c.kind === 'platform'))"),
    ('不看顺序（只比较有哪些节点）', 'JSON.stringify(x) !== JSON.stringify(y)', 'JSON.stringify([...x].sort()) !== JSON.stringify([...y].sort())'),
    ('所有卡点都不算（agent 验收的卡点也能加）', ".filter(n => !(n.kind === 'gate' && n.by.kind === 'human'))\n    .map(shape)\n}\n\n/**\n * 新内容", ".filter(n => n.kind !== 'gate')\n    .map(shape)\n}\n\n/**\n * 新内容"),
    ('只比较节点 id（换 with 也放过）', "const shape = ({ task: _task, inputs: _inputs, ...n }: Workflow['nodes'][number]): string => JSON.stringify(n)", "const shape = (n: Workflow['nodes'][number]): string => JSON.stringify({ id: n.id })"),
    ('人验收的卡点也算（加人验收的卡点被误拦）', ".filter(n => !(n.kind === 'gate' && n.by.kind === 'human'))\n    .map(shape)\n}\n\n/**\n * 新内容", ".map(shape)\n}\n\n/**\n * 新内容"),
]
src = open(P).read()
run = lambda: subprocess.run(['node', '--import', 'tsx', '--test', 'tests/improve.test.ts'], capture_output=True, text=True)
r = run()
print('原始代码：', 'pass' if r.returncode == 0 else 'FAIL')
try:
    for name, a, b in M:
        assert src.count(a) == 1, name
        open(P, 'w').write(src.replace(a, b))
        r = run()
        fails = [l for l in r.stdout.splitlines() if l.startswith('# fail')]
        print('抓住' if r.returncode != 0 else '漏掉', name, fails)
finally:
    open(P, 'w').write(src)
