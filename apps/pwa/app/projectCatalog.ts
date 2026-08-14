export type GatewayProjectSource = {
  projectId: string;
  projectName: string;
  cwd: string;
};

/**
 * A project is identified by its Gateway project ID (which is derived from
 * the working directory), not by a freely-entered display name. Build one
 * deterministic label per identity so session ordering and process restarts
 * cannot rename a project group on screen.
 */
export function canonicalGatewayProjects(
  workspace: GatewayProjectSource | null | undefined,
  sessions: readonly GatewayProjectSource[],
): GatewayProjectSource[] {
  const projects = new Map<string, GatewayProjectSource>();
  const orderedSessions = [...sessions].sort(compareProjectSources);
  for (const session of orderedSessions) {
    if (!projects.has(session.projectId)) {
      projects.set(session.projectId, copyProject(session));
    }
  }

  if (workspace) {
    // The authenticated Gateway workspace is the canonical source for its
    // own project, even when older sessions carry a historical alias.
    projects.set(workspace.projectId, copyProject(workspace));
  }

  const current = workspace ? projects.get(workspace.projectId) : undefined;
  const remaining = [...projects.values()]
    .filter((project) => project.projectId !== current?.projectId)
    .sort(compareProjectSources);
  return current ? [current, ...remaining] : remaining;
}

function compareProjectSources(
  left: GatewayProjectSource,
  right: GatewayProjectSource,
): number {
  return (
    left.projectName.localeCompare(right.projectName) ||
    left.cwd.localeCompare(right.cwd) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function copyProject(project: GatewayProjectSource): GatewayProjectSource {
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    cwd: project.cwd,
  };
}
