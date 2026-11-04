import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibrarySnapshot } from '../../shared/library'

const libraryKey = ['buddy', 'library'] as const

export function useLibrarySnapshot() {
  return useQuery({
    queryKey: libraryKey,
    queryFn: () => window.buddy.getLibrarySnapshot(false),
    staleTime: 15_000
  })
}

export function useLibraryActions() {
  const cache = useQueryClient()
  const setSnap = (data: LibrarySnapshot) => cache.setQueryData(libraryKey, data)
  const refresh = useMutation({
    mutationFn: () => window.buddy.refreshLibrary(true),
    onSuccess: setSnap
  })
  const importSkills = useMutation({
    mutationFn: (ids: string[]) => window.buddy.importLibrarySkills(ids),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  const setSkill = useMutation({
    mutationFn: (input: { skillId: string; targetId: string; enabled: boolean }) =>
      window.buddy.setLibrarySkillAssignment(input.skillId, input.targetId, input.enabled),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  const eject = useMutation({
    mutationFn: (skillId: string) => window.buddy.ejectLibrarySkill(skillId),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  const ejectServer = useMutation({
    mutationFn: (serverId: string) => window.buddy.ejectLibraryServer(serverId),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  const importServers = useMutation({
    mutationFn: (ids: string[]) => window.buddy.importLibraryServers(ids),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  const addServer = useMutation({
    mutationFn: (input: { name: string; raw: Record<string, unknown> }) =>
      window.buddy.addLibraryServer(input.name, input.raw),
    onSuccess: async (result) => {
      if (result.status === 'ok') setSnap(await window.buddy.getLibrarySnapshot())
    }
  })
  const setServer = useMutation({
    mutationFn: (input: { serverId: string; targetId: string; enabled: boolean }) =>
      window.buddy.setLibraryServerAssignment(input.serverId, input.targetId, input.enabled),
    onSuccess: async () => setSnap(await window.buddy.getLibrarySnapshot(true))
  })
  return { ejectServer, refresh, importSkills, setSkill, eject, importServers, addServer, setServer }
}
