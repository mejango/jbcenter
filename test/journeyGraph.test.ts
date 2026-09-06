import { describe, expect, it } from "vitest";
import {
  directoryTree,
  repositoryGroups,
  type DirectoryNode,
} from "../src/directory.js";
import {
  journeyNodes,
  journeyViews,
  validateJourneyGraph,
  type JourneyNode,
  type JourneyView,
} from "../src/journeyGraph.js";

const nodesById = new Map(journeyNodes.map((node) => [node.id, node]));

function visibleIds(view: JourneyView): Set<string> {
  return new Set(view.layout.map((cell) => cell.node));
}

function reachableFrom(
  entry: string,
  visible: ReadonlySet<string>,
): Set<string> {
  const reached = new Set([entry]);
  const queue = [entry];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const edge of nodesById.get(id)!.edges) {
      if (visible.has(edge.to) && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

/** Exclude return edges so a loop cannot masquerade as a deeper decision path. */
function findForwardPath(
  entry: string,
  visible: ReadonlySet<string>,
  accept: (path: readonly string[]) => boolean,
  path: readonly string[] = [entry],
): readonly string[] | undefined {
  if (accept(path)) return path;
  for (const edge of nodesById.get(entry)!.edges) {
    if (
      edge.kind === "return" ||
      !visible.has(edge.to) ||
      path.includes(edge.to)
    )
      continue;
    const result = findForwardPath(edge.to, visible, accept, [
      ...path,
      edge.to,
    ]);
    if (result) return result;
  }
  return undefined;
}

function directoryUrls(nodes: readonly DirectoryNode[]): Set<string> {
  const urls = new Set<string>();
  for (const node of nodes) {
    if (node.url) urls.add(node.url);
    if (node.sourceUrl) urls.add(node.sourceUrl);
    for (const url of directoryUrls(node.children ?? [])) urls.add(url);
  }
  return urls;
}

describe("journey graph navigation", () => {
  // Import-time validation already rejects malformed IDs, missing targets, and
  // invalid grid cells. These checks protect how a visitor can use each map.
  it.each(journeyViews)(
    "makes every $id map node reachable from its entry",
    (view) => {
      const visible = visibleIds(view);
      expect(reachableFrom(view.entry, visible)).toEqual(visible);
    },
  );

  it.each(journeyViews)(
    "gives $id a deeper route, a merge, and a real return cycle",
    (view) => {
      const visible = visibleIds(view);
      const deepPath = findForwardPath(
        view.entry,
        visible,
        (path) => path.length >= 4,
      );
      expect(
        deepPath,
        `${view.id} should offer at least three forward steps`,
      ).toBeDefined();

      const parents = new Map<string, Set<string>>();
      for (const id of visible) {
        for (const edge of nodesById.get(id)!.edges) {
          if (!visible.has(edge.to) || edge.kind === "return") continue;
          const predecessors = parents.get(edge.to) ?? new Set<string>();
          predecessors.add(id);
          parents.set(edge.to, predecessors);
        }
      }
      expect(
        [...parents.values()].some((predecessors) => predecessors.size > 1),
        `${view.id} should let different choices meet at a shared resource or decision`,
      ).toBe(true);

      const hasReturnCycle = [...visible].some((from) =>
        nodesById.get(from)!.edges.some((edge) => {
          if (
            edge.kind !== "return" ||
            !visible.has(edge.to) ||
            edge.to === from
          )
            return false;
          return (
            findForwardPath(
              edge.to,
              visible,
              (path) =>
                path.at(-1) === from &&
                path.some((id) => nodesById.get(id)!.kind === "resource"),
            ) !== undefined
          );
        }),
      );
      expect(
        hasReturnCycle,
        `${view.id} should return to an earlier choice after reaching a resource`,
      ).toBe(true);
    },
  );

  it("gives decisions distinct choices and resources a usable destination", () => {
    for (const node of journeyNodes) {
      expect(new Set(node.edges.map((edge) => edge.label)).size, node.id).toBe(
        node.edges.length,
      );
      if (node.kind === "question") {
        expect(
          new Set(node.edges.map((edge) => edge.to)).size,
          node.id,
        ).toBeGreaterThanOrEqual(2);
      } else {
        expect(Boolean(node.content || node.links?.length), node.id).toBe(true);
      }
    }
  });

  it("lands every crossover in another usable map", () => {
    let crossovers = 0;
    for (const view of journeyViews) {
      const visible = visibleIds(view);
      for (const id of visible) {
        for (const edge of nodesById.get(id)!.edges) {
          if (visible.has(edge.to)) continue;
          crossovers++;
          expect(
            journeyViews.some(
              (destination) =>
                destination.id !== view.id &&
                reachableFrom(destination.entry, visibleIds(destination)).has(
                  edge.to,
                ),
            ),
            `${view.id}/${id} should reach ${edge.to} in another map`,
          ).toBe(true);
        }
      }
    }
    expect(crossovers).toBeGreaterThan(0);
  });

  it("uses the directory's verified resource URLs", () => {
    const verifiedUrls = directoryUrls(directoryTree);
    for (const group of repositoryGroups) {
      for (const url of directoryUrls(group.links)) verifiedUrls.add(url);
    }
    for (const node of journeyNodes) {
      for (const link of node.links ?? []) {
        expect(verifiedUrls.has(link.url), `${node.id}: ${link.url}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps WIP extensions out of the production app destinations", () => {
    const wipUrls = directoryUrls(
      directoryTree.filter((node) => node.id === "wip"),
    );
    const appView = journeyViews.find((view) => view.id === "apps")!;
    expect(wipUrls.size).toBeGreaterThan(0);
    for (const id of visibleIds(appView)) {
      for (const link of nodesById.get(id)!.links ?? []) {
        expect(
          wipUrls.has(link.url),
          `${id} should not recommend a WIP app`,
        ).toBe(false);
      }
    }
  });
});

describe("directory edit validation", () => {
  const fixtureNodes: readonly JourneyNode[] = [
    {
      id: "start",
      title: "Choose a resource",
      kind: "question",
      edges: [
        { label: "First", to: "first" },
        { label: "Second", to: "second" },
      ],
    },
    {
      id: "first",
      title: "First resource",
      kind: "resource",
      links: [{ title: "Open", url: "https://juicebox.money" }],
      edges: [],
    },
    {
      id: "second",
      title: "Second resource",
      kind: "resource",
      links: [{ title: "Open", url: "https://revnet.money" }],
      edges: [],
    },
  ];
  const fixtureView: JourneyView = {
    id: "example",
    title: "Example",
    entry: "start",
    layout: [
      { node: "start", column: 2, row: 1 },
      { node: "first", column: 1, row: 2 },
      { node: "second", column: 3, row: 2 },
    ],
  };

  it("accepts a complete graph and rejects a dangling destination", () => {
    expect(() =>
      validateJourneyGraph(fixtureNodes, [fixtureView]),
    ).not.toThrow();
    const broken = fixtureNodes.map((node) =>
      node.id === "start"
        ? { ...node, edges: [{ label: "Missing resource", to: "missing" }] }
        : node,
    );
    expect(() => validateJourneyGraph(broken, [fixtureView])).toThrow();
  });

  it("rejects conflicting node identities", () => {
    expect(() =>
      validateJourneyGraph([...fixtureNodes, fixtureNodes[0]!], [fixtureView]),
    ).toThrow();
  });

  it("rejects cards that would occupy the same grid cell", () => {
    const overlapping: JourneyView = {
      ...fixtureView,
      layout: fixtureView.layout.map((cell) =>
        cell.node === "second" ? { ...cell, column: 1, row: 2 } : cell,
      ),
    };
    expect(() => validateJourneyGraph(fixtureNodes, [overlapping])).toThrow();
  });

  it("rejects an entry point that its map cannot display", () => {
    expect(() =>
      validateJourneyGraph(fixtureNodes, [
        { ...fixtureView, entry: "missing" },
      ]),
    ).toThrow();
  });
});
