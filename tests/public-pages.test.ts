import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestContext } from './helpers.js';

// Google's consent screen needs a public homepage and privacy policy on the app's domain.
describe('public homepage and privacy policy', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.close());

  it.each(['/about', '/privacy'])('%s is readable without signing in', async (url) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Brain Capture');
    expect(res.body).toContain('href="/privacy"');
    expect(res.body).not.toContain('<script');
  });

  it('the privacy policy states what Google data is used for and the Limited Use commitment', async () => {
    const body = (await ctx.app.inject({ url: '/privacy' })).body;
    expect(body).toContain('Limited Use');
    expect(body).toContain('https://developers.google.com/terms/api-services-user-data-policy');
    expect(body).toContain('https://myaccount.google.com/permissions');
  });

  it('the API stays private', async () => {
    expect((await ctx.app.inject({ url: '/api/captures' })).statusCode).toBe(401);
  });
});
