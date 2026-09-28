const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectTools, callJson } = require("./helpers/tools");
const { useTempProject, cleanup } = require("./helpers/project");
const {
  POLICY_SOURCE_URL,
  POLICY_VERIFIED_ON,
  readerFacingNote,
  requiresDisclosure,
} = require("../dist-tsc/tools/ai-disclosure-policy");

function tools() {
  const m = (n) => require(`../dist-tsc/tools/${n}`);
  return collectTools(
    m("manuscript").registerManuscriptTools,
    m("cover").registerCoverTools,
    m("author").registerAuthorTools,
    m("ai-disclosure").registerAiDisclosureTools
  );
}

async function newProject(t) {
  const dir = useTempProject();
  t.after(() => cleanup(dir));
  const api = tools();
  await callJson(api, "book_init", {
    title: "The Harbour Light",
    author: "A. Writer",
    genre: "Literary Fiction",
  });
  return { dir, api };
}

test("AI-generated content must be declared; AI-assisted must not", async (t) => {
  const { api } = await newProject(t);

  // The distinction the whole policy turns on.
  const assisted = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_assisted",
  });
  assert.equal(assisted.disclosureRequired, false);
  assert.match(assisted.message, /Nothing here has to be declared/);
  assert.ok(
    assisted.whatToDoInKdp.steps.every((s) => /answer NO/.test(s)),
    JSON.stringify(assisted.whatToDoInKdp.steps)
  );

  const generated = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });
  assert.equal(generated.disclosureRequired, true);
  assert.ok(generated.whatToDoInKdp.steps.some((s) => /Text: answer YES/.test(s)));
  assert.ok(generated.whatToDoInKdp.risk, "the consequence should be stated");
});

test("heavy editing does not turn AI-generated into AI-assisted", async (t) => {
  const { api } = await newProject(t);
  const result = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });

  const text = result.classification.find((c) => c.contentType === "text");
  assert.equal(text.mustDeclare, true);
  // The definition has to say so explicitly — this is the single most
  // misunderstood part of the policy.
  assert.match(text.definition, /Editing it afterwards, however heavily/);
});

test("each content type is classified and answered separately", async (t) => {
  const { api } = await newProject(t);
  const result = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_assisted",
    images: "ai_generated",
    translations: "none",
  });

  assert.equal(result.disclosureRequired, true);
  const byType = Object.fromEntries(
    result.classification.map((c) => [c.contentType, c])
  );
  assert.equal(byType.text.mustDeclare, false);
  assert.equal(byType.images.mustDeclare, true);
  assert.equal(byType.translations.mustDeclare, false);

  // Amazon asks about cover and interior artwork together.
  assert.match(byType.images.label, /cover and interior/i);
  assert.ok(result.whatToDoInKdp.steps.some((s) => /Images.*answer YES/.test(s)));
});

test("the reader-facing note is offered but marked not required", async (t) => {
  const { api } = await newProject(t);
  const result = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });

  // KDP wants a form answer, not text in the book. Presenting the note as a
  // compliance step would be wrong.
  assert.equal(result.optionalReaderFacingNote.required, false);
  assert.match(
    result.optionalReaderFacingNote.explanation,
    /does not ask for a disclosure inside the book/
  );
  assert.match(result.whatToDoInKdp.where, /does not go inside the book/);
});

test("the reader-facing note agrees with itself grammatically", () => {
  const note = (uses) => readerFacingNote(uses, "A. Writer");

  assert.match(
    note({ text: "ai_generated", images: "none", translations: "none" }),
    /The text in this book was generated/
  );
  assert.match(
    note({ text: "none", images: "ai_generated", translations: "none" }),
    /The images in this book were generated/
  );
  assert.match(
    note({ text: "ai_generated", images: "ai_generated", translations: "none" }),
    /The text and images in this book were generated/
  );
  assert.match(
    note({ text: "ai_generated", images: "ai_generated", translations: "ai_generated" }),
    /The text, images and translation in this book were generated/
  );
  assert.equal(note({ text: "none", images: "none", translations: "none" }), null);
});

test("every response carries the policy source and the date it was checked", async (t) => {
  const { api } = await newProject(t);
  const result = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });

  // The whole point of not hardcoding stale wording: the reader of this output
  // must be able to tell how old it is and go and check.
  assert.equal(result.policy.source, POLICY_SOURCE_URL);
  assert.equal(result.policy.verifiedOn, POLICY_VERIFIED_ON);
  assert.match(result.policy.caveat, /without notice/);
  assert.match(POLICY_SOURCE_URL, /^https:\/\/kdp\.amazon\.com\//);
  assert.match(POLICY_VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/);
});

test("the disclosure is recorded and can be read back", async (t) => {
  const { dir, api } = await newProject(t);

  const empty = await callJson(api, "book_ai_disclosure_get", {});
  assert.equal(empty.recorded, false);
  assert.match(empty.message, /book_ai_disclosure_generate/);

  await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_assisted",
    images: "ai_generated",
    notes: "Drafted by hand; cover from an image model.",
  });

  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, ".book-mcp", "ai-disclosure.json"), "utf-8")
  );
  assert.equal(stored.images, "ai_generated");
  assert.equal(stored.disclosureRequired, true);
  assert.equal(stored.notes, "Drafted by hand; cover from an image model.");
  assert.equal(stored.policyVerifiedOn, POLICY_VERIFIED_ON);

  const read = await callJson(api, "book_ai_disclosure_get", {});
  assert.equal(read.recorded, true);
  assert.equal(read.disclosure.images, "ai_generated");
});

test("a disclosure recorded against an older policy reading is flagged", async (t) => {
  const { dir, api } = await newProject(t);
  await callJson(api, "book_ai_disclosure_generate", { text: "ai_generated" });

  // Simulate the policy having been re-verified since this was recorded.
  const file = path.join(dir, ".book-mcp", "ai-disclosure.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
  stored.policyVerifiedOn = "2024-01-01";
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));

  const read = await callJson(api, "book_ai_disclosure_get", {});
  assert.match(read.policy.warning, /2024-01-01/);
  assert.match(read.policy.warning, /Re-run book_ai_disclosure_generate/);
});

test("book_cover_checklist reminds you when no disclosure is recorded", async (t) => {
  const { api } = await newProject(t);

  const before = await callJson(api, "book_cover_checklist", { format: "kindle" });
  const reminder = before.checklist.find((c) => c.item === "AI content disclosure");
  assert.ok(reminder, "the checklist should carry an AI disclosure item");
  assert.equal(reminder.status, "needed");
  assert.match(reminder.details, /book_ai_disclosure_generate/);
  assert.match(reminder.details, /kdp\.amazon\.com/);

  await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_assisted",
    images: "ai_generated",
  });

  const after = await callJson(api, "book_cover_checklist", { format: "kindle" });
  const done = after.checklist.find((c) => c.item === "AI content disclosure");
  assert.equal(done.status, "ready");
  assert.match(done.details, /declare AI-generated images/);
  assert.match(done.details, /edit and republish/);
});

test("a project with no AI use at all is marked ready, not nagged", async (t) => {
  const { api } = await newProject(t);
  await callJson(api, "book_ai_disclosure_generate", {
    text: "none",
    images: "none",
    translations: "none",
  });

  const checklist = await callJson(api, "book_cover_checklist", { format: "paperback" });
  const item = checklist.checklist.find((c) => c.item === "AI content disclosure");
  assert.equal(item.status, "ready");
  assert.match(item.details, /nothing to declare/);
});

test("the author name comes from the profile when there is one", async (t) => {
  const { api } = await newProject(t);

  const fromRegistry = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });
  assert.match(fromRegistry.optionalReaderFacingNote.text, /A\. Writer/);

  const { getAuthorProfile, saveAuthorProfile } = require("../dist-tsc/storage/filestore");
  await callJson(api, "book_author_update_profile", { headline: "Novelist" });
  const profile = getAuthorProfile();
  profile.name = "Émile Ø'Brien";
  saveAuthorProfile(profile);

  const fromProfile = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
  });
  assert.match(fromProfile.optionalReaderFacingNote.text, /Émile Ø'Brien/);

  const explicit = await callJson(api, "book_ai_disclosure_generate", {
    text: "ai_generated",
    authorName: "Pen Name",
  });
  assert.match(explicit.optionalReaderFacingNote.text, /Pen Name/);
});

test("requiresDisclosure is driven by AI-generated alone", () => {
  assert.equal(
    requiresDisclosure({ text: "ai_assisted", images: "ai_assisted", translations: "ai_assisted" }),
    false
  );
  assert.equal(
    requiresDisclosure({ text: "none", images: "none", translations: "ai_generated" }),
    true
  );
});
