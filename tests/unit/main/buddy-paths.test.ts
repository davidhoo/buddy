import { describe, expect, it } from 'vitest'
import { createBuddyPaths, taskDir, workspaceKeyForRepo } from '../../../src/main/buddy/paths'

describe('buddy paths', () => {
  it('uses macOS Application Support Buddy directory', () => {
    const paths = createBuddyPaths('/Users/demo/Library/Application Support/Buddy')

    expect(paths.dataRoot).toBe('/Users/demo/Library/Application Support/Buddy')
    expect(paths.globalSettings).toBe('/Users/demo/Library/Application Support/Buddy/global/settings.json')
    expect(paths.runtimeTasksDir).toBe('/Users/demo/Library/Application Support/Buddy/runtime/tasks')
  })

  it('derives buddy-python compatible workspace keys from repo roots', () => {
    expect(workspaceKeyForRepo('/tmp/project')).toMatch(/^project-[a-f0-9]{12}$/)
    expect(workspaceKeyForRepo('/tmp/project')).toBe(workspaceKeyForRepo('/tmp/project'))
  })

  it('prefixes the buddy-macos repo hash with the project directory name', () => {
    expect(workspaceKeyForRepo('/Users/david/SynologyDrive/Projects/github/buddy/buddy-macos')).toBe(
      'buddy-macos-31bd2c697ab4'
    )
  })

  it('builds task directories under workspaces', () => {
    const paths = createBuddyPaths('/tmp/buddy')

    expect(taskDir(paths, 'abc123def456', 'demo')).toBe('/tmp/buddy/workspaces/abc123def456/tasks/demo')
  })
})
