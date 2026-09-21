---
name: book-writer-mcp
description: Use when the user is writing a book, novel, or long-form manuscript.
Triggers: "write a book", "new chapter", "story bible", "my manuscript",
"check continuity", "export my book", "add a character", "outline my book".
---

# Book Writer MCP — Claude Code Skill

## Workflow for Starting a New Book
1. `book_init` — initialize project in current directory
2. `book_style_set` — capture voice, tone, POV before writing anything
3. `book_outline_set` — structure before drafting
4. Add key characters via `book_character_add` before Chapter 1

## Workflow for Writing a Chapter
1. `book_style_get` — always load style guide before drafting
2. `book_character_list` — recall who exists
3. `book_plot_threads_list` — check open threads to weave in
4. Draft the chapter content
5. `book_chapter_create` or `book_chapter_update` — save it
6. `book_continuity_check` — run before marking as review/final
7. `book_style_check` — verify voice consistency

## Workflow for Revising the Chapter List
- `book_chapter_rename` — change a chapter title; it also renames the file, the
  heading inside it and the outline entry
- `book_chapter_update title=...` — same rename, when content or status changes
  in the same call
- `book_chapter_delete confirm=true` — remove a chapter; the file is moved to
  `.book-mcp/trash/` and any story bible, timeline or outline reference that is
  left dangling is reported back
- `book_chapter_reorder` — move a chapter to a different position

## Workflow for Exporting
1. `book_stats` — confirm completeness
2. `book_plot_threads_list status=open` — warn author of unresolved threads
3. `book_export_docx` — compile final manuscript

## Important Rules
- ALWAYS load style guide before generating any prose
- NEVER invent character details — always check story bible first
- Run continuity check before marking any chapter "final"
- Keep synopsis fields updated as chapters evolve
- Retitle chapters with book_chapter_rename, never by re-creating them — a new
  chapter gets a new id and orphans the story bible references
- After book_chapter_delete, fix the dangling references it reports
