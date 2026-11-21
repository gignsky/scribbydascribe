import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinNotice, joinedRecording } from '../src/status.js';

const person = (channelId, bot = false) => ({ channelId, member: { user: { bot } } });

test('a person arriving in the recorded channel is a join', () => {
  assert.equal(joinedRecording(person(null), person('vc'), 'vc'), true, 'from no channel');
  assert.equal(joinedRecording(person('other'), person('vc'), 'vc'), true, 'moved in from another channel');
});

test('mute changes, leaving, other channels and bots are not joins', () => {
  assert.equal(joinedRecording(person('vc'), person('vc'), 'vc'), false, 'mute/unmute in place');
  assert.equal(joinedRecording(person('vc'), person(null), 'vc'), false, 'left');
  assert.equal(joinedRecording(person(null), person('other'), 'vc'), false, 'joined a different channel');
  assert.equal(joinedRecording(person(null, true), person('vc', true), 'vc'), false, 'a bot');
  assert.equal(joinedRecording({ channelId: null }, { channelId: 'vc' }, 'vc'), false, 'unknown member is not greeted');
});

test('the join notice names the person and what is kept', () => {
  const withChat = joinNotice({ mention: '<@1>', channelName: 'Council', recordChat: true, paused: false });
  assert.match(withChat, /<@1>/);
  assert.match(withChat, /Council is being recorded/);
  assert.match(withChat, /text channels/);
  assert.match(withChat, /\/scribe stop/);
  const voiceOnly = joinNotice({ mention: '<@1>', channelName: 'Council', recordChat: false, paused: false });
  assert.doesNotMatch(voiceOnly, /text channels/);
  assert.match(joinNotice({ mention: '<@1>', channelName: 'Council', recordChat: false, paused: true }), /paused right now/);
});
