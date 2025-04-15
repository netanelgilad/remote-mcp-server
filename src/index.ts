import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Demo",
		version: "1.0.0",
	});

	async init() {
		this.server.tool("list sites", "List all sites for the current user", async () => {
			const sites = await fetch("https://www.wixapis.com/site-list/v2/sites/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json, text/plain, */*",
					"Authorization": this.props.accessToken as string,
				},
				body: JSON.stringify({
					query: {
						filter: { editorType: "EDITOR" },
						sort: [{ fieldName: "createdDate", order: "ASC" }],
						cursorPaging: { limit: 2 }
					}
				})
			})

			return sites.json();
		})
	}
}

// Export the OAuth handler as the default
export default new OAuthProvider({
	apiRoute: "/sse",
	// TODO: fix these types
	// @ts-ignore
	apiHandler: MyMCP.mount("/sse"),
	// @ts-ignore
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
