// Landlock 启动器：把一个命令和它起的所有子进程限制成只能写给定的目录，其余只读（node-addon-system 的 landlock-run）。
// 自己没有沙箱、或者自己的沙箱在 Docker 里用不了的执行器（Claude Code）用它。dsh 有自己的 Landlock 实现，不经过这里。
import { grantArgs, launcherPath, probe, type LandlockEnforcement } from '@deepseek-ai/node-addon-system/landlock-run'

export type { LandlockEnforcement }

/** 这台机器上 Landlock 能不能用：真正施加一次规则来探测（不是只看内核版本）。非 Linux 一律 unusable。 */
export const landlockProbe = (platform: string = process.platform): LandlockEnforcement => (platform === 'linux' ? probe(undefined, { timeoutMs: 5000 }) : 'unusable')

/** 在 Landlock 下运行 argv：整个文件系统只读，只有 readWrite 里的目录（和文件）能写。返回要执行的完整命令。 */
export const confined = (readWrite: readonly string[], argv: readonly string[]): string[] => [launcherPath(), ...grantArgs({ readOnly: ['/'], readWrite }), '--', ...argv]
