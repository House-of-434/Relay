# Deferred Register — Scout Research

Items deliberately shifted out of the MVP, with the reason and the trigger
to revisit. Nothing here is forgotten; everything here has a condition.

| Item | Why shifted | Revisit when |
|---|---|---|
| Residential proxy (`BLADE_PROXY`) | Cost + provider choice; VPS results unknown until Bladebro runs there | Reddit/X start returning blocks on the VPS |
| Reddit OAuth connector | Bladebro covers MVP; API is a throughput optimization | Browser fetches become the throughput bottleneck |
| Evidence table (`app.evidence`) | Audit existing `app.*` persistence first | `source_url`-only provenance produces unresolvable citations |
| Embeddings (`companies.embedding`) | One-line enable + migration, but recall UX undecided | Scout visibly re-researches known companies |
| CDP screencast live view | `vision` polling covers MVP cheaper | Someone asks for live view during research |
| Deployment packaging (compose, Tool Layer/BFF containers, `deploy/`) | Dev-only scope; own project | Moving beyond dev-only |
| Full agent-browser excision (`server/browser-*.ts`, UI, packaging) | 45+ files incl. CI fixtures and starter mode; policy-disable holds | Bladebro adapter proven; dedicated removal pass |
| `allowedDomains` egress allowlist | Never implemented; blocks unknown targets (most of research) | Threat model requires it |
| X API (paid read tier) | ~$200/mo; Bladebro reads page API traffic instead | Bladebro X adapter stops working |
| `config.tools` / `disallowedTools` per-bot enforcement | Prompt-only accepted for MVP | Unbounded-egress incident or audit requirement |
| Subagent research pool | Parallel MCP calls cover fan-out; depth-1 cap anyway | Reasoning (not search) needs fan-out |
| Chrome pin in Dockerfile | Adapter accepts `CHROME_PATH` and auto-detects; image still provisions no Chrome | Pin + provision Chrome in the image |
| Deep-research Start/Cancel card UI | Conversational confirmation covers MVP; `create_options_card` is Watcher-locked, new card = new request service | Users ask for buttons, or confirmation needs richer structure |
| Backup/restore routine ownership | Import stamps no owner (pre-owner behavior); exporting owner would let a crafted backup claim another user's workspace | Backup adopt proven ownership with importer verification |
| Remove `RELAY_SHARED_WORKSPACE` flag + Composio remnants | Composio dropped as a third-party dependency, but the flag still gates live behavior (default tool URL, connector prompt suppression, seed path) and the e2e roster boots with `=1`; untangling needs the shared-roster mode defined without it. Our connectors are Google OAuth from outside, not Composio. | Shared-roster mode is defined without Composio; update `relay-agents.e2e.test.ts` to not depend on `=1`; drop the dead prompt |
