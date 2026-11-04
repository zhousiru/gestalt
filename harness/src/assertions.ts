import assert from "node:assert/strict";
import type { ReplayRunResult } from "./replayRunner";

export function assertReplayRun(result: ReplayRunResult): void {
  assertWakes(result);
  assertConnector(result);
  assertModelInput(result);
  assertToolOutputs(result);
  assertLife(result);
  assertRollout(result);
  assertSession(result);
}

function assertWakes(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.wakes;
  if (!expected) {
    return;
  }
  const { wakes } = result;
  const list = (values: unknown[]): string => JSON.stringify(values);
  if (expected.count !== undefined) {
    assert.equal(
      wakes.length,
      expected.count,
      `expected ${expected.count} wakes, got ${list(wakes.map((wake) => wake.reason))}`
    );
  }
  if (expected.minCount !== undefined) {
    assert.ok(wakes.length >= expected.minCount, `only ${wakes.length} wakes`);
  }
  if (expected.maxCount !== undefined) {
    assert.ok(wakes.length <= expected.maxCount, `${wakes.length} wakes`);
  }
  if (expected.reasons) {
    assert.deepEqual(wakes.map((wake) => wake.reason), expected.reasons);
  }
  if (expected.places) {
    assert.deepEqual(wakes.map((wake) => wake.place ?? "phone"), expected.places);
  }
  if (expected.kinds) {
    assert.deepEqual(wakes.map((wake) => wake.kind), expected.kinds);
  }
  if (expected.statuses) {
    assert.deepEqual(wakes.map((wake) => wake.status), expected.statuses);
  }
  if (expected.held !== undefined) {
    assert.equal(
      wakes.reduce((total, wake) => total + wake.held, 0),
      expected.held
    );
  }
  if (expected.reverted !== undefined) {
    assert.equal(wakes.filter((wake) => wake.reverted).length, expected.reverted);
  }
  if (expected.startOffsets) {
    const start = new Date(result.fixture.start).valueOf();
    assert.deepEqual(
      wakes.map((wake) => (Date.parse(wake.startedAt) - start) / 1000),
      expected.startOffsets
    );
  }
}

function assertConnector(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.connector;
  if (!expected) {
    return;
  }
  const { calls, sentGroupMessages } = result.connector;
  const texts = calls.flatMap((call) => {
    const text = (call.input as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  if (expected.groupMessages !== undefined) {
    assert.equal(sentGroupMessages.length, expected.groupMessages);
  }
  if (expected.minGroupMessages !== undefined) {
    assert.ok(sentGroupMessages.length >= expected.minGroupMessages);
  }
  const count = (kind: string): number =>
    calls.filter((call) => call.kind === kind).length;
  if (expected.privateMessages !== undefined) {
    assert.equal(count("send_private_message"), expected.privateMessages);
  }
  if (expected.reactions !== undefined) {
    assert.equal(count("react_to_message"), expected.reactions);
  }
  if (expected.stickers !== undefined) {
    assert.equal(count("send_sticker"), expected.stickers);
  }
  for (const text of expected.textsInclude ?? []) {
    assert.ok(
      texts.some((candidate) => candidate.includes(text)),
      `no sent message contains ${text}: ${JSON.stringify(texts)}`
    );
  }
  for (const text of expected.textsExclude ?? []) {
    assert.ok(
      !texts.some((candidate) => candidate.includes(text)),
      `a sent message contains ${text}: ${JSON.stringify(texts)}`
    );
  }
  if (expected.groupIds) {
    assert.deepEqual(
      sentGroupMessages.map((message) => message.input.groupId),
      expected.groupIds
    );
  }
}

function assertModelInput(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.modelInput;
  if (!expected) {
    return;
  }
  const serialized = JSON.stringify(result.modelRequests);
  if (expected.requests !== undefined) {
    assert.equal(result.modelRequests.length, expected.requests);
  }
  if (expected.minRequests !== undefined) {
    assert.ok(result.modelRequests.length >= expected.minRequests);
  }
  for (const text of expected.contains ?? []) {
    assert.ok(
      serialized.includes(JSON.stringify(text).slice(1, -1)),
      `model input does not contain ${text}`
    );
  }
  for (const text of expected.doesNotContain ?? []) {
    assert.ok(
      !serialized.includes(JSON.stringify(text).slice(1, -1)),
      `model input contains ${text}`
    );
  }
  if (expected.tools) {
    for (const request of result.modelRequests) {
      assert.deepEqual(request.tools, expected.tools);
    }
  }
}

function assertToolOutputs(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.toolOutputs;
  if (!expected) {
    return;
  }
  const serialized = JSON.stringify(
    result.modelExchanges.map((exchange) => exchange.response)
  );
  for (const text of expected.contain ?? []) {
    assert.ok(
      serialized.includes(JSON.stringify(text).slice(1, -1)),
      `tool outputs do not contain ${text}`
    );
  }
  for (const text of expected.doNotContain ?? []) {
    assert.ok(
      !serialized.includes(JSON.stringify(text).slice(1, -1)),
      `tool outputs contain ${text}`
    );
  }
}

function assertLife(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.life;
  if (!expected) {
    return;
  }
  if (expected.commits !== undefined) {
    assert.equal(
      result.lifeLog.length,
      expected.commits,
      `commits: ${JSON.stringify(result.lifeLog)}`
    );
  }
  if (expected.minCommits !== undefined) {
    assert.ok(result.lifeLog.length >= expected.minCommits);
  }
  const readFile = (filePath: string): string | undefined =>
    result.homeAfter.files.find((file) => file.path === filePath)?.content;
  for (const { path, contains } of expected.fileContains ?? []) {
    const content = readFile(path);
    assert.ok(content !== undefined, `home has no file ${path}`);
    assert.ok(content.includes(contains), `${path} lacks ${contains}: ${content}`);
  }
  for (const { path, contains } of expected.fileDoesNotContain ?? []) {
    assert.ok(
      !(readFile(path) ?? "").includes(contains),
      `${path} contains ${contains}`
    );
  }
}

function assertRollout(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.rollout;
  if (!expected) {
    return;
  }
  if (expected.rollouts !== undefined) {
    assert.equal(result.rollouts.length, expected.rollouts);
  }
  if (expected.conversationKeys) {
    assert.deepEqual(
      result.rollouts
        .slice()
        .reverse()
        .map((rollout) => rollout.summary.conversationKey),
      expected.conversationKeys
    );
  }
  if (expected.recordTypes) {
    const types = new Set(
      result.rollouts.flatMap((rollout) =>
        rollout.records.map((record) => record.type)
      )
    );
    for (const type of expected.recordTypes) {
      assert.ok(types.has(type as never), `no rollout record of type ${type}`);
    }
  }
}

function assertSession(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.session;
  if (!expected) {
    return;
  }
  const conversations = result.session.conversations;
  const events = conversations.flatMap((conversation) => conversation.events);
  if (expected.selfMessages !== undefined) {
    assert.equal(
      events.filter(
        (record) =>
          record.event.type === "MessageReceived" &&
          record.event.sender.isSelf === true
      ).length,
      expected.selfMessages
    );
  }
  if (expected.turns !== undefined) {
    assert.equal(
      conversations.flatMap((conversation) => conversation.turns).length,
      expected.turns
    );
  }
  if (expected.windows !== undefined) {
    assert.equal(
      conversations.flatMap((conversation) => conversation.windows).length,
      expected.windows
    );
  }
  if (expected.wakeRecords !== undefined) {
    assert.equal(
      result.sessionJournal.filter((record) => record.type === "wake").length,
      expected.wakeRecords
    );
  }
}
