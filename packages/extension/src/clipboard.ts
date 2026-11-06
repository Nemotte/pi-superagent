import { execFile } from 'node:child_process'
interface Command { file: string; args: string[] }
export function clipboardCommand(platform = process.platform, env = process.env): Command | undefined {
  if (platform === 'darwin') return { file: 'pbcopy', args: [] }
  if (platform === 'win32') return { file: 'clip.exe', args: [] }
  if (platform === 'linux' && env.WAYLAND_DISPLAY) return { file: 'wl-copy', args: [] }
  if (platform === 'linux' && env.DISPLAY) return { file: 'xclip', args: ['-selection', 'clipboard'] }
}
/** Explicit user action only. Secret data goes to stdin, never argv, shell, stdout or an error message. */
export async function copyText(value: string, command = clipboardCommand()): Promise<boolean> {
  if (!command) return false
  try {
    return await new Promise<boolean>(resolve => {
      const child = execFile(command.file, command.args, { timeout: 5000, maxBuffer: 4096, windowsHide: true }, error => resolve(!error))
      child.stdin?.on('error', () => {}).end(value)
    })
  } catch { return false }
}
