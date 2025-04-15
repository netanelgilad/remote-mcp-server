import app from "./app";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";

interface WixTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

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
	tokenExchangeCallback: async (options) => {
		if (options.grantType === 'authorization_code') {
			// For authorization code exchange, we already have the tokens from Wix
			// Just return them as is since they're already in the props
			return {
				accessTokenProps: options.props,
				newProps: options.props
			};
		}

		if (options.grantType === 'refresh_token') {
			// For refresh token exchanges, we need to refresh the Wix token
			const tokenResponse = await fetch("https://www.wixapis.com/oauth2/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					clientId: env.WIX_CLIENT_ID,
					clientSecret: env.WIX_CLIENT_SECRET,
					grantType: "refresh_token",
					refreshToken: options.props.refreshToken,
				}),
			});

			if (!tokenResponse.ok) {
				throw new Error('Failed to refresh Wix token');
			}

			const tokenData = await tokenResponse.json() as WixTokenResponse;

			return {
				accessTokenProps: {
					...options.props,
					accessToken: tokenData.access_token
				},
				newProps: {
					...options.props,
					refreshToken: tokenData.refresh_token || options.props.refreshToken
				},
				accessTokenTTL: tokenData.expires_in
			};
		}
	}
});
