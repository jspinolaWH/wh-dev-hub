// Small stroke icons (16px grid, currentColor) for toolbars and the rail.
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const SearchIcon = () => <Icon d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14" />
export const ClipIcon = () => <Icon d="m13.5 7.5-5.8 5.8a3.3 3.3 0 0 1-4.7-4.7l6.1-6.1a2.2 2.2 0 0 1 3.1 3.1l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.5-5.5" />
export const SplitIcon = () => <Icon d="M2.5 2.5h11v11h-11zM8 2.5v11" />
export const SinglePaneIcon = () => <Icon d="M2.5 2.5h11v11h-11z" />
export const SidebarIcon = () => <Icon d="M2.5 2.5h11v11h-11zM6 2.5v11" />
export const PlusIcon = () => <Icon d="M8 3v10M3 8h10" />
export const GridIcon = () => <Icon d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" />
export const BackIcon = () => <Icon d="M10 3 5 8l5 5" />
export const LoopIcon = () => <Icon d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11M3.5 2.5v2.8h2.8M12.5 13.5v-2.8H9.7" />
