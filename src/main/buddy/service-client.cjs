// Invoked by actors as a short-lived command; the service is spawned by Buddy.
const http = require('node:http')
const fs = require('node:fs')

function request(socketPath, token, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: 'POST', headers: { authorization: `Bearer ${token}` } }, res => {
      let text = ''
      res.on('data', data => { text += data })
      res.on('end', () => {
        try {
          const value = JSON.parse(text)
          if (res.statusCode !== 200) reject(new Error(value.error || `HTTP ${res.statusCode}`))
          else resolve(value)
        } catch (e) { reject(e) }
      })
    })
    req.setTimeout(15000, () => req.destroy(new Error('Buddy service request timed out')))
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

async function main(args) {
  const [action, name, ...rest] = args
  // This explicit stop command also works after a retained task has been deleted.
  if (action === 'stop-owned') {
    const record = JSON.parse(fs.readFileSync(name, 'utf8'))
    if (record.owner !== 'buddy' || record.external) throw new Error('Not a Buddy-owned service')
    return request(record.socket, record.token, '/stop')
  }
  if (!process.env.BUDDY_SERVICE_SOCKET || !process.env.BUDDY_SERVICE_TOKEN) throw new Error('No active Buddy service session')
  let body = { action, name }
  if (action === 'start') {
    const separator = rest.indexOf('--')
    if (separator < 0 || !rest[separator + 1]) throw new Error('Usage: start NAME [--keep REASON] -- COMMAND [ARGS...]')
    const options = rest.slice(0, separator)
    if (options.length && (options.length !== 2 || options[0] !== '--keep')) throw new Error('Expected --keep REASON or no options')
    body = { ...body, command: rest.slice(separator + 1), cwd: process.cwd(), keepReason: options[1] }
  } else if (action === 'keep') body.keepReason = rest.join(' ')
  else if (action === 'external') body.pid = Number(rest[0])
  else if (!['list', 'stop'].includes(action)) throw new Error('Use start, list, stop, keep or external')
  return request(process.env.BUDDY_SERVICE_SOCKET, process.env.BUDDY_SERVICE_TOKEN, '/', body)
}
main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
  console.error(error.message); process.exitCode = 1
})
