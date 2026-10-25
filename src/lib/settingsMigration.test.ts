import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings, SETTINGS_VERSION } from './settingsMigration';
import { DEFAULT_MODELS } from './providers';
import type { AppSettings } from './types';

const base: AppSettings = { id: 'default', systemPrompt: 'p', rememberKeys: true };

test('retired ids are replaced with current defaults and the version is stamped', () => {
  const { settings, changed } = migrateSettings({ ...base, openAiModel: 'o1-mini', anthropicModel: 'claude-3-5-haiku-latest',
    groqModel: 'llama-3.3-70b-versatile', ollamaModel: 'qwen/qwen3.6-27b', customModel: 'o1-preview' });
  assert.equal(changed, true);
  assert.equal(settings.settingsVersion, SETTINGS_VERSION);
  assert.equal(settings.openAiModel, DEFAULT_MODELS.openai);
  assert.equal(settings.anthropicModel, DEFAULT_MODELS.anthropic);
  assert.equal(settings.groqModel, DEFAULT_MODELS.groq);
  assert.equal(settings.ollamaModel, DEFAULT_MODELS.groq);
  assert.equal(settings.customModel, DEFAULT_MODELS.openai);
});

test('every retired id maps to its provider default', () => {
  const expect: Array<[keyof AppSettings, string, string]> = [
    ['openAiModel', 'o1-preview', DEFAULT_MODELS.openai], ['openAiModel', 'o1-mini', DEFAULT_MODELS.openai],
    ['anthropicModel', 'claude-3-5-sonnet-latest', DEFAULT_MODELS.anthropic], ['anthropicModel', 'claude-3-5-haiku-latest', DEFAULT_MODELS.anthropic],
    ['anthropicModel', 'claude-3-opus-latest', DEFAULT_MODELS.anthropic],
    ...['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768', 'qwen/qwen3.6-27b']
      .map((id): [keyof AppSettings, string, string] => ['groqModel', id, DEFAULT_MODELS.groq]),
  ];
  for (const [field, from, to] of expect) assert.equal(migrateSettings({ ...base, [field]: from }).settings[field], to, from);
});

test('live models and custom choices are not touched, but the version is stamped', () => {
  const input = { ...base, openAiModel: 'gpt-4o', ollamaModel: 'gpt-4o-mini', groqModel: 'my-finetune', customModel: 'llama3', savedProviders: [{ id: 'x', name: 'X', key: 'k', model: 'o1-mini', baseUrl: 'https://x' }] };
  const { settings, changed } = migrateSettings(input);
  assert.equal(changed, true);
  assert.deepEqual({ ...settings, settingsVersion: undefined }, { ...input, settingsVersion: undefined });
  assert.equal(settings.settingsVersion, SETTINGS_VERSION);
});

test('migration runs once: a legacy id chosen after it is kept', () => {
  const first = migrateSettings({ ...base, openAiModel: 'o1-mini' }).settings;
  const chosen = { ...first, openAiModel: 'o1-mini' };
  const again = migrateSettings(chosen);
  assert.equal(again.changed, false);
  assert.equal(again.settings, chosen);
  assert.equal(again.settings.openAiModel, 'o1-mini');
});

test('already-current settings are returned as is', () => {
  const current = { ...base, settingsVersion: SETTINGS_VERSION, groqModel: DEFAULT_MODELS.groq };
  const result = migrateSettings(current);
  assert.equal(result.changed, false);
  assert.equal(result.settings, current);
});

test('settings from a future version are left alone', () => {
  const future = { ...base, settingsVersion: SETTINGS_VERSION + 5, openAiModel: 'o1-mini' };
  const result = migrateSettings(future);
  assert.equal(result.changed, false);
  assert.equal(result.settings, future);
  assert.equal(result.settings.settingsVersion, SETTINGS_VERSION + 5);
});

test('unversioned settings without models are just stamped; input is not mutated', () => {
  const input = { ...base };
  const { settings, changed } = migrateSettings(input);
  assert.equal(changed, true);
  assert.equal(settings.settingsVersion, SETTINGS_VERSION);
  assert.equal(input.settingsVersion, undefined);
  assert.ok(!('openAiModel' in settings));
});

test('inherited object keys are not treated as retired ids', () => {
  const { settings } = migrateSettings({ ...base, openAiModel: 'constructor', groqModel: 'toString' });
  assert.equal(settings.openAiModel, 'constructor');
  assert.equal(settings.groqModel, 'toString');
});
