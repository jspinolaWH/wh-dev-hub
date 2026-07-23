declare module 'selfsigned' {
  interface GenerateResult {
    private: string
    public: string
    cert: string
  }
  export function generate(
    attrs?: Array<{ name: string; value: string }>,
    opts?: { days?: number; keySize?: number; algorithm?: string },
  ): Promise<GenerateResult>
}
