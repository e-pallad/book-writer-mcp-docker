export interface Registry {
  title: string;
  author: string;
  genre: string;
  targetWordCount: number;
  createdAt: string;
  updatedAt: string;
  chapters: ChapterMeta[];
}

export interface AuthorProfile {
  name: string;
  linkedinUrl?: string;
  headline?: string;
  location?: string;
  summary?: string;
  experience?: { title: string; company: string; duration?: string }[];
  education?: { school: string; degree?: string; field?: string }[];
  skills?: string[];
  publications?: string[];
  interests?: string[];
  photoUrl?: string;
  generatedIntro?: string;
  generatedIntroShort?: string;
  updatedAt: string;
}

export interface ChapterMeta {
  id: string;
  title: string;
  filename: string;
  status: "outline" | "draft" | "review" | "final";
  wordCount: number;
  order: number;
  synopsis: string;
  updatedAt: string;
}

export interface StoryBible {
  characters: Character[];
  settings: Setting[];
  themes: string[];
  plotThreads: PlotThread[];
  timeline: TimelineEvent[];
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  role: "protagonist" | "antagonist" | "supporting" | "minor";
  description: string;
  backstory: string;
  traits: string[];
  relationships: { characterId: string; nature: string }[];
  firstAppearance: string;
  notes: string;
}

export interface Setting {
  id: string;
  name: string;
  description: string;
  type: "location" | "world" | "organization";
  notes: string;
}

export interface PlotThread {
  id: string;
  title: string;
  status: "open" | "resolved";
  openedIn: string;
  resolvedIn?: string;
  summary: string;
}

export interface TimelineEvent {
  id: string;
  event: string;
  chapterId: string;
  order: number;
}

export interface StyleGuide {
  voice: string;
  pov: string;
  tense: "past" | "present" | "future";
  tone: string;
  targetAudience: string;
  sentenceStyle: string;
  thingsToAvoid: string[];
  recurringMotifs: string[];
  samplePassage: string;
  influences?: AuthorInfluence[];
}

export interface AuthorInfluence {
  author: string;
  works: string[];
  elementsToEmulate: string[];
  notes: string;
}

export interface CoverSpec {
  title: string;
  subtitle?: string;
  authorName: string;
  genre: string;
  targetPlatform: "kindle" | "paperback" | "hardcover" | "all";
  dimensions: CoverDimensions;
  design: CoverDesign;
  backCover?: BackCover;
  spine?: SpineSpec;
}

export interface CoverDimensions {
  widthInches: number;
  heightInches: number;
  dpi: number;
  widthPixels: number;
  heightPixels: number;
  bleedInches: number;
}

export interface CoverDesign {
  mood: string;
  colorPalette: string[];
  typography: {
    titleFont: string;
    subtitleFont?: string;
    authorFont: string;
  };
  imagery: string;
  style: string;
  referenceCovers?: string[];
}

export interface BackCover {
  blurb: string;
  authorBio: string;
  barcodePlacement: "bottom-right" | "bottom-center" | "bottom-left";
  testimonials?: string[];
}

export interface SpineSpec {
  text: string;
  widthInches: number;
}

export interface Outline {
  acts: OutlineAct[];
}

export interface OutlineAct {
  act?: string;
  chapters: OutlineChapter[];
}

export interface OutlineChapter {
  title: string;
  synopsis: string;
  scenes?: string[];
}
