/**
 * Shared accessible switch control.
 *
 * Mirrors the visual style previously inlined in SettingsContent so every
 * consumer (settings page, create-task modal, ...) gets the same track, knob,
 * focus ring, and `role="switch"` semantics. The control holds no internal
 * state — it is fully controlled via `checked` / `onChange`.
 */
export function Switch({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean
  onChange: (value: boolean) => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${checked ? 'bg-accent-primary' : 'bg-border'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  )
}
