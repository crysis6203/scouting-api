#!/usr/bin/env node

// HTTP entry for hosting the scouting MCP server behind a reverse proxy.
// Requests must carry "Authorization: Bearer <MCP_AUTH_TOKEN>". The Scouting
// login comes from SCOUTING_USERNAME and SCOUTING_PASSWORD, as in stdio.ts.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createScoutingClient, type ScoutingClientConfig } from "scouting-api";
import { createServer } from "./server.ts";

function authFromEnv(): ScoutingClientConfig["auth"] {
	const { SCOUTING_USERNAME: username, SCOUTING_PASSWORD: password } =
		process.env;
	if (!username && !password) return "none";
	if (!username || !password) {
		throw new Error(
			"Set both SCOUTING_USERNAME and SCOUTING_PASSWORD, or neither",
		);
	}
	return { username, password };
}

const token = process.env["MCP_AUTH_TOKEN"] ?? "";
if (token.length < 32) {
	throw new Error("Set MCP_AUTH_TOKEN to a random string of 32+ characters");
}
const tokenHash = createHash("sha256").update(token).digest();

const host = process.env["HOST"] ?? "127.0.0.1";
const port = Number(process.env["PORT"] ?? 3000);
const mcpPath = process.env["MCP_PATH"] ?? "/mcp";

const auth = authFromEnv();
const scouting = createScoutingClient({ auth });
const handler = createMcpHandler(() => createServer(scouting, auth !== "none"));

function authorized(header: string | undefined): boolean {
	const given = /^Bearer (.+)$/.exec(header ?? "")?.[1];
	if (!given) return false;
	// Hash both sides so the comparison is constant-time and equal-length
	return timingSafeEqual(
		createHash("sha256").update(given).digest(),
		tokenHash,
	);
}

const server = createHttpServer(async (req, res) => {
	try {
		const url = new URL(
			req.url ?? "/",
			`https://${req.headers.host ?? "localhost"}`,
		);
		if (url.pathname === "/healthz") {
			res.writeHead(200, { "content-type": "text/plain" }).end("ok");
			return;
		}
		if (url.pathname !== mcpPath) {
			res.writeHead(404).end();
			return;
		}
		if (!authorized(req.headers.authorization)) {
			res.writeHead(401, { "www-authenticate": "Bearer" }).end();
			return;
		}

		const abort = new AbortController();
		res.on("close", () => abort.abort());
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined) {
				headers.set(key, Array.isArray(value) ? value.join(", ") : value);
			}
		}
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const request = new Request(url, {
			method: req.method,
			headers,
			body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
			duplex: "half",
			signal: abort.signal,
		} as RequestInit);

		const response = await handler.fetch(request);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		if (response.body) {
			Readable.fromWeb(response.body as never).pipe(res);
		} else {
			res.end();
		}
	} catch (error) {
		// Never log headers or bodies: they carry the token and Scouting data
		console.error("request failed:", error instanceof Error ? error.message : error);
		if (!res.headersSent) res.writeHead(500);
		res.end();
	}
});

server.listen(port, host, () => {
	console.error(`scouting-mcp listening on http://${host}:${port}${mcpPath}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void handler.close().finally(() => server.close(() => process.exit(0)));
	});
}
