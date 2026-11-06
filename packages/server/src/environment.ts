import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

function localHome(home: string): NodeJS.ProcessEnv {
  home = resolve(home)
  const config = join(home, '.config'), cache = join(home, '.cache'), data = join(home, '.local', 'share'), state = join(home, '.local', 'state')
  const gh = join(config, 'gh'), appData = join(home, 'AppData', 'Roaming'), localAppData = join(home, 'AppData', 'Local')
  for (const dir of [home, config, cache, data, state, gh, appData, localAppData]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: state,
    GH_CONFIG_DIR: gh, APPDATA: appData, LOCALAPPDATA: localAppData,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    // OpenSSH otherwise finds personal identities via the OS account, even with a different HOME.
    GIT_SSH_COMMAND: 'ssh -F none -o IdentityAgent=none -o IdentityFile=none -o IdentitiesOnly=yes -o BatchMode=yes',
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, '.npm-globalrc'),
  }
}
/** The SDK may use explicitly supplied provider variables, never channel/admin credentials or personal defaults. */
export function agentEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = /^(GH_|GITHUB_|PI_SUPERAGENT_|GIT_|GCM_|SSH_|XDG_|NPM_CONFIG_)/
  const exact = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'PYTHONSTARTUP'])
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.test(key.toUpperCase()) && !exact.has(key.toUpperCase())))
  return { ...env, ...localHome(home) }
}
/** Commands get no ambient provider, cloud, channel or administrator secrets. This is not an OS sandbox. */
export function jobEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'CI', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key)))
  return { ...env, ...localHome(home) }
}
