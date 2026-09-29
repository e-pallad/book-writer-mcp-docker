import { LanguageRules } from "./types";

export const en: LanguageRules = {
  code: "en",
  name: "English",

  presentTense:
    /\b(?:he says|she says|they say|I say|he walks|she walks|they walk|I walk|he runs|she runs)\b/gi,
  pastTense:
    /\b(?:he said|she said|they said|I said|he walked|she walked|they walked|I walked)\b/gi,
  firstPersonThought: /\b(?:I thought|I felt|I knew|I wondered)\b/gi,
  thirdPersonThought: /\b(?:he thought|she thought|he felt|she felt|he knew|she knew)\b/gi,
  passive: /\b(?:was|were|is|are|been|being)\s+\w+ed\b/gi,

  speechVerbs: [
    "said", "says", "asked", "asks", "replied", "replies", "whispered",
    "whispers", "shouted", "shouts", "muttered", "mutters", "answered",
    "answers", "called", "calls", "added", "adds", "snapped", "snaps",
    "growled", "growls", "murmured", "murmurs", "breathed", "offered",
  ],
  determiners: [],
  notNames: [
    "the", "and", "but", "for", "not", "you", "all", "can", "had", "her",
    "was", "one", "our", "out", "are", "has", "his", "how", "its", "may",
    "new", "now", "old", "see", "way", "who", "did", "get", "let", "say",
    "she", "too", "use", "chapter", "scene", "part", "then", "than",
    "that", "this", "with", "have", "from", "they", "been", "said",
    "each", "make", "like", "long", "look", "many", "some", "them",
    "into", "time", "very", "when", "come", "just", "know", "take",
    "people", "could", "would", "about", "after", "before", "where",
    "should", "still", "their", "there", "these", "those", "being",
    "first", "never", "other", "right", "think", "which", "while",
    "back", "down", "even", "here", "much", "only", "over", "such",
    "well", "what", "will", "also", "more", "must", "most", "went",
  ],

  weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  dayParts: {
    morning: ["morning", "dawn", "sunrise", "daybreak"],
    afternoon: ["afternoon", "midday", "noon"],
    evening: ["evening", "dusk", "sunset", "twilight"],
    night: ["night", "midnight", "small hours"],
  },

  traitOpposites: {
    tall: ["short", "small", "tiny", "petite"],
    short: ["tall", "towering", "giant"],
    old: ["young", "youthful", "teenage"],
    young: ["old", "elderly", "aged", "ancient"],
    thin: ["fat", "heavy", "obese", "large"],
    fat: ["thin", "slim", "slender", "skinny"],
    blonde: ["brunette", "dark-haired", "black-haired", "redhead"],
    brunette: ["blonde", "fair-haired", "redhead"],
  },
  adjectiveEndings: [],
};
