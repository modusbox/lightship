/* eslint-disable ava/max-asserts */
import {
  AddressInfo,
} from 'net';
import test from 'ava';
import axios from 'axios';
import delay from 'delay';
import {
  stub, spy,
} from 'sinon';
import createLightship from '../../../src/factories/createLightship';
import {
  SERVER_IS_NOT_READY, SERVER_IS_NOT_SHUTTING_DOWN, SERVER_IS_READY, SERVER_IS_SHUTTING_DOWN,
} from '../../../src/states';
import {
  HealthResponse,
  Lightship,
} from '../../../src/types';

type HealthProbeState = {
  readonly message: HealthResponse;
  readonly status: number;
};

type ProbeState = {
  readonly message: string;
  readonly status: number;
};

type ServiceState = {
  readonly health: HealthProbeState;
  readonly live: ProbeState;
  readonly ready: ProbeState;
};

const getLightshipPort = (lightship: Lightship) => {
  const address = lightship.server.address() as AddressInfo;

  return address.port;
};

const getServiceState = async (lightship: Lightship): Promise<ServiceState> => {
  const port = getLightshipPort(lightship);

  const health = await axios('http://127.0.0.1:' + port + '/health', {
    validateStatus: () => {
      return true;
    },
  });

  const live = await axios('http://127.0.0.1:' + port + '/live', {
    validateStatus: () => {
      return true;
    },
  });

  const ready = await axios('http://127.0.0.1:' + port + '/ready', {
    validateStatus: () => {
      return true;
    },
  });

  return {
    health: {
      message: health.data,
      status: health.status,
    },
    live: {
      message: live.data,
      status: live.status,
    },
    ready: {
      message: ready.data,
      status: ready.status,
    },
  };
};

test('server starts in SERVER_IS_NOT_READY state', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  t.is(lightship.isServerReady(), false);
  t.is(lightship.isServerShuttingDown(), false);

  const serviceState = await getServiceState(lightship);

  t.is(serviceState.health.status, 500);
  t.is(serviceState.health.message.state, SERVER_IS_NOT_READY);

  t.is(serviceState.live.status, 200);
  t.is(serviceState.live.message, SERVER_IS_NOT_SHUTTING_DOWN);

  t.is(serviceState.ready.status, 500);
  t.is(serviceState.ready.message, SERVER_IS_NOT_READY);

  await lightship.shutdown();

  t.is(terminate.called, false);
});

test('calling `signalReady` changes server state to SERVER_IS_READY', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  lightship.signalReady();

  t.is(lightship.isServerReady(), true);
  t.is(lightship.isServerShuttingDown(), false);

  const serviceState = await getServiceState(lightship);

  t.is(serviceState.health.status, 200);
  t.is(serviceState.health.message.state, SERVER_IS_READY);

  t.is(serviceState.live.status, 200);
  t.is(serviceState.live.message, SERVER_IS_NOT_SHUTTING_DOWN);

  t.is(serviceState.ready.status, 200);
  t.is(serviceState.ready.message, SERVER_IS_READY);

  await lightship.shutdown();

  t.is(terminate.called, false);
});

test('calling `signalReady` resolves `whenFirstReady`', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  setTimeout(() => {
    lightship.signalReady();
  }, 100);

  const startTime = Date.now();

  await lightship.whenFirstReady();

  t.true(Date.now() - startTime > 90);
});

test('`queueBlockingTask` forces service into SERVER_IS_NOT_READY until blocking tasks are resolved', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  let resolveBlockingTask: () => void;
  const blockingTask = new Promise<void>((resolve) => {
    resolveBlockingTask = resolve;
  });

  lightship.queueBlockingTask(blockingTask);

  lightship.signalReady();

  t.is(lightship.isServerReady(), false);

  resolveBlockingTask!();

  await delay(0);

  t.is(lightship.isServerReady(), true);
});

test('`whenFirstReady` resolves when all blocking tasks are resolved', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  lightship.queueBlockingTask(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 200);
    }),
  );

  setTimeout(() => {
    lightship.signalReady();
  }, 100);

  const startTime = Date.now();

  await lightship.whenFirstReady();

  t.true(Date.now() - startTime > 190);
});

test('calling `signalNotReady` changes server state to SERVER_IS_NOT_READY', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  lightship.signalReady();
  lightship.signalNotReady();

  t.is(lightship.isServerReady(), false);
  t.is(lightship.isServerShuttingDown(), false);

  const serviceState = await getServiceState(lightship);

  t.is(serviceState.health.status, 500);
  t.is(serviceState.health.message.state, SERVER_IS_NOT_READY);

  t.is(serviceState.live.status, 200);
  t.is(serviceState.live.message, SERVER_IS_NOT_SHUTTING_DOWN);

  t.is(serviceState.ready.status, 500);
  t.is(serviceState.ready.message, SERVER_IS_NOT_READY);

  await lightship.shutdown();

  t.is(terminate.called, false);
});

test('calling `shutdown` changes server state to SERVER_IS_SHUTTING_DOWN', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  let shutdown: (() => void) | undefined;

  lightship.registerShutdownHandler(() => {
    return new Promise((resolve) => {
      shutdown = resolve;
    });
  });

  lightship.shutdown();

  t.is(lightship.isServerReady(), false);
  t.is(lightship.isServerShuttingDown(), true);

  const serviceState = await getServiceState(lightship);

  t.is(serviceState.health.status, 500);
  t.is(serviceState.health.message.state, SERVER_IS_SHUTTING_DOWN);

  t.is(serviceState.live.status, 500);
  t.is(serviceState.live.message, SERVER_IS_SHUTTING_DOWN);

  t.is(serviceState.ready.status, 500);
  t.is(serviceState.ready.message, SERVER_IS_NOT_READY);

  if (!shutdown) {
    throw new Error('Unexpected state.');
  }

  await shutdown();

  t.is(terminate.called, false);
});

test('invoking `shutdown` using a signal causes SERVER_IS_READY', (t) => {
  const terminate = stub();

  const lightship = createLightship({
    detectKubernetes: false,
    shutdownDelay: 0,
    signals: ['LIGHTSHIP_TEST'],
    terminate,
  });

  process.emit('LIGHTSHIP_TEST' as any);

  t.is(lightship.isServerReady(), false);
  t.is(lightship.isServerShuttingDown(), true);
});

test('error thrown from within a shutdown handler does not interrupt the shutdown sequence', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  const shutdownHandler0 = spy(async () => {
    throw new Error('test');
  });

  let shutdown: (() => void) | undefined;

  const shutdownHandler1 = spy(() => {
    return new Promise<void>((resolve) => {
      shutdown = resolve;
    });
  });

  lightship.registerShutdownHandler(shutdownHandler0);
  lightship.registerShutdownHandler(shutdownHandler1);

  lightship.shutdown();

  await delay(500);

  if (!shutdown) {
    throw new Error('Unexpected state.');
  }

  await shutdown();

  t.is(shutdownHandler0.callCount, 1);
  t.is(shutdownHandler1.callCount, 1);

  t.is(terminate.called, false);
});

test('calling `shutdown` multiple times results in shutdown handlers called once', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  let shutdown: (() => void) | undefined;

  const shutdownHandler = spy(() => {
    return new Promise<void>((resolve) => {
      shutdown = resolve;
    });
  });

  lightship.registerShutdownHandler(shutdownHandler);

  t.is(shutdownHandler.callCount, 0);

  lightship.shutdown();

  t.is(shutdownHandler.callCount, 1);

  lightship.shutdown();

  t.is(shutdownHandler.callCount, 1);

  if (!shutdown) {
    throw new Error('Unexpected state.');
  }

  await shutdown();

  t.is(terminate.called, false);
});

test('presence of live beacons suspend the shutdown routine', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 0,
    terminate,
  });

  let shutdown: (() => void) | undefined;

  const shutdownHandler = spy(() => {
    return new Promise<void>((resolve) => {
      shutdown = resolve;
    });
  });

  lightship.registerShutdownHandler(shutdownHandler);

  const beacon = lightship.createBeacon();

  t.is(shutdownHandler.callCount, 0);

  lightship.shutdown();

  t.is(shutdownHandler.callCount, 0);

  await beacon.die();

  t.is(shutdownHandler.callCount, 1);

  if (!shutdown) {
    throw new Error('Unexpected state.');
  }

  await shutdown();

  t.is(terminate.called, false);
});

test('delays shutdown handlers', async (t) => {
  const terminate = stub();

  const lightship = createLightship({
    shutdownDelay: 1_000,
    terminate,
  });

  let shutdown: (() => void) | undefined;

  const shutdownHandler = spy(() => {
    return new Promise<void>((resolve) => {
      shutdown = resolve;
    });
  });

  lightship.registerShutdownHandler(shutdownHandler);

  lightship.shutdown();

  await delay(500);

  t.is(shutdownHandler.callCount, 0);

  await delay(1_000);

  t.is(shutdownHandler.callCount, 1);

  if (!shutdown) {
    throw new Error('Unexpected state.');
  }

  await shutdown();

  t.is(terminate.called, false);
});

