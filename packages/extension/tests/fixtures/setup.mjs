process.on('message', message => {
  if (message.type === 'init') {
    if (message.request.operation === 'timeout') return
    if (message.request.operation === 'crash') process.exit(2)
    if (message.request.operation === 'notify-failure') {
      process.send({ type: 'notify', event: { type: 'progress', message: 'Login progress' } })
      return
    }
    if (message.request.operation === 'automatic-callback') {
      process.send({ type: 'prompt', id: 1, prompt: { type: 'manual_code', message: 'Wait for browser callback' } })
      setTimeout(() => { process.send({ type: 'cancel-prompt', id: 1 }); setTimeout(() => process.send({ type: 'result', value: { ready: true } }), 200) }, 30)
      return
    }
    process.send({ type: 'prompt', id: 1, prompt: { type: 'secret', message: 'Test key' } })
  }
  if (message.type === 'answer') process.send({ type: 'result', value: { ready: message.value === 'private-key', leaked: Boolean(process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN), args: process.argv.slice(2) } })
})
