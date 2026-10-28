import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  isImportableFoundInstance,
  type DiscoveredInstance,
  type ExtensionActionRequest,
  type ExtensionActionResult,
  type LibraryData,
  type LibraryItem,
  type LibrarySnapshot,
  type ResolvedTarget,
  type TargetBinding
} from '../../../shared/extensions'
import { assignBlockFor } from './discover'
import {
  buildHookEntry,
  canonicalJson,
  entryHash,
  hookSupportsAdapter,
  removeHookFromSettings,
  upsertHookInSettings,
  validateHookSpec,
  type HookSpec
} from './hook-format'
import { isInstructionId, withInstructionBlock } from './instruction-blocks'
import { extensionPaths, writeLibrary } from './library-store'
import {
  contentHash,
  parseSubagentLibrary,
  renderSubagentNative,
  serializeSubagentLibrary,
  validateSubagentName,
  type SubagentSpec
} from './subagent-format'
import {
  isManagedCopy,
  removeManagedCopy,
  syncManagedCopy,
  takeSkillEdits
} from './skill-copy'

type LibraryFile = LibrarySnapshot
type ActionResult = ExtensionActionResult['results'][number]

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,128}$/
const MAX_INSTRUCTION_BYTES = 256 * 1024
const MAX_INSTRUCTION_NAME = 200

export async function applyLibraryAction(input: {
  dataRoot: string
  targets: ResolvedTarget[]
  instances: DiscoveredInstance[]
  library: LibraryFile
  request: ExtensionActionRequest
}): Promise<ExtensionActionResult> {
  const data: LibraryData = {
    version: 1,
    items: input.library.items.map((item) => ({ ...item })),
    bindings: input.library.bindings.map((binding) => ({ ...binding })),
    records: [...input.library.records],
    skillDefaultMode: input.library.skillDefaultMode,
    skillAgentModes: { ...input.library.skillAgentModes }
  }
  const results: ActionResult[] = []
  const request = input.request
  if (request.action === 'skill_mode' || request.action === 'sync') {
    if (request.action === 'skill_mode') {
      if (!request.mode && !request.inherit) return { accepted: false, code: 'missing_target', results: [] }
      if (request.actor && !input.targets.some(t => t.actor === request.actor)) return { accepted: false, code: 'missing_target', results: [] }
      if (request.actor) {
        if (request.inherit) delete data.skillAgentModes![request.actor]
        else data.skillAgentModes![request.actor] = request.mode!
      } else {
        if (!request.mode) return { accepted: false, code: 'missing_target', results: [] }
        data.skillDefaultMode = request.mode
      }
      results.push(result('', 'changed', 'saved', null))
    }
    const items = data.items.filter(entry => entry.kind === 'skill' && (!request.libraryItemId || entry.id === request.libraryItemId))
    if (request.libraryItemId && !items.length) return { accepted: false, code: 'missing_target', results: [] }
    for (const item of items) {
      if (item.libraryPath || item.externalPath) {
        const synced = await syncSkillCopies(input.dataRoot, data, item, input.targets)
        results.push(...synced)
        if (synced.some(r => r.status === 'failed')) continue
      }
      for (const binding of data.bindings.filter(b => b.libraryItemId === item.id && b.desired === 'on')) {
        const target = input.targets.find(t => t.actor === binding.actor)
        if (!target || assignBlockFor(target, 'skill') !== 'none') continue
        results.push(await assignItem(input.dataRoot, data, item, target, 'on', await effectiveSkillMode(data, target.actor, item.id, input.targets), input.targets))
      }
    }
    if (results.some((entry) => entry.status === 'changed' || entry.status === 'failed')) {
      await persistRecords(input.dataRoot, data, request.action, results)
    }
    return { accepted: results.every((entry) => entry.status !== 'failed'), code: 'ok', results }
  }
  if (request.action === 'save' && (request.kind === 'instruction' || request.kind === 'subagent' || request.kind === 'hook')) {
    const saved = request.kind === 'instruction'
      ? await saveInstruction(input.dataRoot, data, input.targets, request)
      : request.kind === 'subagent'
        ? await saveSubagent(input.dataRoot, data, input.targets, request)
        : await saveHook(input.dataRoot, data, input.targets, request)
    results.push(...saved.results)
    if (saved.itemId && results.some((entry) => entry.status === 'changed')) {
      await persistRecords(input.dataRoot, data, request.action, results)
    }
    return { accepted: results.some((entry) => entry.status !== 'failed'), code: 'ok', results }
  }
  if (request.action === 'import' || request.action === 'import_all') {
    if (request.kind === 'instruction' || request.kind === 'subagent' || request.kind === 'hook') {
      return { accepted: false, code: 'missing_target', results: [] }
    }
    const ids = request.action === 'import_all'
      ? input.instances
        .filter((item) => item.kind === request.kind && isImportableFoundInstance(item))
        .map((item) => item.id)
      : [request.instanceId, ...(request.instanceIds ?? [])].filter((id): id is string => Boolean(id))
    if (!ids.length) {
      if (request.action === 'import_all') {
        return { accepted: true, code: 'ok', results: [result('', 'skipped', 'already', null)] }
      }
      return { accepted: false, code: 'missing_target', results: [] }
    }
    for (const id of ids) {
      const instance = input.instances.find((item) => item.id === id && item.kind === request.kind)
      if (!instance) {
        results.push(result('', 'failed', 'not_found', null))
        continue
      }
      if (!isImportableFoundInstance(instance)) {
        results.push(result(instance.actor, 'failed', 'plugin_owned', null))
        continue
      }
      const origin = input.targets.find((entry) => entry.actor === instance.actor)
      if (origin && !origin.writesNativeConfig) {
        results.push(result(instance.actor, 'failed', 'unsupported', null))
        continue
      }
      results.push(await importInstance(input.dataRoot, data, instance))
    }
  } else if (request.action === 'assign') {
    const item = data.items.find((entry) => entry.id === request.libraryItemId)
    if (!item || !request.desired) return { accepted: false, code: 'missing_target', results: [] }
    const kind =
      item.kind === 'mcp' ? 'mcp'
        : item.kind === 'instruction' ? 'instruction'
          : item.kind === 'subagent' ? 'subagent'
            : item.kind === 'hook' ? 'hook'
              : 'skill'
    if (request.kind && request.kind !== kind) return { accepted: false, code: 'missing_target', results: [] }
    const actors = request.actor && request.actor !== '*'
      ? [request.actor]
      : request.desired === 'off'
        ? data.bindings.filter((binding) => binding.libraryItemId === item.id && binding.desired === 'on').map((binding) => binding.actor)
        : input.targets.filter((target) => assignBlockFor(target, kind) === 'none').map((target) => target.actor)
    if (actors.length === 0) results.push(result('', 'skipped', 'already', item.id))
    for (const actor of actors) {
      const target = input.targets.find((entry) => entry.actor === actor)
      if (!target) {
        results.push(result(actor, 'failed', 'not_found', item.id))
        continue
      }
      const blocked = assignBlockFor(target, kind)
      if (request.desired === 'on' && blocked !== 'none') {
        results.push(result(actor, 'failed', blocked, item.id))
        continue
      }
      results.push(await assignItem(input.dataRoot, data, item, target, request.desired, request.mode ?? await effectiveSkillMode(data, actor, item.id, input.targets), input.targets))
    }
  } else if (request.action === 'remove') {
    const item = data.items.find((entry) => entry.id === request.libraryItemId)
    if (!item || (request.kind && request.kind !== item.kind)) return { accepted: false, code: 'missing_target', results: [] }
    results.push(...await removeItem(input.dataRoot, data, item, input.targets))
  } else {
    return { accepted: false, code: 'missing_target', results: [] }
  }
  if (results.some((entry) => entry.status === 'changed')) {
    await persistRecords(input.dataRoot, data, request.action, results)
  }
  return { accepted: results.some((entry) => entry.status !== 'failed'), code: 'ok', results }
}

async function persistRecords(
  dataRoot: string,
  data: LibraryData,
  action: string,
  results: ActionResult[]
): Promise<void> {
  data.records.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    action,
    libraryItemId: results.find((entry) => entry.libraryItemId)?.libraryItemId ?? null,
    summary: results.map((entry) => `${entry.actor}:${entry.code}`).join(', '),
    results: results.map((entry) => ({ actor: entry.actor, status: entry.status, message: entry.code }))
  })
  data.records = data.records.slice(-100)
  await writeLibrary(dataRoot, data)
}

async function importInstance(dataRoot: string, data: LibraryData, instance: DiscoveredInstance): Promise<ActionResult> {
  const existing = data.items.find((item) =>
    item.kind === instance.kind && (item.shareKey === instance.shareKey || item.originPath === instance.path || item.externalPath === instance.realpath)
  )
  if (existing) {
    const before = data.bindings.length
    bindOrigin(data, existing, instance, instance.linkSource || instance.scope === 'shared' ? 'reference' : 'link', instance.path)
    return result(instance.actor, data.bindings.length === before ? 'skipped' : 'changed', 'already', existing.id)
  }
  if (instance.readOnly || instance.ownership === 'plugin' || instance.scope === 'plugin') {
    return result(instance.actor, 'failed', 'plugin_owned', null)
  }
  if (instance.kind === 'mcp') return importMcp(dataRoot, data, instance)
  if (!instance.actor || instance.linkSource || instance.scope === 'shared' || instance.ownership === 'shared') {
    return rememberReference(data, instance)
  }
  return moveSkill(dataRoot, data, instance)
}

function rememberReference(data: LibraryData, instance: DiscoveredInstance): ActionResult {
  const item = blankItem(instance, null, instance.realpath)
  data.items.push(item)
  bindOrigin(data, item, instance, 'reference', instance.path)
  return result(instance.actor, 'changed', 'referenced', item.id)
}

async function moveSkill(dataRoot: string, data: LibraryData, instance: DiscoveredInstance): Promise<ActionResult> {
  const dirName = safeBase(instance.path)
  if (!dirName) return result(instance.actor, 'failed', 'unsupported', null)
  let info
  try {
    info = await lstat(instance.path)
  } catch {
    return result(instance.actor, 'failed', 'not_found', null)
  }
  if (info.isSymbolicLink()) return rememberReference(data, instance)
  if (!info.isDirectory()) return result(instance.actor, 'failed', 'unsupported', null)
  const item = blankItem(instance, null, null)
  const paths = extensionPaths(dataRoot)
  const dest = join(paths.contentDir, 'skills', item.id)
  const backup = join(paths.backupDir, `${item.id}-original`)
  await mkdir(dirname(dest), { recursive: true })
  await mkdir(paths.backupDir, { recursive: true })
  try {
    await cp(instance.path, dest, { recursive: true })
  } catch (error) {
    await rm(dest, { recursive: true, force: true })
    return result(instance.actor, 'failed', errno(error), null)
  }
  await rename(instance.path, backup)
  try {
    await symlink(dest, instance.path)
  } catch (error) {
    await rename(backup, instance.path).catch(() => undefined)
    await rm(dest, { recursive: true, force: true })
    return result(instance.actor, 'failed', symlinkErrno(error), null)
  }
  item.libraryPath = dest
  item.shareKey = instance.shareKey
  data.items.push(item)
  bindOrigin(data, item, instance, 'link', instance.path)
  return result(instance.actor, 'changed', 'imported', item.id)
}

async function importMcp(dataRoot: string, data: LibraryData, instance: DiscoveredInstance): Promise<ActionResult> {
  if (!instance.nativeKey) return result(instance.actor, 'failed', 'unsupported', null)
  let text = ''
  try {
    text = await readFile(instance.path, 'utf8')
  } catch {
    return result(instance.actor, 'failed', 'not_found', null)
  }
  const captured = captureMcp(text, instance.path, instance.nativeKey)
  if (!captured.ok) return result(instance.actor, 'failed', captured.code, null)
  const item = blankItem(instance, null, null)
  const paths = extensionPaths(dataRoot)
  const dest = join(paths.contentDir, 'mcp', `${item.id}.json`)
  await atomicReplace(dest, JSON.stringify(captured.saved), 0o600)
  item.libraryPath = dest
  data.items.push(item)
  bindOrigin(data, item, instance, 'reference', instance.path)
  return result(instance.actor, 'changed', 'referenced', item.id)
}

async function saveInstruction(
  dataRoot: string,
  data: LibraryData,
  targets: ResolvedTarget[],
  request: ExtensionActionRequest
): Promise<{ results: ActionResult[]; itemId: string | null }> {
  const name = (request.name ?? '').trim()
  const content = request.content ?? ''
  if (!name || name.length > MAX_INSTRUCTION_NAME) {
    return { results: [result('', 'failed', 'unsupported', request.libraryItemId ?? null)], itemId: null }
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_INSTRUCTION_BYTES) {
    return { results: [result('', 'failed', 'too_large', request.libraryItemId ?? null)], itemId: null }
  }
  const now = new Date().toISOString()
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const preview = content.trim().split('\n').find((line) => line.trim()) ?? ''
  let item: LibraryItem | undefined
  if (request.libraryItemId) {
    item = data.items.find((entry) => entry.id === request.libraryItemId && entry.kind === 'instruction')
    if (!item?.libraryPath || !isInstructionId(item.id)) {
      return { results: [result('', 'failed', 'not_found', request.libraryItemId)], itemId: null }
    }
    await mkdir(dirname(item.libraryPath), { recursive: true })
    await atomicReplace(item.libraryPath, content.endsWith('\n') || content.length === 0 ? content : `${content}\n`)
    item.name = name
    item.description = preview.slice(0, 240)
    item.contentHash = hash
    item.updatedAt = now
  } else {
    const id = randomUUID()
    const libraryPath = join(extensionPaths(dataRoot).contentDir, 'instructions', `${id}.md`)
    await mkdir(dirname(libraryPath), { recursive: true })
    await atomicReplace(libraryPath, content.endsWith('\n') || content.length === 0 ? content : `${content}\n`)
    item = {
      id,
      kind: 'instruction',
      name,
      description: preview.slice(0, 240),
      originActor: '',
      originPath: libraryPath,
      shareKey: `instruction:${id}`,
      repository: null,
      pluginId: null,
      version: null,
      contentHash: hash,
      libraryPath,
      externalPath: null,
      createdAt: now,
      updatedAt: now
    }
    data.items.push(item)
  }
  const results: ActionResult[] = [result('', 'changed', 'saved', item.id)]
  for (const binding of data.bindings.filter((entry) => entry.libraryItemId === item!.id && entry.desired === 'on')) {
    const target = targets.find((entry) => entry.actor === binding.actor)
    if (!target) {
      results.push(result(binding.actor, 'failed', 'not_found', item.id))
      continue
    }
    results.push(await assignInstruction(dataRoot, data, item, target, 'on'))
  }
  return { results, itemId: item.id }
}

async function assignItem(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off',
  skillMode: 'link' | 'copy' = 'link',
  targets: ResolvedTarget[] = [target]
): Promise<ActionResult> {
  if (item.kind === 'mcp') return assignMcp(dataRoot, data, item, target, desired)
  if (item.kind === 'instruction') return assignInstruction(dataRoot, data, item, target, desired)
  if (item.kind === 'subagent') return assignSubagent(dataRoot, data, item, target, desired)
  if (item.kind === 'hook') return assignHook(dataRoot, data, item, target, desired)
  if (item.kind !== 'skill') return result(target.actor, 'failed', 'unsupported', item.id)
  return assignSkill(dataRoot, data, item, target, desired, skillMode, targets)
}

async function assignSkill(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off',
  skillMode: 'link' | 'copy',
  targets: ResolvedTarget[]
): Promise<ActionResult> {
  const scope = data.bindings.find((binding) => binding.libraryItemId === item.id && binding.actor === target.actor)?.scope ?? 'user'
  const root = await skillRoot(target, scope)
  if (!root) return result(target.actor, 'failed', 'uninitialized', item.id)
  const dirName = safeBase(item.repository ? item.name : item.originPath)
  const linkPath = dirName ? contained(root, dirName) : null
  if (!linkPath) return result(target.actor, 'failed', 'unsupported', item.id)
  const expected = item.libraryPath || item.externalPath
  if (!expected) return result(target.actor, 'failed', 'unsupported', item.id)
  const binding = data.bindings.find((entry) => entry.libraryItemId === item.id && entry.actor === target.actor)
  const asCopy = skillMode === 'copy'
  // Recover edits before any revoke or mode conversion, and preserve a recoverable
  // copy even for externally referenced resources whose source we must not edit.
  if (binding?.management === 'copy' || await isManagedCopy(linkPath)) {
    const synced = await syncSkillCopies(dataRoot, data, item, targets)
    if (synced.some(entry => entry.status === 'failed')) return result(target.actor, 'failed', 'read_failed', item.id)
    if (desired === 'off' || !asCopy) {
      if (await isManagedCopy(linkPath)) {
        const backup = join(extensionPaths(dataRoot).backupDir, randomUUID(), target.actor, dirName!)
        await mkdir(dirname(backup), { recursive: true })
        await cp(linkPath, backup, { recursive: true })
      }
    }
  }

  if (desired === 'off') {
    if (asCopy || (await isManagedCopy(linkPath))) {
      const removed = await removeManagedCopy(linkPath)
      if (removed === 'not_ours') {
        const owned = await linkOwnership(linkPath, expected)
        if (owned === 'owned') {
          await rm(linkPath)
          ensureBinding(data, item, bindingSource(item, target.actor, scope), 'link', linkPath, 'off')
          return result(target.actor, 'changed', 'revoked', item.id)
        }
        if (owned === 'absent') {
          ensureBinding(data, item, bindingSource(item, target.actor, scope), 'copy', linkPath, 'off')
          return result(target.actor, 'skipped', 'already', item.id)
        }
        return result(target.actor, 'failed', 'conflict', item.id)
      }
      ensureBinding(data, item, bindingSource(item, target.actor, scope), 'copy', linkPath, 'off')
      return result(target.actor, removed === 'removed' ? 'changed' : 'skipped', removed === 'removed' ? 'revoked' : 'already', item.id)
    }
    const owned = await linkOwnership(linkPath, expected)
    if (owned === 'absent') {
      ensureBinding(data, item, bindingSource(item, target.actor, scope), 'link', linkPath, 'off')
      return result(target.actor, 'skipped', 'already', item.id)
    }
    if (owned !== 'owned') return result(target.actor, 'failed', 'conflict', item.id)
    await rm(linkPath)
    ensureBinding(data, item, bindingSource(item, target.actor, scope), 'link', linkPath, 'off')
    return result(target.actor, 'changed', 'revoked', item.id)
  }

  if (asCopy) {
    const ownership = await linkOwnership(linkPath, expected)
    if (ownership === 'other' && !(await isManagedCopy(linkPath))) return result(target.actor, 'failed', 'conflict', item.id)
    const taken = await runTakeEdits(dataRoot, data, item)
    if (taken.blocked.length > 0) {
      const hit = taken.blocked.find((entry) => entry.actor === target.actor || entry.path === linkPath)
      return result(target.actor, 'failed', hit?.code ?? 'read_failed', item.id)
    }
    if (taken.libraryUpdated || taken.setAside.length > 0) {
      for (const other of data.bindings.filter((entry) =>
        entry.libraryItemId === item.id && entry.desired === 'on' && entry.management === 'copy' && entry.nativePath && entry.actor !== target.actor
      )) {
        await syncManagedCopy(expected, other.nativePath!)
      }
    }
    const synced = await syncManagedCopy(expected, linkPath)
    if (!synced.ok) return result(target.actor, 'failed', synced.code, item.id)
    ensureBinding(data, item, bindingSource(item, target.actor, scope), 'copy', linkPath, 'on')
    return result(target.actor, synced.changed ? 'changed' : 'skipped', synced.changed ? 'assigned' : 'already', item.id)
  }

  const owned = await linkOwnership(linkPath, expected)
  if (owned === 'owned') {
    ensureBinding(data, item, bindingSource(item, target.actor, scope), item.libraryPath ? 'link' : 'reference', linkPath, 'on')
    return result(target.actor, 'skipped', 'already', item.id)
  }
  if (owned === 'other') {
    if (await isManagedCopy(linkPath)) {
      const next = join(root, `.${dirName}.buddy-link-${randomUUID()}`)
      try {
        await symlink(expected, next)
        const previous = `${next}-old`
        await rename(linkPath, previous)
        try { await rename(next, linkPath) } catch (error) { await rename(previous, linkPath); throw error }
        await rm(previous, { recursive: true, force: true })
      } catch {
        await rm(next, { force: true })
        return result(target.actor, 'failed', 'symlink_failed', item.id)
      }
      ensureBinding(data, item, bindingSource(item, target.actor, scope), 'link', linkPath, 'on')
      return result(target.actor, 'changed', 'assigned', item.id)
    }
    return result(target.actor, 'failed', 'conflict', item.id)
  }
  try {
    await symlink(expected, linkPath)
  } catch (error) {
    const code = symlinkErrno(error)
    if (code !== 'symlink_failed') return result(target.actor, 'failed', code, item.id)
    // Magpie/Windows path: fall back to a marked managed copy when the link cannot be made.
    const synced = await syncManagedCopy(expected, linkPath)
    if (!synced.ok) return result(target.actor, 'failed', 'symlink_failed', item.id)
    ensureBinding(data, item, bindingSource(item, target.actor, scope), 'copy', linkPath, 'on')
    return result(target.actor, 'changed', 'assigned', item.id)
  }
  ensureBinding(data, item, bindingSource(item, target.actor, scope), item.libraryPath ? 'link' : 'reference', linkPath, 'on')
  return result(target.actor, 'changed', 'assigned', item.id)
}

async function syncSkillCopies(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  targets: ResolvedTarget[]
): Promise<ActionResult[]> {
  const source = item.libraryPath || item.externalPath
  if (!source) return [result('', 'failed', 'unsupported', item.id)]
  // Validate every recorded destination before takeEdits or sync can touch it.
  for (const binding of data.bindings.filter(b => b.libraryItemId === item.id && b.desired === 'on' && b.management === 'copy')) {
    const target = targets.find(t => t.actor === binding.actor)
    if (!target || assignBlockFor(target, 'skill') !== 'none') return [result(binding.actor, 'failed', 'unsupported', item.id)]
    const root = await skillRoot(target, binding.scope)
    const name = safeBase(item.repository ? item.name : item.originPath)
    if (!root || !name || !binding.nativePath || resolve(binding.nativePath) !== resolve(root, name)) return [result(binding.actor, 'failed', 'conflict', item.id)]
    const owned = await linkOwnership(binding.nativePath, source)
    if (owned === 'other' && !(await isManagedCopy(binding.nativePath))) {
      try { await readFile(join(binding.nativePath, '.buddy-library'), 'utf8') } catch (error) {
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return [result(binding.actor, 'failed', 'read_failed', item.id)]
      }
      return [result(binding.actor, 'failed', 'conflict', item.id)]
    }
  }
  const taken = await runTakeEdits(dataRoot, data, item)
  const results: ActionResult[] = []
  if (taken.libraryUpdated && taken.winner) {
    results.push(result(taken.winner.actor, 'changed', 'taken', item.id))
  }
  for (const blocked of taken.blocked) {
    results.push(result(blocked.actor, 'failed', blocked.code, item.id))
  }
  for (const aside of taken.setAside) {
    results.push(result(aside.actor, 'changed', 'set_aside', item.id))
  }
  if (taken.blocked.length > 0) return results

  for (const binding of data.bindings.filter((entry) => entry.libraryItemId === item.id && entry.desired === 'on' && entry.management === 'copy')) {
    const target = targets.find((entry) => entry.actor === binding.actor)
    if (!target || !binding.nativePath) {
      results.push(result(binding.actor, 'failed', 'not_found', item.id))
      continue
    }
    const synced = await syncManagedCopy(source, binding.nativePath)
    if (!synced.ok) {
      results.push(result(binding.actor, 'failed', synced.code, item.id))
      continue
    }
    results.push(result(binding.actor, synced.changed ? 'changed' : 'skipped', synced.changed ? 'assigned' : 'already', item.id))
  }
  if (results.length === 0) results.push(result('', 'skipped', 'already', item.id))
  return results
}

async function runTakeEdits(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem
): Promise<Awaited<ReturnType<typeof takeSkillEdits>>> {
  const source = item.libraryPath || item.externalPath
  if (!source) {
    return { libraryUpdated: false, winner: null, blocked: [], setAside: [] }
  }
  const copies = data.bindings
    .filter((entry) => entry.libraryItemId === item.id && entry.desired === 'on' && entry.management === 'copy' && entry.nativePath)
    .map((entry) => ({ actor: entry.actor, path: entry.nativePath! }))
  if (copies.length === 0) {
    return { libraryUpdated: false, winner: null, blocked: [], setAside: [] }
  }
  return takeSkillEdits({
    libraryPath: source,
    backupDir: extensionPaths(dataRoot).backupDir,
    copies
  })
}

async function saveSubagent(
  dataRoot: string,
  data: LibraryData,
  targets: ResolvedTarget[],
  request: ExtensionActionRequest
): Promise<{ results: ActionResult[]; itemId: string | null }> {
  const name = (request.name ?? '').trim()
  const description = (request.description ?? '').trim()
  const prompt = (request.content ?? '').replace(/\r\n/g, '\n').trim()
  if (validateSubagentName(name) || !description || !prompt || description.length > 1000 || Buffer.byteLength(prompt, 'utf8') > 100_000) {
    return { results: [result('', 'failed', 'unsupported', request.libraryItemId ?? null)], itemId: null }
  }
  const spec: SubagentSpec = { name, description, prompt }
  const body = serializeSubagentLibrary(spec)
  const now = new Date().toISOString()
  const hash = contentHash(body)
  let item: LibraryItem | undefined
  if (request.libraryItemId) {
    item = data.items.find((entry) => entry.id === request.libraryItemId && entry.kind === 'subagent')
    if (!item?.libraryPath) return { results: [result('', 'failed', 'not_found', request.libraryItemId)], itemId: null }
    if (item.name !== name && data.items.some((entry) => entry.kind === 'subagent' && entry.name === name && entry.id !== item!.id)) {
      return { results: [result('', 'failed', 'conflict', item.id)], itemId: null }
    }
    await atomicReplace(item.libraryPath, body)
    item.name = name
    item.description = description
    item.contentHash = hash
    item.updatedAt = now
  } else {
    if (data.items.some((entry) => entry.kind === 'subagent' && entry.name === name)) {
      return { results: [result('', 'failed', 'conflict', null)], itemId: null }
    }
    const id = randomUUID()
    const libraryPath = join(extensionPaths(dataRoot).contentDir, 'subagents', `${id}.md`)
    await mkdir(dirname(libraryPath), { recursive: true })
    await atomicReplace(libraryPath, body)
    item = {
      id,
      kind: 'subagent',
      name,
      description,
      originActor: '',
      originPath: libraryPath,
      shareKey: `subagent:${name}`,
      repository: null,
      pluginId: null,
      version: null,
      contentHash: hash,
      libraryPath,
      externalPath: null,
      createdAt: now,
      updatedAt: now
    }
    data.items.push(item)
  }
  const results: ActionResult[] = [result('', 'changed', 'saved', item.id)]
  for (const binding of data.bindings.filter((entry) => entry.libraryItemId === item!.id && entry.desired === 'on')) {
    const target = targets.find((entry) => entry.actor === binding.actor)
    if (!target) {
      results.push(result(binding.actor, 'failed', 'not_found', item.id))
      continue
    }
    results.push(await assignSubagent(dataRoot, data, item, target, 'on'))
  }
  return { results, itemId: item.id }
}

async function saveHook(
  dataRoot: string,
  data: LibraryData,
  targets: ResolvedTarget[],
  request: ExtensionActionRequest
): Promise<{ results: ActionResult[]; itemId: string | null }> {
  const spec: HookSpec = {
    name: (request.name ?? '').trim(),
    description: (request.description ?? '').trim(),
    event: (request.event ?? '').trim(),
    matcher: (request.matcher ?? '').trim(),
    command: (request.command ?? request.content ?? '').trim(),
    timeoutSeconds: typeof request.timeoutSeconds === 'number' ? request.timeoutSeconds : 0
  }
  if (validateHookSpec(spec)) {
    return { results: [result('', 'failed', 'unsupported', request.libraryItemId ?? null)], itemId: null }
  }
  const body = `${JSON.stringify(spec, null, 2)}\n`
  const now = new Date().toISOString()
  const hash = contentHash(body)
  let item: LibraryItem | undefined
  if (request.libraryItemId) {
    item = data.items.find((entry) => entry.id === request.libraryItemId && entry.kind === 'hook')
    if (!item?.libraryPath) return { results: [result('', 'failed', 'not_found', request.libraryItemId)], itemId: null }
    if (item.name !== spec.name && data.items.some((entry) => entry.kind === 'hook' && entry.name === spec.name && entry.id !== item!.id)) {
      return { results: [result('', 'failed', 'conflict', item.id)], itemId: null }
    }
    await atomicReplace(item.libraryPath, body)
    item.name = spec.name
    item.description = spec.description || spec.event
    item.contentHash = hash
    item.updatedAt = now
  } else {
    if (data.items.some((entry) => entry.kind === 'hook' && entry.name === spec.name)) {
      return { results: [result('', 'failed', 'conflict', null)], itemId: null }
    }
    const id = randomUUID()
    const libraryPath = join(extensionPaths(dataRoot).contentDir, 'hooks', `${id}.json`)
    await mkdir(dirname(libraryPath), { recursive: true })
    await atomicReplace(libraryPath, body)
    item = {
      id,
      kind: 'hook',
      name: spec.name,
      description: spec.description || spec.event,
      originActor: '',
      originPath: libraryPath,
      shareKey: `hook:${spec.name}`,
      repository: null,
      pluginId: null,
      version: null,
      contentHash: hash,
      libraryPath,
      externalPath: null,
      createdAt: now,
      updatedAt: now
    }
    data.items.push(item)
  }
  const results: ActionResult[] = [result('', 'changed', 'saved', item.id)]
  for (const binding of data.bindings.filter((entry) => entry.libraryItemId === item!.id && entry.desired === 'on')) {
    const target = targets.find((entry) => entry.actor === binding.actor)
    if (!target) {
      results.push(result(binding.actor, 'failed', 'not_found', item.id))
      continue
    }
    results.push(await assignHook(dataRoot, data, item, target, 'on'))
  }
  return { results, itemId: item.id }
}

async function assignSubagent(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off'
): Promise<ActionResult> {
  if (!item.libraryPath) return result(target.actor, 'failed', 'unsupported', item.id)
  const location = target.locations.find((entry) => entry.kind === 'subagents' && entry.scope === 'user')
  if (!location || location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') {
    return result(target.actor, 'failed', 'uninitialized', item.id)
  }
  if (location.error || location.missingMeans === 'read_failed') {
    return result(target.actor, 'failed', 'read_failed', item.id)
  }
  let libraryText = ''
  try {
    libraryText = await readFile(item.libraryPath, 'utf8')
  } catch {
    return result(target.actor, 'failed', 'not_found', item.id)
  }
  const spec = parseSubagentLibrary(libraryText)
  if (!spec) return result(target.actor, 'failed', 'unsupported', item.id)
  const rendered = renderSubagentNative(target.adapter, spec)
  if (!rendered) return result(target.actor, 'failed', 'unsupported', item.id)
  const nativePath = join(location.path, rendered.fileName)
  if (relative(location.path, nativePath).startsWith('..')) return result(target.actor, 'failed', 'unsupported', item.id)
  const binding = data.bindings.find((entry) => entry.libraryItemId === item.id && entry.actor === target.actor)
  const wantHash = contentHash(rendered.body)

  if (desired === 'off') {
    let current: string | null = null
    try {
      current = await readFile(nativePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', nativePath, 'off', null, null)
        return result(target.actor, 'skipped', 'already', item.id)
      }
      return result(target.actor, 'failed', 'read_failed', item.id)
    }
    const currentHash = contentHash(current)
    if (binding?.appliedVersion && currentHash !== binding.appliedVersion) {
      return result(target.actor, 'failed', 'changed_externally', item.id)
    }
    if (!binding?.appliedVersion && currentHash !== wantHash) {
      return result(target.actor, 'failed', 'conflict', item.id)
    }
    await backupFile(dataRoot, nativePath, item.id)
    await rm(nativePath)
    ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', nativePath, 'off', null, null)
    return result(target.actor, 'changed', 'revoked', item.id)
  }

  let existing: string | null = null
  try {
    existing = await readFile(nativePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return result(target.actor, 'failed', 'read_failed', item.id)
  }
  if (existing !== null) {
    const existingHash = contentHash(existing)
    if (existingHash === wantHash) {
      ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', nativePath, 'on', wantHash, null)
      return result(target.actor, 'skipped', 'already', item.id)
    }
    if (!binding?.appliedVersion || existingHash !== binding.appliedVersion) {
      return result(target.actor, 'failed', 'conflict', item.id)
    }
    await backupFile(dataRoot, nativePath, item.id)
  }
  await mkdir(location.path, { recursive: true })
  await atomicReplace(nativePath, rendered.body)
  ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', nativePath, 'on', wantHash, null)
  return result(target.actor, 'changed', 'assigned', item.id)
}

async function assignHook(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off'
): Promise<ActionResult> {
  if (!item.libraryPath) return result(target.actor, 'failed', 'unsupported', item.id)
  if (!hookSupportsAdapter(target.adapter)) return result(target.actor, 'failed', 'unsupported', item.id)
  const location = target.locations.find((entry) => entry.kind === 'hooks' && entry.scope === 'user')
  if (!location || location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') {
    return result(target.actor, 'failed', 'uninitialized', item.id)
  }
  if (location.error || location.missingMeans === 'read_failed') {
    return result(target.actor, 'failed', 'read_failed', item.id)
  }
  let spec: HookSpec
  try {
    spec = JSON.parse(await readFile(item.libraryPath, 'utf8')) as HookSpec
  } catch {
    return result(target.actor, 'failed', 'not_found', item.id)
  }
  if (validateHookSpec(spec)) return result(target.actor, 'failed', 'unsupported', item.id)
  const built = buildHookEntry(target.adapter, spec)
  if (!built) return result(target.actor, 'failed', 'unsupported', item.id)
  const entryJson = canonicalJson(built.entry)
  const binding = data.bindings.find((entry) => entry.libraryItemId === item.id && entry.actor === target.actor)

  let text = ''
  try {
    text = await readFile(location.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return result(target.actor, 'failed', 'read_failed', item.id)
    if (desired === 'off') {
      ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, 'off', null, null)
      return result(target.actor, 'skipped', 'already', item.id)
    }
    text = ''
  }

  if (desired === 'off') {
    if (!binding?.appliedEntry) {
      ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, 'off', null, null)
      return result(target.actor, 'skipped', 'already', item.id)
    }
    const edited = removeHookFromSettings(text, built.event, binding.appliedEntry)
    if (!edited.ok) return result(target.actor, 'failed', edited.code, item.id)
    if (edited.changed) {
      if (text) await backupFile(dataRoot, location.path, item.id)
      await atomicReplace(location.path, edited.text)
    }
    ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, 'off', null, null)
    return result(target.actor, edited.changed ? 'changed' : 'skipped', edited.changed ? 'revoked' : 'already', item.id)
  }

  const edited = upsertHookInSettings(text, built.event, built.entry, binding?.appliedEntry ?? null)
  if (!edited.ok) return result(target.actor, 'failed', edited.code, item.id)
  if (edited.changed) {
    if (text) await backupFile(dataRoot, location.path, item.id)
    await atomicReplace(location.path, edited.text)
  }
  ensureBinding(
    data,
    item,
    bindingSource(item, target.actor, 'user'),
    'reference',
    location.path,
    'on',
    entryHash(built.entry),
    entryJson
  )
  return result(target.actor, edited.changed ? 'changed' : 'skipped', edited.changed ? 'assigned' : 'already', item.id)
}

async function assignInstruction(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off'
): Promise<ActionResult> {
  if (!item.libraryPath || !isInstructionId(item.id)) return result(target.actor, 'failed', 'unsupported', item.id)
  const location = target.locations.find((entry) => entry.kind === 'instructions' && entry.scope === 'user')
  if (!location || location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') {
    return result(target.actor, 'failed', 'uninitialized', item.id)
  }
  if (location.error || location.missingMeans === 'read_failed') {
    return result(target.actor, 'failed', 'read_failed', item.id)
  }
  if (await samePath(item.libraryPath, location.path)) {
    return result(target.actor, 'failed', 'conflict', item.id)
  }
  let body = ''
  if (desired === 'on') {
    try {
      body = (await readFile(item.libraryPath, 'utf8')).replace(/\r\n/g, '\n').trim()
    } catch {
      return result(target.actor, 'failed', 'not_found', item.id)
    }
  }
  let text = ''
  try {
    text = await readFile(location.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return result(target.actor, 'failed', 'read_failed', item.id)
    if (desired === 'off') {
      ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, 'off')
      return result(target.actor, 'skipped', 'already', item.id)
    }
    text = ''
  }
  const next = withInstructionBlock(text, item.id, desired === 'on' ? body : '')
  if (next === text || (text === '' && next === '')) {
    ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, desired)
    return result(target.actor, 'skipped', 'already', item.id)
  }
  if (text !== '') await backupFile(dataRoot, location.path, item.id)
  await atomicReplace(location.path, next)
  ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, desired)
  return result(target.actor, 'changed', desired === 'off' ? 'revoked' : 'assigned', item.id)
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return resolve(left) === resolve(right)
  }
}

async function assignMcp(
  dataRoot: string,
  data: LibraryData,
  item: LibraryItem,
  target: ResolvedTarget,
  desired: 'on' | 'off'
): Promise<ActionResult> {
  const saved = await readSavedMcp(item.libraryPath)
  if (!saved) return result(target.actor, 'failed', 'unsupported', item.id)
  const location = target.locations.find((entry) => entry.kind === 'mcp' && entry.scope === 'user' && !entry.isDirectory)
  if (!location || location.missingMeans === 'uninitialized' || !location.exists || location.error) {
    return result(target.actor, 'failed', location?.missingMeans === 'uninitialized' ? 'uninitialized' : 'config_missing', item.id)
  }
  let text = ''
  try {
    text = await readFile(location.path, 'utf8')
  } catch {
    return result(target.actor, 'failed', 'config_missing', item.id)
  }
  const edited = desired === 'off'
    ? removeMcp(text, location.path, saved)
    : upsertMcp(text, location.path, saved)
  if (!edited.ok) return result(target.actor, edited.code === 'already' ? 'skipped' : 'failed', edited.code, item.id)
  if (edited.text !== text) {
    await backupFile(dataRoot, location.path, item.id)
    await atomicReplace(location.path, edited.text)
  }
  ensureBinding(data, item, bindingSource(item, target.actor, 'user'), 'reference', location.path, desired)
  return result(target.actor, edited.text === text ? 'skipped' : 'changed', desired === 'off' ? 'revoked' : 'assigned', item.id)
}

async function removeItem(dataRoot: string, data: LibraryData, item: LibraryItem, targets: ResolvedTarget[]): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (const binding of data.bindings.filter((entry) => entry.libraryItemId === item.id && entry.desired === 'on')) {
    const target = targets.find((entry) => entry.actor === binding.actor)
    if (!target) {
      results.push(result(binding.actor, 'failed', 'not_found', item.id))
      return results
    }
    const revoked = await assignItem(dataRoot, data, item, target, 'off', 'link', targets)
    results.push(revoked)
    if (revoked.status === 'failed') return results
  }
  if (item.libraryPath && isInside(extensionPaths(dataRoot).contentDir, item.libraryPath)) {
    const backup = join(extensionPaths(dataRoot).backupDir, `${item.id}-removed`)
    await mkdir(dirname(backup), { recursive: true })
    await rename(item.libraryPath, backup).catch(() => undefined)
  }
  data.items = data.items.filter((entry) => entry.id !== item.id)
  data.bindings = data.bindings.filter((entry) => entry.libraryItemId !== item.id)
  results.push(result(item.originActor, 'changed', 'removed', item.id))
  return results
}

function bindOrigin(
  data: LibraryData,
  item: LibraryItem,
  instance: DiscoveredInstance,
  management: TargetBinding['management'],
  nativePath: string
): void {
  if (!instance.actor) return
  ensureBinding(data, item, instance, management, nativePath)
}

function ensureBinding(
  data: LibraryData,
  item: LibraryItem,
  instance: { actor: string; scope: DiscoveredInstance['scope']; shareKey: string; targetFingerprint?: string },
  management: TargetBinding['management'],
  nativePath: string,
  desired: 'on' | 'off' = 'on',
  appliedVersion: string | null = null,
  appliedEntry: string | null = null
): void {
  const scope = instance.scope === 'project' ? 'project' : 'user'
  const current = data.bindings.find((binding) => binding.libraryItemId === item.id && binding.actor === instance.actor && binding.scope === scope)
  if (current) {
    current.desired = desired
    current.nativePath = nativePath
    current.management = management
    current.shareKey = instance.shareKey
    current.observed = desired
    current.appliedVersion = appliedVersion
    current.appliedEntry = appliedEntry
    return
  }
  data.bindings.push({
    id: randomUUID(),
    libraryItemId: item.id,
    actor: instance.actor,
    targetFingerprint: instance.targetFingerprint ?? '',
    scope,
    nativePath,
    nativeId: null,
    desired,
    observed: desired,
    appliedVersion,
    appliedEntry,
    shareKey: instance.shareKey,
    management
  })
}

function bindingSource(item: LibraryItem, actor: string, scope: 'user' | 'project') {
  return {
    actor,
    scope,
    shareKey: item.shareKey ?? '',
    targetFingerprint: ''
  }
}

function blankItem(instance: DiscoveredInstance, libraryPath: string | null, externalPath: string | null): LibraryItem {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    kind: instance.kind,
    name: instance.name,
    description: instance.description,
    originActor: instance.actor,
    originPath: instance.path,
    shareKey: instance.shareKey,
    repository: null,
    pluginId: null,
    version: null,
    contentHash: instance.contentHash,
    libraryPath,
    externalPath,
    createdAt: now,
    updatedAt: now
  }
}

async function skillRoot(target: ResolvedTarget, scope: 'user' | 'project'): Promise<string | null> {
  const location = target.locations.find((item) => item.kind === 'skills' && item.scope === scope)
  if (!location || location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') return null
  if (location.exists && !location.isDirectory) return null
  if (!location.exists) {
    const parent = await lstat(dirname(location.path)).catch(() => null)
    if (!parent?.isDirectory()) return null
    await mkdir(location.path)
  }
  return location.path
}

async function linkOwnership(path: string, expected: string): Promise<'owned' | 'absent' | 'other'> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'other'
  }
  if (!info.isSymbolicLink()) return 'other'
  const raw = await readlink(path)
  return resolve(dirname(path), raw) === resolve(expected) ? 'owned' : 'other'
}

async function readSavedMcp(path: string | null): Promise<SavedMcp | null> {
  if (!path) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SavedMcp
    if (!parsed || parsed.kind !== 'mcp' || !parsed.serverName) return null
    return parsed
  } catch {
    return null
  }
}

async function backupFile(dataRoot: string, path: string, id: string): Promise<void> {
  const backup = join(extensionPaths(dataRoot).backupDir, `${id}-${Date.now()}.bak`)
  await mkdir(dirname(backup), { recursive: true })
  await copyFile(path, backup)
}

interface SavedMcp {
  kind: 'mcp'
  format: 'json' | 'toml'
  serverName: string
  server?: Record<string, unknown>
  section?: string
}

function captureMcp(text: string, path: string, name: string): { ok: true; saved: SavedMcp } | { ok: false; code: string } {
  if (path.endsWith('.toml')) {
    const section = tomlServerSection(text, name)
    if (!section) return { ok: false, code: 'unsupported' }
    return { ok: true, saved: { kind: 'mcp', format: 'toml', serverName: name, section } }
  }
  if (jsonHasComment(text)) return { ok: false, code: 'comment' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'unsupported' }
  }
  const server = readJsonServer(parsed, path, name)
  if (!server) return { ok: false, code: 'not_found' }
  return { ok: true, saved: { kind: 'mcp', format: 'json', serverName: name, server } }
}

function upsertMcp(text: string, path: string, saved: SavedMcp): { ok: true; text: string } | { ok: false; code: string } {
  if (saved.format === 'toml') {
    if (!saved.section) return { ok: false, code: 'unsupported' }
    const current = tomlServerSection(text, saved.serverName)
    if (current === saved.section.trim()) return { ok: true, text }
    if (current) return { ok: false, code: 'conflict' }
    const suffix = text.endsWith('\n') || text.length === 0 ? '' : '\n'
    return { ok: true, text: `${text}${suffix}\n${saved.section.trim()}\n` }
  }
  if (jsonHasComment(text)) return { ok: false, code: 'comment' }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, code: 'unsupported' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !saved.server) return { ok: false, code: 'unsupported' }
  const key = jsonMcpKey(parsed, path)
  const block = parsed[key]
  const servers = block && typeof block === 'object' && !Array.isArray(block) ? { ...block as Record<string, unknown> } : {}
  const current = servers[saved.serverName]
  if (current && JSON.stringify(current) !== JSON.stringify(saved.server)) return { ok: false, code: 'conflict' }
  if (current) return { ok: true, text }
  servers[saved.serverName] = saved.server
  parsed[key] = servers
  return { ok: true, text: `${JSON.stringify(parsed, null, 2)}\n` }
}

function removeMcp(text: string, path: string, saved: SavedMcp): { ok: true; text: string } | { ok: false; code: string } {
  if (saved.format === 'toml') {
    if (!saved.section) return { ok: false, code: 'unsupported' }
    const current = tomlServerSection(text, saved.serverName)
    if (!current) return { ok: true, text }
    if (current !== saved.section.trim()) return { ok: false, code: 'changed_externally' }
    const next = text.replace(current, '').replace(/\n{3,}/g, '\n\n')
    return { ok: true, text: next.endsWith('\n') || next.length === 0 ? next : `${next}\n` }
  }
  if (jsonHasComment(text)) return { ok: false, code: 'comment' }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, code: 'unsupported' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'unsupported' }
  const key = jsonMcpKey(parsed, path)
  const block = parsed[key]
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { ok: true, text }
  const servers = { ...block as Record<string, unknown> }
  if (!(saved.serverName in servers)) return { ok: true, text }
  if (JSON.stringify(servers[saved.serverName]) !== JSON.stringify(saved.server)) return { ok: false, code: 'changed_externally' }
  delete servers[saved.serverName]
  parsed[key] = servers
  return { ok: true, text: `${JSON.stringify(parsed, null, 2)}\n` }
}

export function tomlServerSection(text: string, name: string): string | null {
  if (!MCP_NAME.test(name)) return null
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `[mcp_servers.${name}]`)
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

function readJsonServer(parsed: unknown, path: string, name: string): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const key = jsonMcpKey(record, path)
  const block = record[key]
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const server = (block as Record<string, unknown>)[name]
  if (!server || typeof server !== 'object' || Array.isArray(server)) return null
  return server as Record<string, unknown>
}

function jsonMcpKey(record: Record<string, unknown>, path: string): string {
  if (path.endsWith('opencode.json')) return 'mcp' in record ? 'mcp' : 'mcpServers'
  return 'mcpServers'
}

function jsonHasComment(text: string): boolean {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) return true
  }
  return false
}

async function atomicReplace(path: string, value: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, value, { mode: mode ?? 0o600 })
    if (mode === undefined) {
      const current = await lstat(path).catch(() => null)
      if (current) await chmod(tmp, current.mode & 0o777)
    }
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

function safeBase(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  if (!name || name === '.' || name === '..' || name.length > 200 || /[\0\r\n]/.test(name)) return null
  return name
}

function contained(root: string, name: string): string | null {
  const dest = join(root, name)
  return relative(root, dest) === name ? dest : null
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}

function result(actor: string, status: ActionResult['status'], code: string, libraryItemId: string | null): ActionResult {
  return { actor, status, code, libraryItemId }
}

function errno(_error: unknown): string {
  return 'failed'
}

function symlinkErrno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'EXDEV' ||
    code === 'EINVAL'
  ) {
    return 'symlink_failed'
  }
  return 'failed'
}

async function effectiveSkillMode(data: LibraryData, actor: string, itemId: string, targets: ResolvedTarget[]): Promise<'link' | 'copy'> {
  const modeOf = (id: string) => data.skillAgentModes?.[id] ?? data.skillDefaultMode ?? (data.bindings.some(b => b.libraryItemId === itemId && b.actor === id && b.management === 'copy') ? 'copy' : 'link')
  const scope = data.bindings.find(b => b.libraryItemId === itemId && b.actor === actor)?.scope ?? 'user'
  const roots = await Promise.all(targets.map(async target => {
    const path = target.locations.find(l => l.kind === 'skills' && l.scope === scope)?.path
    return { actor: target.actor, path: path ? await realpath(path).catch(() => resolve(path)) : null }
  }))
  const root = roots.find(r => r.actor === actor)?.path
  // Native aliases sharing the same directory must agree; any copy preference wins.
  return root && roots.some(r => r.path === root && modeOf(r.actor) === 'copy') ? 'copy' : modeOf(actor)
}
