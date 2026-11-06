import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mod = await import('../src/environment.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function home() { const d = mkdtempSync(join(tmpdir(), 'sa-env-')); dirs.push(d); return d }
const source = { PATH: '/bin', HOME: '/personal', USERPROFILE: '/personal', XDG_CONFIG_HOME: '/personal/config', GH_CONFIG_DIR: '/personal/gh', GH_TOKEN: 'dummy-personal', GITHUB_TOKEN: 'dummy-personal', PI_SUPERAGENT_GITHUB_TOKEN: 'dummy-bot', PI_SUPERAGENT_TOKEN: 'dummy-admin', OPENAI_API_KEY: 'dummy-model', AWS_SECRET_ACCESS_KEY: 'dummy-cloud', SSH_AUTH_SOCK: '/personal/ssh-agent', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'personal-helper', GIT_ASKPASS: '/personal/askpass', NODE_OPTIONS: '--require personal.js', BASH_ENV: '/personal/profile', HTTP_PROXY: 'http://127.0.0.1:9999', NO_PROXY: 'localhost,127.0.0.1', LANG: 'en_US.UTF-8' }
it('keeps model-provider environment only in SDK processes, with instance-local credential discovery', () => {
  expect(mod.agentEnvironment).toBeTypeOf('function')
  const h = home(), env = mod.agentEnvironment(h, source)
  expect(env.HOME).toBe(h); expect(env.USERPROFILE).toBe(h); expect(env.GH_CONFIG_DIR).toBe(join(h, '.config', 'gh'))
  expect(env.XDG_CONFIG_HOME).toBe(join(h, '.config')); expect(env.OPENAI_API_KEY).toBe('dummy-model')
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'PI_SUPERAGENT_GITHUB_TOKEN', 'PI_SUPERAGENT_TOKEN', 'SSH_AUTH_SOCK', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS', 'NODE_OPTIONS', 'BASH_ENV']) expect(env[k], k).toBeUndefined()
  expect(env.GIT_CONFIG_GLOBAL).toBe(join(h, '.gitconfig')); expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  expect(env.GIT_SSH_COMMAND).toContain('IdentityFile=none'); expect(source.HOME).toBe('/personal')
})
it('gives jobs only base runtime and network settings, without any ambient credential variables', () => {
  expect(mod.jobEnvironment).toBeTypeOf('function')
  const h = home(), env = mod.jobEnvironment(h, source)
  for (const k of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'PI_SUPERAGENT_GITHUB_TOKEN', 'PI_SUPERAGENT_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'BASH_ENV']) expect(env[k], k).toBeUndefined()
  expect(env.HOME).toBe(h); expect(env.PATH).toBe('/bin'); expect(env.HTTP_PROXY).toBe(source.HTTP_PROXY); expect(env.NO_PROXY).toBe(source.NO_PROXY); expect(env.LANG).toBe(source.LANG)
})
