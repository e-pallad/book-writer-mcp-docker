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
4. `book_timeline_list` — check when this chapter sits relative to what is
   already logged, so the draft does not contradict it
5. Draft the chapter content
6. `book_chapter_create` or `book_chapter_update` — save it
7. `book_timeline_add` — log what happened and when, while it is fresh
8. `book_continuity_check` — run before marking as review/final
9. `book_style_check` — verify voice consistency; pass characterId to check
   a character's dialogue against their own voice profile as well

## Workflow for Revising the Chapter List
- `book_chapter_rename` — change a chapter title; it also renames the file, the
  heading inside it and the outline entry
- `book_chapter_update title=...` — same rename, when content or status changes
  in the same call
- `book_chapter_delete confirm=true` — remove a chapter; the file is moved to
  `.book-mcp/trash/` and any story bible, timeline or outline reference that is
  left dangling is reported back
- `book_chapter_reorder` — move a chapter to a different position

## Workflow for Revising a Chapter
1. `book_chapter_history_list` — see what earlier versions exist and how far
   each one is from the current text
2. Draft the revision and save it with `book_chapter_update content=...` — the
   previous prose is filed away automatically, no separate step needed
3. `book_chapter_diff` — show the author what the revision actually changed,
   rather than making them compare two full drafts
4. `book_chapter_revert chapterId=... timestamp=...` — restore an earlier
   version if the revision went the wrong way; the text it replaces is saved
   first, so the revert can itself be reverted

## Workflow for Exporting
1. `book_stats` — confirm completeness
2. `book_plot_threads_list status=open` — warn author of unresolved threads
3. `book_export_docx` — compile final manuscript for editors and print
4. `book_export_epub` — compile for e-readers and KDP; set `language` and,
   if the book has one, `identifier` to its ISBN

## Important Rules
- ALWAYS load style guide before generating any prose
- Check dialogue-heavy passages per character with
  `book_style_check characterId=...`, not just once for the whole passage —
  the global guide cannot tell one speaker from another
- Put words in voice_profile neverSays and verbalTics, not descriptions of
  habits: they are matched literally against dialogue
- NEVER invent character details — always check story bible first
- Run continuity check before marking any chapter "final"
- Keep synopsis fields updated as chapters evolve
- Log dated events with book_timeline_add rather than burying them in a
  character's notes — book_continuity_check can only cross-reference what is on
  the timeline
- Give a timeline event a sortKey whenever the story implies an order; without
  one the event cannot be placed and sorts last
- Retitle chapters with book_chapter_rename, never by re-creating them — a new
  chapter gets a new id and orphans the story bible references
- After book_chapter_delete, fix the dangling references it reports
- NEVER hand-copy a chapter somewhere to keep a backup before rewriting it —
  book_chapter_update already saves the previous version
- Offer book_chapter_revert instead of rewriting from memory when the author
  dislikes a revision; the earlier text is still on disk
