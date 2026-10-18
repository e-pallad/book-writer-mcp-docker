// The setting half of book_continuity_check: a scene noted as taking place
// somewhere, read against what the scene says.
//
// Deliberately narrow. A place cannot be "contradicted" the way a character's
// height can: the trait dictionaries cover people (tall, old, blonde), so
// matching a setting's description against the prose would flag "young" next
// to "harbour". Nor is there a reliable way to tell from prose alone that the
// story moved somewhere unregistered. What can be checked without guessing is
// the author's own note — "this scene is at X" — against the scene: does it
// name X, and if not, does it name another place from the story bible?

import { LanguageRules } from "../lang/types";
import { Scene } from "../scenes/scenes";
import { SceneMeta, Setting, StoryBible } from "../storage/schema";
import { snippetAt } from "../utils/match";
import { wholeWordRegExp } from "../utils/text";
import { FlagDetail } from "./continuity-flag";

export interface SettingFlag extends FlagDetail {
  type: "setting";
  severity: "warning";
  description: string;
  suggestion: string;
}

/**
 * What a scene may call a setting by: the full name, or one capitalised word
 * of it ("Wendt" for "Haus Wendt"). Generous on purpose — the question is
 * whether the scene names the place at all, and a miss here is a false alarm.
 * Articles and other function words never count: "The" would name every
 * place called "The Anchor" in every scene.
 */
function namesOfSetting(setting: Setting, rules: LanguageRules | null): { name: string; exact: boolean }[] {
  const skip = new Set([...(rules?.stopWords ?? []), ...(rules?.determiners ?? [])].map((w) => w.toLowerCase()));
  const full = setting.name.trim();
  const names = [{ name: full, exact: false }];
  for (const part of full.split(/\s+/)) {
    if (part === full || part.length < 3 || !/^\p{Lu}/u.test(part) || skip.has(part.toLowerCase())) continue;
    names.push({ name: part, exact: true });
  }
  return names.filter((n) => n.name);
}

function names(setting: Setting, text: string, rules: LanguageRules | null): boolean {
  // The full name ignores case; a single word of it must be written as the
  // name is, or "Haus" would find "das Haus".
  return namesOfSetting(setting, rules).some(({ name, exact }) =>
    wholeWordRegExp(name, exact ? "u" : "iu").test(text)
  );
}

export function checkSceneSettings(
  content: string,
  scenes: { scene: Scene; meta?: SceneMeta }[],
  bible: StoryBible,
  rules: LanguageRules | null,
  chapterId: string
): SettingFlag[] {
  const text = content.normalize("NFC");
  const flags: SettingFlag[] = [];

  for (const { scene, meta } of scenes) {
    if (!meta?.settingId) continue;
    const noted = bible.settings.find((s) => s.id === meta.settingId);
    // A setting that is gone is a broken reference, which book_links_check reports.
    if (!noted || names(noted, scene.text, rules)) continue;

    // Another place from the bible, by its full name only: a looser match
    // would call a scene a mismatch because two places share a word.
    const others = bible.settings.filter(
      (s) => s.id !== noted.id && s.name.trim() && wholeWordRegExp(s.name.trim()).test(scene.text)
    );
    const repair = {
      tool: "book_scene_set",
      args: { chapterId, scene: scene.index },
      choose: "setting",
    };

    if (others.length) {
      const first = others[0];
      const at = wholeWordRegExp(first.name.trim()).exec(scene.text)!;
      flags.push({
        type: "setting",
        severity: "warning",
        code: "scene_setting_mismatch",
        chapterId,
        entities: {
          settingId: noted.id,
          otherSettingIds: others.map((s) => s.id),
          sceneIndex: scene.index,
        },
        evidence: [snippetAt(text, scene.start + at.index, at[0].length, 60)],
        repair,
        description: `Scene ${scene.index} is noted as taking place at "${noted.name}", but names ${others
          .map((s) => `"${s.name}"`)
          .join(", ")} and never "${noted.name}".`,
        suggestion: `If the scene is at ${first.name}, correct its setting with book_scene_set. If it is at ${noted.name}, name the place in the scene — or leave it, if mentioning ${first.name} in passing is deliberate.`,
      });
    } else {
      flags.push({
        type: "setting",
        severity: "warning",
        code: "scene_setting_not_named",
        chapterId,
        entities: { settingId: noted.id, sceneIndex: scene.index },
        repair,
        description: `Scene ${scene.index} is noted as taking place at "${noted.name}", but never names it.`,
        suggestion: `Check that the scene is where the note says — or correct its setting with book_scene_set. A scene that shows the place without naming it is fine; the flag then stands as a reminder, not an error.`,
      });
    }
  }
  return flags;
}
