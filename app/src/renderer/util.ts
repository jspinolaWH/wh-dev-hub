export const openLink = (url: string) => (window.wh ? window.wh.openExternal(url) : window.open(url))

export const fmtCost = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
