import { randomUUID } from "node:crypto";
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { z } from "zod";
import {
  CopilotRequestSchema,
  WorkoutRequestSchema,
  type CopilotRequest,
  type WorkoutRequest,
} from "../shared/schemas.js";
import type { AppConfig } from "./config.js";
import { CopilotService, type CopilotResponse } from "./copilot.js";
import { ActiveGraphProvider, MemberNotFoundError } from "./graph-provider.js";
import type { StructuredModelGateway } from "./openai.js";
import type { RuntimeRepositories } from "./repositories.js";
import { WorkoutService, type WorkoutResponse } from "./workout.js";

const WorkoutWorkflowState = z.object({
  request: WorkoutRequestSchema,
  workflowRunId: z.string(),
  graphVersionId: z.string().optional(),
  response: z.custom<WorkoutResponse>().optional(),
});

const CopilotWorkflowState = z.object({
  request: CopilotRequestSchema,
  workflowRunId: z.string(),
  graphVersionId: z.string().optional(),
  response: z.custom<CopilotResponse>().optional(),
});

function validateWorkoutResponse(response: WorkoutResponse): void {
  if (response.status !== "ready") return;
  if (!response.plan) throw new Error("Ready workout response is missing its plan");
  if (response.plan.memberId.length === 0) throw new Error("Workout plan is missing its member ID");
  const evidenceIds = new Set(response.evidence.map((item) => item.id));
  for (const prescription of response.plan.sections.flatMap((section) => section.exercises)) {
    if (!prescription.evidenceIds.length || prescription.evidenceIds.some((id) => !evidenceIds.has(id))) {
      throw new Error(`Workout prescription ${prescription.exerciseId} has invalid evidence references`);
    }
  }
}

function validateCopilotResponse(response: CopilotResponse): void {
  const evidenceIds = new Set(response.evidence.map((item) => item.id));
  for (const claim of response.answer.narrative) {
    if (!claim.evidenceIds.length || claim.evidenceIds.some((id) => !evidenceIds.has(id))) {
      throw new Error("Copilot response contains an uncited or invalid claim");
    }
  }
}

export class WorkflowOrchestrator {
  private readonly workoutGraph;
  private readonly copilotGraph;

  constructor(
    private readonly repositories: RuntimeRepositories,
    private readonly graphProvider: ActiveGraphProvider,
    gateway: StructuredModelGateway,
    config: AppConfig,
    checkpointer: BaseCheckpointSaver,
  ) {
    this.workoutGraph = new StateGraph(WorkoutWorkflowState)
      .addNode("load_context", async (state) => {
        const [memberGraph, exercises] = await Promise.all([
          graphProvider.forMember(state.request.memberId),
          repositories.data.getExercises(),
        ]);
        if (!exercises.length) throw new Error("No exercise seed data is available");
        return { graphVersionId: memberGraph.versionId };
      })
      .addNode("parse_resolve_traverse_construct_phrase", async (state) => {
        const [member, exercises, memberGraph] = await Promise.all([
          repositories.data.getMember(state.request.memberId),
          repositories.data.getExercises(),
          graphProvider.forMember(state.request.memberId),
        ]);
        if (!member) throw new MemberNotFoundError(state.request.memberId);
        const service = new WorkoutService(exercises, member, memberGraph.graph, gateway, config, repositories.plans);
        return { response: await service.generate(state.request) };
      })
      .addNode("validate", (state) => {
        if (!state.response) throw new Error("Workout workflow produced no response");
        validateWorkoutResponse(state.response);
        return {};
      })
      .addNode("persist", async (state) => {
        if (!state.response || !state.graphVersionId) throw new Error("Workout workflow is missing persistence state");
        if (state.response.plan) {
          const stored = await repositories.plans.get(state.response.plan.id);
          if (!stored) throw new Error(`Workout intent for ${state.response.plan.id} was not retained`);
          await repositories.workflows.saveWorkout({
            workflowRunId: state.workflowRunId,
            graphVersionId: state.graphVersionId,
            response: state.response,
            intent: stored.intent,
          });
        }
        await repositories.workflows.complete(state.workflowRunId, state.response);
        return {};
      })
      .addEdge(START, "load_context")
      .addEdge("load_context", "parse_resolve_traverse_construct_phrase")
      .addEdge("parse_resolve_traverse_construct_phrase", "validate")
      .addEdge("validate", "persist")
      .addEdge("persist", END)
      .compile({ checkpointer });

    this.copilotGraph = new StateGraph(CopilotWorkflowState)
      .addNode("load_member_and_conversation", async (state) => {
        const memberGraph = await graphProvider.forMember(state.request.memberId);
        return { graphVersionId: memberGraph.versionId };
      })
      .addNode("route_retrieve_calculate_phrase", async (state) => {
        const member = await repositories.data.getMember(state.request.memberId);
        if (!member) throw new MemberNotFoundError(state.request.memberId);
        const service = new CopilotService(member, gateway, config, repositories.conversations);
        return { response: await service.query(state.request) };
      })
      .addNode("validate", (state) => {
        if (!state.response) throw new Error("Copilot workflow produced no response");
        validateCopilotResponse(state.response);
        return {};
      })
      .addNode("persist", async (state) => {
        if (!state.response) throw new Error("Copilot workflow is missing persistence state");
        await repositories.workflows.complete(state.workflowRunId, state.response);
        return {};
      })
      .addEdge(START, "load_member_and_conversation")
      .addEdge("load_member_and_conversation", "route_retrieve_calculate_phrase")
      .addEdge("route_retrieve_calculate_phrase", "validate")
      .addEdge("validate", "persist")
      .addEdge("persist", END)
      .compile({ checkpointer });
  }

  async generateWorkout(request: WorkoutRequest): Promise<WorkoutResponse> {
    const workflowRunId = `workout_run_${randomUUID()}`;
    const active = await this.graphProvider.forMember(request.memberId);
    await this.repositories.workflows.start({
      id: workflowRunId,
      kind: "workout",
      memberId: request.memberId,
      graphVersionId: active.versionId,
      payload: request,
    });
    try {
      const state = await this.workoutGraph.invoke(
        { request, workflowRunId },
        { configurable: { thread_id: workflowRunId, checkpoint_ns: "workout" } },
      );
      if (!state.response) throw new Error("Workout workflow completed without a response");
      return state.response;
    } catch (error) {
      await this.repositories.workflows.fail(workflowRunId, error instanceof Error ? error.message : "Unknown workout workflow error");
      throw error;
    }
  }

  async queryCopilot(request: CopilotRequest): Promise<CopilotResponse> {
    const conversationId = request.conversationId ?? `conversation_${randomUUID()}`;
    const normalizedRequest = { ...request, conversationId };
    const workflowRunId = `copilot_run_${randomUUID()}`;
    const active = await this.graphProvider.forMember(request.memberId);
    await this.repositories.workflows.start({
      id: workflowRunId,
      kind: "copilot",
      memberId: request.memberId,
      conversationId,
      graphVersionId: active.versionId,
      payload: normalizedRequest,
    });
    try {
      const state = await this.copilotGraph.invoke(
        { request: normalizedRequest, workflowRunId },
        { configurable: { thread_id: conversationId, checkpoint_ns: "copilot" } },
      );
      if (!state.response) throw new Error("Copilot workflow completed without a response");
      return state.response;
    } catch (error) {
      await this.repositories.workflows.fail(workflowRunId, error instanceof Error ? error.message : "Unknown Copilot workflow error");
      throw error;
    }
  }
}
