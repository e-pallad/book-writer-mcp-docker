# Book Writer MCP

**Turn your ideas into published books with AI as your writing partner.**

Everyone has a story to tell, a worldview to share, or expertise worth publishing. The gap between having something to say and holding a finished manuscript has always been enormous — months of lonely discipline, structural guesswork, and the constant fear of losing your thread. Book Writer MCP closes that gap.

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (or any MCP-compatible AI) a full suite of book-writing tools. You talk about your book. The AI writes, organizes, tracks, and exports it — while you stay in creative control.

## What This Gives You

- **Start a book in one sentence.** Describe your idea. The AI initializes the project, creates your outline, and begins drafting chapters.
- **Stay consistent across 100,000 words.** A story bible tracks every character, setting, plot thread, and timeline event. Continuity checking catches contradictions before they become rewrites.
- **Write in your voice.** A style guide captures your tone, POV, tense, influences, and patterns to avoid — so every chapter sounds like *you*, not generic AI.
- **See your book as you write it.** A built-in HTML preview renders your manuscript with beautiful book typography — Playfair Display headings, drop caps, justified text, ornamental dividers. Live-reload as you draft.
- **Export to real formats.** One command compiles your manuscript to clean Markdown or a formatted `.docx` with title page, table of contents, page numbers, and configurable fonts/spacing.
- **Design your cover.** Generate KDP-compliant cover specs with mood, color palettes, typography, and AI image prompts ready for DALL-E, Midjourney, or Stable Diffusion.
- **Build your author profile.** Pull from LinkedIn or write manually — generates polished bios for your back cover and marketing.

## Quick Start

### Install

```bash
git clone https://github.com/anthropics/book-writer-mcp.git
cd book-writer-mcp
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

## Tools Reference

### Manuscript (core workflow)

| Tool | What it does |
|------|-------------|
| `book_init` | Initialize a new book project |
| `book_chapter_create` | Create a new chapter |
| `book_chapter_read` | Read a chapter's content and metadata |
| `book_chapter_update` | Write updated content to a chapter |
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
  chapters/
    ch-001-your-first-chapter.md
    ch-002-the-next-one.md
    ...
  manuscript.md         # Compiled full manuscript
  manuscript.docx       # Formatted Word document
  preview.html          # Static HTML preview
  preview/
    server.js           # Live preview server
```

## The Preview Reader

The built-in preview renders your manuscript as a beautifully typeset book page:

- **Playfair Display** headings with elegant drop caps
- **Source Serif 4** body text, justified with hyphens
- Ornamental bullet dividers between sections
- Cream paper background with subtle shadow
- Fixed word count badge
- Responsive design for reading on any device
- Live auto-refresh when using the preview server

Run `book_preview` for a static HTML file, or `book_preview_server` to get a live-reloading server at `http://localhost:3456`.

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
