export interface AuthResult {
  user: string
}

export interface Authenticator {
  verify(token: string): Promise<AuthResult | null>
}

/**
 * Dev/config-file auth: static tokens mapped to usernames.
 * Replaced/augmented by Slack OIDC sign-in, which will issue tokens
 * into the same verification path.
 */
export class StaticTokenAuth implements Authenticator {
  constructor(private tokens: Record<string, string>) {}

  async verify(token: string): Promise<AuthResult | null> {
    const user = this.tokens[token]
    return user ? { user } : null
  }
}
