// Story structures and where their turning points fall. The positions are the
// conventional ones — a share of the whole book — and the check treats them as
// that: a guide with a tolerance, not a rule. A midpoint at 45% is a midpoint.

export interface Beat {
  id: string;
  name: { en: string; de: string };
  /** Where the beat conventionally falls, as a share of the book (0–1). */
  position: number;
  description: { en: string; de: string };
}

export interface StructureTemplate {
  id: string;
  name: { en: string; de: string };
  source: string;
  beats: Beat[];
}

const beat = (
  id: string,
  en: string,
  de: string,
  position: number,
  descEn: string,
  descDe: string
): Beat => ({ id, name: { en, de }, position, description: { en: descEn, de: descDe } });

export const TEMPLATES: StructureTemplate[] = [
  {
    id: "three_act",
    name: { en: "Three-act structure", de: "Drei-Akt-Struktur" },
    source: "Syd Field, Screenplay (1979)",
    beats: [
      beat("inciting_incident", "Inciting incident", "Auslösendes Ereignis", 0.12, "The event that disturbs the ordinary world.", "Das Ereignis, das die Ausgangslage stört."),
      beat("plot_point_1", "Plot point 1", "Erster Wendepunkt", 0.25, "The protagonist commits; act two begins.", "Die Hauptfigur legt sich fest; der zweite Akt beginnt."),
      beat("midpoint", "Midpoint", "Mittelpunkt", 0.5, "A reversal or revelation that changes the stakes.", "Eine Umkehr oder Enthüllung, die den Einsatz verändert."),
      beat("plot_point_2", "Plot point 2", "Zweiter Wendepunkt", 0.75, "The lowest point turns into the final push; act three begins.", "Der Tiefpunkt kippt in den Endspurt; der dritte Akt beginnt."),
      beat("climax", "Climax", "Höhepunkt", 0.9, "The decisive confrontation.", "Die entscheidende Konfrontation."),
      beat("resolution", "Resolution", "Auflösung", 0.98, "The new equilibrium.", "Das neue Gleichgewicht."),
    ],
  },
  {
    id: "heros_journey",
    name: { en: "Hero's journey", de: "Heldenreise" },
    source: "Christopher Vogler, The Writer's Journey (1992), after Joseph Campbell",
    beats: [
      beat("ordinary_world", "Ordinary world", "Gewohnte Welt", 0.03, "The hero at home, before it begins.", "Die Heldin, der Held in der gewohnten Welt."),
      beat("call_to_adventure", "Call to adventure", "Ruf des Abenteuers", 0.08, "The challenge appears.", "Die Herausforderung zeigt sich."),
      beat("refusal", "Refusal of the call", "Weigerung", 0.12, "Fear, doubt, reluctance.", "Angst, Zweifel, Zögern."),
      beat("mentor", "Meeting the mentor", "Begegnung mit dem Mentor", 0.17, "Advice, a gift, training.", "Rat, eine Gabe, Vorbereitung."),
      beat("threshold", "Crossing the threshold", "Überschreiten der Schwelle", 0.25, "Into the special world.", "Hinein in die fremde Welt."),
      beat("tests_allies_enemies", "Tests, allies, enemies", "Prüfungen, Verbündete, Feinde", 0.35, "Learning the rules of the new world.", "Die Regeln der neuen Welt lernen."),
      beat("approach", "Approach to the inmost cave", "Vordringen zur tiefsten Höhle", 0.45, "Preparing for the central ordeal.", "Vorbereitung auf die entscheidende Prüfung."),
      beat("ordeal", "The ordeal", "Die entscheidende Prüfung", 0.5, "Facing death, literally or figuratively.", "Konfrontation mit dem Tod, wörtlich oder im Bild."),
      beat("reward", "Reward", "Belohnung", 0.6, "Seizing the sword.", "Den Schatz ergreifen."),
      beat("road_back", "The road back", "Der Rückweg", 0.75, "Consequences follow the hero home.", "Die Folgen verfolgen die Heldin, den Helden."),
      beat("resurrection", "Resurrection", "Auferstehung", 0.9, "The final test, and transformation.", "Die letzte Prüfung, die Verwandlung."),
      beat("return_with_elixir", "Return with the elixir", "Rückkehr mit dem Elixier", 0.98, "Home, changed, bringing something back.", "Heimkehr, verändert, mit etwas im Gepäck."),
    ],
  },
  {
    id: "save_the_cat",
    name: { en: "Save the Cat beat sheet", de: "Save the Cat (Beat Sheet)" },
    source: "Blake Snyder, Save the Cat! (2005); Jessica Brody, Save the Cat! Writes a Novel (2018)",
    beats: [
      beat("opening_image", "Opening image", "Eröffnungsbild", 0.01, "A snapshot of the 'before'.", "Eine Momentaufnahme des Vorher."),
      beat("theme_stated", "Theme stated", "Thema benannt", 0.05, "Someone hints at what the hero must learn.", "Jemand deutet an, was die Hauptfigur lernen muss."),
      beat("catalyst", "Catalyst", "Katalysator", 0.1, "The life-changing event.", "Das Ereignis, das alles verändert."),
      beat("debate", "Debate", "Zögern", 0.17, "Should I go?", "Soll ich?"),
      beat("break_into_two", "Break into two", "Schritt in den zweiten Akt", 0.2, "The hero chooses to act.", "Die Hauptfigur entscheidet sich zu handeln."),
      beat("b_story", "B story", "B-Handlung", 0.22, "A new relationship that carries the theme.", "Eine neue Beziehung, die das Thema trägt."),
      beat("fun_and_games", "Fun and games", "Versprechen der Prämisse", 0.35, "The promise of the premise.", "Die Prämisse wird eingelöst."),
      beat("midpoint", "Midpoint", "Mittelpunkt", 0.5, "False victory or false defeat; stakes rise.", "Scheinsieg oder Scheinniederlage; der Einsatz steigt."),
      beat("bad_guys_close_in", "Bad guys close in", "Die Gegner rücken näher", 0.62, "Doubt, jealousy, the enemy regroups.", "Zweifel, Zwist, der Gegner formiert sich."),
      beat("all_is_lost", "All is lost", "Alles ist verloren", 0.75, "The lowest point, a whiff of death.", "Der Tiefpunkt, ein Hauch von Tod."),
      beat("dark_night", "Dark night of the soul", "Dunkle Nacht der Seele", 0.78, "Wallowing, then the realisation.", "Verzweiflung, dann die Erkenntnis."),
      beat("break_into_three", "Break into three", "Schritt in den dritten Akt", 0.8, "The solution, from the B story.", "Die Lösung, aus der B-Handlung."),
      beat("finale", "Finale", "Finale", 0.9, "The hero proves the lesson learned.", "Die Hauptfigur zeigt, was sie gelernt hat."),
      beat("final_image", "Final image", "Schlussbild", 0.99, "The 'after', mirroring the opening.", "Das Nachher, als Spiegel des Anfangs."),
    ],
  },
  {
    id: "freytag",
    name: { en: "Freytag's pyramid", de: "Freytags Pyramide" },
    source: "Gustav Freytag, Die Technik des Dramas (1863)",
    beats: [
      beat("exposition", "Exposition", "Exposition", 0.1, "Characters, place, situation.", "Figuren, Ort, Ausgangslage."),
      beat("rising_action", "Rising action", "Steigende Handlung", 0.3, "Complications build.", "Die Verwicklungen nehmen zu."),
      beat("climax", "Climax", "Höhepunkt", 0.5, "The turning point of fortune.", "Der Umschlag des Geschicks."),
      beat("falling_action", "Falling action", "Fallende Handlung", 0.7, "Consequences unfold; a last moment of suspense.", "Die Folgen entfalten sich; ein letztes retardierendes Moment."),
      beat("denouement", "Catastrophe / denouement", "Katastrophe / Lösung", 0.92, "The ending.", "Der Ausgang."),
    ],
  },
  {
    id: "seven_point",
    name: { en: "Seven-point structure", de: "Sieben-Punkte-Struktur" },
    source: "Dan Wells, after the Star Wars roleplaying game guide",
    beats: [
      beat("hook", "Hook", "Aufhänger", 0.02, "The starting state, opposite of the resolution.", "Die Ausgangslage, das Gegenteil der Auflösung."),
      beat("plot_turn_1", "Plot turn 1", "Erster Wendepunkt", 0.2, "The call to action.", "Der Anstoß zu handeln."),
      beat("pinch_1", "Pinch 1", "Erster Druckpunkt", 0.35, "Pressure: the antagonist shows its strength.", "Druck: der Gegner zeigt seine Stärke."),
      beat("midpoint", "Midpoint", "Mittelpunkt", 0.5, "From reaction to action.", "Von der Reaktion zur Aktion."),
      beat("pinch_2", "Pinch 2", "Zweiter Druckpunkt", 0.65, "More pressure; things fall apart.", "Mehr Druck; alles bricht zusammen."),
      beat("plot_turn_2", "Plot turn 2", "Zweiter Wendepunkt", 0.8, "The last piece of the solution.", "Das letzte Stück der Lösung."),
      beat("resolution", "Resolution", "Auflösung", 0.98, "The climax and the end state.", "Der Höhepunkt und der Endzustand."),
    ],
  },
];

export function templateById(id: string): StructureTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** How far a beat may sit from its conventional place before it is mentioned. */
export const DEFAULT_TOLERANCE = 0.07;
