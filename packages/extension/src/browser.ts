import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
/** Only explicit login/URL actions use this helper; never interpolate a URL into a shell. */
export function browserCommand(value: string, platform = process.platform): { file: string; args: string[] } {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Unsupported browser URL')
  const target = url.toString()
  if (platform === 'darwin') return { file: 'open', args: [target] }
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] }
  return { file: 'xdg-open', args: [target] }
}
export async function openBrowser(url: string, execute: (file: string, args: string[]) => Promise<unknown> = (file, args) => exec(file, args, { timeout: 5000, maxBuffer: 4096, windowsHide: true })): Promise<boolean> {
  try { const command = browserCommand(url); await execute(command.file, command.args); return true }
  catch { return false } // Opener errors include argv; do not send them to UI/logs.
}
