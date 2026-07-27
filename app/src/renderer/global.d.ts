export {}

declare global {
  interface Window {
    wh?: {
      openExternal: (url: string) => void
      readClipboard: () => string
      writeClipboard: (text: string) => void
      readClipboardImage: () => string
    }
  }
}
