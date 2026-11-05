import { readFile } from "node:fs/promises";
import path from "node:path";
import { judgeLife } from "./lifeJudge";
import { SOUL_RUBRICS } from "./prompts";

// Fixtures only find what someone thought to press on. Everything a replay said
// goes to the judge, because that is where borrowed days turned up.
const outDirs = process.argv.slice(2);
if (outDirs.length === 0) {
  throw new Error("Usage: replayTruth.eval <replay out dir>...");
}

const JUDGE_BATCH_LINES = 20;
let failed = false;
for (const outDir of outDirs) {
  const calls = JSON.parse(
    await readFile(path.join(outDir, "said.json"), "utf8")
  ) as Array<{ input: { text?: string } }>;
  const said = calls.flatMap((call) =>
    call.input.text
      ? [call.input.text.replace(/\[CQ:reply,id=[^\]]+\]/g, "")]
      : []
  );
  // A real replay says more than the judge can get through in one call.
  for (let start = 0; start < said.length; start += JUDGE_BATCH_LINES) {
    const batch = said.slice(start, start + JUDGE_BATCH_LINES);
    const result = await judgeLife(SOUL_RUBRICS.truthfulReplay, { said: batch });
    failed ||= result.label === "fail";
    console.log(
      `${path.basename(outDir)} lines ${start + 1}-${start + batch.length}: ${result.label} ${result.score} - ${result.summary}`
    );
    for (const line of result.evidence) {
      console.log(`  ${line}`);
    }
  }
}
process.exit(failed ? 1 : 0);
