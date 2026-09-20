import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrainingUser } from "../../scripts/local-auth.mjs";

test("recovers an ambiguous Auth create only with the persisted training password", async () => {
  const account = {
    email: "owner@local.ympharma.test",
    role: "owner",
    password: "synthetic-test-password-not-a-real-credential",
  };
  const admin = {
    auth: {
      admin: {
        createUser: async () => ({
          error: { message: "duplicate" },
          data: { user: null },
        }),
      },
    },
  };
  let signedOut = false;
  const publicClient = {
    auth: {
      signInWithPassword: async (input) => {
        assert.equal(input.password, account.password);
        assert.equal(input.email, account.email);
        return {
          data: { user: { id: "recovered-user", email: account.email } },
          error: null,
        };
      },
      signOut: async () => {
        signedOut = true;
      },
    },
  };
  assert.equal(
    await ensureTrainingUser(admin, publicClient, account),
    "recovered-user",
  );
  assert.ok(signedOut);
  publicClient.auth.signInWithPassword = async () => ({
    error: { message: "invalid password" },
    data: { user: null },
  });
  await assert.rejects(
    ensureTrainingUser(admin, publicClient, account),
    /never changed/,
  );
});
test("validates persisted Auth identity and never resets an existing user", async () => {
  const account = { id: "existing-user", email: "cashier@local.ympharma.test" };
  const admin = {
    auth: {
      admin: {
        getUserById: async () => ({
          error: null,
          data: { user: { id: account.id, email: account.email } },
        }),
      },
    },
  };
  assert.equal(await ensureTrainingUser(admin, null, account), account.id);
  admin.auth.admin.getUserById = async () => ({
    error: null,
    data: { user: { email: "different@local.ympharma.test" } },
  });
  await assert.rejects(
    ensureTrainingUser(admin, null, account),
    /No users were reset/,
  );
});
