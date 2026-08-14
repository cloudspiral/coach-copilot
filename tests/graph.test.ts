import { describe, expect, it } from "vitest";
import { exercises, member } from "../src/server/data.js";
import { assertTestDatabase } from "../src/server/db/database.js";
import { sourceHash, stableId, validateGraph } from "../src/server/db/ingestion.js";
import { buildDomainGraph, buildGraph, composeGraph } from "../src/server/graph.js";
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

  it("keeps immutable domain concepts separate from the member overlay", () => {
    const domain = buildDomainGraph(exercises);
    const before = domain.stats();
    expect(before.byType.Member).toBeUndefined();
    validateGraph(domain);
    const composed = composeGraph(domain, member);
    expect(composed.stats()).toEqual(graph.stats());
    expect(domain.stats()).toEqual(before);
  });

  it("derives repeatable IDs and source hashes while detecting content changes", () => {
    expect(stableId("member", "organization:external-123")).toBe(stableId("member", "organization:external-123"));
    const original = sourceHash({ exercises, member });
    expect(sourceHash({ exercises: structuredClone(exercises), member: structuredClone(member) })).toBe(original);
    const changed = structuredClone(member);
    changed.profile.weight_kg += 0.1;
    expect(sourceHash({ exercises, member: changed })).not.toBe(original);
  });

  it("refuses destructive setup against a non-test database", () => {
    expect(() => assertTestDatabase("postgresql://user:pass@localhost/coach_copilot")).toThrow(/must end in _test/);
    expect(() => assertTestDatabase("postgresql://user:pass@localhost/coach_copilot_test")).not.toThrow();
  });

  it("joins Jordan's active knee condition to exercises through anatomy traversal", () => {
    const affected = graph.affectedAnatomyPaths(`member:${member.profile.id}`);
    expect(affected.get("anatomy:knee")?.path).toEqual([
      `member:${member.profile.id}`,
      "has_condition",
      "condition:inj_knee_left",
      "affects",
      "anatomy:patellofemoral-area",
      "part_of",
      "anatomy:knee",
    ]);

    const kneeScope = new Set(affected.keys());
    const kneeLoadingExercise = exercises.find((exercise) => exercise.name === "Dumbbell Goblet Split Squat")!;
    const kneeSparingExercise = exercises.find((exercise) => exercise.name === "Walking Toe Touches")!;
    expect(graph.stressPathToAny(`exercise:${kneeLoadingExercise.id}`, kneeScope)?.path).toEqual([
      `exercise:${kneeLoadingExercise.id}`,
      "stresses",
      "anatomy:knee",
    ]);
    expect(graph.stressPathToAny(`exercise:${kneeSparingExercise.id}`, kneeScope)).toBeUndefined();
  });
});
