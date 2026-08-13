import type { GraphNode } from "../shared/schemas.js";
import type { KnowledgeGraph } from "./graph.js";

export interface Resolution {
  input: string;
  nodeId?: string;
  label?: string;
  confidence: number;
  method: "exact" | "alias" | "fuzzy" | "unresolved";
}

export const aliases: Record<string, string> = {
  db: "dumbbell",
  dumbbells: "dumbbell",
  kb: "kettlebell",
  kettlebells: "kettlebell",
  "leg day": "lower body",
  legs: "lower body",
  pec: "chest",
  pecs: "chest",
  "bad lower back": "lumbar spine",
  "lower back": "lumbar spine",
  kneecap: "patella",
  "left knee": "knee",
  bands: "resistance band - loop",
  "loop band": "resistance band - loop",
};

export function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

function levenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[left.length][right.length];
}

function similarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  return maxLength === 0 ? 1 : 1 - levenshtein(left, right) / maxLength;
}

export class ConceptResolver {
  private readonly concepts: GraphNode[];

  constructor(graph: KnowledgeGraph) {
    this.concepts = [...graph.nodes.values()].filter((node) => ["Anatomy", "Equipment", "MovementPattern", "Exercise"].includes(node.type));
  }

  resolve(input: string, allowedTypes?: GraphNode["type"][]): Resolution {
    const normalizedInput = normalize(input);
    const pool = allowedTypes ? this.concepts.filter((node) => allowedTypes.includes(node.type)) : this.concepts;
    const exact = pool.find((node) => normalize(node.label) === normalizedInput);
    if (exact) return { input, nodeId: exact.id, label: exact.label, confidence: 1, method: "exact" };

    const aliased = aliases[normalizedInput];
    if (aliased) {
      const aliasMatch = pool.find((node) => normalize(node.label) === normalize(aliased));
      if (aliasMatch) return { input, nodeId: aliasMatch.id, label: aliasMatch.label, confidence: 0.95, method: "alias" };
    }

    const ranked = pool
      .map((node) => ({ node, score: similarity(normalizedInput, normalize(node.label)) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];
    if (best && best.score >= 0.72 && (!second || best.score - second.score >= 0.08)) {
      return { input, nodeId: best.node.id, label: best.node.label, confidence: Number(best.score.toFixed(2)), method: "fuzzy" };
    }
    return { input, confidence: best ? Number(best.score.toFixed(2)) : 0, method: "unresolved" };
  }
}
