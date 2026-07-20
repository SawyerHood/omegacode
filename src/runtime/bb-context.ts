export interface BbRunContext {
  threadId: string
  environmentId: string
  projectId?: string
}

/** Capture BB ownership when omegacode is launched from a BB thread shell. */
export function bbRunContextFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BbRunContext | null {
  const threadId = env.BB_THREAD_ID?.trim()
  const environmentId = env.BB_ENVIRONMENT_ID?.trim()
  if (!threadId || !environmentId) return null

  const projectId = env.BB_PROJECT_ID?.trim()
  return projectId ? { threadId, environmentId, projectId } : { threadId, environmentId }
}
