---
name: mem-commands
description: Manage claude-mem observations — confirm, deprecate, flag, and view stats. Use when the user wants to manage their memory system, review observation quality, or clean up outdated memories.
---

# Memory Governance

Manage observations in claude-mem's persistent memory database.

## When to Use

- User says "confirm observation #1234" or "this memory is correct"
- User says "forget observation #1234" or "remove this memory"
- User says "flag observation #1234" or "this memory is outdated"
- User says "memory stats" or "how many observations do I have?"

## Commands

### Stats

Get an overview of the memory system:

```
mem_stats()
```

Returns counts of active, deprecated, confirmed, flagged observations, top projects, and feedback totals.

### Confirm

Mark an observation as verified/accurate:

```
mem_confirm(id=1234)
```

Confirmed observations get a small ranking boost in future context injection.

### Forget (Deprecate)

Soft-delete an observation — it stays in the database but is excluded from all searches and context injection:

```
mem_deprecate(id=1234)
```

Use when an observation is outdated, wrong, or no longer relevant.

### Flag

Mark an observation as potentially conflicting or needing review:

```
mem_flag(id=1234)
```

Flagged observations remain active but are marked for future conflict resolution (Phase 9).

### View Observation

To view a specific observation before acting on it, use the `get_observations` MCP tool:

```
get_observations(ids=[1234])
```

## Workflow

1. **Search first** — Use `/mem-search` to find observations by keyword
2. **Review** — Use `get_observations` to read full details
3. **Act** — Confirm, deprecate, or flag as needed
4. **Verify** — Run `mem_stats()` to see updated counts

## Important

- Deprecation is soft delete — the observation is NOT permanently removed
- Only active observations can be confirmed, deprecated, or flagged
- Confirmed observations contribute to the authority score in hybrid retrieval (Phase 8)
