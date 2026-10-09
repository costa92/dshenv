import { describe, it, expect, afterEach } from 'vitest';
import { callDshWeb, loginDshWeb, parseDshWebUrl, type DshWebSession } from '../../src/dsh/web-client.js';
import { DshError, ValidationError } from '../../src/errors.js';
import { startFakeDshWeb, type FakeDshWeb } from '../helpers/fake-dsh-web.js';

const SECRET = 'SECRET-TOKEN-123';

const errorOf = async (run: () => unknown): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
};

describe('parseDshWebUrl', () => {
  it('returns the origin, host:port endpoint and token of a loopback URL', () => {
    expect(parseDshWebUrl(`http://127.0.0.1:3080/?token=${SECRET}`)).toEqual({
      origin: 'http://127.0.0.1:3080',
      endpoint: '127.0.0.1:3080',
      token: SECRET
    });
  });

  it.each(['http://localhost:3080/?token=t', 'http://[::1]:3080/?token=t', 'https://127.0.0.1:3443/?token=t'])(
    'accepts the loopback URL %s',
    (value) => {
      expect(parseDshWebUrl(value).token).toBe('t');
    }
  );

  it.each([
    [undefined, /DSHENV_DSH_URL is not set/],
    ['  ', /DSHENV_DSH_URL is not set/],
    [`not a url ${SECRET}`, /DSHENV_DSH_URL is not a valid URL/],
    [`ftp://127.0.0.1/?token=${SECRET}`, /must be an http or https URL/],
    ['http://127.0.0.1:3080/', /exactly one token/],
    [`http://127.0.0.1:3080/?token=${SECRET}&token=${SECRET}`, /exactly one token/],
    ['http://127.0.0.1:3080/?token=', /exactly one token/],
    [`http://10.0.0.5:3080/?token=${SECRET}`, /Refusing to send the dsh web token to 10\.0\.0\.5:3080; pass --allow-remote/],
    [`http://127.0.0.1:6667/?token=${SECRET}`, /port 6667 is one fetch refuses/]
  ])('rejects %s with a ValidationError that never contains the token', (value, message) => {
    let caught: unknown;
    try {
      parseDshWebUrl(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).message).toMatch(message);
    expect((caught as Error).message).not.toContain(SECRET);
  });

  it('allows a non-loopback https host with allowRemote', () => {
    expect(parseDshWebUrl(`https://10.0.0.5:3080/?token=${SECRET}`, { allowRemote: true }).endpoint).toBe('10.0.0.5:3080');
  });

  it('refuses to send the token to a non-loopback host over plain http, even with allowRemote', () => {
    let caught: unknown;
    try {
      parseDshWebUrl(`http://10.0.0.5:3080/?token=${SECRET}`, { allowRemote: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/Refusing to send the dsh web token to 10\.0\.0\.5:3080 over plain http; use https for a non-loopback host/);
    expect((caught as Error).message).not.toContain(SECRET);
  });
});

describe('dsh web login and calls', () => {
  let fake: FakeDshWeb | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('logs in with the token and posts a client-request with object args', async () => {
    fake = await startFakeDshWeb({ bundles: [{ name: 'a' }] });
    const session = await loginDshWeb(parseDshWebUrl(fake.url));
    expect(session.cookie).toBe(fake.cookie);

    expect(await callDshWeb(session, 'pluginManager', 'listBundles')).toEqual([{ name: 'a' }]);
    const call = fake.requests.at(-1);
    expect(call).toMatchObject({ method: 'POST', path: '/api/pluginManager/listBundles', cookie: fake.cookie });
    expect(call?.body).toEqual({
      type: 'client-request',
      rpcId: expect.any(String),
      method: 'pluginManager/listBundles',
      payload: { args: {} }
    });
  });

  it('reports a wrong token as a failed login and tells the user to export the URL again', async () => {
    fake = await startFakeDshWeb();
    const error = await errorOf(() => loginDshWeb(parseDshWebUrl(`${fake!.origin}/?token=WRONG-${SECRET}`)));
    expect(error).toBeInstanceOf(DshError);
    expect(error.message).toMatch(/Could not log in to DSH at 127\.0\.0\.1:\d+: expected a 303 with a session cookie, got 401/);
    expect(error.message).toMatch(/export the URL dsh web printed again/);
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    [{ loginStatus: 200 }, /got 200/],
    [{ loginCookie: false }, /got 303/]
  ])('rejects a login answer without a session cookie (%o)', async (options, message) => {
    fake = await startFakeDshWeb(options);
    const error = await errorOf(() => loginDshWeb(parseDshWebUrl(fake!.url)));
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain(SECRET);
  });

  it('reports an expired session on an API call', async () => {
    fake = await startFakeDshWeb();
    const session: DshWebSession = { target: parseDshWebUrl(fake.url), cookie: 'dsh_session=stale' };
    const error = await errorOf(() => callDshWeb(session, 'pluginManager', 'listPlugins'));
    expect(error.message).toMatch(/DSH at 127\.0\.0\.1:\d+ rejected the session for listPlugins; export the URL dsh web printed again/);
  });

  it.each([
    [{ rejectMethod: 'listPlugins' }, /DSH rejected listPlugins: gateway\/internal/],
    [{ apiStatus: 500 }, /answered listPlugins with HTTP 500/],
    [{ apiBody: 'not json' }, /answered listPlugins with a response that is not JSON/],
    [{ apiBody: '{"type":"server-response"}' }, /answered listPlugins with an unexpected response shape/]
  ])('turns a bad API answer into a DshError (%o)', async (options, message) => {
    fake = await startFakeDshWeb(options);
    const session = await loginDshWeb(parseDshWebUrl(fake.url));
    const error = await errorOf(() => callDshWeb(session, 'pluginManager', 'listPlugins'));
    expect(error).toBeInstanceOf(DshError);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(fake.cookie);
  });

  it('times out a slow answer', async () => {
    fake = await startFakeDshWeb({ delayMs: 500 });
    const error = await errorOf(() => loginDshWeb(parseDshWebUrl(fake!.url), { timeoutMs: 100 }));
    expect(error.message).toMatch(/Could not reach DSH at 127\.0\.0\.1:\d+: timed out after 100 ms/);
    expect(error.message).not.toContain(SECRET);
  });

  it('names the cause of a fetch failure that has no error code, without the URL or token', async () => {
    const target = { origin: 'http://127.0.0.1:6667', endpoint: '127.0.0.1:6667', token: SECRET };
    const error = await errorOf(() => loginDshWeb(target));
    expect(error.message).toBe('Could not reach DSH at 127.0.0.1:6667: bad port');
  });

  it('names the connection error code when nothing listens', async () => {
    fake = await startFakeDshWeb();
    const target = parseDshWebUrl(fake.url);
    await fake.close();
    fake = undefined;
    const error = await errorOf(() => loginDshWeb(target));
    expect(error.message).toMatch(/Could not reach DSH at 127\.0\.0\.1:\d+: ECONNREFUSED/);
    expect(error.message).not.toContain(SECRET);
  });
});
