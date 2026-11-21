import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_PERMISSIONS, inviteUrl, ownerAlert, ownerOf, shouldAlertOwner } from '../src/status.js';

test('the invite link asks for bot + slash commands and the four permissions', () => {
  const url = new URL(inviteUrl('123'));
  assert.equal(url.searchParams.get('client_id'), '123');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  assert.equal(url.searchParams.get('permissions'), INVITE_PERMISSIONS);
  assert.equal(Number(INVITE_PERMISSIONS), 1024 + 2048 + 32768 + 1048576);
});

test('the owner is the app owner, or the team owner', () => {
  assert.equal(ownerOf({ owner: { id: '7' } }), '7');
  assert.equal(ownerOf({ owner: { id: 'team', ownerId: '8' } }), '8');
  assert.equal(ownerOf({ owner: null }), null);
  assert.equal(ownerOf(null), null);
});

test('the owner is told about recordings others start, not their own', () => {
  assert.equal(shouldAlertOwner({ notify: true, ownerId: '7', starterId: '9' }), true);
  assert.equal(shouldAlertOwner({ notify: true, ownerId: '7', starterId: '7' }), false);
  assert.equal(shouldAlertOwner({ notify: false, ownerId: '7', starterId: '9' }), false);
  assert.equal(shouldAlertOwner({ notify: true, ownerId: null, starterId: '9' }), false);
});

test('the alert names who, where, and links the channel', () => {
  const msg = ownerAlert({ starter: 'Rook (rook)', guildName: 'The Gilded Table', channelName: 'Session', channelUrl: 'https://discord.com/channels/1/2', recordChat: true });
  assert.match(msg, /Rook \(rook\)/);
  assert.match(msg, /Session/);
  assert.match(msg, /The Gilded Table/);
  assert.match(msg, /with text chat/);
  assert.match(msg, /https:\/\/discord\.com\/channels\/1\/2/);
  assert.doesNotMatch(ownerAlert({ starter: 'x', guildName: 'g', channelName: 'c', channelUrl: 'u', recordChat: false }), /text chat/);
});
