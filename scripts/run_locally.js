#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const path  = require('path');
const spawn = require('child_process').spawn;

var daemons = exports.daemons = {};

const HOST = process.env['GOMBOT_IP_ADDRESS'] || process.env['GOMBOT_HOST'] || "127.0.0.1";

var daemonsToRun = {
  api: { },
  static: { },
  builder: { },
  router: { }
};

// only run builder if specified
if (!process.env.ENABLE_BUILDS) delete daemonsToRun.builder;

process.env['GOMBOT_HOST'] = HOST;

// use the "local" configuration
var configFiles = [];
if (process.env['CONFIG_FILES']) {
  var configFiles = process.env['CONFIG_FILES'].split(',');
}
configFiles.push(path.join(__dirname, '..', 'config', 'local.json'));
process.env['CONFIG_FILES'] = configFiles.join(',');

// all spawned processes should log to console
process.env['LOG_TO_CONSOLE'] = 1;

process.env['GOMBOT_ROUTER_URL'] = 'http://' + HOST + ":20000";
process.env['GOMBOT_API_URL']    = 'http://' + HOST + ":20001";
process.env['GOMBOT_STATIC_URL'] = 'http://' + HOST + ":20002";
process.env['GOMBOT_BUILDER_URL'] = 'http://' + HOST + ":20003";

process.env['PUBLIC_URL'] = process.env['GOMBOT_ROUTER_URL'];

// Windows can't use signals, so lets figure out if we should use them
// To force signals, set the environment variable SUPPORTS_SIGNALS=true.
// Otherwise, they will be feature-detected.
var SIGNALS_PROP = 'SUPPORTS_SIGNALS';
if (!(SIGNALS_PROP in process.env)) {
  try {
    function signals_test() {}
    process.on('SIGINT', signals_test);
    process.removeListener('SIGINT', signals_test);
    process.env[SIGNALS_PROP] = true;
  } catch (noSignals) {
    // process.env converts all values set into strings, so setting this to
    // false would get converted to the string false.  Better to set nothing.
  }
}

var debugPort = 5859;
var inspectorProc;

function runDaemon(daemon, cb) {
  Object.keys(daemonsToRun[daemon]).forEach(function(ek) {
    if (ek === 'path') return; // this blows away the Window PATH
    process.env[ek] = daemonsToRun[daemon][ek];
  });
  var pathToScript = daemonsToRun[daemon].path || path.join(__dirname, "..", "bin", daemon);
  var args = [ pathToScript ];
  if (process.env.GOMBOT_DEBUG_MODE) {
    args.unshift('--debug=' + debugPort++);
  }
  var p = spawn('node', args);

  function dump(d) {
    d.toString().split('\n').forEach(function(d) {
      if (d.length === 0) return;
      console.log(daemon, '(' + p.pid + '):', d);

      // when we find a line that looks like 'running on <url>' then we've
      // fully started up and can run the next daemon.  see issue #556
      if (cb && /^.*running on http:\/\/.*:[0-9]+$/.test(d)) {
        cb();
        cb = undefined;
      }
    });
  }

  p.stdout.on('data', dump);
  p.stderr.on('data', dump);

  console.log("spawned", daemon, "("+pathToScript+") with pid", p.pid);
  Object.keys(daemonsToRun[daemon]).forEach(function(ek) {
    if (ek === 'path') return; // don't kill the Windows PATH
    delete process.env[ek];
  });

  daemons[daemon] = p;

  p.on('exit', function (code, signal) {
    console.log(daemon, 'exited(' + code + ') ', (signal ? 'on signal ' + signal : ""));
    delete daemons[daemon];
    Object.keys(daemons).forEach(function (daemon) { daemons[daemon].kill(); });
    if (Object.keys(daemons).length === 0) {
      if (process.env.GOMBOT_DEBUG_MODE) inspectorProc.kill();
      console.log("all daemons torn down, exiting...");
    }
  });
}

// start all daemons except the router in parallel
var daemonNames = Object.keys(daemonsToRun);
daemonNames.splice(daemonNames.indexOf('router'), 1);

var numDaemonsRun = 0;
daemonNames.forEach(function(dn) {
  runDaemon(dn, function() {
    if (++numDaemonsRun === daemonNames.length) {
      // after all daemons are up and running, start the router
      runDaemon('router', function() {
        if (process.env.PERSONA_DEBUG_MODE) {
          var inspectPath = path.join(__dirname, "..", "node_modules", ".bin", "node-inspector");
          inspectorProc = spawn(inspectPath, []);
        }
      });
    }
  });
});

if (process.env[SIGNALS_PROP]) {
  process.on('SIGINT', function () {
    console.log('\nSIGINT recieved! trying to shut down gracefully...');
    Object.keys(daemons).forEach(function (k) { daemons[k].kill('SIGINT'); });
  });
}
