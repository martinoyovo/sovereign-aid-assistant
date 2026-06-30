# Sovereign AI: An Offline Assistant for the Data NGOs Can't Afford to Lose

When a caseworker at a humanitarian NGO asks "which families haven't received aid in 60 days?", the answer usually depends on someone digging through spreadsheets, paper notes, and institutional memory. The **Sovereign Aid Assistant** is a working demonstration that an AI assistant can answer questions like this directly — without a single byte of confidential case data ever leaving the laptop it runs on.

## The problem with "just use AI"

Most AI assistants today route every question, document, and answer through a cloud API. For an NGO handling case files on displaced families, protection concerns, and vulnerable individuals, that's not a minor inconvenience — it's a dealbreaker. Confidential humanitarian data shouldn't be sitting on a third-party server, subject to someone else's retention policy, jurisdiction, or breach.

The Sovereign Aid Assistant takes the opposite approach: **local-first, fully offline.** A local language model — served by [Ollama](https://ollama.com) on the same machine — answers questions, but it can only get facts by calling tools that read local files. No cloud model, no API key, no telemetry, and after install, the app runs with networking disabled entirely.

## How it actually works

The architecture is deliberately boring in the best way: one Express backend, one local model, and a clean boundary in between.

```
Browser (React) → Express backend → Agent loop → Ollama (local model)
                         ↓
                  MCP client (stdio) → MCP server (7 tools)
                         ↓
                  /data (local JSON + notes)
```

The key design decision is that **the model never touches data directly.** Every fact the assistant states comes through a Model Context Protocol (MCP) tool call — `query_cases`, `search_notes`, `flag_case`, `generate_brief`, and others. The MCP server runs as a genuinely separate process, spoken to over stdio, exactly the way any MCP host (like an IDE) would talk to it. That keeps the boundary honest: there's no shortcut from "language model" to "raw case file" that skips the tool layer.

This matters for two reasons. First, **provenance becomes the product, not an afterthought.** The UI streams each tool call live as the agent works — you watch it search, flag, and write, rather than staring at a spinner — and afterward, every step is clickable, showing exactly what was retrieved. Click a caseId in any answer and you're looking at its source record.

Second, it makes the system **model-agnostic.** Swap `qwen2.5` for `gemma4` from a dropdown, mid-demo, no restart — only the model name sent to Ollama changes. Both produce correct answers, which is the point: there's no vendor lock-in baked into the architecture.

## What it can actually do

The demo walks through three kinds of questions a caseworker would realistically ask:

1. **Structured/compute** — "Which families have not received aid in the last 60 days?" The date arithmetic happens inside the tool, not the model, against a fixed reference date for determinism.
2. **Narrative/read** — "Are there any protection concerns I should know about?" The agent searches field notes, finds the relevant cases, summarizes, and cites caseIds.
3. **Action/multi-step** — "Flag the urgent cases and draft a situation brief." The agent flags cases and writes a real Markdown brief to disk via `generate_brief`.

Caseworkers can also drag in new field reports — text, Markdown, or PDF — directly into the left panel. They're parsed locally and become searchable immediately, with no restart and no network call.

## The hardware story is part of the pitch

This isn't a system that needs a GPU cluster. The two recommended models total about 14 GB on disk; Ollama loads one into RAM at a time and unloads it after idle minutes. It's designed to run on a laptop a field office already owns — $0 in cloud fees, and it keeps working with the network cable physically unplugged. The README even documents how to verify there's no network egress: inspect the built frontend for external URLs, watch DevTools while using it, or just disconnect and run the full demo.

## What it deliberately leaves out

No authentication, no multi-user support, no database, no vector DB. Persistence is in-memory state plus brief files and uploaded reports written to disk. Keyword and structured queries are sufficient and more legible for this purpose — embeddings and semantic search are a natural extension but are explicitly out of scope. This is a reference implementation, not a production case-management system, and it doesn't pretend otherwise.

## Why this is bigger than one demo

The project frames itself as a reference implementation of *sovereign AI as digital public infrastructure* — an open building block any agency or NGO can self-host. That framing matters. As AI tooling gets pitched to humanitarian and public-sector organizations, the default assumption is often "send your data to our API." This project is a concrete counter-example: a fully functional, MIT-licensed system showing that local-first AI is not just theoretically possible but practically usable on hardware these organizations already have.

For an NGO caseworker, the promise isn't "smarter AI" — it's an assistant that does useful work *and* never asks them to trust someone else with the data their clients' safety depends on.
