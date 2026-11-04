import { AgentIcon } from '../settings/AgentIcon'
import type { LibraryTarget } from '../../../shared/library'

export function AgentChips({
  targets,
  assigned,
  onToggle,
  linkSkillPhysicalKeys = false
}: {
  targets: LibraryTarget[]
  assigned: string[]
  onToggle: (targetId: string, enabled: boolean) => void
  /** When true, toggling one target also represents its linkedSkillTargetIds. */
  linkSkillPhysicalKeys?: boolean
}) {
  const assignedSet = new Set(assigned)
  return (
    <div className="library-chips" role="group">
      {targets.map((target) => {
        const linked = linkSkillPhysicalKeys ? target.linkedSkillTargetIds || [] : []
        const on = assignedSet.has(target.targetId) || linked.some((id) => assignedSet.has(id))
        const disabled = target.pendingInit && !target.capabilities.writeMcp && !target.capabilities.writeSkills
        const title = [
          target.displayName,
          target.configContext !== 'native' ? `(${target.configContext})` : '',
          linked.length ? 'skills 与关联目标共用目录，开关联动' : '',
          target.pendingInit ? '尚未初始化' : '',
          target.capabilities.reason || ''
        ].filter(Boolean).join(' · ')
        return (
          <button
            key={target.targetId}
            type="button"
            className={`library-chip${on ? ' on' : ''}${linked.length ? ' locked' : ''}`}
            title={title}
            aria-label={target.displayName}
            aria-pressed={on}
            disabled={disabled || (!target.capabilities.writeSkills && !target.capabilities.writeMcp && !target.pendingInit)}
            onClick={() => onToggle(target.targetId, !on)}
          >
            <AgentIcon id={target.agentId} size={14} />
          </button>
        )
      })}
    </div>
  )
}
