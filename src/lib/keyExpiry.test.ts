import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsForStorage, cleanExpiredKeys } from './keyExpiry';

test('not remembering secrets retains provider definitions, but strips every provider and GitHub key', () => {
  const settings = { id: 'default' as const, systemPrompt: 'prompt', rememberKeys: false, githubPat: 'secret', customKey: 'secret',
    savedProviders: [{ id: 'p', name: 'My provider', key: 'secret', model: 'vision-model', baseUrl: 'https://example.com/v1' }] };
  const persisted = settingsForStorage(settings);
  assert.ok(!JSON.stringify(persisted).includes('secret'));
  assert.equal(persisted.savedProviders?.[0].model, 'vision-model');
  assert.equal(settings.savedProviders[0].key, 'secret', 'the current tab still has the key');
});

test('old keys without expiry are not silently removed and expiry does not remove model definitions', () => {
  const settings = { id: 'default' as const, systemPrompt: '', rememberKeys: true, customKey: 'kept', customModel: 'my-model' };
  assert.equal(cleanExpiredKeys(settings).settings.customKey, 'kept');
  const cleaned = cleanExpiredKeys({ ...settings, keyExpirations: { customKey: 1 } });
  assert.equal(cleaned.settings.customKey, undefined);
  assert.equal(cleaned.settings.customModel, 'my-model');
});
