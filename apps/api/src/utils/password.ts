export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65536,
    timeCost: 3,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === "SEED_ONLY_NO_LOGIN") return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}
