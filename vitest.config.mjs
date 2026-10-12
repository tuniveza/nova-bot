import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Tests never touch the real Cloudflare account
			remoteBindings: false,
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations("./migrations"),
					ACUITY_USER_ID: "12345",
					ACUITY_API_KEY: "test-acuity-key",
					ADMIN_PASSWORD: "test-admin-password",
					AGENT_NOVA_KEY: "agent-nova-test-key",
					// Tests don't wait for booking details from the confirmation page
					BOOKING_DETAILS_WAIT_SECONDS: "0",
					// Tests don't ask the real Google whether a pasted key is right (test/google-keys.spec.js fakes it)
					GOOGLE_KEY_CHECK: "off",
					// Fake Google and Stripe keys for the Nova booking system tests (test/fakes.js stands in for both)
					GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
					GOOGLE_CLIENT_SECRET: "test-client-secret",
					STRIPE_SECRET_KEY: "sk_test_novacane",
					STRIPE_WEBHOOK_SECRET: "whsec_test_novacane",
					PUBLIC_URL: "https://novacane-worker.test",
					// Resend's marketing API without the waits (src/resend-marketing.js spaces calls out in real life)
					RESEND_GAP_MS: "0",
					RESEND_BACKOFF_MS: "0",
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.js", "./test/sign-in.js"],
	},
});
