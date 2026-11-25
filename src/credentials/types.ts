// 凭据的对外类型（纯类型，前端也引用）。凭据的值只在平台进程里解密，这里的类型都不带值。

/** 凭据属于谁。现在没有登录，所有凭据都属于 LOCAL_OWNER；以后接上多人登录时换成用户 id。 */
export type Owner = string & { readonly __owner: unique symbol }
export const LOCAL_OWNER = 'local' as Owner

/**
 * api-key：模型服务的 key；token：Git 托管服务的令牌（个人访问令牌等）；
 * github-app：GitHub App 的 id 和私钥（JSON），平台用它换短期的安装令牌；
 * github-user：某个人通过 GitHub App 授权给平台的用户令牌（JSON，带刷新令牌），平台以这个人的身份推送、开 PR。
 */
export const CREDENTIAL_KINDS = ['api-key', 'token', 'github-app', 'github-user'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/**
 * 列表里的一条凭据：没有值。keyId 是加密它的主密钥的指纹，换过主密钥之后能看出哪些凭据要重新录入。
 * kind 是 unknown：数据库里的类型这个版本不认识（例如新版本写的，又退回了旧版本），列出来让人能找到并删掉。
 */
export type CredentialInfo = { name: string; kind: CredentialKind | 'unknown'; keyId: string; createdAt: number; updatedAt: number }
