import { describe, expect, it } from "vitest";
import { exercises, member } from "../src/server/data.js";
import { buildGraph } from "../src/server/graph.js";
import { ConceptResolver } from "../src/server/resolver.js";

describe("knowledge graph and concept resolution", () => {
  const graph = buildGraph(exercises, member);
  const resolver = new ConceptResolver(graph);

  it("traverses patellofemoral anatomy to the knee region", () => {
    expect([...graph.ancestors("anatomy:patellofemoral-area")]).toEqual(expect.arrayContaining(["anatomy:knee", "anatomy:knee-region"]));
    expect(graph.nodes.get("anatomy:knee")?.provenance?.ontologyUri).toBe("http://snomed.info/id/49076000");
  });

  it("resolves exact matches, curated aliases, fuzzy terms, and ambiguity", () => {
    expect(resolver.resolve("Dumbbell", ["Equipment"]).method).toBe("exact");
    expect(resolver.resolve("DB", ["Equipment"])).toMatchObject({ label: "Dumbbell", method: "alias" });
    expect(resolver.resolve("kneecap", ["Anatomy"])).toMatchObject({ label: "patella", method: "alias" });
    expect(resolver.resolve("zorp joint", ["Anatomy"]).method).toBe("unresolved");
  });

  it("builds exercise, member, fact, equipment, and safety edges", () => {
    expect(graph.stats().byType.Exercise).toBe(exercises.length);
    expect(graph.edgesFrom(`member:${member.profile.id}`, "has_condition")).toHaveLength(1);
    expect(graph.edges.size).toBeGreaterThan(150);
  });
});
