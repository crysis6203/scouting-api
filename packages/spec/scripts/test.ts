// Runs the contract tests for every API, or for the tests files given as
// arguments. Passes SCOUTING_USERNAME and SCOUTING_PASSWORD from the
// environment as workflow inputs, for the tests that need to sign in.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listApis, testsPath } from "./apis.ts";

const files =
	process.argv.length > 2
		? process.argv.slice(2)
		: (await listApis()).map(testsPath);

const inputs = {
	username: process.env["SCOUTING_USERNAME"],
	password: process.env["SCOUTING_PASSWORD"],
};

// On Windows, redocly is a .cmd shim that only a shell can start, and a shell
// would mangle the JSON argument below. Run its script with node instead,
// found through its own package.json so its export map doesn't matter, and
// fall back to the plain command when it can't be found.
function redoclyCommand(): [string, string[]] {
	try {
		const dir = join(
			import.meta.dirname,
			"..",
			"node_modules",
			"@redocly",
			"cli",
		);
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.redocly;
		return [process.execPath, [join(dir, bin)]];
	} catch {
		return ["redocly", []];
	}
}

const [command, commandArgs] = redoclyCommand();

try {
	execFileSync(
		command,
		[...commandArgs, "respect", ...files, "--input", JSON.stringify(inputs)],
		{ stdio: "inherit" },
	);
} catch (error) {
	// A failed test run has already printed its output. A run that never
	// started has no status, so say why.
	if ((error as { status?: number | null }).status == null)
		console.error(error);
	process.exit(1);
}
