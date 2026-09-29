import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FolderInfo } from '@wh/shared'
import { DATA_DIR } from './config'

const FOLDERS_PATH = path.join(DATA_DIR, 'folders.json')

/** Normalise a user-typed name (chat or folder); throws if nothing is left. */
export function cleanName(name: unknown, what: string): string {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!clean) throw new Error(`${what} name can't be empty`)
  return clean
}

/** Each user's sidebar folders, persisted in folders.json (user -> folders). */
export class FolderStore {
  private byUser: Record<string, FolderInfo[]> = {}

  constructor() {
    if (!fs.existsSync(FOLDERS_PATH)) return
    try {
      this.byUser = JSON.parse(fs.readFileSync(FOLDERS_PATH, 'utf8'))
    } catch (err) {
      console.error('[folders] failed to load folders.json:', err)
    }
  }

  list(user: string): FolderInfo[] {
    return this.byUser[user] ?? []
  }

  has(user: string, id: string): boolean {
    return this.list(user).some((f) => f.id === id)
  }

  create(user: string, name: string): FolderInfo {
    const folder = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(name, 'Folder') }
    this.byUser[user] = [...this.list(user), folder]
    this.persist()
    return folder
  }

  rename(user: string, id: string, name: string) {
    const folder = this.list(user).find((f) => f.id === id)
    if (!folder) throw new Error(`no such folder: ${id}`)
    folder.name = cleanName(name, 'Folder')
    this.persist()
  }

  remove(user: string, id: string) {
    if (!this.has(user, id)) throw new Error(`no such folder: ${id}`)
    this.byUser[user] = this.list(user).filter((f) => f.id !== id)
    this.persist()
  }

  private persist() {
    fs.writeFileSync(FOLDERS_PATH, JSON.stringify(this.byUser, null, 2))
  }
}
