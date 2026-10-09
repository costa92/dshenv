import { DshError, ValidationError } from '../errors.js';

export const DSH_URL_ENV = 'DSHENV_DSH_URL';
export const DSH_WEB_TIMEOUT_MS = 10_000;

// The token grants a full dsh web login, so it only goes to this machine unless the user says otherwise.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface DshWebTarget {
  origin: string;
  endpoint: string;
  token: string;
}

export interface DshWebSession {
  target: DshWebTarget;
  cookie: string;
}

const RELOGIN_HINT = 'export the URL dsh web printed again';

// The ports WHATWG fetch refuses to connect to ("bad ports"); dsh web on one could never be reached.
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080
]);

export function fetchBadPortMessage(port: number): string | undefined {
  return FETCH_BAD_PORTS.has(port) ? `port ${port} is one fetch refuses to connect to (a WHATWG "bad port"); pick another` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseDshWebUrl(value: string | undefined, options: { allowRemote?: boolean } = {}): DshWebTarget {
  if (value === undefined || value.trim() === '') {
    throw new ValidationError(`${DSH_URL_ENV} is not set; export the URL dsh web printed at startup`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError(`${DSH_URL_ENV} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`${DSH_URL_ENV} must be an http or https URL`);
  }
  const tokens = url.searchParams.getAll('token');
  if (tokens.length !== 1 || tokens[0] === '') {
    throw new ValidationError(`${DSH_URL_ENV} must carry exactly one token query parameter, as dsh web prints it`);
  }
  const badPort = url.port === '' ? undefined : fetchBadPortMessage(Number(url.port));
  if (badPort) {
    throw new ValidationError(`${DSH_URL_ENV} names ${badPort}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    if (!options.allowRemote) {
      throw new ValidationError(`Refusing to send the dsh web token to ${url.host}; pass --allow-remote to allow a non-loopback host`);
    }
    if (url.protocol !== 'https:') {
      throw new ValidationError(`Refusing to send the dsh web token to ${url.host} over plain http; use https for a non-loopback host`);
    }
  }
  return { origin: url.origin, endpoint: url.host, token: tokens[0] };
}

// Only the error code, or a cause message without the URL or token: fetch messages can echo the request URL, which carries the token.
function describeFetchError(error: unknown, timeoutMs: number, token: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `timed out after ${timeoutMs} ms`;
  }
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : undefined;
  if (typeof cause?.code === 'string') return cause.code;
  const message = typeof cause?.message === 'string' ? cause.message : '';
  return message !== '' && !message.includes(token) && !/:\/\/|token/i.test(message) ? message : 'request failed';
}

async function send(
  target: DshWebTarget,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; text: string }> {
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (error) {
    throw new DshError(`Could not reach DSH at ${target.endpoint}: ${describeFetchError(error, timeoutMs, target.token)}`);
  }
}

export async function loginDshWeb(target: DshWebTarget, options: { timeoutMs?: number } = {}): Promise<DshWebSession> {
  const url = new URL('/', target.origin);
  url.searchParams.set('token', target.token);
  const res = await send(target, url.href, { method: 'GET' }, options.timeoutMs ?? DSH_WEB_TIMEOUT_MS);
  const cookies = res.headers
    .getSetCookie()
    .map((header) => header.split(';')[0].trim())
    .filter((pair) => pair !== '');
  if (res.status !== 303 || cookies.length === 0) {
    const hint = res.status === 401 ? `; the token is wrong or dsh web restarted, ${RELOGIN_HINT}` : '';
    throw new DshError(
      `Could not log in to DSH at ${target.endpoint}: expected a 303 with a session cookie, got ${res.status}${hint}`
    );
  }
  return { target, cookie: cookies.join('; ') };
}

let nextRpcId = 0;

export async function callDshWeb(
  session: DshWebSession,
  service: string,
  method: string,
  options: { timeoutMs?: number } = {}
): Promise<unknown> {
  const { target } = session;
  const endpointPath = `${service}/${method}`;
  nextRpcId += 1;
  const res = await send(
    target,
    `${target.origin}/api/${endpointPath}`,
    {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: String(nextRpcId), method: endpointPath, payload: { args: {} } })
    },
    options.timeoutMs ?? DSH_WEB_TIMEOUT_MS
  );
  if (res.status === 401) {
    throw new DshError(`DSH at ${target.endpoint} rejected the session for ${method}; ${RELOGIN_HINT}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DshError(`DSH at ${target.endpoint} answered ${method} with HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new DshError(`DSH at ${target.endpoint} answered ${method} with a response that is not JSON`);
  }
  const result = isRecord(body) && isRecord(body.result) ? body.result : undefined;
  if (result === undefined || typeof result.ok !== 'boolean') {
    throw new DshError(`DSH at ${target.endpoint} answered ${method} with an unexpected response shape`);
  }
  if (!result.ok) {
    const code = isRecord(result.error) && typeof result.error.code === 'string' ? result.error.code : 'unknown error';
    throw new DshError(`DSH rejected ${method}: ${code}`);
  }
  return result.value;
}
