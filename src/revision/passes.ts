// The passes of a classic revision and what each looks at. Large before small:
// polishing the sentences of a scene that the structural pass will cut is
// wasted work, which is why the order matters and the status says when it was
// not kept.

import { ChapterMeta, RevisionPass } from "../storage/schema";

export const PASSES: RevisionPass[] = ["structural", "line", "copy", "proof"];

interface PassInfo {
  name: { en: string; de: string };
  checklist: { en: string[]; de: string[] };
  /** The tools that help with this pass. */
  tools: string[];
}

export const PASS_INFO: Record<RevisionPass, PassInfo> = {
  structural: {
    name: { en: "Structural edit", de: "Strukturelle Überarbeitung (Entwicklungslektorat)" },
    checklist: {
      en: [
        "Does the chapter move the story — a plot thread, an arc, a question — or could it be cut or merged?",
        "Does every scene have a point-of-view character with a goal, a conflict and an outcome?",
        "Does the chapter start as late and end as early as it can?",
        "Are the turning points where the structure needs them?",
        "Is anything planned missing, or anything written unplanned?",
        "Are open threads carried, resolved, or dropped on purpose?",
        "Does the timeline hold?",
      ],
      de: [
        "Bringt das Kapitel die Geschichte voran — einen Handlungsstrang, einen Figurenbogen, eine Frage — oder kann es weg oder mit einem anderen verschmelzen?",
        "Hat jede Szene eine Perspektivfigur mit Ziel, Konflikt und Ausgang?",
        "Beginnt das Kapitel so spät und endet so früh wie möglich?",
        "Sitzen die Wendepunkte dort, wo die Struktur sie braucht?",
        "Fehlt Geplantes, oder steht Ungeplantes da?",
        "Werden offene Handlungsstränge weitergeführt, aufgelöst oder bewusst fallen gelassen?",
        "Stimmt die Zeitleiste?",
      ],
    },
    tools: ["book_scene_list", "book_structure_check", "book_outline_compare", "book_plot_threads_list", "book_continuity_check"],
  },
  line: {
    name: { en: "Line edit", de: "Stilistische Überarbeitung (Stillektorat)" },
    checklist: {
      en: [
        "Does every sentence earn its place?",
        "Filler words, echoes, and sentences all of one length.",
        "Show what can be shown; tell what only needs telling.",
        "Does each character sound like themselves?",
        "Dialogue tags: 'said' mostly, and none where it is clear who speaks.",
        "Clichés and the book's own tics (the style guide's things to avoid).",
      ],
      de: [
        "Verdient jeder Satz seinen Platz?",
        "Füllwörter, Wortwiederholungen, Sätze von immer gleicher Länge.",
        "Zeigen, was sich zeigen lässt; erzählen, was nur erzählt werden muss.",
        "Klingt jede Figur nach sich selbst?",
        "Redebegleitsätze: meist „sagte“, keiner, wo klar ist, wer spricht.",
        "Floskeln und die eigenen Marotten (die Tabus im Stilguide).",
      ],
    },
    tools: ["book_prose_check", "book_style_check"],
  },
  copy: {
    name: { en: "Copy edit", de: "Korrektorat" },
    checklist: {
      en: [
        "Spelling, grammar, punctuation.",
        "One spelling for each word the style sheet names.",
        "Names, places and dates the same everywhere.",
        "Numbers written the same way throughout.",
        "One kind of quotation mark, typographic, not typewriter.",
        "No placeholders left.",
      ],
      de: [
        "Rechtschreibung, Grammatik, Zeichensetzung.",
        "Eine Schreibweise für jedes Wort im Stylesheet.",
        "Namen, Orte und Daten überall gleich.",
        "Zahlen durchgehend gleich geschrieben.",
        "Eine Sorte Anführungszeichen, typografisch, nicht die der Schreibmaschine.",
        "Keine Platzhalter mehr.",
      ],
    },
    tools: ["book_stylesheet_check", "book_todo_list", "book_find"],
  },
  proof: {
    name: { en: "Proofread", de: "Schlusskorrektur (Fahnenkorrektur)" },
    checklist: {
      en: [
        "Typos and missing words the earlier passes introduced.",
        "Chapter titles, numbers and the contents agree.",
        "Scene breaks where they belong.",
        "Front and back matter complete and current.",
        "Read it in the exported format, not the draft.",
      ],
      de: [
        "Tippfehler und fehlende Wörter, die frühere Durchgänge hinterlassen haben.",
        "Kapiteltitel, Nummerierung und Inhaltsverzeichnis stimmen überein.",
        "Szenentrenner an der richtigen Stelle.",
        "Titelei und Anhang vollständig und aktuell.",
        "Im exportierten Format lesen, nicht im Entwurf.",
      ],
    },
    tools: ["book_preview", "book_export_epub", "book_matter_list"],
  },
};

/** Passes a chapter has done. */
export function donePasses(chapter: ChapterMeta): Set<RevisionPass> {
  return new Set((chapter.passes ?? []).map((p) => p.pass));
}

/** Passes marked on a chapter before an earlier one — copy edited, but not yet structurally. */
export function passesOutOfOrder(chapter: ChapterMeta): RevisionPass[] {
  const done = donePasses(chapter);
  return PASSES.filter((pass, i) => done.has(pass) && PASSES.slice(0, i).some((earlier) => !done.has(earlier)));
}
