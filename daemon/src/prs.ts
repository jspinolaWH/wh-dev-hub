import { execFile } from 'node:child_process'
import type { PrRef, PrStatus, PrTask, SourceStatus } from '@wh/shared'

const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

/** GitHub pull request links in (de-ANSI'd) terminal output. */
export function findPrRefs(text: string): PrRef[] {
  return [...text.matchAll(PR_URL_RE)].map((m) => ({ owner: m[1], repo: m[2], number: Number(m[3]) }))
}

export const prKey = (p: PrRef) => `${p.owner}/${p.repo}#${p.number}`.toLowerCase()
const prUrl = (p: PrRef) => `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`

export interface PrSourcesConfig {
  /** Read access to the repos. Falls back to GITHUB_TOKEN / GH_TOKEN, then `gh auth token`. */
  github?: { token?: string; graphqlUrl?: string }
  /** Linear personal API key; read-only is enough. Falls back to LINEAR_API_KEY. */
  linear?: { apiKey?: string; graphqlUrl?: string }
}

interface GithubPr {
  title: string
  url: string
  state: PrStatus['state']
  isDraft: boolean
  reviewDecision: PrStatus['review'] | null
  author: { login: string } | null
  commits: { nodes: { commit: { statusCheckRollup: { state: PrStatus['checks'] } | null } }[] }
}

interface LinearIssue {
  identifier: string
  title: string
  url: string
  state: { name: string; type: string; color: string }
  assignee: { name: string } | null
}

const CACHE_MS = 60_000

/**
 * Looks pull requests up on GitHub, and the Linear issues they're attached to
 * (Linear's GitHub integration attaches each PR to its issue). One batched
 * GraphQL request per service; results are cached for a minute.
 */
export class PrStatusService {
  private cache = new Map<string, { at: number; status: PrStatus }>()
  private sources: { github: SourceStatus; linear: SourceStatus } = { github: 'ok', linear: 'ok' }

  constructor(private config: PrSourcesConfig) {}

  async statuses(refs: PrRef[], refresh = false) {
    const now = Date.now()
    const stale = refs.filter((r) => refresh || now - (this.cache.get(prKey(r))?.at ?? 0) >= CACHE_MS)
    if (stale.length) {
      const fresh = stale.map((r): PrStatus => ({ ...r, url: prUrl(r), tasks: [] }))
      const github = await this.fillFromGithub(fresh)
      const linear = await this.fillFromLinear(fresh) // after GitHub: needs its canonical URLs
      this.sources = { github, linear }
      const failed = typeof github !== 'string' || typeof linear !== 'string'
      for (const status of fresh) {
        const key = prKey(status)
        // After a failed lookup keep showing the last good answer, left stale
        // so the next look retries.
        if (!failed) this.cache.set(key, { at: now, status })
        else if (!this.cache.has(key)) this.cache.set(key, { at: 0, status })
      }
    }
    return { prs: refs.map((r) => this.cache.get(prKey(r))?.status ?? { ...r, url: prUrl(r), tasks: [] }), ...this.sources }
  }

  private async fillFromGithub(prs: PrStatus[]): Promise<SourceStatus> {
    const token = await this.githubToken()
    if (!token) return 'not-configured'
    const fields =
      'title url state isDraft reviewDecision author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }'
    const query = `query {\n${prs
      .map((p, i) => `p${i}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { ${fields} } }`)
      .join('\n')}\n}`
    try {
      const data = await graphql(this.config.github?.graphqlUrl ?? 'https://api.github.com/graphql', `bearer ${token}`, query)
      prs.forEach((p, i) => {
        const pr = (data[`p${i}`] as { pullRequest: GithubPr | null } | null)?.pullRequest
        if (!pr) return // no access to that repo, or no such PR
        Object.assign(p, {
          url: pr.url,
          title: pr.title,
          state: pr.state,
          draft: pr.isDraft,
          review: pr.reviewDecision ?? undefined,
          author: pr.author?.login,
          checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? undefined,
        })
      })
      return 'ok'
    } catch (err) {
      return { error: `GitHub: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private async fillFromLinear(prs: PrStatus[]): Promise<SourceStatus> {
    const apiKey = this.config.linear?.apiKey || process.env.LINEAR_API_KEY
    if (!apiKey) return 'not-configured'
    const issue = 'identifier title url state { name type color } assignee { name }'
    const query = `query {\n${prs
      .map((p, i) => `a${i}: attachmentsForURL(url: ${JSON.stringify(p.url)}) { nodes { issue { ${issue} } } }`)
      .join('\n')}\n}`
    try {
      const data = await graphql(this.config.linear?.graphqlUrl ?? 'https://api.linear.app/graphql', apiKey, query)
      prs.forEach((p, i) => {
        const nodes = (data[`a${i}`] as { nodes: { issue: LinearIssue | null }[] } | null)?.nodes ?? []
        const tasks = new Map<string, PrTask>()
        for (const { issue: t } of nodes) {
          if (!t || tasks.has(t.identifier)) continue
          tasks.set(t.identifier, {
            identifier: t.identifier,
            title: t.title,
            url: t.url,
            state: t.state.name,
            stateType: t.state.type,
            stateColor: t.state.color,
            assignee: t.assignee?.name,
          })
        }
        p.tasks = [...tasks.values()]
      })
      return 'ok'
    } catch (err) {
      return { error: `Linear: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** The configured token, then the usual env vars, then whoever `gh` on this host is logged in as. */
  private async githubToken(): Promise<string | undefined> {
    return this.config.github?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ghAuthToken()
  }
}

let ghCli: { at: number; token?: string } | undefined

/** Whoever `gh` on this host is logged in as; asked again after 10 min (1 min while nobody is). */
export async function ghAuthToken(): Promise<string | undefined> {
  if (ghCli && Date.now() - ghCli.at < (ghCli.token ? 10 * 60_000 : 60_000)) return ghCli.token
  const token = await new Promise<string | undefined>((resolve) =>
    execFile('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim() || undefined),
    ),
  )
  ghCli = { at: Date.now(), token }
  return token
}

async function graphql(url: string, authorization: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'user-agent': 'wh-dev-hub' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    data?: Record<string, unknown> | null
    errors?: { message: string }[]
    message?: string
  }
  // Partial data is fine (e.g. one repo we can't see); only a missing
  // `data` means the whole request failed.
  if (!res.ok || !body.data) throw new Error(body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`)
  return body.data
}
