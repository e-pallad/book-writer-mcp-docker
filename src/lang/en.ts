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
    // Pronouns: "He said" names nobody, exactly as "he said" does.
    "he", "we", "it", "i", "you",
  ],

  weekdays: [["monday"], ["tuesday"], ["wednesday"], ["thursday"], ["friday"], ["saturday"], ["sunday"]],
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

  fillerWords: [
    "just", "really", "very", "quite", "actually", "basically", "somehow",
    "suddenly", "rather", "pretty", "simply", "literally", "totally",
    "seemingly", "almost", "nearly", "slightly", "somewhat", "perhaps",
    "maybe", "started to", "began to", "a bit", "a little", "kind of", "sort of",
  ],
  stopWords: [
    "the", "a", "an", "and", "or", "but", "not", "no", "nor", "i", "you", "he",
    "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
    "his", "its", "our", "their", "this", "that", "these", "those", "is", "was",
    "are", "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "will", "would", "can", "could", "should", "shall", "may", "might",
    "must", "to", "of", "in", "on", "at", "by", "for", "with", "from", "as",
    "into", "about", "than", "then", "there", "here", "what", "which", "who",
    "whom", "whose", "when", "where", "why", "how", "all", "any", "some",
    "more", "most", "so", "too", "very", "just", "also", "only", "said", "says",
    "out", "up", "down", "over", "back", "again", "one", "if", "like",
    "yes", "yet", "off", "now", "get", "got", "let", "say", "see", "two", "own",
    "way", "did", "any", "how", "who", "why", "her", "him", "our", "its",
  ],
  longSentence: 35,
  adverbSuffix: "ly",
};
