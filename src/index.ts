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
						"cursorPaging": {"limit": 50}
					}
				})
			})

			const result = await sites.json();

			return {
				content: [{
					type: "text",
					text: JSON.stringify(result)
				}]
			}
		});

		this.server.tool("Query Products", "Query products for a wix site", { siteId: z.string() }, async (args) => {
			// Get a site-specific token using the refresh token
			const siteTokenResponse = await fetch("https://www.wixapis.com/oauth2/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					clientId: env.WIX_CLIENT_ID,
					grantType: "refresh_token",
					refreshToken: this.props.refreshToken as string,
					siteId: args.siteId
				})
			});

			if (!siteTokenResponse.ok) {
				return {
					content: [{
						type: "text",
						text: `Failed to get site token: ${siteTokenResponse.status} ${siteTokenResponse.statusText}`
					}]
				};
			}

			const siteTokenData = await siteTokenResponse.json() as WixTokenResponse;
			const siteAccessToken = siteTokenData.access_token;

			
			const products = await fetch(`https://www.wixapis.com/stores/v1/products/query`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": siteAccessToken as string,
				},
				body: JSON.stringify({
					includeVariants: true
				})
			})

			const result = await products.json();

			return {
				content: [{
					type: "text",
					text: JSON.stringify(result)
				}]
			}
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
