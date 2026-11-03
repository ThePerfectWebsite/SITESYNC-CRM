/** Release URLs and labels shared by the project pages (spec §8.2). */
export type ReleaseAction = "promote" | "rollback" | "build_from_ref";

export const preflightHref = (projectId: string, action: ReleaseAction, target?: string | null) =>
  `/projects/${projectId}/deploy/preflight?action=${action}${target ? `&target=${target}` : ""}`;
