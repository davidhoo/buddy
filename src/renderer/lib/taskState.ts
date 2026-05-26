import type { TaskState } from '../../shared/types'

export function isTaskReadyToStart(state: TaskState | null | undefined): boolean {
  return state?.status === 'READY'
}
