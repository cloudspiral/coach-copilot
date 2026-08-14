import type { CopilotResponse } from "./copilot.js";
import type { MemberContext } from "./data.js";
import type { KnowledgeGraph } from "./graph.js";
import type { WorkoutResponse } from "./workout.js";
import type {
  CopilotTopic,
  ExerciseRecord,
  WorkoutIntent,
  WorkoutPlan,
} from "../shared/schemas.js";

export interface ConversationTurn {
  message: string;
  topic: CopilotTopic;
  topics: CopilotTopic[];
  headline: string;
  answer: string;
}

export interface ActiveDomainGraph {
  versionId: string;
  graph: KnowledgeGraph;
}

export interface DataRepository {
  getMember(memberId: string): Promise<MemberContext | null>;
  getExercises(): Promise<ExerciseRecord[]>;
}

export interface PlanRepository {
  get(planId: string): Promise<{ plan: WorkoutPlan; intent: WorkoutIntent } | null>;
  save(plan: WorkoutPlan, intent: WorkoutIntent): Promise<void>;
}

export interface ConversationRepository {
  getRecent(conversationId: string, memberId: string, limit: number): Promise<ConversationTurn[]>;
  append(conversationId: string, memberId: string, turn: ConversationTurn): Promise<void>;
}

export interface GraphRepository {
  loadActive(): Promise<ActiveDomainGraph | null>;
}

export interface WorkflowRepository {
  start(input: {
    id: string;
    kind: "workout" | "copilot";
    memberId: string;
    conversationId?: string;
    graphVersionId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  complete(id: string, output: WorkoutResponse | CopilotResponse): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  saveWorkout(input: {
    workflowRunId: string;
    graphVersionId: string;
    response: WorkoutResponse;
    intent: WorkoutIntent;
  }): Promise<void>;
}

export interface RuntimeRepositories {
  data: DataRepository;
  plans: PlanRepository;
  conversations: ConversationRepository;
  graphs: GraphRepository;
  workflows: WorkflowRepository;
}

export class MemoryDataRepository implements DataRepository {
  constructor(
    private readonly member: MemberContext,
    private readonly exercises: ExerciseRecord[],
  ) {}

  async getMember(memberId: string): Promise<MemberContext | null> {
    return memberId === this.member.profile.id ? structuredClone(this.member) : null;
  }

  async getExercises(): Promise<ExerciseRecord[]> {
    return structuredClone(this.exercises);
  }
}

export class MemoryPlanRepository implements PlanRepository {
  private readonly plans = new Map<string, { plan: WorkoutPlan; intent: WorkoutIntent }>();

  async get(planId: string): Promise<{ plan: WorkoutPlan; intent: WorkoutIntent } | null> {
    const value = this.plans.get(planId);
    return value ? structuredClone(value) : null;
  }

  async save(plan: WorkoutPlan, intent: WorkoutIntent): Promise<void> {
    this.plans.set(plan.id, structuredClone({ plan, intent }));
  }
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, ConversationTurn[]>();

  async getRecent(conversationId: string, _memberId: string, limit: number): Promise<ConversationTurn[]> {
    return structuredClone((this.conversations.get(conversationId) ?? []).slice(-limit));
  }

  async append(conversationId: string, _memberId: string, turn: ConversationTurn): Promise<void> {
    const updated = [...(this.conversations.get(conversationId) ?? []), structuredClone(turn)].slice(-100);
    this.conversations.set(conversationId, updated);
  }
}

export class MemoryGraphRepository implements GraphRepository {
  constructor(private active: ActiveDomainGraph) {}

  async loadActive(): Promise<ActiveDomainGraph> {
    return this.active;
  }

  setActive(active: ActiveDomainGraph): void {
    this.active = active;
  }
}

export class MemoryWorkflowRepository implements WorkflowRepository {
  readonly runs = new Map<string, { status: string; output?: WorkoutResponse | CopilotResponse; error?: string }>();

  async start(input: {
    id: string;
    kind: "workout" | "copilot";
    memberId: string;
    conversationId?: string;
    graphVersionId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.runs.set(input.id, { status: "running" });
  }

  async complete(id: string, output: WorkoutResponse | CopilotResponse): Promise<void> {
    this.runs.set(id, { status: "completed", output: structuredClone(output) });
  }

  async fail(id: string, error: string): Promise<void> {
    this.runs.set(id, { status: "failed", error });
  }

  async saveWorkout(_input: {
    workflowRunId: string;
    graphVersionId: string;
    response: WorkoutResponse;
    intent: WorkoutIntent;
  }): Promise<void> {}
}
