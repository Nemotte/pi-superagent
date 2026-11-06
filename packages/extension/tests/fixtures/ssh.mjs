// Protocol fixture only: does not pretend to implement SSH authentication.
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
let tick
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
lines.on('line', line => {
  const m = JSON.parse(line)
  if (m.type === 'answer') { send({ type: 'result', value: { answered: m.value === 'secret-answer' } }); return }
  const r = m.request
  if (r.operation === 'hang') { tick = setInterval(() => {}, 1000); return }
  if (r.operation === 'bad') { process.stderr.write('SECRET_STDERR'); process.stdout.write('SECRET_NON_JSON\n'); return }
  if (r.operation === 'huge') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); return }
  if (r.operation === 'prompt') { send({ type: 'prompt', id: 1, prompt: { type: 'secret', message: 'Key' } }); return }
  if (r.operation === 'aborted-prompt') { send({ type: 'prompt', id: 1, prompt: { type: 'manual_code', message: 'Code' } }); send({ type: 'cancel-prompt', id: 1 }); setTimeout(() => send({ type: 'result', value: { ready: true } }), 20); return }
  if (r.operation === 'tunnel') { send({ type: 'ready', value: { token: 'private-memory-only' } }); tick = setInterval(() => {}, 1000); return }
  send({ type: 'result', value: { ok: true } })
})
lines.on('close', () => { clearInterval(tick); process.exit(0) })
