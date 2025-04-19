import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
	homeContent,
	layout,
	renderAuthorizationRejectedContent
} from "./utils";

interface WixTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

interface WixTokenInfo {
	subjectId: string;
	// Add other fields as needed
}

interface AuthRequest {
	clientId: string;
	redirectUri: string;
	scope: string;
}

export type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
	WIX_CLIENT_ID: string;
};

const app = new Hono<{
	Bindings: Bindings;
}>();

// Render a basic homepage placeholder to make sure the app is up
app.get("/", async (c: Context) => {
	const content = await homeContent(c.req.raw);
	return c.html(layout(content, "MCP Remote Auth Demo - Home"));
});

// Helper function to generate a random string for the code verifier
function generateRandomString(length: number): string {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
	let result = '';
	const charactersLength = characters.length;
	const randomValues = new Uint8Array(length);
	crypto.getRandomValues(randomValues);
	for (let i = 0; i < length; i++) {
		result += characters.charAt(randomValues[i] % charactersLength);
	}
	return result;
}

// Helper function to generate the code challenge from the code verifier
async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	// Base64 URL encode the digest
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

// Wix OAuth callback endpoint
app.get("/callback", async (c: Context) => {
	try {
		const { code, state } = c.req.query();

		console.log(c.req.query())
		
		// Retrieve the code verifier from the cookie
		const codeVerifier = getCookie(c, 'wix_code_verifier');

		if (!code || !state || !codeVerifier) {
			console.error("Missing code, state, or code verifier cookie");
			// Clean up cookie if it exists but other params are missing
			if (codeVerifier) {
				deleteCookie(c, 'wix_code_verifier', { path: '/', httpOnly: true, secure: true });
			}
			return c.html(
				layout(
					await renderAuthorizationRejectedContent("/"),
					"MCP Remote Auth Demo - Authorization Status",
				),
				400
			);
		}

		// Get the OAuth request info from the state parameter
		const oauthReqInfo = JSON.parse(atob(state as string)) as AuthRequest;
		if (!oauthReqInfo.clientId) {
			return c.html(
				layout(
					await renderAuthorizationRejectedContent("/"),
					"MCP Remote Auth Demo - Authorization Status",
				),
				400
			);
		}
		
		// Clear the code verifier cookie now that we have it
		deleteCookie(c, 'wix_code_verifier', { path: '/', httpOnly: true, secure: true });

		// Exchange code for tokens
		const tokenResponse = await fetch("https://www.wixapis.com/oauth2/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: c.env.WIX_CLIENT_ID,
				grant_type: "authorization_code",
				code: code as string,
				redirect_uri: `${new URL(c.req.url).origin}/callback`,
				code_verifier: codeVerifier,
			}),
		});

		if (!tokenResponse.ok) {
			const requestId = tokenResponse.headers.get("x-wix-request-id");
			console.error("Token exchange failed. Request ID:", requestId);
			return c.html(
				layout(
					await renderAuthorizationRejectedContent("/"),
					"MCP Remote Auth Demo - Authorization Status",
				),
				{ status: tokenResponse.status as 400 | 401 | 403 | 404 | 500 }
			);
		}

		const tokenData = await tokenResponse.json() as WixTokenResponse;

		// Get user info from token
		const tokenInfoResponse = await fetch('https://www.wixapis.com/oauth2/token-info', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				token: tokenData.access_token
			})
		});

		if (!tokenInfoResponse.ok) {
			const requestId = tokenInfoResponse.headers.get("x-wix-request-id");
			console.error("Token info fetch failed. Request ID:", requestId);
			return c.html(
				layout(
					await renderAuthorizationRejectedContent("/"),
					"MCP Remote Auth Demo - Authorization Status",
				),
				{ status: tokenInfoResponse.status as 400 | 401 | 403 | 404 | 500 }
			);
		}

		const tokenInfo = await tokenInfoResponse.json() as WixTokenInfo;
		
		// Complete the authorization with the OAuth provider
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: oauthReqInfo,
			userId: tokenInfo.subjectId,
			metadata: {
				label: "Wix User",
			},
			scope: oauthReqInfo.scope,
			props: {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
			},
		});

		return Response.redirect(redirectTo);
	} catch (error) {
		console.error("OAuth callback error:", error);
		return c.html(
			layout(
				await renderAuthorizationRejectedContent("/"),
				"MCP Remote Auth Demo - Authorization Status",
			),
			{ status: 500 }
		);
	}
});

// Redirect to Wix OAuth authorization endpoint
app.get("/authorize", async (c: Context) => {
	const originalOAuthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
	const clientId = c.env.WIX_CLIENT_ID;
	const redirectUri = `${new URL(c.req.url).origin}/callback`;
	
	// Generate PKCE parameters
	const codeVerifier = generateRandomString(128);
	const codeChallenge = await generateCodeChallenge(codeVerifier);

	// Store code verifier in a secure cookie
	setCookie(c, 'wix_code_verifier', codeVerifier, {
		path: '/',
		secure: true,
		httpOnly: true,
		maxAge: 600, // 10 minutes validity
		sameSite: 'Lax'
	});

	// Create the base authorization URL
	const baseAuthUrl = "https://users.wix.com/v1/oauth/authorize";

	const baseParams = {
		clientId,
		responseType: "code",
		redirectUri,
		scope: "offline_access",
		state: btoa(JSON.stringify(originalOAuthReqInfo))
	}

	const postSignUpUrl = `https://users.wix.com/v1/oauth/authorize?${new URLSearchParams(baseParams).toString()}`;
	
	// Create the final authorization URL with encoded postSignUp parameter and PKCE params
	const authParams = new URLSearchParams({
		...baseParams,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		signInUrl: `https://users.wix.com/signin?postSignUp=${encodeURIComponent(postSignUpUrl)}`
	});
	
	const authUrl = `${baseAuthUrl}?${authParams.toString()}`;
	
	return c.redirect(authUrl);
});

export default app;
