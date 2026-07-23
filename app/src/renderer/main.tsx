import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// No StrictMode: its dev-only double-mount attaches/detaches the pty twice,
// which makes TUI apps repaint and flicker.
createRoot(document.getElementById('root')!).render(<App />)
