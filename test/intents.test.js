import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFlags, GatewayCloseCodes, GatewayIntentBits } from 'discord.js';
import { CHAT_INTENTS, VOICE_INTENTS, chatIntentAllowed, intentsFor, isDisallowedIntents, probeChatIntent } from '../src/intents.js';

test('voice intents are asked for either way, chat only when recording it', () => {
  for (const intent of VOICE_INTENTS) {
    assert.ok(intentsFor(false).includes(intent));
    assert.ok(intentsFor(true).includes(intent));
  }
  for (const intent of CHAT_INTENTS) {
    assert.ok(!intentsFor(false).includes(intent));
    assert.ok(intentsFor(true).includes(intent));
  }
  // The privileged one is the whole reason this module exists.
  assert.ok(CHAT_INTENTS.includes(GatewayIntentBits.MessageContent));
});

test('either message content flag counts as a grant', () => {
  assert.equal(chatIntentAllowed(ApplicationFlags.GatewayMessageContent), true);
  assert.equal(chatIntentAllowed(ApplicationFlags.GatewayMessageContentLimited), true);
  assert.equal(chatIntentAllowed(ApplicationFlags.GatewayMessageContent | 8192), true);
  assert.equal(chatIntentAllowed(0), false);
  assert.equal(chatIntentAllowed(8192), false);
});

test('an unreadable flags field is "do not know", never "refused"', () => {
  for (const flags of [undefined, null, 'nonsense', {}]) assert.equal(chatIntentAllowed(flags), null);
});

test('the probe reports what the application is allowed', async () => {
  const rest = { get: async (route) => ({ route, flags: ApplicationFlags.GatewayMessageContentLimited }) };
  assert.equal(await probeChatIntent('token', { rest }), true);

  const off = { get: async () => ({ flags: 0 }) };
  assert.equal(await probeChatIntent('token', { rest: off }), false);
});

test('a probe that cannot answer lets the gateway decide', async () => {
  const broken = { get: async () => { throw new Error('503'); } };
  assert.equal(await probeChatIntent('token', { rest: broken }), null);

  const silent = { get: async () => ({}) };
  assert.equal(await probeChatIntent('token', { rest: silent }), null);
});

test('a refused intent is recognised in every shape Discord sends it', () => {
  // The close event the shard reports.
  assert.ok(isDisallowedIntents({ code: GatewayCloseCodes.DisallowedIntents }));
  assert.ok(isDisallowedIntents({ code: 'DisallowedIntents' }));
  // The bare Error @discordjs/ws throws on that close, which is what used to
  // kill the process, and the { error } envelope it emits it in.
  assert.ok(isDisallowedIntents(new Error('Used disallowed intents')));
  assert.ok(isDisallowedIntents({ error: new Error('Used disallowed intents') }));
});

test('ordinary trouble is not mistaken for a refused intent', () => {
  for (const err of [undefined, null, {}, new Error('ECONNRESET'), { code: GatewayCloseCodes.AuthenticationFailed }]) {
    assert.ok(!isDisallowedIntents(err));
  }
});
