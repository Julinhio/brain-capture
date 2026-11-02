import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureOwner } from '../src/server/auth/owner.js';
import { hashPassword } from '../src/server/auth/password.js';
import { createUser, login, PASSWORD, setup, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setup();
  await createUser(ctx.db, 'julien@example.com');
});
afterEach(() => ctx.close());

describe('private routes', () => {
  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/captures'],
    ['POST', '/api/captures'],
    ['PATCH', '/api/captures/9a1f5c0e-6a1e-4d0c-9a51-6a3f2f0b8c11'],
  ] as const)('%s %s refuses anonymous requests', async (method, url) => {
    const res = await ctx.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a forged session cookie', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'bc_session=forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('health stays public', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('login', () => {
  it('signs in with the right password and sets an HttpOnly cookie', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ' Julien@Example.com ', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'bc_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'julien@example.com', password: 'nope' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'someone@example.com', password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('rate limits repeated failures', async () => {
    const attempt = () =>
      ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'julien@example.com', password: 'nope' } });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('logout ends the session', async () => {
    const cookie = await login(ctx.app, 'julien@example.com');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('owner bootstrap', () => {
  it('a new password hash signs out existing sessions', async () => {
    const cookie = await login(ctx.app, 'julien@example.com');
    await ensureOwner(ctx.db, 'julien@example.com', await hashPassword('a brand new password'));
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('origin check', () => {
  it('refuses a state-changing request from another site', async () => {
    const cookie = await login(ctx.app, 'julien@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/captures',
      headers: { cookie, origin: 'https://evil.example', host: 'brain.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the app own origin', async () => {
    const cookie = await login(ctx.app, 'julien@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'https://brain.example', host: 'brain.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});
