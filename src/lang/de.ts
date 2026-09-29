import { LanguageRules } from "./types";

// Whole words, Unicode-aware: \b is ASCII-only, so /weiß\b/ never matches —
// there is no word boundary between "ß" and a space as far as \b knows.
function words(list: string[], flags = "giu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${list.join("|")})(?![\\p{L}\\p{N}_])`, flags);
}

const PRONOUNS = ["er", "sie", "es", "man", "ich"];
const THIRD = ["er", "sie", "es", "man"];

// Narrative verbs in the present and the preterite, third and first person.
// Only verbs that turn up in almost every chapter of narration, so a stray
// present-tense sentence in a past-tense book is caught without a grammar.
const PRESENT = [
  "sagt", "fragt", "geht", "läuft", "sieht", "steht", "kommt", "denkt", "weiß",
  "nimmt", "dreht", "schaut", "blickt", "lächelt", "nickt", "öffnet", "setzt",
  "hört", "spürt", "wartet", "greift", "zieht", "hebt", "legt",
];
const PRESENT_FIRST = [
  "sage", "frage", "gehe", "laufe", "sehe", "stehe", "komme", "denke", "nehme",
  "drehe", "schaue", "blicke", "lächle", "nicke", "öffne", "setze", "höre", "spüre",
  "warte", "greife", "ziehe", "hebe", "lege",
];
const PAST = [
  "sagte", "fragte", "ging", "lief", "sah", "stand", "kam", "dachte", "wusste",
  "nahm", "drehte", "schaute", "blickte", "lächelte", "nickte", "öffnete", "setzte",
  "hörte", "spürte", "wartete", "griff", "zog", "hob", "legte",
];

function pronounVerb(pronouns: string[], verbs: string[]): string[] {
  const v = verbs.join("|");
  const p = pronouns.join("|");
  // "sie geht" and, far more common in German narration, "dann geht sie".
  return [`(?:${p})\\s+(?:${v})`, `(?:${v})\\s+(?:${p})`];
}

const THOUGHT_VERBS_PAST = ["dachte", "fühlte", "wusste", "ahnte", "spürte", "fragte sich"];
const THOUGHT_VERBS_PRESENT = ["denke", "fühle", "weiß", "ahne", "spüre", "frage mich"];

export const de: LanguageRules = {
  code: "de",
  name: "German",

  presentTense: words([
    ...pronounVerb(THIRD, PRESENT),
    ...pronounVerb(["ich"], PRESENT_FIRST),
  ]),
  pastTense: words(pronounVerb(PRONOUNS, PAST)),
  firstPersonThought: words([
    ...THOUGHT_VERBS_PAST.map((v) => {
      const [verb, reflexive] = v.split(" ");
      return reflexive
        ? `ich\\s+${verb}\\s+mich|${verb}\\s+ich\\s+mich`
        : `ich\\s+${verb}|${verb}\\s+ich`;
    }),
    ...THOUGHT_VERBS_PRESENT.map((v) => {
      const [verb, reflexive] = v.split(" ");
      return reflexive ? `ich\\s+${verb}\\s+${reflexive}` : `ich\\s+${verb}|${verb}\\s+ich`;
    }),
  ]),
  thirdPersonThought: words(
    THOUGHT_VERBS_PAST.map((v) => {
      const [verb, reflexive] = v.split(" ");
      return reflexive
        ? `(?:er|sie)\\s+${verb}\\s+sich|${verb}\\s+(?:er|sie)\\s+sich`
        : `(?:er|sie)\\s+${verb}|${verb}\\s+(?:er|sie)`;
    })
  ),
  // "wurde … geöffnet", "wurden gerufen", "ist gesehen worden": a form of
  // werden, up to five words, then a participle with ge-. Participles without
  // ge- ("verkauft", "erzählt") are missed on purpose — the check is a nudge,
  // and a miss costs less than a false alarm.
  passive: words([
    "(?:wurde|wurden|wurdest|wurdet|wird|werden|worden)(?:\\s+[\\p{L}-]+){0,5}?\\s+ge\\p{L}+(?:t|en)",
  ]),

  speechVerbs: [
    "sagte", "sagt", "fragte", "fragt", "antwortete", "antwortet", "flüsterte",
    "flüstert", "rief", "ruft", "murmelte", "murmelt", "meinte", "meint",
    "erwiderte", "erwidert", "entgegnete", "entgegnet", "schrie", "schreit",
    "brüllte", "brüllt", "knurrte", "knurrt", "seufzte", "seufzt", "zischte",
    "zischt", "raunte", "raunt", "stammelte", "stammelt", "wisperte", "wispert",
    "sprach", "spricht", "erklärte", "erklärt", "bemerkte", "bemerkt",
    "fügte", "fügt", "lachte", "lacht",
  ],
  determiners: [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines",
    "einem", "einen", "kein", "keine", "keinen", "keinem", "mein", "meine",
    "dein", "deine", "sein", "seine", "ihr", "ihre", "unser", "unsere", "euer",
    "eure", "dieser", "diese", "dieses", "jener", "jene", "jeder", "jede",
    "welcher", "welche", "alle", "beide", "manche",
    // Prepositions, and the ones fused with an article: the capitalised word
    // after "am" or "mit" is the object of a phrase, never the one speaking
    // ("die Frau am Tresen sagte").
    "am", "im", "vom", "zum", "zur", "beim", "ans", "ins", "aufs", "durchs",
    "fürs", "ums", "übers", "an", "auf", "aus", "bei", "mit", "nach", "von",
    "zu", "in", "über", "unter", "vor", "hinter", "neben", "zwischen", "für",
    "gegen", "ohne", "um", "durch",
  ],
  invertedSubjectPronouns: ["er", "sie", "es", "ich", "du", "wir", "ihr", "man"],
  // Capitalised at the start of a sentence, right before a verb of speech —
  // "Dann sagte er" — and never anyone's name.
  notNames: [
    "dann", "da", "nun", "jetzt", "so", "doch", "aber", "und", "oder", "als",
    "wie", "was", "wer", "wo", "warum", "weshalb", "nein", "ja", "gut", "also",
    "später", "danach", "schließlich", "plötzlich", "leise", "laut", "schnell",
    "endlich", "trotzdem", "deshalb", "darauf", "dazu", "hier", "dort", "heute",
    "gestern", "morgen", "sie", "er", "es", "ich", "du", "wir", "ihr", "man",
    "zuerst", "noch", "nur", "auch", "schon", "wieder", "kurz", "erst", "immer",
    "niemand", "jemand", "keiner", "einer", "alle", "beide", "sofort", "hastig",
    "ruhig", "leiser", "lauter", "zögernd", "ernst", "müde", "wütend",
  ],

  weekdays: [
    ["montag"],
    ["dienstag"],
    ["mittwoch"],
    ["donnerstag"],
    ["freitag"],
    ["samstag", "sonnabend"],
    ["sonntag"],
  ],
  // Not bare "morgen": lowercased, it cannot be told apart from "tomorrow".
  dayParts: {
    morning: ["morgens", "am morgen", "frühmorgens", "morgengrauen", "morgendämmerung", "tagesanbruch", "sonnenaufgang", "vormittag", "vormittags"],
    afternoon: ["nachmittag", "nachmittags", "mittag", "mittags", "mittagszeit"],
    evening: ["abend", "abends", "abenddämmerung", "sonnenuntergang", "abendrot"],
    night: ["nacht", "nachts", "mitternacht", "mitternachts"],
  },

  traitOpposites: {
    groß: ["klein", "winzig", "zierlich"],
    klein: ["groß", "riesig", "hochgewachsen", "hünenhaft"],
    alt: ["jung", "jugendlich"],
    jung: ["alt", "betagt", "greis"],
    dünn: ["dick", "korpulent", "fett", "beleibt"],
    schlank: ["dick", "korpulent", "fett", "beleibt", "rundlich"],
    hager: ["dick", "korpulent", "rundlich"],
    dick: ["dünn", "schlank", "hager", "mager"],
    blond: ["dunkelhaarig", "schwarzhaarig", "brünett", "rothaarig"],
    brünett: ["blond", "rothaarig"],
    dunkelhaarig: ["blond", "rothaarig", "hellhaarig"],
    schwarzhaarig: ["blond", "rothaarig"],
    rothaarig: ["blond", "dunkelhaarig", "schwarzhaarig"],
  },
  adjectiveEndings: ["e", "er", "es", "en", "em"],
  // Adjectives are lowercase in German, nouns are not: matching case-
  // sensitively keeps "alt" from finding the noun "Alter".
  adjectivesLowercase: true,

  fillerWords: [
    "eigentlich", "irgendwie", "halt", "eben", "mal", "wohl", "gerade",
    "einfach", "wirklich", "ziemlich", "total", "echt", "quasi", "sozusagen",
    "gewissermaßen", "durchaus", "natürlich", "bereits", "nämlich", "etwa",
    "ohnehin", "sowieso", "überhaupt", "plötzlich", "sehr", "ganz", "etwas",
    "bisschen", "irgendwann", "irgendwo", "eher", "relativ", "offenbar",
    "offensichtlich", "scheinbar", "allerdings", "jedenfalls", "fast",
    "beinahe", "fing an", "begann zu",
  ],
  stopWords: [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines",
    "einem", "einen", "und", "oder", "aber", "doch", "nicht", "kein", "keine",
    "keinen", "ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "mir",
    "dich", "dir", "sich", "ihn", "ihm", "ihnen", "uns", "euch", "sein",
    "seine", "seinen", "seinem", "seiner", "ihre", "ihren", "ihrem", "ihrer",
    "mein", "meine", "dein", "deine", "unser", "euer", "dass", "als", "wie",
    "wenn", "weil", "ob", "zu", "zum", "zur", "im", "in", "an", "am", "auf",
    "aus", "bei", "mit", "nach", "von", "vor", "über", "unter", "um", "durch",
    "für", "gegen", "ohne", "bis", "seit", "ist", "war", "sind", "waren",
    "hat", "hatte", "haben", "hatten", "wird", "wurde", "werden", "wurden",
    "kann", "konnte", "muss", "musste", "soll", "sollte", "will", "wollte",
    "noch", "nur", "auch", "schon", "so", "da", "dann", "dort", "hier",
    "jetzt", "nun", "was", "wer", "wo", "man", "alle", "alles", "etwas",
    "nichts", "mehr", "sehr", "denn", "ja", "nein", "sagte", "sagt", "einmal",
    "wieder", "immer", "diese", "dieser", "dieses", "diesen", "diesem", "jede",
    "jeder", "jedes", "welche", "welcher", "zwei", "drei", "hin", "her",
    "gar", "los", "mal", "ihm", "ihn", "wie", "wer", "des", "vom", "ins", "ans",
  ],
  longSentence: 40,
};
