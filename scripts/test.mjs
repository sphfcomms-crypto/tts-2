import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const build = mkdtempSync(join(tmpdir(), "tts-urdu-tests-"));
const tests = readdirSync("tests").filter(name => name.endsWith(".test.ts"));
try {
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "--target", "es2022", "--module", "commonjs",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--outDir", build,
    ...tests.map(name => join("tests", name)),
  ], { stdio: "inherit" });
  execFileSync(process.execPath, [
    "--test", ...tests.map(name => join(build, "tests", name.replace(/\.ts$/, ".js"))),
  ], { stdio: "inherit" });
} finally {
  rmSync(build, { recursive: true, force: true });
}
