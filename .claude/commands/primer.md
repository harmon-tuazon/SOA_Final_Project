# Prime Context for Claude Code

## 🎯 Primary Context Loading Sequence

This primer loads the complete context for the AWS microservices project. Execute it at the start of each Claude Code session to understand project state and continue development.

### Phase 1: Framework Understanding

1. **Core Documentation**
   - List the project structure (files and folders, excluding `node_modules`/`.git`).
   - Read `CLAUDE.md` for the architecture, conventions, and agent roles.
   - Read `PROJECT REQUIREMENTS.md` (the authoritative source spec) for the project's goal and rubric.
   - Skim `.claude/rules/` (documentation + action-plan) and `.claude/agents/` to know the rules and who does what.
   - Read `docs/README.md` and skim `docs/` if it exists yet.

### Phase 2: Status Report

1. **Explain Back to Me the Following**
   - Project structure
   - Project purpose and goals
   - Key files and their purposes
   - Any important dependencies
   - Any important configuration files
