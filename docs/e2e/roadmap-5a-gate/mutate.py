import subprocess, shutil, sys
P='src/engine/machine.ts'; BAK=sys.argv[1]
M=[
 ('卡点接受过期那一次的结论', ' || g.round !== event.round) return ignore', ') return ignore'),
 ('卡点打回改完不重跑检查', "(g.checks.length > 0 ? runChecks(withGate(task, { phase: 'check' }), g) : decide(task, g, at))", 'decide(task, g, at)'),
 ('卡点打回不要求意见', "if (!event.pass && comment === '') return ignore(task, '打回时要写明意见')", 'if (false) return ignore(task, "")'),
 ('agent 验收多打回一次', 'cycle >= g.by.maxRounds', 'cycle > g.by.maxRounds'),
 ('卡点重跑检查没通过也回到卡点', 'if (allPassed(results)) return decide(task, g, at)', 'return decide(task, g, at)'),
 ('打回意见发到卡点自己的会话', "session: g.with, role: roleOfAgent(task, g.with), purpose: 'amend'", "session: g.id, role: roleOfAgent(task, g.with), purpose: 'amend'"),
 ('打回后第几次不加一（过期结论能通过）', "formatRetries: 0, round: round + 1 })", "formatRetries: 0 })"),
 ('人验收时不进入等待验收（显示成运行中）', "if (g.by.kind === 'human') return { ...noted, status: 'waiting_accept', pending: undefined }", "if (g.by.kind === 'human') return { ...noted, status: 'running', pending: undefined }"),
]
src=open(P).read()
print('原始代码：', 'pass' if subprocess.run(['node','--import','tsx','--test','tests/engine.state-space.test.ts','tests/engine.gate.test.ts'],capture_output=True).returncode==0 else 'FAIL')
for name,a,b in M:
    assert src.count(a)==1,(name)
    open(P,'w').write(src.replace(a,b))
    r=subprocess.run(['node','--import','tsx','--test','tests/engine.state-space.test.ts','tests/engine.gate.test.ts'],capture_output=True,text=True)
    fails=[l for l in r.stdout.splitlines() if l.startswith('not ok')]
    fail_n=[l for l in r.stdout.splitlines() if l.startswith('# fail')]
    print(('抓住' if r.returncode!=0 and fails else '漏掉'), name, fail_n, '；'.join(f[:60] for f in fails[:3]))
    shutil.copy(BAK,P)
