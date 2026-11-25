import { defineConfig } from "tsdown";

// Self-contained build of the HTTP entry for hosting. Like the .mcpb build,
// it bundles every dependency, so the server needs only Node.
export default defineConfig({
	entry: ["src/http.ts"],
	platform: "node",
	outDir: "deploy",
	deps: { alwaysBundle: [/.*/], onlyBundle: false },
});
