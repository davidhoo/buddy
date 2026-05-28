import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { GlobalSettings, GitDiffStats, GitRemote, GitStatusResult } from '../../shared/types'

export function useHealthCheck() {
  return useQuery({
    queryKey: ['health'],
    queryFn: api.checkHealth,
    retry: 1,
    refetchInterval: 10000
  })
}

export function useBootstrap() {
  return useQuery({
    queryKey: ['bootstrap'],
    queryFn: api.bootstrap,
    retry: 3
  })
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: api.getTasks,
    refetchInterval: 5000,
    retry: 2
  })
}

export function useTaskDetail(taskId: string | null, workspaceKey?: string) {
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.getTaskDetail(taskId!, workspaceKey),
    enabled: !!taskId,
    refetchInterval: 1500
  })
}

export function useEvents(taskId: string | null, since: number, workspaceKey?: string) {
  return useQuery({
    queryKey: ['events', taskId, since],
    queryFn: () => api.getEvents(taskId!, since, workspaceKey),
    enabled: !!taskId,
    refetchInterval: 1500
  })
}

export function useCreateTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: api.createTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  })
}

export function useDeleteTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey }: { taskId: string; workspaceKey?: string }) =>
      api.deleteTask(taskId, workspaceKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  })
}

export function useStartTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      taskId,
      data
    }: {
      taskId: string
      data: { actor?: string; message?: string; workspace_key?: string }
    }) => api.startTask(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      taskId,
      data
    }: {
      taskId: string
      data: { actor?: string; message?: string; workspace_key?: string; attachmentMeta?: import('../../shared/types').AttachmentMeta[] }
    }) => api.sendMessage(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useSkipCountdown() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      taskId,
      data
    }: {
      taskId: string
      data: { next_actor?: string; workspace_key?: string }
    }) => api.skipCountdown(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function usePauseCountdown() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      taskId,
      data
    }: {
      taskId: string
      data: { next_actor?: string; workspace_key?: string }
    }) => api.pauseCountdown(taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useInterrupt() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey }: { taskId: string; workspaceKey?: string }) =>
      api.interrupt(taskId, workspaceKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useEnqueueInstruction() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey, content, attachments }: { taskId: string; workspaceKey: string; content: string; attachments?: import('../../shared/types').AttachmentMeta[] }) =>
      api.enqueueInstruction(taskId, workspaceKey, content, attachments),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useDequeueInstruction() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey, itemId }: { taskId: string; workspaceKey: string; itemId: string }) =>
      api.dequeueInstruction(taskId, workspaceKey, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useClearInstructionQueue() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey }: { taskId: string; workspaceKey: string }) =>
      api.clearInstructionQueue(taskId, workspaceKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useInterruptAndInsert() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, workspaceKey, queueItemId }: { taskId: string; workspaceKey: string; queueItemId: string }) =>
      api.interruptAndInsert(taskId, workspaceKey, queueItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task'] })
    }
  })
}

export function useUpdateGlobalSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (settings: GlobalSettings) => api.updateGlobalSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
    }
  })
}

export type { GitDiffStats, GitRemote, GitStatusResult } from '../../shared/types'

export function useGitStatus(repoRoot: string | null | undefined) {
  return useQuery({
    queryKey: ['gitStatus', repoRoot],
    queryFn: () => api.gitStatus(repoRoot!) as Promise<GitStatusResult>,
    enabled: !!repoRoot,
    refetchInterval: 10000
  })
}

export function useGitStageAll() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (repoRoot: string) => api.gitStageAll(repoRoot),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gitStatus'] })
    }
  })
}

export function useGitCommitAndPush() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ repoRoot, message, remote, push }: { repoRoot: string; message: string; remote: string; push?: boolean }) =>
      api.gitCommitAndPush(repoRoot, message, remote, push),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gitStatus'] })
    }
  })
}
