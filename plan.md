# Candidate Assessment Implementation Plan

## Goal

Build a small, practical, graph-backed fitness coaching dashboard with two product surfaces:

1. **Workout Generator** — generate a safe, structured workout from a coach request and member context.
2. **Coach AI Copilot** — answer grounded questions about a member and surface useful summaries/charts.

Core architectural principle:

> **LLMs interpret and communicate; the knowledge graph plus deterministic rules provide domain truth, safety constraints, and evidence.**

The implementation should be intentionally small, explainable, and use-case driven rather than attempting to model the fitness/medical world exhaustively.

---

## Product Shape

Use **one dashboard with two clearly separated surfaces**, not one generic chat interface.

### A. Workout Generator

A dedicated workout-generation surface.

Inputs:

- natural-language coach request
- selected member
- time window / workout duration
- relevant constraints already present in member data

Example:

> Create a 30-minute lower-body workout for this member.

Return a **structured workout**, not only prose. A useful structure could include:

- warmup
- main work
- cooldown
- exercises
- sets / reps / duration
- rest
- safety notes
- evidence / explanation for important choices

### B. Coach AI Copilot

A separate conversational surface for querying member context.

Example questions:

- How has this member's adherence been trending?
- What should I know before coaching this member today?
- What injuries or constraints should I keep in mind?
- What has changed recently?
- Summarize the member's recent training history.

The Copilot should answer from actual member data rather than inventing details. Render charts when the question is naturally quantitative and the supplied data supports one.

Both surfaces should share the same underlying member model, graph, retrieval logic, and provenance/evidence system.

---

## High-Level Architecture

Use an **in-memory knowledge graph for the MVP**. Do not add a graph database unless the existing project scaffolding clearly makes that the simplest option.

Normal Workout Generator flow:

1. User submits a natural-language request.
2. **LLM call #1: intent parsing**
   - convert the request into validated structured intent
   - identify focus, duration, equipment constraints, relevant member constraints, etc.
3. Deterministic code queries the graph and member data.
4. Deterministic safety/rule logic filters or penalizes candidate exercises.
5. Remaining candidates are ranked / assembled into a workout.
6. Build a structured **evidence trace** for important recommendations and exclusions.
7. **LLM call #2: response phrasing**
   - turn the grounded structured result into useful coach-facing language
   - do not invent facts or override safety decisions
8. UI renders the structured workout plus explanations/evidence.

For the MVP, the normal Workout Generator path should use **exactly two model calls**:

- one to understand the request
- one to phrase the grounded result

A third validator/judge model call is optional later, but unnecessary for the MVP.

---

## Role of the LLM

The LLM is **not the source of truth for exercise safety or graph relationships**.

### At the beginning

Translate messy coach language into structured intent.

Example:

> "Give her a short leg day, go easy on the knee, and use dumbbells."

might become conceptually:

```json
{
  "duration_minutes": 30,
  "focus": "lower_body",
  "equipment": ["dumbbell"],
  "safety_focus": ["knee"]
}
```

### At the end

Phrase the already-grounded result naturally for the coach.

The final model must not:

- invent graph facts
- silently override contraindications
- reintroduce an exercise that deterministic filtering removed
- fabricate member facts
- fabricate evidence

---

## Knowledge Graph Strategy

Build a **small, hand-rolled knowledge graph** inspired by the ontologies/resources named in the assessment.

Do **not** attempt to fully ingest or reproduce those ontologies.

Guiding principle:

> Start with the smallest graph that supports the required product behavior. Add structure only when a concrete use case requires it.

---

## Initial Node Types

Keep the first version intentionally small.

### `Exercise`

A canonical exercise.

Examples: back squat, split squat, Romanian deadlift, dumbbell bench press.

### `Anatomy`

A shared anatomy type for the MVP.

Distinguish muscle, joint, or body region using a subtype/property unless separate node types become necessary later.

Examples:

- quadriceps — muscle
- hamstrings — muscle
- knee — joint
- shoulder — joint

### `Equipment`

Examples: dumbbell, barbell, bench, cable machine.

### `MovementPattern`

Examples: squat, hinge, push, pull, lunge.

### `InjuryOrCondition`

A first-class node when a condition matters to safety reasoning.

Examples: knee pain, shoulder injury, low-back limitation.

### `Member`

Represents the coached person.

### `MemberFact`

A flexible catch-all for member-specific information that does not initially deserve its own first-class node type.

Examples:

- goals
- preferences
- adherence
- biomarkers
- coach notes
- messages
- risk signals
- recent observations

Possible fields:

- `kind`
- `value`
- `timestamp`
- `source`

Example:

```text
Member
  --has_fact-->
MemberFact {
  kind: "goal",
  value: "pain-free squat"
}
```

---

## MemberFact Design

`MemberFact` is deliberately flexible, but it is **not necessarily a terminal node**.

A fact can link back into canonical concepts in the graph.

Example:

```text
Member
  --has_fact-->
Goal("pain-free squat")
  --references-->
MovementPattern("squat")
```

This lets the system retrieve related member context without creating a separate node type for every possible fact category.

If a category of member facts later requires its own behavior or structure, promote it into a first-class node type.

---

## Relationship Model

Do not add edges merely because two concepts seem vaguely associated. Every relationship should have clear semantics.

Think about relationships in **three layers**.

### 1. Soft / Reference Relationships

Used for association and retrieval.

Examples:

- `references`
- `about`

Meaning roughly:

> This fact or concept concerns this other concept.

These links are useful for retrieval but should **not independently drive safety filtering**.

Example:

```text
Goal("pain-free squat")
  --references-->
MovementPattern("squat")
```

### 2. Factual Domain Relationships

Concrete facts about the fitness domain.

Examples:

- `targets`
- `stresses`
- `requires`
- `uses_movement_pattern`

Examples:

```text
Exercise("Back Squat")
  --targets-->
Anatomy("Quadriceps")

Exercise("Back Squat")
  --stresses-->
Anatomy("Knee")

Exercise("Goblet Squat")
  --requires-->
Equipment("Dumbbell")

Exercise("Back Squat")
  --uses_movement_pattern-->
MovementPattern("Squat")
```

These describe known domain structure.

### 3. Safety / Decision Rules

Explicit rules that affect recommendation or exclusion.

Examples:

- `contraindicates`
- `affects`
- deterministic rules derived from member facts plus factual graph edges

Example:

```text
InjuryOrCondition("Knee Pain")
  --affects-->
Anatomy("Knee")
```

Then deterministic logic can reason:

```text
Member has Knee Pain
Knee Pain affects Knee
Back Squat stresses Knee
=> Back Squat receives a safety penalty or is excluded
```

Important distinction:

- soft references help us **find relevant information**
- factual edges tell us **what is true about the domain**
- safety rules tell us **what to do about it**

---

## Safety Behavior

Safety should be **conservative and deterministic** for the MVP.

The model can surface or explain safety decisions, but deterministic code should own them.

Prefer explicit, inspectable rules over hidden heuristics.

Examples:

- exclude exercises that directly conflict with a known contraindication
- penalize exercises that strongly stress affected anatomy
- respect equipment constraints
- respect explicit member limitations
- never let final LLM phrasing reintroduce an exercise removed by deterministic filtering

Where uncertainty exists, preserve the uncertainty rather than presenting medical certainty.

---

## Evidence / Provenance

Every important recommendation, exclusion, or safety note should be able to return a **structured evidence trace**.

This is a product feature, not only debugging metadata.

Do not rely on final LLM prose as the only explanation.

Example recommendation:

```json
{
  "exercise": "Split Squat",
  "decision": "recommended",
  "evidence": [
    {
      "type": "member_fact",
      "fact": "Goal: improve lower-body strength"
    },
    {
      "type": "domain_edge",
      "fact": "Split Squat targets quadriceps"
    }
  ]
}
```

Example exclusion:

```json
{
  "exercise": "Heavy Back Squat",
  "decision": "excluded",
  "evidence": [
    {
      "type": "member_condition",
      "fact": "Member has knee discomfort"
    },
    {
      "type": "domain_edge",
      "fact": "Back Squat stresses knee"
    },
    {
      "type": "safety_rule",
      "fact": "Avoid high knee-loading exercises when the current knee constraint is active"
    }
  ]
}
```

### UI Treatment

Expose evidence as lightweight citation-like markers or expandable `Why?` details.

Example:

> **Split Squat — recommended**
> Good lower-body option given the current constraints. `[Why?]`

Expanding `Why?` should reveal the relevant member facts, graph relationships, and rules.

These are not academic citations. They are **provenance links into our own data and graph**.

The goal is to make recommendations:

- transparent
- auditable
- debuggable
- trustworthy

---

## External Ontologies / Standards

Use the assessment's referenced resources as inspiration, not as requirements to fully implement.

### OPE

Ontology of Physical Exercises. Useful inspiration for exercise-domain concepts.

### SNOMED CT

Large clinical terminology system. Useful inspiration for normalizing injury/medical terminology where appropriate.

Do not import it wholesale.

### SKOS

Semantic Web standard for concept schemes and mappings. Useful inspiration for soft conceptual/reference links and canonical terminology.

### SHACL

Semantic Web standard for graph constraints and validation. Useful inspiration for explicit constraints and validation rules.

**Important:** SKOS and SHACL are not an official paired "soft edge vs hard edge" system. We are only borrowing useful ideas from each.

### PROV-O

Provenance ontology. Useful inspiration for tracking where facts and recommendation evidence came from.

Again, do not implement it wholesale.

---

## Fit With the Provided Data

The supplied exercise/member data appears compatible with this minimal graph.

Exercise-side data maps naturally to:

- exercises
- muscle groups
- joints / body regions
- movement patterns
- equipment

Member-side data can initially be represented using:

- `Member`
- first-class `InjuryOrCondition` nodes when relevant to safety
- `MemberFact` nodes for goals, preferences, adherence, biomarkers, messages, notes, risk signals, etc.

Some graph relationships and safety rules will need to be **derived or added manually**, because the raw JSON will not necessarily encode every useful domain relationship directly.

That is acceptable; document those modeling decisions.

---

## Workout Generator MVP Pipeline

Implement one complete vertical slice first.

### Step 1 — Load Data

Load the supplied JSON data into typed internal structures.

### Step 2 — Normalize Concepts

Convert important strings into canonical nodes.

Examples:

- `DB` / `dumbbells` → `Equipment("Dumbbell")`
- equivalent movement/exercise names → canonical concepts where practical

Do not overbuild entity resolution.

### Step 3 — Build Graph

Create the minimal nodes and factual relationships required by the supplied data.

### Step 4 — Attach Member Context

Represent member-specific context using:

- injury/condition nodes
- member facts
- references from relevant facts to canonical graph concepts

### Step 5 — Parse Workout Request

Use LLM call #1 to produce structured intent.

The parser should return a validated schema rather than free-form prose.

### Step 6 — Retrieve Candidates

Use the structured intent and graph to identify candidate exercises.

### Step 7 — Apply Safety / Constraint Rules

Deterministically filter or penalize candidates.

### Step 8 — Rank / Assemble Workout

Create a structured workout from remaining exercises.

Keep ranking simple and explainable.

### Step 9 — Produce Evidence Trace

For each important selection/exclusion, preserve the graph facts and member facts that caused the decision.

### Step 10 — Phrase Response

Use LLM call #2 to turn the structured result into concise coach-facing language.

The model receives the structured result and evidence; it does not independently redo recommendation logic.

### Step 11 — Render

Show:

- structured workout
- safety notes
- concise explanation
- expandable evidence / `Why?` details

---

## Coach Copilot MVP Pipeline

The Copilot shares the same member facts, graph concepts, and provenance system.

Basic flow:

1. Coach asks a question.
2. Parse/classify what member information is needed.
3. Retrieve relevant member facts and graph-linked context.
4. Compute deterministic summaries when appropriate.
5. Return a grounded answer.
6. Include evidence/provenance for important claims.
7. Render a chart when the question is naturally quantitative and data supports it.

The Copilot does not need to use the exact same two-call pipeline as Workout Generator if a simpler retrieval path is sufficient, but it should follow the same grounding rule:

> **No unsupported member claims.**

---

## Acceptance Test / North Star

Implement **one complete, explainable scenario** before expanding breadth.

Choose one member from the supplied data with meaningful constraints.

Example shape:

> Given Member X and a request for a 30-minute lower-body workout, the system returns a structured workout that respects the member's known limitations and available equipment, and every safety-sensitive choice has an evidence trace.

Acceptance criteria:

- request is parsed into structured intent
- graph is queried
- unsafe/incompatible exercises are filtered or penalized
- output respects duration, equipment, and requested focus
- final workout is structured
- important decisions contain evidence
- LLM-generated prose does not contradict the structured result

Add more tests only after this vertical slice works.

---

## Implementation Priorities

Prioritize:

1. correctness
2. explainability
3. safety
4. a complete end-to-end flow
5. simple, polished UI
6. breadth

Avoid spending too much time on:

- exhaustive ontology modeling
- graph database infrastructure
- complicated ranking algorithms
- multi-agent architectures
- excessive model calls
- automatic ingestion of giant external ontologies
- premature abstraction

---

## Suggested Internal Graph Shape

A simple representation is enough:

```text
Node {
  id
  type
  properties
}

Edge {
  source
  target
  type
  properties?
}
```

A lightweight adjacency map or small graph library is fine. Keep traversal code straightforward and testable.

---

## Explainability Rule

For any proposed decision, we should be able to answer:

> Why did the system do this?

The answer should reduce to some combination of:

- the coach's request
- member facts
- graph facts
- explicit deterministic rules

Not:

> Because the language model thought it sounded good.

---

## Ontology Design Test

For every proposed node or edge type, ask:

> What product behavior becomes easier, safer, or more explainable because this exists?

If there is no good answer yet, leave it out of the MVP.

---

## Codex Execution Guidance

Codex should implement the system **end-to-end rather than building isolated infrastructure first**.

Recommended order:

1. inspect the existing repo and supplied data
2. preserve existing project conventions where reasonable
3. create typed data models
4. implement the minimal in-memory graph
5. encode a small set of explicit domain/safety relationships
6. implement the Workout Generator request-parser schema
7. implement deterministic retrieval/filtering/ranking
8. add structured evidence traces
9. implement final response phrasing
10. build the Workout Generator UI
11. build the Coach Copilot UI
12. add one strong end-to-end acceptance test
13. add focused unit tests around graph traversal and safety rules
14. document assumptions and ontology choices in the README

When the assessment is ambiguous, prefer the **simplest implementation that demonstrates clear reasoning and a complete working product**.

Do not silently invent additional product requirements.

---

## Current Decisions Summary

These are the decisions intentionally made so far:

- one dashboard, two distinct surfaces
- Workout Generator is structured/form-like, not just another generic chat box
- Coach AI Copilot is conversational
- both surfaces share the same graph/member-context backend
- use a small hand-rolled graph
- use an in-memory graph for the MVP
- keep node types minimal
- use `MemberFact` as a flexible catch-all for long-tail member information
- allow `MemberFact` nodes to reference canonical graph concepts
- separate soft reference relationships from factual domain relationships
- keep explicit safety/decision logic conceptually separate from both
- do not add vague edges "just in case"
- deterministic code owns safety and filtering
- use the LLM to parse intent and phrase results, not as the safety source of truth
- normal Workout Generator flow uses two LLM calls
- every important recommendation/exclusion should preserve structured evidence
- UI should expose that evidence with lightweight citation-like / expandable details
- start with one strong vertical-slice acceptance test
- expand the ontology only when a concrete product behavior requires it
