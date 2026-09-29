---
name: book-writer-mcp
description: Use when the user is writing a book, novel, or long-form manuscript.
Triggers: "write a book", "new chapter", "story bible", "my manuscript",
"check continuity", "export my book", "add a character", "outline my book".
---

# Book Writer MCP — Claude Code Skill

## Workflow for Starting a New Book
1. `book_init` — initialize project in current directory; pass `language`
   (e.g. `"de"`) for any book not written in English
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

## Workflow for Plot Threads
- `book_plot_thread_add` with `keywords` the prose will actually use — the title
  rarely appears in the text
- `book_plot_thread_touch` when a chapter carries a thread without naming it
- `book_plot_thread_update status=abandoned reason=...` for a thread dropped on
  purpose; `book_plot_thread_resolve` when it is resolved
- `book_setting_update` to change a setting; `book_theme_add` for the themes

## Workflow for Revising the Chapter List
- `book_chapter_rename` — change a chapter title; it also renames the file, the
  heading inside it and the outline entry
- `book_chapter_update title=...` — same rename, when content or status changes
  in the same call
- `book_chapter_delete confirm=true` — remove a chapter; the file is moved to
  `.book-mcp/trash/` and any story bible, timeline or outline reference that is
  left dangling is reported back
- `book_chapter_reorder` — move a chapter to a different position

## Workflow for a Small Correction
1. `book_chapter_find` — locate the passage and confirm the phrase is unique
2. `book_chapter_replace_text` — replace just that passage; the rest of the
   chapter is untouched and the previous version is filed automatically
3. `book_chapter_read fromParagraph=... toParagraph=...` — re-read only the
   part that changed, rather than the whole chapter

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

## Workflow for Taking Stock
1. `book_dashboard` — the whole state of the book at once: progress, who appears
   where, story order against chapter order, health findings, readiness
2. `book_dashboard_export` — the same as a page the author can open and keep
   (or `book_preview_server`, which serves it live at /dashboard alongside the
   manuscript at / and updates as chapters are saved)
3. Act on the health findings before drafting more: an open thread or a timeline
   contradiction is cheaper to fix now than after another ten chapters

## Workflow for Exporting
1. `book_stats` — confirm completeness
2. `book_plot_threads_list status=open` — warn author of unresolved threads
3. `book_export_docx` — compile final manuscript for editors and print
4. `book_export_epub` — compile for e-readers and KDP; set `language` and,
   if the book has one, `identifier` to its ISBN

## Workflow for Publishing to KDP
1. `book_cover_checklist` — see what is still missing
2. `book_ai_disclosure_generate` — classify AI use per content type and record
   it; the answer it gives is for the KDP publishing form, not for the book
3. `book_export_epub` — build the file readers will get

## Important Rules
- Set the project language (`book_init language=...` or `book_project_update
  language=...`) before relying on style or continuity checks — they apply the
  rules of that language. If a check reports `checksSkipped` or
  `partially_checked`, tell the author which checks did not run; never present
  that as a clean result
- ALWAYS load style guide before generating any prose
- Check dialogue-heavy passages per character with
  `book_style_check characterId=...`, not just once for the whole passage —
  the global guide cannot tell one speaker from another
- Put words in voice_profile neverSays and verbalTics, not descriptions of
  habits: they are matched literally against dialogue
- NEVER invent character details — always check story bible first
- Run continuity check before marking any chapter "final"
- Keep synopsis fields updated as chapters evolve
- Run book_dashboard when the author asks how the book is going, rather than
  assembling the answer from book_stats and a handful of list calls
- Log dated events with book_timeline_add rather than burying them in a
  character's notes — book_continuity_check can only cross-reference what is on
  the timeline
- Give a timeline event a sortKey whenever the story implies an order; without
  one the event cannot be placed and sorts last
- Retitle chapters with book_chapter_rename, never by re-creating them — a new
  chapter gets a new id and orphans the story bible references
- After book_chapter_delete, fix the dangling references it reports
- NEVER tell an author that AI-assisted work must be disclosed to KDP, or that
  a disclosure belongs in the book's front matter — neither is true. Run
  book_ai_disclosure_generate and pass on what it says, including the date the
  policy was last checked
- NEVER hand-copy a chapter somewhere to keep a backup before rewriting it —
  book_chapter_update already saves the previous version
- NEVER pass a single paragraph to book_chapter_update: it replaces the WHOLE
  chapter, so everything else is lost. For a small edit use
  book_chapter_replace_text, which changes only the passage it matches
- Prefer book_chapter_find + book_chapter_replace_text over re-sending a whole
  chapter; reserve book_chapter_update content=... for a genuine full rewrite
- Offer book_chapter_revert instead of rewriting from memory when the author
  dislikes a revision; the earlier text is still on disk
