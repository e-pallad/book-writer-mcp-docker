# Book Writer MCP

**Turn your ideas into published books with AI as your writing partner.**

Everyone has a story to tell, a worldview to share, or expertise worth publishing. The gap between having something to say and holding a finished manuscript has always been enormous — months of lonely discipline, structural guesswork, and the constant fear of losing your thread. Book Writer MCP closes that gap.

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (or any MCP-compatible AI) a full suite of book-writing tools. You talk about your book. The AI writes, organizes, tracks, and exports it — while you stay in creative control.

## What This Gives You

- **Start a book in one sentence.** Describe your idea. The AI initializes the project, creates your outline, and begins drafting chapters.
- **Stay consistent across 100,000 words.** A story bible tracks every character, setting, and plot thread. Continuity checking catches contradictions before they become rewrites.
- **Write in your voice.** A style guide captures your tone, POV, tense, influences, and patterns to avoid — so every chapter sounds like *you*, not generic AI.
- **See your book take shape.** A built-in HTML preview renders your manuscript with beautiful book typography — Playfair Display headings, drop caps, justified text, ornamental dividers. The preview server auto-refreshes every 10 seconds; run `book_export_markdown` after editing chapters to update the preview.
- **Export to real formats.** One command compiles your manuscript to clean Markdown or a formatted `.docx` with title page, table of contents, page numbers, and configurable fonts/spacing.
- **Design your cover.** Generate KDP-compliant cover specs with mood, color palettes, typography, and AI image prompts ready for DALL-E, Midjourney, or Stable Diffusion.
- **Build your author profile.** Pull from LinkedIn or write manually — generates polished bios for your back cover and marketing.

## Quick Start

### Install

```bash
git clone https://github.com/e-pallad/book-writer-mcp-docker.git
cd book-writer-mcp-docker
npm install
npm run build
```

### Add to Claude Desktop

Add this to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "book-writer": {
      "command": "node",
      "args": ["/path/to/book-writer-mcp/dist/index.js"],
      "env": {
        "BOOK_PROJECT_DIR": "/path/to/your/book/folder"
      }
    }
  }
}
```

### Add to Claude Code

In your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "book-writer": {
      "command": "node",
      "args": ["/path/to/book-writer-mcp/dist/index.js"],
      "env": {
        "BOOK_PROJECT_DIR": "."
      }
    }
  }
}
```

### Start Writing

Open Claude and say:

> "Initialize a new book called 'The Art of Letting Go' — it's a memoir about leaving corporate life to build something meaningful. Target 50,000 words."

That's it. The AI creates the project structure, and you're writing.

## Remote HTTP Mode (Docker)

The default entry point (`dist/index.js`) speaks stdio, which is what Claude Desktop and Claude Code launch as a local command. Claude.ai and the Claude mobile apps cannot launch local commands — they only talk to **Custom Connectors** over HTTP. For those clients the server ships a second entry point (`dist/http-server.js`) that serves the exact same tools over the MCP Streamable HTTP transport at `POST /mcp`.

Both entry points build the server from the same factory (`src/server.ts`), so there is one implementation of the tools and story bible regardless of transport.

### Run it

```bash
cp .env.example .env
# put a real secret in MCP_AUTH_TOKEN, e.g. openssl rand -hex 32
docker compose up --build
```

Your book lives in `./data` on the host, mounted at `/app/data` in the container and exposed to the server as `BOOK_PROJECT_DIR`. Everything the tools write — `chapters/`, `.book-mcp/`, `manuscript.md`, `manuscript.docx` — lands there and survives a rebuild.

`docker-compose.yml` reads `MCP_AUTH_TOKEN`, `PORT`, `MCP_PUBLIC_URL`, `MCP_OAUTH_PASSPHRASE` and `CLOUDFLARE_TUNNEL_TOKEN` from `.env`. `GET /health` is unauthenticated and returns the session count, which is handy for a proxy or an orchestrator health check.

To run it without Docker:

```bash
npm install && npm run build
MCP_AUTH_TOKEN=your-secret BOOK_PROJECT_DIR=/path/to/book npm run start:http
```

The server refuses to start when `MCP_AUTH_TOKEN` is unset, so it is never exposed without a token.

### Authentication

The server supports two authentication paths at the same time, because Claude's clients do not all support the same one.

| Client | Path |
| --- | --- |
| Claude Code, Claude Desktop | static bearer token (custom header) |
| Claude.ai web, Claude mobile apps | OAuth |

**Static bearer token.** Set `MCP_AUTH_TOKEN` and send it on every request to `/mcp`:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Anything else gets `401`. This is what Claude Code and Claude Desktop use, and it is all you need if those are your only clients. Leave `MCP_PUBLIC_URL` unset and the server runs in this mode alone — no OAuth endpoints are served.

**OAuth (required for Claude.ai and the mobile apps).** The custom connector dialog on claude.ai offers only *OAuth Client ID* and *Client Secret* under Advanced settings — there is no field for a bearer token or an arbitrary header — so a connector added there needs the server to speak OAuth. Set `MCP_PUBLIC_URL` to the public HTTPS origin the container is reachable at and the server additionally acts as an OAuth 2.1 authorization server:

```
MCP_PUBLIC_URL=https://books.example.com
MCP_OAUTH_PASSPHRASE=a-long-random-passphrase   # optional; defaults to MCP_AUTH_TOKEN
```

It then serves the discovery and flow endpoints Claude expects — `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/register` (dynamic client registration), `/authorize`, `/token` and `/revoke` — with PKCE `S256` required and tokens bound to the `/mcp` resource.

There are no user accounts. Claude registers itself as a client, then sends you to a single page that asks for `MCP_OAUTH_PASSPHRASE`; entering it correctly authorizes the connector. That is the same trust model as the bearer token: whoever knows the passphrase owns the book project. Registered clients and issued tokens are stored in `.book-mcp/oauth.json` (mode `0600`, tokens kept only as SHA-256 digests) so a container restart does not disconnect an authorized connector.

To connect: **Settings → Connectors → Add custom connector**, enter `https://your-domain/mcp`, leave the OAuth client fields empty (Claude registers itself), then complete the passphrase prompt Claude opens.

> Several users have reported that claude.ai completes the OAuth flow but then does not attach the access token to `/mcp` requests ([#79](https://github.com/anthropics/claude-ai-mcp/issues/79), [#155](https://github.com/anthropics/claude-ai-mcp/issues/155), [#162](https://github.com/anthropics/claude-ai-mcp/issues/162)). If the connector authorizes but every call comes back `401`, check those issues before debugging your own setup.

### Making it reachable

Claude opens the connection from Anthropic's cloud infrastructure, not from your phone or browser. A container on `localhost` — or anywhere inside your LAN — is therefore not reachable, even if you can open the URL yourself. The endpoint needs a **public HTTPS URL**:

- a reverse proxy (Caddy, nginx, Traefik) on your own domain with a TLS certificate, forwarding to the container port, or
- a tunnel such as Cloudflare Tunnel or ngrok if you do not want to expose a host directly.

Plain HTTP is not accepted, so terminate TLS at the proxy or tunnel. Treat the bearer token as the only thing standing between the internet and your manuscript: use a long random value and rotate it if it leaks.

> **Port note:** `book_preview_server` also defaults to port 3456. If you use the preview server inside the same container, set `PREVIEW_PORT` (or `PORT`) so the two do not collide.

#### Cloudflare Tunnel (recommended for mobile)

`docker-compose.yml` includes an optional `cloudflared` service that gives the container a stable public hostname without opening any inbound ports — useful since the Claude mobile app's connector config points at a fixed URL. Setup happens once, mostly in the Cloudflare dashboard:

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), go to **Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it (e.g. `book-mcp`).
2. Copy the tunnel token shown during setup into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Still in the tunnel's setup, add a **Public Hostname**: your domain/subdomain (e.g. `book-mcp.example.com`), service type `HTTP`, and URL `book-writer-mcp:3456` — that's the compose service name and container-internal port, not `localhost`.
4. `docker compose up -d` — this starts both `book-writer-mcp` and `cloudflared`; the tunnel connects outbound to Cloudflare's edge, so no firewall or router changes are needed.
5. In Claude, add the custom connector at `https://book-mcp.example.com/mcp` with the `Authorization: Bearer <MCP_AUTH_TOKEN>` header, same as any other setup.

The hostname stays stable across restarts and rebuilds, so you only configure the connector once.

## Tools Reference

### Manuscript (core workflow)

| Tool | What it does |
|------|-------------|
| `book_init` | Initialize a new book project |
| `book_chapter_create` | Create a new chapter |
| `book_chapter_read` | Read a chapter's content and metadata |
| `book_chapter_update` | Update a chapter's content, title, synopsis or status |
| `book_chapter_rename` | Rename a chapter (registry, file name, heading, outline) |
| `book_chapter_delete` | Delete a chapter (file moves to `.book-mcp/trash/`) |
| `book_chapter_list` | List all chapters with status and word counts |
| `book_chapter_reorder` | Change chapter order |
| `book_stats` | Manuscript-wide statistics |

### Story Bible (world-building & continuity)

| Tool | What it does |
|------|-------------|
| `book_character_add` | Add a character to the story bible |
| `book_character_update` | Update a character's details |
| `book_character_get` | Retrieve a character's full profile |
| `book_character_list` | List all characters |
| `book_setting_add` | Add a setting (location, world, organization) |
| `book_setting_get` | Retrieve a setting's details |
| `book_setting_list` | List all settings |
| `book_plot_thread_add` | Track an open plot thread |
| `book_plot_thread_resolve` | Mark a plot thread as resolved |
| `book_plot_threads_list` | List plot threads by status |
| `book_continuity_check` | Cross-reference a chapter against the story bible |

### Outline

| Tool | What it does |
|------|-------------|
| `book_outline_set` | Set the full hierarchical outline |
| `book_outline_get` | Retrieve the outline |
| `book_outline_update_chapter` | Update synopsis or scenes for one chapter |

### Style Guide

| Tool | What it does |
|------|-------------|
| `book_style_set` | Set the full style guide (voice, POV, tense, tone) |
| `book_style_get` | Retrieve the style guide |
| `book_style_check` | Check a passage against the style guide |
| `book_style_add_influence` | Add an author influence |
| `book_style_list_influences` | List author influences |
| `book_style_remove_influence` | Remove an author influence |

### Export

| Tool | What it does |
|------|-------------|
| `book_export_markdown` | Compile all chapters into a single Markdown file |
| `book_export_docx` | Export a formatted `.docx` with title page, TOC, and page numbers |

### Preview

| Tool | What it does |
|------|-------------|
| `book_preview` | Generate a static HTML preview with book typography |
| `book_preview_server` | Create a live preview server with 10-second auto-refresh |

### Cover Design

| Tool | What it does |
|------|-------------|
| `book_cover_kdp_specs` | Get KDP cover specifications (ebook, paperback, hardcover) |
| `book_cover_create_spec` | Create a cover design specification |
| `book_cover_get_spec` | Retrieve the cover spec |
| `book_cover_generate_prompt` | Generate an AI image prompt from the cover spec |
| `book_cover_checklist` | KDP publishing readiness checklist |

### Author Profile

| Tool | What it does |
|------|-------------|
| `book_author_from_linkedin` | Build author profile from LinkedIn |
| `book_author_update_profile` | Manually update profile details |
| `book_author_regenerate_intro` | Regenerate bio from profile data |
| `book_author_update_intro` | Directly edit the generated bio |
| `book_author_get_profile` | Retrieve the full author profile |

## Renaming and Deleting Chapters

Chapter titles are not frozen at creation. `book_chapter_rename` changes a
chapter title everywhere it is stored:

- the entry in `registry.json`,
- the chapter file name (`ch-002-old-title.md` becomes `ch-002-new-title.md`),
- the `# Heading` inside the chapter file, so exports and previews show the new
  title (a heading you customised by hand is reported instead of overwritten),
- the matching chapter in `outline.json`, which is keyed by title.

`book_chapter_update` accepts `title` and `synopsis` too, so metadata can be
changed without resubmitting the prose — every field of that tool is optional
apart from the chapter itself.

`book_chapter_delete` removes a chapter from the manuscript. It requires
`confirm: true`, moves the markdown file to `.book-mcp/trash/` instead of
deleting it outright, closes the gap in the chapter order, and reports anything
in the story bible, timeline or outline that still points at the deleted
chapter. Chapter ids are never reused, so surviving references keep pointing at
the chapter they were written for.

Both tools (and every other chapter tool) accept either a chapter id or the
current chapter title.

## Project Structure

When you initialize a book, the MCP creates this structure in your project directory:

```
your-book/
  .book-mcp/
    registry.json       # Book metadata, chapter list, word counts
    story-bible.json    # Characters, settings, plot threads, timeline
    style-guide.json    # Voice, tone, POV, influences
    outline.json        # Hierarchical outline with acts and scenes
    cover-spec.json     # Cover design specification
    author-profile.json # Author bio and profile data
    trash/              # Chapter files removed by book_chapter_delete
  chapters/
    ch-001-your-first-chapter.md
    ch-002-the-next-one.md
    ...
  manuscript.md         # Created by book_export_markdown
  manuscript.docx       # Created by book_export_docx
  preview.html          # Created by book_preview
  preview/
    server.js           # Created by book_preview_server
```

## The Preview Reader

The built-in preview renders your manuscript as a beautifully typeset book page:

- **Playfair Display** headings with elegant drop caps
- **Source Serif 4** body text, justified with hyphens
- Ornamental bullet dividers between sections
- Cream paper background with subtle shadow
- Fixed word count badge
- Responsive design for reading on any device
- Auto-refresh every 10 seconds when using the preview server (re-run `book_export_markdown` after chapter edits to update content)

Run `book_preview` for a static HTML file, or `book_preview_server` to get a preview server at `http://localhost:3456`.

## Writing Workflows

### First-time author

> "I want to write a book about my 20 years in healthcare — the things nobody tells new nurses. Help me structure it."

The AI will create your project, build an outline from your experiences, set up a conversational style guide, and start drafting chapter by chapter. You talk, it writes, you refine.

### Fiction writer

> "I'm writing a mystery novel set in 1920s Mumbai. Three main characters, multiple timelines. Help me keep it all straight."

The story bible tracks every character, relationship, and plot thread. Continuity checking flags contradictions. The timeline keeps your dual narratives synchronized.

### Business / non-fiction

> "Turn my expertise in supply chain optimization into a book. I have keynote slides and some blog posts to start from."

The AI structures your knowledge into chapters, maintains a consistent professional tone, and generates a cover spec and author bio from your LinkedIn profile.

### Self-publishing to KDP

> "My manuscript is done. Help me get it ready for Kindle Direct Publishing."

Export to `.docx` with proper formatting, generate KDP-compliant cover specs with exact dimensions, run the publishing checklist, and preview the final result.

## Requirements

- Node.js 18+
- An MCP-compatible client (Claude Desktop, Claude Code, or any MCP client)

## License

MIT
