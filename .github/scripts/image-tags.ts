// 发布到 ghcr 的镜像打哪些标签（.github/workflows/image.yml 调用）。
// 命令行：node image-tags.ts <镜像> <ref_type> <ref_name> <提交号>，输出 tags=、first=、version= 三行（image-build.sh 读）。

export type ImageTags = { tags: string[]; version: string }

/** Docker 标签允许的字符和长度。 */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

/**
 * v* 标签：<版本号>（去掉 v），版本号里没有 -（不是预发布版）时加 latest。main 分支：main 和 sha-<前 7 位>。
 * 其他 ref 和不合法的版本号抛错：工作流只在这两种 push 上发布。
 */
export const imageTags = (image: string, refType: string, refName: string, sha: string): ImageTags => {
  if (refType === 'tag') {
    if (!refName.startsWith('v')) throw new Error(`标签 ${refName} 不是 v 开头`)
    const version = refName.slice(1)
    if (!/^\d/.test(version) || !TAG.test(version)) throw new Error(`标签 ${refName} 的版本号不能用作镜像标签`)
    return { tags: [`${image}:${version}`, ...(version.includes('-') ? [] : [`${image}:latest`])], version }
  }
  if (refType === 'branch' && refName === 'main') {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`提交号 ${sha} 不对`)
    return { tags: [`${image}:main`, `${image}:sha-${sha.slice(0, 7)}`], version: `main-${sha.slice(0, 7)}` }
  }
  throw new Error(`不发布 ${refType} ${refName}`)
}

if (import.meta.main) {
  const [image, refType, refName, sha] = process.argv.slice(2)
  const r = imageTags(image ?? '', refType ?? '', refName ?? '', sha ?? '')
  console.log(`tags=${r.tags.join(' ')}\nfirst=${r.tags[0]}\nversion=${r.version}`)
}
