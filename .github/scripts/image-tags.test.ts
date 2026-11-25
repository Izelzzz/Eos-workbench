import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { imageTags } from './image-tags.ts'

const IMAGE = 'ghcr.io/izelzzz/eos-workbench'
const SHA = '0123456789abcdef0123456789abcdef01234567'

test('a release tag publishes the version and latest', () => {
  assert.deepEqual(imageTags(IMAGE, 'tag', 'v1.2.3', SHA), { tags: [`${IMAGE}:1.2.3`, `${IMAGE}:latest`], version: '1.2.3' })
})

test('a pre-release tag does not move latest', () => {
  assert.deepEqual(imageTags(IMAGE, 'tag', 'v1.3.0-rc.1', SHA).tags, [`${IMAGE}:1.3.0-rc.1`])
})

test('main publishes main and a short sha tag', () => {
  assert.deepEqual(imageTags(IMAGE, 'branch', 'main', SHA), { tags: [`${IMAGE}:main`, `${IMAGE}:sha-0123456`], version: 'main-0123456' })
})

test('other refs and tags that are not valid image tags are refused', () => {
  assert.throws(() => imageTags(IMAGE, 'branch', 'feature', SHA))
  assert.throws(() => imageTags(IMAGE, 'tag', 'release-1', SHA))
  assert.throws(() => imageTags(IMAGE, 'tag', 'v', SHA))
  assert.throws(() => imageTags(IMAGE, 'tag', 'vnext', SHA))
  assert.throws(() => imageTags(IMAGE, 'tag', 'v1.0/evil', SHA))
  assert.throws(() => imageTags(IMAGE, 'tag', 'v1 2', SHA))
  assert.throws(() => imageTags(IMAGE, 'branch', 'main', 'not-a-sha'))
})

test('the command line prints GITHUB_OUTPUT lines', () => {
  const out = execFileSync(process.execPath, [new URL('./image-tags.ts', import.meta.url).pathname, IMAGE, 'tag', 'v2.0.0', SHA], { encoding: 'utf8' })
  assert.equal(out, `tags=${IMAGE}:2.0.0 ${IMAGE}:latest\nfirst=${IMAGE}:2.0.0\nversion=2.0.0\n`)
})

test('the command line fails on a ref it does not publish', () => {
  assert.throws(() => execFileSync(process.execPath, [new URL('./image-tags.ts', import.meta.url).pathname, IMAGE, 'branch', 'dev', SHA], { stdio: 'pipe' }))
})
