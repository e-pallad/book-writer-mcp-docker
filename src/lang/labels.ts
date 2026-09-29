// The words the exports print — headings, the copyright page, chapter and part
// numbers — in each language the server knows. A language without its own
// falls back to English.

import { Labels } from "./types";

const EN_WORDS = [
  "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen", "Twenty",
];

// Ordinal stems: "Erst" + "es Kapitel" (das Kapitel), + "er Teil" (der Teil).
const DE_ORDINAL_STEMS = [
  "Erst", "Zweit", "Dritt", "Viert", "Fünft", "Sechst", "Siebt", "Acht", "Neunt",
  "Zehnt", "Elft", "Zwölft", "Dreizehnt", "Vierzehnt", "Fünfzehnt", "Sechzehnt",
  "Siebzehnt", "Achtzehnt", "Neunzehnt", "Zwanzigst",
];

export const en: Labels = {
  contents: "Contents",
  by: "by",
  titlePage: "Title page",
  beginning: "Beginning",
  chapter: (n, style) =>
    style === "words" && EN_WORDS[n - 1] ? `Chapter ${EN_WORDS[n - 1]}` : `Chapter ${n}`,
  part: (n) => (EN_WORDS[n - 1] ? `Part ${EN_WORDS[n - 1]}` : `Part ${n}`),
  matter: {
    copyright: "Copyright",
    dedication: "Dedication",
    epigraph: "Epigraph",
    foreword: "Foreword",
    preface: "Preface",
    dramatis_personae: "Dramatis Personae",
    afterword: "Afterword",
    acknowledgements: "Acknowledgements",
    glossary: "Glossary",
    bibliography: "Bibliography",
    about_author: "About the Author",
    also_by: "Also by the Author",
  },
  allRightsReserved: "All rights reserved.",
  firstPublished: "First published",
  editions: { ebook: "eBook", paperback: "Paperback", hardcover: "Hardcover" },
  roles: {
    editor: "Edited by",
    translator: "Translated by",
    illustrator: "Illustrations by",
    cover_designer: "Cover design by",
    foreword: "Foreword by",
    other: "With contributions by",
  },
  seriesVolume: (name, n) => (n !== undefined ? `${name}, Book ${n}` : name),
};

export const de: Labels = {
  contents: "Inhalt",
  by: "von",
  titlePage: "Titelseite",
  beginning: "Beginn",
  chapter: (n, style) =>
    style === "words" && DE_ORDINAL_STEMS[n - 1]
      ? `${DE_ORDINAL_STEMS[n - 1]}es Kapitel`
      : `Kapitel ${n}`,
  part: (n) => (DE_ORDINAL_STEMS[n - 1] ? `${DE_ORDINAL_STEMS[n - 1]}er Teil` : `Teil ${n}`),
  matter: {
    copyright: "Impressum",
    dedication: "Widmung",
    epigraph: "Motto",
    foreword: "Vorwort",
    preface: "Vorbemerkung",
    dramatis_personae: "Personen",
    afterword: "Nachwort",
    acknowledgements: "Danksagung",
    glossary: "Glossar",
    bibliography: "Quellen",
    // Neutral: "Über die Autorin" or "den Autor" needs a gender this server
    // does not know. Override the heading with book_matter_set title=...
    about_author: "Zur Person",
    also_by: "Weitere Bücher",
  },
  allRightsReserved: "Alle Rechte vorbehalten.",
  firstPublished: "Erstausgabe",
  editions: { ebook: "E-Book", paperback: "Taschenbuch", hardcover: "Gebundene Ausgabe" },
  roles: {
    editor: "Lektorat",
    translator: "Übersetzung",
    illustrator: "Illustrationen",
    cover_designer: "Umschlaggestaltung",
    foreword: "Vorwort",
    other: "Mitarbeit",
  },
  seriesVolume: (name, n) => (n !== undefined ? `${name}, Band ${n}` : name),
};
