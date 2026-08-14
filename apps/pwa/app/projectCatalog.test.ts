import { describe, expect, it } from "vitest";
import { canonicalGatewayProjects } from "./projectCatalog";

describe("canonicalGatewayProjects", () => {
  const workspace = {
    projectId: "project-root",
    projectName: "Codever",
    cwd: "/work/codever",
  };

  it("keeps the Gateway workspace label when sessions use aliases", () => {
    expect(
      canonicalGatewayProjects(workspace, [
        {
          projectId: "project-root",
          projectName: "Temporary task name",
          cwd: "/work/codever",
        },
      ]),
    ).toEqual([workspace]);
  });

  it("is stable across session ordering and chooses one label per project ID", () => {
    const first = {
      projectId: "project-other",
      projectName: "Beta",
      cwd: "/work/other",
    };
    const second = { ...first, projectName: "Alpha" };

    const forward = canonicalGatewayProjects(null, [first, second]);
    const reverse = canonicalGatewayProjects(null, [second, first]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([{ ...first, projectName: "Alpha" }]);
  });
});
