/**
 * Prints the argon2id hash to put in OWNER_PASSWORD_HASH.
 * The password is read from stdin so it never lands in shell history:
 *   echo <password> | npx tsx scripts/hash-password.ts       (or pipe from a file)
 */
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../src/server/auth/password.js';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Windows PowerShell pipes prepend a BOM and append CRLF; neither belongs to the password.
  const password = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r?\n$/, '');
  if (password.length < 12) throw new Error('Use at least 12 characters.');
  process.stdout.write(`${await hashPassword(password)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
