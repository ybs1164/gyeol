"""Freeze a separate v2 runner without modifying/resuming v1 with new behavior."""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / "tools/calibrate_cognitive_bots.ts").read_text(encoding="utf-8")
old = "import { cognitiveMove, COGNITION_VERSION, createCognitiveRoster, type CognitivePersona, type CognitiveDecision } from '@gyeol/ai';"
new = "import { wideCognitiveMove as cognitiveMove, WIDE_COGNITION_VERSION as COGNITION_VERSION, createWideRoster as createCognitiveRoster, type WideCognitivePersona as CognitivePersona, type CognitiveDecision } from '@gyeol/ai';"
assert old in source
source = source.replace(old, new).replace("tools/calibration/cognition-v1", "tools/calibration/cognition-v2-wide")
source = source.replace("tools/calibrate_cognitive_bots.ts", "tools/calibrate_cognitive_bots_v2.ts")
source = source.replace("const sourceFiles = [", "const sourceFiles = ['packages/ai/src/cognition-wide.ts', ")
source = source.replace("rosterSize: bots.length,", "rosterSize: bots.length, targetDisplayRange: [974, 2207], ratingMeaning: 'Measured Elo remains separate from each profile targetRating',")
target = root / "tools/calibrate_cognitive_bots_v2.ts"
if target.exists() and target.read_text(encoding="utf-8") != source:
    raise RuntimeError("Existing v2 runner differs; preserve its runs before updating")
target.write_text(source, encoding="utf-8")
print(target)
preview = (root / "tools/play_cognitive_bots.ts").read_text(encoding="utf-8")
preview = preview.replace("type CognitivePersona, COGNITION_VERSION", "type WideCognitivePersona as CognitivePersona, WIDE_COGNITION_VERSION as COGNITION_VERSION")
preview = preview.replace("cognition-v1", "cognition-v2-wide").replace("cognitive-preview.json", "cognitive-wide-preview.json")
preview = preview.replace("for (const file of [", "for (const file of ['packages/ai/src/cognition-wide.ts', ")
preview = preview.replace("Previous ratings used only for provisional matching", "974-2207 target scale; actual strength validation is running")
(root / "tools/play_cognitive_wide.ts").write_text(preview, encoding="utf-8")
