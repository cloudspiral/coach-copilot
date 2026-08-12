# Coach Copilot

Coach Copilot is a coach-facing dashboard for generating safe, personalized,
explainable workouts and retrieving a member's longitudinal context through an
AI copilot.

This repository is an independent implementation of Future's AI Engineering
take-home. The core product constraint is that workout safety decisions must be
enforced deterministically through knowledge-graph traversal rather than left
to an LLM prompt.

## Status

The repository is currently bootstrapped with the pinned assignment
specification and its two supplied synthetic datasets. Architecture, stack,
local development instructions, evaluation evidence, and implementation
trade-offs will be documented here as the system is built.

## Assignment materials

- Full specification: [`docs/assignment/ASSESSMENT.md`](docs/assignment/ASSESSMENT.md)
- Exercise catalog: [`data/exercises.json`](data/exercises.json)
- Synthetic member context: [`data/member-context.json`](data/member-context.json)
- Source and pinned revision: [`docs/assignment/SOURCE.md`](docs/assignment/SOURCE.md)

The supplied data is synthetic. This project must not use real member data or
protected health information.

## Product surfaces

The completed dashboard will contain two connected surfaces:

1. **Workout Generator** — resolves coach requests to canonical graph concepts,
   deterministically applies injury and equipment constraints, and returns a
   structured workout with a provenance trace.
2. **Coach AI Copilot** — retrieves member-specific context such as adherence,
   sleep, prior conversations, morning tasks, and churn signals without
   inventing unsupported facts.

## Development

Setup and run instructions will be added after the architecture and technology
choices are finalized.
