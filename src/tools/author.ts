import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getRegistry,
  getAuthorProfile,
  saveAuthorProfile,
} from "../storage/filestore";
import { AuthorProfile } from "../storage/schema";
import { BookMCPError } from "../utils/errors";
import { decodeHtmlEntities } from "../utils/text";

async function fetchLinkedInProfile(url: string): Promise<Partial<AuthorProfile>> {
  // Normalize the URL
  const cleanUrl = url.replace(/\/$/, "");

  // Try fetching the public LinkedIn page
  // LinkedIn returns limited data for public profiles, but enough for a bio
  try {
    const response = await fetch(cleanUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return { linkedinUrl: cleanUrl };
    }

    const html = await response.text();

    // Extract data from meta tags and structured data
    const extracted: Partial<AuthorProfile> = { linkedinUrl: cleanUrl };

    // og:title usually has "Name - Title - Company"
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:title"/);
    if (ogTitle) {
      // Meta attributes are HTML-encoded, so "Jörg" arrives as "J&ouml;rg".
      const parts = decodeHtmlEntities(ogTitle[1]).split(" - ");
      extracted.name = parts[0]?.trim();
      if (parts[1]) extracted.headline = parts.slice(1).join(" - ").trim();
    }

    // og:description often has the summary
    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/) ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:description"/);
    if (ogDesc) {
      extracted.summary = decodeHtmlEntities(ogDesc[1]).trim();
    }

    // og:image for photo
    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/) ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/);
    if (ogImage) {
      extracted.photoUrl = decodeHtmlEntities(ogImage[1]).trim();
    }

    // Try to extract from JSON-LD if available
    const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonLd) {
      try {
        const data = JSON.parse(jsonLd[1]);
        if (data["@type"] === "Person" || data["@type"] === "ProfilePage") {
          const person = data["@type"] === "ProfilePage" ? data.mainEntity : data;
          if (person) {
            extracted.name = extracted.name || person.name;
            extracted.summary = extracted.summary || person.description;
            if (person.address) {
              extracted.location = typeof person.address === "string"
                ? person.address
                : person.address.addressLocality;
            }
            if (person.alumniOf) {
              const schools = Array.isArray(person.alumniOf)
                ? person.alumniOf
                : [person.alumniOf];
              extracted.education = schools.map((s: { name?: string }) => ({
                school: s.name || String(s),
              }));
            }
            if (person.worksFor) {
              const orgs = Array.isArray(person.worksFor)
                ? person.worksFor
                : [person.worksFor];
              extracted.experience = orgs.map((o: { name?: string; member?: { roleName?: string } }) => ({
                title: o.member?.roleName || "",
                company: o.name || String(o),
              }));
            }
          }
        }
      } catch {
        // JSON-LD parse failed, continue with meta tags
      }
    }

    // location from meta
    const geoRegion = html.match(/<meta[^>]*name="geo\.region"[^>]*content="([^"]*)"/) ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*name="geo\.region"/);
    if (geoRegion) {
      extracted.location = extracted.location || decodeHtmlEntities(geoRegion[1]).trim();
    }

    return extracted;
  } catch (error) {
    // Fetch failed — return URL only so manual data can be added
    return { linkedinUrl: cleanUrl };
  }
}

function generateAuthorIntro(profile: AuthorProfile, genre: string, bookTitle: string): { full: string; short: string } {
  const parts: string[] = [];
  const name = profile.name;

  // Opening with headline/role
  if (profile.headline) {
    parts.push(`${name} is ${addArticle(profile.headline)}.`);
  } else if (profile.experience && profile.experience.length > 0) {
    const current = profile.experience[0];
    parts.push(`${name} is ${addArticle(current.title)} at ${current.company}.`);
  } else {
    parts.push(`${name} is the author of *${bookTitle}*.`);
  }

  // Background/experience
  if (profile.experience && profile.experience.length > 1) {
    const notable = profile.experience.slice(0, 3);
    const companies = notable.map((e) => e.company).filter(Boolean);
    if (companies.length > 0) {
      parts.push(
        `With a career spanning roles at ${joinList(companies)}, ${firstName(name)} brings a wealth of real-world experience to ${pronoun(name)} writing.`
      );
    }
  }

  // Education
  if (profile.education && profile.education.length > 0) {
    const edu = profile.education[0];
    if (edu.degree && edu.field) {
      parts.push(
        `${firstName(name)} holds a ${edu.degree} in ${edu.field} from ${edu.school}.`
      );
    } else if (edu.school) {
      parts.push(`${firstName(name)} studied at ${edu.school}.`);
    }
  }

  // Summary/about — weave it in
  if (profile.summary) {
    // Take first sentence or two from summary if it's not too long
    const sentences = profile.summary.split(/\.\s+/);
    const relevant = sentences.slice(0, 2).join(". ");
    if (relevant.length < 300) {
      parts.push(relevant + (relevant.endsWith(".") ? "" : "."));
    }
  }

  // Location
  if (profile.location) {
    parts.push(`${firstName(name)} is based in ${profile.location}.`);
  }

  // Skills connection to genre
  if (profile.skills && profile.skills.length > 0) {
    const topSkills = profile.skills.slice(0, 3);
    parts.push(
      `${pronounCap(name)} expertise in ${joinList(topSkills)} deeply informs the ${genre} storytelling in *${bookTitle}*.`
    );
  }

  // Publications
  if (profile.publications && profile.publications.length > 0) {
    parts.push(
      `${firstName(name)} is also the author of ${joinList(profile.publications.map((p) => `*${p}*`))}.`
    );
  }

  // Closing
  parts.push(`*${bookTitle}* is ${firstName(name)}'s ${profile.publications && profile.publications.length > 0 ? "latest" : "debut"} ${genreNoun(genre)}.`);

  const full = parts.join(" ");

  // Short version — 2-3 sentences
  const shortParts = [parts[0]];
  if (profile.location) {
    shortParts.push(`Based in ${profile.location}.`);
  }
  shortParts.push(parts[parts.length - 1]);
  const short = shortParts.join(" ");

  return { full, short };
}

function firstName(name: string): string {
  return name.split(" ")[0];
}

function pronoun(_name: string): string {
  return "their"; // gender-neutral default
}

function pronounCap(_name: string): string {
  return "Their";
}

function addArticle(text: string): string {
  const lower = text.toLowerCase();
  if (lower.startsWith("a ") || lower.startsWith("an ") || lower.startsWith("the ")) {
    return text;
  }
  const vowels = "aeiou";
  return (vowels.includes(lower[0]) ? "an " : "a ") + text;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function genreNoun(genre: string): string {
  const lower = genre.toLowerCase();
  if (lower.includes("novel") || lower.includes("fiction")) return "novel";
  if (lower.includes("memoir")) return "memoir";
  if (lower.includes("poetry")) return "collection";
  if (lower.includes("thriller") || lower.includes("mystery")) return "thriller";
  if (lower.includes("sci")) return "science fiction novel";
  if (lower.includes("fantasy")) return "fantasy novel";
  if (lower.includes("romance")) return "romance novel";
  if (lower.includes("horror")) return "horror novel";
  if (lower.includes("non-fiction") || lower.includes("nonfiction")) return "book";
  return "book";
}

export function registerAuthorTools(server: McpServer): void {
  // book_author_from_linkedin
  server.tool(
    "book_author_from_linkedin",
    "Fetch author profile from LinkedIn and generate a polished author intro/bio for the book. Pulls name, headline, experience, education, and summary to create both a full bio (for back cover / about page) and a short bio (for marketing).",
    {
      linkedinUrl: z.string().describe("LinkedIn profile URL (e.g. https://www.linkedin.com/in/username)"),
      additionalContext: z
        .string()
        .optional()
        .default("")
        .describe("Extra context to weave into the bio (e.g. 'passionate about AI', 'lives with two cats')"),
      overrideName: z.string().optional().describe("Override the name from LinkedIn"),
    },
    async ({ linkedinUrl, additionalContext, overrideName }) => {
      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      // Fetch LinkedIn data
      const linkedinData = await fetchLinkedInProfile(linkedinUrl);

      const profile: AuthorProfile = {
        name: overrideName || linkedinData.name || registry.author,
        linkedinUrl: linkedinData.linkedinUrl || linkedinUrl,
        headline: linkedinData.headline,
        location: linkedinData.location,
        summary: linkedinData.summary,
        experience: linkedinData.experience,
        education: linkedinData.education,
        skills: linkedinData.skills,
        publications: linkedinData.publications,
        photoUrl: linkedinData.photoUrl,
        updatedAt: new Date().toISOString(),
      };

      // Generate intros
      const intros = generateAuthorIntro(profile, registry.genre, registry.title);
      profile.generatedIntro = intros.full;
      profile.generatedIntroShort = intros.short;

      // Append additional context if provided
      if (additionalContext) {
        profile.generatedIntro += " " + additionalContext;
      }

      saveAuthorProfile(profile);

      const fetchedFields = Object.entries(linkedinData)
        .filter(([_, v]) => v !== undefined && v !== null)
        .map(([k]) => k);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Author profile created from LinkedIn for "${profile.name}".`,
                fetchedFromLinkedIn: fetchedFields,
                profile,
                generatedIntro: {
                  full: profile.generatedIntro,
                  short: profile.generatedIntroShort,
                  note: "Edit these intros using book_author_update_intro, or manually update the profile with book_author_update_profile.",
                },
                tip: fetchedFields.length <= 2
                  ? "LinkedIn returned limited data (common for private profiles). Use book_author_update_profile to add details manually, then book_author_regenerate_intro to regenerate the bio."
                  : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_author_update_profile
  server.tool(
    "book_author_update_profile",
    "Manually update the author profile with details not available from LinkedIn. Add experience, education, skills, publications, or personal details.",
    {
      headline: z.string().optional().describe("Professional headline"),
      location: z.string().optional().describe("Location (e.g. 'San Francisco, CA')"),
      summary: z.string().optional().describe("Professional summary / about text"),
      experience: z
        .array(
          z.object({
            title: z.string().describe("Job title"),
            company: z.string().describe("Company name"),
            duration: z.string().optional().describe("Duration (e.g. '2019-2023')"),
          })
        )
        .optional()
        .describe("Work experience"),
      education: z
        .array(
          z.object({
            school: z.string().describe("School name"),
            degree: z.string().optional().describe("Degree type"),
            field: z.string().optional().describe("Field of study"),
          })
        )
        .optional()
        .describe("Education"),
      skills: z.array(z.string()).optional().describe("Key skills"),
      publications: z.array(z.string()).optional().describe("Previous publications"),
      interests: z.array(z.string()).optional().describe("Personal interests"),
    },
    async (input) => {
      let profile = getAuthorProfile();
      if (!profile) {
        const registry = getRegistry();
        if (!registry)
          throw new BookMCPError("No book project found. Run book_init first.");
        profile = {
          name: registry.author,
          updatedAt: new Date().toISOString(),
        };
      }

      // Merge updates
      if (input.headline !== undefined) profile.headline = input.headline;
      if (input.location !== undefined) profile.location = input.location;
      if (input.summary !== undefined) profile.summary = input.summary;
      if (input.experience !== undefined) profile.experience = input.experience;
      if (input.education !== undefined) profile.education = input.education;
      if (input.skills !== undefined) profile.skills = input.skills;
      if (input.publications !== undefined) profile.publications = input.publications;
      if (input.interests !== undefined) profile.interests = input.interests;
      profile.updatedAt = new Date().toISOString();

      saveAuthorProfile(profile);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Author profile updated.",
                profile,
                tip: "Run book_author_regenerate_intro to regenerate the bio with updated info.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_author_regenerate_intro
  server.tool(
    "book_author_regenerate_intro",
    "Regenerate the author intro/bio from the current profile data. Run this after updating the profile.",
    {},
    async () => {
      const profile = getAuthorProfile();
      if (!profile)
        throw new BookMCPError("No author profile found. Use book_author_from_linkedin or book_author_update_profile first.");

      const registry = getRegistry();
      if (!registry)
        throw new BookMCPError("No book project found. Run book_init first.");

      const intros = generateAuthorIntro(profile, registry.genre, registry.title);
      profile.generatedIntro = intros.full;
      profile.generatedIntroShort = intros.short;
      profile.updatedAt = new Date().toISOString();
      saveAuthorProfile(profile);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Author intro regenerated.",
                fullIntro: profile.generatedIntro,
                shortIntro: profile.generatedIntroShort,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_author_update_intro
  server.tool(
    "book_author_update_intro",
    "Directly edit the generated author intro text. Use this to polish or completely rewrite the auto-generated bio.",
    {
      fullIntro: z.string().optional().describe("Full author intro (for back cover / about the author page)"),
      shortIntro: z.string().optional().describe("Short author intro (for marketing / social media)"),
    },
    async ({ fullIntro, shortIntro }) => {
      const profile = getAuthorProfile();
      if (!profile)
        throw new BookMCPError("No author profile found. Use book_author_from_linkedin first.");

      if (fullIntro !== undefined) profile.generatedIntro = fullIntro;
      if (shortIntro !== undefined) profile.generatedIntroShort = shortIntro;
      profile.updatedAt = new Date().toISOString();
      saveAuthorProfile(profile);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Author intro updated.",
                fullIntro: profile.generatedIntro,
                shortIntro: profile.generatedIntroShort,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // book_author_get_profile
  server.tool(
    "book_author_get_profile",
    "Retrieve the full author profile and generated intros",
    {},
    async () => {
      const profile = getAuthorProfile();
      if (!profile)
        throw new BookMCPError("No author profile found. Use book_author_from_linkedin or book_author_update_profile first.");

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(profile, null, 2) },
        ],
      };
    }
  );
}
