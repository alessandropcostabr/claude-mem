---
name: mem-search
description: Search claude-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search

Search past work across all sessions. The read workflow depends on the active
claude-mem runtime; PostgreSQL/server-beta uses UUID-backed tools, while the
legacy worker uses numeric observation IDs.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## Select the Runtime Workflow First

Use the runtime identified by the claude-mem MCP `__IMPORTANT` guidance or the
session configuration. Do not probe the worker-only tools first when the active
runtime is `server-beta`.

### Server-beta Runtime (PostgreSQL / UUIDs)

Use `observation_search` to filter results. It already returns complete
PostgreSQL observation records, so their UUIDs must **not** be passed to
`timeline` or `get_observations`.

```
observation_search(query="authentication", limit=20)
```

When a ready-to-inject context block is more useful than individual records,
use:

```
observation_context(query="authentication", limit=10)
```

Both tools accept an optional `projectId`. Filter the returned observations in
the response; no numeric-ID fetch step is required.

### Worker Runtime (SQLite / Numeric IDs)

Use the 3-layer workflow below only in the worker runtime.

## Worker 3-Layer Workflow (ALWAYS Follow in Worker Runtime)

**NEVER fetch full details without filtering first. 10x token savings.**

### Step 1: Search - Get Index with IDs

Use the worker-only `search` MCP tool:

```
search(query="authentication", limit=20, project="my-project")
```

**Returns:** Table with IDs, timestamps, types, titles (~50-100 tokens/result)

```
| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #11131 | 3:48 PM | 🟣 | Added JWT authentication | ~75 |
| #10942 | 2:15 PM | 🔴 | Fixed auth token expiration | ~50 |
```

**Parameters:**

- `query` (string) - Search term
- `limit` (number) - Max results, default 20, max 100
- `project` (string) - Project name filter
- `type` (string, optional) - "observations", "sessions", or "prompts"
- `obs_type` (string, optional) - Comma-separated: bugfix, feature, decision, discovery, change
- `dateStart` (string, optional) - YYYY-MM-DD or epoch ms
- `dateEnd` (string, optional) - YYYY-MM-DD or epoch ms
- `offset` (number, optional) - Skip N results
- `orderBy` (string, optional) - "date_desc" (default), "date_asc", "relevance"

### Step 2: Timeline - Get Context Around Interesting Results

Use the worker-only `timeline` MCP tool:

```
timeline(anchor=11131, depth_before=3, depth_after=3, project="my-project")
```

Or find anchor automatically from query:

```
timeline(query="authentication", depth_before=3, depth_after=3, project="my-project")
```

**Returns:** `depth_before + 1 + depth_after` items in chronological order with observations, sessions, and prompts interleaved around the anchor.

**Parameters:**

- `anchor` (number, optional) - Observation ID to center around
- `query` (string, optional) - Find anchor automatically if anchor not provided
- `depth_before` (number, optional) - Items before anchor, default 5, max 20
- `depth_after` (number, optional) - Items after anchor, default 5, max 20
- `project` (string) - Project name filter

### Step 3: Fetch - Get Full Details ONLY for Filtered IDs

Review titles from Step 1 and context from Step 2. Pick relevant IDs. Discard the rest.

Use the worker-only `get_observations` MCP tool:

```
get_observations(ids=[11131, 10942])
```

**ALWAYS use `get_observations` for 2+ observations - single request vs N requests.**

**Parameters:**

- `ids` (array of numbers, required) - Observation IDs to fetch
- `orderBy` (string, optional) - "date_desc" (default), "date_asc"
- `limit` (number, optional) - Max observations to return
- `project` (string, optional) - Project name filter

**Returns:** Complete observation objects with title, subtitle, narrative, facts, concepts, files (~500-1000 tokens each)

## Examples

**Server-beta search with complete UUID-backed records:**

```
observation_search(query="bug", limit=20)
```

**Server-beta pre-joined context:**

```
observation_context(query="authentication", limit=10)
```

The remaining examples are for the worker runtime.

**Find recent bug fixes:**

```
search(query="bug", type="observations", obs_type="bugfix", limit=20, project="my-project")
```

**Find what happened last week:**

```
search(type="observations", dateStart="2025-11-11", limit=20, project="my-project")
```

**Understand context around a discovery:**

```
timeline(anchor=11131, depth_before=5, depth_after=5, project="my-project")
```

**Batch fetch details:**

```
get_observations(ids=[11131, 10942, 10855], orderBy="date_desc")
```

## Why the Worker Workflow Has Three Layers

- **Search index:** ~50-100 tokens per result
- **Full observation:** ~500-1000 tokens each
- **Batch fetch:** 1 HTTP request vs N individual requests
- **10x token savings** by filtering before fetching

Server-beta deliberately differs: `observation_search` returns complete records
in one UUID-backed response. Keep its `limit` focused, or request the compact
pre-joined block from `observation_context`.

## Knowledge Agents

Want synthesized answers instead of raw records? Use `/knowledge-agent` to build a queryable corpus from your observation history. The knowledge agent reads all matching observations and answers questions conversationally.
