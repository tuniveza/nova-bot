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
					// Fake Google and Stripe keys for the Nova booking system tests (test/fakes.js stands in for both)
					GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
					GOOGLE_CLIENT_SECRET: "test-client-secret",
					STRIPE_SECRET_KEY: "sk_test_novacane",
					STRIPE_WEBHOOK_SECRET: "whsec_test_novacane",
					PUBLIC_URL: "https://novacane-worker.test",
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.js"],
	},
});
