import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Resolve only the two known WeCode shell layouts. Never evaluate the bundle. */
export async function wecodeBundle(command: string): Promise<string> {
  const entry = await realpath(command)
  if ((await stat(entry)).size > 8192) throw new Error('Unsupported WeCode launcher')
  const shim = await readFile(entry, 'utf8')
  const relative = shim.includes('$SCRIPT_DIR/../wecode-cli/bin/cli.js') ? '../wecode-cli/bin/cli.js' : 'cli.js'
  return realpath(join(dirname(entry), relative))
}

/** Read the installed wrapper's own update source; credentials stay in memory. */
export async function latestWecodeVersion(command: string, env?: Record<string, string>): Promise<string> {
  const bundle = await wecodeBundle(command)
  if ((await stat(bundle)).size > 4 * 1024 * 1024) throw new Error('Unsupported WeCode bundle size')
  const source = await readFile(bundle, 'utf8')
  if (!/\/\*\s*WeCoder CLI v\d+\.\d+\.\d+\s*\|/.test(source)) throw new Error('Unrecognized WeCode bundle')
  // Match data constants in the known updater, regardless of minified symbol names.
  const endpoint = /\b([\w$]+)\s*=\s*("https:\/\/git\.intra\.weibo\.com\/api\/v4\/[^"\n]+\/repository\/files\/dist%2Fcli\.js\/raw")/i.exec(source)
  if (!endpoint) throw new Error('WeCode update source unavailable')
  const escaped = endpoint[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const request = new RegExp('fetch\\(\\s*`\\$\\{' + escaped + '\\}\\?ref=[\\s\\S]{0,500}?"PRIVATE-TOKEN"\\s*:\\s*([\\w$]+)').exec(source)
  const tokenName = request?.[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = tokenName && new RegExp('\\b' + tokenName + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")').exec(source)?.[1]
  if (!token) throw new Error('WeCode update authentication unavailable')
  let credential: string
  try { credential = JSON.parse(token) as string }
  catch { throw new Error('Unsupported WeCode update authentication') }
  const url = new URL(JSON.parse(endpoint[2]) as string)
  url.searchParams.set('ref', env?.WECODE_INSTALL_BRANCH || process.env.WECODE_INSTALL_BRANCH || 'master')
  // Never forward the installed credential through a redirect or include it in errors.
  let response: Response
  try {
    response = await fetch(url, { headers: { 'PRIVATE-TOKEN': credential }, redirect: 'error', signal: AbortSignal.timeout(15000) })
  } catch { throw new Error('Cannot reach WeCode update source') }
  if (!response.ok) throw new Error('WeCode update source returned ' + response.status)
  const content = await response.text()
  const version = content.length <= 4 * 1024 * 1024 && /\/\*\s*WeCoder CLI v(\d+\.\d+\.\d+)\s*\|/.exec(content)?.[1]
  if (!version) throw new Error('Invalid WeCode update version')
  return version
}
