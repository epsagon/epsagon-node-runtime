'use strict';
var net = require('net');
var repl = require('repl');

var http = require('http');
var util = require('util');


let invokeManager = undefined;

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API;
const [RUNTIME_HOST, RUNTIME_PORT] = RUNTIME_API.split(':');
const API_BASE_PATH = '/2018-06-01/runtime';
const MAX_LOGGED_ERROR_SIZE = 256 * 1024;

const BASE_CONTEXT = Object.freeze({
  logGroupName : process.env['AWS_LAMBDA_LOG_GROUP_NAME'],
  logStreamName : process.env['AWS_LAMBDA_LOG_STREAM_NAME'],
  functionName : process.env['AWS_LAMBDA_FUNCTION_NAME'],
  memoryLimitInMB : process.env['AWS_LAMBDA_FUNCTION_MEMORY_SIZE'],
  functionVersion : process.env['AWS_LAMBDA_FUNCTION_VERSION'],
});

function fatalError(error) {
  console.log(error.stack);
  process.exit(1);
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      method,
      path: `${API_BASE_PATH}/${path}`,
      port: RUNTIME_PORT,
      host: RUNTIME_HOST,
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode > 299) {
        reject(new Error(`Failed to make api request: ${response.statusCode}`));
      }

      const headers = response.headers;
      const body = [];
      response.on('data', (chunk) => body.push(chunk));
      response.on('end', () => resolve({
        headers,
        body: body.join(''),
      }))
    });
    request.on('error', (err) => reject(err));
    if (body) {
      request.write(body);
    }
    request.end();
  }).catch(fatalError);
}

let API = {
  next() {
    return apiRequest('GET', 'invocation/next').then((response) => {
      let contextObjects = (
        response.headers['lambda-runtime-cognito-identity'] ?
          JSON.parse(response.headers['lambda-runtime-cognito-identity']) : {}
      );
      contextObjects.clientContext = response.headers['lambda-runtime-client-context'];

      return ({
        invokeid: response.headers['lambda-runtime-aws-request-id'],
        'x-amzn-trace-id': response.headers['lambda-runtime-trace-id'],
        eventBody: response.body,
        contextObjects,
        invokedFunctionArn: response.headers['lambda-runtime-invoked-function-arn'],
        deadline: response.headers['lambda-runtime-deadline-ms'],
      });
    });
  },
  response(invocationId, result) {
    return apiRequest('POST', `invocation/${invocationId}/response`, result);
  },
  error(invocationId, msg, name, stack) {
    let data = msg;
    if (name || stack) {
      let result = {errorMessage: msg};
      if (name) {
        result.errorType = name;
      }
      if (stack) {
        result.stackTrace = stack;
      }
      data = JSON.stringify(result);
    }
    return apiRequest(
      'POST',
      `invocation/${invocationId}/error`,
      data
    );
  },
  initError (msg) {
    return apiRequest('POST', `init/error`, msg);
  },
  done(invocationId, isError, result, isInitError) {
    if (isInitError) {
      return this.initError(result);

    }
    if (isError) {
      return this.error(invocationId, result);
    }
    return this.response(invocationId, result);
  },
};

class InvokeManager {
  constructor(handlerString, suppressInit) {
    this._handlerString = handlerString;
    this._requestHandler = suppressInit ? null : this._getHandler(this._handlerString);
  }

  start(options) {
    this._invokeId = options.invokeid;
    if(options['x-amzn-trace-id'] !== undefined) {
      process.env['_X_AMZN_TRACE_ID'] = options['x-amzn-trace-id'];
    } else {
      delete process.env['_X_AMZN_TRACE_ID'];
    }

    this._result = undefined;
    this._faulted = false;
    this._fatal = false;
    this._deadline = options.deadline;

    let event;
    try {
      const eventBody = options.eventBody;
      if (!eventBody) {
        this._fault(`invalid args - eventbody = ${eventBody}`);
        return;
      }
      event = JSON.parse(eventBody);
    } catch(err) {
      this._fault(`Unable to parse input as json: ${err.message}`, err);
      return;
    }

    const baseContext = Object.assign({}, BASE_CONTEXT);
    const contextObjects = options.contextObjects;
    const clientContext = contextObjects.clientContext;
    if(!isUndefined(clientContext)) {
      try {
        baseContext.clientContext = JSON.parse(clientContext);
      } catch (e) {
        this._fault('Unable to parse clientContext as json');
        return;
      }
    }

    const cognitoIdentityId = contextObjects.cognitoIdentityId;
    const cognitoIdentityPoolId = contextObjects.cognitoPoolId;
    if (!isUndefined(cognitoIdentityId) || !isUndefined(cognitoIdentityPoolId)) {
      baseContext.identity = {cognitoIdentityId, cognitoIdentityPoolId};
    }
    baseContext.invokeid = options.invokeid;
    baseContext.awsRequestId = options.invokeid;
    baseContext.invokedFunctionArn = options.invokedFunctionArn;

    patchLogging(options.invokeid);

    // if the handler hasn't been loaded yet, due to init suppression, load it now.
    if (!this._requestHandler) {
      this._requestHandler = this._getHandler(this._handlerString);
    }

    invoke(this._requestHandler, event, baseContext, this.finish.bind(this));
  }

  finish(err, data, waitToFinish) {
    if (this._result === undefined) {
      if (err == null) {
        try {
          this._result = [null, JSON.stringify(isUndefined(data) ? null : data)];
        } catch (err) {
          this._fault(`Unable to stringify response body as json: ${err.message}`, err);
          return;
        }
      } else {
        try {
          let errType = this._faulted ? 'unhandled' : 'handled';
          this._result = [errType, stringifyError(errType, err)];
        } catch (err) {
          this._fault('callback called but a problem was encountered while converting data to a string');
          return;
        }
      }
    }
    if (waitToFinish) {
      return;
    }
    process.nextTick(() => {
      API.done(this._invokeId, this._result[0], this._result[1], this._fatal).then(() => {
        if (this._fatal == true) {
          process.exit(1);
        }
        API.next().then(this.start.bind(this));
      });
    });
  }

  getRemainingTimeInMillis() {
    return this._deadline - Date.now();
  }

  _fault(msg, err, fatal) {
    this._faulted = true;
    this._fatal = this._fatal || fatal;
    if (!isUndefinedOrNull(err)) {
      err.stack = stripMessageFromStack(err.stack);
    }
    try {
      if (isUndefinedOrNull(err)) {
        API.error(this._invokeId, msg);
      } else {
        API.error(this._invokeId, msg ? msg : err.message, err.name, err.stack);
      }
    } catch (err) {
      API.error(this._invokeId, 'unknown');
    }
    this.finish(isUndefinedOrNull(err) ? msg : err, null, true);
  }

  _getHandler(handlerString) {
    let appParts = handlerString.split('.');
    let createErrorHandler = (msg, err, fatal) => {
      return () => {
        this._fault(msg, err, fatal);
      };
    };
    if(appParts.length != 2) {
      return createErrorHandler(`Bad handler ${handlerString}`, null, false);
    }

    let modulePath = appParts[0];
    let handlerName = appParts[1];
    try {
      let lambdaTaskRoot = process.env['LAMBDA_TASK_ROOT'];
      let moduleFullPath = modulePath.startsWith('/opt/') ? modulePath: lambdaTaskRoot + "/" + modulePath;
      let app = require(moduleFullPath);
      let userHandler = app[handlerName];

      if (isUndefined(userHandler)) {
        return createErrorHandler(`Handler '${handlerName}' missing on module '${modulePath}'`, null, false);
      } else {
        return userHandler;
      }
    } catch (e) {
      if (e.code == 'MODULE_NOT_FOUND') {
        return createErrorHandler(`Unable to import module '${modulePath}'`, e, false);
      } else if (e instanceof SyntaxError) {
        return createErrorHandler(`Syntax error in module '${modulePath}'`, e, false);
      } else {
        return createErrorHandler('module initialization error', e, true);
      }
    }
  }

}

function invoke(handler, event, baseContext, finish) {
  let waitToFinish = true;
  let consumed = false;
  const callback = (err, data) => {
    if (consumed) {
      return;
    }
    consumed = true;
    finish(err, data, waitToFinish);
  };

  const context = Object.assign({
    set callbackWaitsForEmptyEventLoop(value) {
      waitToFinish = value;
    },
    get callbackWaitsForEmptyEventLoop() {
      return waitToFinish;
    },

    getRemainingTimeInMillis : () => invokeManager.getRemainingTimeInMillis(),
    done : function(err, data) {
      waitToFinish = false;
      callback(err, data);
    },
    succeed : function(data) {
      checkExpectedArgRange('succeed', arguments, 0, 1);
      context.done(null, data);
    },
    fail : function(err) {
      checkExpectedArgRange('fail', arguments, 0, 1);
      context.done(isUndefinedOrNull(err) ? '__emptyFailParamBackCompat' : err, null);
    }
  }, baseContext);

  // if response is a Promise, use it to call finish() instead
  let response = handler(event, context, callback);
  if (response instanceof Promise) {
    response
      .then(context.succeed)
      .catch(context.fail);
  }
}

function stringifyError(errType, err) {
  let errObj;
  if (err instanceof Error) {
    errObj = errorToFailObject(err);
  } else if (isUndefinedOrNull(err)) {
    errObj = defaultEventErrorObject;
  } else {
    errObj = makeEventFailObject(err);
  }

  let jsonStrErrObj = JSON.stringify(errObj);
  if (errType !== 'unhandled') {
    //we log only 256K of errorMessage into customer's cloudwatch
    if (jsonStrErrObj != null) {
      if (jsonStrErrObj.length > MAX_LOGGED_ERROR_SIZE) {
        console.log(jsonStrErrObj.substring(0, MAX_LOGGED_ERROR_SIZE) + ' - Truncated by Lambda');
      } else {
        console.log(jsonStrErrObj);
      }
    }
  }
  return jsonStrErrObj;
}

function checkExpectedArgRange(name, args, min, maxInclusive) {
  if(args.length < min) {
    console.warn(`function ${name} expected at least ${min} arguments, got ${args.length}`);
  } else if (args.length > maxInclusive) {
    console.warn(`function ${name} expected at most ${min} arguments, got ${args.length}`);
  }
}

function isUndefinedOrNull(arg) {
  return isUndefined(arg) || isNull(arg);
}

function isUndefined(arg) {
  assertExactArgLength(arguments, 1);
  return (typeof arg === 'undefined');
}

function isNull(arg) {
  assertExactArgLength(arguments, 1);
  return isObject(arg) && !arg;
}

function isObject(arg) {
  assertExactArgLength(arguments, 1);
  return typeof(arg) === 'object';
}

function assertExactArgLength(args, length) {
  if(args.length != length) {
    throw new Error(`expected ${length} arguments, got ${args.length}`);
  }
}

function makeEventFailObject(message, name, stack) {
  var result = {};
  if(isUndefinedOrNull(message) || message == '__emptyFailParamBackCompat') {
    result.errorMessage = null;
  } else {
    result.errorMessage = message.toString();
  }

  if(!isUndefinedOrNull(name)) {
    result.errorType = name.toString();
  }

  if(!isUndefinedOrNull(stack)) {
    result.stackTrace = stack;
  }

  return result;
}

function errorToFailObject(error) {
  var prefixToRemove = '    at ';
  function removePrefix(v) {
    return stringStartsWith(v, prefixToRemove)
      ? v.slice(prefixToRemove.length)
      : v;
  }
  try {
    var stack = error.stack.split('\n').slice(1).map(removePrefix);
    return makeEventFailObject(error.message, error.name, stack);
  } catch(error) {
    return makeEventFailObject('callback called with Error argument, but there was a problem while retrieving one or more of its message, name, and stack');
  }
}

var defaultEventErrorObject = Object.freeze(makeEventFailObject());

// Filter out from stack traces awslambda.js and all frames below it
function customPrepareStackTrace(error, stack) {
  var idx = stack.length;
  for(var i = 0; i < stack.length; i++) {
    if(stack[i].getFileName() == __filename) {
      idx = i;
      break;
    }
  }

  var lines = new Array();
  lines[0] = error;

  for (var i = 0; i < idx; i++) {
    var frame = stack[i];
    var line;
    try {
      line = frame.toString();
    } catch (e) {
      try {
        line = '<error: ' + e + '>';
      } catch (ee) {
        line = '<error>';
      }
    }
    lines[i+1] = '    at ' + line;
  }
  return lines.join('\n');
}

// node.js stack traces have the error message on the first line.
// Since we already report the error message in another field, strip it from the stack to avoid redundancy.
function stripMessageFromStack(stack) {
  if(Error.prepareStackTrace != customPrepareStackTrace || (typeof stack === 'undefined') || stack == null) {
    return null;
  } else {
    return stack.slice(stack.indexOf('\n') + 1);
  }
}
function stringStartsWith(str, prefix) {
  return str.substring(0, prefix.length) === prefix;
};

var originalConsoleLog = console.log;
function patchLogging(invokeId) {
  console.log = console.error = console.warn = console.info = function prettyConsoleLog() {
    var dateString = new Date().toISOString();
    var message = `${dateString}\t${invokeId}\t${util.format.apply(this, arguments)}\n`;
    originalConsoleLog(message);
  };
};

// Remove lambda internal environment variables
var env_list = [
  "_LAMBDA_CONTROL_SOCKET",
  "_LAMBDA_SHARED_MEM_FD",
  "_LAMBDA_LOG_FD",
  "_LAMBDA_SB_ID",
  "_LAMBDA_CONSOLE_SOCKET",
  "_LAMBDA_RUNTIME_LOAD_TIME"
]
env_list.forEach(function(env_key){
  delete process.env[env_key];
});

// ensure stack trace is logged with console object so it shows up in debug logs
process.on('uncaughtException', fatalError);
;

Error.prepareStackTrace = customPrepareStackTrace;
process.on('beforeExit', () => invokeManager.finish(null, null, false));

invokeManager = new InvokeManager(process.env._HANDLER, false);
API.next().then(invokeManager.start.bind(invokeManager));
