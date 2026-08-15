# Coach Copilot

Coach Copilot is a local MVP for safe, explainable workout generation and evidence-grounded member intelligence. The React/Vite dashboard talks to an Express API backed by PostgreSQL, Drizzle repositories, LangGraph `StateGraph` workflows, shared Zod contracts, and the direct OpenAI Responses API.

The design rule is simple: the model interprets and phrases; deterministic code owns safety, graph traversal, equipment selection, calculations, citations, charts, persistence, and final validation.

See [architecture.md](architecture.md) for the system diagrams, table ownership, graph versioning, ingestion lifecycle, workflow/checkpoint boundary, safety invariants, recovery behavior, and the threshold for considering Neo4j.

## Local setup

Requirements: Node.js 22+, Docker, and npm. An OpenAI key is optional unless live mode is required. No LangGraph, LangChain, or LangSmith account or key is needed.

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run db:start
npm run db:setup
npm run dev
```

Open <http://127.0.0.1:5173>, click **Continue as Sam**, and choose either product surface. The API listens at <http://127.0.0.1:3001>.

`db:setup` applies Drizzle migrations, validates and ingests the supplied JSON fixtures into typed tables plus an immutable graph version, and initializes LangGraph checkpoint tables in a separate `langgraph` schema. Production startup never creates tables, loads JSON, or silently falls back when PostgreSQL is unavailable.

Set `OPENAI_API_KEY` in `.env` for live responses. Without it, the app remains usable in visibly labeled deterministic-fallback mode. With `REQUIRE_LIVE_MODEL=true`, fallback, refusal, timeout, schema failure, and incorrect model-call count are hard failures. Provider requests use `store: false`; `.env` is ignored by Git.

Health endpoints:

- `GET /api/health` preserves the lightweight key/model/graph contract.
- `GET /api/ready` verifies PostgreSQL, migrations, seed/catalog data, the active graph version, and LangGraph checkpoint readiness; it returns `503` if production dependencies are incomplete.

## Railway deployment

Production is deployed from the GitHub `main` branch to Railway. The web service builds the Vite client and Express server, runs `npm run db:setup` as its pre-deploy command, and starts only after Drizzle migrations, idempotent seed ingestion, and LangGraph checkpoint setup succeed. Railway PostgreSQL supplies `DATABASE_URL`; `/api/ready` is the deployment health check. The server listens on Railway's injected `PORT` and all interfaces while API keys remain server-only environment variables.

The committed `railway.json` is the deployment contract. Railway source deployments should use the `coach-copilot` service and a separate PostgreSQL service in the same production environment.

## Product surfaces

- **Workout Generator:** graph-recomputed plans and adjustments, warmup/main/cooldown phases, equipment and injury constraints, safety notes, exclusions, and expandable provenance.
- **Coach AI Copilot:** quick prompts, free-form questions, persisted multi-turn context, model-selected topics for broad requests, deterministic charts, attachment metadata, unavailable-data handling, and sentence-level citations.

Both successful live workflows make exactly two model calls: structured intent, then constrained phrasing. LangGraph sequences load, execution, validation, and persistence nodes; it does not provide agents or model-controlled tools.

## Persistence model

PostgreSQL is canonical for:

- organizations, coaches, members, goals, preferences, equipment, and conditions;
- workouts, adherence, biometrics, labs, conversations, messages, attachments, briefs, and risk assessments;
- generated plans, decisions, evidence, workflow runs, and model-call traces;
- raw ingestion lineage and immutable `graph_versions`, `graph_nodes`, and `graph_edges`.

`graph_nodes` are the entity/concept nodes and `graph_edges` are their relationships. Composite foreign keys prevent an edge from pointing outside its graph version. Only one validated version may be active.

The active domain graph—exercise, anatomy, equipment, and movement concepts—is reconstructed from PostgreSQL at startup and cached. Typed rows for the requested member are composed into a request-local member overlay. The active version is checked on a 30-second TTL and swapped atomically when a new validated version appears.

The supplied fictional JSON remains in `data/` only as seed/test input. The current seed creates 149 domain nodes and 407 domain edges; composing Jordan's member overlay produces the existing 160-node, 418-edge request graph.

Canonical conversations and generated plans are stored in application tables, so follow-ups and base-plan adjustments survive restarts. LangGraph checkpoints are separate execution state and are never treated as the member database or knowledge graph.

## Safety and grounding

For the supplied recovering knee condition, deterministic code:

1. Traverses condition → patellofemoral area → knee.
2. Removes knee-loading plyometrics and reviewed deep loaded knee flexion.
3. Down-ranks rather than blanket-removes ordinary knee-loading strength work.
4. Adds a shallow, symptom-free-range instruction and safety evidence.
5. Intersects every selected exercise with the member's available/requested equipment.

Unknown anatomy returns `needs_clarification` and no plan. Every workout prescription must reference included evidence. Copilot retrieval, calculations, charts, and citation validation remain deterministic. Blood pressure is reported unavailable; vitamin D is reported as supplied without diagnosing deficiency because no reference range is present.

This is coaching support over synthetic data, not medical advice. Real member/PHI use requires authentication, authorization, tenant RLS, audit/retention policy, encryption controls, and a vendor/privacy review; those are outside this refactor.

## Database commands

| Command | Purpose |
| --- | --- |
| `npm run db:start` | Start PostgreSQL 17 on `127.0.0.1:5434` |
| `npm run db:stop` | Stop the local PostgreSQL container without deleting its volume |
| `npm run db:migrate` | Apply Drizzle application migrations |
| `npm run db:seed` | Validate and idempotently ingest JSON fixtures by SHA-256 hash |
| `npm run db:langgraph:setup` | Explicitly initialize the `langgraph` checkpoint schema |
| `npm run db:setup` | Run migrate, seed, and checkpoint setup in order |
| `npm run db:test:setup` | Destructively reset only `TEST_DATABASE_URL`; refuses names without `_test` suffix |

The default development URLs are documented in `.env.example`. `coach_copilot_test` is physically separate from the development database.

## Verification commands

| Command | Purpose |
| --- | --- |
| `npm run lint` | Lint application, scripts, evaluations, and tests |
| `npm run typecheck` | Check client, server, scripts, evaluations, and tests |
| `npm test` | Unit/API tests using in-memory repositories and `MemorySaver` |
| `npm run test:evals` | Controlled semantic matrix and follow-up coverage |
| `npm run test:quality` | 32 natural workout/Copilot interactions through the local API, PostgreSQL, LangGraph, and a controlled model gateway |
| `npm run test:db` | Guarded PostgreSQL reset plus migration, ingestion, integrity, persistence, restart, and checkpoint tests |
| `npm run test:e2e` | Offline Playwright browser flows |
| `npm run build` | Production client and server build |
| `npm run verify:offline` | Static, unit/API, controlled eval, database, build, and offline browser gates |
| `npm run test:live` | Full unretried matrix using the real key |
| `npm run test:quality:live` | Natural-language live quality audit |
| `npm run test:e2e:live` | Live Playwright flows |
| `npm run verify` | Offline gate followed by all live gates |

Live commands require both PostgreSQL setup and `OPENAI_API_KEY`. They write ignored evidence under `artifacts/`.

## Evaluation status

The current post-persistence verification passes 32/32 natural conversation interactions, 20/20 unit/API tests, 47/47 controlled semantic cases, 4/4 PostgreSQL integration tests, and 6/6 offline browser tests, plus lint, typecheck, and the production build. The 32 interactions include 14 Workout Generator turns, 18 Coach Copilot turns, and nine context-dependent follow-ups; every selected exercise and every Copilot narrative sentence has valid evidence references.

The prior live-model evidence remains documented in [docs/EVALUATION.md](docs/EVALUATION.md). A current live provider/browser rerun is separate from the controlled gate and is not implied by these results.

## Sources and scope

- [Assessment](docs/assignment/ASSESSMENT.md)
- [Pinned upstream source](docs/assignment/SOURCE.md)
- [Exercise seed](data/exercises.json)
- [Synthetic member seed](data/member-context.json)
- [Implementation plan](plan.md)

Neo4j, LangChain agents, LangSmith tracing, authentication, real member ingestion, vector search, and object storage are intentionally deferred. Railway hosts the demo application and PostgreSQL, while PostgreSQL remains the canonical application and graph store.
