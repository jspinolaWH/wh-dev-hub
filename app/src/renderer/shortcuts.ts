/** App-wide keyboard shortcuts. The terminal lets these through to the window. */
export type Shortcut = 'switcher' | 'new-chat' | 'prev-chat' | 'next-chat' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

// On a Mac the app uses Cmd, leaving Ctrl+K & co. to the shell like any terminal.
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = IS_MAC ? '⌘' : 'Ctrl'
export const isMod = (e: KeyboardEvent) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey

export function shortcutOf(e: KeyboardEvent): Shortcut | undefined {
  const k = e.key.toLowerCase()
  if (isMod(e) && !e.shiftKey && k === 'k') return 'switcher'
  if ((isMod(e) && !e.shiftKey && k === 'n') || (e.altKey && !e.ctrlKey && !e.metaKey && k === 'n')) return 'new-chat'
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') return 'prev-chat'
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') return 'next-chat'
  if (isMod(e) && (e.key === '=' || e.key === '+')) return 'zoom-in'
  if (isMod(e) && e.key === '-') return 'zoom-out'
  if (isMod(e) && e.key === '0') return 'zoom-reset'
  return undefined
}
