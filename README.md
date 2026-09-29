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

#### Browser clients and CORS

claude.ai's web client calls `/mcp` with `fetch()` from `https://claude.ai`, which makes every call cross-origin. The browser therefore sends a `OPTIONS` preflight before the real request, and **a preflight never carries an `Authorization` header** — the browser generates it, not the client code. A server that authenticates `OPTIONS` answers `401`, the browser aborts, and the authenticated request is never sent.

That is exactly the failure reported in [#79](https://github.com/anthropics/claude-ai-mcp/issues/79), [#155](https://github.com/anthropics/claude-ai-mcp/issues/155) and [#162](https://github.com/anthropics/claude-ai-mcp/issues/162): the connector authorizes, and then every call fails with no token in the server log. The tokenless request in the log is the preflight. This server used to have that bug; it does not any more. The full investigation, with redacted request/response pairs, is in [ISSUES.md](ISSUES.md).

The server now answers preflights before authentication runs, and exposes the headers a browser client has to read back:

- `Mcp-Session-Id` — Streamable HTTP requires the client to echo the session id on every request after `initialize`. Without `Access-Control-Expose-Headers` the browser hides it and the session is unusable.
- `WWW-Authenticate` — carries the `resource_metadata` pointer that starts OAuth discovery, so it has to be readable off a `401`.

Any origin is allowed by default. That is safe because `/mcp` still requires a bearer token on every request, so another site can reach the endpoint but cannot authenticate to it. To restrict it anyway:

```
MCP_ALLOWED_ORIGINS=https://claude.ai     # comma-separated; unset means any origin
```

#### Debugging a connector that will not authenticate

```
MCP_DEBUG_AUTH=1
```

Logs one line per request, before authentication runs, so rejected requests show up too. Credentials are never logged — the token is reduced to its length and an 8-character SHA-256 prefix, so the output is safe to paste into a bug report. [ISSUES.md](ISSUES.md) explains how to read it.

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
| `book_init` | Initialize a new book project (title, author, genre, target, language) |
| `book_project_update` | Change title, author, genre, target, language, daily goal, deadline or time zone |
| `book_progress` | Today's words against the goal, streak, last 14 days, pace, deadline |
| `book_chapter_create` | Create a new chapter |
| `book_chapter_read` | Read a chapter's content and metadata |
| `book_chapter_update` | Replace a chapter's whole content, or change title, synopsis or status |
| `book_chapter_find` | Find text in a chapter with paragraph numbers and context |
| `book_find` | Find text across the whole book (whole words, case-insensitive if asked) |
| `book_replace_text` | Replace text across the book — a dry run unless told otherwise |
| `book_todo_list` | Placeholders left while drafting: `[TK]`, `[TODO: …]`, `[RECHERCHE: …]` |
| `book_chapter_replace_text` | Replace one passage in a chapter, leaving the rest untouched |
| `book_chapter_rename` | Rename a chapter (registry, file name, heading, outline) |
| `book_chapter_delete` | Delete a chapter (file moves to `.book-mcp/trash/`) |
| `book_chapter_list` | List all chapters with status and word counts |
| `book_chapter_reorder` | Change chapter order |
| `book_chapter_history_list` | List a chapter's saved versions with a per-version diff summary |
| `book_chapter_revert` | Restore a saved version (the text it replaces is saved first) |
| `book_chapter_diff` | Unified diff between a saved version and the current text |
| `book_stats` | Manuscript-wide statistics, including the extent in Normseiten |

### Story Bible (world-building & continuity)

| Tool | What it does |
|------|-------------|
| `book_character_add` | Add a character to the story bible |
| `book_character_update` | Update a character's details |
| `book_character_rename` | Rename a character in the bible, the prose, synopses and the timeline |
| `book_character_get` | Retrieve a character's full profile |
| `book_character_list` | List all characters |
| `book_setting_add` | Add a setting (location, world, organization) |
| `book_setting_update` | Change a setting's name, description, type or notes |
| `book_setting_get` | Retrieve a setting's details |
| `book_setting_list` | List all settings |
| `book_plot_thread_add` | Track an open plot thread, with keywords the prose uses for it |
| `book_plot_thread_update` | Edit a thread, or mark it `abandoned` with a reason |
| `book_plot_thread_touch` | Record that a chapter carries a thread forward |
| `book_plot_thread_resolve` | Mark a plot thread as resolved |
| `book_plot_threads_list` | List plot threads by status |
| `book_theme_add` / `book_theme_list` / `book_theme_remove` | The book's themes |
| `book_continuity_check` | Cross-reference a chapter against the story bible |

### Timeline

| Tool | What it does |
|------|-------------|
| `book_timeline_add` | Log an event with its in-story time and an optional sort key |
| `book_timeline_list` | List events in story order, optionally filtered by chapter or character |
| `book_timeline_update` | Correct an event |
| `book_timeline_delete` | Remove an event |

### Outline

| Tool | What it does |
|------|-------------|
| `book_outline_set` | Set the full hierarchical outline; entries can be linked to chapters |
| `book_outline_get` | Retrieve the outline, with each entry's chapter and its status |
| `book_outline_update_chapter` | Update an entry's synopsis, scenes or link — found by title or by its chapter |
| `book_outline_link` | Link entries to the chapters written from them, where the title is unambiguous |
| `book_outline_compare` | Plan against manuscript: not yet written, not planned, moved, retitled |

### Style Guide

| Tool | What it does |
|------|-------------|
| `book_style_set` | Set the full style guide (voice, POV, tense, tone) |
| `book_style_get` | Retrieve the style guide |
| `book_style_check` | Check a passage against the style guide, and optionally one character's dialogue against their voice profile |
| `book_style_add_influence` | Add an author influence |
| `book_style_list_influences` | List author influences |
| `book_style_remove_influence` | Remove an author influence |

### Scenes

| Tool | What it does |
|------|-------------|
| `book_scene_list` | A chapter's (or the book's) scenes, with what is noted about each, and the point-of-view share |
| `book_scene_set` | Note a scene's point of view, setting, time, goal, conflict, outcome and summary |

### Reader and Editor Notes

| Tool | What it does |
|------|-------------|
| `book_note_add` | Record a note from a test reader, the editor or the author, anchored to a passage |
| `book_note_list` | Open (or resolved) notes, with where each passage is now |
| `book_note_resolve` | Mark a note dealt with, and how — or reopen it |
| `book_note_delete` | Delete a note recorded by mistake |

### Front & Back Matter

| Tool | What it does |
|------|-------------|
| `book_matter_set` | Add or replace a section: copyright page, dedication, epigraph, foreword, preface, cast list, afterword, acknowledgements, glossary, bibliography, about the author, also by |
| `book_matter_get` | One section, and what it will print |
| `book_matter_list` | All sections in reading order |
| `book_matter_remove` | Remove a section |

### Export

| Tool | What it does |
|------|-------------|
| `book_export_markdown` | Compile all chapters into a single Markdown file |
| `book_export_docx` | Export a `.docx` — as a book (`preset="book"`), a German **Normseite** manuscript or the **Standard Manuscript Format** |
| `book_export_epub` | Export a valid EPUB3 with a title page and generated table of contents |

### Dashboard

| Tool | What it does |
|------|-------------|
| `book_dashboard` | The state of the book as structured data |
| `book_dashboard_export` | The same, as a self-contained HTML page |

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
| `book_metadata_set` | Subtitle, series, description, keywords, categories, ISBNs, publisher, date, copyright, contributors |
| `book_metadata_get` | The metadata, its copyright line, what a store would reject, and what is missing |
| `book_ai_disclosure_generate` | Work out what KDP needs declared about AI use, and record it |
| `book_ai_disclosure_get` | Read back the recorded AI disclosure |

### Author Profile

| Tool | What it does |
|------|-------------|
| `book_author_from_linkedin` | Build author profile from LinkedIn |
| `book_author_update_profile` | Manually update profile details |
| `book_author_regenerate_intro` | Regenerate bio from profile data |
| `book_author_update_intro` | Directly edit the generated bio |
| `book_author_get_profile` | Retrieve the full author profile |

## The Book's Language

Every check that reads prose depends on the language it is written in: tense
and point of view, passive voice, who a dialogue tag names, which weekday a
chapter mentions, whether a trait is contradicted. `book_init` therefore takes
a `language` (a BCP 47 tag, `en` by default), and `book_project_update` changes
it later:

```
book_init title="Der Hafen" author="…" genre="Roman" language="de"
book_project_update language="de-AT"
```

The rules live in `src/lang/`, one object per language. The language also
decides what the exports declare: the EPUB's `dc:language` (which readers use
for hyphenation and text-to-speech — `book_export_epub language=` still
overrides it), the proofing language of the `.docx`, the preview's `lang`
attribute, and labels such as *Contents* / *Inhalt*.

**For a language without rules, the checks say so.** `book_style_check` and
`book_continuity_check` list the checks that could not run under
`checksSkipped`, and a passage with nothing flagged scores `partially_checked`
rather than `clean` — a clean result nothing earned is worse than none.
Checks that do not depend on the language, like the style guide's *things to
avoid*, run either way. A project created before the field existed is treated
as English, as it always was, and the reply says so.

Tense and point-of-view rules read the **narration only**: quoted dialogue is
blanked out first, because a character in a past-tense, third-person novel
says "I think" without breaking anything.

### Supported languages

| | English (`en`) | German (`de`) |
|---|---|---|
| Tense | *he says* / *he said* | *sie geht*, *dann geht sie* / *sie ging*, *dann ging sie* |
| Point of view | *I thought* / *she thought* | *dachte ich*, *ich wusste* / *dachte sie*, *er fragte sich* |
| Passive | *was opened* | *wurde … geöffnet* (participles with *ge-*) |
| Dialogue tags | *Kell said*, *said Kell* | *sagte Mara*, *Mara rief*, and 40-odd more verbs of speech |
| Quotation marks | "…" “…” ‘…’ | „…“ »…« ‚…‘ — and «…» for Swiss and French texts |
| Weekdays, time of day | *Saturday*, *night* | *Samstag* = *Sonnabend*, *nachts*, *am Morgen* |
| Contradicted traits | *tall* vs *short* | *groß* vs *klein*, *kleine*, *kleinen* |

German capitalises every noun, so nothing is taken for a name just because it
is capitalised. A speaker is a capitalised word next to a verb of speech, and
not one that follows an article, a possessive or a preposition (*die alte Frau
sagte*, *die Frau am Tresen sagte*), nor one followed by an inverted pronoun
(*Hinterher sagte er*). Adjectives are matched in lowercase with their endings,
so *klein* finds *kleine* but never *Kleinigkeit*, and *alt* never the noun
*Alter*. Bare *morgen* is not a time of day, because lowercased it cannot be
told apart from *tomorrow*.

Guillemets point either way: German sets »so«, French and Swiss «so». The
direction is taken from whichever mark comes first, because pairing German
»…« the French way captures the narration *between* two lines of speech.

## Writing Chapters: the Markup

Chapters are plain Markdown files, and every output — the preview, the live
server, the EPUB and the `.docx` — reads them through one parser
(`src/utils/markdown.ts`), so a chapter looks the same wherever it ends up.

| You type | You get |
|---|---|
| `# Title`, `## Section`, `### Subsection` | Headings |
| `*italic*` or `_italic_`, `**bold**`, `***both***` | Emphasis. Underscores count only at word edges, so `snake_case` is left alone |
| `\*` | A literal asterisk |
| A blank line | A new paragraph. A single line break inside a paragraph is kept as a line break |
| `***`, `* * *`, `---`, `- - -`, `___`, `#`, `⁂`, `~ ~ ~`, `• • •` on a line of their own | A **scene break** |
| `> …` | A block quote — for an epigraph, a letter, a document quoted in the story |

Every scene-break spelling means the same thing, so use whichever your hands
already know. The line does not need blank lines around it. `~~~` on its own is
deliberately *not* a scene break, because most editors read it as the start of
a code block.

## Daily Goals, Deadline and the Writing Log

Drafting runs on a daily quota and a deadline. Set them once:

```
book_project_update dailyWordGoal=1000 deadline="2027-03-31" timezone="Europe/Berlin"
```

Every change to chapter text made through the tools — creating, updating,
replacing a passage, reverting, deleting — goes through one write path
(`saveChapterContent` in `src/storage/writing-log.ts`) and is logged in
`.book-mcp/writing-log.json` against the calendar day in the project's time
zone. A container runs in UTC; without a `timezone`, a late session in Berlin
would count towards tomorrow.

`book_progress` answers from that log:

| | |
|---|---|
| `today` | Words added and cut, net, and what is left to the goal |
| `streak` | Days in a row with words added — and days that met the goal. Today does not break a streak before it is over |
| `recent` | The last 14 days |
| `averages` | Words per day over the days the log covers. Days before the log began are not counted as zeros |
| `deadline` | Days left (today included), words a day needed, and whether the recent pace is enough — `null` until three days are logged |
| `projectedFinish` | When the target is reached at the recent net pace |

Each change counts what it grew or shrank the text by, so rewriting a paragraph
at the same length adds nothing, and the goal is measured against words
*added*. The dashboard's *Words over time* chart uses the log once it spans two
days, and falls back to reconstructing from saved versions before that.

Word counts count prose, not markup: a heading's `#`, a scene break, a quote's
`>` and a free-standing dash are not words. A project counted by the older
counter is recounted the next time its registry is written.

## The Outline and the Manuscript

The outline is the plan; the chapters are what got written. They drift apart —
chapters are split, merged, moved, dropped, renamed — and every revision asks
the same question: what did I plan, what did I write, what changed?

An outline entry can be **linked** to the chapter written from it. The link is
by chapter id, so it survives a rename on either side and tells two chapters
with the same title apart. It is made without asking:

- `book_chapter_create` links the unlinked entry with the chapter's title — or
  the one named in `outlineTitle`, when the chapter was written under another
  title than planned (an entry that does not exist is refused before anything
  is written);
- `book_outline_set` links entries whose title matches exactly one chapter,
  and takes an explicit `chapterId`;
- `book_outline_link` catches up on a plan written after the chapters, and
  reports the titles several chapters share, to link by hand with
  `book_outline_update_chapter linkTo=...`.

`book_outline_compare` then lays plan and manuscript side by side: entries not
written yet, chapters the plan does not mention, chapters in a different place
than planned (counted among the chapters both know, so one missing chapter does
not make every later one look moved), chapters retitled since, and where the
plan's synopsis and the chapter's now say different things. `book_outline_get`
shows each entry with its chapter's status and length.

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
chapter.

Deleting a chapter from the middle leaves its id retired: the ids around it do
not shift, so references written against them keep pointing at the chapter they
were written for. Deleting the **last** chapter is the exception — the next id
is derived from the highest one still registered, so the id it gave up is handed
to the next chapter created. That is why a delete also moves the chapter's saved
versions to `.book-mcp/trash/`: a new chapter must never inherit the revision
history of the one it replaced.

Both tools (and every other chapter tool) accept either a chapter id or the
current chapter title.

## Plot Threads and Themes

A thread is carried by a chapter when the chapter opens it, when the prose
names its title or one of its **keywords**, or when the author says so with
`book_plot_thread_touch` — a chapter can keep a thread alive without naming it.
`book_continuity_check` reminds you of an open thread only once it has rested
for more than five chapters since it was last carried, and says where that was;
the dashboard weights its finding the same way. A thread you drop on purpose is
marked `abandoned` with `book_plot_thread_update`, keeps the reason, and is
never nagged about again.

```
book_plot_thread_add title="Kells Schulden" openedIn="Der Kai" summary="…" \
                     keywords=["Schuldschein", "der Wirt"]
book_plot_thread_touch threadId="Kells Schulden" chapterId="ch-008" note="Kell weicht dem Wirt aus."
book_plot_thread_update threadId="Der Brief" status="abandoned" reason="Doppelt mit der Schuld-Handlung."
```

Characters are addressed by id, name or alias, settings by id or name, threads
by id or title, and a chapter anywhere in the story bible by id or title — it
is stored as its id. A chapter that does not exist yet (a thread planned during
outlining) is kept as given, with a warning.

Themes — what the book is about underneath its plot — are kept with a short
description of how the book treats them (`book_theme_add`).

## Per-Character Voice

The style guide is the book's voice — one POV, one tense, one set of habits for
the whole manuscript. A `voice_profile` is one *person's* voice inside it, and
it is optional: most characters never need one, and a character without one is
checked exactly as before.

```
book_character_add name="Kell" role="supporting" description="Dockhand." \
  voiceProfile='{
    "vocabulary": "nautical, plain, no abstractions",
    "sentenceLength": "clipped",
    "verbalTics": ["aye", "mate"],
    "neverSays": ["furthermore", "consequently"],
    "notes": "Never explains himself."
  }'
```

`neverSays` and `verbalTics` are matched **literally** against dialogue, so they
want words and phrases rather than descriptions of a habit: `"furthermore"`
works, `"avoids formal connectives"` does not.

Pass a character to `book_style_check` and the passage is judged twice — against
the global style guide as prose, and against that character's profile as speech:

```
book_style_check passage="..." characterId="Kell"
```

| Flag | When |
|------|------|
| Would never say | A line contains one of the character's `neverSays` terms. |
| Sentence length | A line runs well outside the band for their `sentenceLength`. The bands overlap deliberately — dialogue is uneven, and one short retort from a rambling character means nothing. |
| Missing verbal tics | The character has tics and none appears across three or more of their lines. A single line is not evidence. |
| Sounds like someone else | The line fits another character's profile *better*, and carries one of that character's markers. Merely not breaking someone else's rules is not enough. |

### How speakers are worked out

Prose is not parseable, so attribution is deliberately conservative. A line
tagged `"..." Kell said` or `"..." said Kell` goes to Kell; the tag is read only
up to the neighbouring quotation mark, so an untagged line cannot borrow the
next line's tag. A line with **no** tag is treated as the character's own, on
the grounds that you named them when you asked. Another character's tagged
dialogue in the same passage is never charged against them.

Straight quotes, curly quotes, guillemets and low-9 quotes are all recognised.
The response reports `linesAttributedToCharacter` and `linesAttributedToOthers`
so you can see how the passage was split before trusting the flags.

## The Timeline

The story bible tracks who and where; the timeline tracks *when*. Events live in
`.book-mcp/timeline.json`, which `story-bible.json` points at via `timelineRef`
rather than holding a second copy — an event references chapters and characters
by id, so renaming a character updates every event that mentions them.

Each event carries two kinds of time:

- **`inStoryTime`** is free text, how the story itself would put it:
  `"Saturday night, ~23:30"`, `"three winters before the siege"`, `"the morning
  after the fire"`. A story's own clock rarely maps onto a calendar, so nothing
  tries to parse this.
- **`sortKey`** is optional and only has to sort lexicographically. An ISO-ish
  stamp works (`"1997-06-14T23:30"`), and so does a scheme of your own
  (`"Y02-D14-2330"`) for a story with no calendar. Events without one are listed
  after those that have one, ordered by the chapter they belong to.

```
book_timeline_add event="Mara finds the letter" \
                  inStoryTime="Saturday night, ~23:30" \
                  sortKey="1997-06-14T23:30" \
                  chapterId="ch-003" \
                  characterIds=["Mara", "Kell"]
```

Chapters and characters can be named rather than id'd — `chapterId="The Letter"`
and `characterIds=["Mara"]` both resolve. An unknown name is rejected rather
than stored, so a typo does not become a silent dangling reference.

### What the continuity check does with it

`book_continuity_check` cross-references the chapter against the timeline and
flags three things. All of them stay quiet unless the timeline actually has
something to say — a chapter with no logged events is never second-guessed.

| Flag | Severity | When |
|------|----------|------|
| Chronology vs chapter order | error | An event logged in this chapter happens *before* one logged in an earlier chapter. Either the chapter is a flashback or a `sortKey` is wrong. |
| Weekday contradiction | error | The chapter names a weekday the logged event does not. |
| Time-of-day contradiction | warning | The chapter reads as morning where the event says night. Only raised when the draft names exactly one time of day — a chapter that spans dawn to dusk legitimately mentions several. |
| Absent character | warning | The timeline puts a character in this chapter but the prose never names them. |

## Editing Part of a Chapter

`book_chapter_update` replaces the **whole** chapter. That is what it is for, but
it makes a small correction expensive — the entire text has to be sent back — and
it is unforgiving: passing a single paragraph to it replaces the chapter with
that paragraph and the rest is gone.

For a small edit, use the pair below instead. Nothing about `book_chapter_update`
changes; this is a second route.

```
book_chapter_find chapterId="ch-003" query="Das Wasser war grau"
book_chapter_replace_text chapterId="ch-003" \
  oldText="Das Wasser war grau." \
  newText="Das Wasser war schwarz."
```

**`book_chapter_find`** returns every occurrence with its paragraph number and
surrounding context, without loading the chapter. Use it to locate a passage and
to confirm a phrase is unique before replacing it.

**`book_chapter_replace_text`** replaces one passage and leaves everything else
byte-for-byte as it was.

| | |
|---|---|
| Matching | Exact and character-for-character. No wildcards, no regular expressions. Both sides are folded to NFC first, so a `ü` typed on macOS matches the one stored on disk. |
| Safety | Without `replaceAll`, `oldText` must occur **exactly once**. At zero or more than one match the call fails, names the count, and writes nothing. |
| Counting | Non-overlapping, as a replacement behaves: `aa` occurs once in `aaa`, not twice. |
| History | The previous text is filed before the write, so `book_chapter_revert` undoes the edit. |
| Locking | The read, the match and the write run under the same lock `book_chapter_update` uses. |
| Reply | Match count, word count before and after, and up to three short excerpts — capped, because a `replaceAll` over forty occurrences would otherwise cost more than reading the chapter. Never the chapter text. |

`dryRun: true` reports what would change, including the reason an edit would be
refused, and writes nothing.

A replacement is spliced in literally: prose containing `$&` or `$1` survives
intact, which it would not if this went through `String.replace`.

### Changes across the whole book

`book_find` searches every chapter (or the ones listed) and reports each
occurrence with its chapter, paragraph and context. `wholeWord` keeps *Mara*
from matching *Maraschino*; `caseSensitive=false` folds case, Unicode-aware. The
counts always cover every match; the snippets stop at `maxResults`.

`book_replace_text` is the book-wide replacement, and it is a **dry run by
default**: it reports what would change, chapter by chapter, and tells you the
`expectedCount` to pass with `dryRun=false`. If the book no longer matches that
count when you apply it, nothing is written. Each changed chapter's previous
text is filed first, so `book_chapter_revert` undoes the change chapter by
chapter.

`book_character_rename` renames a character everywhere at once — the story
bible, the prose of every chapter, chapter and outline synopses, timeline
events, and other characters' descriptions, notes and relationships. It is
whole-word and case-sensitive. When old and new name have the same number of
words, each changed word is renamed on its own as well (*Vance* → *Reed*),
unless another character's name contains that word — *Tom Vance*'s surname is
left alone and reported. English possessives (*Mara's*) are renamed; a form
with letters attached, like the German genitive *Maras*, is **reported, not
guessed at** — pass `includeGenitive=true` to rename *-s* genitives, or fix the
rest with `book_replace_text`.

```
book_character_rename characterId="Mara Vance" newName="Maria Reed" dryRun=true
book_character_rename characterId="Mara Vance" newName="Maria Reed" includeGenitive=true
```

### Reading only part of a chapter

`book_chapter_read` takes optional `fromParagraph` and `toParagraph` (1-based,
inclusive; paragraphs are separated by blank lines, and `book_chapter_find`
reports the number of each match). With neither given it returns the whole
chapter exactly as before.

```
book_chapter_read chapterId="ch-003" fromParagraph=12 toParagraph=14
```

## Scenes

Classic drafting thinks in scenes, not chapters: one point of view, one place,
one time — a goal, a conflict in its way, an outcome that turns into the next
scene. A chapter's scenes are the stretches between its scene breaks, so there
is nothing to maintain: `book_scene_list` reads them off the text, with their
paragraph range, length and opening words.

```
book_scene_list chapterId="Der Kai"
book_scene_set chapterId="Der Kai" scene=2 pov="Kell" setting="Schuppen" \
               goal="Das Geld auftreiben" conflict="Der Wirt will es heute" outcome="Er beschließt zu stehlen"
```

What is noted about a scene lives in `.book-mcp/scenes.json`, **anchored to the
scene's opening words**: insert a scene in front of it and its notes move with
it; rewrite its opening and the notes are reported as lost rather than pinned
to whichever scene now has its number. `pov` is a character from the story
bible (a unique first name will do), `setting` one of its settings or free text.

Across the book, `book_scene_list` and the dashboard show how the words are
shared between point-of-view characters, and scenes noted without a conflict
are counted — a scene without one is often a scene that can go. In a
third-person book, `book_continuity_check` flags a scene whose point-of-view
character is never named in it: either the noted POV is wrong, or the scene
drifted into someone else's head.

## Placeholders While Drafting

The rule of a first draft is to keep going. Where a name, a fact or a date is
missing, leave a marker and write on:

```
Sie nahm die Fähre nach [TK].
Der Hafenmeister hieß [TODO: Name aus dem Adressbuch 1997].
[RECHERCHE: Gezeiten am 14. Juni]
```

`[TK]` (journalism's *to come*), `[TODO …]`, `[FIXME …]`, `[RECHERCHE …]`,
`[PRÜFEN …]`, `[CHECK …]`, `[XXX]` and a bare capital `TK` are recognised, with
the note after them. Only these words open a marker, so an ordinary bracket —
`[sic]`, a stage direction — is left alone, and neither `TKO` nor a lowercase
`tk` counts.

`book_todo_list` lists each one with chapter, paragraph and context, and can
filter by kind (`kind="RECHERCHE"` for a research session). While any remain,
every export and the preview warn; `book_chapter_update status="final"` warns
for the chapter; and the dashboard counts them under *draft* — as serious once
they sit in a chapter marked review or final.

## Notes from Test Readers and the Editor

Between the draft and the finished book stand test readers and an editor, and
their feedback — *why does she already know this here?*, *this scene drags* —
belongs next to the passage it is about, not in a chat history.

```
book_note_add chapterId="Der Kai" anchorText="Sie wusste schon, wer der Tote war." \
              text="Woher weiß sie das an dieser Stelle schon?" source="Testleserin A" kind="question"
book_note_list status="open"
book_note_resolve noteId="note-…" resolution="Hinweis in Kapitel 2 eingebaut."
```

A note is anchored to the **words** it is about, not to a position. Each time
notes are listed the passage is found again, so a paragraph added above it
moves the note with it; a passage that occurs twice is told apart by the
paragraph it was in when the note was made. If a revision cuts the passage,
the note is reported as **lost** — with the paragraph it used to be in — rather
than shown next to the wrong text. A note can also be pinned to a whole
paragraph (`paragraph=3`) or to the chapter as a whole.

Open notes are not forgotten: `book_chapter_update status="final"` warns when a
chapter still has some (the author still decides), the dashboard lists them
under *feedback* — as serious when they sit on a chapter already marked final —
and deleting a chapter reports the notes it leaves behind.

## Chapter Version History

Every `book_chapter_update` that changes the prose files the previous text away
first, under `.book-mcp/history/<chapter-id>/<timestamp>.md`. Nothing has to be
switched on, and an update that only touches the title, synopsis or status does
not create a version — neither does resubmitting prose that is byte-identical to
what is already there.

The last **20** versions of each chapter are kept; older ones are pruned as new
ones arrive.

`book_chapter_history_list` shows what is available, newest first, with each
version's word count and how many lines separate it from the chapter as it
stands now:

```json
{
  "snapshots": [
    {
      "timestamp": "2026-09-22T14-30-00-000Z",
      "savedAt": "2026-09-22T14:30:00.000Z",
      "wordCount": 2140,
      "versusCurrent": {
        "linesAdded": 12,
        "linesRemoved": 4,
        "summary": "+12 / -4 lines to reach the current version"
      }
    }
  ]
}
```

`book_chapter_revert` restores one of them. It files the text it is about to
replace as a new version first, so a revert is itself undoable — the response
names the timestamp to revert to if you change your mind:

```
book_chapter_revert chapterId="ch-003" timestamp="2026-09-22T14-30-00-000Z"
```

Versions are stored per chapter **id**, not per file name, so renaming a chapter
keeps its history with it.

### Reviewing a revision

`book_chapter_diff` shows what actually changed, so a revision can be reviewed
without reading two full drafts side by side. With no timestamp it compares the
current text against the most recent saved version:

```
book_chapter_diff chapterId="ch-003"
book_chapter_diff chapterId="ch-003" timestamp="2026-09-22T14-30-00-000Z"
book_chapter_diff chapterId="ch-003" context=5
```

```diff
--- ch-003-the-arrival.md @ 2026-09-22T14:30:00.000Z
+++ ch-003-the-arrival.md (current)
@@ -1,5 +1,6 @@
 # The Arrival
 
 She stepped off the train into rain.
-The platform was empty.
+The platform was deserted.
 A porter waved her through.
+Somewhere a bell rang.
```

It is a real unified diff, not a rendering that resembles one: the output is
byte-for-byte what `diff -u` produces and applies with `patch`. Both are
asserted in the tests, including across a few hundred randomised revisions. The
line counts in `book_chapter_history_list` come from the same module, so a
summary and a diff can never disagree.

## Concurrent Tool Calls

Every JSON document under `.book-mcp/` is read-modify-written: a tool reads the
whole file, changes a field, and writes it back. The write itself is atomic — a
temp file and a rename, so a reader never sees half a document — but that says
nothing about two tool calls overlapping. If a handler yields between its read
and its write, a second call can start from the same state and one of the two
changes is lost.

Each of those files therefore has an in-process queue keyed by its path
(`src/storage/lock.ts`). Work on one file runs in the order it was requested;
different files never wait on each other. What is held is the *whole*
read-modify-write span, not the read and the write separately — locking those
individually would add nothing, since each is already atomic on its own.

Tools reach it through the transaction helpers in `src/storage/filestore.ts`
(`updateRegistry`, `updateStoryBible`, `updateStyleGuide`, `updateOutline`,
`updateCoverSpec`, `updateAuthorProfile`). Anything that changes one of these
files should go through the matching helper rather than calling `get*` and
`save*` in sequence. Read-only tools need no lock.

Two tools nest transactions. A chapter rename holds `registry.json` and takes
`outline.json` inside it; `book_character_rename` holds `registry.json` and
takes `story-bible.json`, then `timeline.json`, then `outline.json`. That order
— registry, story bible, timeline, outline — is the only one used anywhere, and
no tool that holds a later file reaches back for an earlier one, so they cannot
deadlock. `writing-log.json` takes no lock of its own: it is only ever written
inside a registry transaction, which already serialises it.

Two caveats worth knowing:

- **This is an in-process queue, not a file lock.** One container serving one
  project is what this server is built for. Two processes pointed at the same
  project directory would still race.
- **`oauth.json` is handled differently.** `OAuthStore` keeps the whole store in
  memory and every mutator is synchronous, so a read and its write happen in one
  tick and nothing can interleave. It needs no lock, and making its methods
  async to take one would change the provider interface for no gain.

## Project Structure

When you initialize a book, the MCP creates this structure in your project directory:

```
your-book/
  .book-mcp/
    registry.json       # Book metadata, chapter list, word counts
    story-bible.json    # Characters, settings, plot threads
    timeline.json       # Story events in chronological order
    ai-disclosure.json  # Recorded AI content declaration for KDP
    writing-log.json    # Words added and cut per day
    metadata.json       # Publishing metadata: subtitle, series, ISBNs, keywords…
    matter.json         # Front and back matter
    notes.json          # Notes from test readers and the editor
    scenes.json         # What is noted about each scene
    style-guide.json    # Voice, tone, POV, influences
    outline.json        # Hierarchical outline with acts and scenes
    cover-spec.json     # Cover design specification
    history/            # Saved chapter versions, one folder per chapter id
    author-profile.json # Author bio and profile data
    trash/              # Chapter files removed by book_chapter_delete
  chapters/
    ch-001-your-first-chapter.md
    ch-002-the-next-one.md
    ...
  manuscript.md         # Created by book_export_markdown
  manuscript.docx       # Created by book_export_docx
  manuscript.epub       # Created by book_export_epub
  dashboard.html        # Created by book_dashboard_export
  preview.html          # Created by book_preview
  preview/
    server.js           # Created by book_preview_server
```

## Publishing Metadata

A store needs more than a title: a subtitle, the series, a description, search
keywords, categories, an ISBN per edition, the publisher, the date, the
copyright line, the editor or translator. `book_metadata_set` keeps them in
`.book-mcp/metadata.json`; every field is optional, replaces what was there, and
an empty value clears it.

```
book_metadata_set subtitle="Ein Kriminalroman" seriesName="Hafen-Krimis" seriesNumber=2 \
  description="…" keywords=["Hafenkrimi", "Hamburg"] categories=["FIC022000"] \
  isbnEbook="978-3-16-148410-0" publisher="Kleinverlag" publicationDate="2027-03-01"
```

What KDP would reject is refused, and the call as a whole with it: an eighth
keyword, a keyword over 50 characters, a fourth category, a description over
4000 characters, title and subtitle together over 200, an ISBN whose check digit
does not add up (usually a typo), two editions sharing an ISBN. ISBNs are stored
as bare digits, however they were typed. `book_metadata_get` repeats any such
problem in a hand-edited file, and lists what is still missing.

**The description is the blurb, and it has one home.** The EPUB's description
and the cover spec's back-cover blurb both read it. A blurb given to
`book_cover_create_spec` while there is no description becomes the description.

The EPUB takes all of it: the subtitle as a refined `title-type`, the series as
`belongs-to-collection` with its position, contributors with their MARC
relator roles, publisher, date, rights and categories — and it still passes
epubcheck. Its identifier is the e-book ISBN when there is one; otherwise a UUID
kept in `metadata.json`, so a re-exported draft is the same book to a reader's
library rather than a second copy. The title pages of the EPUB and the `.docx`
show the subtitle, and the dashboard's readiness panel lists what is missing.

## Front Matter, Back Matter, Parts and Chapter Numbers

A printed book is more than its chapters. `book_matter_set` adds the rest, and
every export — Markdown, DOCX, EPUB and the preview, which all build on
`src/export/assemble.ts` — sets it in the classic order:

| Where | What |
|---|---|
| Before the contents | Title page, **copyright page** (*Impressum*), **dedication**, **epigraph** (*Motto*) |
| After the contents | **Foreword**, **preface**, **cast list** (*Personen*) |
| Body | Part pages and chapters |
| After the last chapter | **Afterword**, **acknowledgements**, **glossary**, **bibliography**, **about the author**, **also by** |

Three sections can write themselves when given no content, from data the
project already has — and are written again at every export, so they are never
stale:

- the **copyright page** from the metadata: title, subtitle and series, the
  copyright line, *All rights reserved*, the edition, publisher, contributors
  and one ISBN per edition;
- the **cast list** from the story bible: every character above a minor role,
  main roles first, with the first sentence of their description. Read it for
  spoilers before publishing, or give the section text of its own;
- **about the author** from the author profile's bio.

Headings come in the book's language (*Danksagung*, *Acknowledgements*) and can
be overridden with `title`; a dedication, an epigraph and the copyright page
print without one. `position` moves a section to the other end of the book.

**Parts.** `book_chapter_update part="Die Stadt"` puts a chapter in a part;
consecutive chapters in the same part share one part page, labelled *Erster
Teil* / *Part One* unless the part's own title already says so. In the EPUB the
contents nest the chapters under their part.

**Chapter numbers.** `book_project_update chapterNumbering="words"` prints
*Drittes Kapitel* / *Chapter Three* above each chapter title (`"numeric"`:
*Kapitel 3*). A prologue or epilogue marked `numbered=false` carries no number
and does not push the chapters after it up by one; a chapter exported alone
keeps the number it has in the whole book.

In the EPUB, each piece of matter is its own document with its EPUB
structural semantics (`copyright-page`, `dedication`, `epigraph`, `foreword`,
`acknowledgments`, …), chapters and parts are `<section epub:type="chapter">`
and `"part"`, and the landmarks point at the copyright page — it all passes
epubcheck.

## AI Content Disclosure

Amazon asks publishers to declare AI-generated content. The distinction that
matters, and the one most often got wrong, is **who created the content** — not
how much you edited it afterwards:

| | Definition | Declare to KDP? |
|---|---|---|
| **AI-generated** | An AI tool created the text, images or translation from your prompts. Editing it afterwards, however heavily, does not change this. | **Yes** |
| **AI-assisted** | You created it; AI only brainstormed, outlined, edited, refined or error-checked. | **No** |

```
book_ai_disclosure_generate text="ai_assisted" images="ai_generated"
```

Each content type — text, images (cover *and* interior artwork), translations —
is classified separately, because KDP asks about them separately. The response
tells you exactly what to answer in the publishing form, records the decision in
`.book-mcp/ai-disclosure.json`, and `book_cover_checklist` stops reminding you.

Two things worth being clear about, because tools in this space often are not:

- **The declaration is a form answer, not text in your book.** Amazon does not
  want a disclosure printed in the front matter, and putting one there is not
  what makes you compliant. A reader-facing note is offered anyway, explicitly
  marked as optional, for authors who want to tell readers or who are selling
  through a retailer or into a jurisdiction that asks for something different.
- **AI-assisted work needs no declaration at all.** If you drafted the book and
  used AI to tighten it, there is nothing to declare.

You must declare again whenever you edit and republish, not just on first
publication.

### On the wording staying current

The policy is held in one dated block in `src/tools/ai-disclosure-policy.ts`
carrying its source URL and the date it was last checked, and **every response
repeats both**. This server has no network access at run time by design, so it
cannot re-read Amazon's page for you — and a compliance answer that quietly
served a stale cache would be worse than one that shows its age. Treat the
verification date as the claim: if it is old, open the linked page before you
publish.

A disclosure recorded against an older reading of the policy than the server now
carries is flagged when you read it back, so a project that predates a policy
update does not look settled when it is not.

To refresh: re-read the [KDP content guidelines](https://kdp.amazon.com/en_US/help/topic/G200672390),
update that file, and bump `POLICY_VERIFIED_ON`.

## Which Chapters an Export Contains

`book_export_markdown`, `book_export_docx`, `book_export_epub` and `book_preview`
all choose chapters the same way (`src/export/select.ts`):

1. `includeChapters` (ids or titles) when you give it — an unknown entry is an
   error, not a silent omission;
2. otherwise every chapter marked `review` or `final`;
3. otherwise, while nothing is marked ready yet, every chapter.

The reply's `selection` field says which rule applied and how many drafts were
left out. The live preview server is the one exception: it shows every chapter,
because someone watching it while they write wants to see the draft.

## DOCX Export

`book_export_docx` writes the chapter markdown as real Word formatting rather
than as text: `*italic*` becomes an italic run, `## Section` a *Heading 2*,
a scene break a centred `*  *  *`, a `> quote` an indented paragraph. Every
chapter starts on a new page, and — the convention in printed prose — the first
paragraph after a heading, a scene break or a quote starts flush while the rest
are indented. The heading styles are the body font in black, overriding Word's
built-in blue sans-serif ones.

### Submission manuscripts: Normseite and Standard Manuscript Format

A manuscript sent to an agency or a publisher is not laid out like a book.
`book_export_docx preset=` produces the two formats the trade expects:

| | `normseite` | `standard_manuscript` |
|---|---|---|
| Where | German-language publishing | English-language publishing |
| Page | A4, 2.5 cm margins, the right one set so a line holds **exactly 60 characters** | US Letter, 1-inch margins |
| Type | Courier New 12 pt, a line pitch that fits **exactly 30 lines** | 12 pt Times New Roman or Courier New, double-spaced |
| Running head | `Author · Title / page` | `Surname / TITLE / page` |
| Cover sheet | Contact block; `ca. 312 Normseiten` top right | Contact block; `about 80,000 words` top right |
| Chapters | New page, four lines down | New page, a third of the way down, centred title |
| Scene break | `*` | `#`, and `END` after the last line |

Every paragraph is indented, and in the Normseite every spacing is a whole
number of lines and widow control is off, so no page holds more or less than
thirty. The geometry is not left to taste: the tests assert that the text width
is sixty Courier characters and that thirty lines fit where thirty-one do not.
Font, size and spacing parameters are ignored for these presets (the reply
says so), front and back matter are left out — they are the publisher's to
set — and `contact` fills the cover sheet.

```
book_export_docx preset="normseite" contact=["Anna Autorin", "Hafenstraße 1, 20457 Hamburg", "anna@example.org"]
```

`book_stats` reports the extent the way publishers quote it: `normPages`,
counted by laying the text out exactly as the Normseite export does — each
chapter on a new page, words wrapped at sixty characters, a scene break three
lines — and `charactersWithSpaces`.

## EPUB Export

`book_export_epub` compiles the manuscript into an EPUB3 file: a title page, a
table of contents generated from the chapter titles, and one XHTML document per
chapter.

```
book_export_epub
book_export_epub language="de" identifier="urn:isbn:9780000000000"
book_export_epub outputPath="./drafts/wip.epub" includeChapters=["ch-001","ch-002"]
```

Chapter selection matches `book_export_markdown`: an explicit list if you give
one, otherwise every `final` and `review` chapter, otherwise everything. A
chapter that is empty on disk is skipped and reported rather than shipped as a
blank page.

The author comes from `author-profile.json` when a profile exists, falling back
to the name `book_init` was given; the response says which was used. `language`
is a BCP 47 tag and defaults to `en` — set it, because reading systems use it
for hyphenation and text-to-speech. `identifier` takes an ISBN if you have one
(`urn:isbn:...`); a random UUID is generated if you don't, which is fine for a
draft but should be a real identifier before publishing.

No new dependency was added for this: `jszip` was already in the tree under
`docx`, and is now declared directly since the exporter uses it.

### Validity

The output is checked against [epubcheck](https://github.com/w3c/epubcheck), the
reference implementation of the specification, and passes with no errors or
warnings under EPUB 3.3 rules. epubcheck is a 30 MB Java tool, so it is not
vendored; the test that uses it marks itself skipped when it is absent rather
than reporting a pass it did not earn. To run it:

```bash
curl -sSLo /tmp/epubcheck.zip \
  https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip
unzip -q /tmp/epubcheck.zip -d /tmp
EPUBCHECK_JAR=/tmp/epubcheck-5.1.0/epubcheck.jar npm test
```

The structural checks run either way: that `mimetype` is the first archive entry
and stored uncompressed (readers identify the file by reading it at a fixed
offset), that the required documents are present, and that chapter content is
XHTML rather than HTML — `<br>` instead of `<br />` is a parse error that makes
readers reject an otherwise fine book.

## The Dashboard

`book_dashboard` returns the state of the book as data; `book_dashboard_export`
writes the same thing as a single HTML file with no scripts and nothing fetched
at view time, so it opens straight from disk and prints.

```
book_dashboard
book_dashboard sections=["health","readiness"]
book_dashboard_export outputPath="./dashboard.html"
```

Seven panels, in the order they answer "how is this book doing?":

| Panel | What it shows |
|---|---|
| **Progress** | Words against target, chapter states, reading time, how long since you last worked on it |
| **Who appears where** | Characters down the side, chapters across, shaded by how often each is named |
| **Story order vs chapter order** | Each logged event placed by the chapter it is told in against when it happens |
| **Chapters** | Length, state, saved versions, and how much has changed since the oldest one |
| **Words over time** | Total words reconstructed from the saved chapter versions |
| **Manuscript health** | Open threads, timeline contradictions, absent characters, missing voice profiles, style-guide breaches, stale chapters |
| **Publishing readiness** | What is still outstanding before KDP |

The two worth opening it for are the first two of the middle group. **Who appears
where** makes a character quietly leaving the book for eleven chapters obvious at
a glance, which reading chapter-to-chapter never does. **Story order vs chapter
order** draws the book's flashback structure: a straight diagonal means it is told
in the order it happens, and every departure is deliberate — or a mistake, in
which case the contradiction is marked in red with a label.

### What it is honest about

- **Words over time is a partial record.** It is reconstructed from saved chapter
  versions, which only exist for content changes, cap at 20 per chapter, and
  start when version tracking was added. The panel says so on its face rather
  than presenting a trend that looks complete.
- **Panels stay quiet when they have nothing to say.** A project that has never
  logged a timeline event is not told that every chapter is missing one.
- **A clean book reports "nothing flagged"** rather than an empty list you have
  to interpret.

### Colour

The palette is not decorative and was not picked by eye. Magnitude — the
presence map — uses one blue hue light-to-dark. Chapter status is an ordered
scale, so it uses an ordinal ramp rather than four unrelated colours, and the
ramps for both light and dark mode were checked with a validator (lightness
monotonicity, step separation, contrast against each mode's own surface). Dark
mode is its own set of steps, not an inverted light palette.

Status colours (good / watch / serious / critical) are reserved for state and
never reused as series colours, and they always travel with an icon and a word,
so nothing is carried by colour alone. Every chart has a table view for the same
reason.

## The Preview Reader

The built-in preview renders your manuscript as a beautifully typeset book page:

- **Playfair Display** headings with elegant drop caps
- **Source Serif 4** body text, justified with hyphens
- Ornamental bullet dividers between sections
- Cream paper background with subtle shadow
- Fixed word count badge
- Responsive design for reading on any device
- Auto-refresh every 10 seconds when using the preview server

Run `book_preview` for a static HTML file, or `book_preview_server` for the live
server described below.

### The live server

`book_preview_server` writes `preview/server.js` into your project. It is a
self-contained bundle — `node preview/server.js` runs with nothing installed
beside it — and serves three routes:

| Route | What it is |
|---|---|
| `/` | The manuscript, typeset for reading |
| `/dashboard` | The dashboard, rebuilt on every request |
| `/dashboard.json` | The same data, for anything that wants to consume it |

Both pages are compiled from the chapter files **on every request**, so there is
no export step and nothing goes stale: save a chapter and the next refresh shows
it. The reader also includes chapters of every status, because someone watching
the page while they write wants to see the draft they are writing — `/` is for
writing, `book_export_markdown` is for publishing, and they filter differently on
purpose.

Both refresh via a `<meta http-equiv="refresh">` rather than a script, so nothing
the server sends carries executable code. Files written by `book_preview` and
`book_dashboard_export` carry no refresh at all — a saved page should not try to
reload itself.

```
PREVIEW_PORT=8080 node preview/server.js          # default 3456
PREVIEW_REFRESH_SECONDS=30 node preview/server.js  # default 10
```

The server finds the project as the parent of its own directory, so it works
wherever the project is copied to. `BOOK_PROJECT_DIR` overrides that, which is
what the container sets.

> The server is built from `src/preview/server.ts` and bundled by esbuild, so
> `npm run build` has to have been run in the installation before
> `book_preview_server` can copy it. It used to be assembled at run time as an
> array of JavaScript strings, which meant a second untyped copy of the markdown
> renderer and the stylesheet, free to drift from the originals.

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

## Development

```bash
npm install
npm test          # builds, then runs the suite
npm run typecheck
npm run build     # esbuild bundles for both transports
```

### Type checking

`npm run typecheck` covers `src/utils`, `src/storage`, `src/auth`, `src/http`
and the pure-logic tool modules — everything where the logic lives. It runs in
about a second.

It deliberately leaves out the tool-registration modules, and the reason is
worth knowing before you try to "fix" it: **a full-project `tsc` does not
complete.** Every `server.tool()` call with a zod shape triggers
`TS2589: Type instantiation is excessively deep and possibly infinite`. One
such file takes ~90 seconds on its own; across all thirteen of them the
compiler exhausts even a 13 GB heap and dies. This comes from the MCP SDK's
`ZodRawShape` inference rather than from anything here, it is unaffected by the
zod version (3.25 behaves the same as 3.22), and it predates this config — the
project has never been fully type-checkable, which went unnoticed because the
build uses esbuild, and esbuild strips types without checking them.

Those modules are covered instead by esbuild (imports and syntax) and by the
test suite, which exercises every tool through its real handler and zod schema.
If the SDK's inference is fixed upstream, widen the `include` in
`tsconfig.typecheck.json` and delete this section.

## Requirements

- Node.js 18+
- An MCP-compatible client (Claude Desktop, Claude Code, or any MCP client)

## License

MIT
