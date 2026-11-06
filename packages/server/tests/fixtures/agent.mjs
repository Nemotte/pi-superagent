let target
process.on('message', message => {
  if (message.type === 'init') { target = message.target; process.send({ type: 'ready' }) }
  if (message.type === 'deliver') {
    if (message.delivery.text === 'fail') process.send({ type: 'nack', id: message.delivery.id, error: 'failed delivery' })
    else process.send({ type: 'tool', id: message.delivery.id, name: 'report', args: { state: 'progress', summary: message.delivery.text === 'environment' ? JSON.stringify({ home: process.env.HOME, gh: process.env.GH_CONFIG_DIR, leaked: !!(process.env.GH_TOKEN || process.env.PI_SUPERAGENT_GITHUB_TOKEN) }) : message.delivery.text } })
  }
  if (message.type === 'tool_result') {
    process.send({ type: 'event', event: { type: 'read', deliveryId: message.id } })
    process.send({ type: 'ack', id: message.id })
  }
  if (message.type === 'stop') process.exit(0)
})
