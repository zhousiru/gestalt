import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { isConnectorOutcomeUnknownError } from "../types";
import {
  createOneBotForwardWsTransport,
  type OneBotEventFailureCode
} from "./transport";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Expected a TCP address for the OneBot transport verifier.");
}

let acceptClient!: (socket: WebSocket) => void;
const connectedClient = new Promise<WebSocket>((resolve) => {
  acceptClient = resolve;
});
server.on("connection", acceptClient);

const transport = createOneBotForwardWsTransport({
  url: `ws://127.0.0.1:${address.port}`,
  ingressConcurrency: 2,
  ingressQueueCapacity: 2,
  reconnectMinMs: 10,
  reconnectMaxMs: 40
});
const failureCodes: OneBotEventFailureCode[] = [];
const failureWaiters = new Map<OneBotEventFailureCode, () => void>();
transport.onEventError((failure) => {
  failureCodes.push(failure.code);
  failureWaiters.get(failure.code)?.();
});

let releaseBurst!: () => void;
const burstGate = new Promise<void>((resolve) => {
  releaseBurst = resolve;
});
const handled: number[] = [];
let activeHandlers = 0;
let maxActiveHandlers = 0;
transport.onEvent(async (rawEvent) => {
  const event = rawEvent as { id?: unknown };
  if (event.id === "bad") {
    throw new Error("expected transport handler failure");
  }
  if (typeof event.id !== "number") {
    return;
  }
  activeHandlers += 1;
  maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
  try {
    if (event.id < 2) {
      await burstGate;
    }
    handled.push(event.id);
  } finally {
    activeHandlers -= 1;
  }
});

try {
  await transport.connect();
  const client = await connectedClient;
  const overflowObserved = waitForFailure("queue_overflow");
  for (let id = 0; id < 5; id += 1) {
    client.send(JSON.stringify({ id }));
  }
  await overflowObserved;
  assert.deepEqual(transport.getIngressStats(), {
    active: 2,
    queued: 2,
    accepted: 4,
    completed: 0,
    failed: 0,
    rejected: 1
  });
  releaseBurst();
  await transport.whenIngressIdle();
  assert.deepEqual(handled, [0, 1, 2, 3]);
  assert.equal(maxActiveHandlers, 2);

  const handlerFailureObserved = waitForFailure("handler_failed");
  client.send(JSON.stringify({ id: "bad" }));
  await handlerFailureObserved;
  await transport.whenIngressIdle();

  const invalidMessageObserved = waitForFailure("invalid_message");
  client.send("{");
  await invalidMessageObserved;

  const receivedAction = once(client, "message");
  const action = transport.callAction("send_group_msg", {
    group_id: 1,
    message: "hello"
  });
  await receivedAction;
  const connectionLost = waitForFailure("connection_lost");
  const reconnected = once(server, "connection");
  client.close();
  await assert.rejects(action, isConnectorOutcomeUnknownError);
  await connectionLost;

  // The connection comes back by itself, and events and actions work again.
  const [secondClient] = (await reconnected) as [WebSocket];
  secondClient.send(JSON.stringify({ id: 10 }));
  await waitUntil(() => handled.includes(10));
  const answered = once(secondClient, "message");
  const secondAction = transport.callAction("get_status");
  const [rawAction] = (await answered) as [Buffer];
  const { echo } = JSON.parse(rawAction.toString("utf8")) as { echo: string };
  secondClient.send(JSON.stringify({ status: "ok", retcode: 0, echo }));
  assert.equal((await secondAction).ok, true);

  // A server gone for a while, as NapCat is while QQ is logged out: nothing is
  // listening on the port, so every attempt fails until it returns.
  const secondLost = waitForFailure("connection_lost");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    secondClient.terminate();
  });
  await secondLost;
  await assert.rejects(
    transport.callAction("get_status"),
    /not connected/
  );
  await delay(150);
  const returned = new WebSocketServer({
    host: "127.0.0.1",
    port: address.port
  });
  try {
    const [thirdClient] = (await once(returned, "connection")) as [WebSocket];
    thirdClient.send(JSON.stringify({ id: 11 }));
    await waitUntil(() => handled.includes(11));

    // Disposing ends the loop: no connection comes back after that.
    await transport[Symbol.asyncDispose]();
    await delay(100);
    assert.equal(returned.clients.size, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      returned.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.deepEqual(failureCodes, [
    "queue_overflow",
    "handler_failed",
    "invalid_message",
    "connection_lost",
    "connection_lost"
  ]);
} finally {
  await transport[Symbol.asyncDispose]();
}

console.log(
  JSON.stringify({
    ok: true,
    maxActiveHandlers,
    failureCodes,
    unknownOutcomeOnDisconnect: true,
    reconnects: true,
    survivesAServerOutage: true
  })
);

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the condition");
    await delay(5);
  }
}

function waitForFailure(code: OneBotEventFailureCode): Promise<void> {
  return new Promise<void>((resolve) => {
    failureWaiters.set(code, () => {
      failureWaiters.delete(code);
      resolve();
    });
  });
}
