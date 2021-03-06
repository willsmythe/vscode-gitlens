'use strict';
import { LogCorrelationContext, Logger, LogLevel } from '../../logger';
import { Functions } from './../function';
import { Strings } from './../string';

const correlationContext = new Map<number, LogCorrelationContext>();
let correlationCounter = 0;

export function getCorrelationContext() {
    return correlationContext.get(correlationCounter);
}

export function getCorrelationId() {
    return correlationCounter;
}

function getNextCorrelationId() {
    if (correlationCounter === Number.MAX_SAFE_INTEGER) {
        correlationCounter = 0;
    }
    return ++correlationCounter;
}

function clearCorrelationContext(correlationId: number) {
    correlationContext.delete(correlationId);
}

function setCorrelationContext(correlationId: number, context: LogCorrelationContext) {
    correlationContext.set(correlationId, context);
}

export interface LogContext<T> {
    id: number;
    instance: T;
    instanceName: string;
    name: string;
    prefix: string;
}

export const LogInstanceNameFn = Symbol('logInstanceNameFn');

export function logName<T>(fn: (c: T, name: string) => string) {
    return (target: Function) => {
        (target as any)[LogInstanceNameFn] = fn;
    };
}

export function debug<T>(
    options: {
        args?: false | { [arg: string]: (arg: any) => string | false };
        condition?(...args: any[]): boolean;
        correlate?: boolean;
        enter?(...args: any[]): string;
        exit?(result: any): string;
        prefix?(context: LogContext<T>, ...args: any[]): string;
        sanitize?(key: string, value: any): any;
        singleLine?: boolean;
        timed?: boolean;
    } = { timed: true }
) {
    return log<T>({ debug: true, ...options });
}

export function log<T>(
    options: {
        args?: false | { [arg: number]: ((arg: any) => string | false) };
        condition?(...args: any[]): boolean;
        correlate?: boolean;
        debug?: boolean;
        enter?(...args: any[]): string;
        exit?(result: any): string;
        prefix?(context: LogContext<T>, ...args: any[]): string;
        sanitize?(key: string, value: any): any;
        singleLine?: boolean;
        timed?: boolean;
    } = { timed: true }
) {
    options = { timed: true, ...options };

    const logFn = (options.debug ? Logger.debug.bind(Logger) : Logger.log.bind(Logger)) as
        | typeof Logger.debug
        | typeof Logger.log;

    return (target: any, key: string, descriptor: PropertyDescriptor) => {
        let fn: Function | undefined;
        if (typeof descriptor.value === 'function') {
            fn = descriptor.value;
        }
        else if (typeof descriptor.get === 'function') {
            fn = descriptor.get;
        }
        if (fn == null) throw new Error('Not supported');

        const parameters = Functions.getParameters(fn);

        descriptor.value = function(this: any, ...args: any[]) {
            const correlationId = getNextCorrelationId();

            if (
                (Logger.level !== LogLevel.Debug && !(Logger.level === LogLevel.Verbose && !options.debug)) ||
                (typeof options.condition === 'function' && !options.condition(...args))
            ) {
                return fn!.apply(this, args);
            }

            let instanceName: string;
            if (this != null) {
                instanceName = Logger.toLoggableName(this);
                if (this.constructor != null && this.constructor[LogInstanceNameFn]) {
                    instanceName = target.constructor[LogInstanceNameFn](this, instanceName);
                }
            }
            else {
                instanceName = '';
            }

            let { correlate } = options;
            if (!correlate && options.timed) {
                correlate = true;
            }

            let prefix = `${correlate ? `[${correlationId.toString(16)}] ` : ''}${
                instanceName ? `${instanceName}.` : ''
            }${key}`;

            if (options.prefix != null) {
                prefix = options.prefix(
                    {
                        id: correlationId,
                        instance: this,
                        instanceName: instanceName,
                        name: key,
                        prefix: prefix
                    } as LogContext<T>,
                    ...args
                );
            }

            let correlationContext: LogCorrelationContext | undefined;
            if (correlate) {
                correlationContext = { correlationId: correlationId, prefix: prefix };
                setCorrelationContext(correlationId, correlationContext);
            }

            const enter = options.enter != null ? options.enter(...args) : '';

            let loggableParams: string;
            if (options.args === false || args.length === 0) {
                loggableParams = '';

                if (!options.singleLine) {
                    logFn(`${prefix}${enter}`);
                }
            }
            else {
                const argFns = typeof options.args === 'object' ? options.args : undefined;
                let argFn;
                let loggable;
                loggableParams = args
                    .map((v: any, index: number) => {
                        const p = parameters[index];

                        argFn = argFns !== undefined ? argFns[index] : undefined;
                        if (argFn !== undefined) {
                            loggable = argFn(v);
                            if (loggable === false) return undefined;
                        }
                        else {
                            loggable = Logger.toLoggable(v, options.sanitize);
                        }

                        return p ? `${p}=${loggable}` : loggable;
                    })
                    .filter(Boolean)
                    .join(', ');

                if (!options.singleLine) {
                    if (!options.debug) {
                        Logger.logWithDebugParams(`${prefix}${enter}`, loggableParams);
                    }
                    else {
                        logFn(`${prefix}${enter}`, loggableParams);
                    }
                }
            }

            if (options.timed || options.exit != null) {
                const start = options.timed ? process.hrtime() : undefined;

                const logError = (ex: Error) => {
                    const timing = start !== undefined ? ` \u2022 ${Strings.getDurationMilliseconds(start)} ms` : '';
                    if (options.singleLine) {
                        Logger.error(
                            ex,
                            `${prefix}${enter}`,
                            `failed${
                                correlationContext !== undefined && correlationContext.exitDetails
                                    ? correlationContext.exitDetails
                                    : ''
                            }${timing}`,
                            loggableParams
                        );
                    }
                    else {
                        Logger.error(
                            ex,
                            prefix,
                            `failed${
                                correlationContext !== undefined && correlationContext.exitDetails
                                    ? correlationContext.exitDetails
                                    : ''
                            }${timing}`
                        );
                    }

                    if (correlate) {
                        clearCorrelationContext(correlationId);
                    }
                };

                let result;
                try {
                    result = fn!.apply(this, args);
                }
                catch (ex) {
                    logError(ex);
                    throw ex;
                }

                const logResult = (r: any) => {
                    const timing = start !== undefined ? ` \u2022 ${Strings.getDurationMilliseconds(start)} ms` : '';
                    let exit;
                    if (options.exit != null) {
                        try {
                            exit = options.exit(r);
                        }
                        catch (ex) {
                            exit = `@log.exit error: ${ex}`;
                        }
                    }
                    else {
                        exit = 'completed';
                    }

                    if (options.singleLine) {
                        if (!options.debug) {
                            Logger.logWithDebugParams(
                                `${prefix}${enter} ${exit}${
                                    correlationContext !== undefined && correlationContext.exitDetails
                                        ? correlationContext.exitDetails
                                        : ''
                                }${timing}`,
                                loggableParams
                            );
                        }
                        else {
                            logFn(
                                `${prefix}${enter} ${exit}${
                                    correlationContext !== undefined && correlationContext.exitDetails
                                        ? correlationContext.exitDetails
                                        : ''
                                }${timing}`,
                                loggableParams
                            );
                        }
                    }
                    else {
                        logFn(
                            `${prefix} ${exit}${
                                correlationContext !== undefined && correlationContext.exitDetails
                                    ? correlationContext.exitDetails
                                    : ''
                            }${timing}`
                        );
                    }

                    if (correlate) {
                        clearCorrelationContext(correlationId);
                    }
                };

                if (result != null && Functions.isPromise(result)) {
                    const promise = result.then(logResult);
                    promise.catch(logError);
                }
                else {
                    logResult(result);
                }

                return result;
            }

            return fn!.apply(this, args);
        };
    };
}
