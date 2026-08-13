import type { EdgeType, GraphEdge, GraphNode, NodeType, Provenance } from "../shared/schemas.js";
import type { MemberContext } from "./data.js";
import type { ExerciseRecord } from "../shared/schemas.js";

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export class KnowledgeGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly outgoing = new Map<string, GraphEdge[]>();
  readonly incoming = new Map<string, GraphEdge[]>();

  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) {
      const merged = {
        ...existing,
        label: node.label || existing.label,
        properties: { ...existing.properties, ...node.properties },
        provenance: node.provenance ?? existing.provenance,
      };
      this.nodes.set(node.id, merged);
      return merged;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  ensureNode(id: string, type: NodeType, label: string, properties: Record<string, unknown> = {}, provenance?: Provenance): GraphNode {
    return this.addNode({ id, type, label, properties, provenance });
  }

  addEdge(edge: Omit<GraphEdge, "id"> & { id?: string }): GraphEdge {
    const id = edge.id ?? `${edge.source}:${edge.type}:${edge.target}`;
    const existing = this.edges.get(id);
    if (existing) return existing;
    const fullEdge: GraphEdge = { ...edge, id };
    this.edges.set(id, fullEdge);
    this.outgoing.set(edge.source, [...(this.outgoing.get(edge.source) ?? []), fullEdge]);
    this.incoming.set(edge.target, [...(this.incoming.get(edge.target) ?? []), fullEdge]);
    return fullEdge;
  }

  edgesFrom(source: string, type?: EdgeType): GraphEdge[] {
    return (this.outgoing.get(source) ?? []).filter((edge) => !type || edge.type === type);
  }

  ancestors(nodeId: string): Set<string> {
    const visited = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of this.edgesFrom(current, "part_of")) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    return visited;
  }

  stats(): { nodes: number; edges: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const node of this.nodes.values()) byType[node.type] = (byType[node.type] ?? 0) + 1;
    return { nodes: this.nodes.size, edges: this.edges.size, byType };
  }
}

const source = (jsonPointer: string): Provenance => ({ source: "data/exercises.json", jsonPointer });

export function buildGraph(exercises: ExerciseRecord[], member: MemberContext): KnowledgeGraph {
  const graph = new KnowledgeGraph();

  exercises.forEach((exercise, exerciseIndex) => {
    const exerciseId = `exercise:${exercise.id}`;
    graph.ensureNode(exerciseId, "Exercise", exercise.name, { ...exercise }, source(`/${exerciseIndex}`));

    exercise.muscle_groups.forEach((muscle, index) => {
      const target = `anatomy:${slug(muscle)}`;
      graph.ensureNode(target, "Anatomy", muscle, { subtype: "muscle" }, source(`/${exerciseIndex}/muscle_groups/${index}`));
      graph.addEdge({ source: exerciseId, target, type: "targets", properties: {}, provenance: source(`/${exerciseIndex}/muscle_groups/${index}`) });
    });
    exercise.joints_loaded.forEach((joint, index) => {
      const target = `anatomy:${slug(joint)}`;
      graph.ensureNode(target, "Anatomy", joint, { subtype: "joint" }, source(`/${exerciseIndex}/joints_loaded/${index}`));
      graph.addEdge({ source: exerciseId, target, type: "stresses", properties: {}, provenance: source(`/${exerciseIndex}/joints_loaded/${index}`) });
    });
    exercise.movement_patterns.forEach((pattern, index) => {
      const target = `pattern:${slug(pattern)}`;
      graph.ensureNode(target, "MovementPattern", pattern, {}, source(`/${exerciseIndex}/movement_patterns/${index}`));
      graph.addEdge({ source: exerciseId, target, type: "uses_movement_pattern", properties: {}, provenance: source(`/${exerciseIndex}/movement_patterns/${index}`) });
    });
    exercise.equipment_required.forEach((equipment, index) => {
      const target = `equipment:${slug(equipment)}`;
      graph.ensureNode(target, "Equipment", equipment, {}, source(`/${exerciseIndex}/equipment_required/${index}`));
      graph.addEdge({ source: exerciseId, target, type: "requires", properties: {}, provenance: source(`/${exerciseIndex}/equipment_required/${index}`) });
    });
  });

  const ontologySource: Provenance = { source: "curated domain overlay", derivationRule: "minimal anatomy hierarchy" };
  graph.ensureNode("anatomy:patella", "Anatomy", "patella", { subtype: "structure" }, ontologySource);
  graph.ensureNode("anatomy:patellofemoral-area", "Anatomy", "patellofemoral area", { subtype: "structure" }, ontologySource);
  graph.ensureNode("anatomy:knee", "Anatomy", "knee", {
    subtype: "joint",
    skosExactMatch: "http://snomed.info/id/49076000",
  }, { ...ontologySource, ontologyUri: "http://snomed.info/id/49076000" });
  graph.ensureNode("anatomy:knee-region", "Anatomy", "knee region", {
    subtype: "region",
    skosExactMatch: "http://snomed.info/id/72696002",
  }, { ...ontologySource, ontologyUri: "http://snomed.info/id/72696002" });
  graph.addEdge({ source: "anatomy:patella", target: "anatomy:knee", type: "part_of", properties: {}, provenance: ontologySource });
  graph.addEdge({ source: "anatomy:patellofemoral-area", target: "anatomy:knee", type: "part_of", properties: {}, provenance: ontologySource });
  graph.addEdge({ source: "anatomy:knee", target: "anatomy:knee-region", type: "part_of", properties: {}, provenance: ontologySource });

  const memberId = `member:${member.profile.id}`;
  graph.ensureNode(memberId, "Member", member.profile.name, { ...member.profile }, { source: "data/member-context.json", jsonPointer: "/profile" });

  member.injuries.forEach((injury, index) => {
    const injuryId = `condition:${injury.id}`;
    graph.ensureNode(injuryId, "InjuryOrCondition", injury.region, { ...injury }, { source: "data/member-context.json", jsonPointer: `/injuries/${index}` });
    graph.addEdge({ source: memberId, target: injuryId, type: "has_condition", properties: {}, provenance: { source: "data/member-context.json", jsonPointer: `/injuries/${index}` } });
    graph.addEdge({ source: injuryId, target: "anatomy:patellofemoral-area", type: "affects", properties: { laterality: "left" }, provenance: { source: "data/member-context.json", jsonPointer: `/injuries/${index}/notes` } });
  });

  const factGroups: Array<[string, unknown, string]> = [
    ["goals", member.goals, "/goals"],
    ["preferences", member.preferences, "/preferences"],
    ["equipment", member.equipment_available, "/equipment_available"],
    ["workouts", member.workout_history, "/workout_history"],
    ["adherence", member.adherence, "/adherence"],
    ["biomarkers", member.biomarkers, "/biomarkers"],
    ["labs", member.labs, "/labs"],
    ["chat", member.chat_history, "/chat_history"],
    ["coach_brief", member.coach_brief, "/coach_brief"],
  ];
  for (const [kind, value, pointer] of factGroups) {
    const factId = `fact:${member.profile.id}:${kind}`;
    graph.ensureNode(factId, "MemberFact", kind, { kind, value }, { source: "data/member-context.json", jsonPointer: pointer });
    graph.addEdge({ source: memberId, target: factId, type: "has_fact", properties: {}, provenance: { source: "data/member-context.json", jsonPointer: pointer } });
  }

  return graph;
}
