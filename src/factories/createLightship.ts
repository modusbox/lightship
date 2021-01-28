/* eslint-disable eqeqeq */
/* eslint-disable no-eq-null */
// eslint-disable-next-line fp/no-events
import {
  EventEmitter,
} from 'events';
import {
  AddressInfo,
} from 'net';
import delay from 'delay';
import express from 'express';
import {
  createHttpTerminator,
} from 'http-terminator';
import {
  serializeError,
} from 'serialize-error';
import Logger from '../Logger';
import {
  SERVER_IS_NOT_READY,
  SERVER_IS_NOT_SHUTTING_DOWN,
  SERVER_IS_READY,
  SERVER_IS_SHUTTING_DOWN,
} from '../states';
import type {
  BeaconContext,
  BlockingTask,
  ConfigurationInput,
  Configuration,
  HealthResponse,
  Lightship,
  ShutdownHandler,
  BeaconController,
  StartupLog,
} from '../types';
import {
  isKubernetes,
} from '../utilities';

const log = Logger.child({
  namespace: 'factories/createLightship',
});

const defaultConfiguration: Configuration = {
  detectKubernetes: true,
  gracefulShutdownTimeout: 60_000,
  port: 9_000,
  shutdownDelay: 5_000,
  shutdownHandlerTimeout: 5_000,
  signals: [
    'SIGTERM',
    'SIGHUP',
    'SIGINT',
  ],
  terminate: () => {
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  },
};

interface Beacon {
  context: BeaconContext
}

export default (userConfiguration?: ConfigurationInput): Lightship => {
  let blockingTasks: BlockingTask[] = [];

  let resolveFirstReady: () => void;
  const deferredFirstReady = new Promise<void>((resolve) => {
    resolveFirstReady = resolve;
  });

  // eslint-disable-next-line promise/always-return, promise/catch-or-return
  deferredFirstReady.then(() => {
    log.info('service became available for the first time');
  });

  const eventEmitter = new EventEmitter();

  const beacons: Beacon[] = [];

  const shutdownHandlers: Array<ShutdownHandler> = [];

  const configuration: Configuration = {
    ...defaultConfiguration,
    ...userConfiguration,
  };

  if (configuration.gracefulShutdownTimeout < configuration.shutdownHandlerTimeout) {
    throw new Error('gracefulShutdownTimeout cannot be lesser than shutdownHandlerTimeout.');
  }

  let serverIsReady = false;
  let serverIsShuttingDown = false;

  const isServerReady = () => {
    if (blockingTasks.length > 0) {
      log.debug('service is not ready because there are blocking tasks');

      return false;
    }

    return serverIsReady;
  };

  const app = express();

  const modeIsLocal = configuration.detectKubernetes === true && isKubernetes() === false;

  const server = app.listen(modeIsLocal ? undefined : configuration.port, () => {
    const address = server.address() as AddressInfo;
    log.info('Lightship HTTP service is running on port %s', address.port);
  });

  const httpTerminator = createHttpTerminator({
    server,
  });

  const startupLog : StartupLog = {
    log: [],
  };

  app.get('/health', async (_request, response) => {
    const responsePayload : HealthResponse = {
      detail: healthInfoCallback == null ? {} : await healthInfoCallback(),
      log: startupLog,
      state: '',
      statusCode: 0,
    };
    if (serverIsShuttingDown) {
      responsePayload.state = SERVER_IS_SHUTTING_DOWN;
      responsePayload.statusCode = 500;
    } else if (serverIsReady) {
      responsePayload.state = SERVER_IS_READY;
      responsePayload.statusCode = 200;
    } else {
      responsePayload.state = SERVER_IS_NOT_READY;
      responsePayload.statusCode = 500;
    }
    response.status(responsePayload.statusCode).json(responsePayload);
  });

  app.get('/live', (_request, response) => {
    if (serverIsShuttingDown) {
      response.status(500).send(SERVER_IS_SHUTTING_DOWN);
    } else {
      response.send(SERVER_IS_NOT_SHUTTING_DOWN);
    }
  });

  app.get('/ready', (_request, response) => {
    if (isServerReady()) {
      response.send(SERVER_IS_READY);
    } else {
      response.status(500).send(SERVER_IS_NOT_READY);
    }
  });

  const signalNotReady = () => {
    if (serverIsReady === false) {
      log.warn('server is already in a SERVER_IS_NOT_READY state');
    }

    log.info('signaling that the server is not ready to accept connections');

    serverIsReady = false;
  };

  const signalReady = () => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    log.info('signaling that the server is ready');

    if (blockingTasks.length > 0) {
      log.debug('service will not become immediately ready because there are blocking tasks');
    }

    serverIsReady = true;

    if (blockingTasks.length === 0) {
      resolveFirstReady();
    }
  };

  const startStep = (message: string): void => {
    const lastItem = startupLog.log[startupLog.log.length - 1];
    if (lastItem && lastItem.message === message) {
      lastItem.count++;
      lastItem.lastTimestamp = new Date().toISOString();
    } else {
      startupLog.log.push({
        count: 1,
        lastTimestamp: new Date().toISOString(),
        message,
      });
    }
  };

  const shutdown = async (nextReady: boolean) => {
    if (serverIsShuttingDown) {
      log.warn('server is already shutting down');

      return;
    }

    // @see https://github.com/gajus/lightship/issues/12
    // @see https://github.com/gajus/lightship/issues/25
    serverIsReady = nextReady;
    serverIsShuttingDown = true;

    log.info('received request to shutdown the service');

    if (configuration.shutdownDelay) {
      log.debug('delaying shutdown handler by %d seconds', configuration.shutdownDelay / 1_000);

      await delay(configuration.shutdownDelay);
    }

    let gracefulShutdownTimeoutId;

    if (configuration.gracefulShutdownTimeout !== Infinity) {
      gracefulShutdownTimeoutId = setTimeout(() => {
        log.warn('graceful shutdown timeout; forcing termination');

        configuration.terminate();
      }, configuration.gracefulShutdownTimeout);

      gracefulShutdownTimeoutId.unref();
    }

    if (beacons.length) {
      await new Promise<void>((resolve) => {
        const check = () => {
          log.debug('checking if there are live beacons');

          if (beacons.length > 0) {
            log.info({
              beacons,
            }, 'program termination is on hold because there are live beacons');
          } else {
            log.info('there are no live beacons; proceeding to terminate the Node.js process');

            eventEmitter.off('beaconStateChange', check);

            resolve();
          }
        };

        eventEmitter.on('beaconStateChange', check);

        check();
      });
    }

    if (gracefulShutdownTimeoutId) {
      clearTimeout(gracefulShutdownTimeoutId);
    }

    let shutdownHandlerTimeoutId;

    if (configuration.shutdownHandlerTimeout !== Infinity) {
      shutdownHandlerTimeoutId = setTimeout(() => {
        log.warn('shutdown handler timeout; forcing termination');

        configuration.terminate();
      }, configuration.shutdownHandlerTimeout);

      shutdownHandlerTimeoutId.unref();
    }

    log.debug('running %d shutdown handler(s)', shutdownHandlers.length);

    for (const shutdownHandler of shutdownHandlers) {
      try {
        await shutdownHandler();
      } catch (error) {
        log.error({
          error: serializeError(error),
        }, 'shutdown handler produced an error');
      }
    }

    if (shutdownHandlerTimeoutId) {
      clearTimeout(shutdownHandlerTimeoutId);
    }

    log.debug('all shutdown handlers have run to completion; proceeding to terminate the Node.js process');

    await httpTerminator.terminate();

    setTimeout(() => {
      log.warn('process did not exit on its own; investigate what is keeping the event loop active');

      configuration.terminate();
    }, 1_000)

      .unref();
  };

  if (modeIsLocal) {
    log.warn('shutdown handlers are not used in the local mode');
  } else {
    for (const signal of configuration.signals) {
      process.on(signal, () => {
        log.debug({
          signal,
        }, 'received a shutdown signal');

        shutdown(false);
      });
    }
  }

  const createBeacon = (context?: BeaconContext): BeaconController => {
    const beacon = {
      context: context || {},
    };

    beacons.push(beacon);

    return {
      die: async () => {
        log.trace({
          beacon,
        }, 'beacon has been killed');

        beacons.splice(beacons.indexOf(beacon), 1);

        eventEmitter.emit('beaconStateChange');

        await delay(0);
      },
    };
  };

  let healthInfoCallback: () => Promise<unknown>;

  const healthInfoProvider = (callback: () => Promise<unknown>) : void => {
    healthInfoCallback = callback;
  };

  return {
    createBeacon,
    healthInfoProvider,
    isServerReady,
    isServerShuttingDown: () => {
      return serverIsShuttingDown;
    },
    queueBlockingTask: (blockingTask: BlockingTask) => {
      blockingTasks.push(blockingTask);

      // eslint-disable-next-line promise/catch-or-return
      blockingTask.then((result) => {
        blockingTasks = blockingTasks.filter((maybeTargetBlockingTask) => {
          return maybeTargetBlockingTask !== blockingTask;
        });

        if (blockingTasks.length === 0 && serverIsReady === true) {
          resolveFirstReady();
        }

        return result;
      });
    },
    registerShutdownHandler: (shutdownHandler) => {
      shutdownHandlers.push(shutdownHandler);
    },
    server,
    shutdown: () => {
      return shutdown(false);
    },
    signalNotReady,
    signalReady,
    startStep,
    whenFirstReady: () => {
      return deferredFirstReady;
    },
  };
};
