import { hash, verify } from '@node-rs/argon2';

// OWASP baseline for argon2id (19 MiB, 2 iterations). @node-rs/argon2 defaults to argon2id.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verifying against a throwaway hash when the email is unknown keeps response times
// similar, so the login form does not reveal which address is the owner's.
let decoyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  decoyHash ??= hashPassword('decoy-password-not-used');
  await verifyPassword(await decoyHash, password);
}
