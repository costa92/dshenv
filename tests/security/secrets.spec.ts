import { describe, it, expect } from 'vitest';
import { findPlaintextSecrets, isCredentialKey } from '../../src/security/secrets.js';

const paths = (value: unknown, path?: string) => findPlaintextSecrets(value, path).map((secret) => secret.path);

describe('isCredentialKey', () => {
  it('takes keys ending in a credential name, in any case and separator', () => {
    for (const key of [
      'apiKey', 'api_key', 'API_KEY', 'accessToken', 'token', 'password', 'secret', 'clientSecret', 'githubToken', 'OPENAI_API_KEY',
      'my-api-key', 'Authorization', 'secretKey', 'SECRET_KEY', 'AWS_SECRET_ACCESS_KEY', 'secretAccessKey', 'privateKey', 'accessKey',
      'GH_PAT', 'OpenAIAPIKey', 'XApiKey', 'credentials'
    ]) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it('leaves environment variable references, limits and unrelated keys alone', () => {
    for (const key of ['apiKeyEnv', 'secretEnv', 'API_KEY_ENV', 'tokenizer', 'maxTokens', 'max_token', 'author', 'auth', 'noAuth', 'secretFile', 'model', 'keyboard', 'path', 'compat']) {
      expect(isCredentialKey(key), key).toBe(false);
    }
  });
});

describe('findPlaintextSecrets', () => {
  it('finds non-empty values under credential keys at any depth, including array elements and numeric passwords', () => {
    const entry = {
      id: 'llm',
      config: {
        apiKey: 'sk-123',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        providers: [{ name: 'a', token: 't' }, { name: 'b', token: '' }],
        nested: { password: 12345678, secret: null, maxTokens: 4096, token: 4096, deeper: { clientSecret: 's' } }
      }
    };
    expect(paths(entry)).toEqual(['config.apiKey', 'config.providers[0].token', 'config.nested.password', 'config.nested.deeper.clientSecret']);
  });

  it('finds a URL carrying a password or token under any key', () => {
    expect(paths({ config: { env: { DATABASE_URL: 'postgres://u:pw@h/db', HOME_URL: 'https://example.com/a?b=1' } } })).toEqual([
      'config.env.DATABASE_URL'
    ]);
  });

  it('takes every header of an MCP client row, and its env by key name', () => {
    const entry = {
      id: 'tools',
      insert: [
        { name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', command: 'gh-mcp', env: { LOG_LEVEL: 'info', GH_PAT: 'ghp_x' } } },
        {
          group: true,
          config: [{ name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'http', url: 'https://x', headers: { 'X-Custom': 'v', Empty: '' } } }]
        }
      ]
    };
    expect(paths(entry)).toEqual(['insert[0].config.env.GH_PAT', 'insert[1].config[0].config.headers.X-Custom']);
  });

  it('leaves headers of other rows to the key names', () => {
    expect(paths({ name: 'other', config: { headers: { Authorization: 'Bearer x', Accept: 'json' } } })).toEqual(['config.headers.Authorization']);
  });

  it('prefixes the paths it reports, and hashes the value instead of keeping it', () => {
    const [secret] = findPlaintextSecrets({ apiKey: 'x' }, 'config');
    expect(secret.path).toBe('config.apiKey');
    expect(JSON.stringify(secret)).not.toContain('"x"');
    expect(findPlaintextSecrets({ apiKey: 'x' })[0].digest).toBe(secret.digest);
    expect(paths({ apiKeyEnv: 'X' })).toEqual([]);
  });
});
