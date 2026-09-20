// Called only after the local URL/project guards, with generated training credentials.
export async function ensureTrainingUser(admin, publicClient, account) {
  if (account.id) {
    const result = await admin.auth.admin.getUserById(account.id);
    if (result.error || result.data.user?.email !== account.email)
      throw new Error(
        "Training Auth state differs from the saved file. No users were reset.",
      );
    return account.id;
  }
  const created = await admin.auth.admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: true,
    user_metadata: { full_name: `حساب تدريب — ${account.role}` },
  });
  if (!created.error && created.data.user?.email === account.email)
    return created.data.user.id;
  // A prior create may have succeeded before the response/state write was lost.
  // Recover only by proving possession of the already generated password.
  try {
    const recovered = await publicClient.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });
    if (!recovered.error && recovered.data.user?.email === account.email)
      return recovered.data.user.id;
  } finally {
    await publicClient.auth.signOut({ scope: "local" });
  }
  throw new Error(
    "Unable to create or recover the training account. Existing passwords are never changed.",
  );
}
